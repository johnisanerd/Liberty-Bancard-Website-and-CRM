/**
 * Contact Quality Signal Engine — pure classification function, no side effects.
 *
 * classifyContactQuality(input, context): ContactQualityResult
 *
 * Rules:
 *  - No database writes
 *  - No external provider calls
 *  - No audit log writes
 *  - No outreach authorization decisions
 *  - Returns stable signal codes and non-PII details only
 *
 * Signal codes (26 total):
 *  Phone:   PHONE_MISSING, PHONE_MALFORMED, PHONE_PLACEHOLDER, PHONE_TOLL_FREE
 *  Email:   EMAIL_MISSING, EMAIL_MALFORMED, EMAIL_PLACEHOLDER, EMAIL_VALID_CURRENT,
 *           EMAIL_VALID_STALE, EMAIL_VALID_ANOMALOUS, EMAIL_UNVALIDATED, EMAIL_INVALID, EMAIL_UNSAFE
 *  DNC:     DNC_GLOBAL, AUTO_CONTACT_BLOCKED, EMAIL_SUPPRESSED, SMS_SUPPRESSED, CONTACT_COOLING_ACTIVE
 *  Shared:  SHARED_PHONE_REVIEW, SHARED_EMAIL_REVIEW
 *  Identity: NAME_MISSING, CONTACT_CHANNEL_MISSING
 *  Business: BUSINESS_LINK_VERIFIED, BUSINESS_UNLINKED, BUSINESS_LINK_CANDIDATE, BUSINESS_LINK_CONFLICT
 *
 * This engine reports evidence only. It does NOT bypass or replace evaluateContactability().
 * Every outbound action must still call the canonical contactability authority.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

/** Validation age window: valid + timestamp < 180 days = CURRENT */
const VALIDATION_CURRENT_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * All canonical quality signal codes.
 * Any signal code not in this set is rejected by the API allowlist.
 */
export const ALL_QUALITY_SIGNAL_CODES = [
  // Phone
  "PHONE_MISSING",
  "PHONE_MALFORMED",
  "PHONE_PLACEHOLDER",
  "PHONE_TOLL_FREE",
  // Email
  "EMAIL_MISSING",
  "EMAIL_MALFORMED",
  "EMAIL_PLACEHOLDER",
  "EMAIL_VALID_CURRENT",
  "EMAIL_VALID_STALE",
  "EMAIL_VALID_ANOMALOUS",
  "EMAIL_UNVALIDATED",
  "EMAIL_INVALID",
  "EMAIL_UNSAFE",
  // DNC / suppression / consent
  "DNC_GLOBAL",
  "AUTO_CONTACT_BLOCKED",
  "EMAIL_SUPPRESSED",
  "SMS_SUPPRESSED",
  "CONTACT_COOLING_ACTIVE",
  // Shared identity
  "SHARED_PHONE_REVIEW",
  "SHARED_EMAIL_REVIEW",
  // Missing fields
  "NAME_MISSING",
  "CONTACT_CHANNEL_MISSING",
  // Business link
  "BUSINESS_LINK_VERIFIED",
  "BUSINESS_UNLINKED",
  "BUSINESS_LINK_CANDIDATE",
  "BUSINESS_LINK_CONFLICT",
] as const;

export type QualitySignalCode = typeof ALL_QUALITY_SIGNAL_CODES[number];

export const QUALITY_SIGNAL_CODE_SET = new Set<string>(ALL_QUALITY_SIGNAL_CODES);

