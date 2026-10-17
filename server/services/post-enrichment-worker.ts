/**
 * Post-Enrichment Automation Worker
 *
 * Processes "post-enrichment" jobs fired by writebackEnrichmentToLinkedRecords
 * whenever a contactless lead gets its first real email or phone number.
 *
 * Per job it:
 *   1. Guards against re-fires (postEnrichmentAutomationAt already set)
 *   2. Stamps the deal and writes a durable enrollment intent in ONE transaction
 *   3. Checks the deal is still in an early/contactless stage
 *   4. Advances the deal to "Enriched" stage (if the stage allows it)
 *   5. Finds the best matching vertical sequence, falls back to a generic one
 *   6. Enrolls immediately if authority+coordinator allow; defers otherwise
 *   7. Writes a nextAction string to the deal card
 *   8. Emits audit log entries at every decision point
 *
 * PRODUCT DECISION (P0-3): post-enrichment processing creates a local
 * sequence_enrollments row (canonical sequence enrollment), not just an NBA
 * recommendation. GHL sync is a subordinate step after local enrollment.
 *
 * Recovery path: recoverPendingEnrollmentIntents() is called by the
 * "post-enrichment-intent-recovery" named schedule job. It claims intents
 * with FOR UPDATE SKIP LOCKED, runs executePostEnrichmentEnrollmentIntent()
 * per row, and back-offs or fails terminal cases.
 */

import { db, pool } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { advanceDealStage } from "./deal-stage-service";
import { decideCr06SequenceLifecycle } from "./cr06-promotional-lifecycle-decision";

// Stages that are considered "contactless / early" — the worker only advances
// deals that are still in one of these stages. Any other stage means the deal
// has already been progressed by a rep and should not be touched.
const AUTO_ADVANCE_ELIGIBLE_STAGES = new Set([
  "New Lead",
]);

// Selection policy version — bump when the findSequenceForVertical logic changes
// so recovery workers can detect supersession.
const SELECTION_POLICY_VERSION = "v1";

// Lease duration for processing claims
const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Max batch size per recovery sweep
const RECOVERY_BATCH_SIZE = 10;

// Exponential back-off for retryable failures (seconds)
const BACKOFF_BASE_S = 60;
const BACKOFF_CAP_S  = 60 * 60; // 1 hour max

// ── Sequence lookup ──────────────────────────────────────────────────────────

/**
 * Find the best matching sequence for this contact's vertical.
 * Priority:
 *   1. Active sequence whose sequenceFamily exactly matches the vertical (case-insensitive)
 *   2. Active sequence whose name contains the vertical (case-insensitive)
 *   3. Active sequence whose triggerConfig.vertical matches
 *   4. Active "New Lead" fallback sequence
 *   5. Any active sequence (last resort)
 */
