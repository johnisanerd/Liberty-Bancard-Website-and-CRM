import { storage } from "../storage";
import { generateUnsubscribeToken } from "./unsubscribe-token";
import type { FollowUpSequence } from "@shared/schema";
import type { SignatureType } from "./sender-policy";

export interface EmailSignature {
  name: string;
  title: string;
  phone: string;
  email: string;
  website?: string;
  calendlyLink?: string;
  refCode?: string;
}

export interface PromoOffer {
  headline: string;
  description: string;
  expiry?: string;
}

const BASE_URL = "https://libertybancard.com";
const QUIZ_PATH = "/free-analysis";
const SHOP_PATH = "/shop";

const DEFAULT_PROMO: PromoOffer = {
  headline: "Free Terminal this month",
  description: "Sign up this month and receive a free terminal — subject to eligibility and equipment program terms.",
};

/**
 * Default sender profiles — all From/email addresses are aligned with the
 * sender policy registry (sender-policy.ts). Any change here must mirror the
 * policy registry and vice versa.
 */
const DEFAULT_SIGNATURES: Record<SignatureType, EmailSignature> = {
  /** Cold SDR outreach — uses dedicated cold-outreach mailbox. */
  sales: {
    name: "Scott Stevenson",
    title: "Business Development",
    phone: "954-266-8214",
    email: "Scott@mail.libertybancard.com",
    website: BASE_URL,
    calendlyLink: "https://api.leadconnectorhq.com/widget/booking/liberty-bancard",
  },
  support: {
    name: "Liberty Bancard Support",
    title: "Merchant Support",
    phone: "954-266-8214",
    email: "support@libertybancard.com",
    website: BASE_URL,
  },
  onboarding: {
    name: "Liberty Bancard Onboarding",
    title: "New Merchant Activation",
    phone: "954-266-8214",
    email: "onboarding@libertybancard.com",
    website: BASE_URL,
  },
  security: {
    name: "Liberty Bancard Security",
    title: "Account Security",
    phone: "954-266-8214",
    email: "security@libertybancard.com",
    website: BASE_URL,
  },
  partners: {
    name: "Liberty Bancard Partner Program",
    title: "Partner Relations",
    phone: "954-266-8214",
    email: "partners@libertybancard.com",
    website: BASE_URL,
  },
  accounts: {
    name: "Liberty Bancard Account Management",
    title: "Account Management",
    phone: "954-266-8214",
    email: "accounts@libertybancard.com",
    website: BASE_URL,
  },
};

/**
 * Type-specific disclaimers.
 * Security type carries the phishing/social-engineering warning.
 * All other types carry the general eligibility disclaimer.
 */
