import type { Express } from "express";
import { coldLeadPredicate, requestColdReengagement } from "../services/cold-lead-authority";
import { authorizeContactAccess } from "../services/crm-object-access";
import { isAuthenticated, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { z } from "zod";
import { DateValidationError } from "../utils/date-coerce";
import { pool, db } from "../db";
import { effectiveContactVerticalSql, effectiveContactVerticalStatusSql } from "@shared/effective-vertical";
import { sdrLeadState, insertCompanySchema, insertContactSchema, contacts as contactsTable } from "@shared/schema";
import { eq, inArray, isNull, and, gte, count as drizzleCount, asc, sql } from "drizzle-orm";
import crypto from "crypto";
import {
  approveContactMerge,
  ContactMergeError,
  executeContactMerge,
  findIdentityCandidates,
  previewContactMerge,
  undoContactMerge,
} from "../services/contact-merge";
import { enrollContactInGhlWorkflow } from "../services/ghl-workflow-enrollment";
import { enrichContactFromLinkedIn, bulkEnrichFromLinkedIn } from "../services/linkedin-enrichment";
import { getSerperUsage, isSerperConfigured, resetSerperUsage } from "../services/serper";
import { enqueuePromotionalEnrollment } from "../services/promotional-enrollment-eligibility";
import { triggerWorkflowsByEvent } from "../services/workflow-executor";
import { scoreContact } from "../services/lead-scoring";
import { routeContact } from "../services/smart-router";
import { decideCr06SequenceLifecycle } from "../services/cr06-promotional-lifecycle-decision";
import { createPreferenceAwareNotification, sendCriticalEmailNotification } from "../services/digest-service";
import { ingestBusinessFromContact } from "../services/sdr/dedupe";
import { isGhlConfigured } from "../services/ghl";
import { normalizeGhlId } from "../utils/normalize";
import { syncContactToGhl } from "../services/ghl-sync";
import { writeContact, updateContactLocalFirst, stripProvenanceFields } from "../services/contact-writer";
import { assignNextRep } from "./toolkit";
import { parse } from "csv-parse/sync";
import path from "path";
import { sendPushToAllReps } from "../services/push-service";
import { extractRelationshipsForContact, extractRelationshipsForContactsBatch, propagateRiskFlagToRelatedEntities } from "../services/relationship-extractor";
import { serverError, safeMessage } from "../utils/server-error";
import { LifecycleService, adminOverrideTransition, LIFECYCLE_STATES } from "../services/lifecycle-service";
import type { LifecycleState } from "../services/lifecycle-service";
import { applyConsentCommand } from "../services/consent-authority";
import { agentOwnershipEmail, invalidPagination, parseStrictPagination } from "../services/crm-object-access";
import { contactReadPredicate, readPeople, readPeopleFacets } from "../services/revenue-read-authority";
import { createCro03Batch } from "../services/cro03/enrichment-factory";
import { enrichContactBatch, isContactEnrichRunning, getContactIdsNeedingEnrichment, getEnrichmentBacklogCount } from "../services/enrichment";
import { claimInboundRequest, orchestrateInboundRequest } from "../services/inbound-request-authority";

// ── Canonical email-validation predicates (task #1540A) ─────────────────────
// Moved to server/services/zerobounce-eligibility.ts in #1541 so the durable
// BullMQ campaign worker can share them; re-exported here to preserve existing
// import paths (tests import them from this module).
import {
  UNVALIDATED_EMAIL_PREDICATE,
  VALID_EMAIL_ELIGIBILITY,
  ZB_ISSUE_FILTERS,
  isPlaceholderEmail,
  isRetryableZbFailure,
  isZeroBounceConfigured,
  type ZbCampaignFilter,
} from "../services/zerobounce-eligibility";
export {
  UNVALIDATED_EMAIL_PREDICATE,
  VALID_EMAIL_ELIGIBILITY,
  isPlaceholderEmail,
  isRetryableZbFailure,
  isZeroBounceConfigured,
};

/**
 * Resolve explicit contact IDs into an eligible, deduplicated candidate list.
 * Drops duplicates, archived contacts, blank emails, and synthetic placeholder
 * addresses via VALID_EMAIL_ELIGIBILITY. Terminal-status contacts are kept on
 * purpose: explicit IDs are the operator's deliberate re-validation gate.
 */
export async function resolveZbExplicitCandidates(ids: number[], limit: number): Promise<number[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const rows = await pool.query(
    `SELECT id FROM contacts WHERE id = ANY($1::int[]) AND ${VALID_EMAIL_ELIGIBILITY}`,
    [unique],
  );
  const eligible = new Set<number>(rows.rows.map((r: any) => r.id));
  return unique.filter((id) => eligible.has(id)).slice(0, limit);
}

export interface ZbBatchDeps {
  verifyEmail: (email: string) => Promise<import("../services/sdr/zerobounce").ZeroBounceResult>;
  claimCredit: () => Promise<boolean>;
  hasProviderKey: () => boolean;
}

export interface ZbBatchCounters {
  processed: number;
  valid: number;
  blocked: number;
  errors: number;
  retryableErrors: number;
}

/**
 * Production batch-validation loop shared by the batch route (and tests, via
 * injected deps). Guarantees:
 *  - Missing provider key: NO credits are claimed and NO statuses are written;
 *    every queued contact counts as a retryable error.
 *  - Placeholder/blank emails: skipped BEFORE claiming a credit.
 *  - Transport/HTTP/timeout failures: the credit may already be spent
 *    provider-side, but email_status is left unchanged and the contact stays
 *    eligible for the next run (counted in retryableErrors).
 *  - Only completed provider decisions write contacts.email_status.
 */
export async function runZbValidationBatch(
  toProcess: number[],
  actorId: string,
  deps: ZbBatchDeps,
): Promise<ZbBatchCounters> {
  const counters: ZbBatchCounters = { processed: 0, valid: 0, blocked: 0, errors: 0, retryableErrors: 0 };

      const { createValidationIntent, processValidationIntent, hashEmailToken } = await import("../services/provider-readiness-control");

  for (const contactId of toProcess) {
    try {
      const contact = await storage.getContact(contactId);
      if (!contact?.email) continue;
      // Never send synthetic placeholder addresses to ZeroBounce, and never
      // let them consume a daily credit (checked BEFORE claiming).
      if (isPlaceholderEmail(contact.email)) continue;
      const generation = (await pool.query(
        `UPDATE contacts SET email_mutation_generation = GREATEST(email_mutation_generation, 1),
             email_token_hash = $2 WHERE id = $1 RETURNING email_mutation_generation`,
        [contactId, hashEmailToken(contact.email)],
      )).rows[0].email_mutation_generation;
      await db.transaction((tx) => createValidationIntent(tx, {
        contactId, email: contact.email, generation, purpose: "marketing_outreach",
      }));
      const intent = await pool.query(
        `SELECT id FROM validation_intents WHERE contact_id = $1
           AND subject_generation = $2 AND purpose = 'marketing_outreach'
         ORDER BY updated_at DESC LIMIT 1`,
        [contactId, generation],
      );
      if (!intent.rows[0]) { counters.errors++; continue; }
      const outcome = await processValidationIntent(intent.rows[0].id, { verifyEmail: deps.verifyEmail });
      counters.processed++;
      if (outcome === "completed") counters.valid++;
      else if (outcome === "deferred") counters.retryableErrors++;
      else counters.blocked++;
    } catch (e) {
      counters.errors++;
    }
  }
  return counters;
}

function isUniqueEmailViolation(err: any): boolean {
  return err?.code === "23505" && (err?.constraint?.includes("email") || err?.message?.includes("contacts_email_unique_idx"));
}

/** GET /api/contacts/<literal> readers registered by modules that load after the contacts module
 * (campaigns, crm-operations). The contact-detail route must hand these to their own handlers.
 * scripts/test-stage3-c3-contracts.ts fails if another later-registered literal is added without being listed. */
export const CONTACT_COLLECTION_READERS_REGISTERED_LATER: ReadonlySet<string> = new Set(["readiness-stats", "verticals", "duplicates"]);

export function registerContactsRoutes(app: Express, creationDependencies: Partial<{
  writeContact: typeof writeContact;
  orchestrateInboundRequest: typeof orchestrateInboundRequest;
}> = {}) {
  const createLocalContact = creationDependencies.writeContact ?? writeContact;
  const handoffLocalContact = creationDependencies.orchestrateInboundRequest ?? orchestrateInboundRequest;
  // BT-07 reviewed identity merge API. Read/preview is deliberately limited to
  // managers/admins; every transition that can mutate records is admin-only.
  app.get("/api/contacts/:id/merge-candidates", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!Number.isInteger(contactId) || contactId <= 0) return res.status(400).json({ message: "Invalid contact ID" });
      return res.json({ candidates: await findIdentityCandidates(contactId) });
    } catch (error: any) {
      return serverError(res, error);
    }
  });

  app.post("/api/contacts/merge-operations/preview", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const body = z.object({
        survivorContactId: z.number().int().positive(),
        deprecatedContactId: z.number().int().positive(),
        idempotencyKey: z.string().uuid(),
        fieldDecisions: z.record(z.string(), z.string()).refine(value => Object.keys(value).length > 0),
      }).parse(req.body);
      const role = (req.user as any)?.role as "admin" | "manager";
      const preview = await previewContactMerge({
        ...body,
        actorId: String((req.user as any)?.id),
        actorRole: role,
      });
      return res.json(preview);
    } catch (error: any) {
      if (error instanceof ContactMergeError) return res.status(409).json({ code: error.code, message: error.message });
      return serverError(res, error);
    }
  });

  app.get("/api/contact-merge-operations/:operationId/evidence", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { db } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const result = await db.execute(sql`
        SELECT id, survivor_contact_id, deprecated_contact_id, status, actor_id, actor_role,
          manifest_version, normalization_version, preview_hash, contact_versions,
          field_decisions, conflict_reason, ghl_disposition, reconciliation_status,
          approved_at, executed_at, undone_at, created_at, updated_at
        FROM contact_merge_operations WHERE id = ${req.params.operationId}
      `);
      const operation = (result as any).rows?.[0];
      if (!operation) return res.status(404).json({ message: "Merge operation not found" });
      const actions = await db.execute(sql`
        SELECT relation_key, source_record_id, action, status, created_at, undone_at
        FROM contact_merge_relationship_actions WHERE operation_id = ${req.params.operationId} ORDER BY created_at
      `);
      return res.json({ operation, actions: (actions as any).rows ?? [] });
    } catch (error: any) {
      return serverError(res, error);
    }
  });

  app.post("/api/contact-merge-operations/:operationId/approve", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      return res.json(await approveContactMerge(String(req.params.operationId), String((req.user as any)?.id)));
    } catch (error: any) {
      if (error instanceof ContactMergeError) return res.status(409).json({ code: error.code, message: error.message });
      return serverError(res, error);
    }
  });

  app.post("/api/contact-merge-operations/:operationId/execute", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      return res.json(await executeContactMerge(String(req.params.operationId), String((req.user as any)?.id)));
    } catch (error: any) {
      if (error instanceof ContactMergeError) return res.status(409).json({ code: error.code, message: error.message });
      return serverError(res, error);
    }
  });
  app.post("/api/contact-merge-operations/:operationId/retry-consent-handoff", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const { retryContactMergeConsentHandoff } = await import("../services/contact-merge");
      return res.json(await retryContactMergeConsentHandoff(String(req.params.operationId), String((req.user as any)?.id)));
    } catch (error: any) {
      if (error instanceof ContactMergeError) return res.status(409).json({ code: error.code, message: error.message });
      return serverError(res, error);
    }
  });

  app.post("/api/contact-merge-operations/:operationId/undo", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      return res.json(await undoContactMerge(String(req.params.operationId), String((req.user as any)?.id)));
    } catch (error: any) {
      if (error instanceof ContactMergeError) return res.status(409).json({ code: error.code, message: error.message });
      return serverError(res, error);
    }
  });

  // === CONTACTS ===

  /** Shared filter-parsing helper used by both /api/contacts and /api/contacts/facets */
  function parseContactsFilters(req: any): {
    error?: { code: string; message: string };
    filters?: Parameters<typeof readPeople>[1];
  } {
    const emailStatus = req.query.emailStatus ? String(req.query.emailStatus) : undefined;
    if(req.query.isParentAccount!==undefined&&!["true","false"].includes(req.query.isParentAccount))
      return {error:{code:"INVALID_PARENT_ACCOUNT_FILTER",message:"isParentAccount must be true or false"}};
    const ownerEmail = agentOwnershipEmail(req.user);
    const assignedTo = req.query.assignedToMe === "true"
      ? ownerEmail
      : ownerEmail ? undefined : req.query.assignedTo ? String(req.query.assignedTo) : undefined;
    const archived = req.query.archived === "true";
    const role = String(req.user?.role ?? "");
    if (archived && role !== "admin" && role !== "manager") {
      return { error: { code: "ARCHIVED_CONTACTS_FORBIDDEN", message: "Archived contacts require manager access" } };
    }
    const sort = req.query.sort ? String(req.query.sort) : undefined;
    const allowedSorts = new Set(["activity_desc", "activity_asc", "score_desc", "alpha", "name", "createdAtAsc", "updatedAt", "leadScore"]);
    if (sort && !allowedSorts.has(sort)) {
      return { error: { code: "INVALID_PEOPLE_SORT", message: "Unsupported People sort" } };
    }
    const recordClass = req.query.recordClass ?? req.query.class;
    const allowedClasses = new Set(["production", "test", "demo", "synthetic", "unknown"]);
    if (recordClass && !allowedClasses.has(String(recordClass))) {
      return { error: { code: "INVALID_RECORD_CLASS", message: `Invalid recordClass: '${String(recordClass)}'. Allowed: production, test, demo, synthetic, unknown` } };
    }
    const blockedFilter = req.query.blocked ? String(req.query.blocked) : undefined;
    return {
      filters: {
        // limit/offset are set by callers — defaults here are safe for facets
        limit: 0, offset: 0,
        search: req.query.search ? String(req.query.search) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        emailHealth: req.query.emailHealth ? String(req.query.emailHealth) : emailStatus,
        assignedTo,
        archived,
        recordClass: recordClass ? String(recordClass) : undefined,
        sort,
        churnRisk: req.query.churnRisk ? String(req.query.churnRisk) : undefined,
        noOutreach: req.query.noOutreach ? String(req.query.noOutreach) : undefined,
        blocked: blockedFilter === "true",
        vertical: req.query.vertical ? String(req.query.vertical) : undefined,
        tag: req.query.tag ? String(req.query.tag) : undefined,
        contactedToday: req.query.contactedToday === "true",
        hasAssignee: req.query.hasAssignee === "true",
        isParentAccount:req.query.isParentAccount==="true",
        leadSource: req.query.leadSource ? String(req.query.leadSource) : undefined,
        lifecycle: req.query.lifecycle ? String(req.query.lifecycle) : undefined,
        stale: req.query.stale === "true",
        recentlyUpdated: req.query.recentlyUpdated === "true",
        neverContacted: req.query.neverContacted === "true",
        notContactedIn30: req.query.notContactedIn30 === "true",
        noDeal: req.query.noDeal === "true",
        createdThisWeek: req.query.createdThisWeek === "true",
      },
    };
  }

  /**
   * GET /api/contacts — rows-first.
   *
   * Returns the paginated contact rows WITHOUT waiting for totals or facets.
   * Failure of the facets endpoint must never prevent this response.
   * Use GET /api/contacts/facets for totals and class/health breakdowns.
   */
  app.get("/api/contacts", isDashboardUser, async (req, res) => {
    try {
      const pagination = parseStrictPagination(req.query as Record<string, unknown>, { defaultLimit: 100, maxLimit: 500 });
      if ("error" in pagination) return invalidPagination(res);
      const { limit, offset } = pagination;
      const parsed = parseContactsFilters(req);
      if (parsed.error) return res.status(parsed.error.code === "ARCHIVED_CONTACTS_FORBIDDEN" ? 403 : 400).json(parsed.error);
      const result = await readPeople(req.user as any, { ...parsed.filters!, limit, offset });
      res.json(result);
    } catch (err: any) {
      console.error("Get contacts error:", err.message);
      serverError(res, err);
    }
  });

  /**
   * GET /api/contacts/facets — totals and breakdown counts.
   *
   * Separate from the rows endpoint so contact rows are never blocked on the
   * expensive GROUPING SETS scan.  Errors here must not propagate to the
   * contact list UI.
   *
   * Response: { total, byRecordClass, byEmailHealth, asOf }
   */
  app.get("/api/contacts/facets", isDashboardUser, async (req, res) => {
    try {
      const parsed = parseContactsFilters(req);
      if (parsed.error) return res.status(parsed.error.code === "ARCHIVED_CONTACTS_FORBIDDEN" ? 403 : 400).json(parsed.error);
      const result = await readPeopleFacets(req.user as any, { ...parsed.filters!, limit: 0, offset: 0 });
      res.json(result);
    } catch (err: any) {
      console.error("Get contacts facets error:", err.message);
      serverError(res, err);
    }
  });

  // ── PATCH /api/contacts/:id/assign — assign a contact to a rep ──────────────
  // Restricted to admin/manager: contact assignment is a management action.
  app.patch("/api/contacts/:id/assign", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!Number.isInteger(contactId) || contactId <= 0) {
        return res.status(400).json({ message: "Invalid contact ID" });
      }
      const schema = z.object({
        assignedTo: z.string().email().nullable(),
      });
      const { assignedTo } = schema.parse(req.body);
      const existing = await storage.getContact(contactId);
      if (!existing) return res.status(404).json({ message: "Not found" });

      // Validate that the target email belongs to a real dashboard user.
      if (assignedTo !== null) {
        const { users: usersTable } = await import("@shared/schema");
        const [repRow] = await db.select({ id: usersTable.id }).from(usersTable)
          .where(eq(usersTable.email, assignedTo))
          .limit(1);
        if (!repRow) {
          return res.status(400).json({ message: `No user account found for ${assignedTo}` });
        }
      }

      const updated = await storage.updateContact(contactId, { assignedTo } as any);
      await storage.createAuditLog({
        action: "contact_assigned",
        entityType: "contact",
        entityId: contactId,
        userId: (req.user as any)?.id ?? null,
        details: { assignedTo, previousAssignedTo: (existing as any).assignedTo ?? null },
      });
      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.post("/api/contacts", isDashboardUser, async (req, res) => {
    let committedContact: Awaited<ReturnType<typeof writeContact>> | undefined;
    let durableRequestId: string | undefined;
    try {
      const input = insertContactSchema.parse(req.body);
      const userId = (req.user as any)?.id ?? null;
      const idempotencyKey = req.header("Idempotency-Key");
      if (!idempotencyKey) {
        return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required for manual CRM creation" });
      }
      const inboundClaim = await claimInboundRequest({
        idempotencyKey,
        sourceCategory: "manual_crm",
        sourceType: "dashboard",
        callerScope: `user:${String(userId ?? "unknown")}`,
        actorType: "user",
        actorId: userId ? String(userId) : null,
        payload: input,
      });
      if (inboundClaim.outcome === "conflict") {
        return res.status(409).json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency-Key was used with a different request" });
      }
      if (inboundClaim.outcome === "scope_mismatch") {
        return res.status(403).json({ code: "IDEMPOTENCY_KEY_SCOPE_MISMATCH", message: "Idempotency-Key belongs to a different user" });
      }
      durableRequestId = inboundClaim.request.id;
      if (inboundClaim.outcome === "replay" && inboundClaim.request.contactId) {
        const existing = await storage.getContact(inboundClaim.request.contactId);
        if (existing) {
          if (!await authorizeContactAccess(req, res, existing.id)) return;
          committedContact = existing as Awaited<ReturnType<typeof writeContact>>;
          const request = ["accepted", "completed"].includes(inboundClaim.request.lifecycleState)
            ? inboundClaim.request
            : await handoffLocalContact({ requestId: inboundClaim.request.id, contactId: existing.id });
          const projection = await pool.query<{ state: string }>(
            "SELECT state FROM contact_provider_projections WHERE contact_id=$1 AND provider='ghl' LIMIT 1", [existing.id],
          );
          const projectionState = projection.rows[0]?.state ?? "not_observed";
          const projectionPending = projection.rows.length > 0 && projectionState !== "completed";
          return res.status(!projectionPending && ["accepted", "completed"].includes(request.lifecycleState) ? 200 : 202)
            .json({ ...existing, _ghlSyncPending: projectionPending,
              _handoff: { requestId: request.id, state: request.lifecycleState, replay: true,
                providerProjection: projectionState, providerDelivery: "not_observed" } });
        }
      }
      const contact = await createLocalContact({
        mode: "local_first",
        mutation: input as any,
        provenance: {
          sourceCategory: "manual_crm",
          sourceType: "dashboard",
          eventKey: `manual:${inboundClaim.request.id}`,
          actorType: "user",
          actorId: userId ? String(userId) : undefined,
        },
        actor: { actorType: "user", actorId: userId ? String(userId) : null, userId },
      });
      committedContact = contact;
      // The request authority owns the only task/assignment handoff.  All
      // external effects remain held in its frozen manifest.
      const handoff = await handoffLocalContact({ requestId: inboundClaim.request.id, contactId: contact.id });

      const statusCode = contact._ghlSyncPending || !["accepted", "completed"].includes(handoff.lifecycleState) ? 202 : 201;
      res.status(statusCode).json({ ...contact, _handoff: { requestId: handoff.id, state: handoff.lifecycleState, replay: false } });
    } catch (err: any) {
      // A writer can commit before its caller observes a timeout. Recover only
      // this claimed occurrence's source-event identity, never an email guess.
      if (!committedContact && durableRequestId) {
        const persisted = await pool.query<{ contact_id: number }>(
          "SELECT contact_id FROM contact_source_events WHERE event_key=$1 LIMIT 1",
          [`manual:${durableRequestId}`],
        ).catch(() => undefined);
        const contactId = persisted?.rows[0]?.contact_id;
        if (contactId) {
          const existing = await authorizeContactAccess(req, res, contactId);
          if (!existing) return;
          committedContact = existing as Awaited<ReturnType<typeof writeContact>>;
        }
      }
      if (committedContact) {
        return res.status(202).json({ ...committedContact,
          _handoff: { requestId: durableRequestId, state: "degraded", retryable: true },
          message: "Contact saved locally. Handoff is incomplete; retry with the same Idempotency-Key." });
      }
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      if(["CONTACT_MAILBOX_IDENTITY_AMBIGUOUS","CONTACT_SOURCE_EVENT_IDENTITY_AMBIGUOUS"].includes(err?.message))
        return res.status(409).json({message:"Several contacts match this identity. Select the existing contact instead of creating another.",code:err.message});
      if (isUniqueEmailViolation(err)) {
        const existing = await storage.getContactByEmail(req.body?.email || "").catch(() => undefined);
        return res.status(409).json({
          message: "A contact with this email address already exists.",
          existingContactId: existing?.id ?? null,
        });
      }
      serverError(res, err);
    }
  });

  // === COLD LEADS (Re-engagement segment) ===
  app.get("/api/contacts/cold-leads", isDashboardUser, async (req, res) => {
    try {
      const parsedPage = z.coerce.number().int().nonnegative().safe().safeParse(req.query.page ?? 0);
      if (!parsedPage.success) return res.status(400).json({ message: "Invalid page" });
      const page = parsedPage.data;
      const pageSize = 100;
      const asOf = new Date();
      const values: unknown[] = [];
      const predicate = coldLeadPredicate(req.user as any, values, asOf);

      // Single efficient query: all cold leads across full dataset.
      // Uses NOT EXISTS to exclude contacts with any active (non-closed) deal.
      // Bypasses storage pagination cap (500 rows) by querying DB directly.
      const result = await pool.query(`
        SELECT
          c.id,
          c.first_name AS "firstName",
          c.last_name  AS "lastName",
          c.email,
          c.phone,
          c.company_name  AS "companyName",
          c.lead_source   AS "leadSource",
          c.utm_source    AS "utmSource",
          c.referral_source AS "referralSource",
          c.vertical AS "rawVertical",
          ${effectiveContactVerticalSql("c")} AS vertical,
          ${effectiveContactVerticalStatusSql("c")} AS "effectiveVerticalStatus",
          c.status,
          c.tags,
          c.ghl_contact_id AS "ghlContactId",
          COALESCE(c.last_contacted_at, c.created_at) AS "lastActivityDate",
          EXTRACT(DAY FROM NOW() - COALESCE(c.last_contacted_at, c.created_at))::int AS "daysDormant"
        FROM contacts c
        WHERE ${predicate}
        ORDER BY COALESCE(c.last_contacted_at, c.created_at) ASC
      `, values);

      const allColdLeads = result.rows;
      const total = allColdLeads.length;
      const avgDaysDormant = total > 0
        ? Math.round(allColdLeads.reduce((s: number, c: any) => s + (Number(c.daysDormant) || 0), 0) / total)
        : 0;

      res.json({
        data: allColdLeads.slice(page * pageSize, (page + 1) * pageSize),
        total,
        avgDaysDormant,
        meta: { contractVersion: 1, asOf: asOf.toISOString(), unit: "contacts",
          population: "Production sourced contacts dormant over 45 days with no active deal",
          actorScope: (req.user as any)?.role === "agent" ? "owned_or_unassigned_or_owned_deal" : "management",
          revenue: "unavailable", eligibility: "audience_membership_is_not_send_permission" },
        page,
        pageSize,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/contacts/email-health-summary", isDashboardUser, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE ${UNVALIDATED_EMAIL_PREDICATE})::int                 AS active,
          COUNT(*) FILTER (WHERE email_status = 'bounced')::int                       AS bounced,
          COUNT(*) FILTER (WHERE email_status = 'invalid')::int                       AS invalid,
          COUNT(*) FILTER (WHERE email_status = 'opted_out')::int                     AS opted_out
        FROM contacts
        WHERE archived_at IS NULL
      `);
      res.json(result.rows[0]);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Confirmation Status Batch ──────────────────────────────────────────────
  // POST /api/contacts/confirmation-status/batch
  // Registered BEFORE /:id wildcards so "confirmation-status" is not captured
  // as an :id parameter.
  //
  // Accepts up to 200 contactIds; deduplicates before querying.
  // Returns: { statuses: { [contactId]: { status:"failed", ... } | null } }
  // Only contacts with a current "failed" latest submission appear in statuses.
  app.post("/api/contacts/confirmation-status/batch", isDashboardUser, async (req, res) => {
    try {
      const schema = z.object({
        contactIds: z.array(z.number().int().positive().safe()).min(1).max(200),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
          return res.status(400).json({ message: parsed.error!.errors[0].message });
      }
      // Deduplicate before querying
      const unique = Array.from(new Set(parsed.data.contactIds));
      const { getContactConfirmationStatusBatch } = await import("../services/confirmation-status");
      const result = await getContactConfirmationStatusBatch(unique);
      res.json(result);
    } catch (err: any) {
      console.error("[confirmation-status batch POST]", err.message);
      serverError(res, err);
    }
  });

  // ── Data Quality Scanner ─────────────────────────────────────────────────
  // NOTE: These two routes MUST be registered before the generic /:id handler
  // below, otherwise Express matches "quality-summary" and "quality-scan" as
  // contact IDs and returns 404.

  // GET /api/contacts/quality-summary
  // Returns aggregate counts for the quality health dashboard.
  app.get("/api/contacts/quality-summary", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*)::int                                                                          AS total_contacts,
          COUNT(*) FILTER (WHERE COALESCE(TRIM(first_name), '') = '')::int                      AS blank_first_name,
          COUNT(*) FILTER (WHERE ${UNVALIDATED_EMAIL_PREDICATE})::int                           AS unvalidated_email,
          COUNT(*) FILTER (WHERE email_status IN ('bounced', 'invalid', 'unsafe'))::int         AS bad_email,
          COUNT(*) FILTER (WHERE COALESCE(TRIM(vertical), '') = '')::int                       AS missing_vertical,
          COUNT(*) FILTER (WHERE COALESCE(TRIM(phone), '') = '')::int                          AS missing_phone,
          COUNT(*) FILTER (WHERE email_status = 'valid')::int                                  AS verified_valid,
          COUNT(*) FILTER (WHERE email_status = 'unverified')::int                             AS catch_all
        FROM contacts
        WHERE archived_at IS NULL
      `);
      res.json(result.rows[0]);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/contacts/quality-scan?issue=blank_name|unvalidated_email|bad_email|missing_vertical|missing_phone&page=1&limit=50
  app.get("/api/contacts/quality-scan", requireRole("admin", "manager"), async (req, res) => {
    try {
      const issue = req.query.issue as string | undefined;
      const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10));
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
      const offset = (page - 1) * limit;
      const minLeadScore = parseInt(String(req.query.minLeadScore ?? "0"), 10) || 0;

      const issueFilters: Record<string, string> = {
        blank_name:        `COALESCE(TRIM(first_name), '') = ''`,
        unvalidated_email: UNVALIDATED_EMAIL_PREDICATE,
        bad_email:         `email_status IN ('bounced', 'invalid', 'unsafe')`,
        missing_vertical:  `COALESCE(TRIM(vertical), '') = ''`,
        missing_phone:     `COALESCE(TRIM(phone), '') = ''`,
      };

      const whereClause = issue && issueFilters[issue]
        ? `archived_at IS NULL AND (${issueFilters[issue]}) AND COALESCE(lead_score, 0) >= ${minLeadScore}`
        : `archived_at IS NULL AND COALESCE(lead_score, 0) >= ${minLeadScore}`;

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM contacts WHERE ${whereClause}`,
      );

      const rowsResult = await pool.query(`
        SELECT
          id, first_name, last_name, email, email_status,
          phone, vertical, company_name, lead_score,
          created_at
        FROM contacts
        WHERE ${whereClause}
        ORDER BY COALESCE(lead_score, 0) DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      res.json({
        total: countResult.rows[0]?.total ?? 0,
        page,
        limit,
        data: rowsResult.rows,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Blocked contacts list ────────────────────────────────────────────────────
  // #1784 — GET /api/contacts/class-counts — per-class contact counts (admin/manager)
  app.get("/api/contacts/class-counts", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const result = await pool.query<{ record_class: string; cnt: string }>(
        `SELECT record_class, COUNT(*)::text AS cnt FROM contacts WHERE archived_at IS NULL GROUP BY record_class`
      );
      const counts: Record<string, number> = { production: 0, test: 0, demo: 0, synthetic: 0, unknown: 0 };
      let total = 0;
      for (const row of result.rows) {
        const cls = row.record_class ?? "unknown";
        const n = parseInt(row.cnt, 10);
        if (cls in counts) counts[cls] = n;
        total += n;
      }
      res.json({ ...counts, total });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/contacts/blocked?emailStatus=&doNotContact=&reason=&page=&limit=
  app.get("/api/contacts/blocked", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10));
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
      const offset = (page - 1) * limit;

      const emailStatus   = req.query.emailStatus   ? String(req.query.emailStatus)   : undefined;
      const doNotContact  = req.query.doNotContact  ? String(req.query.doNotContact)  : undefined;
      const reason        = req.query.reason        ? String(req.query.reason)        : undefined;

      const conditions: string[] = [
        `archived_at IS NULL`,
        `(do_not_contact = true OR email_status IN ('bounced','invalid','opted_out','unsafe'))`,
      ];

      if (emailStatus) conditions.push(`email_status = '${emailStatus.replace(/'/g, "''")}'`);
      if (doNotContact === "true")  conditions.push(`do_not_contact = true`);
      if (doNotContact === "false") conditions.push(`do_not_contact = false`);
      if (reason) conditions.push(`(dnc_reason ILIKE '%${reason.replace(/'/g, "''")}%' OR suppression_reason ILIKE '%${reason.replace(/'/g, "''")}%')`);

      const whereClause = conditions.join(" AND ");

      const [countResult, rowsResult] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total FROM contacts WHERE ${whereClause}`),
        pool.query(`
          SELECT id, first_name, last_name, email, phone,
                 email_status, sms_status, do_not_contact,
                 do_not_auto_contact, dnc_reason, suppression_reason,
                 created_at
          FROM contacts
          WHERE ${whereClause}
          ORDER BY id DESC
          LIMIT ${limit} OFFSET ${offset}
        `),
      ]);

      res.json({
        total: countResult.rows[0]?.total ?? 0,
        page,
        limit,
        data: rowsResult.rows,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // Full contacts CSV export (no row cap)
  // GET /api/contacts/export-csv?status=&vertical=&assignedTo=&search=
  // Admin/manager only. Uses raw pool query — no ORM-imposed 500-row limit.
  app.get("/api/contacts/export-csv", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const parsed = parseContactsFilters(req);
      if (parsed.error) return res.status(400).json(parsed.error);
      const params: unknown[] = [];
      const whereClause = contactReadPredicate(req.user as any, parsed.filters!, params);
      const result = await pool.query(
        `SELECT id, first_name, last_name, email, phone,
                company_name, ${effectiveContactVerticalSql("c")} AS vertical, status,
                email_status, sms_status, do_not_contact,
                monthly_volume, current_provider, assigned_to,
                created_at, last_contacted_at
          FROM contacts c
         WHERE ${whereClause}
         ORDER BY id DESC`,
        params,
      );

      function csvEsc(val: unknown): string {
        if (val == null) return "";
        const s = String(val);
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      }

      const headers = [
        "id", "firstName", "lastName", "email", "phone",
        "companyName", "vertical", "status",
        "emailStatus", "smsStatus", "doNotContact",
        "monthlyVolume", "currentProvider", "assignedTo",
        "createdAt", "lastContactedAt",
      ];

      const rows = result.rows.map((r) => [
        r.id, r.first_name, r.last_name, r.email, r.phone,
        r.company_name, r.vertical, r.status,
        r.email_status, r.sms_status, r.do_not_contact,
        r.monthly_volume, r.current_provider, r.assigned_to,
        r.created_at ? new Date(r.created_at).toISOString() : "",
        r.last_contacted_at ? new Date(r.last_contacted_at).toISOString() : "",
      ].map(csvEsc).join(","));

      const csv = [headers.join(","), ...rows].join("\n");
      const date = new Date().toISOString().split("T")[0];
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("X-Metric-Population", "people_matching_shared_filters");
      res.setHeader("X-Metric-Record-Class", parsed.filters!.recordClass ?? "all");
      res.setHeader("X-Metric-Observed-At", new Date().toISOString());
      res.setHeader("Content-Disposition", `attachment; filename="contacts-${date}.csv"`);
      res.send(csv);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Blocked contacts CSV export ───────────────────────────────────────────
  // GET /api/contacts/blocked/export-csv?emailStatus=&doNotContact=&reason=
  app.get("/api/contacts/blocked/export-csv", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const emailStatus  = req.query.emailStatus  ? String(req.query.emailStatus)  : undefined;
      const doNotContact = req.query.doNotContact ? String(req.query.doNotContact) : undefined;
      const reason       = req.query.reason       ? String(req.query.reason)       : undefined;

      // Build the query with proper parameterization to prevent SQL injection.
      const params: unknown[] = [];
      const conditions: string[] = [
        `archived_at IS NULL`,
        `(do_not_contact = true OR email_status IN ('bounced','invalid','opted_out','unsafe'))`,
      ];

      if (emailStatus) {
        params.push(emailStatus);
        conditions.push(`email_status = $${params.length}`);
      }
      if (doNotContact === "true")  conditions.push(`do_not_contact = true`);
      if (doNotContact === "false") conditions.push(`do_not_contact = false`);
      if (reason) {
        params.push(`%${reason}%`);
        conditions.push(`(dnc_reason ILIKE $${params.length} OR suppression_reason ILIKE $${params.length})`);
      }

      const whereClause = conditions.join(" AND ");

      const rowsResult = await pool.query(
        `SELECT id, first_name, last_name, email, phone,
                email_status, sms_status, do_not_contact,
                do_not_auto_contact, dnc_reason, suppression_reason,
                created_at
         FROM contacts
         WHERE ${whereClause}
         ORDER BY id DESC`,
        params,
      );

      function csvEscape(val: unknown): string {
        if (val == null) return "";
        const s = String(val);
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      }

      const headers = [
        "id", "firstName", "lastName", "email", "phone",
        "emailStatus", "smsStatus", "doNotContact", "doNotAutoContact",
        "blockedReason", "createdAt",
      ];

      const rows = rowsResult.rows.map((r) => [
        r.id,
        r.first_name,
        r.last_name,
        r.email,
        r.phone,
        r.email_status,
        r.sms_status,
        r.do_not_contact,
        r.do_not_auto_contact,
        r.dnc_reason || r.suppression_reason,
        r.created_at ? new Date(r.created_at).toISOString() : "",
      ].map(csvEscape).join(","));

      const csv = [headers.join(","), ...rows].join("\n");
      const date = new Date().toISOString().split("T")[0];

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="blocked-contacts-${date}.csv"`);
      res.send(csv);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Generic contact lookup (must stay after all fixed-path /contacts/* routes) ──
  // GET /api/contacts/validate-emails-campaign — active campaign summary (#1541).
  // Active campaign joined with its latest run, counts from zerobounce_attempts
  // (source of truth), and a live remaining-eligible count.
  app.get("/api/contacts/validate-emails-campaign", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { markStaleRunsInterrupted } = await import("../services/zerobounce-campaign-worker");
      const { buildZbEligibilityWhere } = await import("../services/zerobounce-eligibility");
      await markStaleRunsInterrupted();

      const campaign = (await pool.query(
        `SELECT * FROM zerobounce_campaigns WHERE status = 'active' LIMIT 1`,
      )).rows[0];
      if (!campaign) return res.json({ active: false, campaign: null, latestRun: null });

      const [latestRun, counts] = await Promise.all([
        pool.query(
          `SELECT * FROM zerobounce_runs WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [campaign.id],
        ).then(r => r.rows[0] ?? null),
        pool.query(
          `SELECT
             COUNT(*)::int                                             AS claimed,
             COUNT(*) FILTER (WHERE outcome = 'completed')::int        AS completed,
             COUNT(*) FILTER (WHERE outcome = 'retryable_failed')::int AS retryable_failed,
             COUNT(*) FILTER (WHERE outcome = 'skipped')::int          AS skipped,
             COUNT(*) FILTER (WHERE outcome = 'error')::int            AS errors,
             COUNT(*) FILTER (WHERE outcome = 'pending')::int          AS pending,
             COUNT(*) FILTER (WHERE provider_status = 'valid')::int    AS valid,
             COUNT(*) FILTER (WHERE provider_status = 'unsafe')::int   AS blocked
           FROM zerobounce_attempts WHERE campaign_id = $1`,
          [campaign.id],
        ).then(r => r.rows[0]),
      ]);

      const filter = (campaign.filter_definition ?? {}) as ZbCampaignFilter;
      const remainingRow = await pool.query(
        `SELECT COUNT(*)::int AS n FROM contacts c
          WHERE ${buildZbEligibilityWhere(filter)}
            AND NOT EXISTS (SELECT 1 FROM zerobounce_attempts a WHERE a.campaign_id = $1 AND a.contact_id = c.id)`,
        [campaign.id],
      );

      res.json({
        active: true,
        campaign: {
          id: campaign.id,
          filterDefinition: filter,
          initialEligibleTotal: campaign.initial_eligible_total,
          status: campaign.status,
          createdAt: campaign.created_at,
          createdBy: campaign.created_by,
        },
        counts: {
          claimed: counts.claimed,
          providerCompleted: counts.completed,
          retryableFailed: counts.retryable_failed,
          skippedPlaceholders: counts.skipped,
          errors: counts.errors,
          pending: counts.pending,
          valid: counts.valid,
          blocked: counts.blocked,
          remainingEligible: remainingRow.rows[0]?.n ?? 0,
        },
        latestRun: latestRun ? {
          id: latestRun.id,
          state: latestRun.state,
          stopReason: latestRun.stop_reason,
          cancelRequested: latestRun.cancel_requested,
          contactLimit: latestRun.contact_limit,
          lastHeartbeatAt: latestRun.last_heartbeat_at,
          startedAt: latestRun.started_at,
          finishedAt: latestRun.finished_at,
        } : null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Reconnects the working Serper-backed contact enrichment path (task #1943).
  // This calls enrichContactBatch() directly — it performs real Serper lookups
  // and writes email/phone/website straight onto the contact record. It does
  // NOT forward into the CRO-03/MI candidate-factory pipeline, which is gated
  // behind a separate, not-yet-issued production certification (task #1739);
  // that pipeline and its gate are untouched by this route.
  //
  // Registered ahead of GET /api/contacts/:id — Express matches routes in
  // registration order and "enrich-progress" would otherwise be swallowed by
  // the :id param route.
  app.post("/api/contacts/enrich-batch", requireRole("admin", "manager"), async (req, res) => {
    try {
      const schema = z.object({
        contactIds: z.array(z.number().int().positive()).optional().default([]),
        limit: z.number().int().min(1).max(1000).optional().default(100),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message, errors: parsed.error.errors });
      }

      let contactIds = parsed.data.contactIds;
      const limit = parsed.data.limit;

      if (contactIds.length === 0) {
        contactIds = await getContactIdsNeedingEnrichment(limit);
      }

      if (contactIds.length === 0) {
        return res.json({ message: "No contacts need enrichment", processed: 0 });
      }

      if (isContactEnrichRunning()) {
        return res.status(409).json({
          code: "ENRICHMENT_ALREADY_RUNNING",
          message: "A contact enrichment batch is already running. Check /api/contacts/enrich-progress.",
        });
      }

      // Runs in the background — a batch against real Serper lookups can take
      // minutes; the client polls /api/contacts/enrich-progress for status.
      enrichContactBatch(contactIds).catch(err =>
        console.error("[ContactEnrich] Batch enrichment failed:", err)
      );

      res.status(202).json({
        message: "Enrichment batch started",
        total: contactIds.length,
        statusUrl: "/api/contacts/enrich-progress",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/contacts/enrich-progress", isDashboardUser, async (req, res) => {
    try {
      const progress = await storage.getSystemSetting("contact_enrich_batch_progress");
      const backlogRemaining = await getEnrichmentBacklogCount();
      res.json({ ...(progress as object || { status: "idle" }), backlogRemaining });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/contacts/:id", isDashboardUser, async (req, res, next) => {
    try {
      // Literal collection readers registered by later modules share this one-segment shape. Without this
      // deferral the dynamic route consumed them as a contact id (production 404 on readiness-stats).
      if (CONTACT_COLLECTION_READERS_REGISTERED_LATER.has(String(req.params.id))) return next("route");
      const contactId = Number(req.params.id);
      if (!Number.isInteger(contactId) || contactId <= 0) {
        return res.status(404).json({ message: "Not found", code: "NOT_FOUND" });
      }
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Not found" });
      // Agent-scope ownership guard: mirrors the write-path guard on PUT /contacts/:id.
      // Only fires when assigned_to is explicitly set to a different rep — unassigned
      // contacts remain readable by all agents (common state for in-flight leads).
      const _getRole = (req.user as any)?.role;
      const _getEmail = (req.user as any)?.email;
      const _assignedTo = (contact as any).assignedTo as string | null | undefined;
      if (_getRole === "agent" && _assignedTo && _assignedTo !== _getEmail) {
        return res.status(403).json({ message: "Forbidden", code: "NOT_YOUR_CONTACT" });
      }
      res.json(contact);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/contacts/:id", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const existing = await storage.getContact(contactId);
      if (!existing) return res.status(404).json({ message: "Not found" });

      // Agent-scope ownership guard on write path (mirrors GET guard).
      const _putRole = (req.user as any)?.role;
      const _putEmail = (req.user as any)?.email;
      const _assignedTo = (existing as any).assignedTo as string | null | undefined;
      if (_putRole === "agent" && _assignedTo && _assignedTo !== _putEmail) {
        return res.status(403).json({ message: "Forbidden", code: "NOT_YOUR_CONTACT" });
      }

      const contactDateSchema = z.object({
        lastScoredAt: z.coerce.date().optional().nullable(),
        smsOptInAt: z.coerce.date().optional().nullable(),
        emailOptInAt: z.coerce.date().optional().nullable(),
        lastContactedAt: z.coerce.date().optional().nullable(),
        coolingUntil: z.coerce.date().optional().nullable(),
        linkedinEnrichedAt: z.coerce.date().optional().nullable(),
        archivedAt: z.coerce.date().optional().nullable(),
        lastSyncedAt: z.coerce.date().optional().nullable(),
        bouncedAt: z.coerce.date().optional().nullable(),
        lastVoicemailAt: z.coerce.date().optional().nullable(),
        offerRoutedAt: z.coerce.date().optional().nullable(),
      }).passthrough();
      const rawBody = contactDateSchema.parse(req.body);
      // Strip provenance fields — they are immutable after first set and must never be
      // overwritten via the PUT route (defense layer 1; storage.updateContact is layer 2).
      const strippedBody = stripProvenanceFields(rawBody as Record<string, unknown>) as typeof rawBody;
      // assignedTo is a privileged field — only the role-guarded PATCH /assign endpoint
      // may write it. Strip it here so agents/reps cannot bypass the guard via PUT.
      delete (strippedBody as any).assignedTo;
      // lifecycleState and lifecycleStateUpdatedAt are managed exclusively by
      // LifecycleService. Strip them here so no client can bypass the transition
      // guard, validation, or history insertion via this generic update path.
      // (storage.updateContact is defense-in-depth layer 2.)
      delete (strippedBody as any).lifecycleState;
      delete (strippedBody as any).lifecycleStateUpdatedAt;
      // Consent, suppression, reachability, tiers, and opt-out timestamps are
      // authority-owned. Generic CRM edits must never change their projections.
      for (const field of [
        "consentEmail", "consentSms", "consentTier", "doNotContact", "doNotAutoContact",
        "optedOutEmail", "emailStatus", "smsStatus", "smsOptInAt", "emailOptInAt",
        "bouncedAt",
      ]) delete (strippedBody as any)[field];
      // Normalize ghlContactId from passthrough body before it reaches any write path.
      if ((strippedBody as any).ghlContactId !== undefined) {
        (strippedBody as any).ghlContactId = normalizeGhlId((strippedBody as any).ghlContactId);
      }
      if (Object.prototype.hasOwnProperty.call(strippedBody,"vertical")) {
        (strippedBody as any).manualVerticalOverride = (req.body as any).manualVerticalOverride === false
          ? false : !!(strippedBody as any).vertical;
      }
      const body = strippedBody;
      const updated = await updateContactLocalFirst(contactId, body, { actorType: "user", userId: (req.user as any)?.id ?? null });
      if (!updated) return res.status(404).json({ message: "Not found" });

      // ── Lifecycle side-effect: status change may indicate lifecycle advance ──
      {
        const newLifecycleStage = (req.body as any)?.lifecycleStage as string | undefined;
        const newStatus = (req.body as any)?.status as string | undefined;
        let lcState: import("../services/lifecycle-service").LifecycleState | null = null;
        if (newStatus) {
          const statusLower = newStatus.toLowerCase();
          if (statusLower.includes("won") || statusLower.includes("closed won")) {
            lcState = "APPLICATION_COMPLETE";
          } else if (statusLower.includes("lost") || statusLower.includes("closed lost")) {
            lcState = "CLOSED_LOST";
          } else if (statusLower.includes("active")) {
            lcState = "ACTIVE_PROCESSING";
          }
        }
        if (!lcState && newLifecycleStage) {
          const stageLower = newLifecycleStage.toLowerCase();
          if (stageLower === "customer" || stageLower === "client") {
            lcState = "ACTIVE_PROCESSING";
          } else if (stageLower === "opportunity") {
            lcState = "ENGAGED";
          }
        }
        if (lcState) {
          LifecycleService.transition(contactId, lcState, {
            trigger: "contact_status_update",
            source: "contacts-put",
            actorType: "user",
            actorId: (req.user as any)?.id ? String((req.user as any).id) : undefined,
          }).catch((err: Error) =>
            console.warn(`[Lifecycle] Side-effect transition failed for contact #${contactId}:`, err.message),
          );
        }
      }

      // If this update sets an opt-out signal, suppress New Lead auto-enrollment
      const isOptOut =
        body.consentTier === "opted_out" ||
        body.emailStatus === "opted_out" || body.emailStatus === "unsubscribed" ||
        body.optedOutEmail === true ||
        body.doNotContact === true;
      if (isOptOut) {
        const reason = body.doNotContact
          ? "admin_do_not_contact"
          : body.consentTier === "opted_out"
          ? "admin_consent_tier_opted_out"
          : body.emailStatus === "opted_out" || body.emailStatus === "unsubscribed"
          ? "admin_email_status_opted_out"
          : "admin_opted_out_email_flag";
        const { suppressNewLeadAutoEnrollmentForContact } = await import("../services/new-lead-enrollment-job");
        suppressNewLeadAutoEnrollmentForContact(contactId, reason).catch((err: any) =>
          console.error("[contacts PUT] suppression error:", err?.message)
        );
      }

      // Re-extract relationships when key identifiers change
      const phoneChanged = req.body?.phone !== undefined && req.body.phone !== existing?.phone;
      const addressChanged = req.body?.address !== undefined && req.body.address !== existing?.address;
      if (phoneChanged || addressChanged) {
        extractRelationshipsForContact(contactId).catch((err) =>
          console.warn("[Relationships] Re-extraction on update failed:", err),
        );
      }

      const newStatus = req.body?.status as string | undefined;
      const newTags = req.body?.tags as string[] | undefined;
      const isTerminatedStatus =
        newStatus &&
        (newStatus.toLowerCase().includes("terminated") ||
          newStatus.toLowerCase().includes("closed lost") ||
          newStatus.toLowerCase().includes("declined"));
      const hasRiskTag =
        newTags &&
        newTags.some(
          (t) =>
            t.toLowerCase().includes("terminated") ||
            t.toLowerCase().includes("high-chargeback") ||
            t.toLowerCase().includes("fraud"),
        );
      const wasAlreadyTerminated =
        existing?.status?.toLowerCase().includes("terminated") ||
        existing?.status?.toLowerCase().includes("closed lost");

      if ((isTerminatedStatus && !wasAlreadyTerminated) || hasRiskTag) {
        const reason = isTerminatedStatus
          ? `Contact marked as ${newStatus}`
          : `Risk tag added: ${(newTags ?? []).filter((t) => t.toLowerCase().includes("terminated") || t.toLowerCase().includes("high-chargeback") || t.toLowerCase().includes("fraud")).join(", ")}`;
        propagateRiskFlagToRelatedEntities(contactId, reason).catch((err) =>
          console.warn("[Relationships] Risk propagation failed:", err),
        );
      }

      const statusCode = updated._ghlSyncFailed ? 202 : 200;
      res.status(statusCode).json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join(".") });
      if (err instanceof DateValidationError) return res.status(400).json({ message: err.message, field: err.field });
      if (isUniqueEmailViolation(err)) {
        const existing = await storage.getContactByEmail(req.body?.email || "").catch(() => undefined);
        return res.status(409).json({
          message: "A contact with this email address already exists.",
          existingContactId: existing?.id ?? null,
        });
      }
      serverError(res, err);
    }
  });

  // === RE-ENGAGE (Cold Lead Re-engagement) ===
  app.post("/api/contacts/bulk-re-engage", isDashboardUser, async (req, res) => {
    try {
      const schema = z.object({
        contactIds: z.array(z.number().int().positive()).min(1).max(200),
      });
      const { contactIds } = schema.parse(req.body);
      if (new Set(contactIds).size !== contactIds.length) return res.status(400).json({ message: "Duplicate contact ids" });
      const result = await requestColdReengagement(req.user as any, contactIds);
      if (result.denied) return res.status(404).json({ message: "Not found" });
      res.json(result);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.post("/api/contacts/:id/re-engage", isDashboardUser, async (req, res) => {
    try {
      const parsedId = z.coerce.number().int().positive().safe().safeParse(req.params.id);
      if (!parsedId.success) return res.status(400).json({ message: "Invalid contact id" });
      const result = await requestColdReengagement(req.user as any, [parsedId.data]);
      if (result.denied) return res.status(404).json({ message: "Not found" });
      res.json({ success: false, processed: true, ...result.outcomes[0] });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/serper/status", isDashboardUser, async (req, res) => {
    try {
      const configured = isSerperConfigured();
      const usage = await getSerperUsage();
      res.json({ configured, usage });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/serper/reset-usage", requireRole("admin", "manager"), async (req, res) => {
    try {
      await resetSerperUsage();
      res.json({ success: true, message: "Serper usage stats reset" });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === PROXYCURL STATUS ===
  app.get("/api/proxycurl/status", isDashboardUser, async (req, res) => {
    res.json({
      configured: false,
      enabled: false,
      state: "disabled_pending_durable_operation",
      message: "Proxycurl enrichment requires an approved durable provider operation.",
    });
  });

  // === LINKEDIN ENRICHMENT ===
  app.post("/api/contacts/:id/enrich-linkedin", isDashboardUser, async (req, res) => {
    try {
      return res.status(503).json({ message: "LinkedIn enrichment is disabled pending a durable approved provider operation." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/contacts/bulk-enrich-linkedin", isDashboardUser, async (req, res) => {
    try {
      return res.status(503).json({ message: "Bulk LinkedIn enrichment is disabled pending a durable approved provider operation." });
      const schema = z.object({
        contactIds: z.array(z.number().int().positive()).min(1).max(100),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
          return res.status(400).json({ message: "Invalid bulk enrichment request" });
      }
      res.json({ message: `LinkedIn enrichment started for ${parsed.data!.contactIds.length} contacts`, started: true });
      bulkEnrichFromLinkedIn(parsed.data!.contactIds).catch(err =>
        console.error("[LinkedIn Bulk Enrich] Error:", err)
      );
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === OFFER ROUTING ===

  app.post("/api/contacts/:id/enrich", requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      const idempotencyKey = req.header("idempotency-key");
      if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key is required" });
      }

      const command = await createCro03Batch({
        idempotencyKey,
        contactIds: [contactId], actorType: "user",
        actorId: String((req.user as any)?.id ?? ""),
      });
      res.status(command.replayed ? 200 : 202).json({
        success: true, batchId: command.id, statusUrl: `/api/cro03/batches/${command.id}`,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/contacts/:id/route-offer", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const { routeOfferBodySchema } = await import("@shared/offer-router-types");
      const parsed = routeOfferBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { dryRun, forceAi, updateContact } = parsed.data;

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const { routeOffer } = await import("../services/offer-router");
      const result = await routeOffer(contact, { forceAi: forceAi ?? false });

      if (updateContact === true && dryRun !== true && result.shouldUpdateContact) {
        const updated = await updateContactLocalFirst(contactId, {
          primaryOfferPath: result.offerRoute,
          offerConfidence: result.offerConfidence,
          recommendedNextAction: result.recommendedNextAction,
          offerReasoning: result.offerReasoning,
          offerRoutingSource: result.routingSource,
          processorDetected: result.processorDetected ?? null,
          offerRoutedAt: new Date(),
          offerMatchedSignals: result.matchedSignals,
        }, { actorType: "system", userId: (req.user as any)?.id ?? null });
        return res.json({ contact: updated, offerRouting: result, updated: true });
      }

      const wasBlocked = updateContact === true && dryRun !== true && !result.shouldUpdateContact;
      res.json({ offerRouting: result, updated: false, dryRun: dryRun === true || updateContact !== true, skippedManualOverride: wasBlocked });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.patch("/api/contacts/:id/offer-route", requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const { manualOverrideBodySchema } = await import("@shared/offer-router-types");
      const parsed = manualOverrideBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message, errors: parsed.error.errors });
      }
      const { offerRoute, recommendedNextAction, reason } = parsed.data;

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const prevOfferPath = contact.primaryOfferPath;

      const updated = await storage.updateContact(contactId, {
        primaryOfferPath: offerRoute,
        offerRoutingSource: "manual_override",
        offerRoutedAt: new Date(),
        recommendedNextAction: recommendedNextAction ?? null,
        offerConfidence: null,
        processorDetected: null,
        offerMatchedSignals: null,
      }, { actorType: "user", userId: (req.user as any)?.id ?? null });

      if (!updated) return res.status(404).json({ message: "Contact not found" });

      const { auditChange } = await import("../services/audit-change");
      await auditChange({
        action: "offer_route_manual_override",
        entityType: "contact",
        entityId: contactId,
        before: { primaryOfferPath: prevOfferPath },
        after: { primaryOfferPath: offerRoute },
        details: { reason, role: (req.user as any)?.role },
        userId: String((req.user as any)?.id ?? ""),
        actorType: "user",
      });

      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === COMPANIES ===
  app.get("/api/companies", isDashboardUser, async (req, res) => {
    try {
      const {readCompanies}=await import("../services/company-authority");
      const {bindWorkActor}=await import("../services/work-item-command");
      const companies = await readCompanies(bindWorkActor(req.user));
      res.json(companies);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/companies", isDashboardUser, async (req, res) => {
    try {
      const input = insertCompanySchema.parse(req.body);
      const {createOwnedCompany}=await import("../services/company-authority");
      const {bindWorkActor}=await import("../services/work-item-command");
      const company = await createOwnedCompany(bindWorkActor(req.user),input);
      res.status(201).json(company);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === MULTI-LOCATION / PARENT ACCOUNT ===

  app.get("/api/contacts/:id/locations", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const locations = await storage.getChildLocations(contactId);
      res.json(locations);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/contacts/:id/locations", isDashboardUser, async (req, res) => {
    try {
      const parentId = Number(req.params.id);
      const schema = z.object({
        contactId: z.number().int().positive(),
        locationName: z.string().optional(),
      });
      const { contactId: childId, locationName } = schema.parse(req.body);

      if (childId === parentId) {
        return res.status(400).json({ message: "A contact cannot be linked to itself" });
      }

      const parent = await storage.getContact(parentId);
      if (!parent) return res.status(404).json({ message: "Parent contact not found" });

      // Prevent parent from being a child itself (no grandparent hierarchies)
      if (parent.parentContactId) {
        return res.status(400).json({ message: "The parent contact is already a child location of another account. Nested hierarchies are not supported." });
      }

      const child = await storage.getContact(childId);
      if (!child) return res.status(404).json({ message: "Child contact not found" });

      // Prevent child that is itself a parent (would create a fan-out hierarchy)
      const existingChildren = await storage.getChildLocations(childId);
      if (existingChildren.length > 0) {
        return res.status(400).json({ message: "This contact already manages child locations. Move its locations first before linking it as a child." });
      }

      const updates: any = { parentContactId: parentId };
      if (locationName !== undefined) updates.locationName = locationName;

      const updated = await storage.updateContact(childId, updates, { actorType: "user", userId: (req.user as any)?.id ?? null });

      if (!parent.isParentAccount) {
        await storage.updateContact(parentId, { isParentAccount: true }, { actorType: "user", userId: (req.user as any)?.id ?? null });
      }

      // Rep inheritance: propagate parent's agent assignment to child's unassigned deals
      try {
        const parentDeals = await storage.getDealsByContact(parentId);
        const childDeals = await storage.getDealsByContact(childId);
        for (const parentDeal of parentDeals) {
          const parentAgentRows = await storage.getAgentMerchantsByDeal(parentDeal.id);
          if (parentAgentRows.length === 0) continue;
          const parentAgent = parentAgentRows[0];
          for (const childDeal of childDeals) {
            const childAgentRows = await storage.getAgentMerchantsByDeal(childDeal.id);
            if (childAgentRows.length === 0) {
              await storage.assignMerchantToAgent({
                agentId: parentAgent.agentId,
                dealId: childDeal.id,
              } as any);
            }
          }
        }
      } catch (repErr: any) {
        console.error(`[Location Link] Rep inheritance failed for child ${childId}:`, repErr.message);
      }

      await storage.createAuditLog({
        action: "location_linked",
        entityType: "contact",
        entityId: childId,
        details: { parentContactId: parentId, locationName: locationName ?? null },
      });

      res.status(201).json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.delete("/api/contacts/:id/locations/:locationId", isDashboardUser, async (req, res) => {
    try {
      const parentId = Number(req.params.id);
      const locationId = Number(req.params.locationId);

      const child = await storage.getContact(locationId);
      if (!child || child.parentContactId !== parentId) {
        return res.status(404).json({ message: "Location not linked to this parent" });
      }

      await storage.updateContact(locationId, { parentContactId: null, locationName: null }, { actorType: "user", userId: (req.user as any)?.id ?? null });

      const remaining = await storage.getChildLocations(parentId);
      if (remaining.length === 0) {
        await storage.updateContact(parentId, { isParentAccount: false }, { actorType: "user", userId: (req.user as any)?.id ?? null });
      }

      await storage.createAuditLog({
        action: "location_unlinked",
        entityType: "contact",
        entityId: locationId,
        details: { parentContactId: parentId },
      });

      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/contacts/:id/group-kpis", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const kpis = await storage.getGroupKpis(contactId);
      res.json(kpis);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/contacts/:id/parent", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const parent = await storage.getParentAccount(contactId);
      res.json(parent ?? null);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/companies/:id", isDashboardUser, async (req, res) => {
    try {
      const {readCompanies}=await import("../services/company-authority");
      const {bindWorkActor}=await import("../services/work-item-command");
      const {strictRecordId}=await import("@shared/work-item-commands");
      const company = await readCompanies(bindWorkActor(req.user),strictRecordId.parse(req.params.id));
      res.json(company);
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:"Invalid company ID"});
      const {WorkCommandError}=await import("../services/work-item-command");
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      serverError(res, err);
    }
  });

  app.get("/api/companies/:id/contacts", isDashboardUser, async (req, res) => {
    try {
      const {readCompanyMembers}=await import("../services/company-authority");
      const {bindWorkActor}=await import("../services/work-item-command");
      const {strictRecordId}=await import("@shared/work-item-commands");
      const rows=await readCompanyMembers(bindWorkActor(req.user),strictRecordId.parse(req.params.id));
      res.json(rows);
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:"Invalid company ID"});
      const {WorkCommandError}=await import("../services/work-item-command");
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      serverError(res, err);
    }
  });

  app.put("/api/companies/:id", isDashboardUser, async (req, res) => {
    try {
      const {updateOwnedCompany}=await import("../services/company-authority");
      const {bindWorkActor}=await import("../services/work-item-command");
      const {strictRecordId}=await import("@shared/work-item-commands");
      const companyId = strictRecordId.parse(req.params.id);
      const input = insertCompanySchema.partial().parse(req.body);
      const company = await updateOwnedCompany(bindWorkActor(req.user),companyId,input);
      // Re-extract relationships for all contacts linked to this company.
      // Uses the batched extractor: 6 total queries regardless of N linked contacts,
      // instead of N*5 queries from calling extractRelationshipsForContact per contact.
      let extractionState="management_review_required";
      if(["admin","manager"].includes((req.user as any).role)) {
        try {
          const links=await storage.getContactCompaniesByCompany(companyId);
          const linkedContactIds=links.map(link=>link.contactId).filter((id):id is number=>id!==null);
          if(linkedContactIds.length) await extractRelationshipsForContactsBatch(linkedContactIds);
          extractionState="completed";
        } catch {extractionState="failed";}
      }
      res.json({...company,extractionState});
    } catch (err: any) {
      const {WorkCommandError}=await import("../services/work-item-command");
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === DECISION MAKER MANUAL OVERRIDE ===
  // PATCH /api/contacts/:id/snooze
  // #523 — Snooze a contact: hide from outreach for N days by setting nextAllowedContactDate.
  app.patch("/api/contacts/:id/snooze", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const { days } = z.object({ days: z.number().int().min(1).max(365) }).parse(req.body);
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const snoozeUntil = new Date();
      snoozeUntil.setDate(snoozeUntil.getDate() + days);

      const updated = await storage.updateContact(contactId, {
        nextAllowedContactDate: snoozeUntil,
      }, { actorType: "user", userId: (req.user as any)?.id ?? null });

      await storage.createAuditLog({
        action: "contact_snoozed",
        entityType: "contact",
        entityId: contactId,
        actorId: String((req as any).user?.id ?? ""),
        actorType: "user",
        details: { days, snoozeUntil: snoozeUntil.toISOString() },
      });

      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.patch("/api/contacts/:id/decision-maker", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!["admin", "manager"].includes((req.user as any)?.role)) return res.status(404).json({ message: "Not found", code: "CRM_OBJECT_NOT_FOUND" });
      const { businessId, decision, expectedRevision } = z.object({
        businessId: z.number().int().positive(),
        decision: z.enum(["decision_maker", "not_decision_maker", "unknown", "conflicted"]),
        expectedRevision: z.number().int().nonnegative().optional(),
      }).parse(req.body);
      const reviewKey = req.get("Idempotency-Key");
      if (!reviewKey || reviewKey.length > 200) return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED" });
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Not found", code: "CRM_OBJECT_NOT_FOUND" });
      const { reviewDecisionMaker } = await import("../services/commercial-relationship-authority");
      const review = await reviewDecisionMaker({ contactId, businessId, decision, reviewKey, expectedRevision, actorId: String((req.user as any)?.id ?? "unknown") });
      res.json({ id: review.id, decision: review.decision });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === MANAGEMENT TYPE ===
  app.patch("/api/contacts/:id/management-type", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const { managementType } = z.object({ managementType: z.enum(["unified", "per_location", "unknown"]) }).parse(req.body);
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      const updated = await storage.updateContact(contactId, { managementType }, { actorType: "user", userId: (req.user as any)?.id ?? null });
      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === LIFECYCLE ADMIN OVERRIDE ===
  // Allows admin/manager to force a contact into any lifecycle state, bypassing
  // the forward-only guard. Writes a lifecycle_manual_override audit log row.
  app.put("/api/contacts/:id/lifecycle-override", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!contactId || isNaN(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const { targetState } = z.object({
        targetState: z.enum(LIFECYCLE_STATES as unknown as [string, ...string[]]),
      }).parse(req.body);

      const actorId = String((req.user as any)?.id ?? "unknown");
      const newState = await adminOverrideTransition(contactId, targetState as LifecycleState, actorId);

      await storage.createAuditLog({
        action: "lifecycle_manual_override",
        entityType: "contact",
        entityId: contactId,
        actorType: "user",
        details: { targetState, newState, actorId },
      });

      res.json({ success: true, contactId, lifecycle_state: newState });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err?.message?.includes("not found")) return res.status(404).json({ message: err.message });
      serverError(res, err);
    }
  });

  app.patch("/api/companies/:id/management-type", isDashboardUser, async (req, res) => {
    try {
      const {updateOwnedCompany}=await import("../services/company-authority");
      const {bindWorkActor}=await import("../services/work-item-command");
      const {strictRecordId}=await import("@shared/work-item-commands");
      const companyId = strictRecordId.parse(req.params.id);
      const { managementType } = z.object({ managementType: z.enum(["unified", "per_location", "unknown"]) }).parse(req.body);
      const updated = await updateOwnedCompany(bindWorkActor(req.user),companyId,{managementType});
      res.json(updated);
    } catch (err: any) {
      const {WorkCommandError}=await import("../services/work-item-command");
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // /api/ma-events GET/POST/DELETE are registered in server/routes/conversation-ai-config.ts
  // (canonical — role-guarded mutations, Zod-validated, with proper relationship sync).

  // === COMPANY INTELLIGENCE EMAIL HEALTH ===
  app.get("/api/contacts/:id/email-health", isDashboardUser, async (req, res) => {
    try {
      const parentId = Number(req.params.id);
      const children = await storage.getChildLocations(parentId);
      const allIds = [parentId, ...children.map(c => c.id)];
      const { db } = await import("../db");
      const { contacts: contactsTable } = await import("@shared/schema");
      const { inArray, isNull, and } = await import("drizzle-orm");
      const allContacts = await db.select({
        id: contactsTable.id,
        email: contactsTable.email,
        emailStatus: contactsTable.emailStatus,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        companyName: contactsTable.companyName,
      }).from(contactsTable).where(
        and(inArray(contactsTable.id, allIds), isNull(contactsTable.archivedAt))
      );

      const summary = {
        total: allContacts.length,
        active: allContacts.filter(c => c.emailStatus === "active").length,
        bounced: allContacts.filter(c => c.emailStatus === "bounced").length,
        invalid: allContacts.filter(c => c.emailStatus === "invalid").length,
        optedOut: allContacts.filter(c => c.emailStatus === "opted-out").length,
        roleBased: allContacts.filter(c => c.emailStatus === "role-based").length,
        contacts: allContacts,
      };
      res.json(summary);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === CONTACTABILITY — Wave 1A ===
  // dryRun mode: no outreach audit logs written; safe to call from dashboards and contact detail pages
  app.get("/api/contacts/:id/contactability", requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const { evaluateAllChannels } = await import("../services/contactability");
      const result = await evaluateAllChannels(contactId);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/contacts/:id/communication-health", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseInt(req.params.id as string);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const { db } = await import("../db");
      const { auditLogs } = await import("@shared/schema");
      const { desc, eq, and, like } = await import("drizzle-orm");

      const recentEvents = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "contact"),
            eq(auditLogs.entityId, contactId),
            like(auditLogs.action, "comm_event_%")
          )
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(10);

      const emailFailed = contact.emailStatus === "bounced";
      const smsFailed = contact.smsStatus === "undeliverable";
      const callFailed = (contact.callAttempts ?? 0) >= 5;
      const allChannelsFailed = emailFailed && smsFailed && callFailed;

      let nextRecommendedAction = "Continue outreach";
      if (contact.doNotAutoContact) {
        nextRecommendedAction = "Manual review — all channels failed";
      } else if (emailFailed && !smsFailed) {
        nextRecommendedAction = "Escalate to SMS";
      } else if (smsFailed && !emailFailed) {
        nextRecommendedAction = "Escalate to email";
      } else if ((contact.callAttempts ?? 0) >= 3) {
        nextRecommendedAction = "Switch to email-first strategy";
      } else if (contact.preferredChannel) {
        nextRecommendedAction = `Prioritize ${contact.preferredChannel} (preferred channel)`;
      }

      res.json({
        contactId,
        email: {
          status: contact.emailStatus ?? "active",
          bouncedAt: contact.bouncedAt ?? null,
        },
        sms: {
          status: contact.smsStatus ?? "active",
        },
        call: {
          attempts: contact.callAttempts ?? 0,
          lastVoicemailAt: contact.lastVoicemailAt ?? null,
        },
        engagementScore: contact.engagementScore ?? 50,
        reachabilityScore: contact.reachabilityScore ?? 100,
        preferredChannel: contact.preferredChannel ?? null,
        doNotAutoContact: contact.doNotAutoContact ?? false,
        allChannelsFailed,
        nextRecommendedAction,
        recentEvents: recentEvents.map(e => ({
          id: e.id,
          action: e.action,
          details: e.details,
          createdAt: e.createdAt,
        })),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── Canonical Communication Timeline (Wave A3) ────────────────────────────

  app.get("/api/contacts/:id/communication-timeline", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseInt(req.params.id as string);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 200);

      const { getContactCommunicationEvents } = await import("../services/communication-events");
      const events = await getContactCommunicationEvents(contactId, limit);

      res.json({ events, total: events.length, contactId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── Manual Communication Event (inbound SMS, etc.) ──────────────────────────
  // #538 — Let reps log an inbound SMS response received from a contact

  app.post("/api/contacts/:id/communication-events", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseInt(req.params.id as string);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const { direction, channel, provider, subject, body, status } = req.body as Record<string, string>;
      const VALID_CHANNELS = ["email", "sms", "call", "voicemail", "chat", "form", "portal", "rvm"];
      if (!channel || !VALID_CHANNELS.includes(channel)) {
        return res.status(400).json({ message: `channel must be one of: ${VALID_CHANNELS.join(", ")}` });
      }

      const { recordInboundEvent, recordOutboundSend } = await import("../services/communication-events");

      let eventId: number | null = null;
      if (direction === "outbound") {
        eventId = await recordOutboundSend({
          contactId,
          channel: channel as any,
          // recordOutboundSend only accepts ghl|smtp|twilio; manual → omit → defaults to "ghl" internally
          provider: (["ghl", "smtp", "twilio"].includes(provider || "") ? provider : undefined) as any,
          subject: subject || null,
          body: body || null,
          status: (status || "sent") as any,
          metadata: { loggedManually: true, loggedByUserId: (req as any).user?.id },
        });
      } else {
        eventId = await recordInboundEvent({
          contactId,
          channel: channel as any,
          provider: (provider || "manual") as any,
          subject: subject || null,
          body: body || null,
          status: (status || "received") as any,
          metadata: { loggedManually: true, loggedByUserId: (req as any).user?.id },
        });
      }

      res.json({ ok: true, eventId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── Statement Request ────────────────────────────────────────────────────────

  app.post("/api/contacts/:id/request-statement", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseInt(req.params.id as string);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact id" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const token = crypto.randomBytes(24).toString("hex");
      const baseUrl = process.env.APP_URL
        || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : null)
        || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
        || "https://libertybancard.com";
      const uploadUrl = `${baseUrl}/statement-upload/${token}`;

      const sdrRows = await db.select({ id: sdrLeadState.id }).from(sdrLeadState)
        .where(eq(sdrLeadState.contactId, contactId)).limit(1);
      const sdrLeadStateId = sdrRows[0]?.id ?? null;

      const statementRequest = await storage.createStatementRequest({
        contactId,
        sdrLeadStateId,
        status: "requested",
        uploadToken: token,
        uploadUrl,
        requestedAt: new Date(),
        createdBy: (req.user as any)?.id ?? null,
      });

      await storage.createAuditLog({
        action: "statement_request_created",
        entityType: "contact",
        entityId: contactId,
        actorType: "user",
        actorId: (req.user as any)?.id ?? null,
        details: { statementRequestId: statementRequest.id, uploadUrl },
      });

      if (req.query.createTask === "true") {
        const marker = `statement_request_id:${statementRequest.id}`;
        await storage.createAuthorityTask({
          contactId,
          title: "Request statement from merchant",
          description: `Statement request created. Upload URL sent. ${marker}`,
          priority: "normal",
          status: "pending",
          assignedTo: (req.user as any)?.id ?? undefined,
        });
      }

      res.json({ statementRequest, uploadUrl });
    } catch (err: any) {
      console.error("[RequestStatement]", err.message);
      serverError(res, err);
    }
  });

  // ─── Sales Prep ───────────────────────────────────────────────────────────────

  app.get("/api/contacts/:id/sales-prep", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseInt(req.params.id as string);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact id" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const {isSdrSourcedContact}=await import("../services/sales-prep");
      const sdrSourced = await isSdrSourcedContact(contactId);

      if (!sdrSourced) {
        return res.json({ sdrSourced: false, cached: null, cacheKey: null, generatedAt: null, canGenerate: false });
      }

      const { checkSalesPrepCache } = await import("../services/sales-prep");
      const cached = await checkSalesPrepCache(contactId);

      res.json({
        sdrSourced: true,
        cached: cached ? cached.output : null,
        cacheKey: cached ? cached.cacheKey : null,
        generatedAt: cached ? cached.generatedAt : null,
        canGenerate: true,
      });
    } catch (err: any) {
      console.error("[SalesPrep GET]", err.message);
      serverError(res, err);
    }
  });

  app.post("/api/contacts/:id/sales-prep/generate", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseInt(req.params.id as string);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact id" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const sdrRows = await db.select({ id: sdrLeadState.id }).from(sdrLeadState)
        .where(eq(sdrLeadState.contactId, contactId)).limit(1);
      if (sdrRows.length === 0) {
        return res.status(400).json({ message: "Contact is not SDR-sourced; sales prep not available" });
      }

      const { generateSalesPrepAi } = await import("../services/sales-prep");
      const result = await generateSalesPrepAi(contactId);

      res.json(result);
    } catch (err: any) {
      console.error("[SalesPrep POST generate]", err.message);
      serverError(res, err);
    }
  });

  // ─── SDR Contactability Status (read-only, dryRun) ────────────────────────
  app.get("/api/contacts/:id/contactability-status", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseInt(req.params.id as string);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact id" });

      const sdrRows = await db.select({ id: sdrLeadState.id }).from(sdrLeadState)
        .where(eq(sdrLeadState.contactId, contactId)).limit(1);
      if (sdrRows.length === 0) {
        return res.json({ sdrSourced: false });
      }

      const { evaluateContactability } = await import("../services/contactability");
      const result = await evaluateContactability({
        contactId,
        channel: "email",
        mode: "dryRun",
        campaignType: "sdr_outreach",
      });

      return res.json({
        sdrSourced: true,
        allowed: result.allowed,
        reason: result.reason,
        channel: "email",
      });
    } catch (err: any) {
      console.error("[SDR contactability-status GET]", err.message);
      serverError(res, err);
    }
  });

  // ─── SDR Manual Email Enrollment ──────────────────────────────────────────
  app.post("/api/contacts/:id/sdr-enroll", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseInt(req.params.id as string);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact id" });

      // Gate 1: parse and validate body
      const bodySchema = z.object({
        sequenceId: z.number().int().positive(),
        confirmed: z.boolean(),
      });
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid request body", errors: parsed.error.errors });
      const { sequenceId, confirmed } = parsed.data;

      if (!confirmed) {
        return res.status(400).json({ message: "Explicit confirmation required" });
      }

      // Gate 2: contact must exist
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      // Gate 3: must be SDR-sourced
      const sdrRows = await db.select({ id: sdrLeadState.id }).from(sdrLeadState)
        .where(eq(sdrLeadState.contactId, contactId)).limit(1);
      if (sdrRows.length === 0) {
        return res.status(403).json({ message: "Contact is not SDR-sourced" });
      }

      // Gate 4: sequence must exist and be active
      const sequence = await storage.getFollowUpSequence(sequenceId);
      if (!sequence || sequence.status !== "active") {
        return res.status(422).json({ message: "Sequence not found or not active" });
      }
      const cr06Decision = decideCr06SequenceLifecycle(sequence);
      if (!cr06Decision.allowed) {
        return res.status(409).json({ message: cr06Decision.reasonCode, code: cr06Decision.reasonCode });
      }

      // Gate 5: sequence must be email-only
      const emailOnlyViolation = await checkEmailOnlyViolation(sequenceId, sequence);
      if (emailOnlyViolation) {
        return res.status(422).json({ message: "Sequence is not email-only — SMS, voice, and ringless are not permitted for SDR contacts" });
      }

      // Gate 6: sequence eligibility check
      const { canEnrollContactInSequence } = await import("../services/sequence-eligibility");
      const eligibility = await canEnrollContactInSequence(contactId, sequence);
      if (!eligibility.allowed) {
        return res.status(422).json({ message: eligibility.reason ?? "Contact is not eligible for this sequence" });
      }

      // Gate 7: contactability gate (enforcement mode — writes audit log internally on block)
      const { evaluateContactability } = await import("../services/contactability");
      const contactability = await evaluateContactability({
        contactId,
        channel: "email",
        mode: "enforcement",
        campaignType: "sdr_outreach",
      });
      if (!contactability.allowed) {
        return res.status(403).json({ message: contactability.reason });
      }

      // Gate 8: duplicate active enrollment guard (after contactability, before insert)
      const existingEnrollments = await storage.getContactEnrollments(contactId);
      const alreadyEnrolled = existingEnrollments.some(
        e => e.sequenceId === sequenceId && e.status === "active"
      );
      if (alreadyEnrolled) {
        return res.status(409).json({ alreadyEnrolled: true, message: "Already enrolled in this sequence" });
      }

      // Compute nextActionAt from first step delay (mirrors smart-router.ts pattern)
      const steps = await storage.getSequenceSteps(sequenceId);
      const firstStep = steps.find(s => s.stepOrder === 1) || steps[0];
      const delayMs = firstStep
        ? ((firstStep.delayDays || 0) * 86400000) + ((firstStep.delayHours || 0) * 3600000)
        : 0;
      const nextActionAt = new Date(Date.now() + Math.max(delayMs, 1000));

      // Enroll
      await storage.createSequenceEnrollment({
        sequenceId,
        contactId,
        status: "active",
        currentStep: 0,
        nextActionAt,
      });

      // Write manual enrollment audit log (distinct from contactability audit in consentAuditLogs)
      await storage.createAuditLog({
        action: "sdr_manual_enrollment",
        entityType: "contact",
        entityId: contactId,
        details: {
          sequenceId,
          sequenceName: sequence.name,
          confirmedBy: (req.user as any)?.id ?? "unknown",
        },
      });

      return res.json({ enrolled: true, sequenceId, sequenceName: sequence.name });
    } catch (err: any) {
      console.error("[SDR sdr-enroll POST]", err.message);
      serverError(res, err);
    }
  });

  // ── Confirmation Status ────────────────────────────────────────────────────
  // GET /api/contacts/:id/confirmation-status
  // Returns inbound confirmation delivery status for a contact.
  //
  // Liberty is single-tenant; all dashboard users may access all contacts.
  // Update with a tenant predicate if multi-tenant support is added.
  app.get("/api/contacts/:id/confirmation-status", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (isNaN(contactId) || contactId <= 0) {
        return res.status(400).json({ message: "Invalid contact ID" });
      }
      const { getContactConfirmationStatuses } = await import("../services/confirmation-status");
      const result = await getContactConfirmationStatuses(contactId);
      res.json(result);
    } catch (err: any) {
      console.error("[confirmation-status GET]", err.message);
      serverError(res, err);
    }
  });

  // ── Mark Do Not Contact ────────────────────────────────────────────────────
  // POST /api/contacts/:id/mark-dnc
  // Requires a reason. Records to audit_logs and updates suppression fields.
  app.post("/api/contacts/:id/mark-dnc", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const schema = z.object({
        reason: z.string().min(3).max(500),
        source: z.string().optional().default("manual_crm"),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { reason, source } = parsed.data;

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const now = new Date();
      const eventKey = `${contactId}:mark-dnc:${typeof req.body.requestId === "string" ? req.body.requestId : crypto.randomUUID()}`;
      await applyConsentCommand({
        subject: { type: "contact", id: contactId },
        kind: "global_dnc",
        purpose: "outreach",
        eventNamespace: "contacts_mark_dnc",
        eventKey,
        source,
        actorId: String((req.user as any)?.id ?? "unknown"),
        evidence: { reason, source, operator: true },
        details: { reason, source, route: "contacts_mark_dnc" },
      });
      const suppressionEvent = { reason, source, date: now.toISOString(), eventKey };

      await storage.createAuditLog({
        action: "contact_marked_dnc",
        entityType: "contact",
        entityId: contactId,
        actorType: "user",
        actorId: String((req.user as any)?.id ?? "unknown"),
        details: { reason, source, suppressionEvent },
      });

      // Suppress any active auto-enrollments
      const { suppressNewLeadAutoEnrollmentForContact } = await import("../services/new-lead-enrollment-job");
      suppressNewLeadAutoEnrollmentForContact(contactId, `dnc:${reason}`).catch((err: any) =>
        console.error("[contacts/mark-dnc] suppression error:", err?.message)
      );

      res.json({ success: true, contactId, reason, markedAt: now.toISOString() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Get suppression status ──────────────────────────────────────────────────
  // GET /api/contacts/:id/suppression-status
  app.get("/api/contacts/:id/suppression-status", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const contact = await storage.getContact(contactId) as any;
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const suppressionReasons: string[] = [];
      if (contact.doNotContact) suppressionReasons.push("do_not_contact");
      if (contact.optOutStatus === "opted_out") suppressionReasons.push("opt_out_status=opted_out");
      if (contact.unsubscribeStatus === "unsubscribed") suppressionReasons.push("unsubscribed");
      if (contact.bounceStatus === "hard") suppressionReasons.push("hard_bounce");
      if (contact.complaintStatus === "reported") suppressionReasons.push("complaint_reported");
      if (contact.emailStatus === "bounced" || contact.emailStatus === "invalid") suppressionReasons.push(`email_status=${contact.emailStatus}`);

      res.json({
        contactId,
        isSuppressed: suppressionReasons.length > 0,
        suppressionReasons,
        suppressionReason: contact.suppressionReason || null,
        doNotContact: contact.doNotContact,
        dncReason: contact.dncReason,
        dncDate: contact.dncDate,
        dncSource: contact.dncSource,
        optOutStatus: contact.optOutStatus || "active",
        optOutDate: contact.optOutDate,
        optOutChannel: contact.optOutChannel,
        unsubscribeStatus: contact.unsubscribeStatus || "active",
        unsubscribeDate: contact.unsubscribeDate,
        bounceStatus: contact.bounceStatus || "none",
        bounceDate: contact.bounceDate,
        bounceReason: contact.bounceReason,
        complaintStatus: contact.complaintStatus || "none",
        complaintDate: contact.complaintDate,
        emailStatus: contact.emailStatus,
        smsConsentStatus: contact.smsConsentStatus || "not_collected",
        suppressionHistory: contact.suppressionHistory || [],
        nextAllowedContactDate: contact.nextAllowedContactDate || null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/contacts/:id/delivery-log — outbound send log for a contact
  app.get("/api/contacts/:id/delivery-log", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const { db } = await import("../db");
      const { sql } = await import("drizzle-orm");

      const result = await db.execute(sql`
        SELECT
          l.id,
          s.name            AS sequence_name,
          l.step_order,
          l.channel,
          l.from_address,
          l.to_address,
          l.subject,
          l.status,
          l.failure_reason,
          l.sent_at,
          l.failed_at,
          l.created_at
        FROM outbound_send_log l
        LEFT JOIN follow_up_sequences s ON s.id = l.sequence_id
        WHERE l.contact_id = ${contactId}
        ORDER BY l.created_at DESC
        LIMIT 200
      `);

      const rows = (result.rows as any[]).map(r => ({
        id:            r.id,
        sequenceName:  r.sequence_name ?? null,
        stepOrder:     r.step_order != null ? Number(r.step_order) : null,
        channel:       r.channel,
        fromAddress:   r.from_address ?? null,
        toAddress:     r.to_address,
        subject:       r.subject ?? null,
        status:        r.status,
        failureReason: r.failure_reason ?? null,
        sentAt:        r.sent_at ? new Date(r.sent_at).toISOString() : null,
        failedAt:      r.failed_at ? new Date(r.failed_at).toISOString() : null,
        createdAt:     new Date(r.created_at).toISOString(),
      }));

      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // POST /api/contacts/validate-emails-batch
  // #1541 (1540B): starts a DURABLE ZeroBounce validation run. Creates/reuses a
  // zerobounce_campaigns row, inserts a zerobounce_runs row, and enqueues a
  // BullMQ job. No setImmediate; work survives server restarts.
  app.post("/api/contacts/validate-emails-batch", requireRole("admin", "manager"), async (req, res) => {
    try {
      const schema = z.object({
        issue:        z.string().optional().default("unvalidated_email"),
        minLeadScore: z.number().int().min(0).max(100).optional().default(0),
        limit:        z.number().int().min(1).max(500).optional().default(100),
        contactIds:   z.array(z.number().int().positive()).optional().default([]),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { issue, minLeadScore, limit: batchLimit, contactIds: explicitIds } = parsed.data;

      const { checkZeroBounceBudget } = await import("../services/zerobounce-daily-limiter");
      const { markStaleRunsInterrupted } = await import("../services/zerobounce-campaign-worker");
      const { enqueueZeroBounceRun } = await import("../services/queue-manager");

      // Preflight: missing provider key must never burn credits or write status.
      if (!isZeroBounceConfigured()) {
        return res.status(503).json({
          message: "ZeroBounce is not configured (missing ZEROBOUNCE_API_KEY). No credits were consumed and no contact statuses were changed.",
        });
      }

      const budget = await checkZeroBounceBudget();
      if (!budget.allowed) {
        return res.status(429).json({
          message: "ZeroBounce validation is temporarily unavailable. Try again later.",
        });
      }

      // Recover any run orphaned by a restart before checking active-run state.
      await markStaleRunsInterrupted();

      // ── Find or create the active campaign ─────────────────────────────────
      const actorId = String((req.user as any)?.id ?? "system");
      let campaign = (await pool.query(
        `SELECT * FROM zerobounce_campaigns WHERE status = 'active' LIMIT 1`,
      )).rows[0];

      if (!campaign) {
        const filter: ZbCampaignFilter = {
          issue,
          minLeadScore,
          ...(explicitIds.length > 0
            ? { contactIds: (await resolveZbExplicitCandidates(explicitIds, explicitIds.length)) }
            : {}),
        };
        const { buildZbEligibilityWhere } = await import("../services/zerobounce-eligibility");
        const totalRow = await pool.query(
          `SELECT COUNT(*)::int AS n FROM contacts c WHERE ${buildZbEligibilityWhere(filter)}`,
        );
        const initialTotal = totalRow.rows[0]?.n ?? 0;
        // Partial unique index zb_campaigns_one_active_idx makes concurrent
        // creation race-safe: the loser gets 0 rows and re-reads the winner.
        const ins = await pool.query(
          `INSERT INTO zerobounce_campaigns (filter_definition, initial_eligible_total, created_by)
           VALUES ($1::jsonb, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [JSON.stringify(filter), initialTotal, actorId],
        );
        campaign = ins.rows[0] ?? (await pool.query(
          `SELECT * FROM zerobounce_campaigns WHERE status = 'active' LIMIT 1`,
        )).rows[0];
        if (!campaign) return res.status(500).json({ message: "Failed to create campaign" });
      }

      // ── Active-run enforcement: one running run per campaign ───────────────
      const existingRunning = (await pool.query(
        `SELECT id, state FROM zerobounce_runs WHERE campaign_id = $1 AND state = 'running' LIMIT 1`,
        [campaign.id],
      )).rows[0];
      if (existingRunning) {
        return res.status(200).json({
          jobId: existingRunning.id,
          runId: existingRunning.id,
          campaignId: campaign.id,
          alreadyRunning: true,
          queued: 0,
          message: `A validation run is already in progress. Poll /api/contacts/validate-emails-batch/${existingRunning.id} for status.`,
        });
      }

      // Insert the run. The partial unique index (campaign_id) WHERE state='running'
      // closes the remaining race: a concurrent POST loses the insert and re-reads.
      let run;
      try {
        run = (await pool.query(
          `INSERT INTO zerobounce_runs (campaign_id, contact_limit, state, last_heartbeat_at)
           VALUES ($1, $2, 'running', NOW())
           RETURNING *`,
          [campaign.id, batchLimit],
        )).rows[0];
      } catch (insErr: any) {
        if (insErr?.code === "23505") {
          const winner = (await pool.query(
            `SELECT id FROM zerobounce_runs WHERE campaign_id = $1 AND state = 'running' LIMIT 1`,
            [campaign.id],
          )).rows[0];
          if (winner) {
            return res.status(200).json({
              jobId: winner.id, runId: winner.id, campaignId: campaign.id,
              alreadyRunning: true, queued: 0,
              message: `A validation run is already in progress. Poll /api/contacts/validate-emails-batch/${winner.id} for status.`,
            });
          }
        }
        throw insErr;
      }

      // ── Enqueue the durable BullMQ job ──────────────────────────────────────
      const bullJobId = await enqueueZeroBounceRun(run.id);
      if (!bullJobId) {
        // No in-process fallback: mark the run interrupted and fail loudly.
        await pool.query(
          `UPDATE zerobounce_runs SET state = 'interrupted', stop_reason = 'enqueue_failed', finished_at = NOW() WHERE id = $1`,
          [run.id],
        );
        return res.status(503).json({ message: "Background queue unavailable; run not started. Try again shortly." });
      }
      await pool.query(`UPDATE zerobounce_runs SET bull_job_id = $1 WHERE id = $2`, [bullJobId, run.id]);

      res.json({
        jobId: run.id, // backward-compatible field name for DataQuality.tsx polling
        runId: run.id,
        campaignId: campaign.id,
        queued: run.contact_limit,
        message: `Validation run started (up to ${run.contact_limit} contacts). Poll /api/contacts/validate-emails-batch/${run.id} for status.`,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/contacts/validate-emails-batch/:jobId — poll run status (#1541).
  // Reads zerobounce_runs by run ID; response keeps the legacy shape
  // ({ done, processed, valid, blocked, errors, retryableErrors, queued, ... })
  // so DataQuality.tsx keeps working, plus the new run fields.
  app.get("/api/contacts/validate-emails-batch/:jobId", requireRole("admin", "manager"), async (req, res) => {
    try {
      const runId = req.params.jobId;
      const { markStaleRunsInterrupted } = await import("../services/zerobounce-campaign-worker");
      await markStaleRunsInterrupted();

      const run = (await pool.query(`SELECT * FROM zerobounce_runs WHERE id = $1`, [runId])).rows[0];
      if (!run) {
        // Legacy fallback: pre-#1541 jobs stored status in system_settings.
        const legacy = await storage.getSystemSetting(`zerobounce_batch_job_${runId}`);
        if (legacy) return res.json(legacy);
        return res.status(404).json({ message: "Run not found" });
      }

      res.json({
        // Legacy-compatible fields
        done: run.state !== "running",
        processed: run.completed_count,
        valid: run.valid_count,
        blocked: run.blocked_count,
        errors: run.error_count,
        retryableErrors: run.retryable_count,
        queued: run.contact_limit,
        startedAt: run.started_at,
        completedAt: run.finished_at,
        // New durable-run fields
        runId: run.id,
        campaignId: run.campaign_id,
        state: run.state,
        stopReason: run.stop_reason,
        cancelRequested: run.cancel_requested,
        claimed: run.claimed_count,
        skipped: run.skipped_count,
        lastHeartbeatAt: run.last_heartbeat_at,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // DELETE /api/contacts/validate-emails-batch/:runId — request cancellation (#1541).
  // Sets cancel_requested; the worker polls it between contacts and exits with
  // stop_reason='cancelled'.
  app.delete("/api/contacts/validate-emails-batch/:runId", requireRole("admin"), async (req, res) => {
    try {
      const runId = req.params.runId;
      const run = (await pool.query(
        `SELECT id, state, campaign_id FROM zerobounce_runs WHERE id = $1`, [runId],
      )).rows[0];
      if (!run) return res.status(404).json({ message: "Run not found" });

      // Cancelling always abandons the whole CAMPAIGN, not just the run:
      // even if this run is already terminal (budget_stopped, completed via
      // contact limit, interrupted), the admin's intent is "stop this
      // validation campaign so a new one can be started with a fresh filter".
      const { cancelZeroBounceCampaignByRun } = await import("../services/zerobounce-campaign-worker");
      const result = await cancelZeroBounceCampaignByRun(String(runId));
      if (!result.ok) {
        return res.status(409).json({
          message: `Nothing to cancel: run is ${run.state} and its campaign is not active.`,
          state: run.state,
        });
      }
      const { runCancelRequested: cancelRequested, campaignCancelled } = result;
      await storage.createAuditLog({
        action: "zerobounce_campaign_cancel_requested",
        entityType: "zerobounce_campaign",
        details: {
          runId,
          campaignId: run.campaign_id,
          runState: run.state,
          runCancelRequested: cancelRequested,
          campaignCancelled,
          requestedBy: String((req.user as any)?.id ?? "unknown"),
        },
      });
      res.json({
        runId,
        campaignId: run.campaign_id,
        cancelRequested,
        campaignCancelled,
        message: cancelRequested
          ? "Cancellation requested; the worker will stop between contacts and the campaign is cancelled."
          : "Campaign cancelled; the next batch start will create a fresh campaign from its own filter.",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // POST /api/contacts/:id/validate-email — validate a single contact's email via ZeroBounce
  app.post("/api/contacts/:id/validate-email", requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!Number.isFinite(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      if (!contact.email) return res.status(400).json({ message: "Contact has no email address" });
      if (isPlaceholderEmail(contact.email)) {
        return res.status(400).json({ message: "Contact has a synthetic placeholder email address; nothing to validate" });
      }

      const { db } = await import("../db");
      const { createValidationIntent, enqueueCurrentValidationIntent, hashEmailToken } = await import("../services/provider-readiness-control");
      const generation = (await pool.query(
        `UPDATE contacts SET email_mutation_generation = GREATEST(email_mutation_generation, 1),
             email_token_hash = $2 WHERE id = $1 RETURNING email_mutation_generation`,
        [contactId, hashEmailToken(contact.email)],
      )).rows[0].email_mutation_generation;
      await db.transaction((tx) => createValidationIntent(tx, {
        contactId,
        email: contact.email,
        generation,
        purpose: "marketing_outreach",
      }));
      const enqueued = await enqueueCurrentValidationIntent(contactId);
      res.status(enqueued ? 202 : 503).json({
        success: false,
        deferred: !enqueued,
        message: enqueued
          ? "Validation accepted for durable processing."
          : "Validation intent was saved but queue processing is unavailable; it will recover automatically.",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/contacts/:id/lifecycle-history — return lifecycle stage transition history for a contact
  app.get("/api/contacts/:id/lifecycle-history", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!Number.isFinite(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      // Agent-scope ownership guard: mirrors the same guard on GET/PUT /contacts/:id.
      // Agents may only view history for contacts assigned to them.
      const _lcRole = (req.user as any)?.role;
      const _lcEmail = (req.user as any)?.email;
      const _lcAssignedTo = (contact as any).assignedTo as string | null | undefined;
      if (_lcRole === "agent" && _lcAssignedTo && _lcAssignedTo !== _lcEmail) {
        return res.status(403).json({ message: "Forbidden", code: "NOT_YOUR_CONTACT" });
      }

      const { LifecycleService } = await import("../services/lifecycle-service");
      const history = await LifecycleService.getHistory(contactId, 50);

      res.json(history.map((h: any) => ({
        id: h.id,
        fromState: h.fromState ?? null,
        toState: h.toState,
        trigger: h.trigger ?? null,
        actorType: h.actorType ?? null,
        actorId: h.actorId ?? null,
        source: h.source ?? null,
        reason: h.reason ?? null,
        transitionedAt: h.transitionedAt,
      })));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/contacts/:id/voicemails — return inbound voicemail communication events for a contact
  app.get("/api/contacts/:id/voicemails", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!Number.isFinite(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      // Agent-scope ownership guard
      const _vmRole = (req.user as any)?.role;
      const _vmEmail = (req.user as any)?.email;
      const _vmAssignedTo = (contact as any).assignedTo as string | null | undefined;
      if (_vmRole === "agent" && _vmAssignedTo && _vmAssignedTo !== _vmEmail) {
        return res.status(403).json({ message: "Forbidden", code: "NOT_YOUR_CONTACT" });
      }

      const { communicationEvents: commEventsTable } = await import("@shared/schema");
      const { desc: descOp, eq: eqOp, and: andOp } = await import("drizzle-orm");

      const rows = await db
        .select()
        .from(commEventsTable)
        .where(
          andOp(
            eqOp(commEventsTable.contactId, contactId),
            eqOp(commEventsTable.channel, "voicemail")
          )
        )
        .orderBy(descOp(commEventsTable.createdAt))
        .limit(50);

      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PATCH /api/contacts/:id/notes/:noteId/pin — toggle note pinned state
  // Scoped: only updates a note that belongs to this contact (entityType="contact", entityId=contactId)
  // and applies the same agent ownership guard as other contact sub-routes.
  app.patch("/api/contacts/:id/notes/:noteId/pin", isDashboardUser, async (req, res) => {
    try {
      const {noteCommandFields,commandNote}=await import("../services/note-command");
      const {bindWorkActor}=await import("../services/work-item-command");
      const {strictRecordId}=await import("@shared/work-item-commands");
      const fields=noteCommandFields.omit({entityType:true,entityId:true,content:true}).extend({expectedVersion:z.number().int().positive(),pinned:z.boolean()}).parse(req.body);
      res.json(await commandNote(bindWorkActor(req.user,fields.expectedActorId,fields.expectedAccountVersion),"pin",fields,
        strictRecordId.parse(req.params.noteId),strictRecordId.parse(req.params.id)));
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:err.errors[0].message});
      const {WorkCommandError}=await import("../services/work-item-command");
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      serverError(res, err);
    }
  });

  // GET /api/contacts/:id/zerobounce-history — return ZeroBounce validation history for a contact
  // Shares the canonical contact-object ownership guard; no PII or ledger writes.
  app.get("/api/contacts/:id/sfp-readiness", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!Number.isSafeInteger(contactId) || contactId <= 0) return res.status(400).json({ message: "Invalid contact ID" });
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      const { getContactSfpReadiness } = await import("../services/contact-sfp-readiness");
      res.json(await getContactSfpReadiness(contact));
    } catch (error) { serverError(res, error); }
  });
  app.get("/api/contacts/:id/zerobounce-history", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!Number.isFinite(contactId)) return res.status(400).json({ message: "Invalid contact ID" });

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const logs = await storage.getAuditLogsByEntity("contact", contactId, 20);
      const zbLogs = logs
        .filter((l: any) => l.action === "zerobounce_email_validated")
        .slice(0, 10)
        .map((l: any) => ({
          validatedAt: l.createdAt,
          status: (l.details as any)?.zbStatus ?? null,
          subStatus: (l.details as any)?.zbSubStatus ?? null,
          email: (l.details as any)?.email ?? null,
          source: (l.details as any)?.source ?? null,
        }));

      res.json(zbLogs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // POST /api/contacts/:id/send-email — send a composed email via GHL
  app.post("/api/contacts/:id/send-email", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      const schema = z.object({
        subject: z.string().min(1, "Subject is required"),
        body: z.string().min(1, "Body is required"),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0].message });
      }
      const { subject, body } = parsed.data;

      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      const role = (req.user as any)?.role;
      const email = (req.user as any)?.email;
      if (role === "agent" && contact.assignedTo && contact.assignedTo !== email) {
        return res.status(403).json({ message: "Forbidden", code: "NOT_YOUR_CONTACT" });
      }
      if (!contact.email) return res.status(400).json({ message: "Contact has no email address" });
      if (!isGhlConfigured()) return res.status(503).json({ message: "GHL is not configured" });

      const { channelOrchestrator } = await import("../services/transports/index");
      const result = await channelOrchestrator.sendEmail({ contactId, subject, body });

      if (!result.success) {
        console.error("[Contacts] GHL email send failed:", result.error);
        return res.status(502).json({ message: safeMessage(result.error, "GHL send failed") });
      }

      await storage.createAuditLog({
        action: "email_sent_via_composer",
        entityType: "contact",
        entityId: contactId,
        actorType: "admin",
        actorId: String((req.user as any)?.id ?? "unknown"),
        details: { subject, toEmail: contact.email, messageId: result.messageId ?? null },
      });

      res.json({ success: true, messageId: result.messageId ?? null });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GET document access history for a contact ──────────────────────────────
  // Returns document_access_log rows for all documents belonging to this contact.
  app.get("/api/contacts/:id/document-access-history", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!contactId) return res.status(400).json({ message: "Invalid contact ID" });
      const { db } = await import("../db");
      const { documentAccessLog, documents } = await import("../../shared/schema");
      const { eq, desc, sql } = await import("drizzle-orm");
      const rows = await db
        .select({
          id: documentAccessLog.id,
          documentId: documentAccessLog.documentId,
          documentName: documents.fileName,
          userId: documentAccessLog.userId,
          ip: documentAccessLog.ip,
          accessedAt: documentAccessLog.accessedAt,
        })
        .from(documentAccessLog)
        .innerJoin(documents, eq(documents.id, documentAccessLog.documentId))
        .where(eq(documents.contactId, contactId))
        .orderBy(desc(documentAccessLog.accessedAt))
        .limit(50);
      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── POST trigger readiness re-score for a contact ──────────────────────────
  // Enqueues a BullMQ readiness-recalculation job immediately without waiting
  // for the next nightly backfill. Idempotent — repeated calls collapse.
  app.post("/api/contacts/:id/trigger-rescore", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!contactId) return res.status(400).json({ message: "Invalid contact ID" });
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      const { enqueueReadinessRecalculation } = await import("../services/contact-readiness");
      await enqueueReadinessRecalculation(contactId);
      await storage.createAuditLog({
        action: "contact_readiness_rescore_triggered",
        entityType: "contact",
        entityId: contactId,
        actorType: "user",
        actorId: (req as any).user?.id ?? null,
        details: { triggeredBy: "manual_ui" },
      } as any);
      res.json({ queued: true, contactId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GET NPS survey history for a contact ────────────────────────────────────
  app.get("/api/contacts/:id/nps-responses", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (!contactId) return res.status(404).json({ message: "Contact not found" });
      const responses = await storage.getNpsResponsesByContact(contactId);
      res.json(responses);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── DELETE /api/contacts/bulk-delete — admin/manager only (#1444 step 10) ──
  app.post("/api/admin/contacts/normalize-blank-emails", requireRole("admin"), async (req, res) => {
    try {
      const {contactLifecycleFields,commandContactLifecycle}=await import("../services/contact-lifecycle-command");
      const {bindWorkActor}=await import("../services/work-item-command");
      const fields=contactLifecycleFields.parse(req.body);
      const result=await commandContactLifecycle(bindWorkActor(req.user,fields.expectedActorId,fields.expectedAccountVersion),
        "normalize_blank_email",fields);
      res.json(result);
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:"Supply the versioned contact set and exact expected blank emails."});
      const {WorkCommandError}=await import("../services/work-item-command");
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      serverError(res,err);
    }
  });

  // Accepts body: { contactIds: number[] }
  // Soft-archives each contact; agent accounts receive 403 from requireRole.
  app.delete("/api/contacts/bulk-delete", requireRole("admin", "manager"), async (req, res) => {
    try {
      const {contactLifecycleFields,commandContactLifecycle}=await import("../services/contact-lifecycle-command");
      const {bindWorkActor}=await import("../services/work-item-command");
      const fields=contactLifecycleFields.parse(req.body);
      const result=await commandContactLifecycle(bindWorkActor(req.user,fields.expectedActorId,fields.expectedAccountVersion),"archive",fields);
      res.json({...result,archived:result.changed,permanentlyDeleted:0});
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:"Reload the selected contacts and submit the versioned archive command. No records were deleted."});
      const {WorkCommandError}=await import("../services/work-item-command");
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      serverError(res, err);
    }
  });

  // === POST /api/contacts/bulk-assign ==========================================
  // Manager/admin only. Assigns a batch of canonical CRM contacts to a rep.
  // Raw prospect/Sunbiz/master-lead rows are NOT reachable through this endpoint.
  // Two-phase: preview (per-contact eligibility) then execute (with fingerprint locking).
  app.post("/api/contacts/bulk-assign", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const schema = z.object({
        contactIds: z.array(z.number().int().positive()).min(1).max(200),
        assignTo: z.string().email(),
        fingerprintMap: z.record(z.string(), z.string()).optional().default({}),
        previewOnly: z.boolean(),
      });
      const { contactIds, assignTo, fingerprintMap, previewOnly } = schema.parse(req.body);

      // Validate target rep is a real user with agent role
      const { users: usersTable } = await import("@shared/schema");
      const [repUser] = await db.select({ id: usersTable.id, role: usersTable.role })
        .from(usersTable).where(eq(usersTable.email, assignTo)).limit(1);
      if (!repUser) return res.status(400).json({ message: `No user account found for ${assignTo}` });
      if (repUser.role !== "agent") return res.status(400).json({ message: `User ${assignTo} has role '${repUser.role}'; must be 'agent'` });

      // Fetch contacts from canonical contacts table ONLY — no JOIN to prospects/sunbiz/master_leads
      const { contacts: contactsTable } = await import("@shared/schema");
      const rows = await db.select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        email: contactsTable.email,
        assignedTo: contactsTable.assignedTo,
        recordClass: contactsTable.recordClass,
        archivedAt: contactsTable.archivedAt,
        leadScore: contactsTable.leadScore,
        reachabilityScore: contactsTable.reachabilityScore,
      }).from(contactsTable).where(inArray(contactsTable.id, contactIds));

      const rowMap = new Map(rows.map(r => [r.id, r]));

      // CR-04 evaluator (lazy import to avoid circular deps)
      let evaluateCr04: ((id: number, ctx: any) => Promise<{ decision: string; reasonCodes: string[] }>) | null = null;
      try {
        const mod = await import("../services/cr04-cohort-ready-authority");
        evaluateCr04 = mod.evaluateCr04ChannelQualification as any;
      } catch { /* CR-04 unavailable — treat as unavailable */ }

      const accepted: Array<{ contactId: number; name: string }> = [];
      const rejected: Array<{ contactId: number; name: string; reason: string }> = [];
      const previews: Array<{
        contactId: number; name: string; recordClass: string | null;
        currentOwner: string | null; cr04Eligible: boolean | null; blockReason: string | null;
      }> = [];

      for (const contactId of contactIds) {
        const row = rowMap.get(contactId);
        if (!row) {
          rejected.push({ contactId, name: "(not found)", reason: "Contact not found in CRM contacts table" });
          continue;
        }
        if (row.archivedAt) {
          rejected.push({ contactId, name: `${row.firstName} ${row.lastName}`, reason: "Contact is archived" });
          continue;
        }
        // Check CR-04 eligibility for preview annotation
        let cr04Eligible: boolean | null = null;
        let cr04BlockReason: string | null = null;
        if (evaluateCr04) {
          try {
            const dec = await evaluateCr04(contactId, { channel: "manual_call" });
            cr04Eligible = dec.decision === "qualified";
            if (!cr04Eligible) cr04BlockReason = dec.reasonCodes?.join(", ") ?? "blocked";
          } catch { cr04Eligible = null; }
        }

        previews.push({
          contactId,
          name: `${row.firstName} ${row.lastName}`,
          recordClass: row.recordClass ?? null,
          currentOwner: row.assignedTo ?? null,
          cr04Eligible,
          blockReason: cr04Eligible === false ? cr04BlockReason : null,
        });
      }

      if (previewOnly) {
        return res.json({ preview: true, contacts: previews });
      }

      // Execute: FOR UPDATE row-level locking + fingerprint verification
      const actorId = (req.user as any)?.id ?? null;
      for (const p of previews) {
        const expectedFingerprint = fingerprintMap[String(p.contactId)];
        // Re-fetch under lock
        const [locked] = await db.execute(
          sql`SELECT id, assigned_to, email FROM contacts WHERE id = ${p.contactId} FOR UPDATE`
        ).then((r: any) => r.rows ?? []);
        if (!locked) {
          rejected.push({ contactId: p.contactId, name: p.name, reason: "Row disappeared during execution" });
          continue;
        }
        // Fingerprint check if provided
        if (expectedFingerprint) {
          const actualFingerprint = `${locked.assigned_to ?? ""}:${locked.email ?? ""}`;
          if (actualFingerprint !== expectedFingerprint) {
            rejected.push({ contactId: p.contactId, name: p.name, reason: "Fingerprint mismatch — contact modified concurrently" });
            continue;
          }
        }
        // Write assignment
        await db.execute(sql`UPDATE contacts SET assigned_to = ${assignTo}, updated_at = NOW() WHERE id = ${p.contactId}`);
        await storage.createAuditLog({
          action: "contact_bulk_assigned",
          entityType: "contact",
          entityId: p.contactId,
          userId: actorId,
          details: { assignTo, previousAssignedTo: locked.assigned_to ?? null },
        });
        accepted.push({ contactId: p.contactId, name: p.name });
      }

      res.json({
        accepted: accepted.length,
        rejected: rejected.length,
        acceptedContacts: accepted,
        blockReasons: rejected,
        total: contactIds.length,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

}

/**
 * Returns true if the sequence violates email-only constraints.
 * A sequence is email-only if:
 *  - channelsAllowed is null/empty OR equals ["email"]
 *  - No steps have actionType of "sms", "call", or "voicemail_drop"
 */
async function checkEmailOnlyViolation(
  sequenceId: number,
  sequence: { channelsAllowed?: string[] | null }
): Promise<boolean> {
  const blocked_step_types = ["sms", "call", "voicemail_drop"];

  // If channelsAllowed is explicitly set and not ["email"], it's a violation
  const channels = sequence.channelsAllowed;
  if (channels && channels.length > 0) {
    if (channels.length !== 1 || channels[0] !== "email") {
      return true;
    }
  }

  // Also inspect steps for non-email outbound actions
  const steps = await storage.getSequenceSteps(sequenceId);
  for (const step of steps) {
    if (blocked_step_types.includes(step.actionType)) {
      return true;
    }
  }

  return false;
}
