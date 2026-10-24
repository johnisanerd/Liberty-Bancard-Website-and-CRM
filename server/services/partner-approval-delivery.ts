/**
 * Durable approval/welcome work for partners and affiliates.
 *
 * The intent is a row written in the same transaction as the approval (or affiliate account creation), so no crash can
 * lose it and no request has to stay alive to finish it. A sweep executes it with these rules:
 *  - a missing prerequisite (outbound pause, provider contact not yet known, provider not configured) is a wait: no
 *    attempt is consumed and the row is never marked sent or skipped;
 *  - an invite whose delivery outcome is unknown is `ambiguous` and is never re-sent automatically (an operator
 *    resends, which issues a fresh single-use link);
 *  - a crash between claim and outcome is reclaimed: before dispatch it is retried, after dispatch it is `ambiguous`;
 *  - nothing here uses promotional sequences.
 * Provider completion stays with the GHL companion work: this service only hands off and records what is known.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { partnerApprovalDeliveries, partners, type Partner, type PartnerApprovalDelivery, type InsertPartner } from "@shared/schema";
import { storage } from "../storage";
import { issueAuthAction, setAuthActionDelivery } from "./auth-actions";
import { getEmailSignatureHtml } from "./email-signatures";
import { logOperationalDiagnostic } from "../utils/server-error";

export type PartnerDeliveryKind = "invite" | "welcome" | "affiliate_welcome";
export const PARTNER_DELIVERY_MAX_ATTEMPTS = 4;
export const PARTNER_DELIVERY_WAIT_RECHECK_MS = 5 * 60_000;
export const PARTNER_DELIVERY_STALE_MS = 10 * 60_000;
const BASE_BACKOFF_MS = 60_000;
const HEARTBEAT_KEY = "partner_approval_delivery_heartbeat";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Inserts the intent for the next generation of this partner, superseding unfinished earlier work. */
async function enqueueDelivery(tx: Tx, partnerId: number, kind: PartnerDeliveryKind): Promise<PartnerApprovalDelivery> {
  const [last] = await tx.select({ g: partnerApprovalDeliveries.generation }).from(partnerApprovalDeliveries)
    .where(eq(partnerApprovalDeliveries.partnerId, partnerId)).orderBy(desc(partnerApprovalDeliveries.generation)).limit(1);
  await tx.update(partnerApprovalDeliveries).set({ state: "superseded", terminalReason: "SUPERSEDED_BY_NEWER_APPROVAL", updatedAt: new Date() })
    .where(and(eq(partnerApprovalDeliveries.partnerId, partnerId), inArray(partnerApprovalDeliveries.state, ["pending", "waiting"])));
  const [row] = await tx.insert(partnerApprovalDeliveries).values({ partnerId, generation: (last?.g ?? 0) + 1, kind }).returning();
  return row;
}

/** Affiliate signup: called inside the account transaction so the welcome intent commits with the account. */
export async function enqueueAffiliateWelcome(tx: Tx, partnerId: number) {
  return enqueueDelivery(tx, partnerId, "affiliate_welcome");
}

/**
 * Applies an operator update to a partner. When the update activates a non-active partner, the invite/welcome intent
 * commits in the same transaction as the status change.
 */
export async function updatePartnerWithApproval(partnerId: number, updates: Partial<InsertPartner>): Promise<{
  before: Partner; updated: Partner; approved: boolean; delivery: PartnerApprovalDelivery | null;
} | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(partners).where(eq(partners.id, partnerId)).for("update");
    if (!before) return null;
    const [updated] = await tx.update(partners).set({ ...updates, updatedAt: new Date() }).where(eq(partners.id, partnerId)).returning();
    const approved = updates.status === "active" && before.status !== "active";
    let delivery: PartnerApprovalDelivery | null = null;
    if (approved) {
      const kind: PartnerDeliveryKind = before.partnerType === "affiliate" ? "affiliate_welcome" : before.passwordHash ? "welcome" : "invite";
      delivery = await enqueueDelivery(tx, partnerId, kind);
    }
    return { before, updated, approved, delivery };
  });
}

