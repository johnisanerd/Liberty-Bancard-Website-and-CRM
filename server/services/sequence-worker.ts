import {
  evaluateCanonicalAuthority, reconcileCanonicalReleases, settleCanonicalEnrollment, holdCanonicalEnrollment,
  recordUnsentRetry, recordHeldReservation, MAX_UNSENT_RETRIES,
} from "./sfp-canonical-release";
import { reserveSenderCapacity, releaseSenderCapacity, type CapacityReservation } from "./sfp-sender-capacity";
import { storage } from "../storage";
import { db as defaultSequenceWorkerDb } from "../db";
import { sequenceEnrollments as sequenceEnrollmentsTable } from "../../shared/schema";
import { and as drizzleAnd, eq as drizzleEq } from "drizzle-orm";
import { isGhlConfigured } from "./ghl";
// sendGhlEmail / sendGhlSms are now invoked via ChannelOrchestrator transport adapters (Wave 1A).
// Do not re-import them here — use channelOrchestrator.sendEmail / sendSms instead.
import { getEmailSignatureHtml, isColdOutreachSequence } from "./email-signatures";
import type { SignatureType } from "./sender-policy";
import { sanitizeFirstName } from "./contact-name-utils";
import { resolvePolicy } from "./sender-policy";
import { sfpLaunchRenderContext, renderSfpLaunchSubject, renderSfpLaunchBodyHtml } from "./sfp-launch-render";
import { SFP_LAUNCH_SEQUENCE_FAMILY_PREFIX } from "./cro03/sfp-launch-content";
import { hashEmailToken } from "./provider-readiness-control";
import { getOrCreateSequenceAbAssignment, recordSequenceAbDelivery } from "./sequence-ab-authority";
import { authorizeCommercialUseBatch } from "./commercial-resolution";
import {
  classifyCr06SequencePurpose,
  decideCr06PromotionalLifecycle,
} from "./cr06-promotional-lifecycle-decision";

/**
 * Map a sequence's triggerConfig.category to the correct email signature type.
 *
 * | Category                | Signature   | Rationale                                                        |
 * |-------------------------|-------------|------------------------------------------------------------------|
 * | operations              | accounts    | Account mgmt team identity; no cold CTAs; existing relationship  |
 * | reactivation            | accounts    | Re-engaging known contacts; cold CTA would feel inappropriate    |
 * | education               | accounts    | Educational content for merchants/prospects already in pipeline  |
 * | nurture                 | accounts    | Long-term nurture; contact knows us; no cold promo               |
 * | support                 | support     | Ticket replies and merchant-service messages                     |
 * | risk                    | support     | Account-risk / security notices routed through support team      |
 * | onboarding              | onboarding  | Merchant activation and boarding milestones                      |
 * | referral                | partners    | Referral / partner program communications                        |
 * | sales                   | sales       | Explicit sales outreach — cold signature is intentional          |
 * | cold_outreach           | sales       | SDR cold prospecting sequences                                   |
 * | sdr                     | sales       | Legacy SDR category — cold outreach context                      |
 * | sdr_cold_outbound       | sales       | SDR cold outbound sequences                                      |
 * | sdr_outbound            | sales       | SDR outbound sequences                                           |
 * | sdr_noshow_recovery     | sales       | SDR no-show recovery — still in cold pipeline                    |
 * | sdr_proposal_followup   | sales       | SDR proposal follow-up — still Scott Stevenson sender            |
 * | sdr_reply_engaged       | sales       | Engaged lead follow-up within SDR context                        |
 * | sdr_statement_chase     | sales       | Chasing a statement upload — SDR cold context                    |
 * | inbound                 | sales       | Inbound lead nurture — same cold CTA block applies               |
 * | voicemail_followup_sms  | sales       | Voicemail follow-up SMS — sales pipeline                         |
 * | hardware                | sales       | Hardware product outreach — cold CTA appropriate                 |
 * | (unrecognized)          | sales       | Safe default; logs a warning so new categories are noticed       |
 */
export function resolveSignatureType(triggerConfig: Record<string, unknown>): SignatureType {
  const category = typeof triggerConfig.category === "string" ? triggerConfig.category : "";
  switch (category) {
    // ── Account-relationship signatures (no cold CTAs) ──────────────────────
    case "operations":
    case "reactivation":
    case "education":
    case "nurture":
      return "accounts";

    // ── Support / risk ───────────────────────────────────────────────────────
    case "support":
    case "risk":
      return "support";

    // ── Onboarding ───────────────────────────────────────────────────────────
    case "onboarding":
      return "onboarding";

    // ── Partner / referral ───────────────────────────────────────────────────
    case "referral":
      return "partners";

    // ── Sales / cold outreach (all SDR variants + explicit sales) ────────────
    case "sales":
    case "cold_outreach":
    case "sdr":
    case "sdr_cold_outbound":
    case "sdr_outbound":
    case "sdr_noshow_recovery":
    case "sdr_proposal_followup":
    case "sdr_reply_engaged":
    case "sdr_statement_chase":
    case "inbound":
    case "voicemail_followup_sms":
    case "hardware":
      return "sales";

    // ── Unknown category — warn and fall back to cold sales ──────────────────
    default:
      if (category) {
        console.warn(
          `[resolveSignatureType] Unknown sequence category "${category}" — defaulting to "sales" signature. ` +
          `Add an explicit mapping in resolveSignatureType() to silence this warning.`
        );
      }
      return "sales";
  }
}
import { createPreferenceAwareNotification } from "./digest-service";
import { enrollContactInGhlWorkflow, tagContactForInboxOrganization } from "./ghl-workflow-enrollment";
import { addNote as ghlAddNote, addTag as ghlAddTag, triggerWorkflow as ghlTriggerWorkflow, isSdrGhlConfigured } from "./sdr/ghl-client";
import { getWorkflowEnvValue } from "./ghl-workflows";
import { sendSmtpEmail, isSmtpConfigured } from "./smtp-email";
import { generateUnsubscribeToken } from "./unsubscribe-token";
import { authorizeSequenceDispatch, buildIdempotencyKey, hasSentStep, getSendLogByKey, reopenUnsentAttempt, openSendAttempt, markSendSent, markSendFailed, type DispatchAuthorization } from "./outbound-send-log";
import { terminalizeSequenceEnrollment } from "./sequence-terminalization";
import { sendGmailEmail, isGmailOAuthConnected } from "./gmail-oauth";
import type { SendChannel } from "./outbound-send-log";
import type { VoiceBotMode } from "./sdr/voice-orchestrator";
import type { AbTestConfig, AbTestResults } from "@shared/schema";
import { getCanonicalUrl } from "../lib/canonical-url";

/**
 * ZeroBounce statuses that are definitively undeliverable.
 * Used consistently across: the per-step lazy ZB gate, the pre-enrollment ZB gate,
 * and the at-load bounce guard. Keep in sync with ZB_INVALID_STATUSES in campaign-engine.ts.
 */
const ZB_UNDELIVERABLE = new Set([
  "invalid",
  "unsafe",     // spam traps, abuse addresses, do_not_mail
  "bounced",
  "do_not_mail",
  "spam_trap",
  "abuse",
]);

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ARCHITECTURE BOUNDARY — Replit Orchestrates, GHL Transports            ║
// ║                                                                          ║
// ║  This worker is the SOLE orchestration authority for all outbound        ║
// ║  sequence steps. It owns:                                                ║
// ║    • Step scheduling (BullMQ ticks, delayDays advancement)               ║
// ║    • Gate evaluation (global pause, contactability, daily-cap, DNC,      ║
// ║      quiet-hours, bounce guard, reply-stop)                              ║
// ║    • Step dispatch (email/SMS/task/call/voicemail action execution)       ║
// ║                                                                          ║
// ║  GHL is a TRANSPORT layer only in this file:                             ║
// ║    • sendGhlEmail / sendGhlSms   — deliver a message Replit composed     ║
// ║    • upsertGhlContact            — keep CRM contact record in sync       ║
// ║    • addTag / addNote            — label contact for inbox organisation   ║
// ║                                                                          ║
// ║  enrollContactInGhlWorkflow() is called at step 0 ONLY to sync the      ║
// ║  contact to GHL (upsert + inbox tags + note). It always returns          ║
// ║  method:"replit_direct" — it never triggers a GHL native workflow.       ║
// ║  See ghl-workflow-enrollment.ts for the full boundary documentation.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const GHL_WORKFLOW_ONLY = process.env.GHL_WORKFLOW_ONLY_MODE === "true";

// ── Hold-deferral helper (exported for isolated testing) ──────────────────────
/**
 * Writes the durable `_holdDeferred` marker to a sequence enrollment without
 * changing its `status` (enrollment remains `'active'`).
 *
 * Idempotent: if `currentStep` AND `holdReason` already match the stored
 * marker fields, no DB write is performed and the original `_holdDeferredAt`
 * timestamp is preserved.
 *
 * @param enrollmentId   PK of the `sequence_enrollments` row to update
 * @param currentStep    Current step index (`enrollment.currentStep`)
 * @param holdReason     Human-readable reason string for the deferral
 * @param existingMeta   Current `enrollment.metadata` value (or null)
 * @param dbInstance     Drizzle db instance to use; defaults to the global db.
 *                       Pass a test-DB instance for isolated unit tests.
 * @returns `{ written, _holdDeferredAt }` — `written` is false when
 *          idempotency short-circuited the write.
 */
export async function writeHoldDeferralMarker(
  enrollmentId: number,
  currentStep: number,
  holdReason: string,
  existingMeta: Record<string, unknown> | null,
  dbInstance?: typeof defaultSequenceWorkerDb,
): Promise<{ written: boolean; _holdDeferredAt: string | null }> {
  const meta = existingMeta ?? {};
  const alreadyDeferred =
    meta._holdDeferredStep === currentStep &&
    meta._holdDeferredReason === holdReason;

  if (alreadyDeferred) {
    return {
      written: false,
      _holdDeferredAt: typeof meta._holdDeferredAt === "string" ? meta._holdDeferredAt : null,
    };
  }

  const deferredAt = new Date().toISOString();
  const target = dbInstance ?? defaultSequenceWorkerDb;

  await target
    .update(sequenceEnrollmentsTable)
    .set({
      // status intentionally NOT changed — enrollment remains 'active'
      metadata: {
        ...meta,
        _holdDeferredStep: currentStep,
        _holdDeferredReason: holdReason,
        _holdDeferredAt: deferredAt,
      } as any,
      updatedAt: new Date(),
    })
    .where(drizzleEq(sequenceEnrollmentsTable.id, enrollmentId));

  return { written: true, _holdDeferredAt: deferredAt };
}

const REPLY_DECISION_RETRY_MS = 5 * 60 * 1000;

/** Complete only the version of an active enrollment this worker observed. */
async function completeNoResponseEnrollment(
  enrollment: any,
  sequence: any,
  currentStep: number,
  reason: "sequence_exhausted_no_response" | "sms_skipped_no_response" = "sequence_exhausted_no_response",
): Promise<boolean> {
  if (!enrollment.contactId || !enrollment.createdAt) return false;
  const terminalized = await terminalizeSequenceEnrollment({
    enrollmentId: enrollment.id,
    contactId: enrollment.contactId,
    enrolledAt: new Date(enrollment.createdAt),
    expectedCurrentStep: enrollment.currentStep ?? 0,
    terminalCurrentStep: currentStep,
    noResponseReason: reason,
  });
  if (terminalized.outcome === "STALE" || terminalized.outcome === "UNAVAILABLE") return false;
  if (terminalized.outcome === "COMPLETED_REPLY") {
    await storage.createAuditLog({
      action: "sequence_stopped_contact_replied", entityType: "contact", entityId: enrollment.contactId, actorType: "system",
      details: { enrollmentId: enrollment.id, sequenceId: sequence.id, sequenceName: sequence.name, stoppedAtStep: currentStep, reason: "contact_replied" },
    });
    return true;
  }
  await storage.createAuditLog({
    action: "sequence_completed_no_response",
    entityType: "contact",
    entityId: enrollment.contactId || 0,
    actorType: "system",
    details: { enrollmentId: enrollment.id, sequenceId: sequence.id, sequenceName: sequence.name, terminal: { category: "no_response", reason } },
  });
  await createPreferenceAwareNotification({
    channel: "internal",
    title: "Sequence Exhausted — No Response",
    message: `Sequence "${sequence.name}" exhausted without a response for contact #${enrollment.contactId || 0}.`,
    type: "info",
    metadata: { sequenceId: sequence.id, contactId: enrollment.contactId, eventType: "sequence_completed_no_response", terminalReason: reason },
  }, "sequence_completed_no_response");
  return true;
}

async function applyReplyDecision(enrollment: any, sequence: any, currentStep: number): Promise<"continue" | "stopped"> {
  if (!enrollment.contactId || !enrollment.createdAt) {
    await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable)
      .set({
        nextActionAt: new Date(Date.now() + REPLY_DECISION_RETRY_MS),
        metadata: {
          ...((enrollment.metadata as Record<string, unknown> | null) ?? {}),
          deferral: { reason: "reply_decision_unavailable", currentStep },
        } as any,
        updatedAt: new Date(),
      })
      .where(drizzleAnd(
        drizzleEq(sequenceEnrollmentsTable.id, enrollment.id),
        drizzleEq(sequenceEnrollmentsTable.status, "active"),
        drizzleEq(sequenceEnrollmentsTable.currentStep, enrollment.currentStep ?? 0),
      ));
    return "stopped";
  }
  const { decideReplySinceEnrollment } = await import("./communication-events");
  const decision = await decideReplySinceEnrollment(enrollment.contactId, new Date(enrollment.createdAt));
  if (decision === "CONFIRMED_ABSENT") {
    const fenced = await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable)
      .set({ updatedAt: new Date() })
      .where(drizzleAnd(
        drizzleEq(sequenceEnrollmentsTable.id, enrollment.id),
        drizzleEq(sequenceEnrollmentsTable.status, "active"),
        drizzleEq(sequenceEnrollmentsTable.currentStep, enrollment.currentStep ?? 0),
      ))
      .returning({ id: sequenceEnrollmentsTable.id });
    return fenced.length ? "continue" : "stopped";
  }
  if (decision === "REPLIED") {
    const changed = await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable)
      .set({
        status: "completed", completedAt: new Date(), updatedAt: new Date(),
        metadata: { ...((enrollment.metadata as Record<string, unknown> | null) ?? {}), terminal: { category: "reply", reason: "contact_replied" } } as any,
      })
      .where(drizzleAnd(drizzleEq(sequenceEnrollmentsTable.id, enrollment.id), drizzleEq(sequenceEnrollmentsTable.status, "active"), drizzleEq(sequenceEnrollmentsTable.currentStep, enrollment.currentStep ?? 0)))
      .returning({ id: sequenceEnrollmentsTable.id });
    if (changed.length) await storage.createAuditLog({
      action: "sequence_stopped_contact_replied", entityType: "contact", entityId: enrollment.contactId, actorType: "system",
      details: { enrollmentId: enrollment.id, sequenceId: sequence.id, sequenceName: sequence.name, stoppedAtStep: currentStep, reason: "contact_replied" },
    });
  } else {
    await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable)
      .set({
        nextActionAt: new Date(Date.now() + REPLY_DECISION_RETRY_MS),
        metadata: {
          ...((enrollment.metadata as Record<string, unknown> | null) ?? {}),
          deferral: { reason: "reply_decision_unavailable", currentStep },
        } as any,
        updatedAt: new Date(),
      })
      .where(drizzleAnd(
        drizzleEq(sequenceEnrollmentsTable.id, enrollment.id),
        drizzleEq(sequenceEnrollmentsTable.status, "active"),
        drizzleEq(sequenceEnrollmentsTable.currentStep, enrollment.currentStep ?? 0),
      ));
  }
  return "stopped";
}

