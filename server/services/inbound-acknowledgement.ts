/**
 * Inbound acknowledgement owner.
 *
 * Exactly one acknowledgement exists per inbound `transactional_ack` effect. This module is the only code that
 * prepares, dispatches and settles it. Route handlers never send receipts; they only create the durable request
 * occurrence (see inbound-request-authority.ts). Statement-upload step 9 and every other source reference this
 * owner instead of owning a second sender.
 *
 * Delivery capability
 *   Ships CLOSED. While closed, new requests still progress locally and show a truthful "email blocked" state.
 *   An admin opens it per source class (Enable transactional purpose); that is distinct from publishing
 *   content and from activating any campaign. It never unpauses global outbound; it only lets the SMTP
 *   transport grant a per-message lease that the pause authority re-verifies (see authorizeInboundAckSend).
 *
 * State vocabulary (ack row)
 *   prepared | blocked (waiting, no external attempt) | attempting | accepted (transport accepted, not inbox
 *   delivery) | uncertain (never auto-retried) | failed | suppressed (contactability refused).
 */
import crypto from "crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  contacts,
  inboundAcknowledgements,
  inboundRequestEffects,
  inboundRequests,
} from "@shared/schema";
import { storage } from "../storage";

export const ACK_CAPABILITY_KEY = "inbound_ack_delivery_capability";
export const ACK_OWNER_STARTED_KEY = "inbound_ack_owner_started_at";
export const ACK_PRESENTATION_VERSION = "ack-receipt-v1";
export const ACK_MAX_SEND_ATTEMPTS = 3;
export const ACK_SOURCE_CLASSES = [
  "sales_request", "support_request", "fulfillment_request", "partner_application_request", "privacy_request",
] as const;
export type AckSourceClass = (typeof ACK_SOURCE_CLASSES)[number];

/** Representative source type per class, used only to render the admin receipt preview. Exhaustive by type. */
export const ACK_PREVIEW_SOURCE_TYPE: Record<AckSourceClass, string> = {
  sales_request: "estimate_form", support_request: "support_form", fulfillment_request: "equipment_request",
  partner_application_request: "partner_application", privacy_request: "privacy_request",
};

/**
 * A privacy request has no CRM contact by design (no marketing or provider record is created for it). Its receipt goes
 * to the mailbox captured on the request itself, with no contact binding. Every other class requires a contact.
 */
export const ACK_CONTACTLESS_SOURCE_CLASSES: readonly string[] = ["privacy_request"];
const isContactless = (sourceClass: string) => ACK_CONTACTLESS_SOURCE_CLASSES.includes(sourceClass);

/**
 * Block reasons that can never clear: eligibility only moves forward (activation is never backdated) and the
 * recipient snapshot is immutable. The sweep stops revisiting these, so a backlog of them cannot starve new requests.
 */
export const ACK_TERMINAL_BLOCK_REASONS = [
  "capability_closed", "capability_expired", "source_class_not_enabled", "request_before_eligibility_window",
  "eligibility_window_missing", "no_recipient_on_request", "no_submitted_email_on_request",
  "recipient_changed_since_submission", "request_missing", "unexpected_contact_on_contactless_request",
] as const;

export interface AckCapability {
  enabled: boolean;
  /** Requests received before this instant are never acknowledged by email (no historical catch-up). */
  eligibleFrom: string | null;
  expiresAt: string | null;
  sourceClasses: string[];
  activatedBy: string | null;
  activatedAt: string | null;
}

const CLOSED: AckCapability = {
  enabled: false, eligibleFrom: null, expiresAt: null, sourceClasses: [], activatedBy: null, activatedAt: null,
};

/** Throws when the setting cannot be read, so a transient read failure is never recorded as a permanent closure. */
async function readAckCapability(): Promise<AckCapability> {
  const raw = await storage.getSystemSetting(ACK_CAPABILITY_KEY);
  if (!raw) return CLOSED;
  {
    let parsed: any;
    try { parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)); } catch { return CLOSED; }
    if (!parsed || parsed.enabled !== true) return CLOSED;
    return {
      enabled: true,
      eligibleFrom: typeof parsed.eligibleFrom === "string" ? parsed.eligibleFrom : null,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      sourceClasses: Array.isArray(parsed.sourceClasses) ? parsed.sourceClasses.filter((x: unknown) => typeof x === "string") : [],
      activatedBy: typeof parsed.activatedBy === "string" ? parsed.activatedBy : null,
      activatedAt: typeof parsed.activatedAt === "string" ? parsed.activatedAt : null,
    };
  }
}

