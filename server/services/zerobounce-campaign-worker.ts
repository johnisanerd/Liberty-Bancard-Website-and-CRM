/**
 * ZeroBounce Durable Batch Campaign Worker (task #1541 / 1540B)
 *
 * Processes `zerobounce-batch-validate` BullMQ jobs with `{ runId }` payload.
 * Replaces the old setImmediate fire-and-forget batch loop.
 *
 * Guarantees:
 *  - Atomic per-contact claim: INSERT into zerobounce_attempts with
 *    ON CONFLICT (campaign_id, contact_id) DO NOTHING before touching the
 *    provider — a contact can never be double-charged within a campaign.
 *  - Durable: run state lives in zerobounce_runs; a heartbeat is written every
 *    HEARTBEAT_EVERY contacts so a crashed/restarted server leaves a run that
 *    is detectable as stalled (markStaleRunsInterrupted) instead of stuck
 *    "running" forever.
 *  - Cancellation: cancel_requested is polled between contacts.
 *  - Accounting: zerobounce_attempts is the source of truth for all counts;
 *    the counter columns on zerobounce_runs are a denormalized copy refreshed
 *    from attempts at every heartbeat and on exit.
 *
 * NOTE on credits: credit_state records whether validation work reached the
 * provider-operation reservation stage; it is reporting/reconciliation state,
 * not an application-local credit ceiling.
 */

import { db, pool } from "../db";
import { storage } from "../storage";
import { createValidationIntent, hashEmailToken, processValidationIntent } from "./provider-readiness-control";
import {
  buildZbEligibilityWhere,
  isPlaceholderEmail,
  isRetryableZbFailure,
  isZeroBounceConfigured,
  type ZbCampaignFilter,
} from "./zerobounce-eligibility";
import type { ZeroBounceResult } from "./sdr/zerobounce";

const HEARTBEAT_EVERY = 10;          // contacts between heartbeat writes
const HEARTBEAT_MAX_MS = 15_000;     // max wall-clock gap between heartbeats regardless of contact count
export const STALE_RUN_MS = 5 * 60 * 1000; // >5 min without heartbeat ⇒ interrupted
const SELECT_CHUNK = 50;             // candidate ids fetched per DB round-trip

export interface ZbWorkerDeps {
  verifyEmail: (email: string) => Promise<ZeroBounceResult>;
  hasProviderKey: () => boolean;
}

async function defaultDeps(): Promise<ZbWorkerDeps> {
  const { verifyEmail } = await import("./sdr/zerobounce");
  return { verifyEmail, hasProviderKey: isZeroBounceConfigured };
}

/**
 * Mark any run stuck in state='running' with a heartbeat older than 5 minutes
 * as 'interrupted'. Called from the campaign GET handler, from the worker
 * before starting a run, and safe to call anywhere. Returns rows updated.
 */
export async function markStaleRunsInterrupted(): Promise<number> {
  const r = await pool.query(
    `UPDATE zerobounce_runs
        SET state = 'interrupted',
            stop_reason = 'stale_heartbeat',
            finished_at = NOW()
      WHERE state = 'running'
        AND COALESCE(last_heartbeat_at, started_at) < NOW() - INTERVAL '5 minutes'`,
  );
  await reconcilePendingAttempts();
  return r.rowCount ?? 0;
}

/**
 * Admin cancellation of a campaign by any of its run IDs (in-flight OR
 * terminal). Cancelling always abandons the whole campaign — even when the
 * referenced run is already budget_stopped/completed/interrupted — so a
 * subsequent batch start creates a FRESH campaign from its own filter.
 * If the run is still running, its cancel flag is also set; the worker polls
 * it between contacts and exits cleanly with stop_reason='cancelled'.
 */
export async function cancelZeroBounceCampaignByRun(runId: string): Promise<
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "nothing_to_cancel"; runState: string }
  | { ok: true; campaignId: string; runState: string; runCancelRequested: boolean; campaignCancelled: boolean }
