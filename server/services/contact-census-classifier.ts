/**
 * Contact Census Classifier — pure function, no DB calls, no provider calls, no side effects.
 * Called once per contact row during a census run.
 *
 * classifyContact(row, sharedPhoneSet, businessNameSet) → CensusResult
 *
 * Lane precedence: P1 NON_PRODUCTION → P2 BLOCKED_COMPLIANCE → P3 INSUFFICIENT_DATA
 *   → P4 DUPLICATE_REVIEW → P5 MANUAL_REVIEW → P6 NEEDS_MULTIPLE_CONTACT_FIELDS
 *   → P7 NEEDS_CONTACT_NAME → P8 NEEDS_EMAIL → P9 NEEDS_PHONE
 *   → P10 INTERNAL_MATCH_AVAILABLE → P11 NEEDS_BUSINESS_MATERIALIZATION
 *   → P12 NEEDS_BUSINESS_IDENTITY → P13 NEEDS_VERTICAL_ONLY
 *   → P14 NEEDS_VALIDATION_ONLY → P15 COMPLETE_EXISTING_DATA → P16 UNCLASSIFIED_REVIEW
 *
 * COMPLETE_EXISTING_DATA requires an affirmative predicate proving all completeness conditions
 * are satisfied. It is NOT the catch-all fallback. Contacts matching no rule route to
 * UNCLASSIFIED_REVIEW with gap_code='classifier_no_rule_match'.
 */

import { createHash } from "crypto";

// ──────────────────────────────────────────────────────────────────────────────
// Input row shape — only the columns we actually read
// ──────────────────────────────────────────────────────────────────────────────
export interface CensusContactRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  vertical: string | null;
  verticalSource: string | null;
  manualVerticalOverride: boolean | null;
  dataReadinessScore: number | null;
  leadScore: number | null;
  emailStatus: string | null;
  emailValidationUpdatedAt: Date | null;
  businessId: number | null;
  doNotContact: boolean | null;
  suppressionReason: string | null;
  bounceStatus: string | null;
  complaintStatus: string | null;
  consentTier: string | null;
  recordClass: string | null;
  ghlContactId: string | null;
  leadSource: string | null;
  // pre-joined signals
  hasDeal: boolean;
  hasSourceEvent: boolean;
  hasEnrichmentRun: boolean;
  hasZerobounceRun: boolean;
  hasMergeRedirect: boolean;
  // normalized phone for shared-phone lookup (computed once outside classifier)
  normalizedPhone: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Output shape
// ──────────────────────────────────────────────────────────────────────────────
export interface CensusResult {
  contactId: number;
  selectionHash: string;
  runId: string;
  asOf: string;

  // D1–D10
  recordClass: string;            // D1
  identityState: string;          // D2
  businessMaterializationState: string; // D3
  contactabilityState: string;    // D4
  verticalState: string;          // D5
  validationState: string;        // D6
  complianceState: string;        // D7
  evidenceState: string;          // D8
  enrichmentState: string;        // D9
  phoneQualityState: string;      // D10

  primaryLane: string;
  gapCodes: string[];

  // Non-PII boolean context
  hasBusinessId: boolean;
  hasCompanyName: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  hasVertical: boolean;
  readinessScore: number | null;
  leadScore: number | null;
  hasGhlLink: boolean;
  hasDeal: boolean;
  leadSource: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Pre-computed sets passed in per run (loaded once, not per contact)
// ──────────────────────────────────────────────────────────────────────────────
export interface CensusRunContext {
  runId: string;
  asOf: string; // ISO string
  /** Normalized phone values that appear on ≥2 active contacts */
  sharedPhoneSet: Set<string>;
  /** Normalized phone → count map for >20-company threshold detection */
  sharedPhoneCompanyCount: Map<string, number>;
  /** Normalized phone → is-toll-free boolean */
  sharedPhoneTollFree: Map<string, boolean>;
  /** Normalized phone → is-placeholder boolean */
  sharedPhonePlaceholder: Map<string, boolean>;
  /** Exact normalized business names from businesses table */
  businessNameSet: Set<string>;
  /** Normalized company names that have exactly one business name match and single source */
  singleCompanySingleSourcePhones: Set<string>; // phones where only 1 distinct company
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizeName(v: string | null | undefined): string {
  if (!v) return "";
  return v.trim().toLowerCase();
}

/** Returns true for 800/888/877/866/855/844/833 toll-free area codes */
function isTollFreePhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return /^1?(800|888|877|866|855|844|833)/.test(digits);
}

/** Returns true for known placeholder phone suffixes */
function isPlaceholderPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return /1234$|0000$|5555$/.test(digits);
}

