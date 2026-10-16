/**
 * Canonical ZeroBounce eligibility predicates + helpers (task #1540A).
 *
 * Extracted from server/routes/contacts.ts in #1541 so the durable BullMQ
 * campaign worker can share them without importing the whole route module.
 * server/routes/contacts.ts re-exports everything here to preserve existing
 * import paths (including scripts/test-zerobounce-batch-filter.ts).
 *
 * #1533 changed contacts.email_status default from 'active' to 'unvalidated'.
 * Every filter that selects contacts needing validation MUST use these
 * constants — do not hand-write the predicate anywhere else.
 *
 * Task #1956 step 6: this is the legacy campaign-engine ZeroBounce path's
 * eligibility gate — the one confirmed live-spend gap with no DBPR
 * exclusion. DBPR_LINEAGE_EXCLUSION_CLAUSE uses the canonical predicate from
 * server/services/dbpr.ts (never a hand-rolled `%dbpr%` check).
 *
 * IMPORTANT SQL scoping note: the fragment below is embedded inside a
 * correlated NOT EXISTS subquery against canonical_source_links, which has
 * its OWN `business_id` column. A bare, unqualified `business_id` reference
 * here would be resolved by Postgres against the innermost FROM-list (the
 * subquery's own table), silently shadowing the outer contacts row and
 * making the exclusion match/no-match every contact identically regardless
 * of its actual lineage. Every call site embedding this clause MUST alias
 * the outer contacts table as `c` (i.e. `FROM contacts c WHERE ...`) — the
 * fragment is hardcoded to reference `c.business_id`, not a bare column.
 */
import { businessLacksDbprLineageWhereFragment } from "./dbpr";
import { EMAIL_VALIDATION_MAX_AGE_MS } from "./provider-readiness-decision";

/**
 * Excludes contacts linked to a canonical business with any DBPR-family
 * source lineage. Requires the outer query to alias contacts as `c`.
 */
export const DBPR_LINEAGE_EXCLUSION_CLAUSE = `(c.business_id IS NULL OR ${businessLacksDbprLineageWhereFragment("c.business_id")})`;

// 'valid' without a validation date is legacy/anomalous: it has no provider
// evidence behind it, so it is treated as unvalidated. Only completed provider
// decisions and the receipt projection write 'valid', and both set the date.
export const UNVALIDATED_EMAIL_PREDICATE =
  `(email_status IS NULL OR email_status IN ('active', 'unvalidated')
    OR (email_status = 'valid' AND email_validation_updated_at IS NULL))`;

/**
 * "Currently validated": status 'valid' with a validation date inside the same
 * freshness window the marketing authority enforces
 * (EMAIL_VALIDATION_MAX_AGE_MS). This is a candidate-selection filter only;
 * the provider observation checked by evaluateMarketingEmailEligibility
 * remains the sole send authority. Pass the contacts alias when joined.
 */
export function currentValidEmailPredicate(alias = ""): string {
  if (alias && !/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("EMAIL_PREDICATE_ALIAS_INVALID");
  const p = alias ? `${alias}.` : "";
  const days = Math.floor(EMAIL_VALIDATION_MAX_AGE_MS / 86_400_000);
  return `(${p}email_status = 'valid' AND ${p}email_validation_updated_at IS NOT NULL
    AND ${p}email_validation_updated_at > NOW() - INTERVAL '${days} days')`;
}

// Eligibility filter for ZeroBounce candidates: non-blank real addresses only.
// Excludes synthetic placeholders written by CSV import
// (no-email-<uuid>@no-email.libertybancard.internal).
export const VALID_EMAIL_ELIGIBILITY =
  `(COALESCE(TRIM(email), '') != '' AND email NOT ILIKE '%.internal' AND email NOT ILIKE 'no-email-%' AND archived_at IS NULL)`;

/** True for synthetic placeholder addresses that must never reach ZeroBounce. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email || email.trim() === "") return true;
  const e = email.trim().toLowerCase();
  return e.endsWith(".internal") || e.startsWith("no-email-");
}

/**
 * True when a ZeroBounce result represents a transport/configuration failure
 * (missing key, HTTP non-2xx, timeout, exception) rather than a completed
 * provider decision. Retryable failures must NOT overwrite email_status.
 */
export function isRetryableZbFailure(r: { skipped?: boolean; reason?: string }): boolean {
  return r.skipped === true || r.reason != null;
}

/** True when the ZeroBounce provider is configured (API key present). */
export function isZeroBounceConfigured(): boolean {
  return !!process.env.ZEROBOUNCE_API_KEY;
}

/**
 * Campaign filter snapshot stored on zerobounce_campaigns.filter_definition.
 * Immutable for the life of the campaign so daily runs process a stable cohort.
 */
export interface ZbCampaignFilter {
  issue: string;
  minLeadScore: number;
  contactIds?: number[];
}

/** Per-issue SQL fragments — same map the DataQuality batch route always used. */
export const ZB_ISSUE_FILTERS: Record<string, string> = {
  blank_name:        `COALESCE(TRIM(first_name), '') = ''`,
  unvalidated_email: UNVALIDATED_EMAIL_PREDICATE,
  bad_email:         `email_status IN ('bounced', 'invalid', 'unsafe')`,
  missing_vertical:  `COALESCE(TRIM(vertical), '') = ''`,
  missing_phone:     `COALESCE(TRIM(phone), '') = ''`,
};

/**
 * Build the canonical WHERE clause (no parameters) selecting contacts eligible
 * for a campaign's filter snapshot. Explicit contactIds campaigns keep the
 * operator's deliberate re-validation gate: only VALID_EMAIL_ELIGIBILITY is
 * applied on top of the ID list (terminal statuses are re-validated on purpose).
 */
export function buildZbEligibilityWhere(filter: ZbCampaignFilter): string {
  if (filter.contactIds && filter.contactIds.length > 0) {
    const ids = filter.contactIds.filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return "FALSE";
    return `${VALID_EMAIL_ELIGIBILITY} AND ${DBPR_LINEAGE_EXCLUSION_CLAUSE} AND id IN (${ids.join(",")})`;
  }
  const issueClause = ZB_ISSUE_FILTERS[filter.issue] ?? UNVALIDATED_EMAIL_PREDICATE;
  const minScore = Number.isFinite(filter.minLeadScore) ? Math.max(0, Math.floor(filter.minLeadScore)) : 0;
  return `${VALID_EMAIL_ELIGIBILITY} AND ${DBPR_LINEAGE_EXCLUSION_CLAUSE} AND COALESCE(lead_score, 0) >= ${minScore} AND (${issueClause})`;
}
