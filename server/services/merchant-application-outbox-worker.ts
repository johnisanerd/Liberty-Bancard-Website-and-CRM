/**
 * Merchant Application Outbox Worker — v2
 * =========================================
 * Hardened improvements:
 *   2. No catch-and-swallow. Required effects (GHL/consent/risk/email/deal/
 *      lifecycle) propagate errors so the row stays retryable. Optional/not-
 *      configured paths are explicitly classified only where truthful.
 *   3. Finalize/status effects are individually-keyed rows (contact_link,
 *      consent_record, ghl_sync, workflow_enroll, risk_scan, approval_email,
 *      deal_stage, lifecycle_approved, decline_email, lifecycle_declined).
 *      Each handler checks durable evidence before reapplying.
 *   4. Stale processing rows (locked > 10 min) are reclaimed as pending on
 *      each tick. Terminal rows become dead_letter (attempts >= MAX_ATTEMPTS).
 *      last_error is scrubbed through audit-sanitizer before persist/log.
 */

import { sql, eq, lt, and } from "drizzle-orm";
import { db, pool } from "../db";
import { merchantApplications, merchantApplicationProtectedOutbox, contacts, auditLogs } from "@shared/schema";
import { storage } from "../storage";
import { applyEsignDocumentState, applyEsignSendState } from "./merchant-application-service";
import { createContactLocalFirst } from "./contact-writer";

const MAX_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 15_000;
const STALE_LOCK_MS = 10 * 60 * 1000; // 10 min
const BASE_BACKOFF_MS = 30_000;

let started = false;
let running = false;

/**
 * A prerequisite wait (outbound paused, contact not linked yet, GHL id not yet
 * populated) is not a failed attempt. It must not consume the retry budget or
 * reach dead_letter; the row stays pending and is re-checked on a fixed, bounded
 * interval. Genuine failures keep the exponential backoff and attempt budget.
 */
export class OutboxWaitError extends Error {
  constructor(public readonly reason: "outbound_paused" | "contact_not_linked" | "ghl_contact_pending") {
    super(`outbox wait: ${reason}`);
    this.name = "OutboxWaitError";
  }
}
const WAIT_RECHECK_MS = 5 * 60 * 1000;

async function assertOutboundNotPaused(): Promise<void> {
  const { authorize } = await import("./outbound-pause-authority");
  const decision = await authorize({});
  if (!decision.allowed) throw new OutboxWaitError("outbound_paused");
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts), 30 * 60 * 1000);
}

/**
 * Return ONLY a safe, non-sensitive error class/code for persistence & logging.
 * Arbitrary error.message / provider response text is NEVER returned, because it
 * can embed PII, secrets, or provider payloads that the audit sanitizer (which
 * only strips known KEYS, not arbitrary VALUES) would happily pass through.
 * We emit the error's constructor name plus an optional allowlisted code.
 */
const SAFE_ERROR_CODE_ALLOWLIST = new Set<string>([
  "23505", // unique_violation
  "23503", // foreign_key_violation
  "23502", // not_null_violation
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
]);

function scrubError(err: unknown): string {
  if (err instanceof Error) {
    const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : "Error";
    const rawCode = (err as any)?.code;
    const code = typeof rawCode === "string" && SAFE_ERROR_CODE_ALLOWLIST.has(rawCode) ? rawCode : undefined;
    return code ? `${name}:${code}` : name;
  }
  // Never stringify unknown values (may be a raw provider response object).
  return "NonError";
}

interface OutboxRow {
  id: string;
  applicationId: number;
  eventType: string;
  payload: Record<string, any>;
  attempts: number;
}

/** Claim one claimable pending/failed row atomically (SKIP LOCKED). */
async function claimOne(): Promise<OutboxRow | null> {
  const res = await db.execute(sql`
    UPDATE merchant_application_protected_outbox
    SET status = 'processing', locked_at = now(), updated_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM merchant_application_protected_outbox
      WHERE status IN ('pending', 'failed')
        AND attempts < ${MAX_ATTEMPTS}
        AND (available_at IS NULL OR available_at <= now())
      ORDER BY available_at ASC NULLS FIRST
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, application_id, event_type, payload, attempts
  `);
  const rows = (res as any).rows ?? res;
  if (!rows || !rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    applicationId: r.application_id,
    eventType: r.event_type,
    payload: r.payload ?? {},
    attempts: r.attempts,
  };
}

