/**
 * BacklogPreviewService — per-source risk preview of queued outbound work.
 *
 * Design constraints (VFC-19, P1-4, P1-5, VFC-21):
 * - All sequence enrollment queries use the correct column: `next_action_at`
 * - Channel is not a column on sequence_enrollments; it is derived from sequence_steps.action_type
 * - Each source runs in an independent try/catch; one timeout cannot fail another
 * - `nonAdditive: true` signals that stores are overlapping and MUST NOT be summed
 * - `partial: true` when any source returns a non-ok envelope
 * - Never calls getQueueManager() (would lazily initialize workers); uses
 *   isQueueManagerReady() + requireQueueManagerReady() instead
 */

import { sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { isQueueManagerReady, requireQueueManagerReady } from "./queue-manager";

// ── Types ─────────────────────────────────────────────────────────────────────

type SourceResult<T> =
  | { status: "ok"; data: T; capturedAt: string }
  | { status: "timeout" | "unavailable" | "schema_missing"; data: null; errorCode: string; capturedAt: string };

export type DeferredGhlEnrollmentsData = {
  pending: number;
  dueNow: number;
  terminalFailed: number;
};

export interface BacklogPreviewServiceOptions {
  /**
   * Deterministic certification seam for the deferred-GHL source. Production
   * callers leave this unset so the aggregate always comes from PostgreSQL.
   */
  deferredGhlEnrollmentsReader?: () => Promise<DeferredGhlEnrollmentsData>;
}

export interface BacklogPreview {
  partial: boolean;
  nonAdditive: true;
  bullmq: SourceResult<{
    queues: Record<string, { waiting: number | null; delayed: number | null; active: number | null; failed: number | null }>;
    namedJobs?: Array<{ queue: string; jobName: string; state: string; count: number }>;
    scanTruncated: boolean;
  }>;
  sequenceEnrollments: SourceResult<{
    due: number;
    byActionType: Record<string, number>;
    /** Capped at SEQ_BREAKDOWN_CAP sequences; seqTruncated=true when more exist */
    bySequence: Array<{ sequenceId: number; count: number; oldestDueAt: string | null }>;
    seqTruncated: boolean;
    byAge: { under1h: number; h1to24: number; over24h: number };
    eligibilityIndicators: { missingEndpoint: number; knownSuppressed: number; requiresEmailValidation: number };
  }>;
  outboundMessages: SourceResult<{ queued: number; sending: number; staleSending: number }>;
  deferredGhlEnrollments: SourceResult<DeferredGhlEnrollmentsData>;
  postEnrichmentIntents: SourceResult<{ pending: number; eligibleNow: number; processing: number; expiredLease: number; failed: number }>;
  generatedAt: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SOURCE_TIMEOUT_MS = 8_000;
const STALE_SENDING_MINUTES = 30;
const NAMED_JOB_SCAN_LIMIT = 200; // bounded pagination cap
const SEQ_BREAKDOWN_CAP = 50;     // max sequences returned in bySequence
const DB_STATEMENT_TIMEOUT_MS = 7_000; // SET LOCAL timeout per source transaction

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error("BACKLOG_SOURCE_TIMEOUT"), { code: "TIMEOUT" })), ms)
    ),
  ]);
}

function isTimeoutError(err: unknown): boolean {
  const code = (err as any)?.code ?? "";
  return (
    code === "TIMEOUT" ||
    (err instanceof Error && err.message === "BACKLOG_SOURCE_TIMEOUT") ||
    // 57014 = query_canceled — PostgreSQL fires this when SET LOCAL statement_timeout expires
    code === "57014"
  );
}

function isMissingSchemaError(err: unknown): boolean {
  const code = (err as any)?.code ?? "";
  // 42P01 = undefined_table (table missing)
  // 42703 = undefined_column (table exists but required column missing; e.g. 0137 applied, 0138 not)
  // Only trust PostgreSQL SQLSTATEs. Error prose such as "database does not
  // exist" describes runtime unavailability and must not masquerade as schema
  // absence.
  return code === "42P01" || code === "42703";
}

function okEnvelope<T>(data: T): { status: "ok"; data: T; capturedAt: string } {
  return { status: "ok", data, capturedAt: nowIso() };
}

function errEnvelope(
  status: "timeout" | "unavailable" | "schema_missing",
  errorCode: string
): { status: "timeout" | "unavailable" | "schema_missing"; data: null; errorCode: string; capturedAt: string } {
  return { status, data: null, errorCode, capturedAt: nowIso() };
}

// ── Service Class ─────────────────────────────────────────────────────────────

