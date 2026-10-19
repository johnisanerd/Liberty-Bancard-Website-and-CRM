/**
 * CAN-SPAM compliant email footer injection.
 *
 * Rendered only by the SMTP transport for commercial sends, so individual
 * campaign call sites never manage compliance markup or unsubscribe headers.
 *
 * Required elements (15 U.S.C. § 7704):
 *  - Physical postal address of the sender
 *  - Clear and conspicuous opt-out mechanism
 *
 * When a `contactId` is provided, a signed HMAC token is embedded in the
 * unsubscribe link so the `/unsubscribe?t=...` endpoint can authenticate the
 * request and update the contact's opt-out status.
 *
 * Commercial sends require a contact ID. The exported renderer is intentionally
 * fail-closed for known contacts whose canonical configuration is unavailable.
 */

import { storage } from "../storage";
import { generateUnsubscribeToken, getUnsubscribeTokenSecret } from "./unsubscribe-token";

export type CommercialComplianceConfig =
  | { ok: true; mailingAddress: string; unsubscribeUrl: string | null }
  | { ok: false; error: string };

export type EmailCommercialPurpose = "marketing_outreach" | "transactional_response";
export type CommercialComplianceLoader = (contactId?: number) => Promise<CommercialComplianceConfig>;

/** The sole canonical source for commercial SMTP compliance prerequisites. */
export async function getCommercialComplianceConfig(contactId?: number): Promise<CommercialComplianceConfig> {
  let mailingAddress: unknown;
  try {
    mailingAddress = await storage.getSystemSetting("compliance_mailing_address");
  } catch {
    return { ok: false, error: "COMPLIANCE_CONFIGURATION_UNAVAILABLE" };
  }
  if (typeof mailingAddress !== "string" || !mailingAddress.trim()) {
    return { ok: false, error: "COMPLIANCE_MAILING_ADDRESS_MISSING" };
  }
  if (!contactId) {
    return { ok: true, mailingAddress: mailingAddress.trim(), unsubscribeUrl: null };
  }
  const appUrl = process.env.APP_URL?.trim();
  let baseUrl: URL;
  try {
    baseUrl = new URL(appUrl ?? "");
    if (baseUrl.protocol !== "https:") throw new Error("APP_URL must use HTTPS");
  } catch {
    return { ok: false, error: "COMPLIANCE_APP_URL_INVALID" };
  }
  try {
    getUnsubscribeTokenSecret();
    const token = generateUnsubscribeToken(contactId);
    return {
      ok: true,
      mailingAddress: mailingAddress.trim(),
      unsubscribeUrl: `${baseUrl.origin}/unsubscribe?t=${encodeURIComponent(token)}`,
    };
  } catch {
    return { ok: false, error: "COMPLIANCE_UNSUBSCRIBE_SECRET_MISSING" };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Returns true when the HTML body already contains a CAN-SPAM footer block,
 * so we never double-inject on templates that build their own.
 */
function removeExistingFooters(html: string): string {
  // Only suppress injection when the body already contains our own injected
  // marker.  URL-substring checks (e.g. /unsubscribe?t=) cannot be trusted
  // because they match unfilled template literals, invalid tokens, and other
  // non-functional opt-out links without verifying the HMAC.  The marker is
  // only present when injectCanSpamFooter() has already run successfully.
  return html.replace(/<div\b[^>]*\bdata-can-spam-footer(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>[\s\S]*?<\/div>/gi, "");
}

export function htmlToReadableText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TEXT_FOOTER_START = "[CAN-SPAM-FOOTER]";
const TEXT_FOOTER_END = "[/CAN-SPAM-FOOTER]";

/** Pure plain-text renderer; callers must pass one already-resolved config. */
export function injectCanSpamTextFooter(text: string, config: Extract<CommercialComplianceConfig, { ok: true }>): string {
  const marker = /\n?\[CAN-SPAM-FOOTER\][\s\S]*?\[\/CAN-SPAM-FOOTER\]\s*/g;
  const body = text.replace(marker, "").trimEnd();
  const unsubscribe = config.unsubscribeUrl
    ? `Unsubscribe: ${config.unsubscribeUrl}`
    : 'To unsubscribe, reply with "UNSUBSCRIBE" in the subject line.';
  return `${body}\n\n${TEXT_FOOTER_START}\nCommercial message from Liberty Bancard\n${config.mailingAddress}\n${unsubscribe}\n${TEXT_FOOTER_END}`;
}

export async function renderEmailPartsForPurpose(params: {
  html: string;
  text?: string;
  purpose: EmailCommercialPurpose;
  contactId?: number;
  complianceLoader?: CommercialComplianceLoader;
}): Promise<{
  html: string;
  text: string;
  complianceConfig?: Extract<CommercialComplianceConfig, { ok: true }>;
}> {
  const baseText = params.text ?? htmlToReadableText(params.html);
  if (params.purpose === "transactional_response") {
    return { html: params.html, text: baseText };
  }
  // A caller-supplied compliance loader is the seed-test path (its unsubscribe link is not a contact link).
  if (!params.contactId && !params.complianceLoader) throw new Error("COMMERCIAL_CONTACT_REQUIRED");
  const resolved = await (params.complianceLoader ?? getCommercialComplianceConfig)(params.contactId);
  if (!resolved.ok) throw new Error(resolved.error);
  return {
    html: await injectCanSpamFooter(params.html, params.contactId, resolved),
    text: injectCanSpamTextFooter(baseText, resolved),
    complianceConfig: resolved,
  };
}

export async function renderEmailHtmlForPurpose(params: {
  html: string;
  purpose: EmailCommercialPurpose;
  contactId?: number;
  complianceLoader?: CommercialComplianceLoader;
}): Promise<string> {
  if (params.purpose === "transactional_response") return params.html;
  return (await renderEmailPartsForPurpose(params)).html;
}

/**
 * Inject a CAN-SPAM compliant footer into an HTML email body.
 *
 * @param html       The full HTML body to inject into.
 * @param contactId  DB contact ID used to generate a signed one-click
 *                   unsubscribe URL.
 */
export async function injectCanSpamFooter(
  html: string,
  contactId?: number,
  config?: CommercialComplianceConfig,
): Promise<string> {
  const body = removeExistingFooters(html);
  const resolved = config ?? await getCommercialComplianceConfig(contactId);
  if (!resolved.ok) {
    throw new Error(resolved?.error ?? "COMPLIANCE_CONFIGURATION_MISSING");
  }
  const address = escapeHtml(resolved.mailingAddress);
  const signedUrl = resolved.unsubscribeUrl ? escapeHtml(resolved.unsubscribeUrl) : null;

  const unsubscribeLine = signedUrl
    ? `To stop receiving these emails, <a href="${signedUrl}" style="color:#888;">click here to unsubscribe</a>.`
    : `To stop receiving these emails, reply with "UNSUBSCRIBE" in the subject line.`;

  const footer = `
<div data-can-spam-footer="1" style="margin-top:32px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:11px;color:#888;text-align:center;font-family:Arial,sans-serif;">
  <p style="margin:4px 0;">Commercial message from Liberty Bancard</p>
  <p style="margin:4px 0;">${address}</p>
  <p style="margin:4px 0;">${unsubscribeLine}</p>
</div>`;

  if (body.includes("</body>")) {
    return body.replace("</body>", `${footer}\n</body>`);
  }
  return body + footer;
}