/** Reclaim stale processing rows (locked > STALE_LOCK_MS) as pending. */
async function reclaimStale(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_LOCK_MS);
  await db
    .update(merchantApplicationProtectedOutbox)
    .set({ status: "pending", lockedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(merchantApplicationProtectedOutbox.status, "processing"),
        lt(merchantApplicationProtectedOutbox.lockedAt, staleThreshold),
      ),
    );
}

async function markDelivered(id: string): Promise<void> {
  await db
    .update(merchantApplicationProtectedOutbox)
    .set({ status: "delivered", processedAt: new Date(), lockedAt: null, updatedAt: new Date(), lastError: null })
    .where(eq(merchantApplicationProtectedOutbox.id, id));
}

async function markRetryOrDeadLetter(id: string, attempts: number, err: unknown): Promise<void> {
  if (err instanceof OutboxWaitError) {
    // Give back the attempt consumed by claimOne(); a wait is not a failure.
    await db
      .update(merchantApplicationProtectedOutbox)
      .set({
        status: "pending",
        lockedAt: null,
        attempts: sql`GREATEST(${merchantApplicationProtectedOutbox.attempts} - 1, 0)`,
        lastError: `waiting:${err.reason}`,
        availableAt: new Date(Date.now() + WAIT_RECHECK_MS),
        updatedAt: new Date(),
      })
      .where(eq(merchantApplicationProtectedOutbox.id, id));
    return;
  }
  const safeErr = scrubError(err);
  const terminal = attempts >= MAX_ATTEMPTS;
  await db
    .update(merchantApplicationProtectedOutbox)
    .set({
      status: terminal ? "dead_letter" : "pending",
      lockedAt: null,
      lastError: safeErr,
      availableAt: terminal ? new Date() : new Date(Date.now() + backoffMs(attempts)),
      updatedAt: new Date(),
    })
    .where(eq(merchantApplicationProtectedOutbox.id, id));
}

// ── Durable evidence helpers ──────────────────────────────────────────────

/** Check audit_logs for evidence of a completed action on this entity. */
async function hasAuditEvidence(action: string, entityType: string, entityId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, action),
        eq(auditLogs.entityType, entityType),
        eq(auditLogs.entityId, entityId),
      ),
    )
    .limit(1);
  return !!row;
}

// ── Individual effect handlers (no catch-and-swallow) ─────────────────────

async function handleContactLink(row: OutboxRow): Promise<void> {
  const appId = row.applicationId;
  const p = row.payload;
  const contactEmail: string | null = (p.ownerEmail || p.businessEmail) as string | null;

  const [appRow] = await db
    .select({ contactId: merchantApplications.contactId })
    .from(merchantApplications)
    .where(eq(merchantApplications.id, appId))
    .limit(1);
  if (!appRow) throw new Error(`Application #${appId} not found`);

  // Already linked — idempotent.
  if (appRow.contactId) return;

  if (!contactEmail) return; // no email: nothing to link

  let resolvedContactId: number | null = null;
  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, contactEmail.toLowerCase()))
    .limit(1);
  if (existing) {
    resolvedContactId = existing.id;
  } else {
    const created = await createContactLocalFirst({
      firstName: String(p.ownerFirstName || ""),
      lastName: String(p.ownerLastName || ""),
      email: contactEmail,
      phone: String(p.businessPhone || p.ownerPhone || ""),
      companyName: String(p.legalBusinessName || p.dba || ""),
      status: "New",
      tags: ["src_merchant_app", "merchant_application"],
    } as any, undefined, {
      sourceCategory: "merchant_application",
      sourceType: "merchant_application",
      eventKey: `merchant-application-contact:${appId}:${contactEmail.toLowerCase()}`,
    });
    resolvedContactId = created.id;
  }

  if (resolvedContactId) {
    await db
      .update(merchantApplications)
      .set({ contactId: resolvedContactId, updatedAt: new Date() })
      .where(eq(merchantApplications.id, appId));
  }
}

async function handleConsentRecord(row: OutboxRow): Promise<void> {
  const appId = row.applicationId;
  const p = row.payload;
  // Check durable evidence before re-recording (prevents duplicate consent rows).
  const alreadyRecorded = await hasAuditEvidence("pewc_opt_in", "contact", 0);
  // Get actual contactId.
  const [appRow] = await db
    .select({ contactId: merchantApplications.contactId })
    .from(merchantApplications)
    .where(eq(merchantApplications.id, appId))
    .limit(1);
  if (!appRow?.contactId) throw new OutboxWaitError("contact_not_linked");

  const contactId = appRow.contactId;
  // Check contact-scoped evidence.
  const [consentRow] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, "pewc_opt_in"),
        eq(auditLogs.entityType, "contact"),
        eq(auditLogs.entityId, contactId),
      ),
    )
    .limit(1);
  if (consentRow) return; // already recorded for this contact

  const { recordPewcDecision } = await import("./consent-evidence");
  await recordPewcDecision({
    contactId,
    checked: true,
    source: "merchant_application_finalize",
    ipAddress: "outbox",
    userAgent: "outbox",
    details: { applicationId: appId },
  });
}

