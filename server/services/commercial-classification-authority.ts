/**
 * BT-06 — Commercial Classification Authority
 *
 * The ONLY path for reading or changing a subject's commercial record_class.
 * All KPI, payout, and outbound dispatch code must go through this module
 * rather than reading or writing record_class directly.
 *
 * Vocabulary:
 *   production  — evidence-backed real commercial record
 *   test        — synthetic/QA contact created for automated testing
 *   demo        — demo/showcase record not representing real business
 *   synthetic   — system-generated synthetic data (lead-pool seeds, etc.)
 *   unknown     — default; unreviewed; quarantined from production metrics
 *
 * Kill lines enforced here:
 *   - unknown is never treated as production
 *   - class transitions require immutable append-only evidence
 *   - marketing_outreach is blocked for any class except production
 *   - transactional_response is allowed for unknown (newly submitted forms)
 *   - PII (SSN, EIN, bank data, email bodies) must never appear in evidenceFields
 */

import { db } from "../db";
import { sql } from "drizzle-orm";
import crypto from "crypto";
import { lockCommercialGraphNodes } from "./commercial-graph-locks";
import {
  COMMERCIAL_CLASS_VALUES,
  contacts,
  deals,
  prospects,
  companies,
  businesses,
  commercialClassificationEvents,
  CLASSIFICATION_POLICY_VERSION,
  type CommercialClass,
} from "@shared/schema";

// ── Types ────────────────────────────────────────────────────────────────────

export type ClassificationPurpose =
  | "marketing_outreach"
  | "commercial_reporting"
  | "financial_payout"
  | "transactional_response"
  | "internal_test";

export type ClassificationSubjectType =
  | "contact"
  | "deal"
  | "prospect"
  | "company"
  | "business";

export interface ClassificationAuthResult {
  allowed: boolean;
  recordClass: CommercialClass;
  purpose: ClassificationPurpose;
  reasonCode?: "COMMERCIAL_CLASS_UNKNOWN" | "COMMERCIAL_CLASS_NOT_PRODUCTION" | "COMMERCIAL_CLASS_CONFLICT";
  reason?: string;
}

export interface ClassificationCommand {
  subjectType: ClassificationSubjectType;
  subjectId: number;
  targetClass: CommercialClass;
  eventNamespace: string;
  eventKey: string;
  // evidenceFields: allowlisted non-PII fields describing why this classification
  // was chosen. Must NOT contain SSN, EIN, bank account numbers, document bodies,
  // email message bodies, raw import payloads, or any credentials.
  evidenceFields: Record<string, unknown>;
  actorId?: string;
  approverId?: string;
  /** Internal only: lets the fenced command workflow commit event and command
   * state in one database transaction. Never accepted from a route payload. */
  transaction?: any;
}

export interface ClassificationPreviewCommand {
  idempotencyKey: string;
  subjectType: ClassificationSubjectType;
  subjectId: number;
  targetClass: CommercialClass;
  evidenceFields: Record<string, unknown>;
  evidenceRefs: ClassificationEvidenceRef[];
  requestedBy?: string;
}

export type ClassificationEvidenceRef = {
  kind: "classification_event" | "contact_source_event" | "import_row_disposition"
    | "identity_observation" | "merge_operation" | "merge_redirect"
    | "business_link_decision" | "legacy_company_mapping_decision"
    | "relationship_review";
  id: string | number;
};

export interface ApproveCommandParams {
  commandId: string;
  approvedBy: string;
  versionLock: number;
}

// Evidence is deliberately an allowlist. Classification needs provenance, not
// copies of documents, imports, emails, credentials, or financial identifiers.
const EVIDENCE_FIELD_ALLOWLIST = new Set([
  "review_source",
  "verified_at",
  "evidence_reference",
  "external_reference",
  "source_system",
  "approval_basis",
  "classification_reason",
  "attestation_id",
  "ticket_id",
  "command_id",
]);

function assertNoPii(fields: Record<string, unknown>): void {
  if (Object.keys(fields).length === 0) {
    throw new Error("BT-06 kill line: classification evidence must include at least one allowlisted non-PII reference.");
  }
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[-\s]/g, "_");
    if (!EVIDENCE_FIELD_ALLOWLIST.has(normalizedKey)) {
      throw new Error(`BT-06 kill line: evidence field '${key}' is not allowlisted.`);
    }
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      /(?:\b\d{3}-?\d{2}-?\d{4}\b)|(?:\b\d{2}-?\d{7}\b)/.test(value)
    ) {
      throw new Error(`BT-06 kill line: evidence '${key}' must be a short non-PII reference string.`);
    }
  }
}