// ──────────────────────────────────────────────────────────────────────────────
// Severity mapping (for UI display)
// ──────────────────────────────────────────────────────────────────────────────
export const SIGNAL_SEVERITY: Record<QualitySignalCode, "critical" | "warning" | "info"> = {
  PHONE_MISSING:             "warning",
  PHONE_MALFORMED:           "warning",
  PHONE_PLACEHOLDER:         "critical",
  PHONE_TOLL_FREE:           "info",
  EMAIL_MISSING:             "warning",
  EMAIL_MALFORMED:           "warning",
  EMAIL_PLACEHOLDER:         "critical",
  EMAIL_VALID_CURRENT:       "info",
  EMAIL_VALID_STALE:         "warning",
  EMAIL_VALID_ANOMALOUS:     "warning",
  EMAIL_UNVALIDATED:         "info",
  EMAIL_INVALID:             "critical",
  EMAIL_UNSAFE:              "critical",
  DNC_GLOBAL:                "critical",
  AUTO_CONTACT_BLOCKED:      "critical",
  EMAIL_SUPPRESSED:          "warning",
  SMS_SUPPRESSED:            "warning",
  CONTACT_COOLING_ACTIVE:    "info",
  SHARED_PHONE_REVIEW:       "warning",
  SHARED_EMAIL_REVIEW:       "warning",
  NAME_MISSING:              "warning",
  CONTACT_CHANNEL_MISSING:   "critical",
  BUSINESS_LINK_VERIFIED:    "info",
  BUSINESS_UNLINKED:         "warning",
  BUSINESS_LINK_CANDIDATE:   "info",
  BUSINESS_LINK_CONFLICT:    "warning",
};

export const SIGNAL_DESCRIPTIONS: Record<QualitySignalCode, string> = {
  PHONE_MISSING:             "No phone number present on this contact.",
  PHONE_MALFORMED:           "Phone number does not match a valid NANP format.",
  PHONE_PLACEHOLDER:         "Phone number appears to be a test or placeholder value.",
  PHONE_TOLL_FREE:           "Phone number is a toll-free number (800/888/877/866/855/844/833).",
  EMAIL_MISSING:             "No email address present on this contact.",
  EMAIL_MALFORMED:           "Email address does not pass basic format validation.",
  EMAIL_PLACEHOLDER:         "Email address appears to be a test or placeholder value.",
  EMAIL_VALID_CURRENT:       "Email validated as valid within the last 180 days.",
  EMAIL_VALID_STALE:         "Email validated as valid, but validation is older than 180 days.",
  EMAIL_VALID_ANOMALOUS:     "Email marked valid but no validation timestamp was recorded.",
  EMAIL_UNVALIDATED:         "Email has not been validated by a provider.",
  EMAIL_INVALID:             "Email was rejected by the validation provider.",
  EMAIL_UNSAFE:              "Email is flagged as unsafe or risky by the validation provider.",
  DNC_GLOBAL:                "Contact is marked Do Not Contact — no outreach permitted.",
  AUTO_CONTACT_BLOCKED:      "Contact is marked Do Not Auto Contact — automated outreach blocked.",
  EMAIL_SUPPRESSED:          "Email channel is suppressed (opted out, unsubscribed, or blocked).",
  SMS_SUPPRESSED:            "SMS channel is suppressed (opted out, STOP received, or A2P blocked).",
  CONTACT_COOLING_ACTIVE:    "Contact has an active cooling period — contact not permitted until date clears.",
  SHARED_PHONE_REVIEW:       "This normalized phone number appears on multiple contacts — identity collision review.",
  SHARED_EMAIL_REVIEW:       "This normalized email address appears on multiple contacts — identity collision review.",
  NAME_MISSING:              "No usable first name or last name present on this contact.",
  CONTACT_CHANNEL_MISSING:   "Neither a usable email address nor a phone number is present.",
  BUSINESS_LINK_VERIFIED:    "Contact is linked to a verified business record.",
  BUSINESS_UNLINKED:         "Contact has no business link and no admissible crosswalk evidence.",
  BUSINESS_LINK_CANDIDATE:   "Crosswalk evidence suggests a candidate business link awaiting review.",
  BUSINESS_LINK_CONFLICT:    "Conflicting or stale crosswalk evidence prevents a clean business link.",
};

// ──────────────────────────────────────────────────────────────────────────────
// Input types
// ──────────────────────────────────────────────────────────────────────────────

export interface QualityContactInput {
  contactId: number;
  // Identity
  firstName: string | null;
  lastName: string | null;
  // Phone
  phone: string | null;
  // Email
  email: string | null;
  emailStatus: string | null;
  emailValidationUpdatedAt: Date | null;
  // Suppression / compliance
  doNotContact: boolean | null;
  doNotAutoContact: boolean | null;
  dncReason: string | null;
  dncDate: Date | null;
  suppressionReason: string | null;
  optedOutEmail: boolean | null;
  optOutStatus: string | null;
  unsubscribeStatus: string | null;
  bounceStatus: string | null;
  complaintStatus: string | null;
  smsStatus: string | null;
  smsConsentStatus: string | null;
  consentTier: string | null;
  nextAllowedContactDate: Date | null;
  // Business link
  businessId: number | null;
  companyName: string | null;
  // Crosswalk decisions (resolved externally, set-based per batch)
  crosswalkDecisionType: "none" | "candidate" | "conflict" | null;
}