async function findSequenceForVertical(vertical: string | null): Promise<{
  id: number;
  name: string;
} | null> {
  // Load all active sequences once — the table is small enough
  const allSequences = await storage.getFollowUpSequences();
  const active = allSequences.filter((s: any) => s.status === "active");

  if (active.length === 0) return null;

  if (vertical) {
    const vLower = vertical.toLowerCase();

    // 1. sequenceFamily exact match
    const byFamily = active.find((s: any) =>
      typeof s.sequenceFamily === "string" &&
      s.sequenceFamily.toLowerCase() === vLower
    );
    if (byFamily) return { id: byFamily.id, name: byFamily.name };

    // 2. name contains vertical
    const byName = active.find((s: any) =>
      s.name.toLowerCase().includes(vLower)
    );
    if (byName) return { id: byName.id, name: byName.name };

    // 3. triggerConfig.vertical
    const byConfig = active.find((s: any) => {
      try {
        const cfg = typeof s.triggerConfig === "string"
          ? JSON.parse(s.triggerConfig)
          : (s.triggerConfig as Record<string, unknown> | null);
        return cfg && typeof cfg.vertical === "string" &&
          cfg.vertical.toLowerCase() === vLower;
      } catch { return false; }
    });
    if (byConfig) return { id: byConfig.id, name: byConfig.name };
  }

  // 4. Generic "New Lead" sequence
  const newLead = active.find((s: any) =>
    s.name.toLowerCase().includes("new lead") ||
    s.name.toLowerCase().includes("new_lead")
  );
  if (newLead) return { id: newLead.id, name: newLead.name };

  // 5. Any active sequence
  return { id: active[0].id, name: active[0].name };
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface PostEnrichmentJobData {
  entityId: number;
  contactId: number;
  dealId: number;
}

// ── Enrollment outcome classes ───────────────────────────────────────────────

type ErrorClass = "retryable" | "permanent" | "terminal_no_op";

interface EnrollmentOutcome {
  success: boolean;
  enrollmentId?: number;
  errorCode?: string;
  errorClass?: ErrorClass;
  reason?: string;
  eligibilitySnapshot?: Record<string, unknown>;
}

// ── Legacy enrollment containment ────────────────────────────────────────────

/**
 * This worker is a legacy producer: it picks a sequence by vertical name, inserts an
 * `active` sequence_enrollments row and then asks GHL to enroll the contact. It does not
 * use the selected-recipient, validation and ready-held preparation owners, so the global
 * outbound pause was its only fence. A pause is a temporary operating state, not an
 * authority to enroll, so the effect is contained in code: it never creates an enrollment
 * or a GHL side effect whatever the pause or coordinator state is. The deal stamp, stage
 * advance and a durable pending intent (holdReason below) are kept so the work stays
 * visible and can be routed through a reviewed release authority later.
 */
export const LEGACY_POST_ENRICHMENT_ENROLLMENT_CONTAINED = true as boolean;
export const LEGACY_POST_ENRICHMENT_CONTAINMENT_CODE = "legacy_enrollment_contained";

// ── Canonical enrollment command ─────────────────────────────────────────────

/**
 * Execute a durable post-enrichment enrollment intent.
 *
 * Contract:
 * - Re-checks OutboundPauseAuthority.authorize() and coordinator.canExecute()
 *   immediately before the enrollment effect.
 * - Re-evaluates DNC, consent, validation, eligibility, sequence state, deal
 *   policy at execution time.
 * - Creates or resolves the local sequence_enrollments row idempotently:
 *   an existing active/paused enrollment is treated as successful convergence.
 * - Records eligibility snapshot and terminal reason codes on the intent row.
 * - Performs GHL sync as a subordinate step; its failure does not fail the intent.
 * - Each terminal outcome class is handled separately.
 *
 * @param intentId - ID of the post_enrichment_enrollment_intents row to execute
 * @param dealId   - deal ID (from intent row)
 * @param contactId - contact ID (from intent row)
 * @param sequenceId - sequence ID resolved at intent-creation time
 * @param workerId - caller identity for lease attribution
 */
export async function executePostEnrichmentEnrollmentIntent(
  intentId: number,
  dealId: number,
  contactId: number,
  sequenceId: number,
  workerId: string,
): Promise<EnrollmentOutcome> {
  const logPrefix = `[PE-Enroll] intent=${intentId} deal=${dealId} contact=${contactId} seq=${sequenceId}`;

  // ── 0. Containment: no enrollment or GHL effect regardless of pause state ──
  if (LEGACY_POST_ENRICHMENT_ENROLLMENT_CONTAINED) {
    return {
      success: false,
      errorCode: LEGACY_POST_ENRICHMENT_CONTAINMENT_CODE,
      errorClass: "permanent",
      reason: "Legacy post-enrichment enrollment is contained; no enrollment or GHL effect was attempted",
    };
  }

  // ── 1. Re-check authority + coordinator immediately before effect ─────────
  const { authorize } = await import("./outbound-pause-authority");
  const { canExecute } = await import("./outbound-queue-coordinator");

  let decision: Awaited<ReturnType<typeof authorize>>;
  try {
    decision = await authorize({});
  } catch (err: any) {
    return {
      success: false,
      errorCode: "authority_check_failed",
      errorClass: "retryable",
      reason: `authorize() threw: ${err?.message}`,
    };
  }

  if (!decision.allowed) {
    return {
      success: false,
      errorCode: "outbound_paused",
      errorClass: "retryable",
      reason: `Global outbound paused: ${decision.reasonCode}`,
    };
  }

  let coordOk: boolean;
  try {
    coordOk = await canExecute("post-enrichment-enrollment");
  } catch (err: any) {
    return {
      success: false,
      errorCode: "coordinator_check_failed",
      errorClass: "retryable",
      reason: `canExecute() threw: ${err?.message}`,
    };
  }

  if (!coordOk) {
    return {
      success: false,
      errorCode: "coordinator_hold_active",
      errorClass: "retryable",
      reason: "Coordinator hold active for post-enrichment-enrollment",
    };
  }

  // ── 2. Re-evaluate contact eligibility ───────────────────────────────────
  let contact: any;
  try {
    contact = await storage.getContact(contactId);
  } catch (err: any) {
    return {
      success: false,
      errorCode: "contact_load_failed",
      errorClass: "retryable",
      reason: `getContact threw: ${err?.message}`,
    };
  }

  if (!contact) {
    return {
      success: false,
      errorCode: "contact_not_found",
      errorClass: "permanent",
      reason: "Contact not found — may have been deleted",
    };
  }

  // DNC check
  if (contact.doNotContact) {
    return {
      success: false,
      errorCode: "dnc",
      errorClass: "terminal_no_op",
      reason: "Contact marked do-not-contact",
      eligibilitySnapshot: { doNotContact: true },
    };
  }

  // Opt-out check (email_status values that indicate opted out or blocked)
  const blockedStatuses = new Set(["bounced", "spam", "unsubscribed", "invalid", "rejected"]);
  if (contact.emailStatus && blockedStatuses.has(contact.emailStatus)) {
    return {
      success: false,
      errorCode: "email_blocked",
      errorClass: "terminal_no_op",
      reason: `Email status blocked: ${contact.emailStatus}`,
      eligibilitySnapshot: { emailStatus: contact.emailStatus },
    };
  }

  // Missing email endpoint
  const email = contact.email;
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return {
      success: false,
      errorCode: "missing_email",
      errorClass: "terminal_no_op",
      reason: "Contact has no valid email address",
      eligibilitySnapshot: { email: null },
    };
  }

  // ── 3. Re-evaluate deal eligibility ──────────────────────────────────────
  let deal: any;
  try {
    deal = await storage.getDeal(dealId);
  } catch (err: any) {
    return {
      success: false,
      errorCode: "deal_load_failed",
      errorClass: "retryable",
      reason: `getDeal threw: ${err?.message}`,
    };
  }

  if (!deal) {
    return {
      success: false,
      errorCode: "deal_not_found",
      errorClass: "permanent",
      reason: "Deal not found — may have been deleted",
    };
  }

  // ── 4. Re-evaluate sequence state ────────────────────────────────────────
  let sequence: any;
  try {
    const allSeqs = await storage.getFollowUpSequences();
    sequence = allSeqs.find((s: any) => s.id === sequenceId);
  } catch (err: any) {
    return {
      success: false,
      errorCode: "sequence_load_failed",
      errorClass: "retryable",
      reason: `getFollowUpSequences threw: ${err?.message}`,
    };
  }

  if (!sequence) {
    return {
      success: false,
      errorCode: "sequence_not_found",
      errorClass: "permanent",
      reason: `Sequence id=${sequenceId} no longer exists`,
    };
  }

  if (sequence.status !== "active") {
    return {
      success: false,
      errorCode: "sequence_inactive",
      errorClass: "permanent",
      reason: `Sequence "${sequence.name}" is not active (status=${sequence.status})`,
      eligibilitySnapshot: { sequenceStatus: sequence.status },
    };
  }
  const cr06Decision = decideCr06SequenceLifecycle(sequence);
  if (!cr06Decision.allowed) {
    return {
      success: false,
      errorCode: "cr06_promotional_execution_disabled",
      errorClass: "permanent",
      reason: cr06Decision.reasonCode,
    };
  }

  // ── 5. Idempotent enrollment effect ──────────────────────────────────────
  // Use raw SQL INSERT with ON CONFLICT (contact_id, sequence_id) WHERE status IN ('active','paused')
  // The partial unique index idx_sequence_enrollments_active_unique is the convergence backstop.
  const eligibilitySnapshot: Record<string, unknown> = {
    email,
    emailStatus:  contact.emailStatus ?? "unvalidated",
    doNotContact: contact.doNotContact ?? false,
    dealStage:    deal.stage,
    sequenceName: sequence.name,
    sequenceStatus: sequence.status,
    checkedAt:    new Date().toISOString(),
  };

  let enrollmentId: number | null = null;
  let convergenceExisting = false;

  try {
    // Attempt insert; ON CONFLICT DO NOTHING if already active/paused
    const insertResult = await pool.query<{ id: number }>(
      `INSERT INTO sequence_enrollments
         (sequence_id, contact_id, deal_id, status, current_step, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', 0, NOW(), NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [sequenceId, contactId, dealId],
    );

    if (insertResult.rows.length > 0) {
      enrollmentId = insertResult.rows[0].id;
      console.log(`${logPrefix} — created new enrollment id=${enrollmentId}`);
    } else {
      // Conflict: find the existing active/paused enrollment
      const existing = await pool.query<{ id: number }>(
        `SELECT id FROM sequence_enrollments
         WHERE contact_id = $1 AND sequence_id = $2
           AND status IN ('active', 'paused')
         LIMIT 1`,
        [contactId, sequenceId],
      );
      if (existing.rows.length > 0) {
        enrollmentId = existing.rows[0].id;
        convergenceExisting = true;
        console.log(`${logPrefix} — converged to existing enrollment id=${enrollmentId}`);
      } else {
        // Edge case: conflict but no active/paused row found (completed/cancelled)
        // Count as a terminal no-op convergence
        console.log(`${logPrefix} — contact already completed/cancelled in this sequence`);
        return {
          success: true,
          errorCode: "already_enrolled_completed",
          errorClass: "terminal_no_op",
          reason: "Contact already has a completed/cancelled enrollment in this sequence",
          eligibilitySnapshot,
        };
      }
    }
  } catch (err: any) {
    return {
      success: false,
      errorCode: "enrollment_insert_failed",
      errorClass: "retryable",
      reason: `sequence_enrollments INSERT threw: ${err?.message}`,
      eligibilitySnapshot,
    };
  }

  await storage.createAuditLog({
    action: "post_enrichment_sequence_enrollment",
    entityType: "deal",
    entityId: dealId,
    details: {
      contactId,
      sequenceId,
      sequenceName: sequence.name,
      enrollmentId,
      convergenceExisting,
      intentId,
      worker: workerId,
    },
  }).catch((e: any) => console.warn(`${logPrefix} — audit log failed (non-fatal): ${e?.message}`));

  // ── 6. GHL sync (subordinate — its failure does not fail the intent) ──────
  try {
    const { enrollContactInGhlWorkflow } = await import("./ghl-workflow-enrollment");
    await enrollContactInGhlWorkflow({
      contactId,
      sequenceName: sequence.name,
      sequenceId,
      vertical: contact.vertical ?? deal.vertical ?? undefined,
      dealId,
      outboundChannels: ["email"],
    });
    console.log(`${logPrefix} — GHL sync complete`);
  } catch (ghlErr: any) {
    // GHL sync failure is non-fatal; the local enrollment is the source of truth.
    console.warn(`${logPrefix} — GHL sync failed (non-fatal): ${ghlErr?.message}`);
    await storage.createAuditLog({
      action: "post_enrichment_ghl_sync_failed",
      entityType: "deal",
      entityId: dealId,
      details: { intentId, enrollmentId, error: ghlErr?.message },
    }).catch(() => {/* ignore */});
  }

  return {
    success: true,
    enrollmentId: enrollmentId ?? undefined,
    eligibilitySnapshot,
    reason: convergenceExisting ? "converged_to_existing" : "enrolled",
  };
}

// ── Recovery worker ──────────────────────────────────────────────────────────

/**
 * Recover pending post-enrichment enrollment intents.
 *
 * Claims batches atomically via UPDATE ... RETURNING with FOR UPDATE SKIP LOCKED.
 * Handles expired leases by re-claiming after lease_expires_at.
 * Uses bounded exponential back-off with jitter on retryable failures.
 * Stops at max_attempts. Marks terminal failures as failed without retrying.
 *
 * On coordinator block mid-batch, stops cleanly (unclaimed rows remain pending).
 *
 * @param workerId - unique identity for this worker instance (for claimed_by)
 */
export async function recoverPendingEnrollmentIntents(workerId: string): Promise<{
  claimed: number;
  completed: number;
  failed: number;
  deferred: number;
  blockedByCoordinator: boolean;
}> {
  const logPrefix = `[PE-Recovery] worker=${workerId}`;

  const stats = { claimed: 0, completed: 0, failed: 0, deferred: 0, blockedByCoordinator: false };

  // Contained producer: claim nothing, so pending intents keep their state and attempt counts.
  if (LEGACY_POST_ENRICHMENT_ENROLLMENT_CONTAINED) {
    console.log(`${logPrefix} — legacy enrollment contained, no intents claimed`);
    return stats;
  }

  // Check coordinator first (batch-level early exit)
  try {
    const { canExecute } = await import("./outbound-queue-coordinator");
    const coordOk = await canExecute("post-enrichment-enrollment");
    if (!coordOk) {
      console.log(`${logPrefix} — coordinator hold active, skipping batch`);
      stats.blockedByCoordinator = true;
      return stats;
    }
  } catch (err: any) {
    console.warn(`${logPrefix} — coordinator check failed (fail-closed): ${err?.message}`);
    stats.blockedByCoordinator = true;
    return stats;
  }

  // Claim a batch atomically: pending rows that are eligible, or expired processing leases
  const claimResult = await pool.query<{
    id: number;
    deal_id: number;
    contact_id: number;
    sequence_id: number | null;
    attempts: number;
    max_attempts: number;
    claim_token: string;
  }>(
    `UPDATE post_enrichment_enrollment_intents
     SET
       status          = 'processing',
       claim_token     = gen_random_uuid(),
       claimed_at      = NOW(),
       lease_expires_at = NOW() + INTERVAL '5 minutes',
       claimed_by      = $1,
       attempts        = attempts + 1,
       updated_at      = NOW()
     WHERE id IN (
       SELECT id FROM post_enrichment_enrollment_intents
       WHERE (
           status = 'pending'
           AND (eligible_after IS NULL OR eligible_after <= NOW())
         ) OR (
           status = 'processing'
           AND lease_expires_at < NOW()
         )
       ORDER BY created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, deal_id, contact_id, sequence_id, attempts, max_attempts, claim_token`,
    [workerId, RECOVERY_BATCH_SIZE],
  );

  stats.claimed = claimResult.rows.length;
  if (stats.claimed === 0) {
    console.log(`${logPrefix} — no eligible intents to recover`);
    return stats;
  }

  console.log(`${logPrefix} — claimed ${stats.claimed} intent(s)`);

  for (const row of claimResult.rows) {
    const rowPrefix = `${logPrefix} intent=${row.id} deal=${row.deal_id}`;

    // Per-row authority + coordinator re-check (required by contract)
    // If mid-batch the authority changes, stop cleanly.
    try {
      const { authorize } = await import("./outbound-pause-authority");
      const { canExecute } = await import("./outbound-queue-coordinator");
      const dec = await authorize({});
      const coord = dec.allowed ? await canExecute("post-enrichment-enrollment") : false;
      if (!dec.allowed || !coord) {
        console.log(`${rowPrefix} — authority/coordinator blocked mid-batch, releasing row to pending`);
        await pool.query(
          `UPDATE post_enrichment_enrollment_intents
           SET status = 'pending', claim_token = NULL, claimed_at = NULL,
               lease_expires_at = NULL, claimed_by = NULL, updated_at = NOW()
           WHERE id = $1 AND claim_token = $2`,
          [row.id, row.claim_token],
        );
        stats.blockedByCoordinator = true;
        // Stop processing further rows in this batch
        break;
      }
    } catch (err: any) {
      console.warn(`${rowPrefix} — per-row authority check failed, releasing: ${err?.message}`);
      await pool.query(
        `UPDATE post_enrichment_enrollment_intents
         SET status = 'pending', claim_token = NULL, claimed_at = NULL,
             lease_expires_at = NULL, claimed_by = NULL, updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      ).catch(() => {/* ignore */});
      stats.blockedByCoordinator = true;
      break;
    }

    // Sequence_id must be set; if null the row was a pre-0138 orphan that should
    // have been failed in migration but wasn't (defensive check).
    if (!row.sequence_id) {
      await pool.query(
        `UPDATE post_enrichment_enrollment_intents
         SET status = 'failed', last_error_code = 'missing_sequence_id',
             last_error_class = 'permanent', updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      stats.failed++;
      continue;
    }

    // Execute canonical enrollment command
    let outcome: EnrollmentOutcome;
    try {
      outcome = await executePostEnrichmentEnrollmentIntent(
        row.id,
        row.deal_id,
        row.contact_id,
        row.sequence_id,
        workerId,
      );
    } catch (err: any) {
      outcome = {
        success: false,
        errorCode: "unexpected_exception",
        errorClass: "retryable",
        reason: err?.message ?? "unexpected exception",
      };
    }

    if (outcome.success) {
      // Mark completed
      await pool.query(
        `UPDATE post_enrichment_enrollment_intents
         SET status = 'completed',
             completed_enrollment_id = $2,
             last_error_code = $3,
             last_error_class = NULL,
             selection_snapshot = $4,
             processed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [
          row.id,
          outcome.enrollmentId ?? null,
          outcome.errorCode ?? null,
          outcome.eligibilitySnapshot ? JSON.stringify(outcome.eligibilitySnapshot) : null,
        ],
      );
      stats.completed++;
      console.log(`${rowPrefix} — completed (enrollmentId=${outcome.enrollmentId ?? "convergence"})`);
    } else {
      const errorClass = outcome.errorClass ?? "retryable";

      if (errorClass === "terminal_no_op" || errorClass === "permanent") {
        // Do not retry — mark failed immediately
        await pool.query(
          `UPDATE post_enrichment_enrollment_intents
           SET status = 'failed',
               last_error_code = $2,
               last_error_class = $3,
               selection_snapshot = $4,
               processed_at = NOW(),
               updated_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            outcome.errorCode ?? "unknown_permanent",
            errorClass,
            outcome.eligibilitySnapshot ? JSON.stringify(outcome.eligibilitySnapshot) : null,
          ],
        );
        stats.failed++;
        console.log(`${rowPrefix} — permanently failed: ${outcome.errorCode} (${errorClass})`);
      } else {
        // Retryable: apply back-off or exhaust attempts
        const attemptsAfter = row.attempts; // already incremented by claim UPDATE
        if (attemptsAfter >= row.max_attempts) {
          await pool.query(
            `UPDATE post_enrichment_enrollment_intents
             SET status = 'failed',
                 last_error_code = $2,
                 last_error_class = 'permanent',
                 last_error = $3,
                 processed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [row.id, outcome.errorCode ?? "max_attempts_exceeded", outcome.reason ?? null],
          );
          stats.failed++;
          console.log(`${rowPrefix} — exhausted attempts (${attemptsAfter}/${row.max_attempts}): ${outcome.errorCode}`);
        } else {
          // Exponential back-off with jitter, capped at BACKOFF_CAP_S
          const backoffS = Math.min(BACKOFF_CAP_S, BACKOFF_BASE_S * Math.pow(2, attemptsAfter - 1));
          const jitterS  = Math.floor(Math.random() * backoffS * 0.25);
          const totalS   = backoffS + jitterS;

          await pool.query(
            `UPDATE post_enrichment_enrollment_intents
             SET status = 'pending',
                 claim_token = NULL,
                 claimed_at = NULL,
                 lease_expires_at = NULL,
                 claimed_by = NULL,
                 last_error_code = $2,
                 last_error_class = 'retryable',
                 last_error = $3,
                 eligible_after = NOW() + ($4 || ' seconds')::INTERVAL,
                 updated_at = NOW()
             WHERE id = $1`,
            [row.id, outcome.errorCode ?? "retryable_error", outcome.reason ?? null, totalS],
          );
          stats.deferred++;
          console.log(`${rowPrefix} — retryable (attempt ${attemptsAfter}/${row.max_attempts}), back-off ${totalS}s: ${outcome.errorCode}`);
        }
      }
    }
  }

  console.log(`${logPrefix} — sweep complete: claimed=${stats.claimed} completed=${stats.completed} failed=${stats.failed} deferred=${stats.deferred} coordBlocked=${stats.blockedByCoordinator}`);
  return stats;
}

