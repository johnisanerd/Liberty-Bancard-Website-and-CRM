import crypto from "crypto";
import {intakeBusinessEvidence} from "../../shared/intake-business-evidence";
import { storage } from "../storage";
import { db, pool } from "../db";
import type { Contact, Deal, Company, Task, Ticket, Note, UpdateContactRequest } from "@shared/schema";
import { ghlSyncStatus, ACTIVE_DEAL_STAGES, systemSettings, contactProviderProjections, pipelineStages, tasks, contacts, taskAuthorityEvents } from "@shared/schema";
import { commandProducedTask, WorkCommandError } from "./work-item-command";
import {
  upsertGhlContactDetailed,
  isGhlConfigured,
  GhlIdentityAmbiguousError,
  GhlRequiredFieldUnavailableError,
  lookupGhlContactStrict,
  type GhlUpsertOutcome,
  type GhlComponentOutcome,
  type GhlIdentityLookup,
  sendGhlEmail,
  GhlIdentityConflictError,
  GhlInvalidContactError,
  validateGhlIdentityFields,
  isGhlEmailValidation422,
  GHL_NO_USABLE_IDENTITY,
  GHL_EMAIL_VALIDATION_REJECTED,
} from "./ghl";
// Re-export the shared validation boundary so existing consumers/tests keep working.
export { validateGhlIdentityFields, GHL_NO_USABLE_IDENTITY, GHL_EMAIL_VALIDATION_REJECTED };
import { normalizeGhlId } from "../utils/normalize";
import { getEmailSignatureHtml } from "./email-signatures";
import { auditChange } from "./audit-change";
import { writeContact, upsertContactSourceEvent, PROVENANCE_FIELDS } from "./contact-writer";
import { enqueuePromotionalEnrollment } from "./promotional-enrollment-eligibility";
import { eq, sql, and, isNull, desc } from "drizzle-orm";
import { GO_LIVE_GATE_STAGES, checkGoLiveReadiness } from "./go-live-gate";
import { canExecute } from "./outbound-queue-coordinator";
import { markGhlDispatch, classifyGhlOperation, GhlAmbiguousDispatchError, withGhlDispatchRecorder, summarizeDispatches, type GhlDispatchHooks } from "./ghl-dispatch-recorder";
import {
  CONTACT_PROJECTION_MAX_ATTEMPTS, AMBIGUOUS_RETRY_MS, DEFERRAL_RETRY_MS,
  claimEligibleProjections, renewProjectionLease, reserveProjectionDispatch, settleProjection,
  clearProjectionAmbiguity, linkReconciledIdentity, hasUnsettledOperation, beginProjectionOperation, settleProjectionOperation, getUnresolvedCreateOperation,
  markCreateOperationReconciled, GhlProjectionFenceError, type ClaimedProjection,
} from "./ghl-projection-authority";

const GHL_SYNC_DEFERRED_STATS_KEY = "ghl_sync_deferred_stats";

async function recordGhlSyncDeferred(entityType: string, reason: string): Promise<void> {
  const reasonCode = reason.match(/(?:GHL_SYNC_DEFERRED_BLOCKED|GHL_CRM_[A-Z_]+|control_disabled|permissions_disabled|native_review_[a-z_]+|operation_not_reviewed|epoch_or_review_changed)/i)?.[0]
    || "CRM_WRITE_DEFERRED";
  try { await pool.query(
    `INSERT INTO system_settings(key, value, updated_at)
     VALUES ($1, jsonb_build_object('count', 1, 'lastAt', NOW(), 'lastEntityType', $2::text, 'lastReason', $3::text), NOW())
     ON CONFLICT (key) DO UPDATE SET
       value = jsonb_build_object(
         'count', COALESCE((system_settings.value->>'count')::bigint, 0) + 1,
         'lastAt', NOW(),
         'lastEntityType', $2::text,
         'lastReason', $3::text
       ),
       updated_at = NOW()`,
    [GHL_SYNC_DEFERRED_STATS_KEY, entityType, reasonCode],
  ); } catch (error) {
    console.warn("[GHL Sync] Could not persist deferred-operation metric:", (error as Error).message);
  }
}

export type ProjectionRowOutcome =
  | "success" | "deferred" | "skip" | "auth" | "failure" | "ambiguous" | "terminal" | "claim_lost";

export interface ProjectionBatchSummary {
  claimed: number;
  completed: number;
  deferred: number;
  retried: number;
  terminal: number;
  ambiguous: number;
  claimLost: number;
  released: number;
  stoppedReason: string | null;
}

export interface ProjectionExecutorDeps {
  assertOwnership?: () => Promise<void>;
  syncFn?: (contactId: number) => Promise<SyncContactResult>;
  /** Read-only strict remote lookup used to resolve an ambiguous earlier create. Must throw on lookup failure. */
  lookupFn?: (identity: { email?: string | null; phone?: string | null }) => Promise<GhlIdentityLookup>;
  /** Called after each settled row; return false to stop and release the remaining claimed rows. */
  onOutcome?: (outcome: ProjectionRowOutcome, contactId: number) => boolean | void;
  /** Pause between provider calls (ms). */
  paceMs?: number;
}

function projectionRetryDelayMs(attemptCount: number): number {
  return Math.min(3600, 30 * 2 ** Math.min(attemptCount, 6)) * 1000;
}

const NOT_EXPORTABLE_ERROR = /^(?:PIPELINE_LOCAL_ONLY|EXPORT_NOT_ELIGIBLE)/;

export type SyncContactResult = {
  success: boolean; ghlContactId?: string; error?: string; components?: GhlUpsertOutcome["components"] & { tags?: GhlComponentOutcome };
};

type ReconcileResult = { status: "resolved" | "unresolved" | "conflict" | "claim_lost" } | { status: "hold"; code: string };

/**
 * Resolve an ambiguous earlier create with read-only lookups using the ORIGINAL identity that was sent (recorded in
 * the durable operation row), never the contact's current identity. Never clears ambiguity for a contact without a
 * usable identity, and never accepts a phone-only match without independent proof: those are held with a specific
 * reason for review.
 */
async function reconcileAmbiguousProjection(
  row: ClaimedProjection,
  deps: ProjectionExecutorDeps,
): Promise<ReconcileResult> {
  const contact = await storage.getContact(row.contactId);
  if (!contact) return { status: "resolved" };
  // A local link proves identity; remaining operations (update, tags, permissions) are idempotent.
  if (contact.ghlContactId) return (await clearProjectionAmbiguity(row)) ? { status: "resolved" } : { status: "claim_lost" };
  const op = await getUnresolvedCreateOperation(row.id);
  const email = ((op ? op.identity.email : contact.email) ?? "").trim();
  const phone = ((op ? op.identity.phone : contact.phone) ?? "").trim();
  if (!email && !phone) return { status: "hold", code: "AMBIGUOUS_IDENTITY_UNAVAILABLE_NEEDS_REVIEW" };
  const lookup = deps.lookupFn ?? lookupGhlContactStrict;
  let found: GhlIdentityLookup;
  try { found = await lookup(email ? { email } : { phone }); } catch { return { status: "unresolved" }; }
  if (found.status === "absent") {
    if (deps.assertOwnership) await deps.assertOwnership();
    if (!await clearProjectionAmbiguity(row)) return { status: "claim_lost" };
    if (op) await markCreateOperationReconciled(op.operationId, "absent");
    return { status: "resolved" };
  }
  if (found.status === "ambiguous") return { status: "hold", code: "AMBIGUOUS_REMOTE_IDENTITY_NEEDS_REVIEW" };
  // An email-bearing create is proven only by a remote record that states the same email.
  if (email && (!found.matchedEmail || found.matchedEmail.trim().toLowerCase() !== email.toLowerCase())) {
    return { status: "hold", code: "AMBIGUOUS_REMOTE_IDENTITY_NEEDS_REVIEW" };
  }
  const owner = ((await db.execute(sql`
    SELECT id FROM contacts WHERE ghl_contact_id = ${found.id} AND id <> ${row.contactId} LIMIT 1
  `)) as any).rows as any[];
  if (owner.length > 0) return { status: "conflict" };
  // A phone-only match is never proof: a phone number can belong to several people and recency of the remote record
  // does not show it came from this request. Held for a person to review.
  if (!email) return { status: "hold", code: "AMBIGUOUS_PHONE_IDENTITY_NEEDS_REVIEW" };
  // Final fence: runtime ownership, then the link itself is conditional on the live claim.
  if (deps.assertOwnership) await deps.assertOwnership();
  if (!await linkReconciledIdentity(row, found.id)) return { status: "claim_lost" };
  if (op) await markCreateOperationReconciled(op.operationId, "linked");
  await clearProjectionAmbiguity(row);
  return { status: "resolved" };
}

/** Execute one claimed projection: reserve, dispatch, settle by generation CAS. */
async function executeClaimedProjection(row: ClaimedProjection, deps: ProjectionExecutorDeps): Promise<ProjectionRowOutcome> {
  if (deps.assertOwnership) await deps.assertOwnership();
  if (!await renewProjectionLease(row)) return "claim_lost";

  if (row.dispatchState === "ambiguous") {
    const reconciled = await reconcileAmbiguousProjection(row, deps);
    const resolved = reconciled.status;
    if (reconciled.status === "claim_lost") return "claim_lost";
    if (reconciled.status === "hold") {
      return (await settleProjection(row, { kind: "hold", code: reconciled.code })) ? "ambiguous" : "claim_lost";
    }
    if (resolved === "unresolved") {
      return (await settleProjection(row, { kind: "deferred", code: "AMBIGUOUS_RECONCILIATION_PENDING", retryAfterMs: AMBIGUOUS_RETRY_MS })) ? "deferred" : "claim_lost";
    }
    if (resolved === "conflict") {
      return (await settleProjection(row, { kind: "terminal", reason: "GHL_IDENTITY_CONFLICT", code: "ghl_identity_conflict", receipts: {}, consumedAttempt: false, dispatched: false })) ? "terminal" : "claim_lost";
    }
  }

  if (!await reserveProjectionDispatch(row)) return "claim_lost";
  const syncFn = deps.syncFn ?? syncContactToGhl;
  // Final fence + durable operation record before every provider mutation (including transport retries).
  let ownershipLost: Error | null = null;
  const hooks: GhlDispatchHooks = {
    async begin(record, meta) {
      // Runtime selection, runtime lease and job ownership are re-verified before EVERY provider mutation, not only
      // at the start of the row.
      if (deps.assertOwnership) {
        try { await deps.assertOwnership(); } catch (error) {
          ownershipLost = error instanceof Error ? error : new Error(String(error));
          throw new GhlProjectionFenceError("runtime_ownership_lost");
        }
      }
      const allowed = await beginProjectionOperation(row, {
        operationId: record.operationId, operationClass: record.operation, method: record.method,
        identity: record.operation === "contact_create" ? meta.identity ?? null : null,
      });
      if (!allowed) throw new GhlProjectionFenceError();
    },
    async settle(record) {
      await settleProjectionOperation(record.operationId, record.outcome === "pending" ? "ambiguous" : record.outcome, record.httpStatus);
    },
  };
  const run = await withGhlDispatchRecorder(() => syncFn(row.contactId), hooks);
  const evidence = summarizeDispatches(run.recorder);
  if (ownershipLost) {
    // Ownership changed mid-row: stop this row without spending budget, then stop the batch.
    if (evidence.dispatched) {
      await settleProjection(row, { kind: "retry", code: "GHL_RUNTIME_OWNERSHIP_LOST_PARTIAL", receipts: { ...evidence.receipts }, consumedAttempt: false, dispatched: true, delayMs: DEFERRAL_RETRY_MS });
    } else {
      await settleProjection(row, { kind: "released" });
    }
    throw ownershipLost;
  }
  const result = "result" in run ? run.result : null;
  const thrown = "error" in run ? (run.error instanceof Error ? run.error.message : String(run.error)) : null;

  const receipts: Record<string, unknown> = result?.components
    ? { ...evidence.receipts, components: result.components } : { ...evidence.receipts };
  if (result?.success && await hasUnsettledOperation(row)) {
    // A provider operation for this claim never reported its outcome: success cannot be asserted. Recovery
    // reconciles it read-only before anything is sent again.
    return (await settleProjection(row, { kind: "ambiguous", code: "GHL_OPERATION_UNSETTLED", receipts })) ? "ambiguous" : "claim_lost";
  }
  if (result?.success) {
    return (await settleProjection(row, { kind: "success", receipts })) ? "success" : "claim_lost";
  }
  const error = result?.error ?? thrown ?? undefined;
  if (typeof error === "string" && /GHL_PROJECTION_FENCE_LOST/.test(error)) {
    // The claim, lease, generation or eligibility changed before a request: nothing further may be sent for this claim.
    if (evidence.dispatched) {
      return (await settleProjection(row, { kind: "retry", code: "GHL_PROJECTION_FENCE_LOST_PARTIAL", receipts, consumedAttempt: false, dispatched: true, delayMs: DEFERRAL_RETRY_MS })) ? "deferred" : "claim_lost";
    }
    await settleProjection(row, { kind: "released" });
    return "claim_lost";
  }
  const ambiguous = evidence.ambiguous || (typeof error === "string" && /GHL_AMBIGUOUS_DISPATCH/.test(error));
  if (ambiguous) {
    return (await settleProjection(row, { kind: "ambiguous", code: "GHL_AMBIGUOUS_DISPATCH", receipts })) ? "ambiguous" : "claim_lost";
  }
  const nextAttempt = row.attemptCount + 1;
  if (typeof error === "string" && NOT_EXPORTABLE_ERROR.test(error)) {
    return (await settleProjection(row, { kind: "terminal", reason: "EXPORT_NOT_ELIGIBLE", code: error.slice(0, 120), receipts: {}, consumedAttempt: false, dispatched: false })) ? "terminal" : "claim_lost";
  }
  if (isGhlSyncDeferred(error)) {
    if (evidence.dispatched) {
      // Some components reached the provider before a later component was deferred.
      return (await settleProjection(row, { kind: "retry", code: "GHL_SYNC_DEFERRED_PARTIAL", receipts, consumedAttempt: false, dispatched: true, delayMs: DEFERRAL_RETRY_MS })) ? "deferred" : "claim_lost";
    }
    return (await settleProjection(row, { kind: "deferred", code: "GHL_SYNC_DEFERRED_BLOCKED" })) ? "deferred" : "claim_lost";
  }
  if (!evidence.dispatched && typeof error === "string" && /GHL_CUSTOM_FIELD_(?:ID_UNVERIFIED|INVENTORY_EVIDENCE_INCOMPLETE)/.test(error)) {
    // The emitted payload names a custom field the provider inventory does not verify. Nothing was sent and
    // retrying cannot help until the inventory or payload contract changes, so it waits without spending budget.
    return (await settleProjection(row, { kind: "deferred", code: "GHL_CUSTOM_FIELD_CONTRACT_BLOCKED", retryAfterMs: 15 * 60 * 1000 })) ? "deferred" : "claim_lost";
  }
  if (typeof error === "string" && /GHL_IDENTITY_AMBIGUOUS/.test(error)) {
    // Remote identity cannot be established safely. Any request that did reach the provider was rejected without
    // a result (for example a duplicate-contact 400); nothing was linked or merged. Held for review with the reason.
    const reason = error.replace(/^.*GHL_IDENTITY_AMBIGUOUS:?/, "").trim().slice(0, 80) || "unspecified";
    return (await settleProjection(row, { kind: "terminal", reason: "IDENTITY_NEEDS_REVIEW", code: `GHL_IDENTITY_AMBIGUOUS:${reason}`, receipts, consumedAttempt: false, dispatched: evidence.dispatched })) ? "terminal" : "claim_lost";
  }
  if (!evidence.dispatched && typeof error === "string" && /GHL_REQUIRED_SUPPRESSION_FIELD_UNAVAILABLE/.test(error)) {
    // A suppression must travel with the contact but the provider field is not installed: nothing is sent.
    return (await settleProjection(row, { kind: "deferred", code: "GHL_REQUIRED_SUPPRESSION_FIELD_UNAVAILABLE", retryAfterMs: 15 * 60 * 1000 })) ? "deferred" : "claim_lost";
  }
  if (typeof error === "string" && /^GHL_COMPONENT_FAILED/.test(error)) {
    // Identity reached the provider but a required component (permission/suppression fields) failed: retry with budget.
    if (nextAttempt >= CONTACT_PROJECTION_MAX_ATTEMPTS) {
      return (await settleProjection(row, { kind: "terminal", reason: "MAX_ATTEMPTS_EXHAUSTED", code: error.slice(0, 120), receipts, consumedAttempt: true, dispatched: evidence.dispatched })) ? "failure" : "claim_lost";
    }
    return (await settleProjection(row, { kind: "retry", code: error.slice(0, 120), receipts, consumedAttempt: true, dispatched: evidence.dispatched, delayMs: projectionRetryDelayMs(nextAttempt) })) ? "failure" : "claim_lost";
  }
  const kind = classifyGhlSyncError(error);
  if (kind === "auth") {
    return (await settleProjection(row, { kind: "deferred", code: "PROVIDER_AUTH_FAILURE", retryAfterMs: 5 * 60 * 1000 })) ? "auth" : "claim_lost";
  }
  if (kind === "skip") {
    return (await settleProjection(row, { kind: "terminal", reason: "INVALID_OR_UNUSABLE_IDENTITY", code: kind, receipts, consumedAttempt: false, dispatched: evidence.dispatched, rejectedIdentity: true })) ? "skip" : "claim_lost";
  }
  if (nextAttempt >= CONTACT_PROJECTION_MAX_ATTEMPTS) {
    return (await settleProjection(row, { kind: "terminal", reason: "MAX_ATTEMPTS_EXHAUSTED", code: thrown ? "PROJECTION_EXCEPTION" : kind, receipts, consumedAttempt: true, dispatched: evidence.dispatched })) ? "failure" : "claim_lost";
  }
  return (await settleProjection(row, {
    kind: "retry", code: thrown ? "PROJECTION_EXCEPTION" : "PROVIDER_TRANSIENT_FAILURE", receipts,
    consumedAttempt: true, dispatched: evidence.dispatched, delayMs: projectionRetryDelayMs(nextAttempt),
  })) ? "failure" : "claim_lost";
}

/**
 * Claims eligible committed projection intents and settles each by generation compare-and-swap.
 * Provider dispatches are the only thing that consume the failure budget. When `onOutcome`
 * stops the batch (circuit trip, lost ownership) every still-claimed row is released at once.
 */