export class BacklogPreviewService {
  private db: typeof defaultDb;
  private deferredGhlEnrollmentsReader?: BacklogPreviewServiceOptions["deferredGhlEnrollmentsReader"];

  constructor(
    db?: typeof defaultDb,
    options: BacklogPreviewServiceOptions = {},
  ) {
    this.db = db ?? defaultDb;
    this.deferredGhlEnrollmentsReader = options.deferredGhlEnrollmentsReader;
  }

  async getBacklogPreview(): Promise<BacklogPreview> {
    const [bullmqResult, seqResult, outboundResult, deferredResult, peResult] =
      await Promise.allSettled([
        withTimeout(this._fetchBullmqSource(), SOURCE_TIMEOUT_MS),
        withTimeout(this._fetchSequenceEnrollmentsSource(), SOURCE_TIMEOUT_MS),
        withTimeout(this._fetchOutboundMessagesSource(), SOURCE_TIMEOUT_MS),
        withTimeout(this._fetchDeferredGhlEnrollmentsSource(), SOURCE_TIMEOUT_MS),
        withTimeout(this._fetchPostEnrichmentIntentsSource(), SOURCE_TIMEOUT_MS),
      ]);

    const bullmq      = this._settle(bullmqResult);
    const sequenceEnrollments = this._settle(seqResult);
    const outboundMessages    = this._settle(outboundResult);
    const deferredGhlEnrollments = this._settle(deferredResult, "deferredGhlEnrollments");
    const postEnrichmentIntents  = this._settle(peResult);

    const partial =
      bullmq.status !== "ok" ||
      sequenceEnrollments.status !== "ok" ||
      outboundMessages.status !== "ok" ||
      deferredGhlEnrollments.status !== "ok" ||
      postEnrichmentIntents.status !== "ok";

    return {
      partial,
      nonAdditive: true,
      bullmq: bullmq as BacklogPreview["bullmq"],
      sequenceEnrollments: sequenceEnrollments as BacklogPreview["sequenceEnrollments"],
      outboundMessages: outboundMessages as BacklogPreview["outboundMessages"],
      deferredGhlEnrollments: deferredGhlEnrollments as BacklogPreview["deferredGhlEnrollments"],
      postEnrichmentIntents: postEnrichmentIntents as BacklogPreview["postEnrichmentIntents"],
      generatedAt: nowIso(),
    };
  }

  // ── Settle helper ────────────────────────────────────────────────────────────

  private _settle<T>(
    result: PromiseSettledResult<SourceResult<T>>,
    source?: "deferredGhlEnrollments",
  ): SourceResult<T> {
    if (result.status === "fulfilled") return result.value;
    const err = result.reason;
    if (isTimeoutError(err)) {
      return errEnvelope(
        "timeout",
        source === "deferredGhlEnrollments"
          ? "BACKLOG_DEFERRED_GHL_TIMEOUT"
          : "BACKLOG_SOURCE_TIMEOUT",
      );
    }
    if (isMissingSchemaError(err)) {
      return errEnvelope(
        "schema_missing",
        source === "deferredGhlEnrollments"
          ? "BACKLOG_DEFERRED_GHL_SCHEMA_MISSING"
          : "BACKLOG_SOURCE_SCHEMA_MISSING",
      );
    }
    return errEnvelope(
      "unavailable",
      source === "deferredGhlEnrollments"
        ? "BACKLOG_DEFERRED_GHL_UNAVAILABLE"
        : "BACKLOG_SOURCE_UNAVAILABLE",
    );
  }

  // ── BullMQ source ─────────────────────────────────────────────────────────────