const TYPE_DISCLAIMER: Record<SignatureType, string> = {
  sales: "Eligibility, underwriting, card brand rules, and applicable laws apply.",
  support: "Eligibility, underwriting, card brand rules, and applicable laws apply.",
  onboarding: "Eligibility, underwriting, card brand rules, and applicable laws apply.",
  security:
    "Liberty Bancard will never ask for your password or complete payment-card number by email. " +
    "If you did not initiate this action, call us immediately at 954-266-8214.",
  partners: "Eligibility, underwriting, card brand rules, and applicable laws apply.",
  accounts: "Eligibility, underwriting, card brand rules, and applicable laws apply.",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildLink(path: string, refCode?: string): string {
  const url = `${BASE_URL}${path}`;
  if (refCode) return `${url}?ref=${encodeURIComponent(refCode)}`;
  return url;
}

export function getCurrentPromo(): PromoOffer {
  return DEFAULT_PROMO;
}

export function getEmailSignatureHtml(
  type: SignatureType = "sales",
  customSig?: Partial<EmailSignature>,
  promo?: PromoOffer | null,
): string {
  const base = DEFAULT_SIGNATURES[type] ?? DEFAULT_SIGNATURES.sales;
  const sig = { ...base, ...customSig };
  const activePromo = promo ?? null;
  const name = escapeHtml(sig.name);
  const title = escapeHtml(sig.title);
  const phone = escapeHtml(sig.phone);
  const email = escapeHtml(sig.email);
  const website = escapeHtml(sig.website ?? BASE_URL);
  const link = sig.calendlyLink ? escapeHtml(sig.calendlyLink) : "";
  const quizUrl = escapeHtml(buildLink(QUIZ_PATH, sig.refCode));
  const shopUrl = escapeHtml(buildLink(SHOP_PATH, sig.refCode));
  const disclaimer = escapeHtml(TYPE_DISCLAIMER[type] ?? TYPE_DISCLAIMER.sales);

  const promoLine = activePromo
    ? `<tr><td style="padding-top:8px;font-size:12px;color:#1e3a5f;"><strong>P.S.</strong> ${escapeHtml(activePromo.headline)} — ${escapeHtml(activePromo.description)}</td></tr>`
    : "";

  const appUrl = process.env.APP_URL;
  let logoBlock = "";
  if (appUrl) {
    const logoUrl = escapeHtml(`${appUrl}/logo-blue.png`);
    logoBlock = `<img src="${logoUrl}" alt="Liberty Bancard" width="140" style="max-width:140px;width:100%;height:auto;display:block;margin-bottom:10px;border:none;outline:none;text-decoration:none;" />\n`;
  } else {
    console.warn("[email-signatures] APP_URL is not set — logo omitted from email signature");
  }

  const isColdSales = type === "sales";

  const actionRows = isColdSales
    ? `
  <tr>
    <td style="padding-top:14px;">
      <a href="${quizUrl}" style="display:inline-block;background-color:#1e3a5f;color:#ffffff;padding:10px 22px;border-radius:5px;text-decoration:none;font-size:13px;font-weight:bold;line-height:1.4;">Get Your Free Savings Analysis</a>
    </td>
  </tr>
  ${promoLine}`
    : "";

  return `
<br/>
<div data-liberty-signature="1" style="max-width:560px;">
${logoBlock}<table style="font-family:Arial,sans-serif;font-size:13px;color:#333;border-collapse:collapse;width:100%;">
  <tr>
    <td style="border-left:3px solid #1e3a5f;padding-left:12px;line-height:1.6;">
      <strong style="font-size:14px;color:#1e3a5f;display:block;margin-bottom:2px;">${name}</strong>
      <span style="color:#666;font-size:12px;">${title} | Liberty Bancard</span><br/>
      <span style="color:#555;font-size:12px;">${phone}</span>
      &nbsp;·&nbsp;
      <a href="mailto:${email}" style="color:#1e3a5f;font-size:12px;text-decoration:none;">${email}</a><br/>
      <a href="${website}" style="color:#1e3a5f;font-size:12px;text-decoration:none;">${website}</a><br/>
      ${link ? `<a href="${link}" style="color:#1e3a5f;font-size:12px;text-decoration:underline;font-weight:600;">📅 Schedule a Free Statement Review</a><br/>` : ""}
      ${isColdSales ? `<a href="${shopUrl}" style="color:#1e3a5f;font-size:12px;text-decoration:underline;">Browse Terminals &amp; Equipment</a><br/>` : ""}
      <span style="font-size:11px;color:#aaa;margin-top:6px;display:inline-block;">${disclaimer}</span>
    </td>
  </tr>
  ${actionRows}
</table>
</div>`;
}

export function getEmailSignaturePlainText(
  type: SignatureType = "sales",
  customSig?: Partial<EmailSignature>,
  promo?: PromoOffer | null,
): string {
  const base = DEFAULT_SIGNATURES[type] ?? DEFAULT_SIGNATURES.sales;
  const sig = { ...base, ...customSig };
  const activePromo = promo ?? null;
  const quizUrl = buildLink(QUIZ_PATH, sig.refCode);
  const shopUrl = buildLink(SHOP_PATH, sig.refCode);
  const website = sig.website ?? BASE_URL;
  const disclaimer = TYPE_DISCLAIMER[type] ?? TYPE_DISCLAIMER.sales;

  let text = `\n\n--\n${sig.name}\n${sig.title} | Liberty Bancard\n${sig.phone} | ${sig.email}\n${website}`;
  if (sig.calendlyLink) text += `\nSchedule a Review: ${sig.calendlyLink}`;
  if (type === "sales") {
    text += `\n\nGet Your Free Savings Analysis: ${quizUrl}`;
    text += `\nBrowse Terminals & Equipment: ${shopUrl}`;
    if (activePromo) text += `\n\nP.S. ${activePromo.headline} — ${activePromo.description}`;
  }
  text += `\n\n${disclaimer}`;
  return text;
}

const TRANSACTIONAL_FAMILIES = new Set([
  "closed_won",
  "closed-won-onboarding",
  "onboarding_step",
  "merchant_welcome",
  "no_show",
  "no-show-recovery",
  "booked-appointment",
  "support",
  "ticket",
]);

const TRANSACTIONAL_TRIGGER_TYPES = new Set([
  "deal_stage_changed",
  "merchant_approved",
  "application_submitted",
  "onboarding_complete",
  "ticket_created",
  "support_submitted",
]);

export function isColdOutreachSequence(sequence: Pick<FollowUpSequence, "sequenceFamily" | "triggerType">): boolean {
  const family = sequence.sequenceFamily ?? "";
  const trigger = sequence.triggerType ?? "";

  if (family === "cold-email-manual-call" || family === "cold_email_manual_call") return true;
  if (trigger === "contact_created" || trigger === "form_submitted") return true;

  if (TRANSACTIONAL_FAMILIES.has(family)) return false;
  if (TRANSACTIONAL_TRIGGER_TYPES.has(trigger)) return false;

  return true;
}

/**
 * CAN-SPAM / CASL compliant footer for cold commercial outreach.
 *
 * Rules:
 *  - Must NOT make false claims about why the recipient is on the list
 *    ("expressed interest" is false for cold prospects obtained from public records).
 *  - Must include the sender's physical mailing address.
 *  - Must include a working unsubscribe mechanism.
 */
export function getComplianceFooterHtml(contactId: number, mailingAddress: string, baseUrl: string): string {
  const token = generateUnsubscribeToken(contactId);
  const unsubscribeUrl = `${baseUrl}/unsubscribe?t=${encodeURIComponent(token)}`;
  const safeAddress = escapeHtml(mailingAddress);
  const safeUrl = escapeHtml(unsubscribeUrl);

  return `
<br/>
<table style="font-family:Arial,sans-serif;font-size:11px;color:#999;border-collapse:collapse;margin-top:16px;border-top:1px solid #eee;" width="100%">
  <tr>
    <td style="padding-top:10px;font-size:11px;color:#999;line-height:1.5;">
      Liberty Bancard | ${safeAddress}<br/>
      This is a commercial communication from Liberty Bancard. Your business contact information was obtained from publicly available sources.<br/>
      To opt out of future commercial messages, <a href="${safeUrl}" style="color:#999;text-decoration:underline;">click here to unsubscribe</a>.
    </td>
  </tr>
</table>`;
}

/**
 * Plain-text equivalent of getComplianceFooterHtml — used in multipart sends.
 */
export function getComplianceFooterPlainText(contactId: number, mailingAddress: string, baseUrl: string): string {
  const token = generateUnsubscribeToken(contactId);
  const unsubscribeUrl = `${baseUrl}/unsubscribe?t=${encodeURIComponent(token)}`;
  return (
    `\n\n---\nLiberty Bancard | ${mailingAddress}\n` +
    `This is a commercial communication from Liberty Bancard. ` +
    `Your business contact information was obtained from publicly available sources.\n` +
    `To opt out of future commercial messages, visit: ${unsubscribeUrl}`
  );
}

export async function getStoredSignature(type: string): Promise<EmailSignature> {
  const stored = await storage.getSystemSetting(`email_signature_${type}`);
  if (stored) {
    const fallback = (DEFAULT_SIGNATURES as Record<string, EmailSignature>)[type] ?? DEFAULT_SIGNATURES.sales;
    return { ...fallback, ...stored };
  }
  return (DEFAULT_SIGNATURES as Record<string, EmailSignature>)[type] ?? DEFAULT_SIGNATURES.sales;
}

export async function saveSignature(type: string, sig: Partial<EmailSignature>): Promise<void> {
  await storage.setSystemSetting(`email_signature_${type}`, sig);
}

/**
 * Seed default sender profiles into system_settings on first startup.
 * Safe to call multiple times — only writes keys that are not yet set.
 */
export async function seedDefaultSignatures(): Promise<void> {
  for (const [type, sig] of Object.entries(DEFAULT_SIGNATURES)) {
    const existing = await storage.getSystemSetting(`email_signature_${type}`).catch(() => null);
    if (!existing) {
      await storage.setSystemSetting(`email_signature_${type}`, sig).catch(err =>
        console.warn(`[email-signatures] Failed to seed signature "${type}":`, err.message)
      );
      console.log(`[email-signatures] Seeded default sender profile: ${type} (${sig.name} <${sig.email}>)`);
    }
  }
}

/**
 * Async version of getEmailSignatureHtml — reads DB-configured sender profile first,
 * falls back to DEFAULT_SIGNATURES. Use this in async contexts (workers, background jobs).
 */
export async function getEmailSignatureHtmlAsync(
  type: SignatureType = "sales",
  customSig?: Partial<EmailSignature>,
  promo?: PromoOffer | null,
): Promise<string> {
  const dbSig = await getStoredSignature(type);
  return getEmailSignatureHtml(type, { ...dbSig, ...customSig }, promo);
}

/**
 * Get all configured sender profiles (DB-backed with hardcoded fallback).
 */
export async function getAllSenderProfiles(): Promise<Record<string, EmailSignature>> {
  const result: Record<string, EmailSignature> = {};
  for (const type of Object.keys(DEFAULT_SIGNATURES) as SignatureType[]) {
    result[type] = await getStoredSignature(type);
  }
  return result;
}

/**
 * Exported for use by tests and call-site verification.
 * Returns the resolved type-specific disclaimer string (no HTML escaping).
 */
export function getDisclaimerText(type: SignatureType): string {
  return TYPE_DISCLAIMER[type] ?? TYPE_DISCLAIMER.sales;
}

/**
 * Exported for use by tests: the full set of default signature profiles.
 * Callers must not mutate the returned object.
 */
export function getDefaultSignatures(): Readonly<Record<SignatureType, EmailSignature>> {
  return DEFAULT_SIGNATURES;
}