export async function processEligibleContactProjections(limit: number, deps: ProjectionExecutorDeps = {}): Promise<ProjectionBatchSummary> {
  const summary: ProjectionBatchSummary = { claimed: 0, completed: 0, deferred: 0, retried: 0, terminal: 0, ambiguous: 0, claimLost: 0, released: 0, stoppedReason: null };
  const rows = await claimEligibleProjections(limit);
  summary.claimed = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let outcome: ProjectionRowOutcome;
    try {
      outcome = await executeClaimedProjection(row, deps);
    } catch (error) {
      // Ownership loss or an unexpected local fault before/around dispatch: release without consuming budget.
      for (const remaining of rows.slice(i)) {
        if (await settleProjection(remaining, { kind: "released" }).catch(() => false)) summary.released++;
      }
      summary.stoppedReason = error instanceof Error ? error.message.slice(0, 160) : "UNEXPECTED_ERROR";
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { projectionSummary: summary });
    }
    if (outcome === "success") summary.completed++;
    else if (outcome === "deferred" || outcome === "auth") summary.deferred++;
    else if (outcome === "failure") summary.retried++;
    else if (outcome === "skip" || outcome === "terminal") summary.terminal++;
    else if (outcome === "ambiguous") summary.ambiguous++;
    else summary.claimLost++;
    const proceed = deps.onOutcome?.(outcome, row.contactId);
    if (proceed === false) {
      for (const remaining of rows.slice(i + 1)) {
        if (await settleProjection(remaining, { kind: "released" }).catch(() => false)) summary.released++;
      }
      summary.stoppedReason = `stopped_after_${outcome}`;
      break;
    }
    if (deps.paceMs && i < rows.length - 1) await new Promise(r => setTimeout(r, deps.paceMs));
  }
  return summary;
}

/** Compatibility wrapper kept for callers that only need counts. */
export async function processPendingContactProviderProjections(limit = 10): Promise<{ completed: number; retried: number; terminal: number }> {
  const summary = await processEligibleContactProjections(limit);
  return { completed: summary.completed, retried: summary.retried + summary.deferred + summary.ambiguous, terminal: summary.terminal };
}

const CONFLICT_FIELDS: Array<{ ghlKey: string; contactKey: keyof Contact }> = [
  { ghlKey: "firstName", contactKey: "firstName" },
  { ghlKey: "lastName", contactKey: "lastName" },
  { ghlKey: "email", contactKey: "email" },
  { ghlKey: "phone", contactKey: "phone" },
  { ghlKey: "companyName", contactKey: "companyName" },
  { ghlKey: "address1", contactKey: "address" },
  { ghlKey: "city", contactKey: "city" },
  { ghlKey: "state", contactKey: "state" },
  { ghlKey: "website", contactKey: "website" },
];

// Wave 7: Replit is the system-of-record for these compliance/permission fields.
// GHL webhooks and inbound sync must NEVER overwrite them, even if GHL sends a value.
// KL-4: Provenance fields are also Replit-owned; GHL must never overwrite source attribution.
//
// Lazy-initialized to avoid the circular-import TDZ: contact-writer imports
// syncContactToGhl from this file, so we cannot spread PROVENANCE_FIELDS at
// module-init time. The Set is built on first use (all modules are fully
// initialized by then).
let _replitOwnedFields: Set<string> | null = null;
function getReplitOwnedFields(): Set<string> {
  if (!_replitOwnedFields) {
    _replitOwnedFields = new Set<string>([
      "doNotContact",
      "doNotAutoContact",
      "consentTier",
      "lifecycleStage",
      "consentEmail",
      "consentSms",
      "smsStatus",
      "emailStatus",
      "phoneType",
      ...PROVENANCE_FIELDS,
    ]);
  }
  return _replitOwnedFields;
}

/**
 * Structured error logging for GHL sync failures.
 * Writes to ghlActivityLog with channel="sync_error" so the dashboard
 * can surface field-write errors, 422s, and circuit-breaker trips.
 */
export async function logGhlSyncError(opts: {
  contactId: number | null;
  operation: string;
  httpStatus?: number | null;
  errorMessage: string;
  ghlContactId?: string | null;
  metadata?: Record<string, any>;
}): Promise<void> {
  try {
    // Always write to ghlActivityLog — contactId may be null for ghlFetch-level errors
    await storage.createGhlActivityLog({
      contactId: opts.contactId ?? (undefined as any),
      dealId: null,
      direction: "outbound",
      channel: "sync_error",
      templateId: null,
      subject: null,
      body: null,
      status: "error",
      ghlMessageId: opts.ghlContactId || null,
      metadata: {
        operation: opts.operation,
        httpStatus: opts.httpStatus ?? null,
        errorBody: opts.errorMessage.slice(0, 500),
        ...(opts.metadata || {}),
      },
    });
    await storage.createAuditLog({
      action: "ghl_sync_error",
      entityType: "contact",
      entityId: opts.contactId ?? undefined,
      details: {
        operation: opts.operation,
        httpStatus: opts.httpStatus ?? null,
        error: opts.errorMessage.slice(0, 300),
        ghlContactId: opts.ghlContactId ?? null,
        ...(opts.metadata || {}),
      },
    });
  } catch {
    // Non-fatal logging helper — never let it propagate
  }
}

async function detectAndWriteConflicts(
  existing: Contact,
  ghlContact: any,
): Promise<{ conflictFields: string[]; cleanPayload: UpdateContactRequest }> {
  const conflictFields: string[] = [];
  const cleanPayload: UpdateContactRequest = {};
  const lastSynced = existing.lastSyncedAt;

  for (const { ghlKey, contactKey } of CONFLICT_FIELDS) {
    const ghlVal = ghlContact[ghlKey];
    if (ghlVal === undefined) continue;

    const normalizedGhl = ghlVal ?? "";
    const normalizedInternal = (existing[contactKey] as string) ?? "";

    if (normalizedGhl === normalizedInternal) {
      continue;
    }

    const internalUpdatedAt = existing.updatedAt ?? existing.createdAt;
    const wasModifiedSinceSync = lastSynced
      ? internalUpdatedAt && new Date(internalUpdatedAt) > new Date(lastSynced)
      : false;

    if (wasModifiedSinceSync) {
      conflictFields.push(contactKey as string);
      try {
        await storage.createSyncConflict({
          contactId: existing.id,
          fieldName: contactKey as string,
          internalValue: normalizedInternal || null,
          ghlValue: normalizedGhl || null,
          internalUpdatedAt: internalUpdatedAt ? new Date(internalUpdatedAt) : null,
          ghlUpdatedAt: null,
          resolution: "pending",
          resolvedAt: null,
        });
        console.log(`[GHL Sync] Conflict logged for contact #${existing.id} field '${contactKey as string}': internal='${normalizedInternal}' ghl='${normalizedGhl}'`);
      } catch (err: any) {
        console.error(`[GHL Sync] Failed to write conflict row for contact #${existing.id}:`, err.message);
      }
    } else {
      switch (contactKey) {
        case "firstName":    cleanPayload.firstName    = normalizedGhl; break;
        case "lastName":     cleanPayload.lastName     = normalizedGhl; break;
        case "email":        cleanPayload.email        = normalizedGhl; break;
        case "phone":        cleanPayload.phone        = normalizedGhl; break;
        case "companyName":  cleanPayload.companyName  = normalizedGhl; break;
        case "address": cleanPayload.address=normalizedGhl; break;
        case "city": cleanPayload.city=normalizedGhl; break;
        case "state": cleanPayload.state=normalizedGhl; break;
        case "website": cleanPayload.website=normalizedGhl; break;
      }
    }
  }

  return { conflictFields, cleanPayload };
}

const GHL_API_BASE = "https://services.leadconnectorhq.com";

function getConfig() {
  const apiKey = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey || !locationId) return null;
  return { apiKey, locationId, calendarId: process.env.GHL_CALENDAR_ID || undefined };
}

const GHL_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function safeParseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

async function ghlFetch(path: string, options: RequestInit & { pauseEpoch?: bigint; crmDecision?: any } = {}) {
  const config = getConfig();
  if (!config) throw new Error("GHL not configured");
  // ── Canonical pause boundary (fetch-level enforcement) ────────────────────
  // Any mutation whose caller did not already run the pause protocol
  // (signalled by pauseEpoch) gets the full authorize → register(epoch) →
  // recheck → I/O → deregister protocol here. Reads are never gated.
  const method = (options.method || "GET").toUpperCase();
  let bodyValue = typeof options.body === "string" ? safeParseJson(options.body) : options.body;
  if (bodyValue && typeof bodyValue === "object" && !Array.isArray(bodyValue)
      && Array.isArray((bodyValue as any).customFields)) {
    const inventory = await (await import("./ghl")).getGhlCustomFieldInventory(config.locationId);
    const byKey = new Map(inventory.map(field => [field.key, field.id]));
    bodyValue = {
      ...bodyValue,
      customFields: (bodyValue as any).customFields.map((field: any) => {
        const id = typeof field?.id === "string" ? field.id : byKey.get(String(field?.key ?? ""));
        const verified = inventory.find(candidate => candidate.id === id);
        if (!verified || (field.key !== undefined && field.key !== verified.key)) {
          throw new GhlSyncDeferredError("custom_field_id_unverified");
        }
        return { ...field, id, key: verified.key };
      }),
    };
    options = { ...options, body: JSON.stringify(bodyValue) };
  }
  let crmDecision = options.crmDecision;
  // Authorize every operation so unknown GETs cannot bypass the outbound fence.
  if (options.pauseEpoch === undefined) {
    const { authorizeGhlCrmOperation, recheckGhlCrmOperation } = await import("./ghl-sync-control");
    crmDecision = crmDecision ?? await authorizeGhlCrmOperation({
      method,
      path,
      body: bodyValue,
      locationId: config.locationId,
    });
    if (crmDecision.capability === "crm_write" || crmDecision.capability === "permission_write") {
      if (!crmDecision.allowed) throw new GhlSyncDeferredError(crmDecision.reasonCode);
      if (!await recheckGhlCrmOperation(crmDecision)) {
        throw new GhlSyncDeferredError("epoch_or_review_changed");
      }
      options.crmDecision = crmDecision;
    } else if (crmDecision.capability === "crm_read" || crmDecision.capability === "diagnostic_read") {
      if (!crmDecision.allowed) throw new Error(`GHL CRM read blocked: ${crmDecision.reasonCode}`);
      options.crmDecision = crmDecision;
    } else {
    const { authorize, recheckEpoch } = await import("./outbound-pause-authority");
    const { registerInflight, deregisterInflight } = await import("./outbound-control-service");
    const decision = await authorize({});
    if (!decision.allowed) {
      throw new Error(`GHL mutation blocked by pause authority: ${decision.reasonCode} (${method} ${path.split("?")[0]})`);
    }
    const tokenId = crypto.randomUUID();
    await registerInflight(tokenId, decision.epoch);
    try {
      const epochOk = await recheckEpoch(decision.epoch);
      if (!epochOk) {
        throw new Error(`GHL mutation blocked by pause authority: epoch_changed (${method} ${path.split("?")[0]})`);
      }
      return await ghlFetch(path, { ...options, pauseEpoch: decision.epoch });
    } finally {
      deregisterInflight(tokenId);
    }
    }
  }
  const pauseEpoch = options.pauseEpoch;
  delete (options as any).pauseEpoch;
  delete (options as any).crmDecision;
  const url = `${GHL_API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    "Version": "2021-07-28",
    ...(options.headers as Record<string, string> || {}),
  };
  if (GHL_MUTATION_METHODS.has(method)) {
    if (crmDecision) {
      const { recheckGhlCrmOperation } = await import("./ghl-sync-control");
      if (!await recheckGhlCrmOperation(crmDecision)) {
        throw new GhlSyncDeferredError("epoch_or_review_changed");
      }
    } else {
      const coordinatorAllowed = await canExecute("ghl-sync");
      if (!coordinatorAllowed) {
        throw new Error(`GHL mutation blocked by outbound queue coordinator (${method} ${path.split("?")[0]})`);
      }
    }
  }
  const performIo = async () => {
    if (pauseEpoch !== undefined) {
      const { recheckEpochFromDB } = await import("./outbound-pause-authority");
      if (!await recheckEpochFromDB(pauseEpoch)) throw new Error("GHL outbound epoch changed before dispatch");
    }
    const transportBody = bodyValue && typeof bodyValue === "object" && Array.isArray((bodyValue as any).customFields)
      ? JSON.stringify({
          ...bodyValue,
          customFields: (bodyValue as any).customFields.map(({ key: _key, ...field }: any) => field),
        })
      : options.body;
    const settleDispatch = await markGhlDispatch(method, path, {
      identity: bodyValue && typeof bodyValue === "object" && !Array.isArray(bodyValue)
        ? { email: typeof (bodyValue as any).email === "string" ? (bodyValue as any).email : null,
            phone: typeof (bodyValue as any).phone === "string" ? (bodyValue as any).phone : null }
        : null,
    });
    try {
      const dispatched = await fetch(url, { ...options, body: transportBody, headers, signal: options.signal ?? AbortSignal.timeout(20_000) });
      // Only a create can leave an unknown duplicate behind. The owned-tag add/remove endpoints are idempotent set
      // operations, so a 5xx/lost response on them is an ordinary retryable failure, never an ambiguous dispatch.
      const idempotentTagCall = classifyGhlOperation(method, path) === "contact_tags";
      await settleDispatch(dispatched.ok ? "ok" : (dispatched.status >= 500 && method === "POST" && !idempotentTagCall ? "ambiguous" : "http_error"), dispatched.status);
      return dispatched;
    } catch (transportError) {
      if (classifyGhlOperation(method, path) === "contact_tags") {
        await settleDispatch("http_error", null);
        throw transportError;
      }
      await settleDispatch("ambiguous");
      if (method === "POST") {
        throw new GhlAmbiguousDispatchError(`${method} ${path.split("?")[0]}: ${transportError instanceof Error ? transportError.message : String(transportError)}`);
      }
      throw transportError;
    }
  };
  const isCrmWrite = crmDecision?.capability === "crm_write" || crmDecision?.capability === "permission_write";
  const response = isCrmWrite
    ? await (await import("./ghl-sync-control")).withGhlCrmInflight(crmDecision, performIo)
    : await performIo();
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const errMsg = `GHL API error ${response.status}: ${errorBody}`;
    // Centralized structured error capture — contactId is null at this level
    logGhlSyncError({
      contactId: null,
      operation: `ghlFetch:${options.method ?? "GET"}:${path.split("?")[0]}`,
      httpStatus: response.status,
      errorMessage: errMsg,
      metadata: { url: path.split("?")[0] },
    }).catch(() => {});
    throw new Error(errMsg);
  }
  const contentType = response.headers.get("content-type") || "";
  if (response.status === 204 || !contentType.includes("application/json")) {
    return {};
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function updateSyncStatusRecord(entityType: string, direction: string, syncedCount: number, errorCount: number, lastError?: string) {
  try {
    const [existing] = await db.select().from(ghlSyncStatus).where(eq(ghlSyncStatus.entityType, entityType));
    if (existing) {
      await db.update(ghlSyncStatus).set({
        lastSyncAt: new Date(),
        lastSyncDirection: direction,
        syncedCount: (existing.syncedCount || 0) + syncedCount,
        errorCount: (existing.errorCount || 0) + errorCount,
        lastError: lastError || existing.lastError,
        updatedAt: new Date(),
      }).where(eq(ghlSyncStatus.entityType, entityType));
    } else {
      await db.insert(ghlSyncStatus).values({
        entityType,
        lastSyncAt: new Date(),
        lastSyncDirection: direction,
        syncedCount,
        errorCount,
        lastError: lastError || null,
      });
    }
  } catch (err) {
    console.error(`[GHL Sync] Failed to update sync status for ${entityType}:`, err);
  }
}

/**
 * TEST-ONLY override for the provider upsert call so scripts can drive the
 * real syncContactToGhl error-handling paths (e.g. the 422 email-validation
 * terminal skip) with a fake provider. Never set in production code paths.
 */
let _upsertGhlContactOverride: ((contact: Contact) => Promise<string | GhlUpsertOutcome>) | null = null;
export function __setUpsertGhlContactOverrideForTests(fn: ((contact: Contact) => Promise<string | GhlUpsertOutcome>) | null): void {
  _upsertGhlContactOverride = fn;
}

export async function syncContactToGhl(contactId: number): Promise<SyncContactResult> {
  try {
    if (!isGhlConfigured() && !_upsertGhlContactOverride) return { success: false, error: "GHL not configured" };
    const contact = await storage.getContact(contactId);
    if (!contact) return { success: false, error: "Contact not found" };

    // ── Pipeline local-only fence ─────────────────────────────────────────────
    // Contacts promoted via the CRO-03 pipeline carry a terminal GHL projection
    // row (terminal_reason='pipeline_local_only'). They must never be exported to
    // GHL — not through the normal broad scan, not through fullSyncToGhl(), and
    // not through half-open circuit recovery.
    const localOnlyFence = ((await db.execute(sql`
      SELECT 1 FROM contact_provider_projections
      WHERE contact_id = ${contactId}
        AND provider = 'ghl'
        AND state = 'terminal'
        AND terminal_reason = 'pipeline_local_only'
      LIMIT 1
    ` as any)).rows as any[]);
    if (localOnlyFence.length > 0) {
      console.log(`[GHL Sync] Contact #${contactId} is pipeline_local_only — skipping GHL export`);
      return { success: false, error: "PIPELINE_LOCAL_ONLY" };
    }
    // Central export recheck for every lane (projection worker, probe, direct callers).
    const exportRecordClass = String((contact as { recordClass?: string | null }).recordClass ?? "unknown").toLowerCase();
    if (exportRecordClass === "test" || exportRecordClass === "demo" || exportRecordClass === "synthetic") {
      return { success: false, error: `EXPORT_NOT_ELIGIBLE:record_class_${exportRecordClass}` };
    }
    if (contact.archivedAt) return { success: false, error: "EXPORT_NOT_ELIGIBLE:contact_archived" };

    // ── Pre-send payload validation (task #1604) ─────────────────────────────
    // A single malformed/placeholder email causes GHL to 422, which (as a
    // "retryable" classification) would wedge circuit recovery. Strip the bad
    // email when a usable phone exists; terminal-skip when neither identity
    // field is usable — with NO provider I/O.
    const identity = validateGhlIdentityFields({ email: contact.email, phone: contact.phone });
    if (!identity.ok) {
      // Sanitized audit — internal id + reason code only; no email/phone/payload.
      await storage.createAuditLog({
        action: "ghl_sync_skipped_invalid_contact",
        entityType: "contact",
        entityId: contactId,
        details: {
          reason: GHL_NO_USABLE_IDENTITY,
          stage: "pre_send_validation",
          retryable: false,
        },
      }).catch(() => {});
      console.warn(`[GHL Sync] Contact #${contactId} skipped — no usable identity fields (invalid email, no valid phone)`);
      return { success: false, error: GHL_NO_USABLE_IDENTITY };
    }
    const contactForUpsert = identity.emailOmitted
      ? ({ ...contact, email: undefined } as unknown as Contact)
      : contact;
    if (identity.emailOmitted) {
      console.warn(`[GHL Sync] Contact #${contactId} has invalid email — syncing phone-only (email omitted from GHL payload)`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    let upsertOutcome: GhlUpsertOutcome;
    try {
      const raw = await (_upsertGhlContactOverride ?? upsertGhlContactDetailed)(contactForUpsert);
      upsertOutcome = typeof raw === "string"
        ? { ghlContactId: raw, identity: "updated", components: { identity: { state: "ok" }, profile_fields: { state: "ok" }, permissions: { state: "ok" } } }
        : raw;
    } catch (upsertErr: any) {
      if (upsertErr instanceof GhlIdentityAmbiguousError || upsertErr instanceof GhlRequiredFieldUnavailableError
          || upsertErr?.code === "GHL_PROJECTION_FENCE_LOST" || upsertErr instanceof GhlAmbiguousDispatchError) {
        // Typed boundary outcomes: the projection executor maps each to its own durable disposition.
        return { success: false, error: String(upsertErr.message) };
      }
      if (upsertErr instanceof GhlIdentityConflictError) {
        // Ownership conflict — another local contact already holds this GHL ID.
        // This is a safe data-skip, not a GHL API failure; do not log as error.
        console.warn(
          `[GHL Sync] Contact #${contactId} identity conflict — GHL ID ${upsertErr.ghlContactId} owned by contact ${upsertErr.owningContactId} — skipping (not a failure)`
        );
        // Record to syncConflicts queue for staff review. Dedup: skip if a pending
        // conflict already exists for this contactId + ghl_contact_id field.
        try {
          const pendingConflicts = await storage.getSyncConflicts("pending");
          const alreadyQueued = pendingConflicts.some(
            c => c.contactId === contactId && c.fieldName === "ghl_contact_id"
          );
          if (!alreadyQueued) {
            await storage.createSyncConflict({
              contactId,
              fieldName: "ghl_contact_id",
              internalValue: upsertErr.ghlContactId,
              ghlValue: String(upsertErr.owningContactId),
              resolution: "pending",
            });
          }
        } catch (conflictLogErr: any) {
          console.warn(`[GHL Sync] Could not record identity conflict to queue: ${conflictLogErr.message}`);
        }
        return { success: false, error: "ghl_identity_conflict" };
      }
      throw upsertErr;
    }
    const ghlId = normalizeGhlId(upsertOutcome.ghlContactId) ?? undefined;
    if (ghlId && !contact.ghlContactId) {
      await storage.updateContact(contactId, { ghlContactId: ghlId });
    }
    if (ghlId) {
      console.log(`[GHL Sync] Contact #${contactId} synced → GHL ID ${ghlId}`);
    }
    const failedComponents = Object.entries(upsertOutcome.components)
      .filter(([, component]) => component.state === "failed")
      .map(([name, component]) => `${name}:${component.code ?? "failed"}`);
    if (failedComponents.length > 0) {
      // Identity is linked; a required component failed. No tags (which may trigger native workflows) until the
      // permission/suppression fields are in place.
      await updateSyncStatusRecord("contacts", "outbound", 0, 1, `GHL_COMPONENT_FAILED:${failedComponents.join(",")}`);
      return { success: false, ghlContactId: ghlId, error: `GHL_COMPONENT_FAILED:${failedComponents.join(",")}`, components: upsertOutcome.components };
    }

    // Tags (which can start a native workflow) and parent/location fields are the last component, after identity,
    // suppression and permissions are in place.
    let tagsComponent: GhlComponentOutcome = { state: "not_applicable" };
    if (ghlId) {
      const fresh = (await storage.getContact(contactId)) ?? contact;
      tagsComponent = await applyTagsAndParentComponent(fresh, ghlId);
    }
    const allComponents = { ...upsertOutcome.components, tags: tagsComponent };
    if (tagsComponent.state === "failed") {
      await updateSyncStatusRecord("contacts", "outbound", 0, 1, `GHL_COMPONENT_FAILED:tags:${tagsComponent.code ?? "failed"}`);
      return { success: false, ghlContactId: ghlId, error: `GHL_COMPONENT_FAILED:tags:${tagsComponent.code ?? "failed"}`, components: allComponents };
    }

    await storage.createGhlActivityLog({
      contactId,
      direction: "outbound",
      channel: "sync",
      subject: "Contact synced to GHL",
      body: null,
      status: "sent",
      ghlMessageId: ghlId || null,
      dealId: null,
      templateId: null,
    });

    await updateSyncStatusRecord("contacts", "outbound", 1, 0);
    const displayName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || String(contactId);
    await auditChange({
      entityType: "ghl_sync",
      entityId: contactId,
      entityKey: displayName,
      action: "ghl_sync_success",
      actorType: "system",
      details: { ghlContactId: ghlId },
    }).catch(() => {});
    return { success: true, ghlContactId: ghlId, components: allComponents };
  } catch (err: any) {
    if (isGhlSyncDeferred(err?.message)) {
      await recordGhlSyncDeferred("contacts", err.message);
      return { success: false, error: `GHL_SYNC_DEFERRED_BLOCKED:${err.message.match(/GHL_CRM_[A-Z_]+|control_disabled|permissions_disabled|native_review_[a-z_]+|operation_not_reviewed|epoch_or_review_changed/i)?.[0] ?? "POLICY"}` };
    }
    // ── Terminal data-quality skip from the shared upsert boundary ──────────
    // upsertGhlContact already wrote the sanitized skip audit; just propagate
    // the normalized code (classified "skip") without any failure logging.
    if (err instanceof GhlInvalidContactError) {
      return { success: false, error: err.code };
    }
    // ── Known email-validation 422 from GHL → terminal entity skip ──────────
    // Emit ONLY the sanitized skip audit (no response body, no email/phone,
    // no ghl_sync_failed entry — that action string feeds the failed-contact
    // retry query, and a data-quality 422 must not be retried).
    if (isGhlEmailValidation422(err?.message)) {
      console.warn(`[GHL Sync] Contact #${contactId} rejected by GHL email validation (422) — terminal skip, not retried`);
      await storage.createAuditLog({
        action: "ghl_sync_skipped_invalid_contact",
        entityType: "contact",
        entityId: contactId,
        details: {
          reason: GHL_EMAIL_VALIDATION_REJECTED,
          stage: "provider_422_email_validation",
          retryable: false,
        },
      }).catch(() => {});
      return { success: false, error: GHL_EMAIL_VALIDATION_REJECTED };
    }
    // ─────────────────────────────────────────────────────────────────────────
    console.error(`[GHL Sync] Failed to sync contact ${contactId}:`, err.message);
    await updateSyncStatusRecord("contacts", "outbound", 0, 1, err.message);
    await auditChange({
      entityType: "ghl_sync",
      entityId: contactId,
      action: "ghl_sync_failed",
      actorType: "system",
      details: { error: err.message },
    }).catch(() => {});
    // Wire logGhlSyncError for structured activity-log coverage
    const httpStatus = err.message?.match(/GHL API error (\d+)/)?.[1];
    await logGhlSyncError({
      contactId,
      operation: "syncContactToGhl",
      httpStatus: httpStatus ? Number(httpStatus) : null,
      errorMessage: err.message,
      metadata: { stage: "contact_upsert" },
    }).catch(() => {});
    return { success: false, error: err.message };
  }
}