async function handleDeniedDispatchAuthorization(
  authorization: DispatchAuthorization,
  enrollment: any,
  sequence: any,
  currentStep: number,
): Promise<void> {
  const replyHandling = await applyReplyDecision(enrollment, sequence, currentStep);
  if (replyHandling === "stopped") return;
  await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable).set({
    nextActionAt: new Date(Date.now() + REPLY_DECISION_RETRY_MS),
    metadata: {
      ...((enrollment.metadata as Record<string, unknown> | null) ?? {}),
      deferral: {
        reason: authorization.outcome === "UNAVAILABLE"
          ? "dispatch_authorization_unavailable"
          : "dispatch_not_authorized",
        currentStep,
      },
    } as any,
    updatedAt: new Date(),
  }).where(drizzleAnd(
    drizzleEq(sequenceEnrollmentsTable.id, enrollment.id),
    drizzleEq(sequenceEnrollmentsTable.status, "active"),
    drizzleEq(sequenceEnrollmentsTable.currentStep, enrollment.currentStep ?? 0),
  ));
}

export async function processSequenceEnrollments(
  opts: { canonicalReleaseOnly?: boolean } = {},
): Promise<{ processed: number; errors: number }> {
  const { acquireJobLock, releaseJobLock, startJobLockHeartbeat, JOB_NAMES } = await import("./job-registry");
  const lease = await acquireJobLock(JOB_NAMES.SEQUENCE_WORKER);
  if (lease.status !== "acquired") return { processed: 0, errors: 0 };
  const lockToken = lease.lockToken;
  const heartbeat = startJobLockHeartbeat(JOB_NAMES.SEQUENCE_WORKER, lockToken);

  const _runStartMs = Date.now();
  let processed = 0;
  let errors = 0;

  // Dev-only: EXPLAIN the due-work query to confirm index seek vs seq scan
  if (process.env.NODE_ENV !== "production") {
    try {
      const { db: _explDb } = await import("../db");
      const { sql: _explSql } = await import("drizzle-orm");
      const explainResult = await _explDb.execute(_explSql`
        EXPLAIN SELECT id FROM sequence_enrollments
        WHERE status = 'active'
          AND next_action_at IS NOT NULL
          AND next_action_at <= NOW()
      `);
      const planLines = (explainResult.rows as Array<{ "QUERY PLAN": string }>)
        .map(r => r["QUERY PLAN"])
        .join("\n");
      const scanType = planLines.includes("Index") ? "Index Scan ✓" : "Seq Scan ✗ (index missing or not used)";
      console.log(`[SequenceWorker] EXPLAIN due-work query: ${scanType}\n${planLines}`);
    } catch (_explErr) {
      // Non-fatal: EXPLAIN failure should never block the worker
    }
  }

  try {
    await reconcileCanonicalReleases().catch((error) => {
      console.error("[SFP_CANONICAL_RELEASE_EXPIRY_RECONCILE_FAILED]", error instanceof Error ? error.name : "UnknownError");
    });
    const dueEnrollments = await storage.getActiveEnrollments();
    await authorizeCommercialUseBatch({
      subjects: dueEnrollments
        .filter((enrollment) => Number.isInteger(enrollment.contactId))
        .slice(0, 2_000)
        .map((enrollment) => ({ subjectType: "contact" as const, subjectId: enrollment.contactId! })),
      effect: "marketing_outreach",
      maxSubjects: 2_000,
    }).catch((error) => {
      console.error("[CRO02_SEQUENCE_OBSERVATION_FAILED]", {
        count: Math.min(dueEnrollments.length, 2_000),
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    });

    for (const enrollment of dueEnrollments) {
      heartbeat.assertOwned();
      let canonicalJourney = false;
      try {
        const sequence = await storage.getFollowUpSequence(enrollment.sequenceId!);
        if (!sequence || sequence.retiredAt) continue;
        // A canonical SFP sequence stays paused; only an enrollment released by an admin inside the
        // live, unexpired release is admitted. Every other send gate below still applies to it.
        // Fresh decision for every claim: nothing is cached across expiry, revocation or a closed admission window.
        const canonicalAuthority = await evaluateCanonicalAuthority(enrollment, sequence);
        const canonicalReleaseAdmitted = canonicalAuthority.admitted;
        canonicalJourney = canonicalReleaseAdmitted;
        if (!canonicalAuthority.admitted && canonicalAuthority.settle !== "none") {
          // Authority ended (revoked, journey deadline, admission window closed on an unsent first touch):
          // settle the enrollment now so it never lingers active, then move on.
          const settled = await settleCanonicalEnrollment(enrollment.id, canonicalAuthority.releaseId, canonicalAuthority);
          if (settled) {
            await storage.createAuditLog({
              action: "sfp_canonical_authority_settled", entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
              details: { enrollmentId: enrollment.id, reason: canonicalAuthority.reason, settle: canonicalAuthority.settle, endedReason: canonicalAuthority.endedReason },
            });
          }
          continue;
        }
        if (sequence.status !== "active" && !canonicalReleaseAdmitted) {
          continue;
        }
        // Release-only mode (legacy outreach flag off): nothing but an enrollment
        // an admin released inside the live release may be processed.
        if (opts.canonicalReleaseOnly && !canonicalReleaseAdmitted) continue;
        // This is both the durable-work claim boundary and a final safety net
        // before any sequence step can reach a transport. Non-promotional
        // sequences must declare their purpose explicitly in triggerConfig.
        const cr06Purpose = classifyCr06SequencePurpose(sequence);
        const cr06Decision = decideCr06PromotionalLifecycle({
          boundary: "sequence_claim",
          purpose: cr06Purpose,
        });
        if (!cr06Decision.allowed && !canonicalReleaseAdmitted) {
          await storage.updateSequenceEnrollment(enrollment.id, {
            nextActionAt: new Date(Date.now() + 60 * 60 * 1000),
            metadata: {
              ...((enrollment.metadata as Record<string, unknown> | null) ?? {}),
              deferral: { reason: cr06Decision.reasonCode, currentStep: enrollment.currentStep ?? 0 },
            },
          });
          processed++;
          continue;
        }

        const steps = await storage.getSequenceSteps(sequence.id);
        const currentStep = enrollment.currentStep || 0;

        // ── Gate (global-pause + coordinator): Platform-level kill switch ─────
        // Upgraded from raw system_settings read to OutboundPauseAuthority + coordinator.
        // (#1532) FIX: enrollment status is NO LONGER mutated to 'paused'.
        // Instead, a durable _holdDeferred marker is written without changing status,
        // so the enrollment remains 'active' and is not permanently stuck.
        // The VFC-22 restoration sweep in OutboundControlService handles historically-stuck rows.
        {
          const { authorize } = await import("./outbound-pause-authority");
          const { canExecute } = await import("./outbound-queue-coordinator");
          const decision = await authorize({});
          const coordOk = decision.allowed ? await canExecute("sequences") : false;
          const isHeld = !decision.allowed || !coordOk;

          if (isHeld) {
            const holdReason = !decision.allowed
              ? `OutboundPauseAuthority blocked (${decision.reasonCode})`
              : "Coordinator hold active on 'sequences'";

            // Write durable deferral marker WITHOUT changing status (enrollment stays 'active')
            const enrollMeta = (enrollment.metadata as Record<string, unknown> | null) ?? {};
            const alreadyDeferred =
              enrollMeta._holdDeferredStep === currentStep &&
              enrollMeta._holdDeferredReason === holdReason;

            if (!alreadyDeferred) {
              await writeHoldDeferralMarker(
                enrollment.id,
                currentStep,
                holdReason,
                enrollMeta,
                // No injected dbInstance — uses global db (production path)
              );
              await storage.createAuditLog({
                action: "sequence_step_hold_deferred",
                entityType: "contact",
                entityId: enrollment.contactId ?? 0,
                actorType: "system",
                details: {
                  enrollmentId: enrollment.id,
                  sequenceId: sequence.id,
                  sequenceName: sequence.name,
                  currentStep,
                  holdReason,
                  reasonCode: decision.reasonCode,
                  coordBlocked: !coordOk,
                },
              });
            }
            // enrollment status stays 'active' — getActiveEnrollments() will pick it up again
            processed++;
            continue;
          }

          // If previously deferred but now unblocked, clear the deferral marker
          const enrollMeta = (enrollment.metadata as Record<string, unknown> | null) ?? {};
          if (enrollMeta._holdDeferredStep !== undefined) {
            const cleanMeta = { ...enrollMeta };
            delete cleanMeta._holdDeferredStep;
            delete cleanMeta._holdDeferredReason;
            delete cleanMeta._holdDeferredAt;
            await storage.updateSequenceEnrollment(enrollment.id, { metadata: cleanMeta });
          }
        }

        // Canonical reply-stop gate applies at step zero as well as later steps.
        // An unavailable communication_events read is a durable deferral, never
        // an implicit "no reply" authorization.
        if (await applyReplyDecision(enrollment, sequence, currentStep) === "stopped") {
          processed++;
          continue;
        }

        // A sequence with no steps has no outreach to complete. Treating
        // currentStep(0) >= 0 steps as "exhausted, no response" would record a
        // successful no-response outcome for work that never happened.
        if (steps.length === 0) {
          await storage.updateSequenceEnrollment(enrollment.id, {
            nextActionAt: new Date(Date.now() + 60 * 60 * 1000),
            metadata: {
              ...((enrollment.metadata as Record<string, unknown> | null) ?? {}),
              deferral: { reason: "SEQUENCE_HAS_NO_STEPS", currentStep },
            },
          });
          processed++;
          continue;
        }

        if (currentStep >= steps.length) {
          // Re-read at the no-response completion boundary to avoid completing
          // a contact whose reply raced this worker.
          if (await applyReplyDecision(enrollment, sequence, currentStep) === "stopped") {
            processed++;
            continue;
          }
          await completeNoResponseEnrollment(enrollment, sequence, currentStep);
          processed++;
          continue;
        }

        if (currentStep === 0 && enrollment.contactId) {
          // ── Pre-enrollment ZeroBounce validation ─────────────────────────────
          // Run ZB validation BEFORE the contactability check so that the check
          // sees the real ZB result rather than permanently blocking on the
          // 'unvalidated' (new default) or 'active' (legacy default) status.
          // This prevents new contacts from being permanently paused at Step 9.
          //
          // Only runs for email-typed step-0 sequences and only when the contact
          // hasn't been validated yet (null / 'active' / 'unvalidated').
          //
          // A missing/currently invalid validation observation is handled by the
          // durable provider-readiness queue below; there is no local credit cap.
          {
            const firstStep = steps.find(s => s.stepOrder === 1) ?? steps[0];
            if (firstStep?.actionType === "email") {
              const preEnrollContact = await storage.getContact(enrollment.contactId);
              const preEnrollStatus = preEnrollContact?.emailStatus;
              const needsZbValidation =
                preEnrollContact?.email &&
                (preEnrollStatus == null || preEnrollStatus === "active" || preEnrollStatus === "unvalidated");

              if (needsZbValidation) {
                // Retry delay: 1 hour. Keeps enrollment ACTIVE so the worker naturally
                // re-checks it on the next tick after nextActionAt passes.
                const ZB_RETRY_DELAY_MS = 60 * 60 * 1000;
                const { evaluateMarketingEmailEligibility, enqueueCurrentValidationIntent } = await import("./provider-readiness-control");
                const durableDecision = await evaluateMarketingEmailEligibility(preEnrollContact!.id);
                if (!durableDecision.allowed) {
                  await enqueueCurrentValidationIntent(preEnrollContact!.id).catch(() => {});
                  await storage.updateSequenceEnrollment(enrollment.id, {
                    nextActionAt: new Date(Date.now() + ZB_RETRY_DELAY_MS),
                  });
                  await storage.createAuditLog({
                    action: "sequence_enrollment_deferred_provider_readiness",
                    entityType: "contact",
                    entityId: enrollment.contactId,
                    actorType: "system",
                    details: {
                      enrollmentId: enrollment.id,
                      sequenceId: sequence.id,
                      sequenceName: sequence.name,
                      reason: durableDecision.reason,
                      retryAfter: new Date(Date.now() + ZB_RETRY_DELAY_MS).toISOString(),
                    },
                  });
                  processed++;
                  continue;
                }
                // Current evidence is already authoritative; wait for the
                // normal contact projection rather than invoking legacy inline
                // validation/credit code below.
                processed++;
                continue;
              }
            }
          }

          // Gate (a): Evaluate contactability before GHL workflow enrollment (automated outreach).
          // Use the first step's action type as the channel so that SMS-first sequences are
          // checked against SMS eligibility (not email eligibility). This prevents the email
          // Step 9 status check from blocking unvalidated contacts enrolled in SMS-first sequences,
          // where email is never the initial send channel and ZB validation fires per-step.
          {
            const { evaluateContactability } = await import("./contactability");
            const gateFirstStep = steps.find(s => s.stepOrder === 1) ?? steps[0];
            type ContactabilityChannel = "email" | "sms" | "voice_ai" | "ringless_vm" | "manual_call";
            const enrollChannel: ContactabilityChannel =
              gateFirstStep?.actionType === "sms" ? "sms" :
              gateFirstStep?.actionType === "voice_ai" ? "voice_ai" :
              gateFirstStep?.actionType === "ringless_vm" ? "ringless_vm" :
              "email"; // default to email for email steps and any unrecognized type
            const contactabilityCheck = await evaluateContactability({
              contactId: enrollment.contactId,
              channel: enrollChannel,
              campaignType: "sequence_enrollment",
              mode: "enforcement",
            });
            if (!contactabilityCheck.allowed) {
              await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
              await storage.createAuditLog({
                action: "sequence_enrollment_blocked_contactability",
                entityType: "contact",
                entityId: enrollment.contactId,
                actorType: "system",
                details: {
                  sequenceId: sequence.id,
                  sequenceName: sequence.name,
                  channel: "email",
                  reason: contactabilityCheck.reason,
                  consentTier: contactabilityCheck.consentTier,
                  lifecycleStage: contactabilityCheck.lifecycleStage,
                },
              });
              processed++;
              continue;
            }
          }

          const triggerConfig = (sequence.triggerConfig as any) || {};
          // outboundChannels from triggerConfig allows per-sequence channel declaration.
          // When not set in triggerConfig, defaults to fail-closed (all automated channels).
          // Email-only sequences should set triggerConfig.outboundChannels = ["email"].
          const enrollResult = await enrollContactInGhlWorkflow({
            contactId: enrollment.contactId,
            sequenceName: sequence.name,
            sequenceId: sequence.id,
            vertical: triggerConfig.vertical,
            dealId: enrollment.dealId || undefined,
            outboundChannels: triggerConfig.outboundChannels,
          });

          // NOTE: enrollResult.method === "ghl_workflow" can never occur after the
          // architecture refactor in ghl-workflow-enrollment.ts. enrollContactInGhlWorkflow()
          // always returns method:"replit_direct" — it syncs the contact to GHL (upsert +
          // tags + note) but never triggers a GHL native workflow for outbound sequences.
          // Sequence orchestration stays entirely in Replit. See the architecture boundary
          // comment block at the top of this file and in ghl-workflow-enrollment.ts.

          if (enrollResult.method === "skipped") {
            await storage.updateSequenceEnrollment(enrollment.id, {
              status: "paused",
            });
            await storage.createAuditLog({
              action: "sequence_enrollment_skipped",
              entityType: "contact",
              entityId: enrollment.contactId,
              details: {
                sequenceId: sequence.id,
                sequenceName: sequence.name,
                reason: enrollResult.reason,
              },
            });
            processed++;
            continue;
          }

          if (enrollResult.contactGhlId) {
            const triggerConfig = (sequence.triggerConfig as any) || {};
            tagContactForInboxOrganization({
              contactId: enrollment.contactId,
              ghlContactId: enrollResult.contactGhlId,
              sequenceName: sequence.name,
              vertical: triggerConfig.vertical,
            }).catch(err => console.warn("[Sequence Worker] Inbox tagging failed:", err));
          }

          if (GHL_WORKFLOW_ONLY) {
            await storage.updateSequenceEnrollment(enrollment.id, {
              status: "paused",
            });
            await storage.createAuditLog({
              action: "sequence_direct_send_blocked",
              entityType: "contact",
              entityId: enrollment.contactId,
              details: {
                sequenceId: sequence.id,
                sequenceName: sequence.name,
                reason: "GHL_WORKFLOW_ONLY_MODE enabled — direct sends disabled",
                enrollResult: enrollResult.reason,
              },
            });
            processed++;
            continue;
          }

          if (
            enrollResult.method === "replit_direct" &&
            !enrollResult.contactGhlId &&
            enrollResult.reason !== "GHL not configured — falling back to Replit direct sends"
          ) {
            await storage.updateSequenceEnrollment(enrollment.id, {
              status: "paused",
            });
            await storage.createAuditLog({
              action: "sequence_direct_send_blocked",
              entityType: "contact",
              entityId: enrollment.contactId,
              details: {
                sequenceId: sequence.id,
                sequenceName: sequence.name,
                reason: "GHL contact ID not confirmed — direct sends blocked until GHL sync succeeds",
                enrollResult: enrollResult.reason,
              },
            });
            processed++;
            continue;
          }
        }

        const step = steps.find(s => s.stepOrder === currentStep + 1) || steps[currentStep];
        if (!step) {
          if (await applyReplyDecision(enrollment, sequence, currentStep) === "stopped") {
            processed++;
            continue;
          }
          await completeNoResponseEnrollment(enrollment, sequence, currentStep);
          processed++;
          continue;
        }

        // ── Gate (daily-cap): Cold outreach email daily send cap ───────────────
        // Fast-path read: if counter is already at/above cap, defer immediately
        // without attempting GHL enrollment or send. The actual atomic reservation
        // (which prevents race-condition overshoot) happens below, inside the
        // isGhlConfigured() block — only when a real send is about to occur.
        // Both checks read the same DB row; the fast-path is purely an optimisation
        // to skip all the downstream work when the cap is visibly exhausted.
        // Warmup mode overrides the configured cap with a ramp schedule (cannot
        // be manually raised while warmup is active — safety property).
        if (step.actionType === "email" && isColdOutreachSequence(sequence)) {
          const { db: capDb } = await import("../db");
          const { outboundSendCounters } = await import("@shared/schema");
          const { eq, and } = await import("drizzle-orm");

          const capRaw = await storage.getSystemSetting("outboundDailyEmailCap");
          let dailyCap = typeof capRaw === "number" ? capRaw : parseInt(String(capRaw ?? "200"), 10) || 200;

          // Warmup mode: override cap with ramp schedule (day 1→20, day7→50, day14→100, day30→250)
          const warmupEnabledRaw = await storage.getSystemSetting("deliveryWarmupEnabled");
          if (warmupEnabledRaw === true || warmupEnabledRaw === "true") {
            const warmupStartDateRaw = await storage.getSystemSetting("deliveryWarmupStartDate");
            if (typeof warmupStartDateRaw === "string" && warmupStartDateRaw) {
              const daysSince = Math.max(1, Math.floor((Date.now() - new Date(warmupStartDateRaw).getTime()) / 86400000) + 1);
              let warmupCap: number;
              if (daysSince >= 30) warmupCap = 250;
              else if (daysSince >= 14) warmupCap = 100;
              else if (daysSince >= 7) warmupCap = 50;
              else warmupCap = 20;
              // Warmup cap cannot be overridden upward — take the lower value
              dailyCap = Math.min(dailyCap, warmupCap);
            }
          }

          const todayStr = new Date().toISOString().slice(0, 10);
          const [capRow] = await capDb
            .select({ count: outboundSendCounters.count })
            .from(outboundSendCounters)
            .where(and(
              eq(outboundSendCounters.date, todayStr),
              eq(outboundSendCounters.channel, "email"),
              eq(outboundSendCounters.scope, "cold_outreach"),
            ));
          const sendsToday = capRow?.count ?? 0;

          if (sendsToday >= dailyCap) {
            const enrollMeta = (enrollment.metadata as Record<string, unknown> | null) ?? {};
            const alreadyDeferred =
              enrollMeta._capDeferStep === step.stepOrder &&
              enrollMeta._capDeferDate === todayStr;
            if (!alreadyDeferred) {
              await storage.updateSequenceEnrollment(enrollment.id, {
                status: "paused",
                metadata: { ...enrollMeta, _capDeferStep: step.stepOrder, _capDeferDate: todayStr },
              });
              await storage.createAuditLog({
                action: "sequence_step_deferred_daily_cap",
                entityType: "contact",
                entityId: enrollment.contactId ?? 0,
                actorType: "system",
                details: {
                  enrollmentId: enrollment.id,
                  sequenceId: sequence.id,
                  sequenceName: sequence.name,
                  stepOrder: step.stepOrder,
                  sendsToday,
                  dailyCap,
                  todayStr,
                },
              });
            } else {
              await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
            }
            processed++;
            continue;
          }
        }

        // Contact redirects are resolved only at a live delivery boundary.
        // Historical reads intentionally keep their original contact IDs.
        if (enrollment.contactId) {
          const {
            CONTACT_MERGE_EFFECT_HOLD_REASON,
            resolveLiveContactRedirect,
          } = await import("./contact-identity");
          const redirect = await resolveLiveContactRedirect(enrollment.contactId);
          const resolvedContactId = redirect.effectiveContactId;
          if (redirect.effectHold) {
            const enrollMeta = (enrollment.metadata as Record<string, unknown> | null) ?? {};
            const holdReason = CONTACT_MERGE_EFFECT_HOLD_REASON;
            const alreadyDeferred =
              enrollMeta._holdDeferredStep === currentStep
              && enrollMeta._holdDeferredReason === holdReason;
            await storage.updateSequenceEnrollment(enrollment.id, {
              nextActionAt: new Date(Date.now() + 5 * 60 * 1000),
              metadata: {
                ...enrollMeta,
                _holdDeferredStep: currentStep,
                _holdDeferredReason: holdReason,
                _holdDeferredAt: new Date().toISOString(),
              },
            });
            if (!alreadyDeferred) {
              await storage.createAuditLog({
                action: "sequence_step_merge_handoff_deferred",
                entityType: "contact",
                entityId: resolvedContactId,
                actorType: "system",
                details: {
                  enrollmentId: enrollment.id,
                  sequenceId: sequence.id,
                  currentStep,
                  reason: holdReason,
                  redirectOperationIds: redirect.effectHoldOperationIds,
                },
              });
            }
            processed++;
            continue;
          }
          // Keep the deprecated ID as redirect provenance while a temporary
          // handoff hold is active. Move the enrollment only after the hold
          // clears so every retry tick must rediscover and honor that hold.
          if (resolvedContactId !== enrollment.contactId) {
            await storage.updateSequenceEnrollment(enrollment.id, { contactId: resolvedContactId });
            enrollment.contactId = resolvedContactId;
          }
        }
        let contact: any = null;
        if (enrollment.contactId) {
          contact = await storage.getContact(enrollment.contactId);
          // Bounce guard: skip email steps for bounced/invalid/unsafe contacts.
          // "unsafe" covers ZeroBounce-flagged spam traps, abuse addresses, and do_not_mail —
          // including contacts that were validated by the batch/manual route before this send.
          if (contact && contact.emailStatus && ZB_UNDELIVERABLE.has(contact.emailStatus)) {
            await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
            await storage.createAuditLog({
              action: "sequence_enrollment_skipped_bad_email",
              entityType: "contact",
              entityId: enrollment.contactId,
              actorType: "system",
              details: {
                enrollmentId: enrollment.id,
                sequenceId: sequence.id,
                sequenceName: sequence.name,
                emailStatus: contact.emailStatus,
                reason: `Contact email status is '${contact.emailStatus}' — enrollment paused`,
              },
            });
            processed++;
            continue;
          }

          // ── ZeroBounce lazy validation gate ────────────────────────────────
          // Fire once per contact, only for email steps, when emailStatus is unknown.
          // Writes the result back to contacts.email_status so we never re-spend credits.
          //
          // Unvalidated addresses remain deferred until current provider evidence
          // is available; no local credit ceiling is applied here.
          // This path is reached for steps beyond step 0 (or sequences that begin
          // with a non-email step); the pre-enrollment gate covers step 0.
          if (
            contact &&
            step &&
            step.actionType === "email" &&
            (contact.emailStatus == null || contact.emailStatus === "active" || contact.emailStatus === "unvalidated")
          ) {
            const ZB_RETRY_MS = 60 * 60 * 1000; // 1 hour
            const { evaluateMarketingEmailEligibility, enqueueCurrentValidationIntent } = await import("./provider-readiness-control");
            const durableDecision = await evaluateMarketingEmailEligibility(contact.id);
            if (!durableDecision.allowed) {
              await enqueueCurrentValidationIntent(contact.id).catch(() => {});
              await storage.updateSequenceEnrollment(enrollment.id, {
                nextActionAt: new Date(Date.now() + ZB_RETRY_MS),
              });
              processed++;
              continue;
            }
            // A current durable observation exists; do not fall through to the
            // retired inline ZeroBounce/credit-claim lane.
            processed++;
            continue;
            if (contact.email) {
              try {
                const zbResult = { status: "unknown", subStatus: null, outcome: "unavailable", reason: "durable_intent_required", skipped: true };
                // Project only completed evidence for the current token.
                const { db: zbDb } = await import("../db");
                const { sql: zbSql } = await import("drizzle-orm");
                if (zbResult.outcome === "completed" && !zbResult.reason) {
                  await zbDb.execute(zbSql`
                    UPDATE contacts
                    SET email_status = ${zbResult.status},
                        email_token_hash = ${hashEmailToken(contact.email)},
                        email_validation_updated_at = NOW()
                    WHERE id = ${contact.id}
                  `);
                  contact = { ...contact, emailStatus: zbResult.status };
                }

                await storage.createAuditLog({
                  action: "zerobounce_email_validated",
                  entityType: "contact",
                  entityId: contact.id,
                  actorType: "system",
                  details: {
                    enrollmentId: enrollment.id,
                    sequenceId: sequence.id,
                    emailTokenHash: hashEmailToken(contact.email),
                    zbStatus: zbResult.status,
                    zbSubStatus: zbResult.subStatus ?? null,
                    skipped: zbResult.skipped ?? false,
                  },
                });

                // A timeout, unknown, catch-all, or other non-positive result
                // cannot fall through into a marketing sequence send.
                if (zbResult.status !== "valid" || zbResult.outcome !== "completed" || zbResult.reason) {
                  const terminal = ZB_UNDELIVERABLE.has(zbResult.status) || zbResult.status === "unverified";
                  await storage.updateSequenceEnrollment(enrollment.id, terminal
                    ? { status: "paused" }
                    : { nextActionAt: new Date(Date.now() + ZB_RETRY_MS) });
                  await storage.createAuditLog({
                    action: terminal ? "sequence_step_blocked_email_nonpositive" : "sequence_step_deferred_zb_unavailable",
                    entityType: "contact",
                    entityId: contact.id,
                    actorType: "system",
                    details: {
                      enrollmentId: enrollment.id,
                      sequenceId: sequence.id,
                      sequenceName: sequence.name,
                      emailTokenHash: hashEmailToken(contact.email),
                      zbStatus: zbResult.status,
                      zbSubStatus: zbResult.subStatus ?? null,
                      reason: "ZeroBounce did not produce positive current evidence",
                    },
                  });
                  processed++;
                  continue;
                }
              } catch (zbErr) {
                console.warn(`[SequenceWorker] ZeroBounce validation error for contact ${contact.id}:`, (zbErr as Error).message);
                await storage.updateSequenceEnrollment(enrollment.id, {
                  nextActionAt: new Date(Date.now() + ZB_RETRY_MS),
                });
                processed++;
                continue;
              }
            }
          }

          // ── SMS-step consent skip ──────────────────────────────────────────
          // When the current step is SMS and the contact is not eligible for SMS
          // outreach (i.e. evaluateContactability returns !allowed for the "sms"
          // channel), skip THIS STEP and advance to the next — do NOT pause the
          // enrollment.  Cold contacts enrolled in mixed email+SMS sequences (e.g.
          // SDR Outbound) continue receiving email steps; SMS steps resume
          // automatically once the contact completes PEWC (consentTier advances to
          // pewc_full_automation).  Contacts that ARE eligible fall through to the
          // normal SMS send path below.
          //
          // Note: hard blocks (DNC, opt-out, hard-bounce, complaint) are caught
          // earlier by the suppression gate and pause the enrollment before we ever
          // reach this check, so anything failing here is purely a consent-tier
          // (soft) block that is safe to skip.
          if (contact && step && step.actionType === "sms" && enrollment.contactId) {
            const { evaluateContactability: evalSmsContactability } = await import("./contactability");
            const smsCheck = await evalSmsContactability({
              contactId: enrollment.contactId,
              channel: "sms",
              campaignType: "sequence_step",
              mode: "enforcement",
            });
            // Only skip-and-advance for consent-tier blocks (no PEWC).
            // Non-consent failures (quiet hours, feature flag off, invalid phone,
            // carrier blocks, etc.) fall through to Gate (b) below, which applies
            // the normal per-step pause so the step can be retried later.
            const SMS_CONSENT_SOFT_TIERS = new Set(["cold_no_consent", "warm_no_pewc"]);
            const isSmsConsentBlock = !smsCheck.allowed && SMS_CONSENT_SOFT_TIERS.has(smsCheck.consentTier);
            if (isSmsConsentBlock) {
              await storage.createAuditLog({
                action: "sequence_step_skipped_sms_no_consent",
                entityType: "contact",
                entityId: enrollment.contactId,
                actorType: "system",
                details: {
                  enrollmentId: enrollment.id,
                  sequenceId: sequence.id,
                  sequenceName: sequence.name,
                  stepOrder: step.stepOrder,
                  consentTier: smsCheck.consentTier,
                  reason: smsCheck.reason ?? "SMS step skipped — PEWC consent not collected for this contact",
                },
              });
              // Advance to the next step
              const skipNextIndex = currentStep + 1;
              const skipSortedSteps = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
              const skipNextStep = skipSortedSteps[skipNextIndex];
              if (!skipNextStep) {
                if (await applyReplyDecision(enrollment, sequence, currentStep) === "stopped") {
                  processed++;
                  continue;
                }
                await completeNoResponseEnrollment(enrollment, sequence, skipNextIndex, "sms_skipped_no_response");
              } else {
                const skipDelayMs = ((skipNextStep.delayDays || 0) * 86400000) + ((skipNextStep.delayHours || 0) * 3600000);
                const skipNextActionAt = new Date(Date.now() + Math.max(skipDelayMs, 60000));
                await storage.updateSequenceEnrollment(enrollment.id, {
                  currentStep: skipNextIndex,
                  nextActionAt: skipNextActionAt,
                });
              }
              processed++;
              continue;
            }
          }

          // ── Suppression gate: compliance fields pre-send check ──────────────
          // Reads new compliance/suppression fields and blocks if contact is
          // opted-out, unsubscribed, hard-bounced, or complained.
          // NOTE: SMS consent is handled above as a per-step skip — it is
          // intentionally NOT included here to avoid pausing the enrollment.
          if (contact) {
            const suppressionReasons: string[] = [];
            const c = contact as any;

            if (c.optOutStatus === "opted_out") suppressionReasons.push(`opt_out_status=opted_out (channel: ${c.optOutChannel ?? "unknown"})`);
            if (c.unsubscribeStatus === "unsubscribed") suppressionReasons.push("unsubscribe_status=unsubscribed");
            if (c.bounceStatus === "hard") suppressionReasons.push(`bounce_status=hard (${c.bounceReason ?? "no reason recorded"})`);
            if (c.complaintStatus === "reported") suppressionReasons.push("complaint_status=reported");

            if (suppressionReasons.length > 0) {
              const reason = suppressionReasons.join("; ");
              await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
              await storage.createAuditLog({
                action: "sequence_enrollment_suppressed",
                entityType: "contact",
                entityId: enrollment.contactId,
                actorType: "system",
                details: {
                  enrollmentId: enrollment.id,
                  sequenceId: sequence.id,
                  sequenceName: sequence.name,
                  reason,
                  suppressionFields: suppressionReasons,
                },
              });
              processed++;
              continue;
            }

            // ── Communication arbitration: rep-touch / auto-send cooldown ────
            // Runs after hard compliance blocks (above) but before the send.
            // Skips transactional/operations steps — only cold/sales sequences.
            const seqCategory = (sequence as any).triggerConfig?.category ?? "";
            const isAutomatedOutreach = !["operations", "support", "onboarding", "education"].includes(seqCategory);
            if (isAutomatedOutreach && enrollment.contactId) {
              try {
                const arbitrationChannel = (step as any)?.actionType === "sms" ? "sms"
                  : (step as any)?.actionType === "ringless_vm" ? "ringless_vm"
                  : (step as any)?.actionType === "voice_call" ? "voice"
                  : "email";
                const { shouldSuppress: arbCheck, logArbitrationSuppression } = await import("./communication-arbitration");
                const arb = await arbCheck(enrollment.contactId, arbitrationChannel);
                if (arb.suppressed) {
                  await logArbitrationSuppression(enrollment.contactId, arbitrationChannel, arb);
                  // Pause the step (not the whole enrollment) by pushing nextActionAt forward
                  const resumeAt = arb.resumeAfter ?? new Date(Date.now() + 60 * 60 * 1000);
                  await storage.updateSequenceEnrollment(enrollment.id, { nextActionAt: resumeAt });
                  await storage.createAuditLog({
                    action: "sequence_step_deferred_arbitration",
                    entityType: "contact",
                    entityId: enrollment.contactId,
                    actorType: "system",
                    details: {
                      enrollmentId: enrollment.id,
                      sequenceId: sequence.id,
                      sequenceName: sequence.name,
                      channel: arbitrationChannel,
                      reason: arb.reason,
                      resumeAfter: resumeAt.toISOString(),
                    },
                  });
                  processed++;
                  continue;
                }
              } catch (arbErr) {
                // Never convert an arbitration outage into send authorization.
                const resumeAt = new Date(Date.now() + 60 * 60 * 1000);
                await storage.updateSequenceEnrollment(enrollment.id, {
                  nextActionAt: resumeAt,
                  metadata: {
                    ...((enrollment.metadata as Record<string, unknown> | null) ?? {}),
                    deferral: { reason: "arbitration_unavailable", currentStep },
                  },
                });
                await storage.createAuditLog({
                  action: "sequence_step_deferred_arbitration_error",
                  entityType: "contact",
                  entityId: enrollment.contactId,
                  actorType: "system",
                  details: { enrollmentId: enrollment.id, sequenceId: sequence.id, stepOrder: step.stepOrder, reason: (arbErr as Error).message, resumeAfter: resumeAt.toISOString() },
                });
                processed++;
                continue;
              }
            }
          }
        }

        let deal: any = null;
        if (enrollment.dealId) {
          deal = await storage.getDeal(enrollment.dealId);
        }

        const rawFirstName = contact?.firstName ?? "";
        const firstName = sanitizeFirstName(rawFirstName) || "there";
        if (rawFirstName && firstName === "there") {
          console.warn(`[Sequence Worker] Contact ${contact?.id} has unsendable first_name "${rawFirstName}" — substituting "there"`);
        }
        const lastName = contact?.lastName || "";
        const companyName = contact?.companyName || "your business";
        const email = contact?.email || "";

        const industry = contact?.vertical || "your industry";
        const monthlyVolume = contact?.monthlyVolume || "N/A";
        const currentProcessor = contact?.currentProvider || "your current processor";
        const estimatedSavings = contact?.estimatedResidual
          ? `$${Math.round(Number(contact.estimatedResidual) * 12).toLocaleString()}`
          : "significant savings";
        const recommendedProgram = contact?.primaryOfferPath || "Wholesale";
        const recommendedTerminal = deal?.terminalRecommendation || "Clover Flex 3";

        const serviceType = contact?.vertical || industry;
        const estimatedVolume = contact?.monthlyVolume || monthlyVolume;
        let agentName = "Liberty Bancard";
        let agentEmail = "Scott@mail.libertybancard.com";
        let agentPhone = "954-266-8214";
        if (contact?.agentId) {
          try {
            const assignedAgent = await storage.getAgent(contact.agentId);
            if (assignedAgent) {
              const fullName = [assignedAgent.firstName, assignedAgent.lastName].filter(Boolean).join(" ");
              if (fullName) agentName = fullName;
              if ((assignedAgent as any).email) agentEmail = (assignedAgent as any).email;
              if ((assignedAgent as any).phone) agentPhone = (assignedAgent as any).phone;
            }
          } catch {
            // fallback to defaults
          }
        }

        // businessName is the same concept as companyName — alias for template compat
        const businessName = companyName;

        const calendarLink =
          process.env.GHL_CALENDAR_BOOKING_URL ||
          (process.env.GHL_DEFAULT_CALENDAR_ID
            ? `https://api.leadconnectorhq.com/widget/booking/${process.env.GHL_DEFAULT_CALENDAR_ID}`
            : "https://api.leadconnectorhq.com/widget/booking/YFiIy7oIOUXN2qZZPnOr");

        const interpolate = (text: string | null | undefined): string => {
          if (!text) return "";
          const result = text
            .replace(/\{\{firstName\}\}/g, firstName)
            .replace(/\{\{lastName\}\}/g, lastName)
            .replace(/\{\{companyName\}\}/g, companyName)
            .replace(/\{\{email\}\}/g, email)
            .replace(/\{\{contact\.firstName\}\}/g, firstName)
            .replace(/\{\{contact\.lastName\}\}/g, lastName)
            .replace(/\{\{contact\.companyName\}\}/g, companyName)
            .replace(/\{\{industry\}\}/g, industry)
            .replace(/\{\{monthlyVolume\}\}/g, monthlyVolume)
            .replace(/\{\{currentProcessor\}\}/g, currentProcessor)
            .replace(/\{\{estimatedSavings\}\}/g, estimatedSavings)
            .replace(/\{\{recommendedProgram\}\}/g, recommendedProgram)
            .replace(/\{\{recommendedTerminal\}\}/g, recommendedTerminal)
            .replace(/\{\{serviceType\}\}/g, serviceType)
            .replace(/\{\{estimatedVolume\}\}/g, estimatedVolume)
            .replace(/\{\{agentName\}\}/g, agentName)
            .replace(/\{\{agentEmail\}\}/g, agentEmail)
            .replace(/\{\{agentPhone\}\}/g, agentPhone)
            .replace(/\{\{businessName\}\}/g, businessName)
            .replace(/\{\{calendarLink\}\}/g, calendarLink)
            .replace(/\{\{contact\.vertical\}\}/g, industry)
            .replace(/\{\{vertical\}\}/g, industry);
          // Safety net: warn (and block for sensitive placeholders) if raw
          // {{...}} template syntax survived substitution (#1136).
          const remaining = result.match(/\{\{[^}]+\}\}/g);
          if (remaining) {
            const SENSITIVE = /\{\{agentEmail\}\}|\{\{agentPhone\}\}|\{\{agent\w+\}\}/;
            const hasSensitive = remaining.some(p => SENSITIVE.test(p));
            if (hasSensitive) {
              // Hard block — a sensitive placeholder (agent contact info) survived.
              // Sending this would expose raw template syntax to the prospect.
              console.error(
                `[Sequence Worker] BLOCKED outbound — sensitive unresolved placeholder(s) ` +
                `(enrollment ${enrollment.id}, step ${step.stepOrder}, contact ${enrollment.contactId}): ` +
                remaining.filter(p => SENSITIVE.test(p)).join(", ")
              );
              throw new Error(
                `Outbound blocked: unresolved sensitive placeholder(s) ${remaining.filter(p => SENSITIVE.test(p)).join(", ")} ` +
                `in enrollment ${enrollment.id} step ${step.stepOrder}`
              );
            }
            // Unknown placeholders are never a cosmetic concern at the delivery
            // boundary: sending them makes a broken template look successful.
            throw new Error(
              `Outbound blocked: unresolved template placeholder(s) ${remaining.join(", ")} ` +
              `in enrollment ${enrollment.id} step ${step.stepOrder}`,
            );
          }
          return result;
        };

        // SFP launch steps use the shared deterministic renderer, the sender-policy
        // identity (never the contact's assigned rep) and a single sign-off.
        const sfpLaunchStep =
          String(sequence.sequenceFamily ?? "").startsWith(SFP_LAUNCH_SEQUENCE_FAMILY_PREFIX) &&
          (step.config as Record<string, unknown> | null)?.format === "plain_text";
        const sfpContext = sfpLaunchRenderContext(contact);
        const renderSfpSubject = (text: string | null | undefined) => renderSfpLaunchSubject(text, sfpContext);
        const renderSfpBodyHtml = (text: string | null | undefined) => renderSfpLaunchBodyHtml(text, sfpContext);

        let stepExecuted = false;

        // Gate (b): Evaluate contactability before any automated send/trigger dispatch
        {
          type AutomatedActionChannel = "email" | "sms" | "voice_ai" | "ringless_vm" | "manual_call";
          const automatedChannelMap: Record<string, AutomatedActionChannel> = {
            email: "email",
            sms: "sms",
            call: "voice_ai",
            voicemail_drop: "ringless_vm",
            // "task" steps create a CRM task only — no call, no AI voice, no RVM.
            // They are gated via manual_call to block opted-out/DNC contacts after enrollment.
            task: "manual_call",
          };
          const automatedChannel = automatedChannelMap[step.actionType];
          if (automatedChannel && enrollment.contactId) {
            const { evaluateContactability } = await import("./contactability");
            const contactabilityCheck = await evaluateContactability({
              contactId: enrollment.contactId,
              channel: automatedChannel,
              campaignType: "sequence_step",
              mode: "enforcement",
            });
            if (!contactabilityCheck.allowed) {
              await storage.createAuditLog({
                action: "sequence_step_blocked_contactability",
                entityType: "contact",
                entityId: enrollment.contactId,
                actorType: "system",
                details: {
                  enrollmentId: enrollment.id,
                  sequenceId: sequence.id,
                  sequenceName: sequence.name,
                  stepOrder: step.stepOrder,
                  actionType: step.actionType,
                  channel: automatedChannel,
                  reason: contactabilityCheck.reason,
                  consentTier: contactabilityCheck.consentTier,
                  lifecycleStage: contactabilityCheck.lifecycleStage,
                },
              });
              import("./analytics-events").then(({ recordAnalyticsEvent }) => {
                recordAnalyticsEvent({
                  eventName: "sequence_step_blocked",
                  contactId: enrollment.contactId ?? undefined,
                  sequenceId: sequence.id,
                  channel: automatedChannel,
                  blockReason: contactabilityCheck.reason,
                  consentTier: contactabilityCheck.consentTier,
                  lifecycleStage: contactabilityCheck.lifecycleStage,
                  metadata: { stepOrder: step.stepOrder, actionType: step.actionType, sequenceName: sequence.name },
                });
              }).catch(() => {});
              await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
              processed++;
              continue;
            }
          }
        }

        // Last possible reply decision before any step dispatch (email, SMS,
        // voice/RVM workflow, or task). This closes the race with inbound
        // ingestion after the earlier gate.
        if (await applyReplyDecision(enrollment, sequence, currentStep) === "stopped") {
          processed++;
          continue;
        }

        switch (step.actionType) {
          case "email": {
            const abConfig = (step.abTestConfig as AbTestConfig | null);
            const abEnabled = !!(step.variantBSubject || step.variantBBody);

            const existing = (step.abTestResults as Partial<AbTestResults> | null) ?? {};
            const currentWinner: string | null = existing.winnerSelected ?? null;

            let chosenVariant: "A" | "B" = "A";
            let subjectToSend = step.subject;
            let bodyToSend = step.body;

            if (abEnabled) {
              if (currentWinner) {
                chosenVariant = currentWinner as "A" | "B";
              } else {
                chosenVariant = await getOrCreateSequenceAbAssignment({
                  enrollmentId: enrollment.id, stepId: step.id, splitRatio: abConfig?.splitRatio ?? 50,
                  config: { abConfig, subjectA: step.subject, bodyA: step.body, subjectB: step.variantBSubject, bodyB: step.variantBBody },
                  eligibilitySnapshot: { contactId: enrollment.contactId, sequenceId: sequence.id, stepId: step.id, lifecycleState: contact?.lifecycleState ?? null, consentTier: contact?.consentTier ?? null, recordClass: contact?.recordClass ?? "unknown" },
                });
              }
              if (chosenVariant === "B") {
                subjectToSend = step.variantBSubject ?? step.subject;
                bodyToSend = step.variantBBody ?? step.body;
              }
            }

            const sigType = resolveSignatureType((sequence.triggerConfig as any) || {});
            const emailBody = sfpLaunchStep
              ? renderSfpBodyHtml(bodyToSend)
              : interpolate(bodyToSend) + getEmailSignatureHtml(sigType);

            // ── Per-channel pause gate (email) ────────────────────────────────
            // Checked after global pause (already verified above) and contactability.
            // emailChannelPaused = all email; coldEmailChannelPaused = cold only.
            // FAIL-CLOSED: null/undefined (unset) → paused. Only explicit "false"
            // (string or boolean) releases the channel.
            {
              const emailPausedRaw = await storage.getSystemSetting("emailChannelPaused");
              const emailPaused = emailPausedRaw !== "false" && emailPausedRaw !== false;
              if (emailPaused) {
                await storage.createAuditLog({
                  action: "sequence_step_skipped_channel_pause",
                  entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
                  details: { enrollmentId: enrollment.id, sequenceId: sequence.id, channel: "email", reason: "emailChannelPaused" },
                });
                // A released journey is deferred in place (still active, same step); a channel pause must not strand it.
                await storage.updateSequenceEnrollment(enrollment.id, canonicalReleaseAdmitted
                  ? { nextActionAt: new Date(Date.now() + 15 * 60 * 1000) } : { status: "paused" });
                processed++; stepExecuted = false; break;
              }
              if (isColdOutreachSequence(sequence)) {
                const coldPausedRaw = await storage.getSystemSetting("coldEmailChannelPaused");
                const coldPaused = coldPausedRaw !== "false" && coldPausedRaw !== false;
                if (coldPaused) {
                  await storage.createAuditLog({
                    action: "sequence_step_skipped_channel_pause",
                    entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
                    details: { enrollmentId: enrollment.id, sequenceId: sequence.id, channel: "cold_email", reason: "coldEmailChannelPaused" },
                  });
                  await storage.updateSequenceEnrollment(enrollment.id, canonicalReleaseAdmitted
                    ? { nextActionAt: new Date(Date.now() + 15 * 60 * 1000) } : { status: "paused" });
                  processed++; stepExecuted = false; break;
                }
              }
            }

            // ── Idempotency gate (email) ──────────────────────────────────────
            // seq-{enrollmentId}-s{stepOrder} is permanently unique per enrollment.
            // If the step was already successfully sent (e.g. after a crash retry),
            // skip the network call and advance enrollment normally.
            const emailIdemKey = buildIdempotencyKey(enrollment.id, step.stepOrder ?? 0);
            if (await hasSentStep(emailIdemKey)) {
              console.warn(`[Sequence Worker] Email step already sent (idempotent skip): ${emailIdemKey}`);
              stepExecuted = true;
              break;
            }

            // ── Channel selection ─────────────────────────────────────────────
            // Gmail OAuth  → staff/department (non-cold) when connected
            // SMTP         → cold outreach when configured (needs List-Unsubscribe header)
            // GHL          → cold outreach ONLY (Scott@mail.libertybancard.com)
            //
            // CRITICAL: Non-cold sequences MUST send via Gmail OAuth.
            // If Gmail is unavailable, block the send — do NOT fall through to GHL.
            // GHL sends from a cold-outreach domain; mixing department email through
            // that domain silently sends from the wrong address and wrong brand.
            const isColdEmail = isColdOutreachSequence(sequence);
            const useGmailForThisStep = !isColdEmail && (await isGmailOAuthConnected()) && !!contact?.email;
            const useSmtpForThisStep  = isColdEmail && isSmtpConfigured() && !!contact?.email;

            // SFP launch sends have exactly one certified transport (SMTP, which
            // carries the signed List-Unsubscribe headers). If it is unavailable the
            // step is deferred; it never silently falls back to GHL.
            if (sfpLaunchStep && !useSmtpForThisStep) {
              await storage.createAuditLog({
                action: "sequence_step_deferred_transport_unavailable",
                entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
                details: { enrollmentId: enrollment.id, sequenceId: sequence.id, stepOrder: step.stepOrder, reason: "SFP_SMTP_TRANSPORT_REQUIRED", smtpConfigured: isSmtpConfigured() },
              });
              await storage.updateSequenceEnrollment(enrollment.id, { nextActionAt: new Date(Date.now() + 15 * 60 * 1000) });
              processed++; stepExecuted = false; break;
            }

            // Gmail unavailable for non-cold sequence → BLOCK, do not fall through to GHL
            if (!isColdEmail && !useGmailForThisStep) {
              const gmailBlockReason = !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET
                ? "Gmail OAuth secrets (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) not configured"
                : !process.env.CREDENTIAL_ENCRYPTION_KEY
                ? "CREDENTIAL_ENCRYPTION_KEY not set — Gmail token cannot be decrypted"
                : "Gmail OAuth not connected (complete OAuth flow at /dashboard/outbound-readiness)";
              console.warn(`[Sequence Worker] Non-cold email blocked — Gmail unavailable for enrollment ${enrollment.id}: ${gmailBlockReason}`);
              await storage.createAuditLog({
                action: "sequence_step_blocked_gmail_unavailable",
                entityType: "contact",
                entityId: enrollment.contactId ?? 0,
                actorType: "system",
                details: {
                  enrollmentId: enrollment.id,
                  sequenceId: sequence.id,
                  sequenceName: sequence.name,
                  stepOrder: step.stepOrder,
                  reason: gmailBlockReason,
                  blockedAt: new Date().toISOString(),
                },
              });
              await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
              processed++;
              stepExecuted = false;
              break;
            }

            // ── Gate (no-prospect-send): Test mode guard ─────────────────────
            // When deliveryNoProspectSendEmail is true, only allowlisted test addresses
            // can receive sends. Designed to be default-on before go-live, so accidental
            // sends to real prospects during testing are impossible.
            //
            // FAIL-CLOSED: guard runs unconditionally for all email step types.
            // If the guard is active and the contact has no resolvable email (including
            // when GHL would dispatch via contactId alone), we block the send — we never
            // let an unverifiable recipient slip through to any provider.
            {
              const noProspectRaw = await storage.getSystemSetting("deliveryNoProspectSendEmail");
              const noProspectGuard = noProspectRaw === true || noProspectRaw === "true";
              if (noProspectGuard) {
                const allowlistRaw = await storage.getSystemSetting("deliveryTestEmailAllowlist");
                const allowlist: string[] = typeof allowlistRaw === "string"
                  ? allowlistRaw.split(",").map((e: string) => e.trim().toLowerCase()).filter(Boolean)
                  : [];
                // Fail closed: no email on contact record → cannot verify → block.
                const recipientEmail = contact?.email?.toLowerCase() ?? "";
                const isAllowed = recipientEmail.length > 0 &&
                  (allowlist.includes(recipientEmail) || recipientEmail.endsWith("@libertybancard.com"));
                if (!isAllowed) {
                  await storage.createAuditLog({
                    action: "sequence_step_blocked_no_prospect_guard",
                    entityType: "contact",
                    entityId: enrollment.contactId ?? 0,
                    actorType: "system",
                    details: {
                      enrollmentId: enrollment.id,
                      sequenceId: sequence.id,
                      sequenceName: sequence.name,
                      stepOrder: step.stepOrder,
                      recipient: recipientEmail || "(no email on record)",
                      reason: recipientEmail
                        ? "no_prospect_send_email guard active — recipient not in allowlist"
                        : "no_prospect_send_email guard active — contact has no email (fail-closed)",
                    },
                  });
                  await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
                  processed++;
                  stepExecuted = false;
                  break;
                }
              }
            }

            // ── Test intercept: deliveryTestRedirectEmail ────────────────────────
            // When set, every outbound sequence email is redirected to this address.
            // Original recipient + sequence context are prepended to the subject so
            // the operator can audit exactly who each email would have gone to.
            // Safe to leave unset in production — null means no redirect.
            const testRedirectRaw = await storage.getSystemSetting("deliveryTestRedirectEmail");
            const testRedirectTo: string | null =
              typeof testRedirectRaw === "string" && testRedirectRaw.trim()
                ? testRedirectRaw.trim() : null;
            const interpolatedSubject = sfpLaunchStep ? renderSfpSubject(subjectToSend) : interpolate(subjectToSend);
            const deliverySubject = testRedirectTo
              ? `[→ ${contact?.email ?? "no-email"} | ${sequence.name} | Step ${step.stepOrder}] ${interpolatedSubject}`
              : interpolatedSubject;
            const deliveryEmailTo = testRedirectTo ?? contact?.email ?? "";

            if ((useGmailForThisStep || useSmtpForThisStep || isGhlConfigured()) && enrollment.contactId) {
              // ── Atomic cap reservation (cold outreach only) ───────────────────
              // Reserve a send slot via a single conditional upsert.  The WHERE
              // clause makes the increment a no-op when the cap is already reached,
              // which prevents concurrent workers from overshooting the daily limit.
              // Reservation happens here — inside isGhlConfigured() — so counters
              // only tick when an actual GHL send is attempted.
              let coldCapReserved = false;
              // Released SFP launch steps reserve against the ACTUAL selected sender and the global ceiling together.
              let senderReservation: CapacityReservation | null = null;
              const canonicalCapacityPath = sfpLaunchStep && canonicalReleaseAdmitted && useSmtpForThisStep;
              const releaseColdCapReservation = async (): Promise<void> => {
                if (senderReservation) {
                  const held = senderReservation;
                  try { await releaseSenderCapacity(held); senderReservation = null; }
                  catch (decErr) { console.error(`[Sequence Worker] Sender capacity release failed:`, decErr); }
                  return;
                }
                if (!coldCapReserved) return;
                try {
                  const { db: decDb } = await import("../db");
                  const { sql: decSql } = await import("drizzle-orm");
                  const todayDec = new Date().toISOString().slice(0, 10);
                  await decDb.execute(decSql`
                    UPDATE outbound_send_counters
                    SET count = GREATEST(0, count - 1), updated_at = now()
                    WHERE date = ${todayDec} AND channel = 'email' AND scope = 'cold_outreach'
                  `);
                  coldCapReserved = false;
                } catch (decErr) {
                  console.error(`[Sequence Worker] Cap reservation release failed:`, decErr);
                }
              };
              if (canonicalCapacityPath) {
                try {
                  const reserved = await reserveSenderCapacity();
                  if (!reserved.ok) {
                    // Exhausted capacity defers the step; the journey stays active and resumes when capacity returns.
                    await storage.createAuditLog({
                      action: "sequence_step_deferred_sender_capacity", entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
                      details: { enrollmentId: enrollment.id, sequenceId: sequence.id, stepOrder: step.stepOrder, reason: reserved.reason },
                    });
                    await storage.updateSequenceEnrollment(enrollment.id, { nextActionAt: new Date(Date.now() + 60 * 60 * 1000) });
                    processed++; stepExecuted = false; break;
                  }
                  senderReservation = reserved.reservation;
                } catch (reserveErr) {
                  console.error(`[Sequence Worker] Sender capacity reservation failed for enrollment ${enrollment.id} (fail-closed):`, reserveErr);
                  await storage.updateSequenceEnrollment(enrollment.id, { nextActionAt: new Date(Date.now() + 15 * 60 * 1000) });
                  processed++; stepExecuted = false; break;
                }
              } else if (isColdOutreachSequence(sequence)) {
                try {
                  const { db: rsvDb } = await import("../db");
                  const { sql: rsvSql } = await import("drizzle-orm");
                  const todayRsv = new Date().toISOString().slice(0, 10);
                  const { getEffectiveColdDailyCap } = await import("./outbound-cold-cap");
                  const dailyCapRsv = await getEffectiveColdDailyCap();

                  // Conditional upsert: only increment if count < effective cap (atomic guard against race overshoot)
                  const rsvResult = await rsvDb.execute(rsvSql`
                    INSERT INTO outbound_send_counters (date, channel, scope, count, updated_at)
                    VALUES (${todayRsv}, 'email', 'cold_outreach', 1, now())
                    ON CONFLICT (date, channel, scope) DO UPDATE
                      SET count = outbound_send_counters.count + 1, updated_at = now()
                      WHERE outbound_send_counters.count < ${dailyCapRsv}
                    RETURNING count
                  `);
                  // If no row returned the WHERE guard blocked the update → cap is full
                  if (!rsvResult.rows || rsvResult.rows.length === 0) {
                    const enrollMeta2 = (enrollment.metadata as Record<string, unknown> | null) ?? {};
                    const alreadyDeferred2 =
                      enrollMeta2._capDeferStep === step.stepOrder &&
                      enrollMeta2._capDeferDate === todayRsv;
                    if (!alreadyDeferred2) {
                      await storage.updateSequenceEnrollment(enrollment.id, {
                        status: "paused",
                        metadata: { ...enrollMeta2, _capDeferStep: step.stepOrder, _capDeferDate: todayRsv },
                      });
                      await storage.createAuditLog({
                        action: "sequence_step_deferred_daily_cap",
                        entityType: "contact",
                        entityId: enrollment.contactId ?? 0,
                        actorType: "system",
                        details: {
                          enrollmentId: enrollment.id,
                          sequenceId: sequence.id,
                          sequenceName: sequence.name,
                          stepOrder: step.stepOrder,
                          dailyCap: dailyCapRsv,
                          todayStr: todayRsv,
                          source: "atomic_reservation",
                        },
                      });
                    } else {
                      await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
                    }
                    processed++;
                    stepExecuted = false;
                    break;
                  }
                  coldCapReserved = true;
                } catch (reserveErr) {
                  // FAIL-CLOSED: if the atomic reservation query throws for any reason
                  // (DB error, transient fault, SQL error), we must NOT continue to send.
                  // Pause the enrollment and write an audit log so operators can investigate.
                  console.error(`[Sequence Worker] Cold cap reservation failed for enrollment ${enrollment.id} — pausing (fail-closed):`, reserveErr);
                  try {
                    await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
                    await storage.createAuditLog({
                      action: "sequence_step_deferred_cap_reservation_error",
                      entityType: "contact",
                      entityId: enrollment.contactId ?? 0,
                      actorType: "system",
                      details: {
                        enrollmentId: enrollment.id,
                        sequenceId: sequence.id,
                        sequenceName: sequence.name,
                        stepOrder: step.stepOrder,
                        error: reserveErr instanceof Error ? reserveErr.message : String(reserveErr),
                        reason: "Daily cap reservation query failed — send blocked (fail-closed) to preserve warmup/cap enforcement integrity",
                      },
                    });
                  } catch (auditErr) {
                    console.error(`[Sequence Worker] Failed to write audit log for reservation error (enrollment ${enrollment.id}):`, auditErr);
                  }
                  processed++;
                  stepExecuted = false;
                  break;
                }
              }

              // Atomically claim this step before any provider I/O. A null result
              // means another worker owns pending/sent state (or the DB claim was
              // unavailable); this worker must not send or mutate that row.
              const sendLogChannel: import("./outbound-send-log").SendChannel =
                useGmailForThisStep ? "email_gmail"
                : useSmtpForThisStep ? "email_smtp"
                : (testRedirectTo && isSmtpConfigured()) ? "email_smtp"
                : "email_ghl";
              const emailSendClaimId = await openSendAttempt({
                idempotencyKey:       emailIdemKey,
                sequenceId:           sequence.id,
                sequenceEnrollmentId: enrollment.id,
                contactId:            enrollment.contactId ?? undefined,
                stepOrder:            step.stepOrder ?? undefined,
                channel:              sendLogChannel,
                // For GHL sends the provider routes via contactId, not a direct address,
                // but we still record the contact's stored email so the log row is queryable.
                toAddress:            deliveryEmailTo || contact?.email || "",
                subject:              deliverySubject,
              });
              if (emailSendClaimId === null) {
                await releaseColdCapReservation();
                if (canonicalCapacityPath) {
                  // Do not loop forever on an attempt that can never be reclaimed: classify it.
                  const prior = await getSendLogByKey(emailIdemKey);
                  if (prior?.status === "dispatching") {
                    await holdCanonicalEnrollment(enrollment.id, "UNCERTAIN_DELIVERY", { idempotencyKey: emailIdemKey, observedStatus: prior.status });
                    await storage.createAuditLog({ action: "sfp_canonical_hold_uncertain_delivery", entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
                      details: { enrollmentId: enrollment.id, stepOrder: step.stepOrder, idempotencyKey: emailIdemKey } });
                    processed++; continue;
                  }
                  if (prior?.status === "failed") {
                    await holdCanonicalEnrollment(enrollment.id, "SEND_ATTEMPT_FAILED", { idempotencyKey: emailIdemKey, failureReason: prior.failureReason ?? null });
                    processed++; continue;
                  }
                }
                await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable).set({
                  nextActionAt: new Date(Date.now() + 5 * 60 * 1000),
                  metadata: {
                    ...((enrollment.metadata as Record<string, unknown> | null) ?? {}),
                    deferral: { reason: "send_claim_unavailable", channel: "email", currentStep },
                  } as any,
                  updatedAt: new Date(),
                }).where(drizzleAnd(
                  drizzleEq(sequenceEnrollmentsTable.id, enrollment.id),
                  drizzleEq(sequenceEnrollmentsTable.status, "active"),
                  drizzleEq(sequenceEnrollmentsTable.currentStep, enrollment.currentStep ?? 0),
                ));
                processed++;
                continue;
              }
              let emailDispatchAuthorized = false;
              let canonicalSmtpOutcome: "unsent" | "uncertain" | null = null;
              const authorizeClaimedEmailDispatch = async (): Promise<boolean> => {
                if (!decideCr06PromotionalLifecycle({
                  boundary: "sequence_transport",
                  purpose: cr06Purpose,
                }).allowed && !canonicalReleaseAdmitted) {
                  await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable).set({
                    nextActionAt: new Date(Date.now() + 60 * 60 * 1000),
                    updatedAt: new Date(),
                  }).where(drizzleAnd(
                    drizzleEq(sequenceEnrollmentsTable.id, enrollment.id),
                    drizzleEq(sequenceEnrollmentsTable.status, "active"),
                  ));
                  await releaseColdCapReservation();
                  return false;
                }
                if (canonicalReleaseAdmitted) {
                  // Final authorization recomputes authority AND the exact recipient/content binding from live facts;
                  // the claim-time decision is deliberately not trusted here.
                  const fresh = await evaluateCanonicalAuthority(enrollment, sequence, { verifyFacts: true });
                  if (!fresh.admitted) {
                    await releaseColdCapReservation();
                    await reopenUnsentAttempt({ idempotencyKey: emailIdemKey, failureReason: `canonical_authority_denied:${fresh.reason}` });
                    const settled = fresh.settle !== "none"
                      ? await settleCanonicalEnrollment(enrollment.id, fresh.releaseId, fresh) : false;
                    if (!settled) {
                      await storage.updateSequenceEnrollment(enrollment.id, { nextActionAt: new Date(Date.now() + 15 * 60 * 1000) });
                    }
                    await storage.createAuditLog({
                      action: "sfp_canonical_dispatch_denied", entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
                      details: { enrollmentId: enrollment.id, stepOrder: step.stepOrder, reason: fresh.reason, endedReason: fresh.endedReason },
                    });
                    return false;
                  }
                }
                const authorization = await authorizeSequenceDispatch({
                  attemptId: emailSendClaimId.attemptId,
                  claimToken: emailSendClaimId.claimToken,
                  idempotencyKey: emailIdemKey,
                  enrollmentId: enrollment.id,
                  expectedCurrentStep: enrollment.currentStep ?? 0,
                  contactId: enrollment.contactId!,
                  enrolledAt: new Date(enrollment.createdAt!),
                });
                if (authorization.outcome === "AUTHORIZED") {
                  emailDispatchAuthorized = true;
                  return true;
                }
                await handleDeniedDispatchAuthorization(authorization, enrollment, sequence, currentStep);
                await releaseColdCapReservation();
                return false;
              };

              try {
                if (useGmailForThisStep && contact?.email) {
                  // Gmail API: department/staff email via OAuth2 (non-cold sequences)
                  // getCanonicalUrl() always resolves — no undefined risk.
                  const { evaluateContactability } = await import("./contactability");
                  const directProviderDecision = await evaluateContactability({
                    contactId: enrollment.contactId,
                    channel: "email",
                    campaignType: "sequence_direct_gmail",
                    mode: "enforcement",
                  });
                  if (!directProviderDecision.allowed) {
                    throw new Error(`Email blocked by contactability: ${directProviderDecision.reason}`);
                  }
                  const appUrlForToken = getCanonicalUrl();
                  const token = generateUnsubscribeToken(enrollment.contactId);
                  const unsubscribeUrl = `${appUrlForToken}/unsubscribe?t=${encodeURIComponent(token)}`;
                  if (!await authorizeClaimedEmailDispatch()) { processed++; continue; }
                  const result = await sendGmailEmail({
                    to: deliveryEmailTo,
                    subject: deliverySubject,
                    html: emailBody,
                    category: "department_accounts" as any,
                    contactId: enrollment.contactId,
                    commercialPurpose: "marketing_outreach",
                    unsubscribeUrl,
                  });
                  if (!result.success) throw new Error(result.error || "Gmail send failed");
                  await markSendSent({ idempotencyKey: emailIdemKey, providerMessageId: result.messageId, fromAddress: "gmail_oauth" });
                } else if (useSmtpForThisStep && contact?.email) {
                  // Global pause check — upgraded to OutboundPauseAuthority (#1532, was #1399)
                  {
                    const { authorize } = await import("./outbound-pause-authority");
                    const decision = await authorize({});
                    if (!decision.allowed) {
                      throw new Error(`Outbound communications are globally paused (reason=${decision.reasonCode})`);
                    }
                  }
                  // SMTP: cold outreach with List-Unsubscribe header
                  // getCanonicalUrl() always resolves — no undefined risk.
                  const { evaluateContactability } = await import("./contactability");
                  const directProviderDecision = await evaluateContactability({
                    contactId: enrollment.contactId,
                    commercialPurpose: "marketing_outreach",
                    channel: "email",
                    campaignType: "sequence_direct_smtp",
                    mode: "enforcement",
                  });
                  if (!directProviderDecision.allowed) {
                    throw new Error(`Email blocked by contactability: ${directProviderDecision.reason}`);
                  }
                  const appUrlForToken = getCanonicalUrl();
                  const token = generateUnsubscribeToken(enrollment.contactId);
                  const unsubscribeUrl = `${appUrlForToken}/unsubscribe?t=${encodeURIComponent(token)}`;
                  if (!await authorizeClaimedEmailDispatch()) { processed++; continue; }
                  const result = await sendSmtpEmail({
                    to: deliveryEmailTo,
                    subject: deliverySubject,
                    html: emailBody,
                    category: "cold_outreach",
                    contactId: enrollment.contactId,
                    unsubscribeUrl,
                    unsubscribeMailto: "Scott@mail.libertybancard.com",
                  });
                  if (!result.success) {
                    if (canonicalCapacityPath) canonicalSmtpOutcome = result.outcome === "unsent" ? "unsent" : "uncertain";
                    throw new Error(result.error || "SMTP send failed");
                  }
                  await markSendSent({ idempotencyKey: emailIdemKey, providerMessageId: result.messageId, fromAddress: "Scott@mail.libertybancard.com" });
                } else {
                  // GHL: cold outreach from Scott@mail.libertybancard.com
                  // When test intercept is active, fall back to SMTP to the redirect address
                  // because GHL sends via contactId and would reach the real contact directly.
                  const fromEmail = isColdEmail ? "Scott@mail.libertybancard.com" : "accounts@libertybancard.com";
                  const fromName  = isColdEmail ? "Scott Stevenson" : "Liberty Bancard Account Management";
                  // replyTo ensures prospect replies land in a monitored inbox:
                  //   cold outreach → scott@libertybancard.com (not the dedicated send mailbox)
                  //   accounts      → accounts@libertybancard.com (monitored alias)
                  const replyTo   = isColdEmail ? resolvePolicy("cold_outreach").replyTo : "accounts@libertybancard.com";
                  if (testRedirectTo && isSmtpConfigured()) {
                    const { evaluateContactability } = await import("./contactability");
                    const directProviderDecision = await evaluateContactability({
                      contactId: enrollment.contactId,
                      channel: "email",
                      campaignType: "sequence_direct_smtp_redirect",
                      mode: "enforcement",
                    });
                    if (!directProviderDecision.allowed) {
                      throw new Error(`Email blocked by contactability: ${directProviderDecision.reason}`);
                    }
                    if (!await authorizeClaimedEmailDispatch()) { processed++; continue; }
                    const result = await sendSmtpEmail({
                      to: testRedirectTo,
                      subject: deliverySubject,
                      html: emailBody,
                      category: "cold_outreach",
                      contactId: enrollment.contactId,
                      commercialPurpose: "marketing_outreach",
                    });
                    if (!result.success) throw new Error(result.error || "SMTP redirect send failed");
                    await markSendSent({ idempotencyKey: emailIdemKey, providerMessageId: result.messageId, fromAddress: fromEmail });
                  } else {
                    // Route through ChannelOrchestrator (Wave 1A): Liberty decides →
                    // Orchestrator routes → GhlEmailTransport executes → event returns.
                    // The worker's step gate remains the idempotency decision; the
                    // orchestrator repeats the canonical boundary check before I/O.
                    const { channelOrchestrator } = await import("./transports/index");
                    if (!await authorizeClaimedEmailDispatch()) { processed++; continue; }
                    const orchEmailResult = await channelOrchestrator.sendEmail(
                      { contactId: enrollment.contactId, subject: deliverySubject, body: emailBody, fromEmail, fromName, replyTo, commercialPurpose: "marketing_outreach" },
                    );
                    if (!orchEmailResult.success) {
                      throw new Error(
                        orchEmailResult.error ?? orchEmailResult.skipReason ?? "Email send blocked by channel orchestrator",
                      );
                    }
                    await markSendSent({ idempotencyKey: emailIdemKey, providerMessageId: orchEmailResult.messageId, fromAddress: fromEmail });
                  }
                }
                stepExecuted = true;
                // Record in canonical communication_events table (Wave A3 — non-blocking)
                import("./communication-events").then(({ recordOutboundSend }) => {
                  recordOutboundSend({
                    contactId: enrollment.contactId!,
                    channel: "email",
                    provider: testRedirectTo ? "smtp" : "ghl",
                    subject: deliverySubject,
                    sequenceId: sequence.id,
                    sequenceStepId: step.id,
                    status: "sent",
                  });
                }).catch(() => {});
              } catch (emailErr) {
                console.error(`Sequence email failed for enrollment ${enrollment.id}:`, emailErr);
                const failureReason = emailErr instanceof Error ? emailErr.message : String(emailErr);
                if (canonicalCapacityPath) {
                  // Released launch sends never turn a failure into a permanently stranded step.
                  if (!emailDispatchAuthorized) {
                    // Nothing reached the transport: free the allowance, reopen the same step, retry later.
                    await releaseColdCapReservation();
                    await reopenUnsentAttempt({ idempotencyKey: emailIdemKey, failureReason });
                    await storage.updateSequenceEnrollment(enrollment.id, { nextActionAt: new Date(Date.now() + 15 * 60 * 1000) });
                  } else if (canonicalSmtpOutcome === "unsent") {
                    // The transport proved the message was not accepted: allowance is returned, same step retried (bounded).
                    await releaseColdCapReservation();
                    await reopenUnsentAttempt({ idempotencyKey: emailIdemKey, failureReason });
                    const tries = await recordUnsentRetry(enrollment.id, step.stepOrder ?? 0);
                    if (tries >= MAX_UNSENT_RETRIES) {
                      await holdCanonicalEnrollment(enrollment.id, "REPEATED_UNSENT", { idempotencyKey: emailIdemKey, attempts: tries, failureReason });
                    } else {
                      await storage.updateSequenceEnrollment(enrollment.id, { nextActionAt: new Date(Date.now() + 15 * 60 * 1000) });
                    }
                  } else {
                    // Outcome unknown: the message may have been delivered. Keep the allowance consumed, leave the
                    // attempt un-reclaimable and hold the journey for an explicit operator decision.
                    if (senderReservation) {
                      await recordHeldReservation(enrollment.id, senderReservation, emailIdemKey).catch(() => {});
                      senderReservation = null;
                    }
                    await holdCanonicalEnrollment(enrollment.id, "UNCERTAIN_DELIVERY", { idempotencyKey: emailIdemKey, failureReason });
                    await storage.createAuditLog({ action: "sfp_canonical_hold_uncertain_delivery", entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
                      details: { enrollmentId: enrollment.id, stepOrder: step.stepOrder, idempotencyKey: emailIdemKey } });
                  }
                } else {
                  if (emailDispatchAuthorized) {
                    await markSendFailed({ idempotencyKey: emailIdemKey, failureReason });
                  }
                  await releaseColdCapReservation();
                }
              }
            }
            const emailLog = await storage.createEmailLog({
              contactId: enrollment.contactId,
              direction: "outbound",
              subject: sfpLaunchStep ? renderSfpSubject(subjectToSend) : interpolate(subjectToSend),
              body: emailBody,
              status: stepExecuted ? "sent" : "failed",
              metadata: abEnabled ? { stepId: step.id, sequenceId: sequence.id, abVariant: chosenVariant } : undefined,
            });
            if (abEnabled && emailLog) await recordSequenceAbDelivery({ enrollmentId: enrollment.id, stepId: step.id, deliveryLogId: emailLog.id });

            if (abEnabled && stepExecuted && !currentWinner) {
              const stepLogs = await storage.getEmailLogsByStepId(step.id);
              const meta = (l: { metadata: unknown }) => l.metadata as Record<string, unknown> | null;
              const variantASent = stepLogs.filter(l => meta(l)?.abVariant === "A" && l.status === "sent").length;
              const variantBSent = stepLogs.filter(l => meta(l)?.abVariant === "B" && l.status === "sent").length;
              const aOpens = stepLogs.filter(l => meta(l)?.abVariant === "A" && l.openedAt != null).length;
              const bOpens = stepLogs.filter(l => meta(l)?.abVariant === "B" && l.openedAt != null).length;
              const aClicks = stepLogs.filter(l => meta(l)?.abVariant === "A" && l.clickedAt != null).length;
              const bClicks = stepLogs.filter(l => meta(l)?.abVariant === "B" && l.clickedAt != null).length;
              const aReplies = stepLogs.filter(l => meta(l)?.abVariant === "A" && l.repliedAt != null).length;
              const bReplies = stepLogs.filter(l => meta(l)?.abVariant === "B" && l.repliedAt != null).length;
              const totalSent = variantASent + variantBSent;
              const minSampleSize = abConfig?.minSampleSize ?? 100;
              const winnerCriteria = abConfig?.winnerCriteria ?? "open_rate";

              let winnerSelected: string | null = null;
              let winnerAt: string | null = existing.winnerAt ?? null;
              let statisticallySignificant = false;
              if (totalSent >= minSampleSize) {
                const successA = winnerCriteria === "reply_rate" ? aReplies : winnerCriteria === "click_rate" ? aClicks : aOpens;
                const successB = winnerCriteria === "reply_rate" ? bReplies : winnerCriteria === "click_rate" ? bClicks : bOpens;
                const pPooled = variantASent + variantBSent > 0 ? (successA + successB) / (variantASent + variantBSent) : 0;
                if (pPooled > 0 && pPooled < 1 && variantASent >= 5 && variantBSent >= 5) {
                  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / variantASent + 1 / variantBSent));
                  const p1 = variantASent > 0 ? successA / variantASent : 0;
                  const p2 = variantBSent > 0 ? successB / variantBSent : 0;
                  if (se > 0 && Math.abs((p1 - p2) / se) >= 1.96) {
                    statisticallySignificant = true;
                    winnerSelected = p1 >= p2 ? "A" : "B";
                    winnerAt = new Date().toISOString();
                  }
                }
              }

              // Evaluator execution is scheduler/admin-command owned. Sending
              // records exposure only and must not fire a competing evaluator.
            }
            break;
          }

          case "sms": {
            const abConfig = (step.abTestConfig as AbTestConfig | null);
            const abEnabled = !!(step.variantBBody);

            const existing = (step.abTestResults as Partial<AbTestResults> | null) ?? {};
            const currentWinner: string | null = existing.winnerSelected ?? null;

            let chosenVariant: "A" | "B" = "A";
            let bodyToSend = step.body;

            if (abEnabled) {
              if (currentWinner) {
                chosenVariant = currentWinner as "A" | "B";
              } else {
                chosenVariant = await getOrCreateSequenceAbAssignment({
                  enrollmentId: enrollment.id, stepId: step.id, splitRatio: abConfig?.splitRatio ?? 50,
                  config: { abConfig, bodyA: step.body, bodyB: step.variantBBody },
                  eligibilitySnapshot: { contactId: enrollment.contactId, sequenceId: sequence.id, stepId: step.id, lifecycleState: contact?.lifecycleState ?? null, consentTier: contact?.consentTier ?? null, recordClass: contact?.recordClass ?? "unknown" },
                });
              }
              if (chosenVariant === "B") bodyToSend = step.variantBBody ?? step.body;
            }

            // ── Per-channel pause gate (SMS) ──────────────────────────────────
            // FAIL-CLOSED: null/undefined (unset) → paused. Only explicit "false"
            // (string or boolean) releases the SMS channel.
            {
              const smsPausedRaw = await storage.getSystemSetting("smsChannelPaused");
              const smsPaused = smsPausedRaw !== "false" && smsPausedRaw !== false;
              if (smsPaused) {
                await storage.createAuditLog({
                  action: "sequence_step_skipped_channel_pause",
                  entityType: "contact", entityId: enrollment.contactId ?? 0, actorType: "system",
                  details: { enrollmentId: enrollment.id, sequenceId: sequence.id, channel: "sms", reason: "smsChannelPaused" },
                });
                await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
                processed++; stepExecuted = false; break;
              }
            }

            // ── Gate (no-prospect-send): SMS test mode guard ──────────────────
            // When deliveryNoProspectSendSms is true, only allowlisted contacts
            // can receive SMS sends. Uses the email-based allowlist since phone
            // numbers are not individually listed.
            //
            // FAIL-CLOSED: guard runs unconditionally regardless of whether the
            // contact has a local phone/email record. A GHL send dispatched via
            // contactId alone bypasses local field checks — so we verify identity
            // here before any provider call.  Missing email → cannot confirm
            // allowlist membership → block (do not let GHL dispatch unverified).
            {
              const noProspectSmRaw = await storage.getSystemSetting("deliveryNoProspectSendSms");
              const noProspectSmsGuard = noProspectSmRaw === true || noProspectSmRaw === "true";
              if (noProspectSmsGuard) {
                const allowlistRaw = await storage.getSystemSetting("deliveryTestEmailAllowlist");
                const allowlist: string[] = typeof allowlistRaw === "string"
                  ? allowlistRaw.split(",").map((e: string) => e.trim().toLowerCase()).filter(Boolean)
                  : [];
                // Identity verified via email (authoritative field on contact record).
                // Fail closed when email is absent — we cannot confirm allowlist membership.
                const recipientEmail = (contact?.email ?? "").toLowerCase();
                const isSmsAllowed = recipientEmail.length > 0 &&
                  (allowlist.includes(recipientEmail) || recipientEmail.endsWith("@libertybancard.com"));
                if (!isSmsAllowed) {
                  await storage.createAuditLog({
                    action: "sequence_step_blocked_no_prospect_guard_sms",
                    entityType: "contact",
                    entityId: enrollment.contactId ?? 0,
                    actorType: "system",
                    details: {
                      enrollmentId: enrollment.id,
                      sequenceId: sequence.id,
                      sequenceName: sequence.name,
                      stepOrder: step.stepOrder,
                      recipientPhone: contact?.phone ?? null,
                      recipientEmail: contact?.email ?? null,
                      reason: recipientEmail
                        ? "no_prospect_send_sms guard active — contact not in allowlist"
                        : "no_prospect_send_sms guard active — contact has no email for allowlist verification (fail-closed)",
                    },
                  });
                  await storage.updateSequenceEnrollment(enrollment.id, { status: "paused" });
                  processed++;
                  stepExecuted = false;
                  break;
                }
              }
            }

            // ── Idempotency gate (SMS) ────────────────────────────────────────
            const smsIdemKey = buildIdempotencyKey(enrollment.id, step.stepOrder ?? 0);
            if (await hasSentStep(smsIdemKey)) {
              console.warn(`[Sequence Worker] SMS step already sent (idempotent skip): ${smsIdemKey}`);
              stepExecuted = true;
              break;
            }

            // Atomically claim the slot before touching the provider.
            const smsSendClaimId = await openSendAttempt({
              idempotencyKey:       smsIdemKey,
              sequenceId:           sequence.id,
              sequenceEnrollmentId: enrollment.id,
              contactId:            enrollment.contactId ?? undefined,
              stepOrder:            step.stepOrder ?? undefined,
              channel:              "sms_ghl",
              toAddress:            contact?.phone ?? "",
            });
            if (smsSendClaimId === null) {
              await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable).set({
                nextActionAt: new Date(Date.now() + 5 * 60 * 1000),
                metadata: {
                  ...((enrollment.metadata as Record<string, unknown> | null) ?? {}),
                  deferral: { reason: "send_claim_unavailable", channel: "sms", currentStep },
                } as any,
                updatedAt: new Date(),
              }).where(drizzleAnd(
                drizzleEq(sequenceEnrollmentsTable.id, enrollment.id),
                drizzleEq(sequenceEnrollmentsTable.status, "active"),
                drizzleEq(sequenceEnrollmentsTable.currentStep, enrollment.currentStep ?? 0),
              ));
              processed++;
              continue;
            }
            let smsDispatchAuthorized = false;
            const authorizeClaimedSmsDispatch = async (): Promise<boolean> => {
              if (!decideCr06PromotionalLifecycle({
                boundary: "sequence_transport",
                purpose: cr06Purpose,
              }).allowed) {
                await defaultSequenceWorkerDb.update(sequenceEnrollmentsTable).set({
                  nextActionAt: new Date(Date.now() + 60 * 60 * 1000),
                  updatedAt: new Date(),
                }).where(drizzleAnd(
                  drizzleEq(sequenceEnrollmentsTable.id, enrollment.id),
                  drizzleEq(sequenceEnrollmentsTable.status, "active"),
                ));
                return false;
              }
              const authorization = await authorizeSequenceDispatch({
                attemptId: smsSendClaimId.attemptId,
                claimToken: smsSendClaimId.claimToken,
                idempotencyKey: smsIdemKey,
                enrollmentId: enrollment.id,
                expectedCurrentStep: enrollment.currentStep ?? 0,
                contactId: enrollment.contactId!,
                enrolledAt: new Date(enrollment.createdAt!),
              });
              if (authorization.outcome === "AUTHORIZED") {
                smsDispatchAuthorized = true;
                return true;
              }
              await handleDeniedDispatchAuthorization(authorization, enrollment, sequence, currentStep);
              return false;
            };

            if (isGhlConfigured() && enrollment.contactId) {
              try {
                // The worker preserves its per-step gate/idempotency logic; the
                // orchestrator repeats the canonical boundary check before I/O.
                const { channelOrchestrator: smsOrch } = await import("./transports/index");
                if (!await authorizeClaimedSmsDispatch()) { processed++; continue; }
                const orchSmsResult = await smsOrch.sendSms(
                  { contactId: enrollment.contactId, body: interpolate(bodyToSend) },
                );
                if (!orchSmsResult.success) {
                  throw new Error(
                    orchSmsResult.error ?? orchSmsResult.skipReason ?? "SMS send blocked by channel orchestrator",
                  );
                }
                await markSendSent({ idempotencyKey: smsIdemKey, providerMessageId: orchSmsResult.messageId, fromAddress: "ghl_sms" });
                stepExecuted = true;
                // Record in canonical communication_events table (Wave A3 — non-blocking)
                import("./communication-events").then(({ recordOutboundSend }) => {
                  recordOutboundSend({
                    contactId: enrollment.contactId!,
                    channel: "sms",
                    provider: "ghl",
                    body: interpolate(bodyToSend),
                    sequenceId: sequence.id,
                    sequenceStepId: step.id,
                    status: "sent",
                  });
                }).catch(() => {});
              } catch (smsErr) {
                console.error(`Sequence SMS failed for enrollment ${enrollment.id}:`, smsErr);
                if (smsDispatchAuthorized) {
                  await markSendFailed({ idempotencyKey: smsIdemKey, failureReason: smsErr instanceof Error ? smsErr.message : String(smsErr) });
                }
              }
            }

            const smsLog = await storage.createEmailLog({
              contactId: enrollment.contactId,
              direction: "outbound",
              subject: null,
              body: interpolate(bodyToSend),
              status: stepExecuted ? "sent" : "failed",
              metadata: { type: "sms", stepId: step.id, sequenceId: sequence.id, ...(abEnabled ? { abVariant: chosenVariant } : {}) },
            });
            if (abEnabled && smsLog) await recordSequenceAbDelivery({ enrollmentId: enrollment.id, stepId: step.id, deliveryLogId: smsLog.id });

            if (abEnabled && stepExecuted && !currentWinner) {
              const stepLogs = await storage.getEmailLogsByStepId(step.id);
              const meta = (l: { metadata: unknown }) => l.metadata as Record<string, unknown> | null;
              const abLogs = stepLogs.filter(l => meta(l)?.type === "sms" && meta(l)?.abVariant);
              const variantASent = abLogs.filter(l => meta(l)?.abVariant === "A" && l.status === "sent").length;
              const variantBSent = abLogs.filter(l => meta(l)?.abVariant === "B" && l.status === "sent").length;
              const aReplies = abLogs.filter(l => meta(l)?.abVariant === "A" && l.repliedAt != null).length;
              const bReplies = abLogs.filter(l => meta(l)?.abVariant === "B" && l.repliedAt != null).length;
              const totalSent = variantASent + variantBSent;
              const minSampleSize = abConfig?.minSampleSize ?? 100;

              let winnerSelected: string | null = null;
              let winnerAt: string | null = existing.winnerAt ?? null;
              let statisticallySignificant = false;
              if (totalSent >= minSampleSize) {
                const pPooled = variantASent + variantBSent > 0 ? (aReplies + bReplies) / (variantASent + variantBSent) : 0;
                if (pPooled > 0 && pPooled < 1 && variantASent >= 5 && variantBSent >= 5) {
                  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / variantASent + 1 / variantBSent));
                  const p1 = variantASent > 0 ? aReplies / variantASent : 0;
                  const p2 = variantBSent > 0 ? bReplies / variantBSent : 0;
                  if (se > 0 && Math.abs((p1 - p2) / se) >= 1.96) {
                    statisticallySignificant = true;
                    winnerSelected = p1 >= p2 ? "A" : "B";
                    winnerAt = new Date().toISOString();
                  }
                }
              }

              // Evaluator execution is scheduler/admin-command owned.
            }
            break;
          }

          case "call_reminder": {
            await storage.createAuthorityTask({
              title: `Call Reminder — ${firstName} ${lastName}`,
              description: `Sequence "${sequence.name}" Step ${step.stepOrder}: Manual call reminder.\n${step.body ?? ""}`,
              assignedTo: sequence.createdBy || "Unassigned",
              priority: "medium",
              dueDate: new Date(Date.now() + 24 * 3600000),
              contactId: enrollment.contactId || undefined,
              dealId: enrollment.dealId || undefined,
            });
            stepExecuted = true;
            break;
          }

          case "call": {
            const rawCallConfig = step.config
              ? (typeof step.config === "string" ? JSON.parse(step.config) : step.config)
              : null;
            const callConfig = rawCallConfig as {
              callMode?: VoiceBotMode;
              scriptType?: string;
              voicemailScript?: string;
              opening?: string;
              close?: string;
            } | null;
            const orchestratorEnabled = process.env.ORCHESTRATOR_ENABLED !== "false";

            if (!orchestratorEnabled) {
              await storage.createAuditLog({
                action: "call_step_skipped",
                entityType: "contact",
                entityId: enrollment.contactId || 0,
                details: {
                  reason: "ORCHESTRATOR_ENABLED=false — voice dispatch disabled",
                  sequenceName: sequence.name,
                  stepOrder: step.stepOrder,
                  scriptType: callConfig?.scriptType ?? null,
                },
              });
              stepExecuted = true;
              break;
            }

            if (enrollment.contactId) {
              try {
                const { triggerAiCall, VOICE_BOT_MODES } = await import("./sdr/voice-orchestrator");
                const rawCallMode = callConfig?.callMode;
                const callMode: VoiceBotMode = rawCallMode && (VOICE_BOT_MODES as readonly string[]).includes(rawCallMode)
                  ? (rawCallMode as VoiceBotMode)
                  : "intro_qualification";
                if (rawCallMode && rawCallMode !== callMode) {
                  console.warn(`[Sequence Worker] Unsupported callMode "${rawCallMode}" — falling back to intro_qualification`);
                }
                const contact = await storage.getContact(enrollment.contactId);
                if (contact?.ghlContactId) {
                  const { db } = await import("../db");
                  const { sdrMerchants } = await import("@shared/schema");
                  const { eq } = await import("drizzle-orm");
                  const [merchant] = await db
                    .select()
                    .from(sdrMerchants)
                    .where(eq(sdrMerchants.ghlContactId, contact.ghlContactId));
                  if (merchant) {
                    if (await applyReplyDecision(enrollment, sequence, currentStep) === "stopped") { processed++; continue; }
                    const result = await triggerAiCall(merchant.id, callMode);
                    if (result.success || result.scheduled) {
                      stepExecuted = true;
                    } else {
                      console.warn(`[Sequence Worker] Voice call skipped for enrollment ${enrollment.id}: ${result.reason}`);
                    }
                  }
                }
              } catch (callErr) {
                const msg = callErr instanceof Error ? callErr.message : String(callErr);
                console.error(`[Sequence Worker] Voice call failed for enrollment ${enrollment.id}: ${msg}`);
              }
            }

            if (!stepExecuted) {
              await storage.createAuditLog({
                action: "call_step_skipped",
                entityType: "contact",
                entityId: enrollment.contactId || 0,
                details: {
                  reason: "No linked merchant found for voice dispatch",
                  sequenceName: sequence.name,
                  stepOrder: step.stepOrder,
                  scriptType: callConfig?.scriptType ?? null,
                },
              });
              stepExecuted = true;
            }
            break;
          }

          case "voicemail_drop": {
            const vmOrchestratorEnabled = process.env.ORCHESTRATOR_ENABLED !== "false";
            if (!vmOrchestratorEnabled) {
              await storage.createAuditLog({
                action: "voicemail_drop_skipped",
                entityType: "contact",
                entityId: enrollment.contactId || 0,
                details: {
                  reason: "ORCHESTRATOR_ENABLED=false — voicemail drop skipped",
                  sequenceName: sequence.name,
                  stepOrder: step.stepOrder,
                },
              });
              stepExecuted = true;
              break;
            }

            type VmConfig = { voicemailScript?: string; ghlNote?: string };
            const rawVmConfig = step.config;
            const vmConfig: VmConfig | null = rawVmConfig == null
              ? null
              : typeof rawVmConfig === "string"
                ? (JSON.parse(rawVmConfig) as VmConfig)
                : (rawVmConfig as VmConfig);
            const vmScript = interpolate(vmConfig?.voicemailScript ?? "");
            const ghlNote = vmConfig?.ghlNote ?? "";

            await storage.createAuditLog({
              action: "voicemail_drop_logged",
              entityType: "contact",
              entityId: enrollment.contactId || 0,
              details: {
                sequenceId: sequence.id,
                sequenceName: sequence.name,
                stepOrder: step.stepOrder,
                voicemailScript: vmScript,
                ghlSetupNote: ghlNote,
              },
            });

            if (enrollment.contactId && vmScript) {
              try {
                await storage.createAuthorityTask({
                  title: `Voicemail Drop — ${firstName} ${lastName}`,
                  description: `GHL Voicemail Drop for sequence "${sequence.name}" Step ${step.stepOrder}.\n\nScript (record and upload to GHL Voicemail Drops library):\n${vmScript}\n\n${ghlNote}\n\nInstruction: In GHL workflow, add a Voicemail Drop action node and select the pre-recorded audio for this script. Tag 'vm-drop-pending' on the contact signals it is ready to trigger.`,
                  assignedTo: sequence.createdBy || "Unassigned",
                  priority: "medium",
                  dueDate: new Date(Date.now() + 60000),
                  contactId: enrollment.contactId,
                  dealId: enrollment.dealId || undefined,
                });
              } catch (taskErr) {
                console.warn(`[Sequence Worker] Voicemail drop task creation failed:`, taskErr);
              }
              try {
                await storage.createNote({
                  entityType: "contact",
                  entityId: enrollment.contactId,
                  content: `Voicemail Drop: ${vmScript}`,
                  authorName: "Liberty Bancard SDR",
                });
              } catch (noteErr) {
                console.warn(`[Sequence Worker] Voicemail drop local note creation failed:`, noteErr);
              }

              if (isSdrGhlConfigured() && contact?.ghlContactId) {
                const scriptPreview = vmScript.length > 120 ? vmScript.slice(0, 117) + "..." : vmScript;
                try {
                  if (await applyReplyDecision(enrollment, sequence, currentStep) === "stopped") { processed++; continue; }
                  await ghlAddTag({ contactId: contact.ghlContactId, tags: ["vm-drop-pending"] });
                } catch (tagErr) {
                  console.warn(`[Sequence Worker] GHL tag 'vm-drop-pending' failed:`, tagErr);
                }
                try {
                  await ghlAddNote({
                    contactId: contact.ghlContactId,
                    body: `voicemail_drop_pending: ${scriptPreview}`,
                  });
                } catch (noteErr) {
                  console.warn(`[Sequence Worker] GHL voicemail note failed:`, noteErr);
                }
                try {
                  const vmWorkflowId = await getWorkflowEnvValue("GHL_WORKFLOW_VOICEMAIL_DROP");
                  if (vmWorkflowId) {
                    await ghlTriggerWorkflow({
                      workflowId: vmWorkflowId,
                      contactId: contact.ghlContactId,
                      metadata: {
                        sequenceId: sequence.id,
                        sequenceName: sequence.name,
                        stepOrder: step.stepOrder,
                        scriptPreview,
                      },
                    });
                    console.log(`[Sequence Worker] GHL_WORKFLOW_VOICEMAIL_DROP triggered for contact ${contact.ghlContactId}`);
                  }
                } catch (wfErr) {
                  console.warn(`[Sequence Worker] GHL_WORKFLOW_VOICEMAIL_DROP trigger failed:`, wfErr);
                }
              }
            }
            stepExecuted = true;
            break;
          }

          case "task": {
            // Creates a CRM task only — does NOT place a call, invoke AI voice,
            // trigger autodialing, or send an RVM.  Gate (b) above ensures this
            // path is only reached when evaluateContactability("manual_call") passes.
            await storage.createAuthorityTask({
              title: interpolate(step.subject) || `Follow-up task from sequence`,
              description: `Auto-created by sequence "${sequence.name}" - Step ${step.stepOrder}`,
              assignedTo: sequence.createdBy || "Unassigned",
              priority: "medium",
              dueDate: new Date(Date.now() + 24 * 3600000),
              contactId: enrollment.contactId || undefined,
              dealId: enrollment.dealId || undefined,
            });
            stepExecuted = true;
            break;
          }

          case "wait": {
            stepExecuted = true;
            break;
          }

          default:
            stepExecuted = true;
            break;
        }

        if (stepExecuted) {
          import("./analytics-events").then(({ recordAnalyticsEvent }) => {
            recordAnalyticsEvent({
              eventName: "sequence_step_sent",
              contactId: enrollment.contactId ?? undefined,
              sequenceId: sequence.id,
              channel: step.actionType,
              metadata: { stepOrder: step.stepOrder, actionType: step.actionType, sequenceName: sequence.name },
            });
          }).catch(() => {});

          const nextStepIndex = currentStep + 1;
          const sortedSteps = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
          const nextStep = sortedSteps[nextStepIndex];

          if (!nextStep) {
            // A reply can arrive while a transport reports success. Never label
            // that contact as no-response without a final canonical read.
            if (await applyReplyDecision(enrollment, sequence, currentStep) === "stopped") {
              processed++;
              continue;
            }
            await completeNoResponseEnrollment(enrollment, sequence, nextStepIndex);
          } else {
            const delayMs = ((nextStep.delayDays || 0) * 86400000) + ((nextStep.delayHours || 0) * 3600000);
            const nextActionAt = new Date(Date.now() + Math.max(delayMs, 60000));

            await storage.updateSequenceEnrollment(enrollment.id, {
              currentStep: nextStepIndex,
              nextActionAt,
            });
          }

          await storage.createAuditLog({
            action: "sequence_step_executed",
            entityType: "contact",
            entityId: enrollment.contactId || 0,
            details: {
              sequenceId: sequence.id,
              sequenceName: sequence.name,
              stepOrder: step.stepOrder,
              actionType: step.actionType,
              subject: step.subject || "",
            },
          });

          processed++;
        }
      } catch (enrollErr) {
        console.error(`Error processing enrollment ${enrollment.id}:`, enrollErr);
        errors++;
        try {
          // A transient fault must not strand a released journey: defer it in place instead of pausing.
          await storage.updateSequenceEnrollment(enrollment.id, canonicalJourney
            ? { nextActionAt: new Date(Date.now() + 15 * 60 * 1000) } : { status: "paused" });
        } catch (_) {}
      }
    }
    await releaseJobLock(JOB_NAMES.SEQUENCE_WORKER, true, undefined, lockToken);
  } catch (err: any) {
    console.error("Sequence worker error:", err);
    await releaseJobLock(JOB_NAMES.SEQUENCE_WORKER, false, err?.message ?? String(err), lockToken);
  } finally {
    heartbeat.stop();
  }

  // Record runtime metrics to system_settings for health monitor + queue-metrics endpoint
  const _runDurationMs = Date.now() - _runStartMs;
  try {
    // Count total due enrollments at end of run (approximate — reflects current state)
    let enrollmentsDueTotal = 0;
    try {
      const { db: _metricsDb } = await import("../db");
      const { sql: _metricsSql } = await import("drizzle-orm");
      const dueCountResult = await _metricsDb.execute(_metricsSql`
        SELECT COUNT(*)::int AS cnt
        FROM sequence_enrollments
        WHERE status = 'active'
          AND next_action_at IS NOT NULL
          AND next_action_at <= NOW()
      `);
      enrollmentsDueTotal = (dueCountResult.rows[0] as any)?.cnt ?? 0;
    } catch (_countErr) {
      // Non-fatal
    }
    const runMetrics = {
      duration_ms: _runDurationMs,
      enrollments_processed: processed,
      enrollments_due_total: enrollmentsDueTotal,
      errors,
      ran_at: new Date().toISOString(),
    };
    await storage.setSystemSetting("sequence_worker_last_run", runMetrics);
    // Structured log line — consumed by log aggregators and the admin health panel
    console.log(JSON.stringify({
      event: "sequence_worker_run_complete",
      ...runMetrics,
    }));
  } catch (_metricsErr: any) {
    console.warn("[SequenceWorker] Failed to record run metrics:", _metricsErr?.message);
  }

  return { processed, errors };
}