  private async _fetchBullmqSource(): Promise<SourceResult<{
    queues: Record<string, { waiting: number | null; delayed: number | null; active: number | null; failed: number | null }>;
    namedJobs?: Array<{ queue: string; jobName: string; state: string; count: number }>;
    scanTruncated: boolean;
  }>> {
    // VFC-21: never call getQueueManager() from a route/service — use isQueueManagerReady()
    if (!isQueueManagerReady()) {
      return errEnvelope("unavailable", "QUEUE_MANAGER_NOT_READY");
    }

    const qm = requireQueueManagerReady();
    const { queues: metrics } = await qm.getAllQueueMetrics();

    const queueMap: Record<string, { waiting: number | null; delayed: number | null; active: number | null; failed: number | null }> = {};
    for (const m of metrics) {
      // Counts of a queue this profile does not select, or that could not be read, are null (unavailable), never zero.
      queueMap[m.name] = {
        waiting: m.waiting,
        delayed: m.delayed,
        active: m.active,
        failed: m.failed,
      };
    }

    // Bounded scan of named (repeatable) jobs per queue
    const namedJobs: Array<{ queue: string; jobName: string; state: string; count: number }> = [];
    let scanTruncated = false;

    try {
      // Access internal queues map via type cast
      const queueManagerAny = qm as any;
      const internalQueues: Map<string, any> = queueManagerAny.queues;

      if (internalQueues && typeof internalQueues.entries === "function") {
        const allRepeatables: Array<{ queue: string; jobName: string; state: string; count: number }> = [];

        for (const [queueName, queue] of internalQueues.entries()) {
          try {
            const repeatables: any[] = await queue.getRepeatableJobs(0, NAMED_JOB_SCAN_LIMIT - 1);
            if (repeatables.length >= NAMED_JOB_SCAN_LIMIT) {
              scanTruncated = true;
            }
            for (const job of repeatables.slice(0, NAMED_JOB_SCAN_LIMIT)) {
              const existing = allRepeatables.find(
                (j) => j.queue === queueName && j.jobName === (job.name ?? "run")
              );
              if (existing) {
                existing.count++;
              } else {
                allRepeatables.push({
                  queue: queueName,
                  jobName: job.name ?? "run",
                  state: "repeatable",
                  count: 1,
                });
              }
            }
          } catch {
            // Skip queues that can't be enumerated
          }
        }
        namedJobs.push(...allRepeatables);
      }
    } catch {
      // Named job scan is best-effort; failure does not fail the BullMQ source
    }

    return okEnvelope({ queues: queueMap, namedJobs, scanTruncated });
  }

  // ── Sequence enrollments source ───────────────────────────────────────────────
  // Uses database-side aggregation so no unbounded row transfer to Node occurs.
  // Runs inside a transaction with SET LOCAL statement_timeout so a slow query
  // is actually cancelled by the database (not just abandoned by Promise.race).
  // VFC-19: uses next_action_at (correct column); channel derived from
  // sequence_steps.action_type at step_order = current_step + 1 (0-based → 1-based).

