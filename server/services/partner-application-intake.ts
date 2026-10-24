/**
 * Local completion of a claimed partner-application (or affiliate-signup) occurrence.
 *
 * Every step is idempotent and uses the existing authorities: the contact writer with the partner source contract
 * (`website_form|partner_application`, event key derived from the occurrence), a command-keyed review notification, and
 * the inbound request orchestrator. Because the steps are repeatable, a replay of a partially completed occurrence
 * resumes the missing work once instead of telling the applicant to resubmit. No provider call is made here: the
 * contact writer records durable provider work, and the receipt owner decides whether any email is ever sent.
 */
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { inboundRequests, notifications } from "@shared/schema";
import { storage } from "../storage";
import { createContactLocalFirst, upsertContactSourceEvent } from "./contact-writer";
import { ensurePartnerCredential } from "./partner-account";
import { orchestrateInboundRequest, setInboundRequestLifecycle } from "./inbound-request-authority";
import type { InboundRequest } from "@shared/schema";
import { describeAckReceiptState } from "./inbound-acknowledgement";
import { resolveReviewAssignment, reviewMetadata } from "./inbound-review-policy";
import { logOperationalDiagnostic } from "../utils/server-error";

export interface PartnerApplicationSubject {
  id: number;
  email: string;
  phone?: string | null;
  contactName?: string | null;
  companyName?: string | null;
  partnerType?: string | null;
  affiliateCode?: string | null;
}

export interface LocalCompletion {
  localContactId: number | null;
  contactRecorded: boolean;
  reviewNotified: boolean;
  emailReceipt: "queued" | "not_enabled";
}

function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

/**
 * Serializes every local-completion pass for one occurrence (request path, replay and background recovery), so two
 * passes can never interleave their contact/notification steps. The lock is transaction-scoped on its own connection.
 */