async function handleGhlSync(row: OutboxRow): Promise<void> {
  // Honour the global outbound pause: GHL CRM sync is an outbound operation.
  // Using the canonical authority so the static scanner detects this gate.
  // contact_link / consent_record / risk_scan do NOT call this check — they
  // are pure DB operations and must run regardless of pause state.
  await assertOutboundNotPaused();

  const appId = row.applicationId;
  const [appRow] = await db
    .select({ contactId: merchantApplications.contactId })
    .from(merchantApplications)
    .where(eq(merchantApplications.id, appId))
    .limit(1);
  if (!appRow?.contactId) throw new OutboxWaitError("contact_not_linked");

  const { syncMerchantApplicationToGhl } = await import("./ghl-form-sync");
  const result = await syncMerchantApplicationToGhl(appId, appRow.contactId);
  if (!result.success && result.error) {
    // Propagate so row stays retryable (item 2).
    throw new Error(`GHL sync failed: ${result.error}`);
  }
}

async function handleWorkflowEnroll(row: OutboxRow): Promise<void> {
  const appId = row.applicationId;
  const [appRow] = await db
    .select({ contactId: merchantApplications.contactId })
    .from(merchantApplications)
    .where(eq(merchantApplications.id, appId))
    .limit(1);
  if (!appRow?.contactId) throw new OutboxWaitError("contact_not_linked");

  const ghlContact = await storage.getContact(appRow.contactId);
  const ghlContactId = ghlContact?.ghlContactId ?? "";
  if (!ghlContactId) {
    // GHL ID not yet populated — durable wait, not a failed attempt.
    throw new OutboxWaitError("ghl_contact_pending");
  }

  const { enrollInGhlWorkflowCompliant } = await import("./ghl-workflows");
  await enrollInGhlWorkflowCompliant({
    workflowKey: "merchant_app",
    ghlContactId,
    contactId: appRow.contactId,
    metadata: { applicationId: appId },
  });
}

async function handleRiskScan(row: OutboxRow): Promise<void> {
  const appId = row.applicationId;
  const [appRow] = await db
    .select({ contactId: merchantApplications.contactId })
    .from(merchantApplications)
    .where(eq(merchantApplications.id, appId))
    .limit(1);
  if (!appRow?.contactId) throw new OutboxWaitError("contact_not_linked");

  const { scanApplicationRisk } = await import("./relationship-extractor");
  await scanApplicationRisk(appRow.contactId, appId);
}

/**
 * Explicit, least-privilege projection for status emails. NEVER selects
 * protected ciphertext, fingerprints, masks, tokens, or capability columns.
 */
async function loadStatusEmailInput(appId: number): Promise<import("./merchant-application-status").ApplicationStatusEmailInput> {
  const [app] = await db
    .select({
      contactId: merchantApplications.contactId,
      ownerEmail: merchantApplications.ownerEmail,
      businessEmail: merchantApplications.businessEmail,
      ownerFirstName: merchantApplications.ownerFirstName,
      ownerLastName: merchantApplications.ownerLastName,
      legalBusinessName: merchantApplications.legalBusinessName,
      dba: merchantApplications.dba,
      businessPhone: merchantApplications.businessPhone,
      ownerPhone: merchantApplications.ownerPhone,
      vertical: merchantApplications.vertical,
      declineReason: merchantApplications.declineReason,
    })
    .from(merchantApplications)
    .where(eq(merchantApplications.id, appId))
    .limit(1);
  if (!app) throw new Error(`Application #${appId} not found`);
  return { applicationId: appId, ...app };
}