export async function syncContactFromGhl(ghlContact: any): Promise<{ contactId: number; created: boolean } | null> {
  const businessEvidence=intakeBusinessEvidence({companyName:ghlContact.companyName,website:ghlContact.website,
    phone:ghlContact.phone,address:ghlContact.address1,city:ghlContact.city,state:ghlContact.state});
  const businessEvidenceRevision=crypto.createHash("sha256").update(JSON.stringify(businessEvidence)).digest("hex");
  // Wave B1: GHL CRM decoupling guard
  const { checkGhlCrmSyncAllowed, logGhlShadowIntent } = await import("./ghl-crm-sync-guard");
  const guard = checkGhlCrmSyncAllowed("syncContactFromGhl", null);
  if (guard.blocked) return null;
  if (guard.shadowMode) {
    // Log raw GHL payload — field-level diff logged separately via syncTagsFromGhl for tags
    await logGhlShadowIntent("syncContactFromGhl", {
      entityType: "contact",
      ghlId: ghlContact.id ?? null,
      rawPayload: { id: ghlContact.id, email: ghlContact.email, phone: ghlContact.phone, firstName: ghlContact.firstName, lastName: ghlContact.lastName },
    });
    return null; // Liberty is source of truth — no write in shadow mode
  }

  try {
    // Branch A: indexed lookup by GHL contact ID.
    // Uses contacts_ghl_contact_id_idx (shared/schema.ts:118) — never falls back to full scan.
    const existingByGhlId = ghlContact.id
      ? await storage.getContactByGhlContactId(ghlContact.id)
      : undefined;

    // Branch B: indexed lookup by normalized email.
    // A mailbox may belong to distinct GHL identities; require corroboration.
    const normalizedEmail = ghlContact.email ? ghlContact.email.trim().toLowerCase() : "";
    const existingByEmail = normalizedEmail
      ? await storage.getContactByEmail(normalizedEmail,{
        ...ghlContact,address:ghlContact.address1,ghlContactId:ghlContact.id,
      })
      : undefined;

    // Identity-conflict guard: both branches matched but to *different* local contacts.
    // Writing to either row would silently merge two distinct merchants — stop and log.
    if (existingByGhlId && existingByEmail && existingByGhlId.id !== existingByEmail.id) {
      await storage.createAuditLog({
        action: "ghl_sync_identity_conflict",
        entityType: "contact",
        entityId: existingByGhlId.id,
        details: {
          ghlContactId: ghlContact.id,
          byGhlIdContactId: existingByGhlId.id,
          byEmailContactId: existingByEmail.id,
          email: normalizedEmail,
        },
      });
      console.warn(`[GHL Sync] Identity conflict: GHL ID ${ghlContact.id} maps to contact #${existingByGhlId.id} but email ${normalizedEmail} maps to contact #${existingByEmail.id} — sync aborted`);
      return null;
    }

    // Resolve the winning row: GHL ID takes precedence over email match.
    const existingContact = existingByGhlId ?? existingByEmail;

    if (existingContact) {
      // ghlContactId ownership enforcement on email-match path (Step 5).
      // If we landed here via email only, check whether this row already belongs to a different GHL contact.
      if (!existingByGhlId && existingByEmail) {
        if (
          existingByEmail.ghlContactId !== null &&
          existingByEmail.ghlContactId !== undefined &&
          existingByEmail.ghlContactId !== ghlContact.id
        ) {
          await storage.createAuditLog({
            action: "ghl_sync_ghlid_ownership_conflict",
            entityType: "contact",
            entityId: existingByEmail.id,
            details: {
              incomingGhlContactId: ghlContact.id,
              existingGhlContactId: existingByEmail.ghlContactId,
              email: normalizedEmail,
            },
          });
          console.warn(`[GHL Sync] ghlContactId ownership conflict for contact #${existingByEmail.id}: already owned by ${existingByEmail.ghlContactId}, incoming ${ghlContact.id} — sync aborted`);
          return null;
        }
      }

      const { conflictFields, cleanPayload } = await detectAndWriteConflicts(existingContact, ghlContact);

      // Wave 7: Strip Replit-owned compliance/permission fields from any GHL-sourced payload.
      // Replit is the system-of-record; GHL must never overwrite these — even if GHL sends them.
      for (const field of getReplitOwnedFields()) {
        delete (cleanPayload as any)[field];
      }

      // Tags are always applied (no conflict model for array fields)
      if (Array.isArray(ghlContact.tags)) {
        cleanPayload.tags = ghlContact.tags;
      }

      // On email-match path: attach the incoming ghlContactId when the row has none.
      // If it already matches, this is a no-op; if it differed, we returned null above.
      if (!existingByGhlId && existingByEmail) {
        (cleanPayload as any).ghlContactId = normalizeGhlId(ghlContact.id);
      }

      if (conflictFields.length === 0) {
        // Fully clean sync — apply field changes and advance the baseline.
        // syncUpdateContact does NOT bump updatedAt, so updatedAt stays as the last
        // genuine user-edit timestamp and future conflict detection stays accurate.
        cleanPayload.lastSyncedAt = new Date();
        await storage.syncUpdateContact(existingContact.id, cleanPayload);
      } else if (Object.keys(cleanPayload).length > 0) {
        // Some fields were clean, some conflicted — apply only the clean ones, preserve baseline.
        await storage.syncUpdateContact(existingContact.id, cleanPayload);
        console.log(`[GHL Sync] ${conflictFields.length} conflict(s) logged for contact #${existingContact.id}: ${conflictFields.join(", ")}`);
      } else {
        // All changed fields were conflicted — don't touch anything; preserve lastSyncedAt.
        console.log(`[GHL Sync] ${conflictFields.length} conflict(s) logged for contact #${existingContact.id}: ${conflictFields.join(", ")} — no DB write`);
      }

      // Record/refresh a source event so provenance stays current on every inbound sync tick.
      // Each evidence revision is immutable. Repeated ticks refresh only the
      // occurrence timestamp; original events are not overwritten.
      await upsertContactSourceEvent({
        contactId: existingContact.id,
        provenance: {
          eventKey: `ghl:${ghlContact.id}:inbound:business-v1:${businessEvidenceRevision}`,
          sourceCategory: "ghl_sync",
          sourceType: "inbound",
          sourceExternalId: ghlContact.id,
          actorType: "system",
          metadata:{businessEvidence,businessEvidenceRevision},
        },
      }).catch((e: any) => console.warn(`[GHL Sync] source event upsert failed for contact #${existingContact.id}:`, e?.message || e));

      await updateSyncStatusRecord("contacts", "inbound", 1, 0);
      return { contactId: existingContact.id, created: false };
    }

    // No existing row found — create a new contact.
    // Use ghl_inbound_no_echo mode to avoid echoing inbound data back to GHL.
    // Wrap in try/catch to recover from 23505 unique-violation races (concurrent create).
    const stableEventKey = `ghl:${ghlContact.id}:created`;
    try {
      const contact = await writeContact({
        mode: "ghl_inbound_no_echo",
        mutation: {
          firstName: ghlContact.firstName || "Unknown",
          lastName: ghlContact.lastName || "",
          email: ghlContact.email || "",
          phone: ghlContact.phone || "",
          companyName: ghlContact.companyName || "",
          address:ghlContact.address1 || null,
          city:ghlContact.city || null,
          state:ghlContact.state || null,
          website:ghlContact.website || null,
          ghlContactId: ghlContact.id,
          status: "New",
          tags: [...(ghlContact.tags || []), "ghl-import"],
          referralSource: "ghl_sync",
          lastSyncedAt: new Date(),
        },
        provenance: {
          sourceCategory: "ghl_sync",
          sourceType: "inbound",
          eventKey: stableEventKey,
          sourceExternalId: ghlContact.id,
          actorType: "system",
          metadata:{businessEvidence,businessEvidenceRevision},
        },
        actor: { actorType: "system" },
      });

      await updateSyncStatusRecord("contacts", "inbound", 1, 0);
      // An ordinary GHL sync is a projection/acquisition update, not an
      // inbound request or promotional authorization. Any later explicit
      // merchant event must claim its own provider occurrence.
      return { contactId: contact.id, created: true };
    } catch (createErr: any) {
      // 23505 = Postgres unique_violation — a concurrent create beat us to it.
      // IMPORTANT: Only recover when the violated constraint is contacts_ghl_contact_id_unique.
      // Any other 23505 (e.g. email uniqueness) must be rethrown — swallowing those would
      // silently corrupt unrelated identity constraints.
      const isUniqueViolation = createErr?.code === "23505" || createErr?.message?.includes("23505");
      if (isUniqueViolation) {
        const violatedConstraint: string = createErr?.constraint ?? createErr?.detail ?? "";
        const isGhlIdConstraint =
          violatedConstraint.includes("contacts_ghl_contact_id_unique") ||
          (createErr?.detail ?? "").includes("ghl_contact_id");

        if (isGhlIdConstraint) {
          console.warn(`[GHL Sync] 23505 on contacts_ghl_contact_id_unique for GHL ID ${ghlContact.id} — re-querying`);
          const recovered = ghlContact.id
            ? await storage.getContactByGhlContactId(ghlContact.id)
            : undefined;

          if (recovered) {
            // Verify identity before stamping lastSyncedAt — guard against phantom race recovery.
            await storage.syncUpdateContact(recovered.id, { lastSyncedAt: new Date() });
            await updateSyncStatusRecord("contacts", "inbound", 1, 0);
            return { contactId: recovered.id, created: false };
          }
          // Re-query returned nothing — do not create a third row; log and bail.
          console.error(`[GHL Sync] 23505 recovery: re-query found no contact for GHL ID ${ghlContact.id} — aborting`);
          await storage.createAuditLog({
            action: "ghl_sync_23505_unrecoverable",
            entityType: "contact",
            details: { ghlContactId: ghlContact.id, email: normalizedEmail },
          });
          return null;
        }
        // Non-GHL-ID unique violation (e.g. email index) — rethrow so the outer catch logs it.
      }
      throw createErr;
    }
  } catch (err: any) {
    console.error("[GHL Sync] Failed to sync from GHL:", err.message);
    await updateSyncStatusRecord("contacts", "inbound", 0, 1, err.message);
    return null;
  }
}

/**
 * Retired bulk export. A broad scan of unlinked contacts is exactly the historical-bulk-export lane the
 * projection authority forbids: contact export is queued only by `enqueueContactProjection` and executed by
 * `processEligibleContactProjections`. Kept as a no-op so legacy callers cannot create GHL records.
 */
export async function fullSyncToGhl(): Promise<{ synced: number; failed: number; skipped: number }> {
  console.warn("[GHL Sync] fullSyncToGhl is retired: contact export is governed by the projection authority");
  return { synced: 0, failed: 0, skipped: 0 };
}