/** Per-run context loaded once, not per-contact. */
export interface QualityRunContext {
  asOf: Date;
  /**
   * Normalized (digits-only, 10-digit NANP) phones that appear on ≥2 active contacts.
   * Key: normalized 10-digit string.
   * Value: { count: distinct contact count, domainCount: distinct email domain count, tollFree: boolean }
   */
  sharedNormalizedPhones: Map<string, { count: number; domainCount: number; tollFree: boolean }>;
  /**
   * Normalized (trimmed lowercase) emails that appear on ≥2 active contacts.
   * Key: lowercase trimmed email.
   * Value: { count: distinct contact count, domainCount: number }
   */
  sharedNormalizedEmails: Map<string, { count: number; domainCount: number }>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Output type
// ──────────────────────────────────────────────────────────────────────────────

export interface ContactQualityResult {
  contactId: number;
  signalCodes: QualitySignalCode[];
  /**
   * Non-PII details per signal. Contains: bounded status values, booleans, counts,
   * timestamps, validation age in days, rule identifiers, normalized cohort counts.
   * Does NOT contain raw phone numbers or email addresses.
   */
  signalDetails: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phone normalization
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a phone value to a 10-digit NANP string (digits only).
 *
 * Supports:
 *  - 10-digit NANP numbers (direct)
 *  - 11-digit numbers beginning with '1' (strip leading 1)
 *  - Common punctuation: spaces, dashes, dots, parens
 *  - Optional extensions (ignored; only the base number is returned)
 *
 * Returns null if the number cannot be normalized to a 10-digit NANP.
 */
export function normalizeNanpPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip extension markers: "ext", "x", "#" followed by digits at end
  const stripped = raw.replace(/\s*(ext|x|#)[.\s]*\d+\s*$/i, "").trim();
  // Remove all non-digit characters
  const digits = stripped.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
  return null;
}

/**
 * Returns true for toll-free area codes: 800, 888, 877, 866, 855, 844, 833.
 * Input must be a normalized 10-digit NANP string.
 */
export function isTollFreeNanp(normalized: string): boolean {
  const npa = normalized.slice(0, 3);
  return ["800", "888", "877", "866", "855", "844", "833"].includes(npa);
}

/**
 * Returns true if the phone is a known placeholder/test value.
 * Rules (applied to normalized 10-digit NANP):
 *
 * 1. NPA-555-0100 through NPA-555-0199: exchange is '555', subscriber in 0100–0199.
 *    (The fictional reserved block per NANPA. Does NOT flag every 555 exchange.)
 * 2. All same digit (e.g., 1111111111, 0000000000).
 * 3. Sequential ascending run of at least 7 consecutive digits (e.g., 0123456789).
 * 4. Sequential descending run of at least 7 consecutive digits (e.g., 9876543210).
 * 5. Known test fixtures: 5550100–5550199 when area code makes the full number a known
 *    test pattern (e.g., 5555550100 — area 555, exchange 555, sub 0100).
 */
export function isPlaceholderNanp(normalized: string): boolean {
  if (normalized.length !== 10) return false;

  // Rule 1: Reserved 555 block: exchange (positions 3-5) = '555', subscriber starts with '01'
  const exchange = normalized.slice(3, 6);
  const subscriber = normalized.slice(6, 10);
  if (exchange === "555" && subscriber >= "0100" && subscriber <= "0199") return true;

  // Rule 2: All same digit
  if (/^(\d)\1{9}$/.test(normalized)) return true;

  // Rule 3 & 4: Sequential run of 7+ consecutive digits
  if (hasSequentialRun(normalized, 7)) return true;

  return false;
}

/**
 * Returns true if the digit string contains a run of at least `minLen`
 * consecutive ascending or descending digits.
 */
function hasSequentialRun(digits: string, minLen: number): boolean {
  let ascLen = 1;
  let descLen = 1;
  for (let i = 1; i < digits.length; i++) {
    const cur = parseInt(digits[i], 10);
    const prev = parseInt(digits[i - 1], 10);
    if (cur === prev + 1) {
      ascLen++;
      if (ascLen >= minLen) return true;
    } else {
      ascLen = 1;
    }
    if (cur === prev - 1) {
      descLen++;
      if (descLen >= minLen) return true;
    } else {
      descLen = 1;
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Email helpers
// ──────────────────────────────────────────────────────────────────────────────

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Placeholder/test email patterns.
 * Does NOT include role-based addresses (info@, sales@, support@, etc.).
 */
const PLACEHOLDER_EMAIL_RE =
  /^(noemail|no-email|no_email|placeholder|test\.?user|testuser|example\.?user|user@example\.|fake@|dummy@|null@|nobody@|invalid@|void@|noreply@noreply\.|admin@test\.|user@test\.)/i;

const PLACEHOLDER_EMAIL_DOMAIN_RE = /@(example\.(com|org|net|io)|test\.(com|org|net)|localhost|mailinator\.com|guerrillamail\.|yopmail\.|throwam\.com|maildrop\.cc)/i;

/**
 * Returns true for known placeholder/test email patterns.
 * Does NOT flag role-based addresses (info@, sales@, support@).
 */
export function isPlaceholderEmail(email: string): boolean {
  const lower = email.toLowerCase().trim();
  return PLACEHOLDER_EMAIL_RE.test(lower) || PLACEHOLDER_EMAIL_DOMAIN_RE.test(lower);
}

// ──────────────────────────────────────────────────────────────────────────────
// Main classifier — pure, no side effects
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Classify a contact and return zero or more stable quality signal codes.
 *
 * This function MUST NOT:
 *  - Write to any database table
 *  - Call any external provider
 *  - Write any audit log
 *  - Return an authoritative allowed/denied outreach decision
 *  - Mutate any contact field
 */
export function classifyContactQuality(
  input: QualityContactInput,
  ctx: QualityRunContext,
): ContactQualityResult {
  const codes: QualitySignalCode[] = [];
  const details: Record<string, unknown> = {};

  // ── Phase 2: Phone quality ─────────────────────────────────────────────────
  const normalizedPhone = normalizeNanpPhone(input.phone);

  if (!input.phone || input.phone.trim() === "") {
    codes.push("PHONE_MISSING");
  } else if (!normalizedPhone) {
    // Has a phone value but can't normalize to NANP
    const rawDigits = input.phone.replace(/\D/g, "");
    codes.push("PHONE_MALFORMED");
    details.phone_raw_digit_count = rawDigits.length;
  } else {
    // Normalized successfully
    const tollFree = isTollFreeNanp(normalizedPhone);
    const placeholder = isPlaceholderNanp(normalizedPhone);

    if (placeholder) {
      codes.push("PHONE_PLACEHOLDER");
      // Determine which rule fired (non-PII)
      const exchange = normalizedPhone.slice(3, 6);
      const subscriber = normalizedPhone.slice(6, 10);
      if (exchange === "555" && subscriber >= "0100" && subscriber <= "0199") {
        details.phone_placeholder_rule = "reserved_555_block";
      } else if (/^(\d)\1{9}$/.test(normalizedPhone)) {
        details.phone_placeholder_rule = "all_same_digit";
      } else {
        details.phone_placeholder_rule = "sequential_run";
      }
    } else if (tollFree) {
      codes.push("PHONE_TOLL_FREE");
      details.phone_toll_free_npa = normalizedPhone.slice(0, 3);
    }

    // Shared phone review (set-based, normalized)
    const sharedPhoneInfo = ctx.sharedNormalizedPhones.get(normalizedPhone);
    if (sharedPhoneInfo) {
      codes.push("SHARED_PHONE_REVIEW");
      details.shared_phone_count = sharedPhoneInfo.count;
      details.shared_phone_domain_count = sharedPhoneInfo.domainCount;
      details.shared_phone_toll_free = sharedPhoneInfo.tollFree;
      // Note: shared-phone alone is NOT labeled a confirmed duplicate
    }
  }

  // ── Phase 3: Email quality ─────────────────────────────────────────────────
  const emailRaw = input.email?.trim() ?? null;
  const emailLower = emailRaw ? emailRaw.toLowerCase() : null;

  if (!emailLower) {
    codes.push("EMAIL_MISSING");
  } else if (!EMAIL_FORMAT_RE.test(emailLower)) {
    codes.push("EMAIL_MALFORMED");
  } else if (isPlaceholderEmail(emailLower)) {
    codes.push("EMAIL_PLACEHOLDER");
  } else {
    // Classify by validation status
    const status = input.emailStatus ?? "unvalidated";

    if (status === "valid") {
      if (!input.emailValidationUpdatedAt) {
        // Anomalous: marked valid but no timestamp
        codes.push("EMAIL_VALID_ANOMALOUS");
        details.email_validation_state = "valid_no_timestamp";
      } else {
        const ageMs = ctx.asOf.getTime() - new Date(input.emailValidationUpdatedAt).getTime();
        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        if (ageMs < VALIDATION_CURRENT_WINDOW_MS) {
          codes.push("EMAIL_VALID_CURRENT");
          details.email_validation_age_days = ageDays;
        } else {
          codes.push("EMAIL_VALID_STALE");
          details.email_validation_age_days = ageDays;
        }
      }
    } else if (["bounced", "invalid", "blocked"].includes(status)) {
      codes.push("EMAIL_INVALID");
      details.email_invalid_reason = status;
    } else if (status === "unsafe") {
      codes.push("EMAIL_UNSAFE");
    } else if (status === "opted_out" || status === "unsubscribed") {
      // These are handled by suppression signals below (EMAIL_SUPPRESSED)
      // Fall through to UNVALIDATED only if not caught by suppression
      codes.push("EMAIL_UNVALIDATED");
      details.email_validation_state = status;
    } else {
      // active, unvalidated, subscribed, null = unvalidated
      // NOTE: 'subscribed' is NOT opted-out — it means subscribed to email
      codes.push("EMAIL_UNVALIDATED");
      details.email_validation_state = status;
    }

    // Shared email review (set-based, normalized)
    const sharedEmailInfo = ctx.sharedNormalizedEmails.get(emailLower);
    if (sharedEmailInfo) {
      codes.push("SHARED_EMAIL_REVIEW");
      details.shared_email_count = sharedEmailInfo.count;
      details.shared_email_domain_count = sharedEmailInfo.domainCount;
    }
  }

  // ── Phase 4: DNC, suppression, channel evidence ────────────────────────────
  if (input.doNotContact === true) {
    codes.push("DNC_GLOBAL");
    if (input.dncReason) {
      details.dnc_reason_present = true;
    }
    if (input.dncDate) {
      details.dnc_since = input.dncDate.toISOString().slice(0, 10);
    }
  }

  if (input.doNotAutoContact === true) {
    codes.push("AUTO_CONTACT_BLOCKED");
  }

  // Email suppression: opted_out_email flag OR opt_out_status=opted_out OR unsubscribe_status=unsubscribed
  // OR bounce_status=hard OR complaint_status=reported
  // OR email_status=opted_out/bounced/blocked/unsafe
  const emailSuppressed =
    input.optedOutEmail === true ||
    input.optOutStatus === "opted_out" ||
    input.unsubscribeStatus === "unsubscribed" ||
    input.bounceStatus === "hard" ||
    input.complaintStatus === "reported" ||
    (input.emailStatus != null && ["opted_out", "bounced", "blocked"].includes(input.emailStatus)) ||
    !!(input.suppressionReason);

  if (emailSuppressed) {
    codes.push("EMAIL_SUPPRESSED");
    const reasons: string[] = [];
    if (input.optedOutEmail === true) reasons.push("opted_out_email");
    if (input.optOutStatus === "opted_out") reasons.push("opt_out_status");
    if (input.unsubscribeStatus === "unsubscribed") reasons.push("unsubscribed");
    if (input.bounceStatus === "hard") reasons.push("hard_bounce");
    if (input.complaintStatus === "reported") reasons.push("complaint");
    if (input.emailStatus === "opted_out") reasons.push("email_status_opted_out");
    if (input.emailStatus === "bounced") reasons.push("email_status_bounced");
    if (input.emailStatus === "blocked") reasons.push("email_status_blocked");
    if (input.suppressionReason) reasons.push("suppression_reason");
    details.email_suppression_reasons = reasons;
  }

  // SMS suppression: sms_status=opted_out OR sms_consent_status=opted_out OR sms_consent_status=a2p_blocked
  const smsSuppressed =
    input.smsStatus === "opted_out" ||
    input.smsConsentStatus === "opted_out" ||
    input.smsConsentStatus === "a2p_blocked";

  if (smsSuppressed) {
    codes.push("SMS_SUPPRESSED");
    const reasons: string[] = [];
    if (input.smsStatus === "opted_out") reasons.push("sms_status_opted_out");
    if (input.smsConsentStatus === "opted_out") reasons.push("sms_consent_opted_out");
    if (input.smsConsentStatus === "a2p_blocked") reasons.push("a2p_blocked");
    details.sms_suppression_reasons = reasons;
  }

  // Cooling period
  if (input.nextAllowedContactDate && input.nextAllowedContactDate > ctx.asOf) {
    codes.push("CONTACT_COOLING_ACTIVE");
    details.cooling_until = input.nextAllowedContactDate.toISOString().slice(0, 16);
  }

  // ── Phase 5: Missing-field signals ────────────────────────────────────────
  const hasUsableFirstName = !!(input.firstName && input.firstName.trim().length > 0);
  const hasUsableLastName = !!(input.lastName && input.lastName.trim().length > 0);
  const hasUsableEmail = emailLower && EMAIL_FORMAT_RE.test(emailLower);
  const hasUsablePhone = normalizedPhone !== null;

  if (!hasUsableFirstName && !hasUsableLastName) {
    codes.push("NAME_MISSING");
  }

  if (!hasUsableEmail && !hasUsablePhone) {
    codes.push("CONTACT_CHANNEL_MISSING");
  }

  // PHONE_MISSING / EMAIL_MISSING already added above (phase 2 / phase 3)

  // ── Phase 7: Business-link signals ────────────────────────────────────────
  if (input.businessId != null) {
    codes.push("BUSINESS_LINK_VERIFIED");
    details.business_id_present = true;
  } else {
    // No business_id — check crosswalk evidence
    const dec = input.crosswalkDecisionType;
    if (dec === "candidate") {
      codes.push("BUSINESS_LINK_CANDIDATE");
    } else if (dec === "conflict") {
      codes.push("BUSINESS_LINK_CONFLICT");
    } else {
      codes.push("BUSINESS_UNLINKED");
    }
  }

  return {
    contactId: input.contactId,
    signalCodes: deduplicateCodes(codes),
    signalDetails: details,
  };
}

/** Deduplicate signal codes while preserving order. */
function deduplicateCodes(codes: QualitySignalCode[]): QualitySignalCode[] {
  const seen = new Set<string>();
  return codes.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared-value cohort loading helpers (used by the runner once per run)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a QualityRunContext from pre-loaded cohort data.
 * The runner loads these via set-based SQL queries — no per-contact lookups.
 */
export function buildQualityRunContext(
  asOf: Date,
  sharedPhoneRows: Array<{
    normalized_phone: string;
    contact_count: number;
    domain_count: number;
  }>,
  sharedEmailRows: Array<{
    normalized_email: string;
    contact_count: number;
    domain_count: number;
  }>,
): QualityRunContext {
  const sharedNormalizedPhones = new Map<string, { count: number; domainCount: number; tollFree: boolean }>();
  for (const row of sharedPhoneRows) {
    sharedNormalizedPhones.set(row.normalized_phone, {
      count: row.contact_count,
      domainCount: row.domain_count,
      tollFree: isTollFreeNanp(row.normalized_phone),
    });
  }

  const sharedNormalizedEmails = new Map<string, { count: number; domainCount: number }>();
  for (const row of sharedEmailRows) {
    sharedNormalizedEmails.set(row.normalized_email, {
      count: row.contact_count,
      domainCount: row.domain_count,
    });
  }

  return { asOf, sharedNormalizedPhones, sharedNormalizedEmails };
}
