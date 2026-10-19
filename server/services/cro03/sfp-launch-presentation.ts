/**
 * Shared presentation for SFP launch emails: the signature block and the small Liberty logo beneath it.
 *
 * This is a dependency-free leaf. The sequence worker, the operator seed test and the preview renderer all reach it
 * through the one launch renderer, so a seed message carries exactly what a customer's message carries. The transport
 * still adds the single compliance footer, mailing address and unsubscribe section; nothing here may add one.
 *
 * The presentation fingerprint is folded into the package content hash and the recipient binding hash, so changing
 * anything here is versioned content: staged preparations and customer release approvals made against the old
 * presentation stop matching and must be refreshed and re-approved.
 */
import { createHash } from "node:crypto";

export const SFP_LAUNCH_PRESENTATION_VERSION = "sfp-launch-presentation-2026-10-19.1";
export const SFP_LAUNCH_SITE_HOST = "libertybancard.com";
/** The only host a launch body may link to (the signature link, logo and secure upload page all live on it). */
export const SFP_LAUNCH_ALLOWED_HOSTS = [SFP_LAUNCH_SITE_HOST];
export const SFP_LAUNCH_SITE_URL = `https://${SFP_LAUNCH_SITE_HOST}`;
/** Existing production logo asset. Dimensions keep the 3360x697 artwork small and proportional. */
export const SFP_LAUNCH_LOGO_URL = `${SFP_LAUNCH_SITE_URL}/logo-blue.png`;
export const SFP_LAUNCH_LOGO_ALT = "Liberty Bancard logo";
const LOGO_WIDTH = 120;
const LOGO_HEIGHT = 25;

export const SFP_SIGNATURE_MARKER = "data-sfp-signature";

export interface SfpSignatureFacts { agentName: string; agentPhone: string }

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Signature as a plain table: readable with images blocked (the logo is the last row and has descriptive alt text,
 * every fact above it is real text).
 */
export function renderSfpLaunchSignatureHtml(facts: SfpSignatureFacts): string {
  const name = esc(facts.agentName), phone = esc(facts.agentPhone);
  // Line-per-div (not table rows) so the plain-text part derived from this HTML keeps one fact per line.
  return `<div ${SFP_SIGNATURE_MARKER}="1" style="margin:22px 0 0 0;padding-top:10px;border-top:2px solid #1e3a5f;font-family:Arial,Helvetica,sans-serif;">
<div style="font-size:15px;line-height:1.3;font-weight:bold;color:#1e3a5f;">${name}</div><div style="padding-top:2px;font-size:13px;line-height:1.4;color:#333333;">Liberty Bancard</div><div style="padding-top:2px;font-size:13px;line-height:1.4;color:#333333;">${phone}&nbsp;|&nbsp;<a href="${SFP_LAUNCH_SITE_URL}" style="color:#1e3a5f;text-decoration:underline;">${SFP_LAUNCH_SITE_HOST}</a></div><div style="padding-top:10px;"><img src="${SFP_LAUNCH_LOGO_URL}" alt="${SFP_LAUNCH_LOGO_ALT}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" style="display:block;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;border:0;outline:none;text-decoration:none;" /></div></div>`;
}

export function renderSfpLaunchSignatureText(facts: SfpSignatureFacts): string {
  return `${facts.agentName}\nLiberty Bancard\n${facts.agentPhone} | ${SFP_LAUNCH_SITE_HOST}`;
}

export class SfpPresentationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "SfpPresentationError"; }
}

/** Appends the signature to a rendered body. Refuses a body that already carries a signature or a compliance footer. */
export function applySfpLaunchPresentation(bodyHtml: string, facts: SfpSignatureFacts): string {
  if (bodyHtml.includes(SFP_SIGNATURE_MARKER)) throw new SfpPresentationError("SFP_PRESENTATION_DUPLICATE_SIGNATURE");
  if (/data-can-spam-footer/i.test(bodyHtml)) throw new SfpPresentationError("SFP_PRESENTATION_BODY_CONTAINS_FOOTER");
  return `${bodyHtml}\n${renderSfpLaunchSignatureHtml(facts)}`;
}

export function applySfpLaunchPresentationText(bodyText: string, facts: SfpSignatureFacts): string {
  return `${bodyText.replace(/\s+$/, "")}\n\n${renderSfpLaunchSignatureText(facts)}`;
}

/**
 * Fingerprint of everything the presentation contributes, derived from the renderer's own output so editing the
 * markup, logo, alt text, links or version string changes it without a separate manual bump.
 */
export function sfpLaunchPresentationFingerprint(): string {
  const probe = { agentName: "Probe Sender", agentPhone: "000-000-0000" };
  return createHash("sha256").update(JSON.stringify([
    SFP_LAUNCH_PRESENTATION_VERSION, renderSfpLaunchSignatureHtml(probe), renderSfpLaunchSignatureText(probe),
  ])).digest("hex");
}