export async function fullSyncFromGhl(): Promise<{ created: number; updated: number; failed: number }> {
  if (!isGhlConfigured()) return { created: 0, updated: 0, failed: 0 };

  const config = getConfig();
  if (!config) return { created: 0, updated: 0, failed: 0 };

  let created = 0;
  let updated = 0;
  let failed = 0;
  let nextPageUrl: string | null = `/contacts/?locationId=${config.locationId}&limit=100`;

  console.log("[GHL Sync] Starting full sync from GHL...");

  try {
    while (nextPageUrl) {
      const data = await ghlFetch(nextPageUrl);
      const contacts = data.contacts || [];

      for (const ghlContact of contacts) {
        try {
          const result = await syncContactFromGhl(ghlContact);
          if (result) {
            if (result.created) created++;
            else updated++;
          }
        } catch (err) {
          failed++;
        }
      }

      const meta = data.meta;
      if (meta?.nextPageUrl || meta?.nextPage) {
        const next = meta.nextPageUrl || meta.nextPage;
        nextPageUrl = next.startsWith("http") ? next.replace(GHL_API_BASE, "") : next;
      } else if (data.meta?.total && (created + updated + failed) < data.meta.total && contacts.length === 100) {
        nextPageUrl = `/contacts/?locationId=${config.locationId}&limit=100&startAfter=${contacts[contacts.length - 1]?.id}`;
      } else {
        nextPageUrl = null;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (err: any) {
    console.error("[GHL Sync] Error during full sync from GHL:", err.message);
  }

  console.log(`[GHL Sync] From GHL complete: ${created} created, ${updated} updated, ${failed} failed`);

  await storage.setSystemSetting("ghl_last_sync_from", {
    timestamp: new Date().toISOString(),
    created,
    updated,
    failed,
  });

  return { created, updated, failed };
}

type SemanticGhlStageMapping = {
  localPipelineId: string;
  localStageId: number;
  ghlPipelineId: string;
  ghlStageId: string;
};
type GhlPipelineMetadata = { id: string; name: string; stages: Array<{ id: string; name: string }> };

let cachedProviderPipelines: GhlPipelineMetadata[] = [];
let cachedProviderPipelinesAt = 0;
const PIPELINE_CACHE_TTL_MS = 30_000;

async function loadSemanticStageMappings(): Promise<SemanticGhlStageMapping[]> {
  const raw = await storage.getSystemSetting("ghl_semantic_stage_id_map");
  if (!Array.isArray(raw)) return [];
  return raw.filter((mapping: any): mapping is SemanticGhlStageMapping =>
    !!mapping
    && typeof mapping.localPipelineId === "string"
    && Number.isSafeInteger(mapping.localStageId)
    && typeof mapping.ghlPipelineId === "string"
    && typeof mapping.ghlStageId === "string");
}

async function getFreshProviderPipelines(forceRefresh = false): Promise<GhlPipelineMetadata[]> {
  if (!forceRefresh && cachedProviderPipelines.length > 0 && Date.now() - cachedProviderPipelinesAt < PIPELINE_CACHE_TTL_MS) {
    return cachedProviderPipelines;
  }
  const config = getConfig();
  if (!config) throw new Error("GHL not configured");
  const data = await ghlFetch(`/opportunities/pipelines?locationId=${config.locationId}`);
  cachedProviderPipelines = (data.pipelines || []).filter((pipeline: any) => typeof pipeline.id === "string").map((pipeline: any) => ({
    id: pipeline.id,
    name: typeof pipeline.name === "string" ? pipeline.name : "",
    stages: Array.isArray(pipeline.stages) ? pipeline.stages
      .filter((stage: any) => typeof stage.id === "string")
      .map((stage: any) => ({ id: stage.id, name: typeof stage.name === "string" ? stage.name : "" })) : [],
  }));
  cachedProviderPipelinesAt = Date.now();
  return cachedProviderPipelines;
}

async function resolveSemanticGhlStage(localPipelineId: string, localStageId: number): Promise<{
  pipelineId: string;
  stageId: string;
}> {
  const mappings = await loadSemanticStageMappings();
  const mapping = mappings.find(candidate =>
    candidate.localPipelineId === localPipelineId && candidate.localStageId === localStageId);
  if (!mapping) {
    throw new Error(`GHL_SEMANTIC_STAGE_MAPPING_UNRESOLVED:${localPipelineId}:${localStageId}`);
  }
  const pipelines = await getFreshProviderPipelines();
  const pipeline = pipelines.find(candidate => candidate.id === mapping.ghlPipelineId);
  if (!pipeline || !pipeline.stages.some(stage => stage.id === mapping.ghlStageId)) {
    throw new Error(`GHL_SEMANTIC_STAGE_MAPPING_STALE:${localPipelineId}:${localStageId}:${mapping.ghlPipelineId}:${mapping.ghlStageId}`);
  }
  return { pipelineId: mapping.ghlPipelineId, stageId: mapping.ghlStageId };
}

async function resolveLocalSemanticStage(ghlPipelineId: string, ghlStageId: string): Promise<{ pipelineId: string; stageName: string }> {
  const pipelines = await getFreshProviderPipelines();
  const providerPipeline = pipelines.find(candidate => candidate.id === ghlPipelineId);
  if (!providerPipeline || !providerPipeline.stages.some(stage => stage.id === ghlStageId)) {
    throw new Error(`GHL_SEMANTIC_STAGE_MAPPING_STALE:${ghlPipelineId}:${ghlStageId}`);
  }
  const mappings = await loadSemanticStageMappings();
  const mapping = mappings.find(candidate =>
    candidate.ghlPipelineId === ghlPipelineId && candidate.ghlStageId === ghlStageId);
  if (!mapping) throw new Error(`GHL_SEMANTIC_STAGE_MAPPING_UNRESOLVED:${ghlPipelineId}:${ghlStageId}`);
  const [localStage] = await db.select().from(pipelineStages).where(
    sql`${pipelineStages.id} = ${mapping.localStageId} AND ${pipelineStages.pipeline} = ${mapping.localPipelineId}`,
  ).limit(1);
  if (!localStage) throw new Error(`GHL_SEMANTIC_LOCAL_STAGE_MISSING:${mapping.localPipelineId}:${mapping.localStageId}`);
  return { pipelineId: localStage.pipeline, stageName: localStage.stageName };
}

// Compatibility helper: a display title alone cannot resolve an ID-to-ID mapping.
export function autoAlignStages(
  localStages: string[],
  ghlStages: Array<{ name: string; id: string }>,
): Array<{ localName: string; ghlId: string | null; ghlName: string | null; score: number; method: "exact" | "fuzzy" | "none" }> {
  void ghlStages;
  return localStages.map(local => ({ localName: local, ghlId: null, ghlName: null, score: 0, method: "none" as const }));
}

/** Returns freshly-read provider stages and only explicit local ID-to-ID mappings. */
export async function getGhlPipelineStages(): Promise<{
  pipelineId: string | null;
  /** Raw GHL stages returned from the API */
  ghlStages: Array<{ name: string; id: string }>;
  /** Auto-alignment result for each local stage */
  alignment: Array<{
    localName: string;
    ghlId: string | null;
    ghlName: string | null;
    score: number;
    method: "exact" | "fuzzy" | "none";
    /** If a DB or env override is active, this overrides the auto-match */
    override?: string;
  }>;
  dbOverrides: Record<string, string>;
  envOverrides: Record<string, string>;
}> {
  const pipelines = await getFreshProviderPipelines(true);
  const mappings = await loadSemanticStageMappings();
  const localStages = await db.select().from(pipelineStages);
  const providerStageByKey = new Map<string, { pipelineId: string; stage: { id: string; name: string } }>();
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) providerStageByKey.set(`${pipeline.id}\0${stage.id}`, { pipelineId: pipeline.id, stage });
  }
  const mappingByLocalKey = new Map(mappings.map(mapping => [`${mapping.localPipelineId}\0${mapping.localStageId}`, mapping]));
  const alignment = localStages.map(local => {
    const mapping = mappingByLocalKey.get(`${local.pipeline}\0${local.id}`);
    const provider = mapping ? providerStageByKey.get(`${mapping.ghlPipelineId}\0${mapping.ghlStageId}`) : undefined;
    return {
      localName: `${local.pipeline}/${local.stageName}`,
      ghlId: provider?.stage.id ?? null,
      ghlName: provider?.stage.name ?? null,
      score: provider ? 1 : 0,
      method: provider ? "exact" as const : "none" as const,
      override: mapping?.ghlStageId,
    };
  });
  const mappedPipelineIds = new Set(mappings.map(mapping => mapping.ghlPipelineId));

  return {
    pipelineId: mappedPipelineIds.size === 1 ? [...mappedPipelineIds][0] : null,
    ghlStages: pipelines.flatMap(pipeline => pipeline.stages),
    alignment,
    dbOverrides: {},
    envOverrides: {},
  };
}

/**
 * Refresh provider pipeline metadata and report the explicitly configured ID
 * mappings. This function never creates or updates provider pipelines/stages.
 */
export async function syncLocalStagesToGhl(): Promise<{
  resolved: number;
  total: number;
  alignment: Awaited<ReturnType<typeof getGhlPipelineStages>>["alignment"];
}> {
  // Force a fresh provider read; never create or mutate pipeline stages.
  cachedProviderPipelinesAt = 0;
  const result = await getGhlPipelineStages();
  const resolved = result.alignment.filter(r => r.ghlId).length;
  return { resolved, total: result.alignment.length, alignment: result.alignment };
}

export function mapDealStageToGhl(stage: string): { pipelineStageId: string; status: "open" | "won" | "lost" | "abandoned" } {
  throw new Error(`GHL_SEMANTIC_STAGE_MAPPING_REQUIRED:${stage}`);
}

function dealStatusForStage(stage: string): "open" | "won" | "lost" | "abandoned" {
  let status: "open" | "won" | "lost" | "abandoned" = "open";
  if (stage === "Closed Won") status = "won";
  else if (stage === "Closed Lost") status = "lost";
  else if (stage === "Nurture / Not Now") status = "abandoned";
  return status;
}

export function mapGhlStageToDeal(ghlStageId: string, ghlStatus?: string): string {
  void ghlStatus;
  throw new Error(`GHL_SEMANTIC_STAGE_MAPPING_REQUIRED:${ghlStageId}`);
}

export async function syncDealToGhl(dealId: number): Promise<{ success: boolean; ghlOpportunityId?: string; error?: string }> {
  try {
    if (!isGhlConfigured()) return { success: false, error: "GHL not configured" };
    const config = getConfig();
    if (!config) return { success: false, error: "GHL not configured" };

    const deal = await storage.getDeal(dealId);
    if (!deal) return { success: false, error: "Deal not found" };

    const contact = deal.contactId ? await storage.getContact(deal.contactId) : null;
    let ghlContactId = contact?.ghlContactId;
    if (contact && !ghlContactId) {
      const syncResult = await syncContactToGhl(contact.id);
      ghlContactId = syncResult.ghlContactId;
    }
    if (!ghlContactId) return { success: false, error: "No GHL contact linked" };

    const [localStage] = await db.select().from(pipelineStages).where(
      sql`${pipelineStages.pipeline} = ${deal.pipeline} AND ${pipelineStages.stageName} = ${deal.stage}`,
    ).limit(1);
    if (!localStage) throw new Error(`GHL_SEMANTIC_LOCAL_STAGE_MISSING:${deal.pipeline}:${deal.stage}`);
    const stageMapping = await resolveSemanticGhlStage(localStage.pipeline, localStage.id);
    const status = dealStatusForStage(deal.stage);

    // POST (create) requires locationId; PUT (update) rejects it — keep separate.
    const createPayload: Record<string, any> = {
      pipelineId: stageMapping.pipelineId,
      locationId: config.locationId,
      name: deal.contactId ? `${contact?.companyName || contact?.firstName} - Deal #${deal.id}` : `Deal #${deal.id}`,
      status,
      contactId: ghlContactId,
      monetaryValue: deal.totalVolume ? Number(deal.totalVolume) : undefined,
      pipelineStageId: stageMapping.stageId,
    };
    const updatePayload: Record<string, any> = {
      pipelineId: stageMapping.pipelineId,
      name: createPayload.name,
      status: createPayload.status,
      contactId: ghlContactId,
      monetaryValue: createPayload.monetaryValue,
      pipelineStageId: createPayload.pipelineStageId,
    };

    const existingGhlOpportunityId = deal.ghlOpportunityId;

    let ghlOpportunityId: string | undefined;
    if (existingGhlOpportunityId) {
      await ghlFetch(`/opportunities/${existingGhlOpportunityId}`, {
        method: "PUT",
        body: JSON.stringify(updatePayload),
      });
      ghlOpportunityId = existingGhlOpportunityId;
    } else {
      try {
        const result = await ghlFetch("/opportunities/", {
          method: "POST",
          body: JSON.stringify(createPayload),
        });
        ghlOpportunityId = result?.opportunity?.id || result?.id;
        if (ghlOpportunityId) {
          await db.execute(sql`UPDATE deals SET ghl_opportunity_id = ${ghlOpportunityId}, updated_at = NOW() WHERE id = ${dealId}`);
        }
      } catch (postErr: any) {
        // Auto-recover duplicate opportunity — GHL returns 400 with meta.existingId.
        // Same pattern as the duplicate-contact 400 recovery in upsertGhlContact.
        const dupMatch = postErr.message?.match(/"existingId":"([^"]+)"/);
        if (dupMatch) {
          const recoveredId = dupMatch[1];
          console.log(`[GHL Sync] Recovering duplicate deal ${dealId} → existing GHL opportunity ${recoveredId}`);
          await db.execute(sql`UPDATE deals SET ghl_opportunity_id = ${recoveredId}, updated_at = NOW() WHERE id = ${dealId}`);
          await ghlFetch(`/opportunities/${recoveredId}`, {
            method: "PUT",
            body: JSON.stringify(updatePayload),
          });
          ghlOpportunityId = recoveredId;
        } else {
          throw postErr;
        }
      }
    }

    if (contact) {
      await checkAndApplyActivePipelineTag(contact, ghlContactId);
    }

    await updateSyncStatusRecord("deals", "outbound", 1, 0);
    return { success: true, ghlOpportunityId };
  } catch (err: any) {
    if (isGhlSyncDeferred(err?.message)) {
      await recordGhlSyncDeferred("deals", err.message);
      return { success: false, error: `GHL_SYNC_DEFERRED_BLOCKED:${err.message.match(/GHL_CRM_[A-Z_]+|control_disabled|permissions_disabled|native_review_[a-z_]+|operation_not_reviewed|epoch_or_review_changed/i)?.[0] ?? "POLICY"}` };
    }
    if (/^GHL_SEMANTIC_(?:STAGE_MAPPING|LOCAL_STAGE)/.test(String(err?.message))) {
      console.warn(`[GHL Sync] Deal ${dealId} stage mapping deferred:`, err.message);
      return { success: false, error: err.message };
    }
    console.error(`[GHL Sync] Failed to sync deal ${dealId}:`, err.message);
    await updateSyncStatusRecord("deals", "outbound", 0, 1, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncDealFromGhl(ghlOpportunity: any): Promise<{ dealId: number; created: boolean } | null> {
  // Wave B1: GHL CRM decoupling guard
  const { checkGhlCrmSyncAllowed, logGhlShadowIntent } = await import("./ghl-crm-sync-guard");
  const guard = checkGhlCrmSyncAllowed("syncDealFromGhl", null);
  if (guard.blocked) return null;
  if (guard.shadowMode) {
    await logGhlShadowIntent("syncDealFromGhl", {
      entityType: "deal",
      ghlId: ghlOpportunity.id ?? null,
      rawPayload: { id: ghlOpportunity.id, contactId: ghlOpportunity.contactId, pipelineStageId: ghlOpportunity.pipelineStageId, status: ghlOpportunity.status, monetaryValue: ghlOpportunity.monetaryValue },
    });
    return null;
  }

  try {
    const ghlContactId = ghlOpportunity.contactId || ghlOpportunity.contact?.id;
    if (!ghlContactId) return null;

    // Indexed lookup — contacts_ghl_contact_id_unique index; never scans all rows.
    const contact = ghlContactId ? await storage.getContactByGhlContactId(ghlContactId) : undefined;
    if (!contact) return null;

    const ghlStageId = ghlOpportunity.pipelineStageId || ghlOpportunity.stageId;
    const ghlPipelineId = ghlOpportunity.pipelineId || ghlOpportunity.pipeline?.id;
    if (!ghlStageId || !ghlPipelineId) return null;
    const localStageMapping = await resolveLocalSemanticStage(ghlPipelineId, ghlStageId);
    const localStage = localStageMapping.stageName;

    const existingDeals = await storage.getDealsByContact(contact.id);
    const existingDeal = existingDeals.find(d => d.ghlOpportunityId === ghlOpportunity.id);

    if (existingDeal) {
      const updatePayload: Record<string, any> = {};
      if (ghlOpportunity.monetaryValue !== undefined && ghlOpportunity.monetaryValue !== null) {
        updatePayload.totalVolume = String(ghlOpportunity.monetaryValue);
      } else if (ghlOpportunity.monetaryValue === null) {
        updatePayload.totalVolume = null;
      }
      if (ghlOpportunity.name) {
        updatePayload.notes = existingDeal.notes || `GHL Opportunity: ${ghlOpportunity.name}`;
      }

      // Go-Live gate: block inbound GHL stage writes that would bypass the readiness check
      let stageBlocked = false;
      if (localStage && existingDeal.pipeline === "onboarding" && (GO_LIVE_GATE_STAGES as readonly string[]).includes(localStage)) {
        const readiness = await checkGoLiveReadiness(existingDeal);
        if (!readiness.ready) {
          stageBlocked = true;
          console.warn(
            `[GHL Sync] Go-live gate blocked inbound stage "${localStage}" for onboarding deal #${existingDeal.id}. Missing: ${readiness.missing.join("; ")}`,
          );
          await storage.createAuditLog({
            action: "go_live_gate_blocked_ghl_inbound",
            entityType: "deal",
            entityId: existingDeal.id,
            details: { attemptedStage: localStage, missingItems: readiness.missing, source: "ghl_inbound_sync" },
          });
        }
      }

      // Wave 1A: Liberty is the system-of-record for deal stages.
      // GHL opportunity stage changes must NOT overwrite Liberty deal stages except in
      // explicit admin-override scenarios (GHL_DEAL_STAGE_AUTHORITY=ghl env var).
      // Default: "liberty" — inbound GHL stage writes are dropped with a log.
      const dealStageAuthority = (process.env.GHL_DEAL_STAGE_AUTHORITY ?? "liberty").toLowerCase();
      const ghlCanWriteDealStage = dealStageAuthority === "ghl";

      if (!stageBlocked && localStage && ghlCanWriteDealStage) {
        updatePayload.stage = localStage;
        updatePayload.pipeline = localStageMapping.pipelineId;
      } else if (!stageBlocked && localStage && !ghlCanWriteDealStage) {
        // Liberty owns deal stages — log the drop for observability but do not apply
        console.log(
          `[GHL Sync] Deal #${existingDeal.id} stage write blocked: GHL wants "${localStage}" but Liberty is system-of-record. ` +
          `Set GHL_DEAL_STAGE_AUTHORITY=ghl to allow GHL to overwrite deal stages.`,
        );
        await storage.createAuditLog({
          action: "ghl_sync_deal_stage_blocked",
          entityType: "deal",
          entityId: existingDeal.id,
          details: {
            attemptedStage: localStage,
            currentStage: existingDeal.stage,
            ghlOpportunityId: ghlOpportunity.id,
            reason: "liberty_is_deal_stage_authority",
          },
        }).catch(() => {});
      }

      if (Object.keys(updatePayload).length > 0) {
        await storage.updateDeal(existingDeal.id, updatePayload);
      }
      await updateSyncStatusRecord("deals", "inbound", 1, 0);
      return { dealId: existingDeal.id, created: false };
    }

    const newDeal = await storage.createDeal({
      contactId: contact.id,
      stage: localStage,
      pipeline: localStageMapping.pipelineId,
      totalVolume: (ghlOpportunity.monetaryValue !== undefined && ghlOpportunity.monetaryValue !== null) ? String(ghlOpportunity.monetaryValue) : undefined,
      notes: `Synced from GHL opportunity: ${ghlOpportunity.name || ghlOpportunity.id}`,
    });

    if (ghlOpportunity.id) {
      await storage.updateDeal(newDeal.id, { ghlOpportunityId: ghlOpportunity.id });
    }

    await updateSyncStatusRecord("deals", "inbound", 1, 0);
    return { dealId: newDeal.id, created: true };
  } catch (err: any) {
    console.error("[GHL Sync] Failed to sync deal from GHL:", err.message);
    if (!/^GHL_SEMANTIC_(?:STAGE_MAPPING|LOCAL_STAGE)/.test(String(err?.message))) {
      await updateSyncStatusRecord("deals", "inbound", 0, 1, err.message);
    }
    return null;
  }
}

export async function syncCompanyToGhl(companyId: number): Promise<{ success: boolean; skip?: boolean; error?: string }> {
  try {
    if (!isGhlConfigured()) return { success: false, error: "GHL not configured" };
    const config = getConfig();
    if (!config) return { success: false, error: "GHL not configured" };

    const companies = await storage.getCompanies();
    const company = companies.find(c => c.id === companyId);
    if (!company) return { success: false, error: "Company not found" };

    const companyPayload = {
      name: company.legalName,
      website: company.website || undefined,
      address: company.address || undefined,
      locationId: config.locationId,
    };

    await ghlFetch("/companies", {
      method: "POST",
      body: JSON.stringify(companyPayload),
    });

    await updateSyncStatusRecord("companies", "outbound", 1, 0);
    console.log(`[GHL Sync] Company ${companyId} (${company.legalName}) synced to GHL`);
    return { success: true };
  } catch (err: any) {
    if (isGhlSyncDeferred(err?.message)) {
      await recordGhlSyncDeferred("companies", err.message);
      return { success: false, error: `GHL_SYNC_DEFERRED_BLOCKED:${err.message.match(/GHL_CRM_[A-Z_]+|control_disabled|permissions_disabled|native_review_[a-z_]+|operation_not_reviewed|epoch_or_review_changed/i)?.[0] ?? "POLICY"}` };
    }
    // 404 = GHL companies API not available at this integration tier — skip
    // silently rather than counting toward the circuit-breaker threshold.
    const is404 = err.message?.includes("404");
    if (is404) {
      console.warn(`[GHL Sync] Company ${companyId} sync skipped (GHL companies API unavailable)`);
      return { success: false, skip: true, error: err.message };
    }
    console.error(`[GHL Sync] Failed to sync company ${companyId}:`, err.message);
    await updateSyncStatusRecord("companies", "outbound", 0, 1, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncTaskToGhl(taskId: number): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isGhlConfigured()) return { success: false, error: "GHL not configured" };
    const config = getConfig();
    if (!config) return { success: false, error: "GHL not configured" };

    const allTasks = await storage.getTasks({ limit: 500 });
    const task = allTasks.find((t: any) => t.id === taskId);
    if (!task) return { success: false, error: "Task not found" };

    let ghlContactId: string | undefined;
    if (task.contactId) {
      const contact = await storage.getContact(task.contactId);
      ghlContactId = contact?.ghlContactId || undefined;
      if (contact && !ghlContactId) {
        const syncResult = await syncContactToGhl(contact.id);
        ghlContactId = syncResult.ghlContactId;
      }
    }

    if (!ghlContactId) return { success: false, error: "No GHL contact linked to task" };

    // GHL Tasks API only accepts: title, dueDate, assignedTo, completed.
    // Sending body/description or contactId (already in URL) causes a 422.
    const taskPayload: Record<string, unknown> = {
      title: task.title,
      dueDate: task.dueDate ? new Date(task.dueDate).toISOString() : undefined,
      completed: task.status === "completed",
    };

    const taskData: any = await ghlFetch(`/contacts/${ghlContactId}/tasks`, {
      method: "POST",
      body: JSON.stringify(taskPayload),
    });

    try {
      const returnedGhlTaskId = taskData?.task?.id || taskData?.id;
      if (returnedGhlTaskId) {
        await storage.updateTask(taskId, { ghlTaskId: returnedGhlTaskId } as any);
      }
    } catch {
      // non-critical — task was synced, ID capture failed
    }

    await updateSyncStatusRecord("tasks", "outbound", 1, 0);
    console.log(`[GHL Sync] Task ${taskId} synced to GHL`);
    return { success: true };
  } catch (err: any) {
    if (isGhlSyncDeferred(err?.message)) {
      await recordGhlSyncDeferred("tasks", err.message);
      return { success: false, error: `GHL_SYNC_DEFERRED_BLOCKED:${err.message.match(/GHL_CRM_[A-Z_]+|control_disabled|permissions_disabled|native_review_[a-z_]+|operation_not_reviewed|epoch_or_review_changed/i)?.[0] ?? "POLICY"}` };
    }
    console.error(`[GHL Sync] Failed to sync task ${taskId}:`, err.message);
    await updateSyncStatusRecord("tasks", "outbound", 0, 1, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncTicketToGhl(ticketId: number): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isGhlConfigured()) return { success: false, error: "GHL not configured" };
    const config = getConfig();
    if (!config) return { success: false, error: "GHL not configured" };

    const ticket = await storage.getTicket(ticketId);
    if (!ticket) return { success: false, error: "Ticket not found" };

    let ghlContactId: string | undefined;
    if (ticket.contactId) {
      const contact = await storage.getContact(ticket.contactId);
      ghlContactId = contact?.ghlContactId || undefined;
      if (contact && !ghlContactId) {
        const syncResult = await syncContactToGhl(contact.id);
        ghlContactId = syncResult.ghlContactId;
      }
    }

    if (!ghlContactId) return { success: false, error: "No GHL contact linked to ticket" };

    // GHL Tasks API only accepts: title, dueDate, assignedTo, completed.
    // Sending body/description or contactId (already in URL) causes a 422.
    const taskPayload: Record<string, unknown> = {
      title: `[Ticket #${ticket.id}] ${ticket.subject}`,
      dueDate: ticket.slaDeadline ? new Date(ticket.slaDeadline).toISOString() : undefined,
      completed: ticket.status === "Resolved" || ticket.status === "Closed",
    };

    await ghlFetch(`/contacts/${ghlContactId}/tasks`, {
      method: "POST",
      body: JSON.stringify(taskPayload),
    });

    await updateSyncStatusRecord("tickets", "outbound", 1, 0);
    console.log(`[GHL Sync] Ticket ${ticketId} synced to GHL as task`);
    return { success: true };
  } catch (err: any) {
    if (isGhlSyncDeferred(err?.message)) {
      await recordGhlSyncDeferred("tickets", err.message);
      return { success: false, error: `GHL_SYNC_DEFERRED_BLOCKED:${err.message.match(/GHL_CRM_[A-Z_]+|control_disabled|permissions_disabled|native_review_[a-z_]+|operation_not_reviewed|epoch_or_review_changed/i)?.[0] ?? "POLICY"}` };
    }
    console.error(`[GHL Sync] Failed to sync ticket ${ticketId}:`, err.message);
    await updateSyncStatusRecord("tickets", "outbound", 0, 1, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncNoteToGhl(noteId: number): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isGhlConfigured()) return { success: false, error: "GHL not configured" };

    const noteRow = await storage.getNote(noteId);
    if (!noteRow) return { success: false, error: "Note not found" };

    const entityType = noteRow.entityType;
    const entityId = noteRow.entityId;
    const content = noteRow.content;

    let ghlContactId: string | undefined;
    if (entityType === "contact") {
      const contact = await storage.getContact(entityId);
      ghlContactId = contact?.ghlContactId || undefined;
      if (contact && !ghlContactId) {
        const syncResult = await syncContactToGhl(contact.id);
        ghlContactId = syncResult.ghlContactId;
      }
    } else if (entityType === "deal") {
      const deal = await storage.getDeal(entityId);
      if (deal?.contactId) {
        const contact = await storage.getContact(deal.contactId);
        ghlContactId = contact?.ghlContactId || undefined;
      }
    }

    if (!ghlContactId) return { success: false, error: "No GHL contact linked to note entity" };

    await ghlFetch(`/contacts/${ghlContactId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: content }),
    });

    await updateSyncStatusRecord("notes", "outbound", 1, 0);
    console.log(`[GHL Sync] Note ${noteId} synced to GHL`);
    return { success: true };
  } catch (err: any) {
    console.error(`[GHL Sync] Failed to sync note ${noteId}:`, err.message);
    await updateSyncStatusRecord("notes", "outbound", 0, 1, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncTaskFromGhl(ghlTask: any, ghlContactId: string): Promise<{ success: boolean; taskId?: number; error?: string }> {
  // Wave B1: GHL CRM decoupling guard
  const { checkGhlCrmSyncAllowed, logGhlShadowIntent } = await import("./ghl-crm-sync-guard");
  const guard = checkGhlCrmSyncAllowed("syncTaskFromGhl", { success: true });
  if (guard.blocked) return { success: true };
  if (guard.shadowMode) {
    await logGhlShadowIntent("syncTaskFromGhl", {
      entityType: "task",
      ghlId: ghlTask.id ?? null,
      rawPayload: { title: ghlTask.title, completed: ghlTask.completed, dueDate: ghlTask.dueDate, ghlContactId },
    });
    return { success: true };
  }

  try {
    // Indexed lookup — contacts_ghl_contact_id_unique index; never scans all rows.
    const contact = ghlContactId ? await storage.getContactByGhlContactId(ghlContactId) : undefined;
    if (!contact) return { success: false, error: "Contact not found for GHL contact" };

    if (typeof ghlTask.id !== "string" || !ghlTask.id.trim()) return { success:false,error:"Native task identity unavailable; management review required" };
    if (typeof ghlTask.completed !== "boolean") return { success:false,error:"Native task completion fact unavailable" };
    if ((ghlTask.title !== undefined && typeof ghlTask.title !== "string") ||
      (ghlTask.body !== undefined && typeof ghlTask.body !== "string")) return { success:false,error:"Native task text facts unavailable" };
    const dueDate = ghlTask.dueDate ? new Date(ghlTask.dueDate) : null;
    if (dueDate && Number.isNaN(dueDate.getTime())) return { success:false,error:"Native task due date unavailable" };
    const snapshot = { id:ghlTask.id, ghlContactId, title:ghlTask.title || "Task from GHL",
      body:ghlTask.body ?? "", completed:ghlTask.completed, dueDate:dueDate?.toISOString() ?? null,
      occurrence:ghlTask.dateUpdated ?? ghlTask.updatedAt ?? null };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const newTask = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl-task:${contact.id}:${ghlTask.id}`},0))`);
      const [parent] = await tx.select().from(contacts).where(and(eq(contacts.id,contact.id),isNull(contacts.archivedAt))).for("share");
      if (!parent || !["production","test","demo"].includes(parent.recordClass)) throw new WorkCommandError("Task contact unavailable",404);
      const matches = await tx.select().from(tasks).where(and(eq(tasks.contactId,contact.id),eq(tasks.ghlTaskId,ghlTask.id))).limit(2);
      if (matches.length > 1) throw new WorkCommandError("Native task identity ambiguous; management review required",409);
      const existing = matches[0];
      if (existing) {
        const [last] = await tx.select({payload:taskAuthorityEvents.payload}).from(taskAuthorityEvents)
          .where(and(eq(taskAuthorityEvents.taskId,existing.id),eq(taskAuthorityEvents.producer,"ghl_incoming")))
          .orderBy(desc(taskAuthorityEvents.createdAt),desc(taskAuthorityEvents.id)).limit(1);
        const context = (last?.payload as any)?.context ?? (last?.payload as any)?.commandSnapshot?.context;
        if (context?.fingerprint === fingerprint) return existing;
        const result = await commandProducedTask({ id:existing.id, producer:"ghl_incoming",
          commandId:`ghl-incoming:${contact.id}:${ghlTask.id}:${fingerprint}`, recordClass:parent.recordClass as "production"|"test"|"demo",
          updates:{ title:snapshot.title,description:snapshot.body,status:snapshot.completed?"completed":"pending",dueDate },
          context:{...snapshot,fingerprint}, eligible:async (_tx,row) => row.contactId===parent.id && row.ghlTaskId===snapshot.id,
        },tx);
        return result.results[0].item;
      }
      return storage.createAuthorityTask({ title:snapshot.title,contactId:parent.id,ghlTaskId:ghlTask.id,
        status:snapshot.completed?"completed":"pending",priority:"medium",dueDate,description:snapshot.body,assignedTo:null,source:"ghl_incoming",
      },{producer:"ghl_incoming",issueKey:ghlTask.id,subjectType:"contact",subjectId:parent.id,
        commandKey:`ghl-incoming-create:${parent.id}:${ghlTask.id}`,context:{...snapshot,fingerprint,assignmentReview:"provider_assignee_not_resolved"}},tx);
    });
    await updateSyncStatusRecord("tasks", "inbound", 1, 0);
    return { success: true, taskId: newTask.id };
  } catch (err: any) {
    console.error("[GHL Sync] Failed to sync task from GHL:", err.message);
    await updateSyncStatusRecord("tasks", "inbound", 0, 1, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncCompanyFromGhl(ghlCompany: any): Promise<{ success: boolean; companyId?: number; error?: string }> {
  // Wave B1: GHL CRM decoupling guard
  const { checkGhlCrmSyncAllowed, logGhlShadowIntent } = await import("./ghl-crm-sync-guard");
  const guard = checkGhlCrmSyncAllowed("syncCompanyFromGhl", { success: true });
  if (guard.blocked) return { success: true };
  if (guard.shadowMode) {
    await logGhlShadowIntent("syncCompanyFromGhl", {
      entityType: "company",
      ghlId: ghlCompany.id ?? null,
      rawPayload: { name: ghlCompany.name, website: ghlCompany.website, address: ghlCompany.address },
    });
    return { success: true };
  }

  try {
    const companies = await storage.getCompanies();
    const existing = companies.find(c =>
      c.legalName?.toLowerCase() === (ghlCompany.name || "").toLowerCase()
    );

    if (existing) {
      await updateSyncStatusRecord("companies", "inbound", 1, 0);
      return { success: true, companyId: existing.id };
    }

    const newCompany = await storage.createCompany({
      legalName: ghlCompany.name || "Unknown Company",
      dba: ghlCompany.dba || ghlCompany.name || "",
      website: ghlCompany.website || "",
      address: ghlCompany.address || "",
    });

    await updateSyncStatusRecord("companies", "inbound", 1, 0);
    return { success: true, companyId: newCompany.id };
  } catch (err: any) {
    console.error("[GHL Sync] Failed to sync company from GHL:", err.message);
    await updateSyncStatusRecord("companies", "inbound", 0, 1, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncTagsToGhl(contactId: number): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isGhlConfigured()) return { success: false, error: "GHL not configured" };

    const contact = await storage.getContact(contactId);
    if (!contact) return { success: false, error: "Contact not found" };

    let ghlContactId = contact.ghlContactId;
    if (!ghlContactId) {
      const syncResult = await syncContactToGhl(contactId);
      ghlContactId = syncResult.ghlContactId ?? null;
    }
    if (!ghlContactId) return { success: false, error: "No GHL contact linked" };

    const tags = contact.tags || [];
    if (tags.length === 0) return { success: true };

    await ghlFetch(`/contacts/${ghlContactId}`, {
      method: "PUT",
      body: JSON.stringify({ tags }),
    });

    await updateSyncStatusRecord("tags", "outbound", 1, 0);
    console.log(`[GHL Sync] Tags synced for contact ${contactId}: ${tags.join(", ")}`);
    return { success: true };
  } catch (err: any) {
    console.error(`[GHL Sync] Failed to sync tags for contact ${contactId}:`, err.message);
    await updateSyncStatusRecord("tags", "outbound", 0, 1, err.message);
    await auditChange({
      entityType: "ghl_sync",
      entityId: contactId,
      action: "ghl_tag_sync_failed",
      actorType: "system",
      details: { error: err.message },
    }).catch(() => {});
    return { success: false, error: err.message };
  }
}

export async function syncTagsFromGhl(ghlContactId: string, tags: string[]): Promise<{ success: boolean; error?: string }> {
  // Wave B1: GHL CRM decoupling guard
  const { checkGhlCrmSyncAllowed, logGhlShadowIntent } = await import("./ghl-crm-sync-guard");
  const guard = checkGhlCrmSyncAllowed("syncTagsFromGhl", { success: true });
  if (guard.blocked) return { success: true };
  if (guard.shadowMode) {
    const contact = await storage.getContactByGhlContactId(ghlContactId).catch(() => null);
    const newTags = tags.filter(t => !(contact?.tags || []).includes(t));
    if (newTags.length > 0) {
      await logGhlShadowIntent("syncTagsFromGhl", {
        entityType: "tags",
        entityId: contact?.id ?? null,
        ghlId: ghlContactId,
        fieldDiffs: { tags: { current: contact?.tags ?? [], ghl: tags } },
      });
    }
    return { success: true };
  }

  try {
    // Indexed lookup — contacts_ghl_contact_id_unique index; never scans all rows.
    const contact = await storage.getContactByGhlContactId(ghlContactId);
    if (!contact) return { success: false, error: "Contact not found" };

    const mergedTags = [...new Set([...(contact.tags || []), ...tags])];
    await storage.updateContact(contact.id, { tags: mergedTags });

    await updateSyncStatusRecord("tags", "inbound", 1, 0);
    return { success: true };
  } catch (err: any) {
    console.error("[GHL Sync] Failed to sync tags from GHL:", err.message);
    await updateSyncStatusRecord("tags", "inbound", 0, 1, err.message);
    await auditChange({
      entityType: "ghl_sync",
      action: "ghl_tag_inbound_failed",
      actorType: "system",
      details: { error: err.message },
    }).catch(() => {});
    return { success: false, error: err.message };
  }
}

export async function removeTagsFromLocal(ghlContactId: string, tags: string[]): Promise<{ success: boolean; error?: string }> {
  try {
    // Indexed lookup — contacts_ghl_contact_id_unique index; never scans all rows.
    const contact = await storage.getContactByGhlContactId(ghlContactId);
    if (!contact) return { success: false, error: "Contact not found" };

    const filteredTags = (contact.tags || []).filter(t => !tags.includes(t));
    await storage.updateContact(contact.id, { tags: filteredTags });

    await updateSyncStatusRecord("tags", "inbound", 1, 0);
    return { success: true };
  } catch (err: any) {
    console.error("[GHL Sync] Failed to remove tags from local:", err.message);
    return { success: false, error: err.message };
  }
}

/** Typed fence/ambiguity errors must reach the projection executor; they are never a component failure. */
function isProjectionBoundaryError(err: any): boolean {
  return err?.code === "GHL_PROJECTION_FENCE_LOST" || err instanceof GhlAmbiguousDispatchError || err instanceof GhlSyncDeferredError;
}

const ACTIVE_PIPELINE_TAG = "LB-ACTIVE-PIPELINE";
const PARENT_ACCOUNT_TAG = "lb_parent_account";

/**
 * Parent/location fields and the two CRM-owned tags as ONE component, written only after identity, suppression and
 * permission components.
 *
 * Tags are never replaced. GHL-native tags (outreach.paused, outreach.replied, outbound-merchant-enrolled, opt-out and
 * bounce tags, source tags...) are owned by GHL and its workflows; the CRM owns exactly LB-ACTIVE-PIPELINE and
 * lb_parent_account. The component therefore sends only owned-tag deltas through the add-tags and remove-tags
 * endpoints, which cannot touch any other tag, and only when the CRM's last known state of an owned tag differs from
 * what the CRM wants. The local copy of an owned tag changes only after the provider accepted that delta, so a failed
 * write is retried (idempotently) instead of being masked.
 *
 * A reviewed-operation refusal or a provider rejection of the tag endpoints yields a held outcome (reported, never
 * retried forever and never blocking identity/permission storage); transient failures stay retryable failures. Fields
 * the provider has not installed are held (and reported), never auto-created.
 */
export function computeOwnedTagDelta(currentTags: readonly string[], wantActive: boolean, wantParent: boolean): { add: string[]; remove: string[] } {
  const add: string[] = []; const remove: string[] = [];
  for (const [tag, wanted] of [[ACTIVE_PIPELINE_TAG, wantActive], [PARENT_ACCOUNT_TAG, wantParent]] as const) {
    const present = currentTags.includes(tag);
    if (wanted && !present) add.push(tag);
    else if (!wanted && present) remove.push(tag);
  }
  return { add, remove };
}

export async function applyTagsAndParentComponent(contact: Contact, ghlContactId: string): Promise<GhlComponentOutcome> {
  try {
    const deals = await storage.getDealsByContact(contact.id);
    const hasActiveDeal = deals.some(d => (ACTIVE_DEAL_STAGES as readonly string[]).includes(d.stage));
    const currentTags: string[] = contact.tags || [];
    const delta = computeOwnedTagDelta(currentTags, hasActiveDeal, !!contact.isParentAccount);

    const wanted: Array<{ key: string; field_value: string; meaningful: boolean }> = [];
    if (hasActiveDeal !== currentTags.includes(ACTIVE_PIPELINE_TAG)) {
      wanted.push({ key: "lb_do_not_sdr", field_value: hasActiveDeal ? "true" : "false", meaningful: true });
    }
    if (contact.parentContactId) {
      const parent = await storage.getContact(contact.parentContactId);
      if (parent) {
        const parentName = parent.companyName || `${parent.firstName} ${parent.lastName}`.trim();
        wanted.push({ key: "lb_location_of", field_value: parentName, meaningful: true });
      }
    } else {
      wanted.push({ key: "lb_location_of", field_value: "", meaningful: false });
    }
    const { getGhlCustomFieldInventory } = await import("./ghl");
    const installedKeys = new Set((await getGhlCustomFieldInventory()).map(field => field.key));
    const customFields = wanted.filter(field => installedKeys.has(field.key)).map(({ key, field_value }) => ({ key, field_value }));
    const heldKeys = wanted.filter(field => !installedKeys.has(field.key) && field.meaningful).map(field => field.key);

    if (customFields.length > 0) {
      await ghlFetch(`/contacts/${ghlContactId}`, { method: "PUT", body: JSON.stringify({ customFields }) });
    }

    const tagState: { held: string | null } = { held: null };
    let localTags = [...currentTags];
    const tagCall = async (method: "POST" | "DELETE", tags: string[]) => {
      if (tags.length === 0 || tagState.held) return;
      try {
        await ghlFetch(`/contacts/${ghlContactId}/tags`, { method, body: JSON.stringify({ tags }) });
      } catch (err: any) {
        const message = String(err?.message || "");
        // A refusal because the tag-delta operation is not in the approved native review is a held component,
        // whichever error class carried it; every other boundary error still aborts the projection.
        if (/operation_not_reviewed/.test(message)) { tagState.held = "tags:operation_not_reviewed"; return; }
        if (isProjectionBoundaryError(err)) throw err;
        const status = message.match(/GHL API error (\d+)/)?.[1];
        if (status && ["400", "403", "404", "422"].includes(status)) { tagState.held = `tags:provider_rejected_${status}`; return; }
        throw err;
      }
      localTags = method === "POST"
        ? Array.from(new Set([...localTags, ...tags]))
        : localTags.filter(tag => !tags.includes(tag));
      await storage.syncUpdateContact(contact.id, { tags: localTags });
    };
    await tagCall("POST", delta.add);
    await tagCall("DELETE", delta.remove);

    const allHeld = tagState.held ? [...heldKeys, tagState.held] : heldKeys;
    return { state: allHeld.length > 0 ? "held" : "ok", heldKeys: allHeld };
  } catch (err: any) {
    if (isGhlSyncDeferred(err?.message)) throw new GhlSyncDeferredError(err.message);
    if (isProjectionBoundaryError(err)) throw err;
    const status = String(err?.message || "").match(/GHL API error (\d+)/)?.[1] || "unknown";
    console.warn(`[GHL Sync] Tags/parent component failed for contact ${contact.id} (${status}):`, String(err?.message || "").slice(0, 200));
    return { state: "failed", code: `HTTP_${status}` };
  }
}

/** Legacy export: parent/location tags alone. Delegates to the one component so the rules cannot diverge. */
export async function applyParentLocationTags(contact: Contact, ghlContactId?: string): Promise<void> {
  const id = ghlContactId || contact.ghlContactId || undefined;
  if (!id) return;
  const outcome = await applyTagsAndParentComponent(contact, id);
  if (outcome.state === "failed") throw new Error(`GHL_COMPONENT_FAILED:tags:${outcome.code ?? "failed"}`);
}

/** Deal-sync entry point: the same component. Failures are logged by the caller's sync status, never masked locally. */
export async function checkAndApplyActivePipelineTag(contact: Contact, ghlContactId?: string): Promise<void> {
  const id = ghlContactId || contact.ghlContactId || undefined;
  if (!id) return;
  const outcome = await applyTagsAndParentComponent(contact, id);
  if (outcome.state === "failed") {
    console.error(`[GHL Sync] Active-pipeline tag not applied for contact ${contact.id} (${outcome.code}); local tags unchanged so it retries`);
  }
}

export async function syncActivityFromGhl(payload: {
  contactId: string;
  type: string;
  channel: string;
  body?: string;
  subject?: string;
  messageId?: string;
  direction?: string;
}): Promise<void> {
  try {
    // Indexed lookup — contacts_ghl_contact_id_unique index; never scans all rows.
    const contact = payload.contactId ? await storage.getContactByGhlContactId(payload.contactId) : undefined;
    if (!contact) return;

    // Indexed lookup by contactId — deals_contact_id_idx; avoids scanning all deals.
    const contactDeals = await storage.getDealsByContact(contact.id);
    const contactDeal = contactDeals[0];

    await storage.createGhlActivityLog({
      contactId: contact.id,
      dealId: contactDeal?.id || null,
      direction: payload.direction || "inbound",
      channel: payload.channel || "email",
      templateId: null,
      subject: payload.subject || null,
      body: payload.body || null,
      status: "received",
      ghlMessageId: payload.messageId || null,
      metadata: { source: "ghl_webhook", type: payload.type },
    });

    await updateSyncStatusRecord("activity", "inbound", 1, 0);
  } catch (err: any) {
    console.error("[GHL Sync] Failed to sync activity from GHL:", err.message);
    await updateSyncStatusRecord("activity", "inbound", 0, 1, err.message);
  }
}

export async function getGhlSyncStatus() {
  const contactStats = await storage.getContactAggregateStats();
  const lastSyncTo = await storage.getSystemSetting("ghl_last_sync_to");
  const lastSyncFrom = await storage.getSystemSetting("ghl_last_sync_from");

  let entitySyncStatuses: any[] = [];
  try {
    const rows = await db.select().from(ghlSyncStatus);
    entitySyncStatuses = rows;
  } catch {
    entitySyncStatuses = [];
  }

  return {
    configured: isGhlConfigured(),
    totalContacts: contactStats.total,
    syncedToGhl: contactStats.syncedToGhl,
    unsyncedToGhl: contactStats.total - contactStats.syncedToGhl,
    lastSyncTo,
    lastSyncFrom,
    entitySyncStatuses,
  };
}

export async function getFullSyncDashboard() {
  const baseStatus = await getGhlSyncStatus();

  const dealStats = await storage.getDealAggregateStats();

  let entityStatuses: Record<string, any> = {};
  try {
    const rows = await db.select().from(ghlSyncStatus);
    for (const row of rows) {
      entityStatuses[row.entityType] = {
        lastSyncAt: row.lastSyncAt,
        lastSyncDirection: row.lastSyncDirection,
        syncedCount: row.syncedCount,
        errorCount: row.errorCount,
        lastError: row.lastError,
      };
    }
  } catch {
    entityStatuses = {};
  }

  if (!entityStatuses["contacts"]) entityStatuses["contacts"] = {};
  entityStatuses["contacts"].localCount = baseStatus.totalContacts;
  entityStatuses["contacts"].ghlSyncedCount = baseStatus.syncedToGhl;

  if (!entityStatuses["deals"]) entityStatuses["deals"] = {};
  entityStatuses["deals"].localCount = dealStats.total;

  // ── Wave 7: Expanded Sync Authority metrics ────────────────────────────────
  const circuitStatus = getGhlCircuitStatus();

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Audit log based metrics
  let failedSyncsLast24h: number | null = null;
  let optOutEventsLast24h: number | null = null;
  let lastCircuitTripAt: string | null = null;
  try {
    const auditLogs = await storage.getAuditLogs();
    const recent = auditLogs.filter(l => l.createdAt && new Date(l.createdAt) >= twentyFourHoursAgo);
    const failedCount = recent.filter(l => l.action === "ghl_sync_error" || l.action === "ghl_sync_failed").length;
    const optOutCount = recent.filter(l =>
      l.action === "contact_unsubscribed" ||
      l.action === "contact_dnd_set"
    ).length;
    failedSyncsLast24h = failedCount;
    optOutEventsLast24h = optOutCount;
    const circuitTrip = auditLogs.find(l => l.action === "GHL_CIRCUIT_OPEN");
    lastCircuitTripAt = circuitTrip?.createdAt ? new Date(circuitTrip.createdAt).toISOString() : null;
  } catch { /* non-fatal */ }

  // GHL activity log based metrics — use global query (no contactId filter)
  let webhookEventsLast24h: number | null = null;
  let permissionCheckCallsLast24h: number | null = null;
  // null = the read failed (rendered "Unknown"); never a silent zero.
  let fieldWriteErrors422: number | null = null;
  let emailValidation422Count: number | null = null;
  let unclassified422Count: number | null = null;
  let missingGhlContactId: number | null = null;
  let recent422Errors: Array<{ contactId: number | null; operation: string | null; httpStatus: number | null; createdAt: string | null; kind: "field_write" | "email_validation" | "unclassified" }> = [];
  try {
    // Exact count over every contact (the previous first-5000 sample under-reported on a larger book).
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM contacts WHERE ghl_contact_id IS NULL AND COALESCE(btrim(email), '') <> ''`);
    missingGhlContactId = Number(((r as any).rows ?? r)[0]?.n ?? NaN);
    if (!Number.isFinite(missingGhlContactId)) missingGhlContactId = null;
  } catch { missingGhlContactId = null; }
  try {
    // Full-scope global query — getGhlActivityLogs() with no contactId returns all logs
    const allActivityLogs = await storage.getGhlActivityLogs();
    let fieldWrite = 0, emailValidation = 0, unclassified = 0, webhooks = 0, permChecks = 0;
    for (const log of allActivityLogs) {
      if (!log.createdAt || new Date(log.createdAt) < twentyFourHoursAgo) continue;
      if (log.direction === "inbound") webhooks++;
      if (log.channel === "permission_check") permChecks++;
      if (log.channel === "sync_error") {
        const meta = log.metadata as any;
        if (meta?.httpStatus === 422 || meta?.httpStatus === "422") {
          // A 422 is only a custom-field gap when the provider body names a custom field. Email-validation 422s are
          // data-quality rejections of one record and must not raise the permission-field alert.
          const body = String(meta?.errorBody ?? "");
          const kind: "field_write" | "email_validation" | "unclassified" =
            isGhlEmailValidation422(`GHL API error 422: ${body}`) ? "email_validation"
            : /custom ?field|\blb_[a-z_]+|customFields/i.test(body) ? "field_write"
            : "unclassified";
          if (kind === "field_write") fieldWrite++; else if (kind === "email_validation") emailValidation++; else unclassified++;
          if (recent422Errors.length < 10) {
            recent422Errors.push({
              contactId: log.contactId ?? null,
              operation: meta?.operation ?? null,
              httpStatus: meta?.httpStatus ? Number(meta.httpStatus) : 422,
              createdAt: log.createdAt ? new Date(log.createdAt).toISOString() : null,
              kind,
            });
          }
        }
      }
    }
    webhookEventsLast24h = webhooks; permissionCheckCallsLast24h = permChecks;
    fieldWriteErrors422 = fieldWrite; emailValidation422Count = emailValidation; unclassified422Count = unclassified;
  } catch { /* leaves the 422 counters null (unavailable) */ }

  const hasPermissionFieldGap = fieldWriteErrors422 === null ? null : fieldWriteErrors422 > 0;

  return {
    ...baseStatus,
    totalDeals: dealStats.total,
    entityStatuses,
    // Wave 7 authority fields
    circuitState: {
      open: circuitStatus.circuitOpen,
      consecutiveFailures: circuitStatus.consecutiveFailures,
      threshold: circuitStatus.threshold,
      lastTripAt: lastCircuitTripAt,
    },
    failedSyncsLast24h,
    missingGhlContactId,
    fieldWriteErrors422,
    emailValidation422Count,
    unclassified422Count,
    recent422Errors,
    webhookEventsLast24h,
    permissionCheckCallsLast24h,
    optOutEventsLast24h,
    hasPermissionFieldGap,
  };
}

