import crypto from "crypto";
import { db } from "../db";
import { storage } from "../storage";
import {intakeBusinessEvidence} from "../../shared/intake-business-evidence";
import {selectMailboxContact,ContactIdentityAmbiguityError} from "./contact-mailbox-identity";
import {
  contacts,
  contactSourceEvents,
  contactProviderProjections,
  importRowDispositions,
  importExecutions,
  type InsertContact,
  type UpdateContactRequest,
  type Contact,
  type ServerInsertContact,
} from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { normalizeGhlId } from "../utils/normalize";
import { READINESS_DEPENDENT_FIELDS, enqueueReadinessRecalculation } from "./contact-readiness";
import { requestContactLeadScoring } from "./contact-lead-scoring-trigger";
import { recordContactIdentityObservations } from "./contact-identity";
import {
  CONTACT_AUTHORITY_OWNED_FIELDS,
  ContactProtectedFieldError,
  assertNoProtectedContactFields,
  stripContactAuthorityFields,
} from "./contact-field-authority";
import { createValidationIntent, hashEmailToken, normalizeEmailToken } from "./provider-readiness-control";

export {
  CONTACT_AUTHORITY_OWNED_FIELDS,
  ContactProtectedFieldError,
  assertNoProtectedContactFields,
  stripContactAuthorityFields,
} from "./contact-field-authority";

// ---------------------------------------------------------------------------
// Source category / type validation
// Reject invalid combinations before any DB write.
// ---------------------------------------------------------------------------
const VALID_SOURCE_COMBOS: ReadonlySet<string> = new Set([
  "website_form|statement_upload",
  "website_form|estimate_form",
  "website_form|callback_form",
  "website_form|equipment_order",
  "website_form|support_form",
  "website_form|partner_application",
  "website_form|merchant_application",
  "website_form|get_started_form",
  "website_form|integration_request",
  "website_form|testimonial_submit",
  "website_form|newsletter_signup",
  "manual_crm|dashboard",
  "ghl_sync|inbound",
  "csv_import|csv_contact",
  "csv_import|outscraper",
  "csv_import|apollo",
  "csv_import|apify",
  "registry_import|sunbiz_upload",
  "registry_import|sunbiz_corevt",
  "prospect_conversion|csv_prospect",
  "discovery|apollo",
  "discovery|outscraper",
  "discovery|apify",
  "discovery|serper",
  "discovery|cro03",
  "discovery|free_discovery",
  "partner_referral|partner_form",
  "partner_referral|partner_portal",
  "partner_referral|co_branded_proposal",
  "merchant_application|merchant_application",
  "legacy_unknown|historical_backfill",
]);