/** Missing, malformed or unreadable capability is CLOSED. */
export async function getAckCapability(): Promise<AckCapability> {
  try { return await readAckCapability(); } catch { return CLOSED; }
}

async function getOwnerStartedAt(): Promise<Date> {
  const existing = await storage.getSystemSetting(ACK_OWNER_STARTED_KEY);
  if (typeof existing === "string" && !Number.isNaN(Date.parse(existing))) return new Date(existing);
  const now = new Date();
  await storage.setSystemSetting(ACK_OWNER_STARTED_KEY, now.toISOString());
  return now;
}

/** Pure: can this request be acknowledged by email under this capability right now? */
export function ackCapabilityAllows(
  cap: AckCapability,
  input: { sourceClass: string; sourceReceivedAt: Date; ownerStartedAt: Date; now?: Date },
): { ok: true } | { ok: false; reason: string } {
  const now = input.now ?? new Date();
  if (!cap.enabled) return { ok: false, reason: "capability_closed" };
  if (cap.expiresAt && Date.parse(cap.expiresAt) <= now.getTime()) return { ok: false, reason: "capability_expired" };
  if (!cap.sourceClasses.includes(input.sourceClass)) return { ok: false, reason: "source_class_not_enabled" };
  if (!cap.eligibleFrom || Number.isNaN(Date.parse(cap.eligibleFrom))) return { ok: false, reason: "eligibility_window_missing" };
  const from = Math.max(Date.parse(cap.eligibleFrom), input.ownerStartedAt.getTime());
  if (input.sourceReceivedAt.getTime() < from) return { ok: false, reason: "request_before_eligibility_window" };
  return { ok: true };
}

export async function setAckCapability(input: {
  enabled: boolean;
  sourceClasses?: string[];
  eligibleFrom?: Date;
  expiresAt?: Date | null;
  actor: string;
}): Promise<AckCapability> {
  const now = new Date();
  const ownerStartedAt = await getOwnerStartedAt();
  const value: AckCapability = input.enabled
    ? {
        enabled: true,
        // Never earlier than now: a request that predates activation can never become eligible (no catch-up, no backdating).
        eligibleFrom: (input.eligibleFrom && input.eligibleFrom > now ? input.eligibleFrom : now).toISOString(),
        expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
        sourceClasses: (input.sourceClasses ?? []).filter((c) => (ACK_SOURCE_CLASSES as readonly string[]).includes(c)),
        activatedBy: input.actor,
        activatedAt: now.toISOString(),
      }
    : CLOSED;
  await storage.setSystemSetting(ACK_CAPABILITY_KEY, JSON.stringify(value));
  await storage.createAuditLog({
    action: input.enabled ? "inbound_ack_capability_enabled" : "inbound_ack_capability_closed",
    entityType: "system_setting",
    entityId: 0,
    details: { actor: input.actor, sourceClasses: value.sourceClasses, eligibleFrom: value.eligibleFrom, expiresAt: value.expiresAt },
  } as any);
  return value;
}

// ── Content ───────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SOURCE_LABELS: Record<string, string> = {
  estimate_form: "estimate request",
  get_started_form: "get-started request",
  callback_form: "callback request",
  free_analysis: "free analysis request",
  statement_upload: "statement upload",
  integration_request: "integration request",
  support_form: "support request",
  equipment_request: "equipment request",
  partner_application: "partner application",
  privacy_request: "privacy request",
  partner_portal: "request",
};