const syncedCompanyIds = new Set<number>();
const syncedTaskIds = new Set<number>();

const GHL_CIRCUIT_THRESHOLD = 5;
const GHL_HALF_OPEN_PROBES_REQUIRED = 3;
const GHL_ROLLING_UNHEALTHY_MS = 60 * 60 * 1000; // 60 min without a successful full tick → force half-open probe

export type GhlCircuitStateEnum = "closed" | "open" | "half-open";
let ghlCircuitState: GhlCircuitStateEnum = "closed";
let consecutiveGhlFailures = 0;
let halfOpenProbeSuccesses = 0;
let lastFullSuccessTickAt = Date.now();
// Deterministic half-open probe cursor: id of the last examined unsynced
// contact. Ensures one permanently-skipping contact (e.g. an identity
// conflict at the lowest id) cannot starve recovery. Reset to 0 whenever the
// circuit closes or is manually reset.
let halfOpenProbeCursorId = 0;
const PROBE_PAGE_SIZE = 10;

export type GhlSyncErrorClass = "auth" | "rate-limit" | "skip" | "retryable";

/** A policy denial that leaves the entity eligible for a later authorized tick. */
export class GhlSyncDeferredError extends Error {
  readonly code = "GHL_SYNC_DEFERRED_BLOCKED";
  constructor(reason?: string) {
    super(reason ? `GHL_SYNC_DEFERRED_BLOCKED:${reason}` : "GHL_SYNC_DEFERRED_BLOCKED");
    this.name = "GhlSyncDeferredError";
  }
}