// ── Delivery transports (injectable for certification) ──────────────────────
export type InviteOutcome = "sent" | "unsent" | "paused" | "ambiguous";
export interface DeliveryDeps {
  now?: Date;
  pauseAllows?: () => Promise<boolean>;
  sendInvite?: (partner: Partner, token: string) => Promise<InviteOutcome>;
  sendWelcome?: (partner: Partner) => Promise<"sent" | "not_configured" | "no_provider_contact">;
  enrollAffiliateWelcome?: (input: { ghlContactId: string; contactId: number; partner: Partner }) => Promise<{ success: boolean; skipped?: boolean; error?: string }>;
}

function baseUrl(): string {
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return process.env.APP_URL || (replitDomain ? `https://${replitDomain}` : "https://libertybancard.com");
}

async function defaultPauseAllows(): Promise<boolean> {
  const { authorize } = await import("./outbound-pause-authority");
  return (await authorize({})).allowed;
}

async function defaultSendInvite(partner: Partner, token: string): Promise<InviteOutcome> {
  const inviteUrl = `${baseUrl()}/partner-login#action=invite&token=${encodeURIComponent(token)}`;
  const firstName = (partner.contactName || "").split(" ")[0] || "there";
  const safeUrl = escapeHtml(inviteUrl);
  const html = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;">
   <p>Hi ${escapeHtml(firstName)},</p>
  <p>Congratulations — your Liberty Bancard partner application has been <strong>approved</strong>!</p>
  <p>To activate your partner account, please set your password by clicking the button below:</p>
   <p><a href="${safeUrl}" style="display:inline-block;background-color:#1e3a5f;color:#ffffff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:bold;">Set Your Password &amp; Access Your Portal &rarr;</a></p>
   <p>Or copy and paste this link:<br/><span style="font-family:monospace;font-size:12px;color:#555;">${safeUrl}</span></p>
  <p>This link expires in 72 hours. Once you set your password, you'll have full access to your partner dashboard with referral tracking, commission reports, and marketing materials.</p>
  <p>Questions? Reply to this email, call us at <a href="tel:9542668214" style="color:#1e3a5f;">954-266-8214</a>, or email <a href="mailto:scott@libertybancard.com" style="color:#1e3a5f;">scott@libertybancard.com</a>.</p>
  <p>Welcome aboard!</p>
${getEmailSignatureHtml("partners")}
</div>`;
  const subject = "You're approved — set your partner portal password";
  const { sendSmtpEmail } = await import("./smtp-email");
  const smtp = await sendSmtpEmail({ to: partner.email!, subject, html, category: "internal_ops" });
  if (smtp.success) return "sent";
  if (/paused/i.test(smtp.error ?? "")) return "paused";
  if (smtp.outcome && smtp.outcome !== "unsent") return "ambiguous";
  const { isGhlConfigured, sendGhlPartnerTransactionalEmail } = await import("./ghl");
  if (!isGhlConfigured()) return "unsent";
  try {
    const ghl = await sendGhlPartnerTransactionalEmail({ email: partner.email!, subject, body: html, fromEmail: "partners@libertybancard.com", fromName: "Liberty Bancard Partner Program" });
    return ghl.success ? "sent" : "unsent";
  } catch {
    return "ambiguous";
  }
}

async function defaultSendWelcome(partner: Partner) {
  const { deliverPartnerWelcome } = await import("./partner-welcome");
  return deliverPartnerWelcome(partner);
}

async function defaultEnrollAffiliateWelcome(input: { ghlContactId: string; contactId: number; partner: Partner }) {
  const { enrollInGhlWorkflowCompliant } = await import("./ghl-workflows");
  return enrollInGhlWorkflowCompliant({
    workflowKey: "affiliate_welcome", ghlContactId: input.ghlContactId, contactId: input.contactId,
    metadata: { affiliateCode: input.partner.affiliateCode, partnerId: input.partner.id },
  });
}

// ── Execution ───────────────────────────────────────────────────────────────
const backoffMs = (attempts: number) => Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), 30 * 60_000);

async function claimOne(now: Date): Promise<PartnerApprovalDelivery | null> {
  const res: any = await db.execute(sql`
    UPDATE partner_approval_deliveries
    SET state = 'attempting', locked_at = ${now}, attempts = attempts + 1, updated_at = ${now}
    WHERE id = (
      SELECT id FROM partner_approval_deliveries
      WHERE state IN ('pending', 'waiting') AND next_attempt_at <= ${now}
      ORDER BY next_attempt_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id`);
  const id = (res.rows ?? res)[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(partnerApprovalDeliveries).where(eq(partnerApprovalDeliveries.id, id));
  return row ?? null;
}

/** A crash between claim and outcome: retry if nothing was dispatched, otherwise the outcome is unknown. */
export async function reclaimStalePartnerDeliveries(now: Date): Promise<{ retried: number; ambiguous: number }> {
  const cutoff = new Date(now.getTime() - PARTNER_DELIVERY_STALE_MS);
  const stale = await db.select().from(partnerApprovalDeliveries)
    .where(and(eq(partnerApprovalDeliveries.state, "attempting"), lt(partnerApprovalDeliveries.lockedAt, cutoff)));
  let retried = 0, ambiguous = 0;
  for (const row of stale) {
    if (row.dispatchStartedAt) {
      await db.update(partnerApprovalDeliveries).set({ state: "ambiguous", terminalReason: "DISPATCH_OUTCOME_UNKNOWN", lockedAt: null, updatedAt: now })
        .where(and(eq(partnerApprovalDeliveries.id, row.id), eq(partnerApprovalDeliveries.state, "attempting")));
      if (row.authActionId) await setAuthActionDelivery(row.authActionId, "ambiguous").catch(() => undefined);
      ambiguous++;
    } else {
      await db.update(partnerApprovalDeliveries).set({ state: "pending", lockedAt: null, attempts: Math.max(0, row.attempts - 1), nextAttemptAt: now, updatedAt: now })
        .where(and(eq(partnerApprovalDeliveries.id, row.id), eq(partnerApprovalDeliveries.state, "attempting")));
      retried++;
    }
  }
  return { retried, ambiguous };
}

const setState = (id: string, patch: Partial<typeof partnerApprovalDeliveries.$inferInsert>) =>
  db.update(partnerApprovalDeliveries).set({ ...patch, lockedAt: null, updatedAt: new Date() }).where(eq(partnerApprovalDeliveries.id, id));

async function waitFor(row: PartnerApprovalDelivery, reason: string, now: Date) {
  // A wait is not an attempt: give the claimed attempt back and look again later.
  await setState(row.id, { state: "waiting", waitReason: reason, attempts: Math.max(0, row.attempts - 1), nextAttemptAt: new Date(now.getTime() + PARTNER_DELIVERY_WAIT_RECHECK_MS), terminalReason: null });
}

async function retryOrFail(row: PartnerApprovalDelivery, reason: string, now: Date) {
  if (row.attempts >= PARTNER_DELIVERY_MAX_ATTEMPTS) await setState(row.id, { state: "failed", terminalReason: reason, waitReason: null });
  else await setState(row.id, { state: "pending", terminalReason: reason, waitReason: null, nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts)) });
}

const markDispatch = (id: string) => db.update(partnerApprovalDeliveries).set({ dispatchStartedAt: new Date() }).where(eq(partnerApprovalDeliveries.id, id));

async function execute(row: PartnerApprovalDelivery, deps: DeliveryDeps, now: Date): Promise<string> {
  const [partner] = await db.select().from(partners).where(eq(partners.id, row.partnerId));
  if (!partner) { await setState(row.id, { state: "superseded", terminalReason: "PARTNER_MISSING" }); return "superseded"; }
  if (partner.status !== "active") { await setState(row.id, { state: "superseded", terminalReason: "PARTNER_NO_LONGER_ACTIVE" }); return "superseded"; }
  if (!partner.email) { await setState(row.id, { state: "no_recipient", terminalReason: "NO_EMAIL_ON_FILE" }); return "no_recipient"; }
  if (row.kind === "invite" && partner.passwordHash) { await setState(row.id, { state: "superseded", terminalReason: "CREDENTIAL_ALREADY_SET" }); return "superseded"; }

  if (!await (deps.pauseAllows ?? defaultPauseAllows)()) { await waitFor(row, "outbound_paused", now); return "waiting"; }

  if (row.kind === "invite") {
    const action = await issueAuthAction({ purpose: "partner_invite", subject: { type: "partner", id: partner.id }, ttlMs: 72 * 60 * 60 * 1000 });
    await db.update(partnerApprovalDeliveries).set({ authActionId: action.id }).where(eq(partnerApprovalDeliveries.id, row.id));
    await markDispatch(row.id);
    let outcome: InviteOutcome;
    try { outcome = await (deps.sendInvite ?? defaultSendInvite)(partner, action.token); } catch { outcome = "ambiguous"; }
    if (outcome === "sent") { await setAuthActionDelivery(action.id, "sent"); await setState(row.id, { state: "sent", terminalReason: null, waitReason: null }); return "sent"; }
    if (outcome === "ambiguous") { await setAuthActionDelivery(action.id, "ambiguous"); await setState(row.id, { state: "ambiguous", terminalReason: "DISPATCH_OUTCOME_UNKNOWN", waitReason: null }); return "ambiguous"; }
    await setAuthActionDelivery(action.id, "definite_failure"); // nothing was handed to a provider: the link is revoked
    await db.update(partnerApprovalDeliveries).set({ dispatchStartedAt: null }).where(eq(partnerApprovalDeliveries.id, row.id));
    if (outcome === "paused") { await waitFor(row, "outbound_paused", now); return "waiting"; }
    await retryOrFail(row, "INVITE_NOT_SENT", now);
    return "retry";
  }

  if (row.kind === "welcome") {
    await markDispatch(row.id);
    try {
      const result = await (deps.sendWelcome ?? defaultSendWelcome)(partner);
      if (result === "sent") { await setState(row.id, { state: "sent", terminalReason: null, waitReason: null }); return "sent"; }
      await db.update(partnerApprovalDeliveries).set({ dispatchStartedAt: null }).where(eq(partnerApprovalDeliveries.id, row.id));
      await waitFor(row, result === "not_configured" ? "provider_not_configured" : "ghl_contact_pending", now);
      return "waiting";
    } catch (err) {
      // A welcome carries no secret, so a retry after a surfaced failure is safe (worst case a duplicate greeting).
      logOperationalDiagnostic("partner_approval_delivery", err, "welcome_failed", { partnerId: partner.id });
      await db.update(partnerApprovalDeliveries).set({ dispatchStartedAt: null }).where(eq(partnerApprovalDeliveries.id, row.id));
      await retryOrFail(row, "WELCOME_FAILED", now);
      return "retry";
    }
  }

  // affiliate_welcome: needs the provider contact id of the affiliate's local contact.
  const contact = await storage.getContactByEmail(partner.email.trim().toLowerCase());
  if (!contact || !contact.ghlContactId) { await waitFor(row, "ghl_contact_pending", now); return "waiting"; }
  await markDispatch(row.id);
  try {
    const result = await (deps.enrollAffiliateWelcome ?? defaultEnrollAffiliateWelcome)({ ghlContactId: contact.ghlContactId, contactId: contact.id, partner });
    if (result.success) { await setState(row.id, { state: "sent", terminalReason: null, waitReason: null }); return "sent"; }
    await db.update(partnerApprovalDeliveries).set({ dispatchStartedAt: null }).where(eq(partnerApprovalDeliveries.id, row.id));
    if (result.skipped) { await waitFor(row, "enrollment_deferred", now); return "waiting"; }
    await retryOrFail(row, "ENROLLMENT_FAILED", now);
    return "retry";
  } catch (err) {
    logOperationalDiagnostic("partner_approval_delivery", err, "affiliate_welcome_failed", { partnerId: partner.id });
    await db.update(partnerApprovalDeliveries).set({ dispatchStartedAt: null }).where(eq(partnerApprovalDeliveries.id, row.id));
    await retryOrFail(row, "ENROLLMENT_FAILED", now);
    return "retry";
  }
}

export async function processPartnerApprovalDeliveries(opts: { limit?: number; deps?: DeliveryDeps } = {}): Promise<Record<string, number>> {
  const deps = opts.deps ?? {};
  const now = deps.now ?? new Date();
  const tally: Record<string, number> = {};
  const reclaimed = await reclaimStalePartnerDeliveries(now);
  if (reclaimed.ambiguous) tally.ambiguous = reclaimed.ambiguous;
  for (let i = 0; i < (opts.limit ?? 25); i++) {
    const row = await claimOne(now);
    if (!row) break;
    let outcome: string;
    try { outcome = await execute(row, deps, now); }
    catch (err) {
      logOperationalDiagnostic("partner_approval_delivery", err, "execution_failed", { partnerId: row.partnerId });
      await retryOrFail(row, "EXECUTION_ERROR", now);
      outcome = "retry";
    }
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  return tally;
}

/** Operator decision to send again after a failed or ambiguous delivery (issues a fresh link for an invite). */
export async function resendPartnerDelivery(partnerId: number, deliveryId: string, actorId: string): Promise<PartnerApprovalDelivery | null> {
  const [row] = await db.update(partnerApprovalDeliveries).set({
    state: "pending", attempts: 0, terminalReason: null, waitReason: null, dispatchStartedAt: null, nextAttemptAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(partnerApprovalDeliveries.id, deliveryId), eq(partnerApprovalDeliveries.partnerId, partnerId),
    inArray(partnerApprovalDeliveries.state, ["failed", "ambiguous"]))).returning();
  if (row) await storage.createAuditLog({ action: "partner_approval_delivery_resend", entityType: "partner", entityId: partnerId, details: { deliveryId, kind: row.kind, actorId } } as any).catch(() => undefined);
  return row ?? null;
}

export async function listPartnerDeliveries(partnerId: number) {
  const rows = await db.select().from(partnerApprovalDeliveries).where(eq(partnerApprovalDeliveries.partnerId, partnerId)).orderBy(desc(partnerApprovalDeliveries.generation));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, state: r.state, waitReason: r.waitReason, attempts: r.attempts, terminalReason: r.terminalReason,
    nextAttemptAt: r.nextAttemptAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }));
}

let started = false;
const INTERVAL_MS = 60_000;
export function startPartnerApprovalDeliveryWorker(): void {
  if (started) return;
  started = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const tally = await processPartnerApprovalDeliveries();
      await storage.setSystemSetting(HEARTBEAT_KEY, { at: new Date().toISOString(), outcome: "ok", tally, intervalMs: INTERVAL_MS });
    } catch (err) {
      await storage.setSystemSetting(HEARTBEAT_KEY, { at: new Date().toISOString(), outcome: "error", errorName: err instanceof Error ? err.name : "NonError", intervalMs: INTERVAL_MS }).catch(() => undefined);
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  const initial = setTimeout(() => void tick(), 20_000);
  if (typeof initial.unref === "function") initial.unref();
}