async function withOccurrenceLock<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"partner-application:" + requestId}))`);
    return fn();
  });
}

export async function completePartnerApplicationLocal(
  inbound: Pick<InboundRequest, "id" | "sourceReceivedAt">,
  partner: PartnerApplicationSubject,
  variant: "partner" | "affiliate",
): Promise<LocalCompletion> {
  return withOccurrenceLock(inbound.id, () => completeLocked(inbound, partner, variant));
}

async function completeLocked(
  inbound: Pick<InboundRequest, "id" | "sourceReceivedAt">,
  partner: PartnerApplicationSubject,
  variant: "partner" | "affiliate",
): Promise<LocalCompletion> {
  const email = partner.email.trim().toLowerCase();
  const provenance = {
    sourceCategory: "website_form",
    sourceType: "partner_application",
    eventKey: `form:partner_application:${inbound.id}`,
  };

  let localContactId: number | null = null;
  let contactRecorded = false;
  try {
    const existing = await storage.getContactByEmail(email);
    if (existing) {
      // The same mailbox is the same contact: link it without modifying it, and append THIS occurrence's source
      // evidence (idempotent on the occurrence key) so the contact's history shows the application.
      await upsertContactSourceEvent({
        contactId: existing.id,
        provenance: { ...provenance, actorType: "system", metadata: { partnerId: partner.id, variant, via: "existing_contact" } },
      });
      localContactId = existing.id;
    } else {
      const { firstName, lastName } = splitName(partner.contactName);
      const created = await createContactLocalFirst({
        firstName,
        lastName,
        email,
        phone: partner.phone ?? "",
        companyName: partner.companyName || undefined,
        status: "Active",
        tags: variant === "affiliate" ? ["src_website", "affiliate"] : ["src_website", "iso_partner_application", partner.partnerType ?? "referral"],
      }, undefined, provenance);
      localContactId = created?.id ?? null;
    }
    contactRecorded = localContactId != null;
  } catch (err) {
    logOperationalDiagnostic("partner_application_sync", err, "contact_create_failed", { partnerId: partner.id });
  }

  const assignment = await resolveReviewAssignment("partner_application_request", inbound.sourceReceivedAt ?? new Date());
  const label = (partner.companyName || partner.contactName || "A new applicant").toString().trim().slice(0, 120);
  let reviewNotified = false;
  let emailReceipt: "queued" | "not_enabled" = "not_enabled";
  try {
    // Repeatable: the notification is command-keyed, so a pass after a crash reuses the one already written.
    const commandKey = `inbound:${inbound.id}:review-notification`;
    const [priorNotification] = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.commandKey, commandKey)).limit(1);
    const notification = priorNotification ?? await storage.createNotification({
      channel: "internal",
      title: variant === "affiliate" ? "New affiliate signup to review" : "New partner application to review",
      message: variant === "affiliate"
        ? `${label} signed up as an affiliate.`
        : `${label} applied as ${(partner.partnerType ?? "referral").replace(/_/g, " ")}.`,
      type: "alert",
      inboundRequestId: inbound.id,
      commandKey,
      metadata: {
        partnerId: partner.id,
        link: "/dashboard/referral-program",
        eventType: "partner_application_received",
        audienceRoles: ["admin"],
        ...reviewMetadata(assignment),
      },
    } as any);
    const orchestrated = await orchestrateInboundRequest({ requestId: inbound.id, contactId: localContactId, notificationId: notification.id });
    reviewNotified = orchestrated.lifecycleState !== "review_required";
    emailReceipt = await describeAckReceiptState(inbound.id);
  } catch (err) {
    logOperationalDiagnostic("partner_application_review", err, "review_notification_failed", { partnerId: partner.id });
    await setInboundRequestLifecycle(inbound.id, "review_required", "REVIEW_NOTIFICATION_FAILED").catch(() => undefined);
  }
  if (!contactRecorded) {
    // Truthful and resumable: the contact record is missing, so the occurrence stays visible for review/resume.
    await setInboundRequestLifecycle(inbound.id, "review_required", "CONTACT_RECORD_FAILED").catch(() => undefined);
  }
  return { localContactId, contactRecorded, reviewNotified: reviewNotified && contactRecorded, emailReceipt };
}

/** An occurrence that has captured no mailbox is given this long before it is declared to have created no account. */
export const UNBOUND_OCCURRENCE_GRACE_MS = 60_000;

/**
 * Finish the missing local work of an occurrence from what was durably recorded.
 *
 * The account is found only through the occurrence's captured mailbox, which is written in the same transaction as the
 * account. A captured mailbox therefore proves an account exists (and resumes it); no captured mailbox proves none was
 * created. Within the grace period an unbound occurrence may still be executing, so it is reported as in progress
 * rather than failed.
 */
export async function resumePartnerApplication(
  request: Pick<InboundRequest, "id" | "lifecycleState" | "submittedEmail" | "sourceReceivedAt"> & { createdAt?: Date | null },
  variant: "partner" | "affiliate",
  now: Date = new Date(),
): Promise<{ failed?: string; state?: string }> {
  if (!["claimed", "processing", "review_required"].includes(String(request.lifecycleState))) return {};
  const email = request.submittedEmail?.trim().toLowerCase();
  if (!email) {
    const startedAt = (request.createdAt ?? request.sourceReceivedAt ?? now).getTime();
    if (now.getTime() - startedAt < UNBOUND_OCCURRENCE_GRACE_MS) return { state: String(request.lifecycleState) };
    await setInboundRequestLifecycle(request.id, "failed", "PARTIAL_INTAKE_NO_ACCOUNT");
    return { failed: "PARTIAL_INTAKE_NO_ACCOUNT" };
  }
  const partner = await storage.getPartnerByEmail(email);
  if (!partner) {
    // Cannot happen for an occurrence bound by account creation; surface it instead of guessing.
    await setInboundRequestLifecycle(request.id, "failed", "BOUND_ACCOUNT_MISSING");
    return { failed: "BOUND_ACCOUNT_MISSING" };
  }
  // Variant follows the recorded account, not the caller, so recovery needs no browser context.
  const effectiveVariant: "partner" | "affiliate" = partner.partnerType === "affiliate" ? "affiliate" : variant;
  await ensurePartnerCredential(partner, effectiveVariant === "affiliate" ? "affiliate" : "partner");
  const done = await completePartnerApplicationLocal(request, partner as PartnerApplicationSubject, effectiveVariant);
  return { state: done.contactRecorded && done.reviewNotified ? "accepted" : "review_required" };
}

const RECOVERABLE_REASONS = ["CONTACT_RECORD_FAILED", "REVIEW_NOTIFICATION_FAILED"] as const;

/**
 * Ordinary background recovery: resumes occurrences that stopped part-way, with no browser replay. Finds claimed or
 * processing occurrences and review_required occurrences whose recorded reason is a failed local step. Occurrences
 * waiting on a human review for any other reason are left alone. Makes no provider call.
 */
export async function recoverPartnerApplications(opts: { now?: Date; staleMs?: number; limit?: number } = {}): Promise<{
  examined: number; resumed: number; failedNoAccount: number; skippedFresh: number;
}> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.staleMs ?? 120_000));
  const rows = await db.select().from(inboundRequests).where(and(
    eq(inboundRequests.sourceCategory, "website_form"),
    eq(inboundRequests.sourceType, "partner_application"),
    lt(inboundRequests.updatedAt, cutoff),
    or(
      inArray(inboundRequests.lifecycleState, ["claimed", "processing"]),
      and(eq(inboundRequests.lifecycleState, "review_required"), inArray(inboundRequests.terminalReason, [...RECOVERABLE_REASONS])),
    ),
  )).orderBy(asc(inboundRequests.updatedAt)).limit(opts.limit ?? 25);
  const out = { examined: rows.length, resumed: 0, failedNoAccount: 0, skippedFresh: 0 };
  for (const row of rows) {
    try {
      const result = await resumePartnerApplication(row, "partner", now);
      if (result.failed) out.failedNoAccount += 1;
      else if (result.state === row.lifecycleState && !row.submittedEmail) out.skippedFresh += 1;
      else out.resumed += 1;
    } catch (err) {
      logOperationalDiagnostic("partner_application_recovery", err, "resume_failed", { requestId: row.id });
    }
  }
  return out;
}

let recoveryStarted = false;
const RECOVERY_INTERVAL_MS = 60_000;

/** Starts the recovery sweep (same lifecycle as the acknowledgement worker; off with the background profile). */
export function startPartnerApplicationRecovery(): void {
  if (recoveryStarted) return;
  recoveryStarted = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const tally = await recoverPartnerApplications();
      await storage.setSystemSetting("partner_application_recovery_heartbeat", { at: new Date().toISOString(), outcome: "ok", tally, intervalMs: RECOVERY_INTERVAL_MS });
    } catch (err) {
      await storage.setSystemSetting("partner_application_recovery_heartbeat", {
        at: new Date().toISOString(), outcome: "error", errorName: err instanceof Error ? err.name : "NonError", intervalMs: RECOVERY_INTERVAL_MS,
      }).catch(() => undefined);
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, RECOVERY_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  const initial = setTimeout(() => void tick(), 15_000);
  if (typeof initial.unref === "function") initial.unref();
}