const VALIDATION_CURRENT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────────────
// D1 — Record Classification
// ──────────────────────────────────────────────────────────────────────────────
function classifyD1(row: CensusContactRow): string {
  return row.recordClass ?? "unknown";
}

// ──────────────────────────────────────────────────────────────────────────────
// D2 — Identity State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD2(row: CensusContactRow, ctx: CensusRunContext): string {
  const hasName = nonEmpty(row.firstName) || nonEmpty(row.companyName);
  const hasChannel = nonEmpty(row.email) || nonEmpty(row.phone);

  if (row.hasMergeRedirect) return "conflicting";

  if (!hasName && !hasChannel) return "insufficient";

  // Two-signal duplicate check: shared phone AND (matching company name OR email domain)
  if (row.normalizedPhone && ctx.sharedPhoneSet.has(row.normalizedPhone)) {
    const companyNorm = normalizeName(row.companyName);
    const emailDomain = row.email?.split("@")[1]?.toLowerCase() ?? "";
    // We check for multi-company phones here — single company is NOT duplicate_candidate
    const companyCount = ctx.sharedPhoneCompanyCount.get(row.normalizedPhone) ?? 1;
    if (companyCount > 1 && companyCount <= 20 && (nonEmpty(companyNorm) || nonEmpty(emailDomain))) {
      return "duplicate_candidate";
    }
  }

  const fullyResolved =
    nonEmpty(row.firstName) &&
    (nonEmpty(row.lastName) || nonEmpty(row.companyName)) &&
    hasChannel;

  return fullyResolved ? "resolved" : "partially_resolved";
}

// ──────────────────────────────────────────────────────────────────────────────
// D3 — Business-Materialization State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD3(row: CensusContactRow, ctx: CensusRunContext): string {
  if (row.businessId != null) return "linked";

  if (nonEmpty(row.companyName)) {
    const norm = normalizeName(row.companyName);
    if (ctx.businessNameSet.has(norm)) return "candidate_match";
    return "pipeline_eligible";
  }

  return "insufficient_for_pipeline";
}

// ──────────────────────────────────────────────────────────────────────────────
// D4 — Contactability State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD4(row: CensusContactRow): string {
  const hasEmail = nonEmpty(row.email);
  const hasPhone = nonEmpty(row.phone);
  if (hasEmail && hasPhone) return "email_and_phone";
  if (hasEmail) return "email_only";
  if (hasPhone) return "phone_only";
  return "no_usable_channel";
}

// ──────────────────────────────────────────────────────────────────────────────
// D5 — Vertical State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD5(row: CensusContactRow): string {
  if (row.manualVerticalOverride === true) return "manual_override";
  if (nonEmpty(row.vertical)) {
    return nonEmpty(row.verticalSource) ? "resolved_provenanced" : "resolved_unprovenanced";
  }
  return "missing";
}

