/**
 * Shared eligibility classifier for the deal backfill and the SDR orchestrator
 * future-orphan guard. Both paths must apply identical gates so the same contact
 * is never accepted by one path and rejected by the other.
 *
 * NEVER call autoEnrollFromTrigger() or any outbound-send function from here.
 */

export const PLACEHOLDER_EMAIL_REGEX = /^lead-\d+@placeholder\./i;

export const ANONYMOUS_FIRST_NAMES = new Set([
  "anonymous", "contact", "unknown", "n/a", "na", "", "test", "user",
]);

export const ANONYMOUS_LAST_NAMES = new Set([
  "", "unknown", "n/a", "na", "anonymous",
]);

export function isPlaceholderEmail(email: string | null): boolean {
  if (!email) return true;
  const lower = email.toLowerCase();
  return (
    PLACEHOLDER_EMAIL_REGEX.test(email) ||
    lower.endsWith("@placeholder.com") ||
    lower.includes("noemail@") ||
    lower.includes("no-email@") ||
    lower.startsWith("noreply@") ||
    lower.startsWith("donotreply@")
  );
}

export function isAnonymousContact(c: { firstName: string; lastName: string; companyName: string | null }): boolean {
  const fn = (c.firstName || "").trim().toLowerCase();
  const ln = (c.lastName || "").trim().toLowerCase();
  if (ANONYMOUS_FIRST_NAMES.has(fn) && ANONYMOUS_LAST_NAMES.has(ln) && !c.companyName) return true;
  if (!fn && !ln && !c.companyName) return true;
  return false;
}

export function hasValidIdentity(c: { firstName: string; lastName: string; email: string | null; phone: string; companyName: string | null }): boolean {
  const hasName = !!(c.firstName?.trim()) || !!(c.lastName?.trim()) || !!(c.companyName?.trim());
  const hasContact = (!isPlaceholderEmail(c.email) && !!(c.email?.trim())) || !!(c.phone?.trim());
  return hasName && hasContact;
}

export type EligibilityVerdict =
  | "eligible"
  | "cold"
  | "anonymous"
  | "placeholder_email"
  | "suppressed_dnc"
  | "missing_identity"
  | "duplicate_business";

export interface EligibilityCandidate {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string;
  companyName: string | null;
  leadScore: number | null;
  doNotContact: boolean | null;
  businessId: number | null;
}

/**
 * Classify a contact against all eligibility gates.
 * businessIdsWithDeals: set of businessIds that already have an active deal —
 *   used to prevent multiple deals for the same business.
 */
export function classifyEligibility(
  c: EligibilityCandidate,
  businessIdsWithDeals: Set<number>,
  minScore = 45,
): EligibilityVerdict {
  const score = c.leadScore ?? 0;
  if (score < minScore) return "cold";
  if ((c.doNotContact ?? false)) return "suppressed_dnc";
  if (isAnonymousContact(c)) return "anonymous";
  if (isPlaceholderEmail(c.email) && !(c.phone?.trim())) return "placeholder_email";
  if (!hasValidIdentity(c)) return "missing_identity";
  if (c.businessId && businessIdsWithDeals.has(c.businessId)) return "duplicate_business";
  return "eligible";
}