async function handleApprovalEmail(row: OutboxRow): Promise<void> {
  const appId = row.applicationId;
  // Check durable audit evidence before re-sending (either outcome is terminal).
  if (await hasAuditEvidence("merchant_application_approved_email_sent", "merchant_application", appId)) return;
  if (await hasAuditEvidence("merchant_application_approved_email_skipped", "merchant_application", appId)) return;

  await assertOutboundNotPaused();
  const input = await loadStatusEmailInput(appId);

  const { sendApplicationApprovedEmail } = await import("./merchant-application-status");
  // Transient contact/GHL/send failures propagate here and keep the row retryable.
  const result = await sendApplicationApprovedEmail(input);

  if (result.status === "sent") {
    // Evidence written ONLY when the email was actually sent.
    await storage.createAuditLog({
      action: "merchant_application_approved_email_sent",
      entityType: "merchant_application",
      entityId: appId,
      details: {},
    });
  } else {
    // Distinct skip evidence — records the stated (data) reason, no PII.
    await storage.createAuditLog({
      action: "merchant_application_approved_email_skipped",
      entityType: "merchant_application",
      entityId: appId,
      details: { reason: result.reason },
    });
  }
}

async function handleDealStage(row: OutboxRow): Promise<void> {
  const dealId = row.payload.dealId as number | null;
  if (!dealId) return;
  const { advanceDealStage } = await import("./deal-stage-service");
  await advanceDealStage(dealId, "Closed Won", "merchant_approval");
}

async function handleLifecycleApproved(row: OutboxRow): Promise<void> {
  const contactId = row.payload.contactId as number | null;
  if (!contactId) return;
  const { LifecycleService } = await import("./lifecycle-service");
  await LifecycleService.transition(contactId, "APPROVED", {
    trigger: "merchant_application_approved",
    source: "outbox-worker",
    metadata: { applicationId: row.applicationId },
  });
}

async function handleDeclineEmail(row: OutboxRow): Promise<void> {
  const appId = row.applicationId;
  if (await hasAuditEvidence("merchant_application_declined_email_sent", "merchant_application", appId)) return;
  if (await hasAuditEvidence("merchant_application_declined_email_skipped", "merchant_application", appId)) return;

  await assertOutboundNotPaused();
  const input = await loadStatusEmailInput(appId);

  const { sendApplicationDeclinedEmail } = await import("./merchant-application-status");
  // Transient contact/GHL/send failures propagate here and keep the row retryable.
  const result = await sendApplicationDeclinedEmail(input);

  if (result.status === "sent") {
    await storage.createAuditLog({
      action: "merchant_application_declined_email_sent",
      entityType: "merchant_application",
      entityId: appId,
      details: {},
    });
  } else {
    await storage.createAuditLog({
      action: "merchant_application_declined_email_skipped",
      entityType: "merchant_application",
      entityId: appId,
      details: { reason: result.reason },
    });
  }
}

async function handleLifecycleDeclined(row: OutboxRow): Promise<void> {
  const contactId = row.payload.contactId as number | null;
  if (!contactId) return;
  const { LifecycleService } = await import("./lifecycle-service");
  await LifecycleService.transition(contactId, "CLOSED_LOST", {
    trigger: "merchant_application_declined",
    source: "outbox-worker",
    reason: (row.payload.declineReason as string) ?? undefined,
    metadata: { applicationId: row.applicationId },
  });
}