export async function autoEnrollFromTrigger(triggerType: string, data: {
  contactId?: number;
  dealId?: number;
  formType?: string;
}, opts?: {
  preEvaluated?: {
    contactabilityByChannel: Partial<Record<string, import("./contactability").ContactabilityResult>>;
  };
  promotionalIntent?: {
    idempotencyKey: string;
    actorId: string;
    source: string;
  };
}): Promise<{ count: number; enrollmentIds: number[]; alreadyEnrolledCount: number }> {
  let enrolled = 0;
  let alreadyEnrolledCount = 0;
  const enrollmentIds: number[] = [];
  // CR-04 fail-closed boundary: direct trigger callers (including public
  // contact_created routes) cannot activate promotional sequences. The durable
  // promotional job is the only admitted caller, and its CR-04 path currently
  // records a blocked activation attempt until pilot authority exists.
  if (!opts?.promotionalIntent) {
    if (data.contactId) {
      await storage.createAuditLog({
        action: "cr04_auto_enrollment_blocked",
        entityType: "contact",
        entityId: data.contactId,
        actorType: "system",
        details: { triggerType, reasonCode: "CR04_PROMOTIONAL_INTENT_REQUIRED" },
      });
    }
    return { count: 0, enrollmentIds: [], alreadyEnrolledCount: 0 };
  }

  try {
    const allSequences = await storage.getFollowUpSequences();
    const activeSequences = allSequences.filter(
      s => !s.retiredAt && s.status === "active" && s.triggerType === triggerType
    );

    for (const seq of activeSequences) {
      const triggerConfig = (seq.triggerConfig as any) || {};

      if (triggerType === "form_submitted" && triggerConfig.formType && triggerConfig.formType !== data.formType) {
        continue;
      }

      if (triggerType === "deal_stage_changed" && triggerConfig.toStage && triggerConfig.toStage !== (data as any).toStage) {
        continue;
      }

      if (triggerType === "deal_stage_changed" && triggerConfig.pipeline && triggerConfig.pipeline !== (data as any).pipeline) {
        continue;
      }

      if (!data.contactId) continue;

      const existing = await storage.getContactEnrollments(data.contactId);
      const alreadyInSequence = existing.some(
        e => e.sequenceId === seq.id && (e.status === "active" || e.status === "completed")
      );
      if (alreadyInSequence) {
        alreadyEnrolledCount++;
        continue;
      }

      const steps = await storage.getSequenceSteps(seq.id);

      // Pre-enrollment contactability gate — mirrors the same channel-resolution logic used
      // by Gate (b) in processSequenceEnrollments so both gates use identical channel mapping.
      {
        type AutomatedActionChannel = "email" | "sms" | "voice_ai" | "ringless_vm" | "manual_call";
        const automatedChannelMap: Record<string, AutomatedActionChannel> = {
          email: "email",
          sms: "sms",
          call: "voice_ai",
          voicemail_drop: "ringless_vm",
          // task steps create a CRM task only — gated via manual_call to block DNC contacts
          task: "manual_call",
        };

        // Resolve the FULL set of outbound channels this sequence could execute.
        // Strategy: always take the UNION of step-derived channels AND any declared
        // outboundChannels — never let a narrower declaration hide channels that steps
        // will actually try to execute (which Gate (b) checks per step.actionType).
        //
        // Step-derived: map each step.actionType → channel, same as Gate (b).
        const stepChannels = new Set<AutomatedActionChannel>();
        for (const step of steps) {
          const ch = automatedChannelMap[step.actionType];
          if (ch) stepChannels.add(ch);
        }

        // Declared: triggerConfig.outboundChannels (used by enrollContactInGhlWorkflow path)
        const declaredChannels = new Set<AutomatedActionChannel>();
        if (
          Array.isArray(triggerConfig.outboundChannels) &&
          (triggerConfig.outboundChannels as string[]).length > 0
        ) {
          for (const c of triggerConfig.outboundChannels as string[]) {
            if (["email", "sms", "voice_ai", "ringless_vm", "manual_call"].includes(c)) {
              declaredChannels.add(c as AutomatedActionChannel);
            }
          }
        }

        // Channel set for enrollment gate.
        //
        // When outboundChannels is explicitly declared in triggerConfig, use it as
        // the sole authority.  The per-step gates (SMS skip + Gate b) handle
        // compliance for channels not listed here — so setting ["email"] allows cold
        // contacts to enroll in mixed email+SMS sequences while SMS steps are skipped
        // until PEWC consent is obtained.
        //
        // When outboundChannels is NOT declared (legacy sequences), fall back to the
        // step-derived channel set so existing behaviour is preserved.  If neither
        // source produces any channels, fail-closed to all automated channels.
        let channelSet: Set<AutomatedActionChannel>;
        if (declaredChannels.size > 0) {
          // Explicit declaration wins — do NOT union with step-derived channels.
          channelSet = declaredChannels;
        } else if (stepChannels.size > 0) {
          channelSet = stepChannels;
        } else {
          // Fail-closed: no channels declared or derivable → require all automated channels
          channelSet = new Set(["email", "sms", "voice_ai", "ringless_vm"] as AutomatedActionChannel[]);
        }

        const { evaluateContactability } = await import("./contactability");
        let enrollmentBlocked = false;
        let blockedChannel: string | undefined;
        let blockReason: string | undefined;
        let blockConsentTier: string | undefined;
        let blockLifecycleStage: string | undefined;

        for (const channel of channelSet) {
          let check: import("./contactability").ContactabilityResult | undefined;

          if (opts?.preEvaluated?.contactabilityByChannel) {
            check = opts.preEvaluated.contactabilityByChannel[channel];
          }

          if (!check) {
            check = await evaluateContactability({
              contactId: data.contactId,
              channel,
              campaignType: "auto_enrollment",
              mode: "enforcement",
            });
          }

          if (!check.allowed) {
            enrollmentBlocked = true;
            blockedChannel = channel;
            blockReason = check.reason;
            blockConsentTier = check.consentTier;
            blockLifecycleStage = check.lifecycleStage;
            break;
          }
        }

        if (enrollmentBlocked) {
          await storage.createAuditLog({
            action: "auto_enrollment_blocked_contactability",
            entityType: "contact",
            entityId: data.contactId,
            actorType: "system",
            details: {
              sequenceId: seq.id,
              sequenceName: seq.name,
              triggerType,
              blockedChannel,
              reason: blockReason,
              consentTier: blockConsentTier,
              lifecycleStage: blockLifecycleStage,
            },
          });
          continue;
        }
      }

      const firstStep = steps.find(s => s.stepOrder === 1) || steps[0];
      const delayMs = firstStep
        ? ((firstStep.delayDays || 0) * 86400000) + ((firstStep.delayHours || 0) * 3600000)
        : 0;
      const cr06EnrollmentDecision = decideCr06PromotionalLifecycle({
        boundary: "sequence_enrollment",
        purpose: classifyCr06SequencePurpose(seq),
      });
      if (!cr06EnrollmentDecision.allowed) {
        await storage.createAuditLog({
          action: "cr06_auto_enrollment_blocked",
          entityType: "contact",
          entityId: data.contactId ?? 0,
          actorType: "system",
          details: { triggerType, sequenceId: seq.id, reasonCode: cr06EnrollmentDecision.reasonCode },
        });
        continue;
      }

      let newEnrollment: { id: number } | null = null;
      if (opts?.promotionalIntent && data.contactId) {
        const { enrollThroughCr04Fence } = await import("./cr04-cohort-ready-authority");
        const firstChannel = steps
          .map((step) => step.actionType === "email" ? "email" : step.actionType === "sms" ? "sms" : step.actionType === "task" ? "manual_call" : null)
          .find((channel): channel is "email" | "sms" | "manual_call" => channel !== null) ?? "manual_call";
        const fenced = await enrollThroughCr04Fence({
          contactId: data.contactId,
          sequenceId: seq.id,
          channel: firstChannel as "email" | "sms" | "manual_call",
          idempotencyKey: `${opts.promotionalIntent.idempotencyKey}:${seq.id}`,
          source: opts.promotionalIntent.source,
          actor: { role: "admin", actorId: opts.promotionalIntent.actorId, email: null },
          dealId: data.dealId ?? null,
          nextActionAt: new Date(Date.now() + Math.max(delayMs, 1000)),
        });
        if ((fenced as any).blocked) continue;
        if (fenced.enrollmentId) newEnrollment = { id: fenced.enrollmentId };
      } else {
        newEnrollment = await storage.createSequenceEnrollment({
          sequenceId: seq.id,
          contactId: data.contactId,
          dealId: data.dealId || undefined,
          status: "active",
          currentStep: 0,
          nextActionAt: new Date(Date.now() + Math.max(delayMs, 1000)),
        });
      }

      if (newEnrollment?.id) {
        enrollmentIds.push(newEnrollment.id);
      }

      await storage.createAuditLog({
        action: "sequence_auto_enrolled",
        entityType: "contact",
        entityId: data.contactId,
        details: {
          sequenceId: seq.id,
          sequenceName: seq.name,
          trigger: triggerType,
        },
      });

      enrolled++;
    }
  } catch (err) {
    console.error("Auto-enrollment error:", err);
  }

  return { count: enrolled, enrollmentIds, alreadyEnrolledCount };
}