function isGhlSyncDeferred(error: string | undefined): boolean {
  return !!error && /GHL_SYNC_DEFERRED_BLOCKED|GHL_CRM_(?:OPERATION_)?(?:BLOCKED|DEFERRED)|GHL CRM (?:operation|mutation) blocked|blocked by (?:GHL )?CRM (?:control|authorization)/i.test(error);
}

/**
 * Single classification dispatch for GHL sync error strings.  ALL circuit-
 * breaker counting decisions in runGhlFullSyncTick flow through this table.
 *
 * - "auth"       → 401 / unauthorized: opens the circuit IMMEDIATELY.
 * - "rate-limit" → 429: counts toward the threshold (retryable pressure).
 * - "skip"       → data-dependency misses (local record not found, GHL not
 *                  configured, GHL 400 not-found on stale/fake IDs, identity
 *                  conflicts, stage-map config errors): never counted.
 * - "retryable"  → everything else: counts toward the threshold.
 */
export function classifyGhlSyncError(error: string | undefined, httpStatus?: number): GhlSyncErrorClass {
  if (httpStatus === 401) return "auth";
  if (httpStatus === 429) return "rate-limit";
  if (!error) return "retryable";
  if (/GHL API error 401/i.test(error) || /\bunauthorized\b/i.test(error)) return "auth";
  if (/GHL API error 429/i.test(error) || /rate.?limit/i.test(error)) return "rate-limit";
  if (error === "ghl_identity_conflict") return "skip";
  if (/^(?:PIPELINE_LOCAL_ONLY|EXPORT_NOT_ELIGIBLE)/.test(error)) return "skip";
  if (error === GHL_NO_USABLE_IDENTITY) return "skip";
  if (error === GHL_EMAIL_VALIDATION_REJECTED) return "skip";
  // GHL 422 field-validation on email — permanent data-quality issue with one
  // record, not a provider outage. Unknown 422 bodies stay "retryable".
  if (isGhlEmailValidation422(error)) return "skip";
  if (error === "GHL not configured") return "skip";
  // Pause-authority blocks are deliberate policy denials, not provider
  // failures — they must never count toward the circuit-breaker threshold.
  if (/blocked by pause authority/i.test(error)) return "skip";
  if (isGhlSyncDeferred(error)) return "skip";
  if (/^No GHL contact linked/i.test(error)) return "skip";
  if (/OPPORTUNITY_STAGE_ID_INVALID|GHL_SEMANTIC_(?:STAGE_MAPPING|LOCAL_STAGE)/.test(error)) return "skip";
  // Local DB misses: "Contact not found", "Deal not found", "Task not found", "Company not found"
  if (/^[A-Za-z ]*not found$/i.test(error.trim())) return "skip";
  if (isGhlNotFoundError(error)) return "skip";
  return "retryable";
}

/**
 * Returns true when the error string represents a GHL 400 "not found" response
 * (e.g. a fake/stale GHL ID that doesn't exist in GHL).  These are data-skip
 * errors — not transient API failures — and must NOT count toward the circuit-
 * breaker threshold.  Typical source: smoke-test records left in the DB with
 * fake ghlContactId / ghlOpportunityId values.
 */
function isGhlNotFoundError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return /GHL API error 400/i.test(errorMessage) && /not.?found/i.test(errorMessage);
}

/** Open the circuit immediately on a 401/auth classification. */
function tripCircuitAuth(phase: string): void {
  ghlCircuitState = "open";
  consecutiveGhlFailures = Math.max(consecutiveGhlFailures, GHL_CIRCUIT_THRESHOLD);
  halfOpenProbeSuccesses = 0;
  console.error(`[Queue:ghl-sync] GHL_CIRCUIT_OPEN_AUTH — auth (401) failure in ${phase}, opening circuit immediately`);
  storage.createAuditLog({ action: "GHL_CIRCUIT_OPEN_AUTH", entityType: "system", details: `Circuit opened immediately: GHL auth (401) failure in ${phase}` }).catch(() => {});
  maybeSendCircuitAlert();
  persistGhlCircuit();
}