  private async _fetchSequenceEnrollmentsSource(): Promise<SourceResult<{
    due: number;
    byActionType: Record<string, number>;
    bySequence: Array<{ sequenceId: number; count: number; oldestDueAt: string | null }>;
    seqTruncated: boolean;
    byAge: { under1h: number; h1to24: number; over24h: number };
    eligibilityIndicators: { missingEndpoint: number; knownSuppressed: number; requiresEmailValidation: number };
  }>> {
    return await this.db.transaction(async (tx) => {
      // Actual database-side cancellation — if the query exceeds the limit,
      // Postgres cancels the backend query, not just the client promise.
      // Note: SET LOCAL does not accept parameterized values ($1); the value
      // must be inlined as a literal.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${DB_STATEMENT_TIMEOUT_MS}'`));

      // ── Query 1: Summary aggregates ─────────────────────────────────────────
      // All counts computed in SQL; returns exactly one row.
      type SummaryRow = {
        total_due: string;
        under1h: string;
        h1to24: string;
        over24h: string;
        known_suppressed: string;
        missing_endpoint: string;
        requires_email_validation: string;
      };
      const summaryResult = await tx.execute<SummaryRow>(sql`
        SELECT
          COUNT(*)::text                                           AS total_due,
          COUNT(*) FILTER (
            WHERE NOW() - se.next_action_at < INTERVAL '1 hour'
          )::text                                                  AS under1h,
          COUNT(*) FILTER (
            WHERE NOW() - se.next_action_at >= INTERVAL '1 hour'
              AND NOW() - se.next_action_at < INTERVAL '24 hours'
          )::text                                                  AS h1to24,
          COUNT(*) FILTER (
            WHERE NOW() - se.next_action_at >= INTERVAL '24 hours'
          )::text                                                  AS over24h,
          COUNT(*) FILTER (
            WHERE c.do_not_contact = true
          )::text                                                  AS known_suppressed,
          (
            COUNT(*) FILTER (
              WHERE (ss.action_type ILIKE '%email%' OR ss.action_type ILIKE '%mail%')
                AND (c.email_status IS NULL OR c.email_status = 'invalid')
            ) +
            COUNT(*) FILTER (
              WHERE (ss.action_type ILIKE '%sms%' OR ss.action_type ILIKE '%text%'
                       OR ss.action_type ILIKE '%message%')
                AND (c.sms_status IS NULL OR c.sms_status = 'invalid')
            )
          )::text                                                  AS missing_endpoint,
          COUNT(*) FILTER (
            WHERE (ss.action_type ILIKE '%email%' OR ss.action_type ILIKE '%mail%')
              AND (c.email_status IS NULL
                   OR c.email_status = 'unvalidated'
                   OR c.email_status = 'active')
          )::text                                                  AS requires_email_validation
        FROM sequence_enrollments se
        LEFT JOIN sequence_steps ss
          ON ss.sequence_id = se.sequence_id
          AND ss.step_order = se.current_step + 1
        LEFT JOIN contacts c
          ON c.id = se.contact_id
        WHERE se.status = 'active'
          AND se.next_action_at IS NOT NULL
          AND se.next_action_at <= NOW()
      `);

      // ── Query 2: byActionType ────────────────────────────────────────────────
      // Normalises action_type to a bounded fixed-bucket set so this query
      // always returns at most 6 rows regardless of database cardinality.
      type ActionRow = { action_bucket: string; n: string };
      const actionResult = await tx.execute<ActionRow>(sql`
        SELECT
          CASE
            WHEN ss.action_type ILIKE '%email%' OR ss.action_type ILIKE '%mail%' THEN 'email'
            WHEN ss.action_type ILIKE '%sms%'
              OR ss.action_type ILIKE '%text%'
              OR ss.action_type ILIKE '%message%' THEN 'sms'
            WHEN ss.action_type ILIKE '%call%' OR ss.action_type ILIKE '%phone%' THEN 'call'
            WHEN ss.action_type ILIKE '%linkedin%' OR ss.action_type ILIKE '%social%' THEN 'social'
            WHEN ss.action_type IS NULL THEN 'unknown'
            ELSE 'other'
          END AS action_bucket,
          COUNT(*)::text AS n
        FROM sequence_enrollments se
        LEFT JOIN sequence_steps ss
          ON ss.sequence_id = se.sequence_id
          AND ss.step_order = se.current_step + 1
        WHERE se.status = 'active'
          AND se.next_action_at IS NOT NULL
          AND se.next_action_at <= NOW()
        GROUP BY action_bucket
      `);

      // ── Query 3: bySequence (bounded, ordered by depth desc) ─────────────────
      // Fetches SEQ_BREAKDOWN_CAP + 1 rows to detect truncation.
      type SeqRow = { sequence_id: string; n: string; oldest_due_at: string | null };
      const seqResult = await tx.execute<SeqRow>(sql`
        SELECT
          se.sequence_id::text,
          COUNT(*)::text             AS n,
          MIN(se.next_action_at)::text AS oldest_due_at
        FROM sequence_enrollments se
        WHERE se.status = 'active'
          AND se.next_action_at IS NOT NULL
          AND se.next_action_at <= NOW()
        GROUP BY se.sequence_id
        ORDER BY COUNT(*) DESC
        LIMIT ${SEQ_BREAKDOWN_CAP + 1}
      `);

      // ── Assemble result ──────────────────────────────────────────────────────
      const summaryRows: SummaryRow[] = (summaryResult as any).rows ?? [];
      const actionRows: ActionRow[]   = (actionResult as any).rows ?? [];
      const seqRows: SeqRow[]         = (seqResult as any).rows ?? [];

      const s = summaryRows[0];
      const byActionType: Record<string, number> = {};
      for (const row of actionRows) {
        byActionType[row.action_bucket ?? "unknown"] = Number(row.n);
      }

      const seqTruncated = seqRows.length > SEQ_BREAKDOWN_CAP;
      const bySequence = seqRows.slice(0, SEQ_BREAKDOWN_CAP).map((r) => ({
        sequenceId: Number(r.sequence_id),
        count: Number(r.n),
        oldestDueAt: r.oldest_due_at ?? null,
      }));

      return okEnvelope({
        due:         Number(s?.total_due ?? 0),
        byActionType,
        bySequence,
        seqTruncated,
        byAge: {
          under1h: Number(s?.under1h ?? 0),
          h1to24:  Number(s?.h1to24  ?? 0),
          over24h: Number(s?.over24h ?? 0),
        },
        eligibilityIndicators: {
          missingEndpoint:         Number(s?.missing_endpoint          ?? 0),
          knownSuppressed:         Number(s?.known_suppressed          ?? 0),
          requiresEmailValidation: Number(s?.requires_email_validation ?? 0),
        },
      });
    });
  }

  // ── Outbound messages source ──────────────────────────────────────────────────
  // Single-row conditional aggregate; SET LOCAL statement_timeout ensures the
  // Postgres backend actually cancels the query — Promise.race alone only
  // abandons the client-side promise while the server-side work continues.

