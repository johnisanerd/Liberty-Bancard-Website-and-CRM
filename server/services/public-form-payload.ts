/**
 * Central allowlist for public form → contact profile field mapping.
 *
 * Returns only the fields a public form is permitted to refresh on an existing
 * contact. Protected compliance fields (doNotContact, doNotAutoContact,
 * emailStatus, smsStatus, consentTier, provenance, GHL identity, lifecycle
 * stage, lead/readiness scores, archived state) are always stripped regardless
 * of what arrives in req.body.
 *
 * Consent fields (consentEmail, consentSms) are extracted separately and
 * evaluated by mergePersistedConsentState() — they are NOT in the profile
 * allowlist returned here.
 */

export type PublicFormType =
  | "statement_upload"
  | "estimate_form"
  | "support_form"
  | "get_started_form"
  | "integration_request"
  | "callback_form"
  | "equipment_order"
  | "testimonial_submit"
  | "newsletter_signup"
  | "partner_portal_form";

export interface PublicContactProfilePayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  vertical?: string;
  monthlyVolume?: string | number;
  currentProvider?: string;
  notes?: string;
  interestedIn0Percent?: boolean;
  needTerminal?: boolean;
  primaryOfferPath?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  landingPage?: string;
  referralSource?: string;
}

const PROTECTED_FIELDS = new Set([
  "doNotContact",
  "doNotAutoContact",
  "emailStatus",
  "smsStatus",
  "consentTier",
  "consentEmail",
  "consentSms",
  "lifecycleStage",
  "leadScore",
  "readinessScore",
  "ghlContactId",
  "archivedAt",
  "sourceCategory",
  "primarySourceCategory",
  "primarySourceType",
  "primarySourceEventId",
  "id",
  "createdAt",
  "updatedAt",
  "lastSyncedAt",
  "lastMeaningfulContactMutationAt",
  "partnerOrgId",
  "promoCode",
  "referralSource",
]);

const FORM_PROFILE_ALLOWLISTS: Record<PublicFormType, ReadonlySet<string>> = {
  statement_upload: new Set([
    "firstName", "lastName", "email", "phone", "companyName",
    "vertical", "currentProvider", "interestedIn0Percent", "needTerminal",
    "notes", "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm",
    "landingPage",
  ]),
  estimate_form: new Set([
    "firstName", "lastName", "email", "phone",
    "monthlyVolume", "currentProvider", "notes",
    "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm",
    "landingPage",
  ]),
  support_form: new Set([
    "firstName", "lastName", "email", "phone", "companyName",
  ]),
  get_started_form: new Set([
    "firstName", "lastName", "email", "phone", "vertical",
    "monthlyVolume", "interestedIn0Percent", "needTerminal", "primaryOfferPath",
    "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm",
    "landingPage",
  ]),
  integration_request: new Set([
    "firstName", "lastName", "email", "phone", "companyName", "notes",
  ]),
  callback_form: new Set([
    "firstName", "lastName", "phone",
  ]),
  equipment_order: new Set([
    "firstName", "lastName", "email", "phone", "companyName",
    "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm",
    "landingPage",
  ]),
  testimonial_submit: new Set([
    "firstName", "lastName", "email", "phone",
  ]),
  newsletter_signup: new Set([
    "firstName", "email",
  ]),
  partner_portal_form: new Set([
    "firstName", "lastName", "email", "phone", "companyName",
    "utmSource", "utmMedium", "utmCampaign", "landingPage",
  ]),
};

/**
 * Extracts only the profile fields a given form type is allowed to refresh on
 * an existing contact. All protected fields are always excluded.
 *
 * Pass the parsed+sanitized fields (NOT raw req.body) — callers are responsible
 * for sanitizing string lengths before calling this function.
 */
export function buildPublicContactPayload(
  formType: PublicFormType,
  fields: Record<string, unknown>,
): PublicContactProfilePayload {
  const allowlist = FORM_PROFILE_ALLOWLISTS[formType];
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (PROTECTED_FIELDS.has(key)) continue;
    if (!allowlist.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    payload[key] = value;
  }

  return payload as PublicContactProfilePayload;
}