> {
  const run = (await pool.query(
    `SELECT id, state, campaign_id FROM zerobounce_runs WHERE id = $1`, [runId],
  )).rows[0];
  if (!run) return { ok: false, reason: "not_found" };

  let runCancelRequested = false;
  if (run.state === "running") {
    await pool.query(`UPDATE zerobounce_runs SET cancel_requested = TRUE WHERE id = $1`, [runId]);
    runCancelRequested = true;
  }
  const campaignCancel = await pool.query(
    `UPDATE zerobounce_campaigns
        SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND status = 'active'
      RETURNING id`,
    [run.campaign_id],
  );
  const campaignCancelled = (campaignCancel.rowCount ?? 0) > 0;
  if (!runCancelRequested && !campaignCancelled) {
    return { ok: false, reason: "nothing_to_cancel", runState: run.state };
  }
  return { ok: true, campaignId: run.campaign_id, runState: run.state, runCancelRequested, campaignCancelled };
}

/**
 * Crash-window reconciliation: resolve 'pending' attempts left behind by runs
 * that are no longer running. The credit_state column tells us which crash
 * window the row died in:
 *
 *  - credit_state='none'     ⇒ crashed AFTER claim, BEFORE claiming a credit /
 *    calling the provider. Safe to RELEASE (delete) — the contact becomes
 *    claimable again and will be validated by the next run.
 *  - credit_state='reserved' ⇒ a local credit was claimed and the provider MAY
 *    have been called (crashed mid-flight or before the result was written).
 *    We cannot know whether ZeroBounce billed it, so the attempt is finalized
 *    as retryable_failed (error_code='interrupted_midflight'): email_status is
 *    left untouched and the contact is NOT re-charged within this campaign.
 *
 * After reconciliation no terminal run can own a pending attempt, so campaign
 * completion (which is additionally gated on zero pending attempts) is safe.
 */
export async function reconcilePendingAttempts(): Promise<{ released: number; finalized: number }> {
  const del = await pool.query(
    `DELETE FROM zerobounce_attempts a
      USING zerobounce_runs r
      WHERE a.run_id = r.id
        AND r.state <> 'running'
        AND a.outcome = 'pending'
        AND a.credit_state = 'none'`,
  );
  const upd = await pool.query(
    `UPDATE zerobounce_attempts a
        SET outcome = 'retryable_failed', retryable = TRUE,
            error_code = 'interrupted_midflight', updated_at = NOW()
       FROM zerobounce_runs r
      WHERE a.run_id = r.id
        AND r.state <> 'running'
        AND a.outcome = 'pending'
        AND a.credit_state = 'reserved'`,
  );
  return { released: del.rowCount ?? 0, finalized: upd.rowCount ?? 0 };
}

/** Refresh the run's denormalized counters from zerobounce_attempts (source of truth). */
async function syncRunCounters(runId: string, heartbeat: boolean): Promise<void> {
  await pool.query(
    `UPDATE zerobounce_runs r SET
        claimed_count   = a.claimed,
        completed_count = a.completed,
        retryable_count = a.retryable,
        skipped_count   = a.skipped,
        error_count     = a.errors,
        valid_count     = a.valid,
        blocked_count   = a.blocked
        ${heartbeat ? ", last_heartbeat_at = NOW()" : ""}
      FROM (
        SELECT
          COUNT(*)::int                                                    AS claimed,
          COUNT(*) FILTER (WHERE outcome = 'completed')::int               AS completed,
          COUNT(*) FILTER (WHERE outcome = 'retryable_failed')::int        AS retryable,
          COUNT(*) FILTER (WHERE outcome = 'skipped')::int                 AS skipped,
          COUNT(*) FILTER (WHERE outcome = 'error')::int                   AS errors,
          COUNT(*) FILTER (WHERE provider_status = 'valid')::int           AS valid,
          COUNT(*) FILTER (WHERE provider_status = 'unsafe')::int          AS blocked
        FROM zerobounce_attempts WHERE run_id = $1
      ) a
      WHERE r.id = $1`,
    [runId],
  );
}