export function ackReference(requestId: string): string {
  return requestId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export interface AckContent { templateKey: string; subject: string; html: string; text: string }

/**
 * Factual receipt only: no timing promise, no approval/quote/analysis claim, no CTA, no promotional content.
 * The signature owner supplies the single logo and signature; the SMTP boundary adds its own transport footer.
 */
export async function buildAckContent(input: {
  sourceClass: string; sourceType: string; requestId: string; firstName?: string | null;
}): Promise<AckContent> {
  const label = SOURCE_LABELS[input.sourceType] ?? "request";
  const ref = ackReference(input.requestId);
  const greeting = input.firstName?.trim() ? `Hello ${input.firstName.trim()},` : "Hello,";
  const next =
    input.sourceClass === "support_request"
      ? "A member of our support team will review it and reply to this email."
      : input.sourceClass === "fulfillment_request"
        ? "Our team will review the details and follow up using this email address."
        : input.sourceClass === "partner_application_request"
          ? "Our team will review your application and contact you at the email address you provided."
          : input.sourceClass === "privacy_request"
            ? "Our team will review it and respond to this email address. Please do not reply with sensitive personal information."
            : "A member of our team will review it and follow up using the email address you provided.";
  const templateKey = `ack.${input.sourceClass}`;
  const subject = `We received your ${label} (ref ${ref})`;
  const lines = [greeting, `We received your ${label}. Your reference is ${ref}.`, next];
  const { getEmailSignatureHtml, getEmailSignaturePlainText, getStoredSignature } = await import("./email-signatures");
  const sig = await getStoredSignature("support");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#1f2937;max-width:600px;">` +
    `<p style="margin:0 0 12px;">${esc(greeting)}</p>` +
    `<p style="margin:0 0 12px;">We received your ${esc(label)}. Your reference is <strong>${esc(ref)}</strong>.</p>` +
    `<p style="margin:0 0 20px;">${esc(next)}</p>` +
    `${getEmailSignatureHtml("support", sig)}</div>`;
  const text = `${lines.join("\n\n")}\n\n${getEmailSignaturePlainText("support", sig)}`;
  return { templateKey, subject, html, text };
}

export function ackContentHash(m: { to: string; subject: string; html: string; text?: string | null }): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify([m.to.trim().toLowerCase(), m.subject, m.html, m.text ?? ""]))
    .digest("hex");
}

// ── Prepare (bind recipient/purpose/content before any dispatch) ──────────

type AckRow = typeof inboundAcknowledgements.$inferSelect;

export async function prepareAcknowledgement(effectId: string): Promise<AckRow | null> {
  const [existing] = await db.select().from(inboundAcknowledgements).where(eq(inboundAcknowledgements.effectId, effectId)).limit(1);
  if (existing) return existing;

  const [row] = await db
    .select({
      effectType: inboundRequestEffects.effectType,
      requestId: inboundRequests.id,
      sourceClass: inboundRequests.sourceClass,
      sourceType: inboundRequests.sourceType,
      contactId: inboundRequests.contactId,
      submittedEmail: inboundRequests.submittedEmail,
    })
    .from(inboundRequestEffects)
    .innerJoin(inboundRequests, eq(inboundRequests.id, inboundRequestEffects.requestId))
    .where(eq(inboundRequestEffects.id, effectId))
    .limit(1);
  if (!row || row.effectType !== "transactional_ack") return null;

  // The recipient is the mailbox captured with the occurrence, never the current CRM value. If the CRM address has
  // since changed, the receipt is not sent at all (it would disclose request details to an unsubmitted address).
  const email = row.submittedEmail?.trim().toLowerCase() || null;
  const contactless = isContactless(row.sourceClass);
  let firstName: string | null = null;
  let currentEmail: string | null = null;
  if (row.contactId && !contactless) {
    const [c] = await db.select({ email: contacts.email, firstName: contacts.firstName }).from(contacts).where(eq(contacts.id, row.contactId)).limit(1);
    currentEmail = c?.email?.trim().toLowerCase() || null;
    firstName = c?.firstName ?? null;
  }
  const templateKey = `ack.${row.sourceClass}`;
  const unusable = contactless
    ? (row.contactId ? "unexpected_contact_on_contactless_request" : !email ? "no_submitted_email_on_request" : null)
    : !row.contactId ? "no_recipient_on_request"
      : !email ? "no_submitted_email_on_request"
      : currentEmail !== email ? "recipient_changed_since_submission"
      : null;
  if (unusable || !email) {
    const [created] = await db.insert(inboundAcknowledgements).values({
      effectId, requestId: row.requestId, sourceClass: row.sourceClass, templateKey,
      presentationVersion: ACK_PRESENTATION_VERSION, state: "blocked", blockedReason: unusable ?? "no_recipient_on_request",
    }).onConflictDoNothing().returning();
    return created ?? (await db.select().from(inboundAcknowledgements).where(eq(inboundAcknowledgements.effectId, effectId)).limit(1))[0] ?? null;
  }
  const content = await buildAckContent({ sourceClass: row.sourceClass, sourceType: row.sourceType, requestId: row.requestId, firstName });
  const [created] = await db.insert(inboundAcknowledgements).values({
    effectId, requestId: row.requestId, sourceClass: row.sourceClass,
    recipientEmail: email, recipientContactId: contactless ? null : row.contactId,
    templateKey: content.templateKey, presentationVersion: ACK_PRESENTATION_VERSION,
    subject: content.subject, htmlBody: content.html, textBody: content.text,
    contentHash: ackContentHash({ to: email, subject: content.subject, html: content.html, text: content.text }),
    state: "prepared",
  }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(inboundAcknowledgements).where(eq(inboundAcknowledgements.effectId, effectId)).limit(1))[0] ?? null;
}