function hashEvidence(fields: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(fields, Object.keys(fields).sort()))
    .digest("hex");
}
function hashPreviewPayload(params: ClassificationPreviewCommand, dependencyFingerprint?: string | null): string {
  const evidenceRefs = [...params.evidenceRefs]
    .map(ref => ({ kind: ref.kind, id: String(ref.id) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return crypto.createHash("sha256").update(JSON.stringify({
    subjectType: params.subjectType, subjectId: params.subjectId, targetClass: params.targetClass,
    evidenceFields: Object.fromEntries(Object.entries(params.evidenceFields).sort()),
    evidenceRefs, policyVersion: CLASSIFICATION_POLICY_VERSION,
    dependencyFingerprint: dependencyFingerprint ?? null,
  })).digest("hex");
}

function assertCommercialClass(value: string): asserts value is CommercialClass {
  if (!(COMMERCIAL_CLASS_VALUES as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid commercial class '${value}'. Expected one of: ${COMMERCIAL_CLASS_VALUES.join(", ")}.`
    );
  }
}

function assertSubjectType(value: string): asserts value is ClassificationSubjectType {
  if (!["contact", "deal", "prospect", "company", "business"].includes(value)) {
    throw new Error(`Invalid classification subject type '${value}'.`);
  }
}

function rows(result: unknown): any[] {
  return ((result as { rows?: unknown[] })?.rows ?? []) as any[];
}

const CLASSIFICATION_GRAPH_DRIFT_RETRIES = 3;
async function withClassificationGraphDriftRetry<T>(
  run: (tx: any) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < CLASSIFICATION_GRAPH_DRIFT_RETRIES; attempt++) {
    try {
      return await db.transaction(run);
    } catch (error) {
      if ((error as Error).message !== "CRO02_GRAPH_DISCOVERY_DRIFT") throw error;
      if (attempt === CLASSIFICATION_GRAPH_DRIFT_RETRIES - 1) {
        throw new Error("CRO02_GRAPH_RETRY_EXHAUSTED");
      }
    }
  }
  throw new Error("CRO02_GRAPH_RETRY_EXHAUSTED");
}

async function validateTypedEvidence(
  tx: any,
  refs: ClassificationEvidenceRef[],
  requestedType: ClassificationSubjectType,
  requestedId: number,
  effectiveType: ClassificationSubjectType,
  effectiveId: number,
): Promise<void> {
  if (!refs.length) throw new Error("CLASSIFICATION_TYPED_EVIDENCE_REQUIRED");
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.kind}:${String(ref.id)}`;
    if (seen.has(key)) throw new Error("CLASSIFICATION_EVIDENCE_DUPLICATE");
    seen.add(key);
    let row: any;
    switch (ref.kind) {
      case "classification_event":
        row = rows(await tx.execute(sql`SELECT subject_type,subject_id FROM commercial_classification_events WHERE id=${Number(ref.id)} FOR UPDATE`))[0];
        break;
      case "contact_source_event":
        row = rows(await tx.execute(sql`SELECT 'contact' subject_type,contact_id subject_id FROM contact_source_events WHERE id=${Number(ref.id)} FOR UPDATE`))[0];
        break;
      case "import_row_disposition":
        row = rows(await tx.execute(sql`SELECT 'contact' subject_type,contact_id subject_id FROM import_row_dispositions WHERE id=${Number(ref.id)} FOR UPDATE`))[0];
        break;
      case "identity_observation":
        row = rows(await tx.execute(sql`SELECT 'contact' subject_type,contact_id subject_id FROM contact_identity_observations WHERE id=${String(ref.id)}::uuid AND superseded_at IS NULL FOR UPDATE`))[0];
        break;
      case "merge_operation":
        row = rows(await tx.execute(sql`SELECT 'contact' subject_type,survivor_contact_id subject_id,deprecated_contact_id alternate_id FROM contact_merge_operations WHERE id=${String(ref.id)}::uuid FOR UPDATE`))[0];
        break;
      case "merge_redirect":
        row = rows(await tx.execute(sql`SELECT 'contact' subject_type,survivor_contact_id subject_id,deprecated_contact_id alternate_id FROM contact_merge_redirects WHERE id=${String(ref.id)}::uuid AND active FOR UPDATE`))[0];
        break;
      case "business_link_decision":
        row = rows(await tx.execute(sql`SELECT 'contact' subject_type,contact_id subject_id,'business' alternate_type,business_id alternate_id FROM contact_business_link_decisions WHERE id=${String(ref.id)}::uuid AND superseded_at IS NULL FOR UPDATE`))[0];
        break;
      case "legacy_company_mapping_decision":
        row = rows(await tx.execute(sql`SELECT 'company' subject_type,company_id subject_id,'business' alternate_type,business_id alternate_id FROM legacy_company_mapping_decisions WHERE id=${String(ref.id)}::uuid AND superseded_at IS NULL FOR UPDATE`))[0];
        break;
      case "relationship_review":
        row = rows(await tx.execute(sql`SELECT 'contact' subject_type,contact_id subject_id,'business' alternate_type,business_id alternate_id FROM commercial_relationship_reviews WHERE id=${String(ref.id)}::uuid AND superseded_at IS NULL FOR UPDATE`))[0];
        break;
    }
    if (!row) throw new Error("CLASSIFICATION_EVIDENCE_MISSING");
    const matches = (row.subject_type === requestedType && Number(row.subject_id) === requestedId)
      || (row.subject_type === effectiveType && Number(row.subject_id) === effectiveId)
      || (row.alternate_type === requestedType && Number(row.alternate_id) === requestedId)
      || (row.alternate_type === effectiveType && Number(row.alternate_id) === effectiveId)
      || (requestedType === "contact" && Number(row.alternate_id) === requestedId)
      || (effectiveType === "contact" && Number(row.alternate_id) === effectiveId);
    if (!matches) throw new Error("CLASSIFICATION_EVIDENCE_SUBJECT_MISMATCH");
  }
}

// ── Current class lookup ─────────────────────────────────────────────────────

/**
 * Read the current record_class for a subject directly from the root table.
 * Returns 'unknown' if the subject does not exist or has no class set.
 */
export async function getCurrentClass(
  subjectType: ClassificationSubjectType,
  subjectId: number
): Promise<CommercialClass> {
  switch (subjectType) {
    case "contact": {
      const [row] = await db.select({ recordClass: contacts.recordClass }).from(contacts).where(sql`${contacts.id} = ${subjectId}`).limit(1);
      return (row?.recordClass as CommercialClass | undefined) ?? "unknown";
    }
    case "deal": {
      const [row] = await db.select({ recordClass: deals.recordClass }).from(deals).where(sql`${deals.id} = ${subjectId}`).limit(1);
      return (row?.recordClass as CommercialClass | undefined) ?? "unknown";
    }
    case "prospect": {
      const [row] = await db.select({ recordClass: prospects.recordClass }).from(prospects).where(sql`${prospects.id} = ${subjectId}`).limit(1);
      return (row?.recordClass as CommercialClass | undefined) ?? "unknown";
    }
    case "company": {
      const [row] = await db.select({ recordClass: companies.recordClass }).from(companies).where(sql`${companies.id} = ${subjectId}`).limit(1);
      return (row?.recordClass as CommercialClass | undefined) ?? "unknown";
    }
    case "business": {
      const [row] = await db.select({ recordClass: businesses.recordClass }).from(businesses).where(sql`${businesses.id} = ${subjectId}`).limit(1);
      return (row?.recordClass as CommercialClass | undefined) ?? "unknown";
    }
  }
}

// ── Purpose-aware authorization gate ─────────────────────────────────────────

/**
 * authorizeUse — the canonical purpose-aware classification gate.
 *
 * Must be called before evaluateContactability() at every marketing/outreach
 * dispatch boundary. Returns fail-closed for unknown purposes.
 *
 * Purpose semantics:
 *   marketing_outreach    — ONLY production allowed; blocks unknown/test/demo/synthetic
 *   commercial_reporting  — ONLY production counts in metrics; blocks others
 *   financial_payout      — ONLY production included in payouts
 *   transactional_response — allows unknown (newly-submitted form contacts); blocks non-production
 *   internal_test         — test-only harness work; never permitted in a
 *                           non-test process
 */
export async function authorizeUse(params: {
  contactId?: number;
  subjectType?: ClassificationSubjectType;
  subjectId?: number;
  purpose: ClassificationPurpose;
}): Promise<ClassificationAuthResult> {
  const { purpose } = params;

  // `internal_test` must never become a production escape hatch. It exists only
  // for isolated test harnesses, whose database is separately verified before
  // application imports. A caller-controlled purpose string is not sufficient
  // authorization outside NODE_ENV=test.
  if (purpose === "internal_test") {
    if (process.env.NODE_ENV !== "test") {
      return {
        allowed: false,
        recordClass: "unknown",
        purpose,
        reasonCode: "COMMERCIAL_CLASS_CONFLICT",
        reason: "internal_test authorization is available only in NODE_ENV=test",
      };
    }
    return {
      allowed: true,
      recordClass: "unknown",
      purpose,
    };
  }

  const subjectType = params.subjectType ?? "contact";
  const subjectId = params.subjectId ?? params.contactId;

  if (!subjectId) {
    return {
      allowed: false,
      recordClass: "unknown",
      purpose,
      reasonCode: "COMMERCIAL_CLASS_UNKNOWN",
      reason: "No subject ID provided to authorizeUse",
    };
  }

  let recordClass: CommercialClass;
  try {
    recordClass = await getCurrentClass(subjectType, subjectId);
  } catch {
    // Fail closed on DB errors
    return {
      allowed: false,
      recordClass: "unknown",
      purpose,
      reasonCode: "COMMERCIAL_CLASS_CONFLICT",
      reason: "Classification lookup failed — failing closed",
    };
  }

  // Transactional response: allow unknown (form submissions), block everything else non-production
  if (purpose === "transactional_response") {
    if (recordClass === "production" || recordClass === "unknown") {
      return { allowed: true, recordClass, purpose };
    }
    return {
      allowed: false,
      recordClass,
      purpose,
      reasonCode: "COMMERCIAL_CLASS_NOT_PRODUCTION",
      reason: `Transactional response blocked for class '${recordClass}' — only production and unknown are permitted`,
    };
  }

  // All other purposes require production class
  if (recordClass !== "production") {
    if (recordClass === "unknown") {
      return {
        allowed: false,
        recordClass,
        purpose,
        reasonCode: "COMMERCIAL_CLASS_UNKNOWN",
        reason: `Subject is unclassified (unknown) — must be promoted to production before ${purpose}`,
      };
    }
    return {
      allowed: false,
      recordClass,
      purpose,
      reasonCode: "COMMERCIAL_CLASS_NOT_PRODUCTION",
      reason: `Commercial class '${recordClass}' is not eligible for ${purpose}`,
    };
  }

  return { allowed: true, recordClass, purpose };
}

// ── Classification transitions (human production requires independent review) ──

/**
 * Private canonical write path for classification events. Only the public
 * human command and the evidence-gated Sunbiz policy below may reach it.
 *
 * Idempotent: if (eventNamespace, eventKey) already exists, returns the
 * existing event without re-applying. Caller must verify evidence before calling.
 *
 * Human role requirements are enforced by the public applyClassification caller.
 */
async function applyClassificationWithPolicy(
  command: ClassificationCommand,
  authorizationPolicy: "independent_reviewer" | "verified_sunbiz_bootstrap" | "verified_import_link" | "verified_first_party_link" = "independent_reviewer",
): Promise<{ eventId: number; applied: boolean; duplicate: boolean }> {
  assertSubjectType(command.subjectType);
  assertCommercialClass(command.targetClass);
  assertNoPii(command.evidenceFields);
  if (
    authorizationPolicy === "independent_reviewer" &&
    command.targetClass === "production" &&
    (!command.actorId || !command.approverId || command.approverId === command.actorId)
  ) {
    throw new Error(
      "Production classification requires a distinct authorized approver and immutable evidence."
    );
  }

  const evidenceHash = hashEvidence(command.evidenceFields);

  const applyInTransaction = async (tx: any) => {
    const graphNodes: Array<{ type: ClassificationSubjectType; id: number }> = [{
      type: command.subjectType,
      id: command.subjectId,
    }];
    let dealRootHint: { contactId: number | null; companyId: number | null } | null = null;
    if (command.targetClass === "production" && command.subjectType === "deal") {
      const hint = rows(await tx.execute(sql`SELECT contact_id,company_id FROM deals
        WHERE id=${command.subjectId}`))[0];
      if (hint) {
        dealRootHint = {
          contactId: hint.contact_id == null ? null : Number(hint.contact_id),
          companyId: hint.company_id == null ? null : Number(hint.company_id),
        };
        if (dealRootHint.contactId) graphNodes.push({ type: "contact", id: dealRootHint.contactId });
        if (dealRootHint.companyId) graphNodes.push({ type: "company", id: dealRootHint.companyId });
      }
    }
    await lockCommercialGraphNodes(tx, graphNodes);
    if (dealRootHint) {
      const current = rows(await tx.execute(sql`SELECT contact_id,company_id FROM deals
        WHERE id=${command.subjectId} FOR UPDATE`))[0];
      if (!current ||
          Number(current.contact_id ?? 0) !== Number(dealRootHint.contactId ?? 0) ||
          Number(current.company_id ?? 0) !== Number(dealRootHint.companyId ?? 0)) {
        throw new Error("CLASSIFICATION_GRAPH_STALE");
      }
    }
    // The event key is globally unique, not unique per subject. Lock it before
    // looking up or changing a root so conflicting reuse on different subjects
    // cannot leave an unjournaled projection update behind.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`${command.eventNamespace}:${command.eventKey}`}))
    `);

    // A same replay returns duplicate; a same key with different commercial
    // facts is an error before any projection can be changed.
    const existing = rows(await tx.execute(sql`
      SELECT id, subject_type, subject_id, new_class, evidence_hash, actor_id, approver_id
      FROM commercial_classification_events
      WHERE event_namespace = ${command.eventNamespace}
        AND event_key = ${command.eventKey}
      LIMIT 1
    `))[0];

    if (existing) {
      const matches =
        existing.subject_type === command.subjectType &&
        Number(existing.subject_id) === command.subjectId &&
        existing.new_class === command.targetClass &&
        existing.evidence_hash === evidenceHash &&
        (existing.actor_id ?? null) === (command.actorId ?? null) &&
        (existing.approver_id ?? null) === (command.approverId ?? null);
      if (!matches) {
        throw new Error("Classification idempotency key collision: replay payload differs from the immutable event.");
      }
      return { eventId: existing.id as number, applied: false, duplicate: true };
    }

    // Lock and verify the real root only after the global event-key reservation.
    const priorClass = await getCurrentClassInTransaction(tx, command.subjectType, command.subjectId);
    if (command.targetClass === "production") {
      const linkedClasses = await getLinkedClassesInTransaction(tx, command.subjectType, command.subjectId);
      if (command.subjectType === "deal" && linkedClasses.length === 0) {
        throw new Error(
          "COMMERCIAL_REQUIRED_ROOT_MISSING: production promotion requires at least one linked commercial root."
        );
      }
      if (linkedClasses.some((value) => value !== "production")) {
        throw new Error(
          "COMMERCIAL_CLASS_CONFLICT: production promotion requires every linked commercial root to be independently classified production."
        );
      }
    }

    // Update first. The event insertion below is in the same transaction, so
    // a failed immutable event rolls this projection back with no silent drift.
    await applyClassToSubject(tx, command.subjectType, command.subjectId, command.targetClass as CommercialClass);
    await tx.execute(sql`INSERT INTO commercial_subject_revisions
      (subject_type,subject_id,revision,authority_version,updated_at)
      VALUES(${command.subjectType},${command.subjectId},1,1,now())
      ON CONFLICT(subject_type,subject_id) DO UPDATE
      SET revision=commercial_subject_revisions.revision+1,updated_at=now()`);

    // Insert immutable event only after the subject projection has changed.
    const [event] = rows(await tx.execute(sql`
      INSERT INTO commercial_classification_events
        (subject_type, subject_id, event_namespace, event_key, policy_version,
         prior_class, new_class, evidence_hash, evidence_fields, actor_id, approver_id, created_at)
      VALUES
        (${command.subjectType}, ${command.subjectId}, ${command.eventNamespace},
         ${command.eventKey}, ${CLASSIFICATION_POLICY_VERSION},
         ${priorClass}, ${command.targetClass}, ${evidenceHash},
         ${JSON.stringify(command.evidenceFields)}::jsonb,
         ${command.actorId ?? null}, ${command.approverId ?? null}, now())
      RETURNING id
    `));

    if (!event) {
      // The advisory lock makes this impossible for authority callers. Throwing
      // rolls back the projection if an out-of-band writer races us.
      throw new Error("Could not reserve immutable commercial classification event.");
    }

    return { eventId: event.id as number, applied: true, duplicate: false };
  };
  return command.transaction
    ? applyInTransaction(command.transaction)
    : db.transaction(applyInTransaction);
}

/**
 * Public human-reviewed classification path. Automated source initialization
 * uses its own narrowly scoped database-evidence policy below.
 */
export async function applyClassification(
  command: ClassificationCommand
): Promise<{ eventId: number; applied: boolean; duplicate: boolean }> {
  return applyClassificationWithPolicy(command, "independent_reviewer");
}

/** Internal automatic initial classification, not a general promotion API.
 * Both original provider-row provenance and an independently verified current
 * canonical affiliation are required. Existing test/demo/synthetic classes are
 * never promoted; a CSV email/provider validity claim alone proves nothing. */
export async function initializeImportedLinkedContactClass(contactId:number,authorityCheck?:(tx:any)=>Promise<boolean>) {
  return db.transaction(async tx=>{
    const hint=rows(await tx.execute(sql`SELECT business_id FROM contacts WHERE id=${contactId}`))[0];
    if (!hint?.business_id) return {applied:false,reason:"INDEPENDENT_BUSINESS_LINK_REQUIRED"};
    // An unlinked row has nothing to promote; don't take the singleton owner
    // lock for this read-only hold. Every possible mutation still pins it first.
    if (authorityCheck && !await authorityCheck(tx)) throw new Error("CANONICAL_IMPORTED_CLASS_AUTHORITY_FENCE_LOST");
    await lockCommercialGraphNodes(tx,[
      {type:"contact",id:contactId},{type:"business",id:Number(hint.business_id)},
    ]);
    const proof=rows(await tx.execute(sql`SELECT c.email,c.record_class,c.business_id,e.id event_id,
      e.import_execution_id,e.source_row_number,e.row_fingerprint,o.payload->'rawSourceRow' raw_row
      FROM contacts c JOIN businesses b ON b.id=c.business_id AND b.record_class='canonical'
      JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.business_id=c.business_id
        AND d.decision='verified' AND d.superseded_at IS NULL
      JOIN contact_source_events e ON e.contact_id=c.id AND e.source_category='csv_import'
        AND e.source_type IN ('outscraper','apollo')
      JOIN import_row_dispositions accounting ON accounting.execution_id=e.import_execution_id
        AND accounting.source_row_number=e.source_row_number
        AND accounting.row_fingerprint=e.row_fingerprint
         AND (accounting.disposition IN ('created','matched_noop') OR (
           accounting.disposition='deferred' AND EXISTS(
             SELECT 1 FROM cro03_enrichment_items recovered
             JOIN cro03_enrichment_batches recovered_batch ON recovered_batch.id=recovered.batch_id
             WHERE recovered.id::text=e.metadata->>'canonicalRecoveryItemId'
               AND recovered_batch.idempotency_key=
                 'csv-source:'||e.import_execution_id::text||':'||e.source_row_number::text
               AND ((recovered.state='running' AND recovered.current_provider='canonical_local_import'
                 AND recovered.lease_expires_at>clock_timestamp())
                 OR (recovered.state='completed' AND recovered.terminal_code='CANONICAL_LOCAL_IMPORT_FULFILLED'))
           )))
      JOIN cro03_enrichment_batches batch ON batch.idempotency_key=
        'csv-source-raw-v2:'||e.import_execution_id::text||':'||e.source_row_number::text
      JOIN cro03_batch_memberships member ON member.batch_id=batch.id
      JOIN cro03_source_observations o ON o.id=member.source_observation_id
        AND o.payload->>'rowFingerprint'=e.row_fingerprint
      WHERE c.id=${contactId} AND c.business_id=${Number(hint.business_id)}
        AND c.archived_at IS NULL ORDER BY e.id LIMIT 1`))[0];
    if (!proof || proof.record_class!=="unknown") return {applied:false,reason:"INITIAL_CLASS_OR_SOURCE_PROOF_REQUIRED"};
    const {providerImportEmails}=await import("./canonical-provider-import");
    if (!providerImportEmails(proof.raw_row ?? {}).includes(String(proof.email).trim().toLowerCase())) {
      return {applied:false,reason:"RETAINED_SOURCE_EMAIL_PROOF_REQUIRED"};
    }
    return applyClassificationWithPolicy({
      subjectType:"contact",subjectId:contactId,targetClass:"production",
      eventNamespace:"canonical_verified_import_link",
      eventKey:`${proof.import_execution_id}:${proof.source_row_number}:${contactId}:${proof.row_fingerprint}`,
      actorId:"system:canonical-verified-import-link",
      evidenceFields:{
        review_source:"verified_provider_import_link",
        evidence_reference:`contact-source-event:${proof.event_id}`,
        external_reference:`${proof.import_execution_id}:${proof.source_row_number}:${proof.row_fingerprint}`,
        source_system:"canonical_provider_import",
        approval_basis:"original_source_email_and_independently_verified_canonical_business",
        classification_reason:"initial_production_class_of_verified_imported_contact",
      },transaction:tx,
    },"verified_import_link");
  });
}

/** Internal automatic initial classification for a contact created from a
 * business's own published address. Requires the current verified first-party
 * link decision (immutable evidence row) to the contact's current business.
 * It never promotes test/demo/synthetic rows and is not a general promotion API. */
export async function initializeFirstPartyLinkedContactClass(contactId:number,tx:any) {
  const proof=rows(await tx.execute(sql`SELECT c.record_class,c.business_id,d.id decision_id,
      e.id evidence_id,e.candidate_id
    FROM contacts c JOIN businesses b ON b.id=c.business_id AND b.record_class='canonical'
    JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.business_id=c.business_id
      AND d.decision='verified' AND d.superseded_at IS NULL
    JOIN contact_business_first_party_link_evidence e ON e.id=d.first_party_evidence_id
      AND e.contact_id=c.id AND e.business_id=c.business_id
    WHERE c.id=${contactId} AND c.archived_at IS NULL LIMIT 1`))[0];
  if (!proof) return {applied:false,reason:"FIRST_PARTY_LINK_REQUIRED"};
  if (proof.record_class!=="unknown") return {applied:false,reason:"INITIAL_CLASS_ALREADY_SET"};
  return applyClassificationWithPolicy({
    subjectType:"contact",subjectId:contactId,targetClass:"production",
    eventNamespace:"first_party_staged_email_link",
    eventKey:`${contactId}:${proof.decision_id}`,
    actorId:"system:first-party-staged-email-link",
    evidenceFields:{
      review_source:"verified_first_party_link",
      evidence_reference:`link-decision:${proof.decision_id}`,
      external_reference:`free-discovery-candidate:${proof.candidate_id}`,
      source_system:"free_discovery",
      approval_basis:"business_published_address_and_verified_exact_business_link",
      classification_reason:"initial_production_class_of_verified_first_party_contact",
    },transaction:tx,
  },"verified_first_party_link");
}

export interface SunbizBootstrapClassificationParams {
  businessId: number;
  filingNumber: string;
  /** The claim's compare-and-swap lease for a new bootstrap result. */
  claimLease?: unknown;
  /** Repair is limited to an already completed created-claim cohort. */
  claimMode: "active_lease" | "completed_bootstrap";
  transaction?: any;
}

export interface SunbizBootstrapClassificationResult {
  decision: "initialized" | "quarantined" | "preserved";
  recordClass: CommercialClass;
  reasonCode?: string;
  eventId?: number;
  applied?: boolean;
}

function normalizeBootstrapName(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeBootstrapDomain(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const hostname = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return hostname.includes(".") ? hostname : null;
  } catch {
    return null;
  }
}

function normalizeBootstrapPhone(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function matchedBootstrapIdentity(
  source: {
    website: string | null;
    phone: string | null;
    principal_city: string | null;
    principal_state: string | null;
  },
  business: {
    website_domain: string | null;
    main_phone: string | null;
    city: string | null;
    state: string | null;
  },
): boolean {
  const sourceDomain = normalizeBootstrapDomain(source.website);
  const businessDomain = normalizeBootstrapDomain(business.website_domain);
  if (sourceDomain && sourceDomain === businessDomain) return true;

  const sourcePhone = normalizeBootstrapPhone(source.phone);
  const businessPhone = normalizeBootstrapPhone(business.main_phone);
  if (sourcePhone.length >= 7 && sourcePhone === businessPhone) return true;

  return Boolean(
    source.principal_city?.trim() &&
      source.principal_state?.trim() &&
      source.principal_city.trim().toLowerCase() === business.city?.trim().toLowerCase() &&
      source.principal_state.trim().toLowerCase() === business.state?.trim().toLowerCase(),
  );
}

/**
 * Narrow automated initialization policy for verified Sunbiz bootstrap
 * outcomes. This does not relax applyClassification(): human production
 * transitions still require distinct requester/approver identities.
 *
 * The only production decision is based on a locked claim (current lease for
 * a new result, or the exact completed-created cohort for repair), its matching
 * Sunbiz entity, a verified source link to this business, meaningful matching
 * identity facts, a nonblank matching name, and current hot/warm source status.
 * Failed proof returns an explicit quarantine decision without changing the
 * unknown projection or fabricating an approver.
 */
export async function initializeSunbizBootstrapBusinessClass(
  params: SunbizBootstrapClassificationParams,
): Promise<SunbizBootstrapClassificationResult> {
  const run = async (tx: any): Promise<SunbizBootstrapClassificationResult> => {
    if (
      (params.claimMode !== "active_lease" && params.claimMode !== "completed_bootstrap") ||
      !params.filingNumber?.trim()
    ) {
      return { decision: "quarantined", recordClass: "unknown", reasonCode: "SUNBIZ_CLASSIFICATION_CLAIM_UNVERIFIED" };
    }
    if (params.claimMode === "active_lease" && params.claimLease == null) {
      return { decision: "quarantined", recordClass: "unknown", reasonCode: "SUNBIZ_CLASSIFICATION_CLAIM_UNVERIFIED" };
    }
    await lockCommercialGraphNodes(tx, [{ type: "business", id: params.businessId }]);
    const business = rows(await tx.execute(sql`
      SELECT id, record_class, canonical_name, website_domain, main_phone, city, state
      FROM businesses WHERE id = ${params.businessId} FOR UPDATE
    `))[0] as {
      id: number;
      record_class: string;
      canonical_name: string;
      website_domain: string | null;
      main_phone: string | null;
      city: string | null;
      state: string | null;
    } | undefined;
    if (!business) {
      return { decision: "quarantined", recordClass: "unknown", reasonCode: "SUNBIZ_CLASSIFICATION_SUBJECT_MISSING" };
    }
    if (business.record_class !== "unknown") {
      const existingClass = (COMMERCIAL_CLASS_VALUES as readonly string[]).includes(business.record_class)
        ? business.record_class as CommercialClass
        : "unknown";
      return { decision: "preserved", recordClass: existingClass, reasonCode: "SUNBIZ_CLASSIFICATION_SUBJECT_NOT_UNKNOWN" };
    }

    const claim = params.claimMode === "active_lease"
      ? rows(await tx.execute(sql`
          SELECT id, sunbiz_entity_id FROM sunbiz_bootstrap_claims
          WHERE filing_number = ${params.filingNumber}
            AND status = 'claimed'
            AND claimed_at = ${params.claimLease}
            AND business_id IS NULL
          FOR UPDATE
        `))[0]
      : rows(await tx.execute(sql`
          SELECT id, sunbiz_entity_id FROM sunbiz_bootstrap_claims
          WHERE filing_number = ${params.filingNumber}
            AND status = 'created'
            AND business_id = ${params.businessId}
          FOR UPDATE
        `))[0];
    if (!claim || claim.sunbiz_entity_id == null) {
      return { decision: "quarantined", recordClass: "unknown", reasonCode: "SUNBIZ_CLASSIFICATION_CLAIM_UNVERIFIED" };
    }

    const source = rows(await tx.execute(sql`
      SELECT id, filing_number, score, entity_name, website, phone, principal_city, principal_state
      FROM sunbiz_entities
      WHERE id = ${Number(claim.sunbiz_entity_id)}
        AND filing_number = ${params.filingNumber}
      FOR UPDATE
    `))[0] as {
      id: number;
      filing_number: string;
      score: string | null;
      entity_name: string | null;
      website: string | null;
      phone: string | null;
      principal_city: string | null;
      principal_state: string | null;
    } | undefined;
    if (!source) {
      return { decision: "quarantined", recordClass: "unknown", reasonCode: "SUNBIZ_CLASSIFICATION_SOURCE_UNVERIFIED" };
    }

    const lineage = rows(await tx.execute(sql`
      SELECT business_id FROM canonical_source_links
      WHERE source_system = 'sunbiz'
        AND source_type = 'sunbiz_entity'
        AND stable_key = ${params.filingNumber}
      FOR UPDATE
    `))[0] as { business_id: number } | undefined;
    if (!lineage || Number(lineage.business_id) !== params.businessId) {
      return { decision: "quarantined", recordClass: "unknown", reasonCode: "SUNBIZ_CLASSIFICATION_LINEAGE_UNVERIFIED" };
    }

    const sourceName = normalizeBootstrapName(source.entity_name);
    const businessName = normalizeBootstrapName(business.canonical_name);
    const sourceDomain = normalizeBootstrapDomain(source.website);
    const sourcePhone = normalizeBootstrapPhone(source.phone);
    const hasMeaningfulSourceIdentity = Boolean(
      sourceDomain ||
        sourcePhone.length >= 7 ||
        (source.principal_city?.trim() && source.principal_state?.trim()),
    );
    if (
      !sourceName ||
      !businessName ||
      sourceName !== businessName ||
      !(source.score === "hot" || source.score === "warm") ||
      !hasMeaningfulSourceIdentity ||
      !matchedBootstrapIdentity(source, business)
    ) {
      return { decision: "quarantined", recordClass: "unknown", reasonCode: "SUNBIZ_CLASSIFICATION_EVIDENCE_INSUFFICIENT" };
    }

    const filingReference = crypto.createHash("sha256").update(params.filingNumber).digest("hex").slice(0, 24);
    const command: ClassificationCommand = {
      subjectType: "business",
      subjectId: params.businessId,
      targetClass: "production",
      eventNamespace: "sunbiz_bootstrap",
      eventKey: `business:${params.businessId}:filing-ref:${filingReference}`,
      evidenceFields: {
        source_system: "sunbiz_bootstrap",
        external_reference: `sunbiz-filing-ref:${filingReference}`,
        classification_reason: "verified_sunbiz_bootstrap_evidence",
        review_source: "sunbiz_bootstrap_evidence_policy_v1",
      },
      actorId: "service:sunbiz_bootstrap",
      // No approver: this is a separately validated automated source policy,
      // not a human-reviewed production promotion.
      transaction: tx,
    };
    const receipt = await applyClassificationWithPolicy(command, "verified_sunbiz_bootstrap");
    const projection = rows(await tx.execute(sql`
      SELECT record_class FROM businesses WHERE id = ${params.businessId} FOR UPDATE
    `))[0] as { record_class: string } | undefined;
    if (projection?.record_class !== "production") {
      return {
        decision: "quarantined",
        recordClass: "unknown",
        reasonCode: "SUNBIZ_CLASSIFICATION_PROJECTION_UNVERIFIED",
        eventId: receipt.eventId,
        applied: false,
      };
    }
    return {
      decision: "initialized",
      recordClass: "production",
      eventId: receipt.eventId,
      applied: receipt.applied,
    };
  };

  return params.transaction ? run(params.transaction) : db.transaction(run);
}

/** Resolve an inherited class for a new deal. Any absent or disagreeing source
 * remains quarantined; production is inherited only from verified production roots. */
export async function deriveLinkedDealClass(
  contactId?: number | null,
  companyId?: number | null,
): Promise<CommercialClass> {
  const classes: CommercialClass[] = [];
  if (contactId) classes.push(await getCurrentClass("contact", contactId));
  if (companyId) classes.push(await getCurrentClass("company", companyId));
  return classes.length > 0 && classes.every((value) => value === "production")
    ? "production"
    : "unknown";
}

/**
 * Transaction-scoped counterpart to deriveLinkedDealClass.
 *
 * Creation authorities which already own a transaction must use this version:
 * using the global reader here would permit a classification decision from a
 * different snapshot than the subsequent deal insert.
 */
export async function deriveLinkedDealClassInTransaction(
  tx: any,
  contactId?: number | null,
  companyId?: number | null,
): Promise<CommercialClass> {
  const classes: CommercialClass[] = [];

  if (contactId) {
    const contact = rows(await tx.execute(sql`
      SELECT record_class
      FROM contacts
      WHERE id = ${contactId}
      FOR UPDATE
    `))[0];
    if (contact) classes.push((contact.record_class as CommercialClass | undefined) ?? "unknown");
  }

  if (companyId) {
    const company = rows(await tx.execute(sql`
      SELECT record_class
      FROM companies
      WHERE id = ${companyId}
      FOR UPDATE
    `))[0];
    if (company) classes.push((company.record_class as CommercialClass | undefined) ?? "unknown");
  }

  return classes.length > 0 && classes.every((value) => value === "production")
    ? "production"
    : "unknown";
}

async function getLinkedClassesInTransaction(
  tx: any,
  subjectType: ClassificationSubjectType,
  subjectId: number,
): Promise<CommercialClass[]> {
  if (subjectType === "deal") {
    const row = rows(await tx.execute(sql`
      SELECT c.record_class AS contact_class, co.record_class AS company_class
      FROM deals d
      LEFT JOIN contacts c ON c.id = d.contact_id
      LEFT JOIN companies co ON co.id = d.company_id
      WHERE d.id = ${subjectId}
      FOR UPDATE OF d
    `))[0];
    return [row?.contact_class, row?.company_class]
      .filter((value): value is CommercialClass => typeof value === "string");
  }
  if (subjectType === "prospect") {
    const row = rows(await tx.execute(sql`
      SELECT c.record_class AS contact_class
      FROM prospects p LEFT JOIN contacts c ON c.id = p.contact_id
      WHERE p.id = ${subjectId} FOR UPDATE OF p
    `))[0];
    return typeof row?.contact_class === "string" ? [row.contact_class as CommercialClass] : [];
  }
  return [];
}

async function getCurrentClassInTransaction(
  tx: any,
  subjectType: ClassificationSubjectType,
  subjectId: number
): Promise<CommercialClass> {
  const tableName = {
    contact: "contacts",
    deal: "deals",
    prospect: "prospects",
    company: "companies",
    business: "businesses",
  }[subjectType];
  const result = rows(await tx.execute(sql`
    SELECT record_class FROM ${sql.identifier(tableName)}
    WHERE id = ${subjectId}
    FOR UPDATE
  `))[0];
  if (!result) {
    throw new Error(`Commercial classification subject ${subjectType}:${subjectId} does not exist.`);
  }
  return (result.record_class as CommercialClass | undefined) ?? "unknown";
}

async function applyClassToSubject(
  tx: any,
  subjectType: ClassificationSubjectType,
  subjectId: number,
  newClass: CommercialClass
): Promise<void> {
  let updated: any[];
  switch (subjectType) {
    case "contact":
      updated = rows(await tx.execute(sql`UPDATE contacts SET record_class = ${newClass} WHERE id = ${subjectId} RETURNING id`));
      break;
    case "deal":
      updated = rows(await tx.execute(sql`UPDATE deals SET record_class = ${newClass} WHERE id = ${subjectId} RETURNING id`));
      break;
    case "prospect":
      updated = rows(await tx.execute(sql`UPDATE prospects SET record_class = ${newClass} WHERE id = ${subjectId} RETURNING id`));
      break;
    case "company":
      updated = rows(await tx.execute(sql`UPDATE companies SET record_class = ${newClass} WHERE id = ${subjectId} RETURNING id`));
      break;
    case "business":
      updated = rows(await tx.execute(sql`UPDATE businesses SET record_class = ${newClass} WHERE id = ${subjectId} RETURNING id`));
      break;
  }
  if (!updated?.length) {
    throw new Error(`Commercial classification subject ${subjectType}:${subjectId} disappeared before update.`);
  }
}

// ── Preview/approve/execute workflow ─────────────────────────────────────────

/**
 * createPreviewCommand — creates a preview command for admin review before execution.
 * Returns 409 if versionLock conflicts with existing command status.
 */
export async function createPreviewCommand(
  params: ClassificationPreviewCommand
): Promise<{ commandId: string; status: "created" | "duplicate" }> {
  assertNoPii(params.evidenceFields);
  assertSubjectType(params.subjectType);
  assertCommercialClass(params.targetClass);
  // Preview captures the current graph vector rather than letting approval or
  // execution silently use a later graph. The resolver is shadow-only here;
  // its result cannot change the legacy classification transition semantics.
  const { resolveCommercialGraph } = await import("./commercial-resolution");
  return withClassificationGraphDriftRetry(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`classification:${params.idempotencyKey}`}))`);
    const graph = await resolveCommercialGraph({
      subjectType: params.subjectType, subjectId: params.subjectId,
      effect: "commercial_reporting", persist: true, transaction: tx,
    });
    if (graph.reasonCodes.includes("SUBJECT_MISSING")) throw new Error("CLASSIFICATION_SUBJECT_MISSING");
    if (params.targetClass === "production" && params.subjectType === "deal") {
      const linkedClasses = await getLinkedClassesInTransaction(tx, params.subjectType, params.subjectId);
      if (linkedClasses.length === 0 || linkedClasses.some(value => value !== "production")) {
        throw new Error("CLASSIFICATION_GRAPH_QUARANTINED");
      }
    }
    if (graph.policyVersion !== 1 || !graph.policyFingerprint) throw new Error("CLASSIFICATION_PURPOSE_POLICY_INVALID");
    if (params.targetClass === "production" && (
      graph.reasonCodes.includes("STALE_GRAPH") ||
      graph.reasonCodes.includes("REDIRECT_UNRESOLVED") ||
      (params.subjectType === "deal" && (
        graph.reasonCodes.includes("REQUIRED_LINK_MISSING") ||
        graph.reasonCodes.includes("DANGLING_LINK") ||
        graph.reasonCodes.includes("ROOT_CLASS_CONFLICT")
      ))
    )) throw new Error("CLASSIFICATION_GRAPH_QUARANTINED");
    await validateTypedEvidence(tx, params.evidenceRefs, params.subjectType, params.subjectId,
      graph.effectiveSubjectType, graph.effectiveSubjectId);
    const payloadHash = hashPreviewPayload(params, graph.dependencyFingerprint);
    const inserted = rows(await tx.execute(sql`INSERT INTO commercial_classification_commands
      (idempotency_key,subject_type,subject_id,target_class,status,requested_by,evidence_fields,evidence_refs,
       payload_hash,preview_dependency_fingerprint,purpose_policy_fingerprint,policy_version,version_lock)
      VALUES(${params.idempotencyKey}::uuid,${params.subjectType},${params.subjectId},${params.targetClass},
       'preview',${params.requestedBy ?? null},${JSON.stringify(params.evidenceFields)}::jsonb,
       ${JSON.stringify(params.evidenceRefs)}::jsonb,${payloadHash},${graph.dependencyFingerprint},${graph.policyFingerprint},
       ${CLASSIFICATION_POLICY_VERSION},0)
      ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`));
    if (inserted.length) return { commandId: String(inserted[0].id), status: "created" as const };
    const existing = rows(await tx.execute(sql`SELECT id,payload_hash FROM commercial_classification_commands
      WHERE idempotency_key=${params.idempotencyKey}::uuid FOR UPDATE`))[0];
    if (!existing || existing.payload_hash !== payloadHash) throw new Error("CLASSIFICATION_COMMAND_REPLAY_DIVERGENT");
    return { commandId: String(existing.id), status: "duplicate" as const };
  });
}

/**
 * approveCommand — admin-role gate; moves command from preview → approved.
 * Uses optimistic version locking; returns 409 on stale version.
 */
export async function approveCommand(
  params: ApproveCommandParams
): Promise<{ approved: boolean; conflict: boolean }> {
  const result = rows(await db.execute(sql`
    UPDATE commercial_classification_commands
    SET status = 'approved',
        approved_by = ${params.approvedBy},
        approved_at = now(),
        version_lock = version_lock + 1,
        updated_at = now()
    WHERE id = ${params.commandId}
      AND version_lock = ${params.versionLock}
      AND status = 'preview'
       AND (requested_by IS NULL OR requested_by <> ${params.approvedBy})
    RETURNING id
  `));

  if (result.length === 0) {
    return { approved: false, conflict: true };
  }
  return { approved: true, conflict: false };
}

/**
 * executeApprovedCommand — executes an approved command, producing a classification event.
 * Idempotent: safe to retry on network failure.
 */
export async function executeApprovedCommand(
  commandId: string,
  actorId: string
): Promise<{ executed: boolean; eventId?: number; reason?: string }> {
  return withClassificationGraphDriftRetry(async (tx) => {
    await tx.execute(sql`SELECT * FROM commercial_shadow_controls WHERE control_key='commercial' FOR UPDATE`);
    await tx.execute(sql`SELECT * FROM commercial_purpose_policies
      WHERE purpose='commercial_reporting' AND policy_version=1 FOR UPDATE`);
    // Command is locked before its root/event key, making state/version fencing
    // and the immutable event/projection/command transition one commit.
    const cmdResult = rows(await tx.execute(sql`
      SELECT id, idempotency_key, subject_type, subject_id, target_class, evidence_fields, evidence_refs, requested_by, approved_by,
             version_lock, payload_hash, preview_dependency_fingerprint, purpose_policy_fingerprint,
             policy_version, status, executor_id
      FROM commercial_classification_commands WHERE id=${commandId} FOR UPDATE
    `))[0];
    if (!cmdResult) return { executed: false, reason: "Command not found or not in approved state" };
    if (cmdResult.status === "executed") {
      const event = rows(await tx.execute(sql`SELECT id FROM commercial_classification_events
        WHERE event_namespace='bt06:command' AND event_key=${`cmd:${commandId}`} LIMIT 1`))[0];
      return event ? { executed: true, eventId: Number(event.id) } : { executed: false, reason: "CLASSIFICATION_EXECUTION_INCONSISTENT" };
    }
    if (cmdResult.status !== "approved") return { executed: false, reason: "Command not found or not in approved state" };
    if (!cmdResult.requested_by || !cmdResult.approved_by ||
        cmdResult.requested_by === cmdResult.approved_by ||
        cmdResult.requested_by === actorId || cmdResult.approved_by === actorId) {
      return { executed: false, reason: "CLASSIFICATION_ACTOR_SEPARATION_VIOLATION" };
    }
    const evidenceFields = (cmdResult.evidence_fields as Record<string, unknown>) ?? {};
    const evidenceRefs = (cmdResult.evidence_refs as ClassificationEvidenceRef[] | null) ?? [];
    const expectedHash = hashPreviewPayload({
      idempotencyKey: String(cmdResult.idempotency_key), subjectType: cmdResult.subject_type as ClassificationSubjectType,
      subjectId: Number(cmdResult.subject_id), targetClass: cmdResult.target_class as CommercialClass,
      evidenceFields, evidenceRefs, requestedBy: cmdResult.requested_by,
    }, cmdResult.preview_dependency_fingerprint);
    if (cmdResult.payload_hash !== expectedHash || Number(cmdResult.policy_version) !== CLASSIFICATION_POLICY_VERSION) {
      return { executed: false, reason: "CLASSIFICATION_STALE_COMMAND" };
    }
    assertNoPii(evidenceFields);
    const { resolveCommercialGraph } = await import("./commercial-resolution");
    const graph = await resolveCommercialGraph({
      subjectType: cmdResult.subject_type as ClassificationSubjectType,
      subjectId: Number(cmdResult.subject_id), effect: "commercial_reporting",
      expectedFingerprint: cmdResult.preview_dependency_fingerprint,
      persist: false, transaction: tx,
    });
    if (graph.reasonCodes.includes("STALE_GRAPH")) {
      return { executed: false, reason: "CLASSIFICATION_STALE_GRAPH" };
    }
    if (cmdResult.target_class === "production" && cmdResult.subject_type === "deal") {
      const linkedClasses = await getLinkedClassesInTransaction(
        tx, cmdResult.subject_type as ClassificationSubjectType, Number(cmdResult.subject_id),
      );
      if (linkedClasses.length === 0 || linkedClasses.some(value => value !== "production")) {
        return { executed: false, reason: "CLASSIFICATION_GRAPH_QUARANTINED" };
      }
    }
    if (graph.policyVersion !== Number(cmdResult.policy_version)
        || graph.policyFingerprint !== cmdResult.purpose_policy_fingerprint) {
      return { executed: false, reason: "CLASSIFICATION_PURPOSE_POLICY_MISMATCH" };
    }
    if (cmdResult.target_class === "production" && (
      graph.reasonCodes.includes("REDIRECT_UNRESOLVED") ||
      (cmdResult.subject_type === "deal" && (
        graph.reasonCodes.includes("REQUIRED_LINK_MISSING") ||
        graph.reasonCodes.includes("DANGLING_LINK") ||
        graph.reasonCodes.includes("ROOT_CLASS_CONFLICT")
      ))
    )) {
      return { executed: false, reason: "CLASSIFICATION_GRAPH_QUARANTINED" };
    }
    await validateTypedEvidence(tx, evidenceRefs,
      cmdResult.subject_type as ClassificationSubjectType, Number(cmdResult.subject_id),
      graph.effectiveSubjectType, graph.effectiveSubjectId);
    const { eventId } = await applyClassification({
      subjectType: cmdResult.subject_type as ClassificationSubjectType, subjectId: Number(cmdResult.subject_id),
      targetClass: cmdResult.target_class as CommercialClass, eventNamespace: "bt06:command",
      eventKey: `cmd:${commandId}`, evidenceFields: { ...evidenceFields, commandId },
      actorId: cmdResult.requested_by, approverId: cmdResult.approved_by, transaction: tx,
    });
    const postGraph = await resolveCommercialGraph({
      subjectType: cmdResult.subject_type as ClassificationSubjectType,
      subjectId: Number(cmdResult.subject_id), effect: "commercial_reporting",
      persist: true, transaction: tx,
    });
    if (!postGraph.snapshotId) throw new Error("CLASSIFICATION_SNAPSHOT_MISSING");
    await tx.execute(sql`INSERT INTO commercial_evidence_references(snapshot_id,classification_event_id)
      VALUES(${postGraph.snapshotId}::uuid,${eventId})`);
    for (const ref of evidenceRefs) {
      const column = {
        classification_event: "classification_event_id",
        contact_source_event: "contact_source_event_id",
        import_row_disposition: "import_row_disposition_id",
        identity_observation: "identity_observation_id",
        merge_operation: "merge_operation_id",
        merge_redirect: "merge_redirect_id",
        business_link_decision: "business_link_decision_id",
        legacy_company_mapping_decision: "legacy_company_mapping_decision_id",
        relationship_review: "relationship_review_id",
      }[ref.kind];
      await tx.execute(sql`INSERT INTO commercial_evidence_references
        (snapshot_id,${sql.identifier(column)}) VALUES(${postGraph.snapshotId}::uuid,${ref.id})`);
    }
    const updated = rows(await tx.execute(sql`
      UPDATE commercial_classification_commands SET status='executed', executor_id=${actorId},
        executed_at=now(), updated_at=now(), version_lock=version_lock+1, execution_fence=execution_fence+1
      WHERE id=${commandId} AND status='approved' AND version_lock=${cmdResult.version_lock} RETURNING id
    `));
    if (!updated.length) throw new Error("CLASSIFICATION_COMMAND_STATE_CONFLICT");
    return { executed: true, eventId };
  });
}

// ── Reconciliation helpers ────────────────────────────────────────────────────

export interface ReconciliationReport {
  aggregateType: string;
  aggregateKey: string;
  policyVersion: number;
  sourceRowCount: number;
  productionCount: number;
  excludedCount: number;
  unknownCount: number;
  lineageHwm: Date | null;
  computedAt: Date;
}

/**
 * recordAggregateLineage — stores lineage metadata for one KPI rebuild.
 * Call once per rebuild after computing production-only aggregates.
 */
export async function recordAggregateLineage(params: {
  aggregateType: string;
  aggregateKey: string;
  sourceRowCount: number;
  productionCount: number;
  excludedCount: number;
  unknownCount: number;
  lineageHwm?: Date;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO commercial_aggregate_lineage
      (aggregate_type, aggregate_key, policy_version,
       source_row_count, production_count, excluded_count, unknown_count,
       lineage_hwm, computed_at)
    VALUES
      (${params.aggregateType}, ${params.aggregateKey}, ${CLASSIFICATION_POLICY_VERSION},
       ${params.sourceRowCount}, ${params.productionCount}, ${params.excludedCount},
       ${params.unknownCount}, ${params.lineageHwm ?? null}, now())
  `);
}

/**
 * getReconciliationReport — read-only summary of lineage for a key.
 */
export async function getReconciliationReport(
  aggregateType: string,
  aggregateKey: string
): Promise<ReconciliationReport | null> {
  const result = rows(await db.execute(sql`
    SELECT aggregate_type, aggregate_key, policy_version,
           source_row_count, production_count, excluded_count, unknown_count,
           lineage_hwm, computed_at
    FROM commercial_aggregate_lineage
    WHERE aggregate_type = ${aggregateType} AND aggregate_key = ${aggregateKey}
    ORDER BY computed_at DESC
    LIMIT 1
  `))[0];

  if (!result) return null;

  return {
    aggregateType: result.aggregate_type as string,
    aggregateKey: result.aggregate_key as string,
    policyVersion: result.policy_version as number,
    sourceRowCount: result.source_row_count as number,
    productionCount: result.production_count as number,
    excludedCount: result.excluded_count as number,
    unknownCount: result.unknown_count as number,
    lineageHwm: result.lineage_hwm ? new Date(result.lineage_hwm as string) : null,
    computedAt: new Date(result.computed_at as string),
  };
}

// ── Bulk classification count helpers ─────────────────────────────────────────

/**
 * getClassificationCounts — admin-only read of class distribution.
 * Returns counts by class for contacts (redacted for non-admin display).
 */
export async function getContactClassCounts(): Promise<Record<CommercialClass, number>> {
  const result = rows(await db.execute(sql`
    SELECT record_class, COUNT(*)::int AS cnt
    FROM contacts
    WHERE archived_at IS NULL
    GROUP BY record_class
  `));

  const counts: Record<string, number> = {
    production: 0, test: 0, demo: 0, synthetic: 0, unknown: 0,
  };
  for (const row of result) {
    const cls = row.record_class as string;
    counts[cls] = (counts[cls] ?? 0) + (row.cnt as number);
  }
  return counts as Record<CommercialClass, number>;
}