/** Open the circuit because the consecutive-failure threshold was reached. */
function tripCircuitThreshold(phase: string): void {
  ghlCircuitState = "open";
  halfOpenProbeSuccesses = 0;
  console.error(`[Queue:ghl-sync] GHL_CIRCUIT_OPEN — ${consecutiveGhlFailures} consecutive failures in ${phase}, aborting tick`);
  storage.createAuditLog({ action: "GHL_CIRCUIT_OPEN", entityType: "system", details: `Circuit opened: ${consecutiveGhlFailures} consecutive GHL failures in ${phase} — tick aborted` }).catch(() => {});
  maybeSendCircuitAlert();
  persistGhlCircuit();
}

/** Close the circuit after the required number of half-open probe successes. */
function closeCircuitAfterProbes(): void {
  const probes = halfOpenProbeSuccesses;
  ghlCircuitState = "closed";
  consecutiveGhlFailures = 0;
  halfOpenProbeSuccesses = 0;
  halfOpenProbeCursorId = 0;
  lastFullSuccessTickAt = Date.now();
  console.log(`[Queue:ghl-sync] GHL_CIRCUIT_CLOSED — circuit recovered after ${probes} successful probes`);
  storage.createAuditLog({ action: "GHL_CIRCUIT_CLOSED", entityType: "system", details: `Circuit closed: ${probes} consecutive successful half-open probes` }).catch(() => {});
  maybeSendCircuitRecoveryAlert(probes);
  persistGhlCircuit();
}
let lastCircuitAlertAt = 0;
const GHL_CIRCUIT_ALERT_KEY = "ghl_circuit_alert_at";
let lastCircuitRecoveryAlertAt = 0;
const GHL_CIRCUIT_RECOVERY_ALERT_KEY = "ghl_circuit_recovery_alert_at";

/**
 * Recovery (half-open → closed) notification with its own 1-hour cooldown,
 * persisted under GHL_CIRCUIT_RECOVERY_ALERT_KEY so restarts don't re-fire.
 */
function maybeSendCircuitRecoveryAlert(probeSuccesses: number): void {
  const now = Date.now();
  if (now - lastCircuitRecoveryAlertAt < 60 * 60 * 1000) return;
  lastCircuitRecoveryAlertAt = now;
  const alertAt = new Date().toISOString();
  db.insert(systemSettings)
    .values({ key: GHL_CIRCUIT_RECOVERY_ALERT_KEY, value: { at: alertAt } })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: { at: alertAt } } })
    .catch(() => {});
  import("./system-audit/slack-notifier").then(({ sendCriticalAlert }) => {
    sendCriticalAlert({
      subsystem: "ghl-auth",
      status: "ok",
      summary: `GHL sync circuit breaker recovered after ${probeSuccesses} successful probes.`,
      details: { probeSuccesses, probesRequired: GHL_HALF_OPEN_PROBES_REQUIRED },
    }).catch(() => {});
  }).catch(() => {});
  import("./smtp-email").then(({ sendSmtpEmail, isSmtpConfigured }) => {
    if (!isSmtpConfigured()) return;
    const adminEmail = process.env.ADMIN_ALERT_EMAIL || "accounts@libertybancard.com";
    const subject = "✅ GHL Sync Circuit Breaker RECOVERED";
    const html = `
      <h2 style="color:#27ae60;">GHL Sync Circuit Breaker CLOSED</h2>
      <p>The GHL sync circuit breaker recovered at <strong>${alertAt}</strong> after <strong>${probeSuccesses} successful probes</strong>.</p>
      <p>Full sync has resumed automatically.</p>
      <p style="color:#7f8c8d;font-size:12px;">This alert has a 1-hour cooldown to prevent spam.</p>
    `;
    sendSmtpEmail({ to: adminEmail, subject, html, category: "internal_ops" }).catch(() => {});
  }).catch(() => {});
}

// ── Circuit-breaker persistence (survives process restarts) ─────────────────
const GHL_CIRCUIT_STATE_KEY = "ghl_circuit_state";
let circuitStateRestored = false;

/** Fire-and-forget upsert of current circuit state to system_settings. */
function persistGhlCircuit(): void {
  // systemSettings.value is jsonb — store the object directly, no JSON.stringify.
  const value = {
    state: ghlCircuitState,
    open: ghlCircuitState === "open", // legacy alias for older readers
    consecutiveFailures: consecutiveGhlFailures,
    halfOpenProbeSuccesses,
    halfOpenProbeCursorId,
    lastFullSuccessTickAt,
    updatedAt: new Date().toISOString(),
  };
  db.insert(systemSettings)
    .values({ key: GHL_CIRCUIT_STATE_KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value } })
    .catch((err: Error) => console.error("[GHL Circuit] State persistence failed:", err.message));
}

/**
 * Restore circuit state saved by a previous process.  Runs at most once per
 * process lifetime so the very first tick knows whether GHL was unhealthy at
 * shutdown.  The restored state is authoritative — the tick does NOT reset it.
 */
async function restoreGhlCircuit(): Promise<void> {
  if (circuitStateRestored) return;
  circuitStateRestored = true;
  try {
    const rows = await db.select().from(systemSettings).where(
      sql`key IN (${GHL_CIRCUIT_STATE_KEY}, ${GHL_CIRCUIT_ALERT_KEY}, ${GHL_CIRCUIT_RECOVERY_ALERT_KEY})`
    );
    for (const row of rows) {
      if (row.key === GHL_CIRCUIT_STATE_KEY && row.value) {
        const saved = row.value as {
          state?: GhlCircuitStateEnum;
          open?: boolean;
          consecutiveFailures?: number;
          halfOpenProbeSuccesses?: number;
          halfOpenProbeCursorId?: number;
          lastFullSuccessTickAt?: number;
        };
        ghlCircuitState = saved.state ?? (saved.open ? "open" : "closed");
        consecutiveGhlFailures = saved.consecutiveFailures ?? (saved.open ? GHL_CIRCUIT_THRESHOLD : 0);
        halfOpenProbeSuccesses = saved.halfOpenProbeSuccesses ?? 0;
        halfOpenProbeCursorId = saved.halfOpenProbeCursorId ?? 0;
        if (typeof saved.lastFullSuccessTickAt === "number") {
          lastFullSuccessTickAt = saved.lastFullSuccessTickAt;
        }
        if (ghlCircuitState !== "closed") {
          console.log(`[GHL Sync] Restored circuit state from DB — state=${ghlCircuitState}, failures=${consecutiveGhlFailures}, probeSuccesses=${halfOpenProbeSuccesses}`);
        }
      }
      if (row.key === GHL_CIRCUIT_RECOVERY_ALERT_KEY && row.value) {
        const saved = row.value as { at?: string };
        if (saved.at) lastCircuitRecoveryAlertAt = new Date(saved.at).getTime();
      }
      if (row.key === GHL_CIRCUIT_ALERT_KEY && row.value) {
        // Restore alert cooldown so a restart doesn't re-fire the alert within the same hour
        const saved = row.value as { at?: string };
        if (saved.at) {
          lastCircuitAlertAt = new Date(saved.at).getTime();
          console.log(`[GHL Sync] Restored circuit alert cooldown from DB — lastCircuitAlertAt=${saved.at}`);
        }
      }
    }
  } catch {
    // Non-critical: start fresh on DB read failure
  }
}
// ────────────────────────────────────────────────────────────────────────────

function maybeSendCircuitAlert(): void {
  const now = Date.now();
  if (now - lastCircuitAlertAt < 60 * 60 * 1000) return;
  lastCircuitAlertAt = now;
  // Persist the alert timestamp so a process restart within the same hour doesn't re-fire
  const alertAt = new Date().toISOString();
  db.insert(systemSettings)
    .values({ key: GHL_CIRCUIT_ALERT_KEY, value: { at: alertAt } })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: { at: alertAt } } })
    .catch(() => {});
  const failureCount = consecutiveGhlFailures;
  const timestamp = new Date().toISOString();
  import("./system-audit/slack-notifier").then(({ sendCriticalAlert }) => {
    sendCriticalAlert({
      subsystem: "ghl-auth",
      status: "error",
      summary: `GHL circuit breaker opened — ${failureCount} consecutive API failures. Sync halted.`,
      details: { consecutiveFailures: failureCount, threshold: GHL_CIRCUIT_THRESHOLD },
    }).catch(() => {});
  }).catch(() => {});
  // Also send admin email notification
  import("./smtp-email").then(({ sendSmtpEmail, isSmtpConfigured }) => {
    if (!isSmtpConfigured()) return;
    const adminEmail = process.env.ADMIN_ALERT_EMAIL || "accounts@libertybancard.com";
    const subject = "🚨 GHL Sync Circuit Breaker OPEN";
    const html = `
      <h2 style="color:#c0392b;">GHL Sync Circuit Breaker OPEN</h2>
      <p>The GHL sync circuit breaker opened at <strong>${timestamp}</strong>.</p>
      <p><strong>${failureCount} consecutive failures</strong> reached the threshold of ${GHL_CIRCUIT_THRESHOLD}.</p>
      <p>The sync has been halted and will retry automatically on the next scheduled tick.</p>
      <hr/>
      <p><strong>Recommended actions:</strong></p>
      <ul>
        <li>Check GHL API status and connectivity.</li>
        <li>Review the audit logs for GHL_CIRCUIT_OPEN entries.</li>
        <li>If the issue is resolved, the circuit will reset automatically on the next sync tick.</li>
      </ul>
      <p style="color:#7f8c8d;font-size:12px;">This alert has a 1-hour cooldown to prevent spam.</p>
    `;
    sendSmtpEmail({ to: adminEmail, subject, html, category: "internal_ops" }).catch(() => {});
  }).catch(() => {});
}

export function getGhlCircuitState(): { open: boolean; state: GhlCircuitStateEnum; consecutiveFailures: number } {
  return { open: ghlCircuitState === "open", state: ghlCircuitState, consecutiveFailures: consecutiveGhlFailures };
}

export function startAutoSyncLoop(_intervalMs: number = 45000): void {
  // Retained only for source compatibility. GHL sync has one execution
  // mechanism (the owner-fenced BullMQ worker); never revive an interval that
  // could race that durable runtime.
  console.warn("[GHL Sync] Legacy interval fallback is disabled; use the owner-fenced BullMQ runtime.");
}

export function stopAutoSyncLoop(): void {
  // No legacy interval is started.
}

export function getGhlCircuitStatus(): {
  circuitOpen: boolean;
  circuitState: GhlCircuitStateEnum;
  consecutiveFailures: number;
  threshold: number;
} {
  return {
    // open AND half-open both count as unhealthy for consumers
    circuitOpen: ghlCircuitState !== "closed",
    circuitState: ghlCircuitState,
    consecutiveFailures: consecutiveGhlFailures,
    threshold: GHL_CIRCUIT_THRESHOLD,
  };
}

export function resetGhlCircuit(): void {
  ghlCircuitState = "closed";
  consecutiveGhlFailures = 0;
  halfOpenProbeSuccesses = 0;
  halfOpenProbeCursorId = 0;
  lastFullSuccessTickAt = Date.now();
  persistGhlCircuit(); // persist so the next process restart doesn't re-open from stale DB state
  console.log("[GHL Sync] Circuit breaker manually reset by operator — full state cleared and persisted");
}

/**
 * TEST-ONLY hooks for scripts/test-ghl-circuit-classification.ts.
 * Never call these from production code paths.
 */
export const __ghlCircuitTestHooks = {
  setState(partial: Partial<{ state: GhlCircuitStateEnum; consecutiveFailures: number; halfOpenProbeSuccesses: number; halfOpenProbeCursorId: number; lastFullSuccessTickAt: number; restored: boolean }>): void {
    if (partial.state !== undefined) ghlCircuitState = partial.state;
    if (partial.consecutiveFailures !== undefined) consecutiveGhlFailures = partial.consecutiveFailures;
    if (partial.halfOpenProbeSuccesses !== undefined) halfOpenProbeSuccesses = partial.halfOpenProbeSuccesses;
    if (partial.halfOpenProbeCursorId !== undefined) halfOpenProbeCursorId = partial.halfOpenProbeCursorId;
    if (partial.lastFullSuccessTickAt !== undefined) lastFullSuccessTickAt = partial.lastFullSuccessTickAt;
    if (partial.restored !== undefined) circuitStateRestored = partial.restored;
  },
  getState(): { state: GhlCircuitStateEnum; consecutiveFailures: number; halfOpenProbeSuccesses: number; halfOpenProbeCursorId: number; lastFullSuccessTickAt: number } {
    return { state: ghlCircuitState, consecutiveFailures: consecutiveGhlFailures, halfOpenProbeSuccesses, halfOpenProbeCursorId, lastFullSuccessTickAt };
  },
  recordFailure(errorMessage: string | undefined, phase: string): GhlSyncErrorClass {
    const kind = classifyGhlSyncError(errorMessage);
    if (kind === "auth") tripCircuitAuth(phase);
    else if (kind !== "skip") consecutiveGhlFailures++;
    if (kind !== "auth" && consecutiveGhlFailures >= GHL_CIRCUIT_THRESHOLD) tripCircuitThreshold(phase);
    return kind;
  },
  recordProbeSuccess(): void {
    halfOpenProbeSuccesses++;
    if (halfOpenProbeSuccesses >= GHL_HALF_OPEN_PROBES_REQUIRED) closeCircuitAfterProbes();
  },
  constants: {
    threshold: GHL_CIRCUIT_THRESHOLD,
    probesRequired: GHL_HALF_OPEN_PROBES_REQUIRED,
    rollingUnhealthyMs: GHL_ROLLING_UNHEALTHY_MS,
  },
};

/**
 * Half-open probe with a deterministic persisted cursor.
 *
 * Fetches a bounded page of unsynced candidates AFTER halfOpenProbeCursorId
 * and iterates them in id-ascending order:
 *  - skip     → advance within the page; never touches any circuit counter.
 *  - success  → one successful probe; cursor := candidate id; break.
 *  - auth     → trip the circuit immediately (401).
 *  - failure  → re-open the circuit immediately.
 * All-skipped page → cursor := last candidate id; remain half-open.
 * Empty page → cursor wraps to 0; remain half-open (NOT an error; the cursor
 * is simply past the end of the table). A wrap on a genuinely empty system is
 * followed next tick by an empty page at cursor 0, which counts as a healthy
 * no-op probe (prevents a permanently half-open circuit on an idle system).
 *
 * `deps` exists only for tests to stub the storage fetch and sync call.
 */
async function runCursorProbeTick(deps: {
  getCandidates?: (limit: number, afterId: number) => Promise<Array<{ id: number }>>;
  syncFn?: (contactId: number) => Promise<{ success: boolean; error?: string }>;
}): Promise<void> {
  const getCandidates = deps.getCandidates
    ?? (async (limit: number, afterId: number) => ((await db.execute(sql`
      SELECT p.contact_id AS id FROM contact_provider_projections p
      JOIN contacts c ON c.id = p.contact_id
      WHERE p.provider = 'ghl' AND p.authority_version IS NOT NULL
        AND p.state IN ('pending', 'retry')
        AND p.export_disposition IN ('current_intake', 'linked_update')
        AND c.record_class NOT IN ('test', 'demo', 'synthetic') AND c.archived_at IS NULL
        AND p.contact_id > ${afterId}
      ORDER BY p.contact_id LIMIT ${limit}`)) as any).rows.map((r: any) => ({ id: Number(r.id) })));
  const syncFn = deps.syncFn ?? syncContactToGhl;

  const probeCandidates = await getCandidates(PROBE_PAGE_SIZE, halfOpenProbeCursorId);

  if (probeCandidates.length === 0) {
    if (halfOpenProbeCursorId > 0) {
      // Cursor is past the end of the table — wrap and retry from the start
      // next tick. Do NOT treat this as an empty system or reopen the circuit.
      console.log(`[Queue:ghl-sync] Half-open probe: no candidates after cursor ${halfOpenProbeCursorId} — wrapping cursor to 0`);
      halfOpenProbeCursorId = 0;
      persistGhlCircuit();
      return;
    }
    // Nothing to sync at cursor 0 — a healthy no-op probe (prevents a
    // permanently half-open circuit on an idle system).
    console.log("[Queue:ghl-sync] Half-open probe: no unsynced contacts — counting as healthy probe");
    halfOpenProbeSuccesses++;
    if (halfOpenProbeSuccesses >= GHL_HALF_OPEN_PROBES_REQUIRED) {
      closeCircuitAfterProbes();
    } else {
      persistGhlCircuit();
    }
    return;
  }

  for (const candidate of probeCandidates) {
    let outcome: "success" | "skip" | "auth" | "failure";
    try {
      const result = await syncFn(candidate.id);
      if (result.success) {
        outcome = "success";
      } else {
        const kind = classifyGhlSyncError(result.error);
        outcome = kind === "auth" ? "auth" : kind === "skip" ? "skip" : "failure";
      }
    } catch (e: any) {
      outcome = classifyGhlSyncError(e?.message) === "auth" ? "auth" : "failure";
    }

    if (outcome === "skip") {
      // Inconclusive candidate — advance the cursor past it and move on.
      // Committing here (task #1604) ensures a later provider failure in the
      // same page cannot cause already-skipped contacts (e.g. terminal
      // invalid-identity skips) to be re-examined on every recovery attempt.
      // Never increments halfOpenProbeSuccesses or consecutiveGhlFailures.
      halfOpenProbeCursorId = candidate.id;
      persistGhlCircuit();
      console.log(`[Queue:ghl-sync] Half-open probe: contact ${candidate.id} skipped — cursor advanced to ${candidate.id}, trying next candidate`);
      continue;
    }
    if (outcome === "success") {
      halfOpenProbeSuccesses++;
      halfOpenProbeCursorId = candidate.id;
      console.log(`[Queue:ghl-sync] Half-open probe success ${halfOpenProbeSuccesses}/${GHL_HALF_OPEN_PROBES_REQUIRED} (contact ${candidate.id})`);
      if (halfOpenProbeSuccesses >= GHL_HALF_OPEN_PROBES_REQUIRED) {
        closeCircuitAfterProbes();
      } else {
        persistGhlCircuit();
      }
      return; // one success per tick is enough
    }
    if (outcome === "auth") {
      tripCircuitAuth("half-open probe");
      return;
    }
    // outcome === "failure" → provider failure: re-open immediately.
    ghlCircuitState = "open";
    halfOpenProbeSuccesses = 0;
    console.error("[Queue:ghl-sync] GHL_CIRCUIT_OPEN — half-open probe failed, re-opening circuit");
    storage.createAuditLog({ action: "GHL_CIRCUIT_OPEN", entityType: "system", details: "Half-open probe failed — circuit re-opened" }).catch(() => {});
    maybeSendCircuitAlert();
    persistGhlCircuit();
    return;
  }

  // Whole page skipped — advance the cursor past the last examined candidate
  // and stay half-open; next tick resumes after it.
  halfOpenProbeCursorId = probeCandidates[probeCandidates.length - 1].id;
  console.log(`[Queue:ghl-sync] Half-open probe: all ${probeCandidates.length} candidates skipped — cursor advanced to ${halfOpenProbeCursorId}`);
  persistGhlCircuit();
}