async function finishRun(runId: string, state: string, stopReason: string | null): Promise<void> {
  await syncRunCounters(runId, true);
  await pool.query(
    `UPDATE zerobounce_runs
        SET state = $2, stop_reason = $3, finished_at = NOW()
      WHERE id = $1 AND state = 'running'`,
    [runId, state, stopReason],
  );
}

async function isCancelRequested(runId: string): Promise<boolean> {
  const r = await pool.query(`SELECT cancel_requested FROM zerobounce_runs WHERE id = $1`, [runId]);
  return r.rows[0]?.cancel_requested === true;
}

/**
 * Select the next chunk of contact IDs eligible for this campaign that have
 * not yet been claimed (no zerobounce_attempts row for this campaign).
 */
async function selectNextCandidates(
  campaignId: string,
  filter: ZbCampaignFilter,
  limit: number,
): Promise<number[]> {
  const where = buildZbEligibilityWhere(filter);
  const r = await pool.query(
    `SELECT c.id FROM contacts c
      WHERE ${where}
        AND NOT EXISTS (
          SELECT 1 FROM zerobounce_attempts a
           WHERE a.campaign_id = $1 AND a.contact_id = c.id
        )
      ORDER BY COALESCE(c.lead_score, 0) DESC, c.id
      LIMIT $2`,
    [campaignId, limit],
  );
  return r.rows.map((row: any) => row.id);
}

export type ZbRunExit =
  | "completed"          // cohort exhausted or contact_limit reached
  | "budget_stopped"
  | "cancelled"
  | "error"
  | "not_running";       // run was not in state 'running' (already terminal / interrupted)

export type ZbAutoRunOutcome =
  | { outcome: "skipped"; reason: string }
  | { outcome: "already_running"; runId: string }
  | { outcome: "enqueued"; runId: string; bullJobId: string }
  | { outcome: "enqueue_failed"; runId: string }
  | { outcome: "error"; error: string };

/**
 * Daily automated ZeroBounce validation runner (#1616).
 *
 * Called by the "zerobounce-auto-run" BullMQ named schedule (6 AM UTC daily).
 * Performs all the same safety checks as the manual POST
 * /api/contacts/validate-emails-batch route, then creates the campaign/run and
 * enqueues the durable "run" job that actually validates contacts.
 *
 * Admin gate: reads zerobounce_auto_run_enabled from system_settings.
 * Set it to true to enable daily auto-runs; any falsy value disables.
 *
 * Writes an audit log entry on every invocation (including no-ops) so admins
 * can verify the scheduled job is firing and see why it skipped when it did.
 */
/**
 * The unattended auto-run builds a campaign from a universe-wide filter (every unvalidated
 * address), not from selected recipients, so the admin flag alone must not be able to start
 * it. It stays contained until it is rebuilt on an explicit selected-contact scope (the
 * `contactIds` filter). Operator-launched campaigns keep their own explicit request, the
 * DBPR-lineage fence and the provider control.
 */
export const ZB_UNATTENDED_BROAD_AUTO_RUN_CONTAINED = true as boolean;