function assertValidSourceCombo(sourceCategory: string, sourceType: string): void {
  const key = `${sourceCategory}|${sourceType}`;
  if (!VALID_SOURCE_COMBOS.has(key)) {
    throw new Error(`[ContactWriter] Invalid sourceCategory/sourceType combination: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type WriteMode =
  | "local_first"         // Commit canonical local state before any provider effect
  | "ghl_inbound_no_echo" // Local DB only — skip GHL write to avoid echo loop
  | "local_only";         // Local DB only — no GHL (CSV imports, bulk ops)

export interface ProvenanceInput {
  sourceCategory: string;
  sourceType: string;
  eventKey: string; // non-null, server-generated
  sourceExternalId?: string;
  importExecutionId?: string; // UUID
  sourceRowNumber?: number;
  rowFingerprint?: string;
  /** Required for import-owned mutations so a reclaimed worker fences stale owners. */
  importClaimToken?: string;
  actorType: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
}

export interface ContactWriterHookPolicy {
  /** Internal CRO-03 or deliberately isolated inbound reconciliation write. */
  source: "cro03" | "ghl_inbound";
  deferValidation: true;
  deferReadiness: true;
  deferLeadScoring: true;
  suppressProviderProjection: true;
  /** Optional caller-owned database authority check, evaluated inside the
   * contact/source-event transaction immediately before any mutation. */
  authorityCheck?: (tx: any) => Promise<boolean>;
}

export interface ActorCtx {
  actorType: string;
  actorId?: string | null;
  userId?: string | null;
}

// ---------------------------------------------------------------------------
// Provenance fields that must never be accepted from client input
// ---------------------------------------------------------------------------
export const PROVENANCE_FIELDS = [
  "sourceCategory",
  "primarySourceCategory",
  "primarySourceType",
  "primarySourceEventId",
  // Vertical provenance — server-assigned; never accepted from client input
  "verticalSource",
  "verticalConfidence",
  "manualVerticalOverride",
] as const;

/**
 * Strip provenance fields from any object (defense-in-depth for PUT/PATCH routes).
 */
export function stripProvenanceFields<T extends Record<string, unknown>>(obj: T): Omit<T, typeof PROVENANCE_FIELDS[number]> {
  const result = { ...obj };
  for (const field of PROVENANCE_FIELDS) {
    delete (result as Record<string, unknown>)[field];
  }
  return result as Omit<T, typeof PROVENANCE_FIELDS[number]>;
}

// ---------------------------------------------------------------------------
// Canonical writer — all contact creation flows go through here
// ---------------------------------------------------------------------------
/**
 * writeContact — canonical single write path for all new contact creation.
 *
 * The command is deliberately local-first. Contact, source event, BT-07
 * identity observation, audit record, and GHL projection intent commit in one
 * transaction. Provider I/O is performed only by the claimed projection worker.
 *
 * In all modes: contact + source event are written in a single DB transaction.
 * Sets sourceCategory AND primarySourceCategory to the same server-controlled value.
 * primarySourceCategory is immutable after first set via this writer.
 */
export async function writeContact(args: {
  mode: WriteMode;
  mutation: Omit<InsertContact, "sourceCategory" | "primarySourceCategory" | "primarySourceType" | "primarySourceEventId"> & Record<string, unknown>;
  provenance: ProvenanceInput;
  actor: ActorCtx;
  hookPolicy?: ContactWriterHookPolicy;
  /** Caller-owned transaction for compound local-only mutations. All hooks
   * must be deferred, because they cannot run before the caller commits. */
  transaction?: any;
  /** CSV receipt written in the same local transaction as the contact. */
  rowDisposition?: { createdReasonCode: string; matchedReasonCode: string; additionalContact?: boolean };
  /** Local fulfillment of an immutable deferred import, owned by its existing
   * source work item. Never accepted from route payloads or provider adapters. */
  retainedSourceRecovery?: import("./canonical-import-recovery-contract").CanonicalImportRecoveryClaim;
}): Promise<Contact & {
  _ghlSyncPending: boolean;
  _intakeOutcome: "created" | "matched_existing";
  _sourceEventId: number;
}> {
  const { mode, provenance:rawProvenance, actor, rowDisposition, hookPolicy } = args;
  const provenance = ["manual_crm","ghl_sync"].includes(rawProvenance.sourceCategory) &&
    !rawProvenance.metadata?.businessEvidence
    ? {...rawProvenance,metadata:{...rawProvenance.metadata,businessEvidence:intakeBusinessEvidence(args.mutation)}}
    : rawProvenance;
  if (args.transaction && (!hookPolicy ||
      !((mode === "local_only") || (mode === "ghl_inbound_no_echo" && hookPolicy.source === "ghl_inbound")) ||
      !hookPolicy.deferValidation ||
      !hookPolicy.deferReadiness || !hookPolicy.deferLeadScoring || !hookPolicy.suppressProviderProjection)) {
    throw new Error("CONTACT_WRITE_EXTERNAL_TRANSACTION_REQUIRES_DEFERRED_LOCAL_HOOKS");
  }
  if (hookPolicy?.source === "ghl_inbound" &&
      (mode !== "ghl_inbound_no_echo" || provenance.sourceCategory !== "ghl_sync" ||
       provenance.sourceType !== "inbound" || !provenance.sourceExternalId ||
       !hookPolicy.deferValidation || !hookPolicy.deferReadiness ||
       !hookPolicy.deferLeadScoring || !hookPolicy.suppressProviderProjection)) {
    throw new Error("CONTACT_WRITE_INVALID_GHL_INBOUND_HOOK_POLICY");
  }
  const mutation = stripContactAuthorityFields(args.mutation);

  assertValidSourceCombo(provenance.sourceCategory, provenance.sourceType);
  if ((!hookPolicy || hookPolicy.source === "cro03") && provenance.sourceExternalId) {
    const { assertCro03bLegacySourceWriteAllowed } = await import("./cro03/admission-service");
    await assertCro03bLegacySourceWriteAllowed({
      subjectType: provenance.sourceType,
      subjectKey: provenance.sourceExternalId,
      writerKey: `contact-writer:${provenance.sourceCategory}:${provenance.sourceType}`,
    }, args.transaction ?? db);
  }

  // Normalize ghlContactId in mutation before any DB write — blank strings become null.
  if ((mutation as any).ghlContactId !== undefined) {
    (mutation as any).ghlContactId = normalizeGhlId((mutation as any).ghlContactId);
  }

  const shouldProject = mode === "local_first" && !hookPolicy?.suppressProviderProjection;
  const email = String((mutation as any).email ?? "").trim().toLowerCase();
  // Phone-only contacts have no mailbox. Preserve raw source observations,
  // but represent absence honestly in the contact projection, not as a shared
  // empty-string pseudo-identity. Source observations retain the original.
  (mutation as any).email = email || null;
  const syntheticPlaceholder = /^no-email-[0-9a-f-]+@no-email\.libertybancard\.internal$/i.test(email);
  const initialEmailTokenHash = hashEmailToken(email);

  // Transactional contact + source event + observation + audit + projection.
  // A: insert contact with primarySourceEventId = NULL
  // B: insert contact_source_events row
  // C: UPDATE contact to set primarySourceCategory, primarySourceType, primarySourceEventId, sourceCategory
  // The DEFERRABLE INITIALLY DEFERRED FK on primarySourceEventId allows A before B.
  const { auditChange } = await import("./audit-change");

  const writeInsideTransaction = async (tx: any) => {
    // With mailbox uniqueness removed, serialize retries and competing mailbox
    // resolutions in this transaction (never on another connection).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`contact-source:${provenance.eventKey}`}, 0))`);
    if(email&&!syntheticPlaceholder)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`contact-mailbox:${email}`}, 0))`);
    if (hookPolicy?.authorityCheck && !(await hookPolicy.authorityCheck(tx))) {
      throw new Error("CONTACT_WRITE_AUTHORITY_FENCE_LOST");
    }
    const importOwned = Boolean(provenance.importExecutionId || provenance.importClaimToken || rowDisposition);
    if (args.retainedSourceRecovery) {
      if (!args.transaction || mode!=="local_only" || hookPolicy?.source!=="cro03" ||
          !hookPolicy.authorityCheck || !provenance.importExecutionId || provenance.importClaimToken ||
          !provenance.sourceRowNumber || !provenance.rowFingerprint || !rowDisposition) {
        throw new Error("CANONICAL_IMPORT_RECOVERY_PROTOCOL_REQUIRED");
      }
      const {hasCanonicalImportRecoveryClaim}=await import("./canonical-import-recovery-contract");
      if (!await hasCanonicalImportRecoveryClaim(tx,{
        executionId:provenance.importExecutionId,sourceRowNumber:provenance.sourceRowNumber,
        rowFingerprint:provenance.rowFingerprint,recoveryClaim:args.retainedSourceRecovery,
      })) throw new Error("CANONICAL_IMPORT_RECOVERY_CLAIM_LOST");
    } else if (importOwned) {
      if (
        !provenance.importExecutionId || !provenance.importClaimToken ||
        !provenance.sourceRowNumber || !provenance.rowFingerprint || !rowDisposition
      ) {
        throw new Error("IMPORT_EXECUTION_CLAIM_REQUIRED");
      }
      const owner = (await tx.execute(sql`
        SELECT id FROM import_executions
        WHERE id = ${provenance.importExecutionId}::uuid
          AND claim_token = ${provenance.importClaimToken}::uuid
          AND status = 'running'
          AND lease_expires_at >= now()
        FOR UPDATE
      `) as any).rows?.[0];
      if (!owner) throw new Error(`IMPORT_EXECUTION_LEASE_LOST:${provenance.importExecutionId}`);
    }
    const recordLedger = async (contactId: number, disposition: "created" | "matched_noop", reasonCode: string) => {
      if (!importOwned) return;
      // The original deferred disposition describes the original import. Its
      // later local fulfillment is receipted by the claimed source work item.
      if (args.retainedSourceRecovery) return;
      if (rowDisposition?.additionalContact) {
        // Multiple distinct addresses from ONE retained source row share its
        // row accounting, not its contact identity. Require the primary receipt
        // in this owned transaction; every additional contact still has its own
        // immutable source event and exact source-row provenance.
        const primary=(await tx.execute(sql`SELECT id FROM import_row_dispositions
          WHERE execution_id=${provenance.importExecutionId!}::uuid
            AND source_row_number=${provenance.sourceRowNumber!}
            AND row_fingerprint=${provenance.rowFingerprint!}
            AND disposition IN ('created','matched_noop')`) as any).rows?.[0];
        if (!primary) throw new Error("IMPORT_ADDITIONAL_CONTACT_PRIMARY_RECEIPT_REQUIRED");
        return;
      }
      const inserted = await tx.insert(importRowDispositions).values({
        executionId: provenance.importExecutionId!,
        sourceRowNumber: provenance.sourceRowNumber!,
        rowFingerprint: provenance.rowFingerprint!,
        disposition,
        reasonCode,
        contactId,
      }).onConflictDoNothing().returning({ id: importRowDispositions.id });
      if (inserted.length) return;
      const [existingLedger] = await tx.select({
        rowFingerprint: importRowDispositions.rowFingerprint,
        disposition: importRowDispositions.disposition,
        reasonCode: importRowDispositions.reasonCode,
        contactId: importRowDispositions.contactId,
      }).from(importRowDispositions).where(and(
        eq(importRowDispositions.executionId, provenance.importExecutionId!),
        eq(importRowDispositions.sourceRowNumber, provenance.sourceRowNumber!),
      )).limit(1);
      if (
        existingLedger?.rowFingerprint === provenance.rowFingerprint &&
        existingLedger.disposition === disposition &&
        existingLedger.reasonCode === reasonCode &&
        existingLedger.contactId === contactId
      ) return;
      throw new Error(`IMPORT_LEDGER_DISPOSITION_CONFLICT:${provenance.importExecutionId}:${provenance.sourceRowNumber}`);
    };
    // Shared email alone is not identity. Reuse only one corroborated candidate;
    // conflicting names/sites/source IDs remain separate contacts.
    // An existing source-event key is an exact retry of this intake command,
    // not a newly discovered identity match. Resolve it before email matching
    // so a recovery worker preserves the original `created` disposition.
    const prior = await tx.execute(sql`
      SELECT c.id
      FROM contact_source_events e
      JOIN contacts c ON c.id = e.contact_id
      WHERE e.event_key = ${provenance.eventKey}
      LIMIT 2
    `);
    const priorContacts = ((prior as any).rows ?? []);
    if(priorContacts.length>1)throw new ContactIdentityAmbiguityError("CONTACT_SOURCE_EVENT_IDENTITY_AMBIGUOUS",
      priorContacts.map((candidate:any)=>Number(candidate.id)));
    const replayedSourceContact = priorContacts[0];
    const candidates: Contact[] = replayedSourceContact
      ? await tx.select().from(contacts).where(eq(contacts.id, replayedSourceContact.id)).limit(1)
      : email && !syntheticPlaceholder
        ? await tx.select().from(contacts).where(and(eq(contacts.email, email), isNull(contacts.archivedAt)))
        : [];
    const existing = replayedSourceContact ? candidates[0] : selectMailboxContact(candidates, mutation);
    if (existing) {
      const sourceEventResult = await tx.execute(sql`
        INSERT INTO contact_source_events
          (contact_id, event_key, source_category, source_type, source_external_id,
           import_execution_id, source_row_number, row_fingerprint, actor_type, actor_id, metadata)
        VALUES
          (${existing.id}, ${provenance.eventKey}, ${provenance.sourceCategory}, ${provenance.sourceType},
           ${provenance.sourceExternalId ?? null}, ${provenance.importExecutionId ?? null},
           ${provenance.sourceRowNumber ?? null}, ${provenance.rowFingerprint ?? null},
           ${provenance.actorType}, ${provenance.actorId ?? null},
           ${provenance.metadata ? JSON.stringify(provenance.metadata) : null}::jsonb)
        ON CONFLICT (contact_id, event_key) DO UPDATE SET last_seen_at = now()
        RETURNING id
      `);
      const sourceEventId = Number(((sourceEventResult as any).rows ?? [])[0]?.id);
      if (!sourceEventId) throw new Error("CONTACT_SOURCE_EVENT_REPLAY_FAILED");
      await recordContactIdentityObservations(tx as any, existing, "contact_writer", provenance.eventKey);
      await auditChange({
        userId: actor.userId ?? null,
        actorType: (actor.actorType as any) ?? "system",
        actorId: actor.actorId ?? null,
        action: "contact_intake_matched",
        entityType: "contact",
        entityId: existing.id,
        before: null,
        after: { sourceCategory: provenance.sourceCategory, sourceType: provenance.sourceType },
      }, tx);
      await recordLedger(
        existing.id,
        replayedSourceContact ? "created" : "matched_noop",
        replayedSourceContact
          ? rowDisposition?.createdReasonCode ?? "LOCAL_CONTACT_CREATED"
          : rowDisposition?.matchedReasonCode ?? "EXACT_ELIGIBLE_IDENTITY_MATCH",
      );
      if (shouldProject && !existing.ghlContactId && !syntheticPlaceholder) {
        await tx.insert(contactProviderProjections).values({
          contactId: existing.id,
          provider: "ghl",
          projectionKey: `contact:${existing.id}`,
          state: "pending",
        }).onConflictDoNothing();
      }
      return {
        contact: existing,
        outcome: replayedSourceContact ? "created" as const : "matched_existing" as const,
        pending: shouldProject && !existing.ghlContactId && !syntheticPlaceholder,
        sourceEventId,
      };
    }

    const contactPayload: ServerInsertContact = {
      ...(mutation as any),
      sourceCategory: provenance.sourceCategory,
      primarySourceCategory: provenance.sourceCategory,
      primarySourceType: provenance.sourceType,
      primarySourceEventId: null, // will be updated after event insert
      recordClass: "unknown",
      lastMeaningfulContactMutationAt: new Date(),
      ...(initialEmailTokenHash ? {
        emailMutationGeneration: 1,
        emailTokenHash: initialEmailTokenHash,
        emailValidationUpdatedAt: null,
        // DAT-14 is a compatibility projection only; the durable intent below
        // is the authoritative record that current validation is pending.
        emailStatus: "unvalidated",
      } : {}),
    };

    // A: Insert contact
    const [newContact] = await tx.insert(contacts).values(contactPayload).returning();
    if (initialEmailTokenHash && !hookPolicy?.deferValidation) {
      await createValidationIntent(tx, {
        contactId: newContact.id,
        email: newContact.email,
        generation: newContact.emailMutationGeneration,
      });
    }
    await recordContactIdentityObservations(tx as any, newContact, "contact_writer", provenance.eventKey);

    // B: Insert source event
    const [sourceEvent] = await tx.insert(contactSourceEvents).values({
      contactId: newContact.id,
      eventKey: provenance.eventKey,
      sourceCategory: provenance.sourceCategory,
      sourceType: provenance.sourceType,
      sourceExternalId: provenance.sourceExternalId ?? null,
      importExecutionId: provenance.importExecutionId ?? null,
      sourceRowNumber: provenance.sourceRowNumber ?? null,
      rowFingerprint: provenance.rowFingerprint ?? null,
      actorType: provenance.actorType,
      actorId: provenance.actorId ?? null,
      metadata: provenance.metadata ?? null,
    }).returning();

    // C: Update contact with sourceEvent FK
    const [updatedContact] = await tx
      .update(contacts)
      .set({ primarySourceEventId: sourceEvent.id })
      .where(eq(contacts.id, newContact.id))
      .returning();

    // Audit log
    await auditChange({
      userId: actor.userId ?? null,
      actorType: (actor.actorType as any) ?? "system",
      actorId: actor.actorId ?? null,
      action: "contact_created",
      entityType: "contact",
      entityId: updatedContact.id,
      before: null,
      after: updatedContact as unknown as Record<string, unknown>,
    }, tx);
    await recordLedger(updatedContact.id, "created", rowDisposition?.createdReasonCode ?? "LOCAL_CONTACT_CREATED");
    const pending = shouldProject && !updatedContact.ghlContactId && !syntheticPlaceholder;
    if (pending) {
      await tx.insert(contactProviderProjections).values({
        contactId: updatedContact.id,
        provider: "ghl",
        projectionKey: `contact:${updatedContact.id}`,
        state: "pending",
      }).onConflictDoNothing();
    }
    return { contact: updatedContact, outcome: "created" as const, pending, sourceEventId: sourceEvent.id };
  };
  const result = args.transaction
    ? await writeInsideTransaction(args.transaction)
    : await db.transaction(writeInsideTransaction);
  const contact = result.contact;

  if (contact.emailMutationGeneration > 0 && !hookPolicy?.deferValidation) {
    const { enqueueCurrentValidationIntent } = await import("./provider-readiness-control");
    // Failure is intentionally non-fatal: the committed intent is recovered by
    // the queue-owned worker rather than being lost with this HTTP request.
    await enqueueCurrentValidationIntent(contact.id).catch(() => {});
  }

  // Step 3: Readiness hook
  if (!hookPolicy?.deferReadiness) {
    try {
      await enqueueReadinessRecalculation(contact.id);
    } catch (err) {
      console.warn(`[ContactWriter] Readiness enqueue failed for new contact ${contact.id}: ${(err as Error).message}`);
    }
  }

  // Step 3b: Per-contact lead scoring hook
  if (!hookPolicy?.deferLeadScoring) {
    try {
      const scoringStatus = await requestContactLeadScoring(contact.id, "contact_created");
      console.debug(`[ContactWriter] Lead scoring enqueued for contact ${contact.id}: ${scoringStatus}`);
    } catch (err) {
      console.warn(`[ContactWriter] Lead scoring trigger failed for contact ${contact.id}: ${(err as Error).message}`);
    }
  }

  return {
    ...contact, _ghlSyncPending: result.pending, _intakeOutcome: result.outcome,
    _sourceEventId: result.sourceEventId,
  };
}

/**
 * Upsert a contact_source_events row — used on GHL inbound updates
 * (existing contacts only). Does NOT touch primarySourceCategory if already set.
 * On duplicate eventKey: updates lastSeenAt only.
 */
export async function upsertContactSourceEvent(args: {
  contactId: number;
  provenance: ProvenanceInput;
}): Promise<void> {
  const { contactId, provenance } = args;
  assertValidSourceCombo(provenance.sourceCategory, provenance.sourceType);

  await db.execute(sql`
    INSERT INTO contact_source_events
      (contact_id, event_key, source_category, source_type, source_external_id,
       import_execution_id, actor_type, actor_id, metadata)
    VALUES
      (${contactId}, ${provenance.eventKey}, ${provenance.sourceCategory},
       ${provenance.sourceType}, ${provenance.sourceExternalId ?? null},
       ${provenance.importExecutionId ?? null},
       ${provenance.actorType}, ${provenance.actorId ?? null},
       ${provenance.metadata ? JSON.stringify(provenance.metadata) : null}::jsonb)
    ON CONFLICT (contact_id, event_key)
    DO UPDATE SET last_seen_at = now()
  `);
}

// ---------------------------------------------------------------------------
// Explicit local-first adapters for legacy call sites
// ---------------------------------------------------------------------------
export async function createContactLocalFirst(
  input: InsertContact,
  auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null },
  source?: Pick<ProvenanceInput, "sourceCategory" | "sourceType" | "eventKey">,
): Promise<Contact & { _ghlSyncPending: boolean; _intakeOutcome: "created" | "matched_existing" }> {
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({
      email: (input as any).email ?? "",
      phone: (input as any).phone ?? "",
      companyName: (input as any).companyName ?? "",
      source: source?.sourceCategory ?? "manual_crm",
    }))
    .digest("hex")
    .slice(0, 32);
  const contract = source ?? {
    sourceCategory: "manual_crm",
    sourceType: "dashboard",
    eventKey: `internal-contact:${fingerprint}`,
  };
  return writeContact({
    mode: "local_first",
    mutation: input as any,
    provenance: {
      ...contract,
      actorType: auditCtx?.actorType ?? "system",
      actorId: auditCtx?.actorId ?? undefined,
    },
    actor: {
      actorType: auditCtx?.actorType ?? "system",
      actorId: auditCtx?.actorId ?? null,
      userId: auditCtx?.userId ?? null,
    },
  });
}

/**
 * Generic profile updates commit locally, audit locally, and create durable
 * GHL work before any network attempt. Protected fields must go through their
 * respective authorities instead.
 */
export async function updateContactLocalFirst(
  contactId: number,
  updates: UpdateContactRequest,
  auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null },
  compareAndSet?: {
    field: keyof Contact;
    expectedValue: unknown;
    expectedEmailGeneration?: number;
    authorityCheck?: (tx: any) => Promise<boolean>;
  },
  hookPolicy?: ContactWriterHookPolicy,
  transaction?: any,
): Promise<(Contact & { _ghlSyncFailed: boolean }) | null> {
  if (hookPolicy?.source === "ghl_inbound" &&
      (!hookPolicy.deferValidation || !hookPolicy.deferReadiness ||
       !hookPolicy.deferLeadScoring || !hookPolicy.suppressProviderProjection)) {
    throw new Error("CONTACT_WRITE_INVALID_GHL_INBOUND_HOOK_POLICY");
  }
  if (!hookPolicy || hookPolicy.source === "cro03") {
    const { assertCro03bLegacyContactWriteAllowed } = await import("./cro03/admission-service");
    await assertCro03bLegacyContactWriteAllowed(contactId, "contact-writer:update-local-first");
  }
  assertNoProtectedContactFields(updates as Record<string, unknown>);
  const safeUpdates = stripProvenanceFields(updates as Record<string, unknown>) as UpdateContactRequest;
  const changedKeys = Object.keys(safeUpdates) as Array<keyof typeof safeUpdates>;
  const hasReadinessChange = changedKeys.some(k => READINESS_DEPENDENT_FIELDS.includes(k as any));
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(safeUpdates)).digest("hex").slice(0, 32);
  const updateInsideTransaction = async (tx: any) => {
    const [before] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).limit(1).for("update");
    if (!before) return null;
    if (compareAndSet) {
      if (compareAndSet.authorityCheck && !(await compareAndSet.authorityCheck(tx))) {
        throw new ContactWriteConflictError();
      }
      const actual = (before as any)[compareAndSet.field];
      if (String(actual ?? "") !== String(compareAndSet.expectedValue ?? "") ||
          (compareAndSet.expectedEmailGeneration !== undefined &&
           before.emailMutationGeneration !== compareAndSet.expectedEmailGeneration)) {
        throw new ContactWriteConflictError();
      }
    }
    const nextEmail = "email" in safeUpdates ? String((safeUpdates as any).email ?? "") : before.email;
    const materialEmailChange = normalizeEmailToken(nextEmail) !== normalizeEmailToken(before.email);
    const nextGeneration = materialEmailChange ? before.emailMutationGeneration + 1 : before.emailMutationGeneration;
    const nextTokenHash = materialEmailChange ? hashEmailToken(nextEmail) : before.emailTokenHash;
    const [local] = await tx.update(contacts).set({
      ...safeUpdates,
      ...(hasReadinessChange ? { lastMeaningfulContactMutationAt: new Date() } : {}),
      ...(materialEmailChange ? {
        emailMutationGeneration: nextGeneration,
        emailTokenHash: nextTokenHash,
        emailValidationUpdatedAt: null,
        emailStatus: "unvalidated",
      } : {}),
    }).where(eq(contacts.id, contactId)).returning();
    if (!local) return null;
    if (materialEmailChange && nextTokenHash && !hookPolicy?.deferValidation) {
      await createValidationIntent(tx, {
        contactId,
        email: local.email,
        generation: nextGeneration,
      });
    }
    const syntheticPlaceholder = /^no-email-[0-9a-f-]+@no-email\.libertybancard\.internal$/i.test(local.email);
    if (!syntheticPlaceholder && !hookPolicy?.suppressProviderProjection) {
      await tx.insert(contactProviderProjections).values({
        contactId,
        provider: "ghl",
        projectionKey: `profile:${contactId}:${fingerprint}`,
        state: "pending",
      }).onConflictDoNothing();
    }
    const { auditChange } = await import("./audit-change");
    await auditChange({
      userId: auditCtx?.userId ?? null, actorType: (auditCtx?.actorType as any) ?? "system",
      actorId: auditCtx?.actorId ?? null, action: "contact_updated", entityType: "contact",
      entityId: contactId, before: null, after: safeUpdates as Record<string, unknown>,
    }, tx);
    return local;
  };
  const updated = transaction
    ? await updateInsideTransaction(transaction)
    : await db.transaction(updateInsideTransaction);
  if (!updated) return null;

  if (hasReadinessChange && !hookPolicy?.deferReadiness) {
    try {
      await enqueueReadinessRecalculation(contactId);
    } catch (err) {
      console.warn(`[ContactWriter] Readiness enqueue failed for contact ${contactId}: ${(err as Error).message}`);
    }
  }
  return { ...updated, _ghlSyncFailed: false };
}

export class ContactWriteConflictError extends Error {
  constructor() {
    super("CONTACT_WRITE_COMPARE_AND_SET_FAILED");
    this.name = "ContactWriteConflictError";
  }
}