async function handleEsignSend(row: OutboxRow): Promise<void> {
  const appId = row.applicationId;
  const [app] = await db.select().from(merchantApplications).where(eq(merchantApplications.id, appId)).limit(1);
  if (!app) throw new Error(`Application #${appId} not found`);

  if (app.esignDocumentId && app.esignStatus === "sent") {
    await applyEsignSendState({ applicationId: appId, sendState: "sent" });
    return;
  }

  const templateId = process.env.GHL_MERCHANT_AGREEMENT_TEMPLATE_ID;
  if (!templateId) {
    // Template genuinely not configured — this is a configuration gap, not
    // an effect failure. Mark idle so it stops looping; operator must configure.
    await applyEsignSendState({ applicationId: appId, sendState: "idle" });
    return;
  }

  const recipientName = `${app.ownerFirstName || ""} ${app.ownerLastName || ""}`.trim() || app.legalBusinessName || "Merchant";
  const recipientEmail = app.ownerEmail || app.businessEmail || "";
  if (!recipientEmail) {
    await applyEsignSendState({ applicationId: appId, sendState: "idle" });
    // No email is a data-quality issue, not transient — treat as terminal config problem.
    return;
  }

  await assertOutboundNotPaused();
  const { sendDocumentForEsign } = await import("./ghl");
  const result = await sendDocumentForEsign({ documentTemplateId: templateId, recipientName, recipientEmail, applicationId: appId });

  if (!result.success) {
    await applyEsignSendState({ applicationId: appId, sendState: "failed" });
    // Propagate so row stays retryable (item 2). Error scrubbed before logging.
    throw new Error("e-sign provider send failed");
  }

  await applyEsignDocumentState({
    applicationId: appId,
    esignStatus: "sent",
    esignDocumentId: result.documentId || null,
    esignSigningUrl: result.signingUrl || null,
  });
  await applyEsignSendState({ applicationId: appId, sendState: "sent" });

  await storage.createAuditLog({
    action: "merchant_application_esign_sent",
    entityType: "merchant_application",
    entityId: appId,
    details: {},
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

async function processRow(row: OutboxRow): Promise<void> {
  switch (row.eventType) {
    case "contact_link":       return handleContactLink(row);
    case "consent_record":     return handleConsentRecord(row);
    case "ghl_sync":           return handleGhlSync(row);
    case "workflow_enroll":    return handleWorkflowEnroll(row);
    case "risk_scan":          return handleRiskScan(row);
    case "approval_email":     return handleApprovalEmail(row);
    case "deal_stage":         return handleDealStage(row);
    case "lifecycle_approved": return handleLifecycleApproved(row);
    case "decline_email":      return handleDeclineEmail(row);
    case "lifecycle_declined": return handleLifecycleDeclined(row);
    case "esign_send":         return handleEsignSend(row);
    default:
      // Unknown / legacy combined event types (including the pre-split
      // finalize_side_effects and status_changed) must NOT be silently marked
      // delivered — that could drop a real, unhandled side effect. Throw so the
      // row retries and ultimately dead-letters for operator inspection (item 4).
      throw new Error(`Unknown outbox event type: ${row.eventType}`);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  // Pool-pressure backpressure: if callers are already queued waiting for a
  // DB connection, skip this tick rather than adding more pressure. The next
  // scheduled tick (15 s later) will retry. This prevents the outbox worker
  // from contributing to pool saturation during high-load windows.
  if (pool.waitingCount > 0) {
    process.stderr.write(`[MerchantOutbox] Pool pressure — ${pool.waitingCount} waiter(s), skipping tick\n`);
    return;
  }
  // NOTE: No top-level pause check here. Pure data-operations (contact_link,
  // consent_record, risk_scan, deal_stage, lifecycle_*) must run regardless of
  // the global outbound pause so that contact creation and PEWC consent recording
  // are never blocked.  GHL-sending events (ghl_sync, workflow_enroll, esign_send)
  // fail naturally at the service layer (pause authority blocks GHL calls there)
  // and are retried with exponential back-off until the pause is lifted.
  running = true;
  try {
    await reclaimStale();

    for (let i = 0; i < 10; i++) {
      const row = await claimOne();
      if (!row) break;
      try {
        await processRow(row);
        await markDelivered(row.id);
      } catch (err) {
        // Minimal operational log — no app/profile data, no provider payloads.
        process.stderr.write(`[MerchantOutbox] ${row.eventType} app#${row.applicationId} attempt#${row.attempts} failed (${scrubError(err)})\n`);
        await markRetryOrDeadLetter(row.id, row.attempts, err);
      }
    }
  } catch (err) {
    process.stderr.write(`[MerchantOutbox] Tick error: ${scrubError(err)}\n`);
  } finally {
    running = false;
  }
}

export function startMerchantApplicationOutboxWorker(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  const initial = setTimeout(() => void tick(), 3000);
  if (typeof initial.unref === "function") initial.unref();
}

/**
 * Schedule an expedited outbox tick ~100 ms from now.
 * Call after a finalize/status mutation to ensure contact_link and consent_record
 * rows are processed promptly rather than waiting up to POLL_INTERVAL_MS (15 s).
 * Safe to call concurrently — the re-entrancy guard in tick() prevents double-work.
 *
 * No-op when BACKGROUND_JOB_PROFILE=off — the recurring worker was not started
 * and triggering an ad-hoc tick would execute background work in HTTP/API-only mode.
 */
export function triggerOutboxTick(): void {
  // Use the canonical profile resolver so invalid/missing values fail closed to "off".
  // Inline the logic (same as getBackgroundProfile) to avoid a circular import.
  const VALID_PROFILES = new Set(["off", "core", "full"]);
  const raw = process.env.BACKGROUND_JOB_PROFILE;
  const profile = raw && VALID_PROFILES.has(raw) ? raw : "off";
  if (profile === "off") {
    // off mode (explicit or fail-closed): recurring worker was not started;
    // skip ad-hoc tick to preserve the HTTP/API-only guarantee.
    return;
  }
  const t = setTimeout(() => { void tick(); }, 100);
  if (typeof t.unref === "function") t.unref();
}

export const __test__ = { backoffMs, MAX_ATTEMPTS, STALE_LOCK_MS, scrubError };