export async function runZeroBounceAutoRun(): Promise<ZbAutoRunOutcome> {
  try {
    if (ZB_UNATTENDED_BROAD_AUTO_RUN_CONTAINED) {
      await storage.createAuditLog({
        action: "zerobounce_auto_run_skipped",
        entityType: "system",
        entityId: 0,
        actorType: "system",
        actorId: "zerobounce-auto-run",
        details: { reason: "broad_universe_auto_run_contained" },
      });
      console.log("[ZB auto-run] Skipped — unattended universe-wide auto-run is contained");
      return { outcome: "skipped", reason: "broad_universe_auto_run_contained" };
    }
    // ── 1. Feature gate: admin must explicitly enable auto-runs ──────────────
    const enabled = await storage.getSystemSetting("zerobounce_auto_run_enabled");
    if (!enabled) {
      console.log("[ZB auto-run] Skipped — zerobounce_auto_run_enabled is not set or false");
      return { outcome: "skipped", reason: "feature_disabled" };
    }

    // ── 2. Control-plane gate: configuration alone never authorizes spend. ──
    const control = await pool.query(
      `SELECT enabled, circuit_state FROM provider_controls WHERE provider = 'zerobounce'`,
    );
    if (!control.rows[0]?.enabled || control.rows[0]?.circuit_state !== "closed") {
      await storage.createAuditLog({
        action: "zerobounce_auto_run_skipped",
        entityType: "system",
        entityId: 0,
        actorType: "system",
        actorId: "zerobounce-auto-run",
        details: { reason: "provider_control_unavailable" },
      });
      console.warn("[ZB auto-run] Skipped — provider control is disabled or unavailable");
      return { outcome: "skipped", reason: "provider_control_unavailable" };
    }

    // ── 3. Stale-run cleanup: heal any run orphaned by a prior crash ──────────
    await markStaleRunsInterrupted();

    // ── 5. Find or create the active campaign ─────────────────────────────────
    // Default filter matches the manual-trigger defaults: all unvalidated emails,
    // no minimum lead score. Prioritised by lead score DESC (highest-value first).
    let campaign = (await pool.query(
      `SELECT * FROM zerobounce_campaigns WHERE status = 'active' LIMIT 1`,
    )).rows[0];

    if (!campaign) {
      const filter: ZbCampaignFilter = { issue: "unvalidated_email", minLeadScore: 0 };
      const { buildZbEligibilityWhere } = await import("./zerobounce-eligibility");
      const totalRow = await pool.query(
        `SELECT COUNT(*)::int AS n FROM contacts c WHERE ${buildZbEligibilityWhere(filter)}`,
      );
      const initialTotal = totalRow.rows[0]?.n ?? 0;
      // Partial unique index zb_campaigns_one_active_idx makes concurrent creation race-safe.
      const ins = await pool.query(
        `INSERT INTO zerobounce_campaigns (filter_definition, initial_eligible_total, created_by)
         VALUES ($1::jsonb, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [JSON.stringify(filter), initialTotal, "system:zerobounce-auto-run"],
      );
      campaign = ins.rows[0] ?? (await pool.query(
        `SELECT * FROM zerobounce_campaigns WHERE status = 'active' LIMIT 1`,
      )).rows[0];
      if (!campaign) {
        const errMsg = "Failed to find or create an active campaign";
        console.error(`[ZB auto-run] ${errMsg}`);
        return { outcome: "error", error: errMsg };
      }
    }

    // ── 6. Active-run guard: one running run per campaign at a time ───────────
    const existingRunning = (await pool.query(
      `SELECT id FROM zerobounce_runs WHERE campaign_id = $1 AND state = 'running' LIMIT 1`,
      [campaign.id],
    )).rows[0];
    if (existingRunning) {
      await storage.createAuditLog({
        action: "zerobounce_auto_run_skipped",
        entityType: "system",
        entityId: 0,
        actorType: "system",
        actorId: "zerobounce-auto-run",
        details: { reason: "run_already_active", existingRunId: existingRunning.id, campaignId: campaign.id },
      });
      console.log(`[ZB auto-run] Skipped — run ${existingRunning.id} is already in progress`);
      return { outcome: "already_running", runId: existingRunning.id };
    }

    // ── 7. Insert the run row ─────────────────────────────────────────────────
    // Keep a bounded per-run contact limit independent of any provider credit
    // ceiling so operators can reason about and stop individual runs.
    let run: any;
    try {
      run = (await pool.query(
        `INSERT INTO zerobounce_runs (campaign_id, contact_limit, state, last_heartbeat_at)
         VALUES ($1, $2, 'running', NOW())
         RETURNING *`,
        [campaign.id, 5000],
      )).rows[0];
    } catch (insErr: any) {
      if (insErr?.code === "23505") {
        // Concurrent insert won the race (partial unique index on running state)
        const winner = (await pool.query(
          `SELECT id FROM zerobounce_runs WHERE campaign_id = $1 AND state = 'running' LIMIT 1`,
          [campaign.id],
        )).rows[0];
        if (winner) {
          console.log(`[ZB auto-run] Concurrent run ${winner.id} started — skipping`);
          return { outcome: "already_running", runId: winner.id };
        }
      }
      throw insErr;
    }

    // ── 8. Enqueue the durable BullMQ "run" job ───────────────────────────────
    // Dynamic import avoids a static circular dep (queue-manager imports this module).
    const { enqueueZeroBounceRun } = await import("./queue-manager");
    const bullJobId = await enqueueZeroBounceRun(run.id);
    if (!bullJobId) {
      // Queue unavailable: mark the run interrupted rather than leaving it stuck in 'running'.
      await pool.query(
        `UPDATE zerobounce_runs
            SET state = 'interrupted', stop_reason = 'enqueue_failed', finished_at = NOW()
          WHERE id = $1`,
        [run.id],
      );
      await storage.createAuditLog({
        action: "zerobounce_auto_run_enqueue_failed",
        entityType: "system",
        entityId: 0,
        actorType: "system",
        actorId: "zerobounce-auto-run",
        details: { runId: run.id, campaignId: campaign.id, reason: "queue_unavailable" },
      });
      console.error(`[ZB auto-run] Failed to enqueue run ${run.id} — queue unavailable`);
      return { outcome: "enqueue_failed", runId: run.id };
    }

    await pool.query(
      `UPDATE zerobounce_runs SET bull_job_id = $1 WHERE id = $2`,
      [bullJobId, run.id],
    );

    // ── 9. Audit log: record the successful auto-run start ────────────────────
    await storage.createAuditLog({
      action: "zerobounce_auto_run_started",
      entityType: "system",
      entityId: 0,
      actorType: "system",
      actorId: "zerobounce-auto-run",
      details: {
        runId: run.id,
        campaignId: campaign.id,
        bullJobId,
        provider: "zerobounce",
        reservation: "per_intent",
      },
    });

    console.log(
      `[ZB auto-run] Started run ${run.id} for campaign ${campaign.id} ` +
       `(bull job: ${bullJobId}, reservations occur per validation intent)`,
    );
    return { outcome: "enqueued", runId: run.id, bullJobId };
  } catch (err: any) {
    const errMsg = String(err?.message ?? err).slice(0, 500);
    console.error("[ZB auto-run] Unexpected error:", errMsg);
    // Best-effort audit log — may fail if the error is DB-related
    storage.createAuditLog({
      action: "zerobounce_auto_run_error",
      entityType: "system",
      entityId: 0,
      actorType: "system",
      actorId: "zerobounce-auto-run",
      details: { error: errMsg },
    }).catch(() => {});
    return { outcome: "error", error: errMsg };
  }
}

/**
 * Process one run to a terminal state. Exported with injectable deps so the
 * automated test never touches the real ZeroBounce API.
 */
export async function processZeroBounceRun(runId: string, injectedDeps?: ZbWorkerDeps): Promise<ZbRunExit> {
  const deps = injectedDeps ?? (await defaultDeps());

  // Recover any run this restart orphaned before we start (incl. possibly this one).
  await markStaleRunsInterrupted();

  const runRes = await pool.query(
    `SELECT r.*, c.filter_definition, c.status AS campaign_status
       FROM zerobounce_runs r
       JOIN zerobounce_campaigns c ON c.id = r.campaign_id
      WHERE r.id = $1`,
    [runId],
  );
  const run = runRes.rows[0];
  if (!run) {
    console.warn(`[ZB campaign] run ${runId} not found; skipping`);
    return "not_running";
  }
  if (run.state !== "running") return "not_running";
  if (run.campaign_status !== "active") {
    await finishRun(runId, "cancelled", "campaign_not_active");
    return "cancelled";
  }

  // The durable provider control, not secret presence, authorizes spend.
  const control = await pool.query(
    `SELECT enabled, circuit_state FROM provider_controls WHERE provider = 'zerobounce'`,
  );
  if (!control.rows[0] || !control.rows[0].enabled || control.rows[0].circuit_state !== "closed") {
    await finishRun(runId, "error", "provider_control_unavailable");
    return "error";
  }

  const campaignId: string = run.campaign_id;
  const filter = (run.filter_definition ?? {}) as ZbCampaignFilter;
  const contactLimit: number = run.contact_limit ?? 100;

  let processedThisRun = 0;
  let sinceHeartbeat = 0;
  let lastHeartbeatMs = Date.now();

  // Initial heartbeat so stale detection has a fresh baseline.
  await pool.query(`UPDATE zerobounce_runs SET last_heartbeat_at = NOW() WHERE id = $1`, [runId]);

  try {
    while (processedThisRun < contactLimit) {
      const remaining = contactLimit - processedThisRun;
      const candidates = await selectNextCandidates(campaignId, filter, Math.min(SELECT_CHUNK, remaining));
      if (candidates.length === 0) break; // cohort exhausted

      for (const contactId of candidates) {
        if (processedThisRun >= contactLimit) break;

        // Cancellation is polled between contacts.
        if (await isCancelRequested(runId)) {
          await finishRun(runId, "cancelled", "cancelled");
          return "cancelled";
        }

        // ── Atomic claim: one attempt per (campaign, contact), ever. ──────────
        const claim = await pool.query(
          `INSERT INTO zerobounce_attempts (campaign_id, run_id, contact_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (campaign_id, contact_id) DO NOTHING
           RETURNING id`,
          [campaignId, runId, contactId],
        );
        if (claim.rowCount === 0) continue; // claimed by a concurrent run — skip, never double-charge
        const attemptId = claim.rows[0].id;
        processedThisRun++;

        // The claimed-attempt body is a closure so EVERY exit path (skipped
        // placeholder, retryable provider failure, completed, error) falls
        // through to the heartbeat bookkeeping below — a provider outage
        // producing a long streak of retryable failures must still heartbeat,
        // or stale-run detection would falsely interrupt a live worker.
        await (async (): Promise<"processed"> => {
          try {
            const contact = await storage.getContact(contactId);
            const email = contact?.email ?? null;
            if (!email || isPlaceholderEmail(email)) {
              // Never send placeholders to the provider, never claim a credit for them.
              await pool.query(
                `UPDATE zerobounce_attempts SET outcome = 'skipped', error_code = 'placeholder_or_blank_email', updated_at = NOW() WHERE id = $1`,
                [attemptId],
              );
              return "processed";
            }

            const generation = (await pool.query(
              `UPDATE contacts
                  SET email_mutation_generation = GREATEST(email_mutation_generation, 1),
                      email_token_hash = $2
                WHERE id = $1
              RETURNING email_mutation_generation`,
              [contactId, hashEmailToken(email)],
            )).rows[0].email_mutation_generation;
            await db.transaction((tx) => createValidationIntent(tx, {
              contactId, email, generation, purpose: "marketing_outreach",
            }));
            const intent = await pool.query(
              `SELECT id FROM validation_intents WHERE contact_id = $1
                 AND normalized_email_token_hash = $2 AND subject_generation = $3
                 AND purpose = 'marketing_outreach'`,
              [contactId, hashEmailToken(email), generation],
            );
            const outcome = await processValidationIntent(intent.rows[0].id, { verifyEmail: deps.verifyEmail });
            if (outcome !== "completed") {
              await pool.query(
                `UPDATE zerobounce_attempts SET outcome = 'retryable_failed', retryable = TRUE,
                    error_code = $2, updated_at = NOW() WHERE id = $1`,
                [attemptId, outcome],
              );
              return "processed";
            }
            const observation = await pool.query(
              `SELECT outcome FROM provider_observations WHERE subject_id = $1
                 AND email_token_hash = $2 AND subject_generation = $3
               ORDER BY observed_at DESC LIMIT 1`,
              [contactId, hashEmailToken(email), generation],
            );
            await pool.query(
              `UPDATE zerobounce_attempts
                  SET outcome = 'completed', provider_status = $2, sub_status = $3,
                      credit_state = 'reserved', updated_at = NOW()
                WHERE id = $1`,
              [attemptId, observation.rows[0]?.outcome ?? "unknown", null],
            );
            await storage.createAuditLog({
              action: "zerobounce_email_validated",
              entityType: "contact",
              entityId: contactId,
              actorType: "system",
              actorId: `zb-run:${runId}`,
              details: {
                emailTokenHash: hashEmailToken(email),
                zbStatus: observation.rows[0]?.outcome ?? "unknown",
                zbSubStatus: null,
                source: "campaign",
                campaignId,
                runId,
              },
            });
            return "processed";
          } catch (err: any) {
            await pool.query(
              `UPDATE zerobounce_attempts SET outcome = 'error', error_code = $2, updated_at = NOW() WHERE id = $1`,
              [attemptId, String(err?.message ?? err).slice(0, 500)],
            ).catch(() => {});
            return "processed";
          }
        })();

        // ── Heartbeat: every HEARTBEAT_EVERY claimed attempts OR when more
        //    than HEARTBEAT_MAX_MS has elapsed since the last write (a slow
        //    provider — e.g. 10 s timeouts during an outage — must not let
        //    the heartbeat go stale while the worker is genuinely alive). ──
        sinceHeartbeat++;
        if (sinceHeartbeat >= HEARTBEAT_EVERY || Date.now() - lastHeartbeatMs >= HEARTBEAT_MAX_MS) {
          sinceHeartbeat = 0;
          lastHeartbeatMs = Date.now();
          await syncRunCounters(runId, true);
          // If something external flipped this run's state (stale-marked by a
          // reader, admin action), stop immediately — never keep processing
          // alongside a replacement run, and never overwrite the terminal state.
          const st = await pool.query(`SELECT state FROM zerobounce_runs WHERE id = $1`, [runId]);
          if (st.rows[0]?.state !== "running") {
            console.warn(`[ZB campaign] run ${runId} externally moved to '${st.rows[0]?.state}' — worker stopping`);
            return "not_running";
          }
        }
      }
    }

    // Cohort exhausted or per-run contact limit reached.
    await finishRun(runId, "completed", processedThisRun >= contactLimit ? "contact_limit_reached" : "cohort_exhausted");

    // Terminal reconciliation: complete the campaign only when nothing eligible
    // remains AND no unresolved pending attempts exist (a pending attempt means
    // a contact whose fate is unknown — the campaign must stay open until
    // reconcilePendingAttempts() has resolved it).
    const left = await selectNextCandidates(campaignId, filter, 1);
    if (left.length === 0) {
      await pool.query(
        `UPDATE zerobounce_campaigns c
            SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE c.id = $1 AND c.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM zerobounce_attempts a
               WHERE a.campaign_id = $1 AND a.outcome = 'pending'
            )`,
        [campaignId],
      );
    }
    return "completed";
  } catch (err: any) {
    console.error(`[ZB campaign] run ${runId} failed:`, err?.message ?? err);
    await finishRun(runId, "error", String(err?.message ?? err).slice(0, 500)).catch(() => {});
    return "error";
  }
}
