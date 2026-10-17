import crypto from "node:crypto";

/**
 * Pure classification of one evaluated contact into a durable disposition.
 * No database access: the worker supplies what it evaluated. A disposition is
 * observation only. It never grants relationship authority; only the audited
 * relationship writer links a contact to a business.
 */
export const DISPOSITION_RULE_VERSION = "contact_link_disposition_v1";

export type DispositionOutcome = "linked" | "unsupported" | "awaiting_review" | "retryable";

export const UNSUPPORTED_RETRY_TRIGGER =
  "contact_updated|source_event_added|business_or_source_link_changed|rule_version_changed";
export const REVIEW_RETRY_TRIGGER =
  "reviewed_decision|business_or_source_link_changed|rule_version_changed";
export const RETRYABLE_TRIGGER = "automatic_retry_at";
export const RETRY_DELAY_MINUTES = 15;

/** A concrete conflict or missing decision. Anything else is unsupported or retryable. */
export const CONFLICT_REASON_CODES = new Set([
  "competing_corroborated_businesses", "AMBIGUOUS_ORGANIZATION_MATCH",
  "RETAINED_ORGANIZATION_IDENTITY_CONFLICT", "RETAINED_REGISTRY_SOURCE_AMBIGUOUS",
  "RETAINED_REGISTRY_LOCATION_CONFLICT", "COMMERCIAL_LINK_DIVERGENT_REPLAY",
]);
const RETRYABLE_CODE = /(SNAPSHOT_STALE|EVIDENCE_CHANGED|TIMEOUT|DEADLOCK|SERIALIZ|CONNECTION|TERMINATING|ECONN|RETRY)/i;

export interface DispositionInput {
  contactId: number;
  ruleVersion: string;
  snapshotHash: string;
  materializationEvidenceRevision: string | null;
  eligible: boolean;
  reasons: string[];
  projectedBusinessId: number | null;
  currentDecision: string | null;
  businessId: number | null;
  candidateEvidence: Array<{businessId: number; sourceLinkId: string; reasons?: string[]}>;
  sourceEvents: {count: number; kinds: string[]; hasSupportedEvidence: boolean};
  hasGhlContactId: boolean;
  materializer?: {status: string; reasonCode?: string | null; businessId?: number | null} | null;
  writer?: {status: string; code?: string | null} | null;
  failure?: string | null;
}

export interface DispositionDraft {
  contactId: number;
  outcome: DispositionOutcome;
  reasonCode: string;
  ruleVersion: string;
  evidenceFingerprint: string;
  evidenceRefs: Record<string, unknown>;
  nextRetryTrigger: string | null;
  retryDelayMinutes: number | null;
  businessId: number | null;
}

const clean = (value: string) => value.replace(/[^A-Za-z0-9_:.-]+/g, "_").slice(0, 80);

export function classifyContactLinkDisposition(input: DispositionInput): DispositionDraft {
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
    input.ruleVersion, input.snapshotHash, input.materializationEvidenceRevision,
    input.materializer?.status ?? null, input.materializer?.reasonCode ?? null,
    input.writer?.status ?? null, input.writer?.code ?? null,
  ])).digest("hex");
  const refs = {
    sourceEventCount: input.sourceEvents.count,
    sourceEventKinds: [...new Set(input.sourceEvents.kinds)].sort().slice(0, 12),
    candidateBusinessIds: [...new Set(input.candidateEvidence.map(c => c.businessId))].slice(0, 10),
    candidateSourceLinkIds: [...new Set(input.candidateEvidence.map(c => c.sourceLinkId))].slice(0, 10),
    reasons: input.reasons.slice(0, 10),
    materializer: input.materializer ? {status: input.materializer.status,
      reasonCode: input.materializer.reasonCode ?? null} : null,
    writer: input.writer ? {status: input.writer.status, code: input.writer.code ?? null} : null,
  };
  const make = (outcome: DispositionOutcome, reasonCode: string, businessId: number | null = null): DispositionDraft => ({
    contactId: input.contactId, outcome, reasonCode: clean(reasonCode), ruleVersion: input.ruleVersion,
    evidenceFingerprint: fingerprint, evidenceRefs: refs, businessId,
    nextRetryTrigger: outcome === "linked" ? null : outcome === "retryable" ? RETRYABLE_TRIGGER
      : outcome === "awaiting_review" ? REVIEW_RETRY_TRIGGER : UNSUPPORTED_RETRY_TRIGGER,
    retryDelayMinutes: outcome === "retryable" ? RETRY_DELAY_MINUTES : null,
  });

  // Temporary source/query/worker failures are never a relationship conclusion.
  if (input.failure) return make("retryable", `RETRYABLE_${input.failure}`);
  if (input.writer?.status === "applied") return make("linked", "LINK_COMMITTED", input.businessId);
  if (input.writer?.status === "replayed") return make("linked", "LINK_REPLAYED", input.businessId);
  if (input.writer?.status === "rejected") {
    const code = input.writer.code ?? "WRITER_REJECTED";
    return RETRYABLE_CODE.test(code) ? make("retryable", `RETRYABLE_${code}`)
      : make("awaiting_review", `WRITER_${code}`, input.businessId);
  }
  if (input.currentDecision === "verified" && input.projectedBusinessId != null)
    return make("linked", "EXISTING_VERIFIED_ASSIGNMENT_PRESERVED", input.projectedBusinessId);
  const held = input.materializer;
  if (held && (held.status === "held" || held.status === "preserved") && held.reasonCode) {
    return CONFLICT_REASON_CODES.has(held.reasonCode)
      ? make("awaiting_review", `MATERIALIZATION_${held.reasonCode}`, held.businessId ?? null)
      : make("unsupported", `MATERIALIZATION_${held.reasonCode}`, held.businessId ?? null);
  }
  if (input.reasons.some(reason => CONFLICT_REASON_CODES.has(reason)))
    return make("awaiting_review", "COMPETING_CORROBORATED_BUSINESSES");
  if (input.projectedBusinessId != null)
    return make("unsupported", "LEGACY_PROJECTION_NOT_INDEPENDENTLY_VERIFIED", input.projectedBusinessId);
  if (input.reasons.includes("independent_business_identity_not_found") || input.reasons.length === 0) {
    if (input.sourceEvents.hasSupportedEvidence) return make("unsupported", "INDEPENDENT_BUSINESS_IDENTITY_NOT_FOUND");
    if (input.hasGhlContactId || input.sourceEvents.kinds.some(kind => kind.startsWith("ghl_sync:")))
      return make("unsupported", "GHL_ORGANIZATION_EVIDENCE_NOT_RETAINED");
    if (input.sourceEvents.count > 0) return make("unsupported", "SOURCE_EVIDENCE_NOT_SUPPORTED_FOR_ASSIGNMENT");
    return make("unsupported", "LEGACY_CONTACT_FIELDS_ONLY");
  }
  // A name/domain/place candidate exists but independent corroboration is missing.
  return make("unsupported", "CANDIDATE_NOT_INDEPENDENTLY_CORROBORATED");
}