// ── Transport-boundary verification (called by the pause authority) ───────

export interface AckTransportMessage {
  to: string; subject: string; html: string; text?: string;
  category?: string; contactId?: number; commercialPurpose?: string;
  inboundRequestId?: string; intendedRecipientContactId?: number;
}

/**
 * Re-derives every binding from durable state. A caller-supplied flag proves nothing: the exact message must
 * match the prepared row, the row must be mid-attempt under this token, and the capability must still allow it.
 */
export async function verifyAckTransportCapability(
  message: AckTransportMessage,
  claim: { effectId: string; attemptToken: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const deny = (error: string) => ({ ok: false as const, error });
  if (message.commercialPurpose !== "transactional_response") return deny("ACK_PURPOSE_MISMATCH");
  if (message.category !== "support") return deny("ACK_CATEGORY_MISMATCH");
  const [row] = await db
    .select({
      ack: inboundAcknowledgements,
      effectState: inboundRequestEffects.state,
      effectType: inboundRequestEffects.effectType,
      requestId: inboundRequests.id,
      requestContactId: inboundRequests.contactId,
      submittedEmail: inboundRequests.submittedEmail,
      sourceClass: inboundRequests.sourceClass,
      sourceReceivedAt: inboundRequests.sourceReceivedAt,
    })
    .from(inboundAcknowledgements)
    .innerJoin(inboundRequestEffects, eq(inboundRequestEffects.id, inboundAcknowledgements.effectId))
    .innerJoin(inboundRequests, eq(inboundRequests.id, inboundAcknowledgements.requestId))
    .where(eq(inboundAcknowledgements.effectId, claim.effectId))
    .limit(1);
  if (!row) return deny("ACK_NOT_PREPARED");
  const { ack } = row;
  const contactless = isContactless(row.sourceClass);
  // A contact-bound class must carry its contact binding; a contactless class must carry none (so a privacy receipt
  // can never be re-aimed at a CRM contact, and a sales receipt can never be sent unbound).
  if (contactless) {
    if (message.contactId != null || message.intendedRecipientContactId != null) return deny("ACK_CONTACT_NOT_ALLOWED");
    if (row.requestContactId != null || ack.recipientContactId != null) return deny("ACK_CONTACT_MISMATCH");
  } else if (!message.contactId || message.intendedRecipientContactId !== message.contactId) {
    return deny("ACK_RECIPIENT_UNBOUND");
  }
  if (row.effectType !== "transactional_ack" || row.effectState !== "attempting") return deny("ACK_EFFECT_NOT_ATTEMPTING");
  if (ack.state !== "attempting" || !ack.attemptToken || ack.attemptToken !== claim.attemptToken) return deny("ACK_CLAIM_MISMATCH");
  if (message.inboundRequestId !== row.requestId) return deny("ACK_REQUEST_MISMATCH");
  if (!ack.recipientEmail || ack.recipientEmail !== message.to.trim().toLowerCase()) return deny("ACK_RECIPIENT_MISMATCH");
  // Authority is the mailbox captured with the occurrence; the contact (when the class has one) must still hold it.
  if (!row.submittedEmail || row.submittedEmail !== ack.recipientEmail) return deny("ACK_RECIPIENT_NOT_SUBMITTED");
  if (!contactless) {
    if (row.requestContactId !== message.contactId || ack.recipientContactId !== message.contactId) return deny("ACK_CONTACT_MISMATCH");
    const [liveContact] = await db.select({ email: contacts.email }).from(contacts).where(eq(contacts.id, message.contactId!)).limit(1);
    if (liveContact?.email?.trim().toLowerCase() !== row.submittedEmail) return deny("ACK_RECIPIENT_CHANGED");
  }
  if (!ack.contentHash || ack.contentHash !== ackContentHash(message)) return deny("ACK_CONTENT_MISMATCH");
  const cap = await getAckCapability();
  const verdict = ackCapabilityAllows(cap, {
    sourceClass: row.sourceClass,
    sourceReceivedAt: row.sourceReceivedAt,
    ownerStartedAt: await getOwnerStartedAt(),
  });
  if (!verdict.ok) return deny(`ACK_${verdict.reason.toUpperCase()}`);
  return { ok: true };
}

// ── Dispatch / settle ─────────────────────────────────────────────────────

export type AckDispatchOutcome =
  | { state: "blocked"; reason: string }
  | { state: "accepted"; messageId?: string }
  | { state: "uncertain" }
  | { state: "failed"; reason: string }
  | { state: "suppressed"; reason: string }
  | { state: "skipped"; reason: string };

type SendFn = (params: Record<string, unknown>) => Promise<{ success: boolean; messageId?: string; error?: string; outcome?: string }>;

const SUPPRESSION_REASONS = /(suppress|unsubscribe|do_not|dnc|opt_out|blocked_contact)/i;

function safeReason(error: string | undefined): string {
  const e = (error ?? "unknown").toLowerCase();
  if (e.includes("outbound paused") || e.includes("paused")) return "outbound_paused";
  if (/^[a-z0-9_:]{3,64}$/i.test(error ?? "")) return (error as string).toLowerCase();
  if (e.includes("smtp not configured")) return "smtp_not_configured";
  return "transport_refused";
}

export async function dispatchAcknowledgement(effectId: string, deps?: { send?: SendFn; now?: Date }): Promise<AckDispatchOutcome> {
  const ack = await prepareAcknowledgement(effectId);
  if (!ack) return { state: "skipped", reason: "not_an_acknowledgement_effect" };
  if (["accepted", "uncertain", "failed", "suppressed", "attempting"].includes(ack.state)) {
    return ack.state === "accepted" ? { state: "accepted", messageId: ack.transportMessageId ?? undefined }
      : ack.state === "uncertain" ? { state: "uncertain" }
      : ack.state === "attempting" ? { state: "skipped", reason: "attempt_in_progress" }
      : { state: ack.state as "failed" | "suppressed", reason: ack.blockedReason ?? ack.state };
  }

  const [req] = await db
    .select({ sourceClass: inboundRequests.sourceClass, sourceReceivedAt: inboundRequests.sourceReceivedAt })
    .from(inboundRequests).where(eq(inboundRequests.id, ack.requestId)).limit(1);
  const block = async (reason: string): Promise<AckDispatchOutcome> => {
    {
      await db.update(inboundAcknowledgements)
        .set({ state: "blocked", blockedReason: reason, updatedAt: new Date() })
        .where(and(eq(inboundAcknowledgements.id, ack.id), inArray(inboundAcknowledgements.state, ["prepared", "blocked"])));
    }
    return { state: "blocked", reason };
  };
  if (!req) return block("request_missing");
  const contactless = isContactless(req.sourceClass);
  if (!ack.recipientEmail || (!contactless && !ack.recipientContactId)) return block(ack.blockedReason ?? "no_recipient_on_request");

  let cap: AckCapability;
  try { cap = await readAckCapability(); } catch { return block("capability_unreadable"); }
  const verdict = ackCapabilityAllows(cap, {
    sourceClass: req.sourceClass, sourceReceivedAt: req.sourceReceivedAt,
    ownerStartedAt: await getOwnerStartedAt(), now: deps?.now,
  });
  if (!verdict.ok) return block(verdict.reason);

  // Pause state must be readable and not mid-activation before a claim is spent. A paused state is expected here: the
  // transport grants a per-message lease (authorizeInboundAckSend) and re-checks the pause epoch before provider I/O.
  const { describeSeedLeaseEligibility } = await import("./outbound-pause-authority");
  const pauseEligibility = await describeSeedLeaseEligibility();
  if (!(pauseEligibility.eligible === true)) return block(pauseEligibility.reasonCode === "activating" ? "outbound_activating" : "outbound_pause_state_unreadable");

  // Claim: effect held/ready -> attempting, then ack -> attempting under a fresh token. One winner only.
  const token = crypto.randomUUID();
  const claimedEffect = await db.update(inboundRequestEffects)
    .set({ state: "attempting", attemptCount: sql`${inboundRequestEffects.attemptCount} + 1`, updatedAt: new Date() })
    .where(and(eq(inboundRequestEffects.id, effectId), inArray(inboundRequestEffects.state, ["held", "ready"])))
    .returning({ id: inboundRequestEffects.id });
  if (claimedEffect.length !== 1) return { state: "skipped", reason: "effect_not_claimable" };
  const claimedAck = await db.update(inboundAcknowledgements)
    .set({ state: "attempting", attemptToken: token, attemptCount: sql`${inboundAcknowledgements.attemptCount} + 1`, attemptedAt: new Date(), blockedReason: null, updatedAt: new Date() })
    .where(and(eq(inboundAcknowledgements.id, ack.id), inArray(inboundAcknowledgements.state, ["prepared", "blocked"])))
    .returning({ id: inboundAcknowledgements.id });
  if (claimedAck.length !== 1) {
    await db.update(inboundRequestEffects).set({ state: "held", updatedAt: new Date() }).where(and(eq(inboundRequestEffects.id, effectId), eq(inboundRequestEffects.state, "attempting")));
    return { state: "skipped", reason: "ack_not_claimable" };
  }

  const send: SendFn = deps?.send ?? (async (p) => (await import("./smtp-email")).sendSmtpEmail(p as any));
  let result: Awaited<ReturnType<SendFn>>;
  try {
    result = await send({
      to: ack.recipientEmail,
      subject: ack.subject!, html: ack.htmlBody!, text: ack.textBody ?? undefined,
      category: "support",
      contactId: contactless ? undefined : ack.recipientContactId,
      commercialPurpose: "transactional_response",
      inboundRequestId: ack.requestId,
      intendedRecipientContactId: contactless ? undefined : ack.recipientContactId,
      inboundAck: { effectId, attemptToken: token },
    });
  } catch {
    // Exception after the attempt began: the transport may or may not have transmitted. Never auto-retry.
    result = { success: false, outcome: "uncertain", error: "send_threw" };
  }

  if (result.success) {
    await db.update(inboundAcknowledgements)
      .set({ state: "accepted", transportMessageId: result.messageId ?? null, settledAt: new Date(), updatedAt: new Date() })
      .where(eq(inboundAcknowledgements.id, ack.id));
    await db.update(inboundRequestEffects)
      .set({ state: "sent", providerReceipt: result.messageId ?? null, terminalReason: null, updatedAt: new Date() })
      .where(eq(inboundRequestEffects.id, effectId));
    return { state: "accepted", messageId: result.messageId };
  }
  if (result.outcome === "uncertain") {
    await db.update(inboundAcknowledgements)
      .set({ state: "uncertain", blockedReason: "delivery_uncertain", settledAt: new Date(), updatedAt: new Date() })
      .where(eq(inboundAcknowledgements.id, ack.id));
    await db.update(inboundRequestEffects)
      .set({ terminalReason: "delivery_uncertain", updatedAt: new Date() })
      .where(eq(inboundRequestEffects.id, effectId));
    return { state: "uncertain" };
  }

  const reason = safeReason(result.error);
  if (SUPPRESSION_REASONS.test(reason)) {
    await db.update(inboundAcknowledgements)
      .set({ state: "suppressed", blockedReason: reason, settledAt: new Date(), updatedAt: new Date() })
      .where(eq(inboundAcknowledgements.id, ack.id));
    await db.update(inboundRequestEffects)
      .set({ state: "suppressed", terminalReason: reason, updatedAt: new Date() })
      .where(eq(inboundRequestEffects.id, effectId));
    return { state: "suppressed", reason };
  }
  // A pause or other pre-send refusal is a wait, not a consumed attempt.
  const waited = reason === "outbound_paused";
  const attempts = ack.attemptCount + (waited ? 0 : 1);
  const exhausted = !waited && attempts >= ACK_MAX_SEND_ATTEMPTS;
  await db.update(inboundAcknowledgements)
    .set({
      state: exhausted ? "failed" : "blocked", blockedReason: reason,
      attemptCount: attempts, attemptToken: null, settledAt: exhausted ? new Date() : null, updatedAt: new Date(),
    })
    .where(eq(inboundAcknowledgements.id, ack.id));
  await db.update(inboundRequestEffects)
    .set({ state: exhausted ? "failed" : "held", terminalReason: exhausted ? reason : null, updatedAt: new Date() })
    .where(eq(inboundRequestEffects.id, effectId));
  return exhausted ? { state: "failed", reason } : { state: "blocked", reason };
}

/**
 * What a public response may truthfully say about the receipt at the moment of the request. `queued` means the
 * capability currently permits this request, so the receipt worker will attempt it; it is not delivery. `not_enabled`
 * means no receipt email will be sent for it. Unreadable capability is reported as not enabled.
 */
export async function describeAckReceiptState(requestId: string): Promise<"queued" | "not_enabled"> {
  const [req] = await db.select({ sourceClass: inboundRequests.sourceClass, sourceReceivedAt: inboundRequests.sourceReceivedAt })
    .from(inboundRequests).where(eq(inboundRequests.id, requestId)).limit(1);
  if (!req) return "not_enabled";
  try {
    const verdict = ackCapabilityAllows(await readAckCapability(), {
      sourceClass: req.sourceClass, sourceReceivedAt: req.sourceReceivedAt, ownerStartedAt: await getOwnerStartedAt(),
    });
    return verdict.ok ? "queued" : "not_enabled";
  } catch {
    return "not_enabled";
  }
}

// ── Crash recovery ────────────────────────────────────────────────────────

/** Longer than any SMTP attempt; an attempt older than this has no live owner. */
export const ACK_STALE_ATTEMPT_MS = 10 * 60_000;

/**
 * A process that dies mid-attempt leaves rows `attempting` forever. Two shapes, both resolved without resending:
 *  - ack `attempting` (the transport may or may not have transmitted): becomes `uncertain / attempt_interrupted`;
 *    the effect keeps `attempting` with `delivery_uncertain`, exactly like any other uncertain outcome.
 *  - effect `attempting` while its ack never reached `attempting` (crash between the two claims, so nothing was
 *    sent): the effect returns to `held` and the normal sweep decides again.
 * A late settle from a slow original attempt may still overwrite `uncertain` with the true outcome.
 */
export async function recoverStaleAcknowledgementAttempts(now: Date = new Date()): Promise<{ uncertain: number; released: number }> {
  const cutoff = new Date(now.getTime() - ACK_STALE_ATTEMPT_MS);
  const interrupted = await db.update(inboundAcknowledgements)
    .set({ state: "uncertain", blockedReason: "attempt_interrupted", settledAt: now, updatedAt: now })
    .where(and(
      eq(inboundAcknowledgements.state, "attempting"),
      sql`COALESCE(${inboundAcknowledgements.attemptedAt}, ${inboundAcknowledgements.updatedAt}) < ${cutoff}`,
    ))
    .returning({ id: inboundAcknowledgements.id, effectId: inboundAcknowledgements.effectId, requestId: inboundAcknowledgements.requestId });
  for (const row of interrupted) {
    await db.update(inboundRequestEffects)
      .set({ terminalReason: "delivery_uncertain", updatedAt: now })
      .where(and(eq(inboundRequestEffects.id, row.effectId), eq(inboundRequestEffects.state, "attempting")));
    await storage.createAuditLog({
      action: "inbound_ack_attempt_interrupted",
      entityType: "inbound_acknowledgement",
      entityId: 0,
      details: { acknowledgementId: row.id, effectId: row.effectId, requestId: row.requestId, resolvedAs: "uncertain", resent: false },
    } as any);
  }
  const released = await db.update(inboundRequestEffects)
    .set({ state: "held", updatedAt: now })
    .where(and(
      eq(inboundRequestEffects.effectType, "transactional_ack"),
      eq(inboundRequestEffects.state, "attempting"),
      sql`${inboundRequestEffects.updatedAt} < ${cutoff}`,
      sql`NOT EXISTS (SELECT 1 FROM inbound_acknowledgements a WHERE a.effect_id = ${inboundRequestEffects.id}
            AND a.state NOT IN ('prepared','blocked'))`,
    ))
    .returning({ id: inboundRequestEffects.id });
  return { uncertain: interrupted.length, released: released.length };
}

// ── Sweep (the single ongoing processor; no browser or operator action needed) ──

export async function runAcknowledgementSweep(opts?: { limit?: number; deps?: { send?: SendFn; now?: Date } }): Promise<{
  examined: number; accepted: number; blocked: number; uncertain: number; failed: number; suppressed: number; skipped: number;
  recoveredUncertain: number; releasedEffects: number;
}> {
  const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);
  const recovered = await recoverStaleAcknowledgementAttempts(opts?.deps?.now);
  const ownerStartedAt = await getOwnerStartedAt();
  const rows = await db
    .select({ effectId: inboundRequestEffects.id })
    .from(inboundRequestEffects)
    .innerJoin(inboundRequests, eq(inboundRequests.id, inboundRequestEffects.requestId))
    .leftJoin(inboundAcknowledgements, eq(inboundAcknowledgements.effectId, inboundRequestEffects.id))
    .where(and(
      eq(inboundRequestEffects.effectType, "transactional_ack"),
      inArray(inboundRequestEffects.state, ["held", "ready"]),
      // Historical requests (before this owner started) are never prepared or sent; they keep an explicit disposition.
      gte(inboundRequests.sourceReceivedAt, ownerStartedAt),
      // Terminal blocks are never revisited; transient waits (pause, unreadable state, retryable failures) are
      // rotated by least-recently-touched so no backlog can pin the head of the queue.
      sql`(${inboundAcknowledgements.id} IS NULL OR ${inboundAcknowledgements.state} = 'prepared'
        OR (${inboundAcknowledgements.state} = 'blocked'
            AND COALESCE(${inboundAcknowledgements.blockedReason}, '') NOT IN (${sql.join(ACK_TERMINAL_BLOCK_REASONS.map((r) => sql`${r}`), sql`, `)})))`,
    ))
    .orderBy(sql`COALESCE(${inboundAcknowledgements.updatedAt}, ${inboundRequests.sourceReceivedAt})`)
    .limit(limit);
  const tally = {
    examined: rows.length, accepted: 0, blocked: 0, uncertain: 0, failed: 0, suppressed: 0, skipped: 0,
    recoveredUncertain: recovered.uncertain, releasedEffects: recovered.released,
  };
  for (const r of rows) {
    const out = await dispatchAcknowledgement(r.effectId, opts?.deps);
    tally[out.state] += 1;
  }
  return tally;
}

let workerStarted = false;
let workerRunning = false;
const WORKER_INTERVAL_MS = 30_000;

export function startInboundAcknowledgementWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try { await runAcknowledgementSweep(); }
    catch (err) { process.stderr.write(`[InboundAck] sweep error (${err instanceof Error ? err.name : "NonError"})\n`); }
    finally { workerRunning = false; }
  };
  const timer = setInterval(() => { void tick(); }, WORKER_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  const initial = setTimeout(() => void tick(), 5000);
  if (typeof initial.unref === "function") initial.unref();
}

/** Counts for the admin status view; every number is a distinct state, none implies inbox delivery. */
export async function getAcknowledgementStatusCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: inboundAcknowledgements.state, n: sql<number>`count(*)::int` })
    .from(inboundAcknowledgements)
    .groupBy(inboundAcknowledgements.state);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = Number(r.n);
  return out;
}