// ──────────────────────────────────────────────────────────────────────────────
// D6 — Validation State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD6(row: CensusContactRow, asOf: Date): string {
  if (!nonEmpty(row.email)) return "not_applicable";

  const status = row.emailStatus ?? "unvalidated";

  if (["bounced", "invalid", "unsafe", "blocked"].includes(status)) return "invalid";
  // NOTE: 'subscribed' means subscribed to email — it is NOT opted_out.
  // Only 'opted_out' drives the opted_out validation state.
  if (status === "opted_out") return "opted_out";

  if (status === "valid") {
    if (!row.emailValidationUpdatedAt) return "stale"; // anomalous
    const age = asOf.getTime() - new Date(row.emailValidationUpdatedAt).getTime();
    return age < VALIDATION_CURRENT_WINDOW_MS ? "current" : "stale";
  }

  // email_status = 'active' or 'unvalidated' with no validation date
  return "unknown";
}

// ──────────────────────────────────────────────────────────────────────────────
// D7 — Compliance State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD7(row: CensusContactRow): string {
  if (row.doNotContact === true) return "blocked_dnc";
  if (nonEmpty(row.suppressionReason)) return "blocked_suppression";
  if (
    ["bounced", "blocked", "opted_out"].includes(row.emailStatus ?? "") ||
    row.consentTier === "opted_out"
  ) {
    return "blocked_email";
  }
  if (nonEmpty(row.complaintStatus) && row.complaintStatus !== "none") {
    return "blocked_complaint";
  }
  if (nonEmpty(row.bounceStatus) && row.bounceStatus !== "none") {
    return "blocked_email";
  }

  // Explicit consent check (any PEWC tier)
  const tier = (row.consentTier ?? "").toLowerCase();
  if (tier.includes("pewc")) return "eligible";

  return "eligible_unverified";
}

// ──────────────────────────────────────────────────────────────────────────────
// D8 — Evidence State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD8(d1: string, d3: string, d5: string, d6: string, d7: string, row: CensusContactRow): string {
  if (d1 !== "production") return "not_eligible";
  if (d7.startsWith("blocked")) return "not_eligible";

  if (row.businessId != null) {
    if (d6 === "current" && d5 !== "missing") return "sufficient_existing";
    return "partial_existing";
  }
  if (d3 === "candidate_match") return "internal_match_possible";
  if (d3 === "pipeline_eligible") return "pipeline_eligible";
  if (d3 === "insufficient_for_pipeline") return "insufficient_identity";

  return "partial_existing";
}

// ──────────────────────────────────────────────────────────────────────────────
// D9 — Existing-Enrichment State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD9(row: CensusContactRow): string {
  if (row.hasEnrichmentRun) return "enrichment_run_exists";
  if (row.hasZerobounceRun) return "zerobounce_run_exists";
  if (row.hasSourceEvent) return "source_event_exists";
  return "none";
}

// ──────────────────────────────────────────────────────────────────────────────
// D10 — Shared-Phone Quality State
// ──────────────────────────────────────────────────────────────────────────────
function classifyD10(row: CensusContactRow, ctx: CensusRunContext): string {
  if (!nonEmpty(row.phone)) return "not_applicable";

  const np = row.normalizedPhone;
  if (!np || !ctx.sharedPhoneSet.has(np)) return "unique";

  if (ctx.sharedPhonePlaceholder.get(np)) return "import_artifact";

  const companyCount = ctx.sharedPhoneCompanyCount.get(np) ?? 1;
  if (companyCount > 20) return "source_attribution_conflict";

  const tollFree = ctx.sharedPhoneTollFree.get(np) ?? false;
  const isSingleCompany = ctx.singleCompanySingleSourcePhones.has(np);

  if (isSingleCompany || (tollFree && companyCount === 1)) return "likely_shared_business";

  return "unresolved_shared";
}