/**
 * Half-open probe. Default path is export-filtered: it claims at most one eligible projection (never a
 * held, historical, test or local-only contact) and settles it through the same executor as the closed
 * path, so deferrals are counted and generations are respected. With no eligible work it uses the
 * read-only provider health check. `deps` selects the legacy cursor path used by cursor tests.
 */
export async function runHalfOpenProbeTick(deps?: {
  getCandidates?: (limit: number, afterId: number) => Promise<Array<{ id: number }>>;
  syncFn?: (contactId: number) => Promise<{ success: boolean; error?: string }>;
  assertOwnership?: () => Promise<void>;
}): Promise<void> {
  if (deps?.getCandidates || deps?.syncFn) return runCursorProbeTick({ getCandidates: deps.getCandidates, syncFn: deps.syncFn });
  let outcome: ProjectionRowOutcome | null = null;
  const summary = await processEligibleContactProjections(1, {
    assertOwnership: deps?.assertOwnership,
    onOutcome: (o) => { outcome = o; return false; },
  });
  if (summary.claimed === 0) {
    const health = await (await import("./ghl")).checkGhlHealth();
    outcome = health.connected ? "success" : (classifyGhlSyncError(health.error) === "auth" ? "auth" : "failure");
  }
  if (outcome === "success") {
    halfOpenProbeSuccesses++;
    console.log(`[Queue:ghl-sync] Half-open probe success ${halfOpenProbeSuccesses}/${GHL_HALF_OPEN_PROBES_REQUIRED}`);
    if (halfOpenProbeSuccesses >= GHL_HALF_OPEN_PROBES_REQUIRED) closeCircuitAfterProbes(); else persistGhlCircuit();
  } else if (outcome === "auth") {
    tripCircuitAuth("half-open probe");
  } else if (outcome === "failure" || outcome === "ambiguous") {
    ghlCircuitState = "open";
    halfOpenProbeSuccesses = 0;
    console.error("[Queue:ghl-sync] GHL_CIRCUIT_OPEN — half-open probe failed, re-opening circuit");
    persistGhlCircuit();
  } else {
    // deferred / skip / terminal / claim_lost: inconclusive; counters untouched, deferral is recorded on the row.
    persistGhlCircuit();
  }
}

const GHL_LAST_TICK_KEY = "ghl_sync_last_tick";

async function recordGhlTick(record: Record<string, unknown>): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO system_settings(key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [GHL_LAST_TICK_KEY, JSON.stringify({ at: new Date().toISOString(), ...record })]);
  } catch (error) {
    console.warn("[Queue:ghl-sync] Could not record tick outcome:", (error as Error).message);
  }
}

export async function readGhlExportPolicy(): Promise<{ currentIntakeSince: string; existingPopulationEnabled: boolean; legacyPhases: { deals: boolean; tasks: boolean; companies: boolean } }> {
  const row = ((await pool.query(`SELECT value FROM system_settings WHERE key = 'ghl_export_policy'`)).rows[0]?.value ?? {}) as any;
  return {
    currentIntakeSince: typeof row.currentIntakeSince === "string" ? row.currentIntakeSince : "2026-10-23T04:00:00Z",
    existingPopulationEnabled: row.existingPopulation?.enabled !== false,
    legacyPhases: {
      deals: row.legacyPhases?.deals === true,
      tasks: row.legacyPhases?.tasks === true,
      companies: row.legacyPhases?.companies === true,
    },
  };
}

/** Legacy entity phases. Contained by default: they used process-local de-duplication and a two-minute window
 *  and cannot be proven idempotent. They only run when explicitly enabled in the export policy. */
async function runLegacyEntityPhases(
  flags: { deals: boolean; tasks: boolean; companies: boolean },
  assertOwnership: () => Promise<void>,
): Promise<{ ok: boolean; error?: string; counts: { deals: number; tasks: number; companies: number } }> {
  const counts = { deals: 0, tasks: 0, companies: 0 };
  if (flags.deals) {
    const { data: deals } = await storage.getDeals({ limit: 500 });
    const unsyncedDeals = deals.filter(d => !d.ghlOpportunityId && d.contactId);
    let dealsSynced = 0;
    for (const deal of unsyncedDeals.slice(0, 5)) {
      await assertOwnership();
      if (consecutiveGhlFailures >= GHL_CIRCUIT_THRESHOLD) {
        tripCircuitThreshold("deals phase");
        return { ok: false, error: "GHL_CIRCUIT_OPEN", counts };
      }
      try {
        const result = await syncDealToGhl(deal.id);
        if (result.success) {
          consecutiveGhlFailures = 0;
          dealsSynced++; counts.deals = dealsSynced;
        } else {
          const kind = classifyGhlSyncError(result.error);
          if (kind === "auth") {
            tripCircuitAuth("deals phase");
            return { ok: false, error: "GHL_CIRCUIT_OPEN_AUTH", counts };
          } else if (kind === "skip") {
            // Data-dependency skip, stage-map config error, or GHL 400 not-found —
            // not a transient API failure; do not trip the circuit.
            console.log(`[Queue:ghl-sync] Deal ${deal.id} skipped (${result.error}) — not counted as GHL failure`);
          } else {
            consecutiveGhlFailures++;
            console.warn(`[Queue:ghl-sync] Deal ${deal.id} sync failed: ${result.error}`);
          }
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (e: any) {
        if (classifyGhlSyncError(e?.message) === "auth") {
          tripCircuitAuth("deals phase");
          return { ok: false, error: "GHL_CIRCUIT_OPEN_AUTH", counts };
        }
        consecutiveGhlFailures++;
        console.error(`[Queue:ghl-sync] Deal ${deal.id} sync error:`, e.message);
      }
    }

    if (consecutiveGhlFailures >= GHL_CIRCUIT_THRESHOLD) {
      tripCircuitThreshold("after deals phase");
      return { ok: false, error: "GHL_CIRCUIT_OPEN", counts };
    }

  }
  if (flags.tasks) {
    const allTasks = await storage.getTasks({ limit: 100 });
    const recentTasks = allTasks.filter((t: any) => {
      if (!t.contactId || syncedTaskIds.has(t.id)) return false;
      const created = t.createdAt ? new Date(t.createdAt).getTime() : 0;
      return Date.now() - created < 120000;
    });
    let tasksSynced = 0;
    for (const task of recentTasks.slice(0, 5)) {
      await assertOwnership();
      if (consecutiveGhlFailures >= GHL_CIRCUIT_THRESHOLD) {
        tripCircuitThreshold("tasks phase");
        return { ok: false, error: "GHL_CIRCUIT_OPEN", counts };
      }
      try {
        const result = await syncTaskToGhl(task.id);
        if (result.success) {
          consecutiveGhlFailures = 0;
          tasksSynced++; counts.tasks = tasksSynced;
          syncedTaskIds.add(task.id);
        } else {
          const kind = classifyGhlSyncError(result.error);
          if (kind === "auth") {
            tripCircuitAuth("tasks phase");
            return { ok: false, error: "GHL_CIRCUIT_OPEN_AUTH", counts };
          } else if (kind === "skip") {
            // Data-availability skips AND GHL 400 not-found (stale task-linked
            // contact IDs) — not real GHL API failures; don't count toward the
            // circuit-breaker threshold.
            console.log(`[Queue:ghl-sync] Task ${task.id} skipped (${result.error}) — not counted as GHL failure`);
            syncedTaskIds.add(task.id); // prevent retry every tick
          } else {
            consecutiveGhlFailures++;
          }
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (e: any) {
        if (classifyGhlSyncError(e?.message) === "auth") {
          tripCircuitAuth("tasks phase");
          return { ok: false, error: "GHL_CIRCUIT_OPEN_AUTH", counts };
        }
        consecutiveGhlFailures++;
        console.error(`[Queue:ghl-sync] Task ${task.id} sync error:`, e.message);
      }
    }

    if (consecutiveGhlFailures >= GHL_CIRCUIT_THRESHOLD) {
      tripCircuitThreshold("after tasks phase");
      return { ok: false, error: "GHL_CIRCUIT_OPEN", counts };
    }

  }
  if (flags.companies) {
    const companies = await storage.getCompanies();
    const unsyncedCompanies = companies.filter(c => !syncedCompanyIds.has(c.id));
    let companiesSynced = 0;
    for (const company of unsyncedCompanies.slice(0, 5)) {
      await assertOwnership();
      if (consecutiveGhlFailures >= GHL_CIRCUIT_THRESHOLD) {
        tripCircuitThreshold("companies phase");
        return { ok: false, error: "GHL_CIRCUIT_OPEN", counts };
      }
      try {
        const result = await syncCompanyToGhl(company.id);
        if (result.success) {
          consecutiveGhlFailures = 0;
          companiesSynced++; counts.companies = companiesSynced;
          syncedCompanyIds.add(company.id);
        } else if (result.skip) {
          // Known API limitation (e.g. 404 on GHL companies endpoint) — don't
          // count toward circuit-breaker threshold; mark as synced so we stop
          // retrying on every tick.
          syncedCompanyIds.add(company.id);
        } else {
          const kind = classifyGhlSyncError(result.error);
          if (kind === "auth") {
            tripCircuitAuth("companies phase");
            return { ok: false, error: "GHL_CIRCUIT_OPEN_AUTH", counts };
          } else if (kind === "skip") {
            // "Company not found" / "GHL not configured" — local data misses,
            // not API failures; mark as synced so we stop retrying every tick.
            console.log(`[Queue:ghl-sync] Company ${company.id} skipped (${result.error}) — not counted as GHL failure`);
            syncedCompanyIds.add(company.id);
          } else {
            consecutiveGhlFailures++;
          }
        }
        await new Promise(r => setTimeout(r, 300));
      } catch (e: any) {
        if (classifyGhlSyncError(e?.message) === "auth") {
          tripCircuitAuth("companies phase");
          return { ok: false, error: "GHL_CIRCUIT_OPEN_AUTH", counts };
        }
        consecutiveGhlFailures++;
        console.error(`[Queue:ghl-sync] Company ${company.id} sync error:`, e.message);
      }
    }

  }
  return { ok: true, counts };
}

type TickBody = { ok: boolean; error?: string; reason: string; detail?: Record<string, unknown> };

/**
 * Owner-fenced CRM reconciliation tick. Every exit path (no work, half-open, circuit trip, exception)
 * stops both heartbeats and releases the runtime lease and job lock exactly once; every early exit
 * records its reason so "no progress" is always explainable.
 */
export async function runGhlFullSyncTick(): Promise<void> {
  if (!isGhlConfigured()) { await recordGhlTick({ outcome: "skipped", reason: "ghl_not_configured" }); return; }
  const { acquireJobLock, releaseJobLock, startJobLockHeartbeat, JOB_NAMES } = await import("./job-registry");
  const lease = await acquireJobLock(JOB_NAMES.GHL_SYNC);
  if (lease.status !== "acquired") { await recordGhlTick({ outcome: "skipped", reason: `job_lock_${lease.status}` }); return; }
  const lockToken = lease.lockToken;
  const heartbeat = startJobLockHeartbeat(JOB_NAMES.GHL_SYNC, lockToken);
  const { acquireGhlSyncRuntimeLease } = await import("./ghl-sync-runtime");
  let runtimeLease: Awaited<ReturnType<typeof acquireGhlSyncRuntimeLease>> | null = null;
  let body: TickBody = { ok: false, error: "TICK_NOT_COMPLETED", reason: "unknown" };
  let thrown: unknown = null;
  try {
    runtimeLease = await acquireGhlSyncRuntimeLease();
    if (runtimeLease.status !== "acquired" || !runtimeLease.assertOwned || !runtimeLease.release) {
      body = { ok: true, reason: `runtime_lease_${runtimeLease.status}` };
      return;
    }
    const lockedLease = runtimeLease;
    const assertOwnership = async () => {
      heartbeat.assertOwned();
      await lockedLease.assertOwned!();
    };
    body = await runGhlTickBody(assertOwnership);
  } catch (err) {
    thrown = err;
    body = { ok: false, error: err instanceof Error ? err.message : String(err), reason: "exception" };
  } finally {
    try { runtimeLease?.stopHeartbeat?.(); } catch { /* best effort */ }
    try { await runtimeLease?.release?.(); } catch { /* expiry is the recovery path */ }
    heartbeat.stop();
    await releaseJobLock(JOB_NAMES.GHL_SYNC, body.ok, body.error, lockToken).catch(() => {});
    await recordGhlTick({
      outcome: body.ok ? "ok" : "failed", reason: body.reason, error: body.error ?? null,
      circuitState: ghlCircuitState, ...(body.detail ?? {}),
    });
  }
  if (thrown) throw thrown;
}

async function runGhlTickBody(assertOwnership: () => Promise<void>): Promise<TickBody> {
  await restoreGhlCircuit();
  await assertOwnership();
  const detail: Record<string, unknown> = {};

  // Legacy rows converge to the authority model; stranded deferral rows are released. Failures are
  // recorded but never block the tick: only authority-adopted rows are claimable.
  try {
    const { convergeLegacyProjectionRows } = await import("./ghl-projection-convergence");
    const convergence = await convergeLegacyProjectionRows();
    detail.convergence = convergence.ran ? (convergence.remaining ? "partial_resumable" : "ran") : "none_needed";
    const { repairStrandedProjections, reconcileExhaustedProjections } = await import("./ghl-projection-authority");
    const repaired = await repairStrandedProjections();
    if (repaired > 0) detail.strandedReleased = repaired;
    const exhausted = await reconcileExhaustedProjections();
    if (exhausted > 0) detail.exhaustedExpiredClosed = exhausted;
  } catch (error) {
    detail.convergenceError = (error as Error).message.slice(0, 200);
  }
  await assertOwnership();

  // Provider-write commands obey the circuit; only the read-only identity backfill runs while it is not closed.
  const { runPendingGhlSpecializedCommands } = await import("./ghl-specialized-commands");
  const commandResult = await runPendingGhlSpecializedCommands(undefined, ghlCircuitState !== "closed");
  detail.specializedCommand = commandResult.reason ?? (commandResult.advanced ? "advanced" : "idle");
  await assertOwnership();

  const { getProjectionBacklog } = await import("./ghl-projection-authority");
  const backlog = await getProjectionBacklog();
  detail.backlog = backlog;
  const dueWork = backlog.eligiblePending + backlog.eligibleRetryDue + backlog.processing;
  if (dueWork === 0 && ghlCircuitState === "closed") {
    // Healthy idle: nothing eligible is not evidence of provider failure.
    lastFullSuccessTickAt = Date.now();
  }

  if (ghlCircuitState === "open") {
    ghlCircuitState = "half-open";
    halfOpenProbeSuccesses = 0;
    console.log("[Queue:ghl-sync] GHL_CIRCUIT_HALF_OPEN — circuit was open, entering half-open probe mode");
    storage.createAuditLog({ action: "GHL_CIRCUIT_HALF_OPEN", entityType: "system", details: "Circuit transitioned open → half-open; single probe sync this tick" }).catch(() => {});
    persistGhlCircuit();
  } else if (ghlCircuitState === "closed" && dueWork > 0 && Date.now() - lastFullSuccessTickAt > GHL_ROLLING_UNHEALTHY_MS) {
    ghlCircuitState = "half-open";
    halfOpenProbeSuccesses = 0;
    console.log(`[Queue:ghl-sync] GHL_CIRCUIT_HALF_OPEN — eligible work without a successful projection since ${new Date(lastFullSuccessTickAt).toISOString()}, entering probe mode`);
    storage.createAuditLog({ action: "GHL_CIRCUIT_HALF_OPEN", entityType: "system", details: `Eligible work waited ${Math.round((Date.now() - lastFullSuccessTickAt) / 60000)} min without a successful projection — probe mode` }).catch(() => {});
    persistGhlCircuit();
  }

  if (ghlCircuitState === "half-open") {
    await runHalfOpenProbeTick({ assertOwnership });
    detail.circuitAfterProbe = ghlCircuitState;
    return { ok: true, reason: "half_open_probe", detail };
  }

  let stopError: string | undefined;
  const summary = await processEligibleContactProjections(10, {
    assertOwnership,
    paceMs: 300,
    onOutcome: (outcome) => {
      if (outcome === "success") {
        consecutiveGhlFailures = 0;
        lastFullSuccessTickAt = Date.now();
        return true;
      }
      if (outcome === "auth") {
        tripCircuitAuth("projection phase");
        stopError = "GHL_CIRCUIT_OPEN_AUTH";
        return false;
      }
      if (outcome === "failure" || outcome === "ambiguous") {
        consecutiveGhlFailures++;
        if (consecutiveGhlFailures >= GHL_CIRCUIT_THRESHOLD) {
          tripCircuitThreshold("projection phase");
          stopError = "GHL_CIRCUIT_OPEN";
          return false;
        }
      }
      return true; // deferred, skip, terminal and claim_lost never touch the circuit counters
    },
  });
  detail.projections = summary;
  if (summary.completed || summary.retried || summary.terminal || summary.deferred) {
    console.log(`[Queue:ghl-sync] contact projections completed=${summary.completed} deferred=${summary.deferred} retried=${summary.retried} terminal=${summary.terminal} ambiguous=${summary.ambiguous}`);
  }
  if (stopError) { persistGhlCircuit(); return { ok: false, error: stopError, reason: "circuit_opened", detail }; }
  await assertOwnership();

  const policy = await readGhlExportPolicy();
  const legacyEnabled = policy.legacyPhases.deals || policy.legacyPhases.tasks || policy.legacyPhases.companies;
  if (legacyEnabled) {
    const legacy = await runLegacyEntityPhases(policy.legacyPhases, assertOwnership);
    detail.legacyEntities = legacy.counts;
    if (!legacy.ok) { persistGhlCircuit(); return { ok: false, error: legacy.error, reason: "circuit_opened_legacy", detail }; }
  } else {
    detail.legacyEntities = "contained";
  }

  try {
    await assertOwnership();
    const { runDeleteDetectionTick } = await import("./ghl-delete-sync");
    const deleteResult = await runDeleteDetectionTick();
    if (deleteResult.contactsDeleted > 0 || deleteResult.dealsDeleted > 0) {
      console.log(`[Queue:ghl-sync] Delete detection: ${deleteResult.contactsDeleted} contacts, ${deleteResult.dealsDeleted} deals soft-deleted`);
    }
  } catch (delErr: any) {
    if (/LEASE_LOST|RUNTIME_SELECTION_CHANGED|lock lost|ownership/i.test(delErr?.message ?? "")) throw delErr;
    console.warn("[Queue:ghl-sync] Delete detection tick failed (non-fatal):", delErr.message);
  }

  persistGhlCircuit(); // carry counter/state forward across ticks and restarts
  return { ok: true, reason: dueWork === 0 ? "idle_no_eligible_work" : "projection_batch", detail };
}