  private async _fetchOutboundMessagesSource(): Promise<SourceResult<{
    queued: number;
    sending: number;
    staleSending: number;
  }>> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${DB_STATEMENT_TIMEOUT_MS}'`));

      type Row = { queued: string; sending: string; stale_sending: string };
      const result = await tx.execute<Row>(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::text  AS queued,
          COUNT(*) FILTER (WHERE status = 'sending')::text AS sending,
          COUNT(*) FILTER (
            WHERE status = 'sending'
              AND COALESCE(sending_at, created_at) < NOW() - INTERVAL '30 minutes'
          )::text                                          AS stale_sending
        FROM outbound_messages
        WHERE status IN ('queued', 'sending')
      `);
      const rows: Row[] = (result as any).rows ?? [];
      const r = rows[0];
      return okEnvelope({
        queued:       Number(r?.queued       ?? 0),
        sending:      Number(r?.sending      ?? 0),
        staleSending: Number(r?.stale_sending ?? 0),
      });
    });
  }

  // ── Deferred GHL enrollments source ──────────────────────────────────────────
  // Single-row conditional aggregate under SET LOCAL statement_timeout.
  // P1-5: 42P01/42703 → schema_missing (not zero). Table has a finite set of
  // status values so GROUP BY status is bounded; this source never reads unbounded rows.

  private async _fetchDeferredGhlEnrollmentsSource(): Promise<SourceResult<DeferredGhlEnrollmentsData>> {
    if (this.deferredGhlEnrollmentsReader) {
      return okEnvelope(await this.deferredGhlEnrollmentsReader());
    }

    return await this.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${DB_STATEMENT_TIMEOUT_MS}'`));

      type Row = { pending: string; due_now: string; terminal_failed: string };
      const result = await tx.execute<Row>(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::text                       AS pending,
          COUNT(*) FILTER (
            WHERE status = 'pending'
              AND next_retry_at IS NOT NULL
              AND next_retry_at <= NOW()
          )::text                                                                 AS due_now,
          COUNT(*) FILTER (WHERE status = 'failed')::text                        AS terminal_failed
        FROM deferred_ghl_enrollments
      `);
      const rows: Row[] = (result as any).rows ?? [];
      const r = rows[0];
      return okEnvelope({
        pending:       Number(r?.pending        ?? 0),
        dueNow:        Number(r?.due_now         ?? 0),
        terminalFailed: Number(r?.terminal_failed ?? 0),
      });
    });
  }

  // ── Post-enrichment intents source ────────────────────────────────────────────
  // Single-row conditional aggregate — returns exactly one row regardless of
  // how many intents exist. SET LOCAL statement_timeout for Postgres-side cancellation.
  // 42P01/42703 → schema_missing: table is created in 0137; columns (lease_expires_at,
  // eligible_after) are added in 0138. Either missing → schema_missing is correct.

  private async _fetchPostEnrichmentIntentsSource(): Promise<SourceResult<{
    pending: number;
    eligibleNow: number;
    processing: number;
    expiredLease: number;
    failed: number;
  }>> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${DB_STATEMENT_TIMEOUT_MS}'`));

      type Row = {
        pending: string;
        eligible_now: string;
        processing: string;
        expired_lease: string;
        failed: string;
      };
      const result = await tx.execute<Row>(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::text                   AS pending,
          COUNT(*) FILTER (
            WHERE status = 'pending'
              AND (eligible_after IS NULL OR eligible_after <= NOW())
          )::text                                                             AS eligible_now,
          COUNT(*) FILTER (WHERE status = 'processing')::text                AS processing,
          COUNT(*) FILTER (
            WHERE status = 'processing'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at < NOW()
          )::text                                                             AS expired_lease,
          COUNT(*) FILTER (WHERE status = 'failed')::text                    AS failed
        FROM post_enrichment_enrollment_intents
      `);
      const rows: Row[] = (result as any).rows ?? [];
      const r = rows[0];
      return okEnvelope({
        pending:      Number(r?.pending       ?? 0),
        eligibleNow:  Number(r?.eligible_now  ?? 0),
        processing:   Number(r?.processing    ?? 0),
        expiredLease: Number(r?.expired_lease ?? 0),
        failed:       Number(r?.failed        ?? 0),
      });
    });
  }
}

// ── Singleton accessor for route handlers ─────────────────────────────────────

export function createBacklogPreviewService(
  db?: typeof defaultDb,
  options?: BacklogPreviewServiceOptions,
): BacklogPreviewService {
  return new BacklogPreviewService(db, options);
}