// ──────────────────────────────────────────────────────────────────────────────
// Primary Lane Assignment (P1–P16)
// ──────────────────────────────────────────────────────────────────────────────
function assignLane(
  row: CensusContactRow,
  d1: string, d2: string, d3: string, d4: string, d5: string,
  d6: string, d7: string, _d8: string, _d9: string, _d10: string,
): { lane: string; gapCodes: string[] } {

  // P1 — NON_PRODUCTION
  if (["test", "demo", "synthetic"].includes(d1)) {
    return { lane: "NON_PRODUCTION", gapCodes: [`record_class:${d1}`] };
  }

  // P2 — BLOCKED_COMPLIANCE
  if (d7.startsWith("blocked")) {
    return { lane: "BLOCKED_COMPLIANCE", gapCodes: [d7] };
  }

  // P3 — INSUFFICIENT_DATA
  const hasEmail = nonEmpty(row.email);
  const hasPhone = nonEmpty(row.phone);
  const hasFirstName = nonEmpty(row.firstName);
  const hasCompanyName = nonEmpty(row.companyName);
  const hasChannel = hasEmail || hasPhone;

  if (!hasChannel && (!hasFirstName && !hasCompanyName)) {
    return { lane: "INSUFFICIENT_DATA", gapCodes: ["no_channel", "no_name"] };
  }

  // P4 — DUPLICATE_REVIEW
  if (d2 === "duplicate_candidate") {
    return { lane: "DUPLICATE_REVIEW", gapCodes: ["shared_phone_multi_company"] };
  }

  // P5 — MANUAL_REVIEW
  if (d2 === "conflicting" || d1 === "unknown") {
    return { lane: "MANUAL_REVIEW", gapCodes: [d2 === "conflicting" ? "merge_redirect_exists" : "record_class_unknown"] };
  }

  // Count missing fields
  const missingFields: string[] = [];
  if (!hasEmail) missingFields.push("email");
  if (!hasPhone) missingFields.push("phone");
  if (!hasFirstName) missingFields.push("first_name");
  if (!hasCompanyName) missingFields.push("company_name");

  // P6 — NEEDS_MULTIPLE_CONTACT_FIELDS (≥2 missing)
  if (missingFields.length >= 2) {
    return { lane: "NEEDS_MULTIPLE_CONTACT_FIELDS", gapCodes: missingFields.map(f => `missing:${f}`) };
  }

  // P7 — NEEDS_CONTACT_NAME
  // Fires when firstName is absent regardless of companyName presence.
  // Rationale: companyName alone is insufficient for individual-contact identification in outreach;
  // a person name (firstName) is always required for a complete contact record.
  // By P6 we already know missingFields.length < 2, so this catches "only firstName missing"
  // as well as the historical "firstName AND companyName both missing" case.
  if (!hasFirstName) {
    const gaps = ["missing:first_name"];
    if (!hasCompanyName) gaps.push("missing:company_name");
    return { lane: "NEEDS_CONTACT_NAME", gapCodes: gaps };
  }

  // P8 — NEEDS_EMAIL
  if (!hasEmail && hasPhone && hasCompanyName) {
    return { lane: "NEEDS_EMAIL", gapCodes: ["missing:email"] };
  }

  // P9 — NEEDS_PHONE
  if (!hasPhone && hasEmail && hasCompanyName) {
    return { lane: "NEEDS_PHONE", gapCodes: ["missing:phone"] };
  }

  // P10 — INTERNAL_MATCH_AVAILABLE
  if (d3 === "candidate_match") {
    return { lane: "INTERNAL_MATCH_AVAILABLE", gapCodes: ["business_candidate_match_available"] };
  }

  // P11 — NEEDS_BUSINESS_MATERIALIZATION
  if (hasCompanyName && row.businessId == null && d3 === "pipeline_eligible") {
    return { lane: "NEEDS_BUSINESS_MATERIALIZATION", gapCodes: ["business_not_materialized"] };
  }

  // P12 — NEEDS_BUSINESS_IDENTITY
  if (!hasCompanyName && row.businessId == null && hasChannel) {
    return { lane: "NEEDS_BUSINESS_IDENTITY", gapCodes: ["missing:company_name", "no_business_id"] };
  }

  // P13 — NEEDS_VERTICAL_ONLY
  if (d5 === "missing") {
    return { lane: "NEEDS_VERTICAL_ONLY", gapCodes: ["missing:vertical"] };
  }

  // P14 — NEEDS_VALIDATION_ONLY
  if (["unknown", "stale"].includes(d6) && row.businessId != null) {
    return { lane: "NEEDS_VALIDATION_ONLY", gapCodes: [`validation_state:${d6}`] };
  }

  // P15 — COMPLETE_EXISTING_DATA (affirmative predicate — all conditions must pass)
  // IMPORTANT: This lane requires affirmative proof of all completeness conditions.
  // It does not imply validation, compliance, or outreach authorization.
  // It must never be assigned merely because no earlier rule matched.
  const passConditions: string[] = [];
  let allPass = true;

  if (row.businessId != null) { passConditions.push("PASS:business_id_linked"); }
  else { allPass = false; }

  if (hasEmail) { passConditions.push("PASS:email_present"); }
  else { allPass = false; }

  if (hasPhone) { passConditions.push("PASS:phone_present"); }
  else { allPass = false; }

  if (hasFirstName) { passConditions.push("PASS:first_name_present"); }
  else { allPass = false; }

  if (hasCompanyName) { passConditions.push("PASS:company_name_present"); }
  else { allPass = false; }

  if (d6 === "current") { passConditions.push("PASS:validation_current"); }
  else { allPass = false; }

  if (!d7.startsWith("blocked")) { passConditions.push("PASS:compliance_eligible"); }
  else { allPass = false; }

  if (["resolved_provenanced", "resolved_unprovenanced", "manual_override"].includes(d5)) {
    passConditions.push("PASS:vertical_resolved");
  } else { allPass = false; }

  if (allPass) {
    return { lane: "COMPLETE_EXISTING_DATA", gapCodes: passConditions };
  }

  // P16 — UNCLASSIFIED_REVIEW (exhaustive fallback — classifier gap)
  // Expected count is 0. Any non-zero count is a classifier bug.
  return { lane: "UNCLASSIFIED_REVIEW", gapCodes: ["classifier_no_rule_match"] };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main exported classifier — pure, no side effects
// ──────────────────────────────────────────────────────────────────────────────
export function classifyContact(
  row: CensusContactRow,
  ctx: CensusRunContext,
): CensusResult {
  const asOfDate = new Date(ctx.asOf);

  const d1 = classifyD1(row);
  const d2 = classifyD2(row, ctx);
  const d3 = classifyD3(row, ctx);
  const d4 = classifyD4(row);
  const d5 = classifyD5(row);
  const d6 = classifyD6(row, asOfDate);
  const d7 = classifyD7(row);
  const d8 = classifyD8(d1, d3, d5, d6, d7, row);
  const d9 = classifyD9(row);
  const d10 = classifyD10(row, ctx);

  const { lane, gapCodes } = assignLane(row, d1, d2, d3, d4, d5, d6, d7, d8, d9, d10);

  const selectionHash = createHash("sha256")
    .update(`${row.id}||${ctx.runId}||${ctx.asOf}`)
    .digest("hex");

  return {
    contactId: row.id,
    selectionHash,
    runId: ctx.runId,
    asOf: ctx.asOf,

    recordClass: d1,
    identityState: d2,
    businessMaterializationState: d3,
    contactabilityState: d4,
    verticalState: d5,
    validationState: d6,
    complianceState: d7,
    evidenceState: d8,
    enrichmentState: d9,
    phoneQualityState: d10,

    primaryLane: lane,
    gapCodes,

    hasBusinessId: row.businessId != null,
    hasCompanyName: nonEmpty(row.companyName),
    hasEmail: nonEmpty(row.email),
    hasPhone: nonEmpty(row.phone),
    hasVertical: nonEmpty(row.vertical),
    readinessScore: row.dataReadinessScore ?? null,
    leadScore: row.leadScore ?? null,
    hasGhlLink: nonEmpty(row.ghlContactId),
    hasDeal: row.hasDeal,
    leadSource: row.leadSource ?? null,
  };
}