// ── Main processor (event-driven path) ───────────────────────────────────────

export async function processPostEnrichmentJob(data: PostEnrichmentJobData): Promise<void> {
  const { entityId, contactId, dealId } = data;

  const logPrefix = `[PostEnrich] entity=${entityId} contact=${contactId} deal=${dealId}`;

  // ── 1. Guard: already processed? ─────────────────────────────────────────
  const deal = await storage.getDeal(dealId);
  if (!deal) {
    console.warn(`${logPrefix} — deal not found, skipping`);
    return;
  }

  if ((deal as any).postEnrichmentAutomationAt) {
    console.log(`${logPrefix} — already processed at ${(deal as any).postEnrichmentAutomationAt}, skipping`);
    return;
  }

  // ── 2. Resolve vertical and sequence BEFORE the transaction ──────────────
  // We need the sequence_id for the transactional intent row.
  let vertical: string | null = (deal as any).vertical ?? null;
  if (!vertical) {
    try {
      const contact = await storage.getContact(contactId);
      vertical = contact?.vertical ?? null;
    } catch { /* non-critical */ }
  }

  const sequence = await findSequenceForVertical(vertical);

  // ── Phase A + B: Atomic transaction ──────────────────────────────────────
  // Write the deal phase marker AND the enrollment intent in one transaction.
  // A crash/failure anywhere rolls back both — no stranded stamps without intents.
  // If enrollment is currently allowed, we enroll immediately (no intent row).
  // If enrollment is deferred, we write a durable intent row.

  const { authorize } = await import("./outbound-pause-authority");
  const { canExecute } = await import("./outbound-queue-coordinator");

  const decision = await authorize({});
  const coordOk = decision.allowed ? await canExecute("post-enrichment-enrollment") : false;
  const enrollNow = !LEGACY_POST_ENRICHMENT_ENROLLMENT_CONTAINED && decision.allowed && coordOk;
  const holdReason = LEGACY_POST_ENRICHMENT_ENROLLMENT_CONTAINED
    ? LEGACY_POST_ENRICHMENT_CONTAINMENT_CODE
    : !decision.allowed ? decision.reasonCode : "coordinator-hold";

  if (!sequence) {
    // No sequences at all — stamp the deal (no enrollment possible), no intent row
    await db.execute(sql`
      UPDATE deals
      SET post_enrichment_automation_at = NOW(),
          next_action = ${'Manual review — no active sequence found'},
          updated_at = NOW()
      WHERE id = ${dealId}
        AND post_enrichment_automation_at IS NULL
    `);
    await storage.createAuditLog({
      action: "post_enrichment_no_sequence",
      entityType: "deal",
      entityId: dealId,
      details: { vertical, reason: "No active sequences found in system" },
    });
    console.warn(`${logPrefix} — no active sequences found, wrote manual-review nextAction`);
    // Continue to stage advance below
  } else if (enrollNow) {
    // Immediate-enroll path: STILL write the intent row (status='processing') + deal stamp
    // in one transaction so the stamp NEVER commits without a durable command record.
    // If the intent INSERT fails, the BullMQ job retries and the stamp is NOT committed.
    const idempotencyKey = `pe-enroll-${dealId}-${sequence.id}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE deals
         SET post_enrichment_automation_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND post_enrichment_automation_at IS NULL`,
        [dealId],
      );
      await client.query(
        `INSERT INTO post_enrichment_enrollment_intents
           (deal_id, contact_id, entity_id, idempotency_key, status,
            sequence_id, purpose, channels, selection_policy_version,
            selection_snapshot, max_attempts, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'processing',
                 $5, 'post_enrichment_cold_outreach', $6, $7, $8, 5, NOW(), NOW())
         ON CONFLICT (idempotency_key) DO UPDATE
           SET status = 'processing', updated_at = NOW()`,
        [
          dealId, contactId, entityId ?? null, idempotencyKey, sequence.id,
          JSON.stringify(["email"]), SELECTION_POLICY_VERSION,
          JSON.stringify({
            sequenceId: sequence.id, sequenceName: sequence.name, vertical,
            selectionPolicyVersion: SELECTION_POLICY_VERSION,
            decidedAt: new Date().toISOString(), path: "immediate",
          }),
        ],
      );
      await client.query("COMMIT");
    } catch (txErr: any) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw new Error(`[PostEnrich] Transactional intent write (immediate) failed: ${txErr?.message}`);
    } finally {
      client.release();
    }
  } else {
    // Deferred: stamp deal + write intent in one atomic transaction.
    // If the intent INSERT fails, the entire transaction rolls back and the BullMQ
    // job will be retried — the stamp is NOT committed without a durable intent.
    const idempotencyKey = `pe-enroll-${dealId}-${sequence.id}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE deals
         SET post_enrichment_automation_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND post_enrichment_automation_at IS NULL`,
        [dealId],
      );

      // Insert intent row — NOT wrapped in try/catch; errors propagate and roll back the deal stamp
      await client.query(
        `INSERT INTO post_enrichment_enrollment_intents
           (deal_id, contact_id, entity_id, idempotency_key, status,
            sequence_id, purpose, channels, selection_policy_version,
            selection_snapshot, max_attempts, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending',
                 $5, 'post_enrichment_cold_outreach', $6, $7,
                 $8, 5, NOW(), NOW())
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          dealId,
          contactId,
          entityId ?? null,
          idempotencyKey,
          sequence.id,
          JSON.stringify(["email"]),
          SELECTION_POLICY_VERSION,
          JSON.stringify({
            sequenceId:   sequence.id,
            sequenceName: sequence.name,
            vertical,
            selectionPolicyVersion: SELECTION_POLICY_VERSION,
            decidedAt: new Date().toISOString(),
            holdReason,
          }),
        ],
      );

      await client.query("COMMIT");
    } catch (txErr: any) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      // Propagate: BullMQ job will retry; the deal stamp was NOT committed
      throw new Error(`[PostEnrich] Transactional intent write failed: ${txErr?.message}`);
    } finally {
      client.release();
    }

    await storage.createAuditLog({
      action: "post_enrichment_enrollment_deferred",
      entityType: "deal",
      entityId: dealId,
      details: {
        contactId,
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        vertical,
        holdReason,
        idempotencyKey,
      },
    });
    await db.execute(sql`
      UPDATE deals SET next_action = ${LEGACY_POST_ENRICHMENT_ENROLLMENT_CONTAINED
        ? 'Enrollment held — legacy auto-enrollment is contained'
        : 'Enrollment deferred — outbound hold active'}, updated_at = NOW()
      WHERE id = ${dealId}
    `);
    console.log(`${logPrefix} — enrollment deferred (hold active), intent written as ${idempotencyKey}`);
  }

  await storage.createAuditLog({
    action: "post_enrichment_automation_started",
    entityType: "deal",
    entityId: dealId,
    details: { entityId, contactId, dealId, stage: deal.stage, enrollNow },
  });

  // ── 3. Stage advancement ──────────────────────────────────────────────────
  const stageEligible = AUTO_ADVANCE_ELIGIBLE_STAGES.has(deal.stage ?? "");

  if (stageEligible) {
    try {
      await advanceDealStage(dealId, "Enriched", "post_enrichment_automation", {
        reason: "Enrichment found first contact info for contactless lead",
        actor: "system",
      });
      await storage.createAuditLog({
        action: "post_enrichment_stage_advanced",
        entityType: "deal",
        entityId: dealId,
        details: { fromStage: deal.stage, toStage: "Enriched", trigger: "post_enrichment_automation" },
      });
      console.log(`${logPrefix} — advanced from "${deal.stage}" → "Enriched"`);
    } catch (err: any) {
      // advanceDealStage can throw GoLiveGateError for onboarding deals — non-fatal
      console.warn(`${logPrefix} — stage advance failed (non-fatal): ${err?.message}`);
      await storage.createAuditLog({
        action: "post_enrichment_stage_advance_skipped",
        entityType: "deal",
        entityId: dealId,
        details: { stage: deal.stage, reason: err?.message || "unknown" },
      });
    }
  } else {
    console.log(`${logPrefix} — stage "${deal.stage}" not eligible for auto-advance, skipping stage change`);
    await storage.createAuditLog({
      action: "post_enrichment_stage_advance_skipped",
      entityType: "deal",
      entityId: dealId,
      details: { stage: deal.stage, reason: "Stage not in auto-advance eligible set" },
    });
  }

  // ── 4. Immediate enrollment path ──────────────────────────────────────────
  if (!enrollNow || !sequence) return; // deferred or no sequence — done

  const workerId = `pe-direct-${process.pid}`;
  let outcome: EnrollmentOutcome;
  try {
    // The intent row was already written (status='processing') in the atomic
    // transaction above. Resolve its ID so we can update it after execution.
    const idempotencyKey = `pe-enroll-${dealId}-${sequence.id}`;
    const intentResult = await pool.query<{ id: number }>(
      `SELECT id FROM post_enrichment_enrollment_intents
       WHERE idempotency_key = $1
       LIMIT 1`,
      [idempotencyKey],
    );
    const intentId = intentResult.rows[0]?.id;

    outcome = await executePostEnrichmentEnrollmentIntent(
      intentId ?? 0, dealId, contactId, sequence.id, workerId,
    );

    // Mark the intent completed/failed based on outcome
    if (intentId) {
      if (outcome.success) {
        await pool.query(
          `UPDATE post_enrichment_enrollment_intents
           SET status = 'completed', completed_enrollment_id = $2,
               selection_snapshot = $3, processed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [intentId, outcome.enrollmentId ?? null, JSON.stringify(outcome.eligibilitySnapshot ?? {})],
        );
      } else {
        const isTerminal = outcome.errorClass === "terminal_no_op" || outcome.errorClass === "permanent";
        await pool.query(
          `UPDATE post_enrichment_enrollment_intents
           SET status = $2, last_error_code = $3, last_error_class = $4,
               selection_snapshot = $5, processed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [
            intentId,
            isTerminal ? "failed" : "pending",
            outcome.errorCode ?? null,
            outcome.errorClass ?? null,
            JSON.stringify(outcome.eligibilitySnapshot ?? {}),
          ],
        );
      }
    }
  } catch (err: any) {
    outcome = { success: false, errorCode: "enrollment_threw", errorClass: "retryable", reason: err?.message };
    console.error(`${logPrefix} — enrollment threw: ${err?.message}`);
  }

  await storage.createAuditLog({
    action: "post_enrichment_sequence_enrollment",
    entityType: "deal",
    entityId: dealId,
    details: {
      contactId,
      sequenceId: sequence.id,
      sequenceName: sequence.name,
      vertical,
      success: outcome.success,
      errorCode: outcome.errorCode,
      errorClass: outcome.errorClass,
      enrollmentId: outcome.enrollmentId,
    },
  });

  // ── 5. Write nextAction chip to deal ──────────────────────────────────────
  let nextAction: string;
  if (outcome.success) {
    const vertLabel = vertical ? `${vertical} lead` : "lead";
    nextAction = `Enrolled — enriched ${vertLabel}, sequence started`;
  } else if (outcome.errorClass === "terminal_no_op") {
    nextAction = "Manual review — contact blocked from auto-outreach";
  } else {
    nextAction = `Manual outreach — enriched${vertical ? `, ${vertical}` : ""}, no auto-enrollment`;
  }

  await db.execute(sql`
    UPDATE deals SET next_action = ${nextAction}, updated_at = NOW() WHERE id = ${dealId}
  `);

  await storage.createAuditLog({
    action: "post_enrichment_next_action_set",
    entityType: "deal",
    entityId: dealId,
    details: { nextAction, success: outcome.success, sequenceId: sequence.id },
  });

  console.log(`${logPrefix} — complete. nextAction="${nextAction}", success=${outcome.success}`);
}
