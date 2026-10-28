import { Queue, Worker, DelayedError, type ConnectionOptions, type Job } from "bullmq";
import { summarizeFailureForLog } from "../lib/lock-trace";
import { sql } from "drizzle-orm";
import {withTransactionPhase} from "../lib/transaction-observability";
import {
  getBackgroundProfile,
  getSelectiveGroups,
  getQueuesForCapabilityGroups,
  isQueueSelectedByBackgroundProfile,
  CORE_QUEUE_ALLOWLIST,
  type BackgroundProfile,
  type WorkerCapabilityGroup,
} from "./background-profile";
import { createHash } from "node:crypto";
import {
  diagnoseRedisCapacity,
  getBullMqPrefixForQueue,
  getBullMqTestPrefix,
  getRedisConnection,
  getSharedRedisClientIfReady,
  type QueueMode,
  type RedisCapacityDiagnosis,
} from "./queue-connection";
import { storage } from "../storage";
import { decideCr06PromotionalLifecycle } from "./cr06-promotional-lifecycle-decision";
import { sanitizeAuditPayload, sanitizeDeadLetterEvent } from "./audit-sanitizer";
import { QUEUE_NAMES, type QueueName } from "./queue-names";
export { QUEUE_NAMES, type QueueName } from "./queue-names";
import { setDbContext } from "../lib/db-context";
import { safeCanonicalEnrichmentFailureDiagnostics } from "./cro03/sfp-failure-diagnostics";
import { isOwnedRepeatableSchedule } from "./owned-repeatable-schedule";
let seqNoOpAlertCooldown = 0;

interface QueueConfig {
  name: QueueName;
  concurrency: number;
  attempts: number;
  backoffDelay: number;
  repeatEveryMs: number;
  cronPattern?: string;
  jobName: string;
}

/**
 * Named schedule entry: an additional repeatable job attached to an existing
 * physical queue under a distinct job name. Used when an event-driven queue
 * (repeatEveryMs=0 in QUEUE_CONFIGS) also needs a periodic recovery sweep.
 *
 * Crucially, installing a named schedule ONLY removes repeatable jobs whose
 * BullMQ key contains this entry's jobId prefix — it never removes jobs
 * belonging to other named entries or the base queue config.
 */
interface NamedQueueSchedule {
  /** Physical queue name — must exist in QUEUE_CONFIGS */
  queueName: QueueName;
  /** Job name dispatched by worker on job.name */
  jobName: string;
  /** Repeat interval in milliseconds (used when cronPattern is absent) */
  repeatEveryMs: number;
  /**
   * Optional cron expression (e.g. "0 6 * * *" for 6 AM UTC daily).
   * When set, BullMQ uses cron scheduling instead of a fixed interval.
   * repeatEveryMs is kept as documentation/fallback but is not used.
   */
  cronPattern?: string;
  /** Stable BullMQ jobId used to identify + deduplicate this schedule */
  jobId: string;
}

// Alert threshold: how many consecutive failures before an operator alert is written.
const WORKER_FAILURE_ALERT_THRESHOLD =
  parseInt(process.env.WORKER_FAILURE_ALERT_THRESHOLD ?? "10", 10) || 10;

// In development the high-frequency workers (ghl-sync, sequences) run at reduced
// cadence to prevent Node.js heap exhaustion in the single-process dev server.
// Production intervals are unchanged.
const IS_DEV = process.env.NODE_ENV !== "production";

// Sequences repeat interval: operators can tune this via SEQUENCES_REPEAT_EVERY_MS
// without a redeploy. A 5-minute floor is enforced to prevent the runaway pile-up
// that the original 30-second interval caused (jobs accumulated 16x faster than
// they finished). In dev the IS_DEV short-circuit (5 min) always wins.
const SEQUENCES_REPEAT_FLOOR_MS = 5 * 60 * 1000; // 5 min hard floor
const SEQUENCES_REPEAT_DEFAULT_MS = 10 * 60 * 1000; // 10 min production default
const _seqEnvMs = parseInt(process.env.SEQUENCES_REPEAT_EVERY_MS ?? "", 10);
const SEQUENCES_REPEAT_EVERY_MS = IS_DEV
  ? 5 * 60 * 1000
  : Number.isFinite(_seqEnvMs) && _seqEnvMs > 0
    ? Math.max(_seqEnvMs, SEQUENCES_REPEAT_FLOOR_MS)
    : SEQUENCES_REPEAT_DEFAULT_MS;

// #1329 — GHL sync interval: operators can tune via GHL_SYNC_REPEAT_EVERY_MS without a redeploy.
// Floor: 30 s (prevent circuit-trip storms). Dev short-circuit always wins.
const GHL_SYNC_REPEAT_FLOOR_MS = 30 * 1000; // 30 s hard floor
const GHL_SYNC_REPEAT_DEFAULT_MS = 45000;    // 45 s production default
const _ghlSyncEnvMs = parseInt(process.env.GHL_SYNC_REPEAT_EVERY_MS ?? "", 10);
const GHL_SYNC_REPEAT_EVERY_MS = IS_DEV
  ? 5 * 60 * 1000
  : Number.isFinite(_ghlSyncEnvMs) && _ghlSyncEnvMs > 0
    ? Math.max(_ghlSyncEnvMs, GHL_SYNC_REPEAT_FLOOR_MS)
    : GHL_SYNC_REPEAT_DEFAULT_MS;

// #1329 — SLA check interval: operators can tune via SLA_CHECKS_REPEAT_EVERY_MS without a redeploy.
// Floor: 2 min. Dev short-circuit always wins.
const SLA_CHECKS_REPEAT_FLOOR_MS = 2 * 60 * 1000; // 2 min hard floor
const SLA_CHECKS_REPEAT_DEFAULT_MS = 5 * 60 * 1000; // 5 min production default
const _slaChecksEnvMs = parseInt(process.env.SLA_CHECKS_REPEAT_EVERY_MS ?? "", 10);
const SLA_CHECKS_REPEAT_EVERY_MS = IS_DEV
  ? 15 * 60 * 1000
  : Number.isFinite(_slaChecksEnvMs) && _slaChecksEnvMs > 0
    ? Math.max(_slaChecksEnvMs, SLA_CHECKS_REPEAT_FLOOR_MS)
    : SLA_CHECKS_REPEAT_DEFAULT_MS;

export const QUEUE_CONFIGS: QueueConfig[] = [
  {
    // Event-owned dispatcher. Recovery is a separate bounded named schedule,
    // never a repeatable successor batch.
    name: QUEUE_NAMES.CRO03C_LIVE,
    concurrency: 1, attempts: 3, backoffDelay: 10_000,
    repeatEveryMs: 0, jobName: "dispatch",
  },
  {
    name: QUEUE_NAMES.CRO03A_QUALIFICATION,
    concurrency: 1, attempts: 3, backoffDelay: 10_000,
    repeatEveryMs: 60_000, jobName: "recover",
  },
  {
    // CRO-02 shadow population observation — runs every 2 hours in prod (hourly in dev).
    // Removed from all HTTP request paths; pool pressure from per-subject graph resolution
    // must not block or background-consume connections during dashboard load.
    name: QUEUE_NAMES.CRO02_OBSERVATION,
    concurrency: 1,
    attempts: 2,
    backoffDelay: 60_000,
    repeatEveryMs: process.env.NODE_ENV === "production" ? 2 * 60 * 60 * 1000 : 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.DEAL_STAGE_EFFECTS,
    concurrency: 1, attempts: 3, backoffDelay: 10_000,
    repeatEveryMs: 60_000, jobName: "dispatch",
  },
  {
    name: QUEUE_NAMES.CHARGEBACK_COMMANDS,
    concurrency: 1, attempts: 3, backoffDelay: 10_000,
    repeatEveryMs: 60_000, jobName: "dispatch",
  },
  {
    name: QUEUE_NAMES.STATEMENT_UPLOAD,
    concurrency: 1,
    attempts: 3,
    backoffDelay: 10000,
    repeatEveryMs: 5 * 60 * 1000,
    jobName: "recover",
  },
  {
    name: QUEUE_NAMES.GHL_SYNC,
    // W12: concurrency=1 (was 3). The handler acquires a singleton lease
    // (acquireJobLock) so concurrent slots always no-op and waste a Redis
    // blocking connection. Projection work and legacy scan are both serialised
    // inside runGhlFullSyncTick(); separating them is tracked separately.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 5000,
    repeatEveryMs: GHL_SYNC_REPEAT_EVERY_MS,
    jobName: "ghl-sync-tick",
  },
  {
    // Task #2002 completion: ticks the resumable Sunbiz full-backlog cursor.
    // concurrency=1 + the run row's own fenced lease means an overlapping
    // tick (or a manual "run now" trigger) always safely no-ops rather than
    // double-advancing the cursor. No-op unless an admin has set the run to
    // 'running' -- disabled by default in every environment including prod.
    name: QUEUE_NAMES.SUNBIZ_FULL_BACKFILL,
    concurrency: 1,
    attempts: 1,
    backoffDelay: 30000,
    // Live batches take 2–4 minutes. Leave headroom between resumable passes;
    // the existing run-state gate still prevents work after completion/pause.
    repeatEveryMs: 5 * 60 * 1000,
    jobName: "tick",
  },
  {
    name: QUEUE_NAMES.SLA_CHECKS,
    // concurrency=1: correctness-sensitive; concurrent SLA passes could double-fire alerts.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 10000,
    repeatEveryMs: SLA_CHECKS_REPEAT_EVERY_MS,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.SEQUENCES,
    // concurrency=1: processSequenceEnrollments() holds a DB-based acquireJobLock
    // (singleton per-process) so a second concurrent slot would always no-op and
    // waste a DB pool connection. A single slot is the correct model here.
    //
    // repeatEveryMs prod=10 min: a full run against 155 K+ contacts takes ~8 min.
    // The previous 30 s interval caused runaway queue depth — new jobs piled up
    // 16x faster than they finished. 10 min gives a ~2-min recovery buffer after
    // each run, keeping queue depth at or near zero.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 10000,
    repeatEveryMs: SEQUENCES_REPEAT_EVERY_MS,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.ENRICHMENT,
    // concurrency=2: reduced from 5 to ease DB pool pressure in production.
    // Each enrichment job runs several storage queries; 5 concurrent jobs
    // consumed ~10 pool slots simultaneously alongside HTTP handlers and other
    // workers, pushing total near the pool max=20 and triggering ETIMEDOUT.
    // 2 concurrent enrichment jobs = ~4 pool slots, safe headroom restored.
    concurrency: 2,
    attempts: 3,
    backoffDelay: 15000,
    repeatEveryMs: 10 * 60 * 1000,
    jobName: "run",
  },
  {
    // MI-09 corrective item 1: genuine isolated recurring consumer for the
    // `free-enrichment-lane` capability group. This queue is physically
    // separate from QUEUE_NAMES.ENRICHMENT — selecting only the
    // `free-enrichment-lane` capability group must never start the broad
    // `enrichment` queue (which also runs Sunbiz auto-convert, lead-scoring
    // recovery, statement blueprints, contact_lead_scoring, etc). The handler
    // below imports only ./free-enrichment-lane, which itself imports only
    // the free RDAP/JSON-LD/contact-page executor — no paid provider,
    // ZeroBounce, GHL, sequence, campaign, or outreach import is reachable
    // from this queue's case block.
    name: QUEUE_NAMES.FREE_ENRICHMENT_LANE,
    concurrency: 1,
    attempts: 3,
    backoffDelay: 15000,
    // Recent retained batches average ~31 minutes. This is a periodic sweep,
    // not a delivery deadline; avoid keeping a successor ready every 15 minutes.
    repeatEveryMs: 45 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.DISCOVERY,
    // concurrency=1: runs once daily; a single sequential pass is sufficient.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 30000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.DIGESTS,
    // concurrency=1: low-frequency (hourly); correctness requires a single pass.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 10000,
    repeatEveryMs: 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.MID_INGESTION,
    // concurrency=1: nightly batch; single-pass DB write avoids row-level conflicts.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 60000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.ONBOARDING_REMINDER,
    // concurrency=1: runs every 4h to catch abandoned apps within the 24h stale window.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 60000,
    repeatEveryMs: 4 * 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.ACTIVATION_MONITOR,
    // concurrency=1: daily check for MIDs assigned but not yet activated (#1405).
    concurrency: 1,
    attempts: 2,
    backoffDelay: 60000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.MERCHANT_SUCCESS,
    // concurrency=1: daily 30/60/90-day merchant success program enrollments (#1406).
    concurrency: 1,
    attempts: 2,
    backoffDelay: 60000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.WINBACK_OUTREACH,
    // concurrency=1: nightly win-back engine — emails automationEligible WINBACK_OUTREACH NBAs (#1407).
    concurrency: 1,
    attempts: 2,
    backoffDelay: 60000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.ABANDONED_STATEMENT,
    // concurrency=1: nightly; checks for statement requests that haven't been uploaded in 3+ days.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 60000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.EXECUTIVE_SNAPSHOT,
    // concurrency=1: Monday 12 PM UTC (7 AM ET) weekly KPI snapshot + AI briefings.
    // Override with EXEC_SNAPSHOT_CRON env var.
    concurrency: 1,
    attempts: 2,
    backoffDelay: 60000,
    repeatEveryMs: 7 * 24 * 60 * 60 * 1000,
    cronPattern: process.env.EXEC_SNAPSHOT_CRON ?? "0 12 * * 1",
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.SYSTEM_AUDIT,
    // concurrency=1: weekly audit; single sequential run is correct.
    // Cron: Monday 8 AM UTC by default; override with SYSTEM_AUDIT_CRON env var.
    concurrency: 1,
    attempts: 2,
    backoffDelay: 30000,
    repeatEveryMs: 7 * 24 * 60 * 60 * 1000,
    cronPattern: process.env.SYSTEM_AUDIT_CRON ?? "0 11 * * 1", // Monday 11am UTC = 6am ET
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.DB_BACKUP,
    // concurrency=1: nightly pg_dump at 3 AM UTC; single sequential run avoids partial dumps.
    concurrency: 1,
    attempts: 2,
    backoffDelay: 60000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    cronPattern: "0 3 * * *",
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.ENROLLMENT_RECOVERY,
    // concurrency=1: runs once daily at 6 AM UTC, after daily cold-outreach caps reset.
    // Recovers enrollments that were deferred because the cap was exhausted the previous day.
    concurrency: 1,
    attempts: 2,
    backoffDelay: 60000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    cronPattern: process.env.ENROLLMENT_RECOVERY_CRON ?? "0 6 * * *",
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY,
    // concurrency=1: processes deferred GHL workflow enrollment retries.
    // Runs every 30 minutes to catch transient failures (network timeout, 5xx, 429).
    // After MAX_RETRIES (3) failures the record is permanently dropped with an audit log.
    concurrency: 1,
    attempts: 2,
    backoffDelay: 30000,
    repeatEveryMs: IS_DEV ? 10 * 60 * 1000 : 30 * 60 * 1000, // dev: 10 min, prod: 30 min
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.HEALTH_MONITOR,
    // concurrency=1: single sequential health check pass; no contention required.
    // Non-critical — skip retry if fails (attempts=1).
    concurrency: 1,
    attempts: 1,
    backoffDelay: 0,
    repeatEveryMs: IS_DEV ? 15 * 60 * 1000 : 5 * 60 * 1000, // dev: 15min, prod: 5min
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.PIPELINE_SILENCE_CHECK,
    // concurrency=1: daily scan for silent pipeline stages; single sequential pass is correct.
    // Non-critical — skip retry if fails (attempts=1).
    concurrency: 1,
    attempts: 1,
    backoffDelay: 0,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    cronPattern: process.env.PIPELINE_SILENCE_CRON ?? "0 9 * * *", // 9 AM UTC daily
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.PROPOSAL_FOLLOWUP,
    // concurrency=1: nightly; checks for proposals sent > 3 days ago with no view.
    // Max 2 re-sends per deal, gated by audit_logs count.
    concurrency: 1,
    attempts: 3,
    backoffDelay: 60000,
    repeatEveryMs: 24 * 60 * 60 * 1000,
    cronPattern: process.env.PROPOSAL_FOLLOWUP_CRON ?? "0 10 * * *", // 10 AM UTC daily
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.PARTNER_MONTHLY_DIGEST,
    // concurrency=1: runs on the 1st of each month at 9 AM UTC (4 AM ET).
    // Sends each active partner a monthly residuals + earnings summary email.
    // Override with PARTNER_MONTHLY_DIGEST_CRON env var.
    concurrency: 1,
    attempts: 2,
    backoffDelay: 60000,
    repeatEveryMs: 30 * 24 * 60 * 60 * 1000, // fallback ~30 days
    cronPattern: process.env.PARTNER_MONTHLY_DIGEST_CRON ?? "0 9 1 * *", // 1st of month 9 AM UTC
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.VOICEMAIL_SYNC,
    // Polls GHL Conversations API for inbound voicemail messages every 15 min.
    // Only active when VOICEMAIL_SYNC_ENABLED=true env var is set.
    concurrency: 1,
    attempts: 2,
    backoffDelay: 30000,
    repeatEveryMs: 15 * 60 * 1000, // 15 minutes
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.POST_ENRICHMENT,
    // Event-driven: jobs are enqueued one at a time by writebackEnrichmentToLinkedRecords
    // whenever enrichment writes the first real email/phone to a contactless lead.
    // repeatEveryMs is unused (no repeatable job); the queue only processes ad-hoc items.
    // A named recovery schedule is installed separately via NAMED_QUEUE_SCHEDULES.
    concurrency: 3,
    attempts: 3,
    backoffDelay: 15000,
    repeatEveryMs: 0, // no repeatable job — driven by enrichment events
    jobName: "post-enrichment-automation",
  },
  {
    name: QUEUE_NAMES.ZEROBOUNCE_BATCH,
    // Event-driven (#1541): jobs are enqueued by POST /api/contacts/validate-emails-batch
    // with a { runId } payload. concurrency=1: the zerobounce_attempts unique
    // claim makes concurrent runs safe, but serial processing keeps daily-cap
    // consumption deterministic. attempts=1: a crashed run is recovered via
    // stale-heartbeat detection + a new operator-initiated run, not a blind
    // BullMQ retry (which could double-report a terminal state).
    concurrency: 1,
    attempts: 1,
    backoffDelay: 10000,
    repeatEveryMs: 0, // no repeatable job — driven by batch-start requests
    jobName: "run",
  },
  {
    name: QUEUE_NAMES.SOURCE_REGISTRY_IMPORT,
    // Event-driven: jobs enqueued by POST /api/admin/source-registry/:key/import.
    // concurrency=1: per-adapter advisory lock ensures no overlap anyway, but
    // serializing BullMQ picks avoids wasting a worker slot on a lock-wait.
    // attempts=1: a failed import is re-triggered by an admin explicitly; blind
    // BullMQ retries could double-count new/updated records via idempotency keys.
    concurrency: 1,
    // attempts=3: transient failures (network, DB timeout, temp lock contention) are
    // retried up to 3 times with 30 s backoff. The runner resets the run row to 'queued'
    // on retryable errors and throws, so BullMQ sees a failed job and retries.
    // Non-retryable failures (wrong adapter, missing headers, tombstone guard, lease loss)
    // mark the run permanently 'failed' in the DB and return (BullMQ sees success — no
    // point retrying a configuration error).
    attempts: 3,
    backoffDelay: 30_000,
    repeatEveryMs: 0, // on-demand only — schedule_disabled=true for all adapters
    jobName: "run",
  },
  {
    // MI-07: master-lead-stager — event-driven; one job per staging intent.
    // Jobs are enqueued by writeBusinessValidationResult() when provider_valid.
    // concurrency=3: staging jobs are mostly DB reads/writes with no external calls.
    // attempts=5: exponential backoff; failed intent rows remain pending for retry.
    name: QUEUE_NAMES.MASTER_LEAD_STAGER,
    concurrency: 3,
    attempts: 5,
    backoffDelay: 15_000,
    repeatEveryMs: 0, // event-driven only
    jobName: "stage",
  },
  {
    // MI-09: CRO-08A scheduler — event-driven; scheduling installed via
    // NAMED_QUEUE_SCHEDULES (see below). Setting repeatEveryMs=0 here prevents
    // duplicate schedule registration (one registration in QUEUE_CONFIGS + one
    // in NAMED_QUEUE_SCHEDULES would result in two competing repeatable jobs).
    name: QUEUE_NAMES.CRO08A_SCHEDULER,
    concurrency: 1,
    attempts: 3,
    backoffDelay: 30_000,
    repeatEveryMs: 0, // scheduled via NAMED_QUEUE_SCHEDULES only
    jobName: "tick",
  },
  {
    // MI-09: CRO-08A processor — event-driven; scheduling installed via
    // NAMED_QUEUE_SCHEDULES. concurrency=1 ensures at most one occurrence is
    // processed at a time; lease-renewal keeps long-running jobs alive.
    name: QUEUE_NAMES.CRO08A_PROCESSOR,
    concurrency: 1,
    attempts: 5,
    backoffDelay: 60_000,
    repeatEveryMs: 0, // scheduled via NAMED_QUEUE_SCHEDULES only
    jobName: "process",
  },
  {
    // Task #2001: isolated SFP held-staging tick. It is assigned only to the
    // sfp-campaign-staging capability group and checks program/stage controls
    // in the processor before discovering or executing any work.
    name: QUEUE_NAMES.SFP_CAMPAIGN_STAGING,
    concurrency: 1,
    attempts: 1,
    backoffDelay: 60_000,
    repeatEveryMs: 15 * 60 * 1000,
    jobName: "tick",
  },
  {
    name: QUEUE_NAMES.SFP_FREE_CLASSIFICATION,
    concurrency: 1,
    attempts: 1,
    backoffDelay: 60_000,
    // Mostly empty recent ticks: poll less often without changing eligibility,
    // program state, or the existing bounded classification cursor.
    repeatEveryMs: 10 * 60 * 1000,
    jobName: "tick",
  },
  {
    // Continuous paid-discovery rotation. concurrency=1: a single sequential
    // Serper batch per tick is correct — the reservation/settlement path is
    // per-business and idempotent, but running two ticks concurrently would
    // waste a worker slot racing for the same cohort's advisory lock.
    // 30 min interval leaves headroom beyond observed 12–14 minute runs; the tick
    // itself is a hard no-op unless CRO03_PROVIDER_TRANSPORT_ENABLED,
    // SERPER_API_KEY, and an active SFP program are all already true.
    name: QUEUE_NAMES.SFP_CONTINUOUS_DISCOVERY,
    concurrency: 1,
    attempts: 1,
    backoffDelay: 60_000,
    repeatEveryMs: 30 * 60 * 1000,
    jobName: "tick",
  },
  {
    // Local file fulfillment has no paid provider work and must not wait for
    // discovery. A periodic wakeup recovers crashes; successful full batches
    // schedule their next page immediately on this same serial worker.
    name: QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY,
    concurrency: 1,
    attempts: 3,
    backoffDelay: 30_000,
    repeatEveryMs: IS_DEV ? 5 * 60 * 1000 : 60_000,
    jobName: "tick",
  },
  {
    // Shared canonical address validation retains its own promotion kill switch.
    name: QUEUE_NAMES.SFP_CONTINUOUS_VALIDATION,
    concurrency: 1,
    attempts: 1,
    backoffDelay: 60_000,
    repeatEveryMs: 10 * 60 * 1000,
    jobName: "tick",
  },
];

/**
 * Additional named schedules for event-driven queues (repeatEveryMs=0 in
 * QUEUE_CONFIGS). Each entry installs exactly one repeatable job on an
 * existing physical queue under a distinct job name.
 *
 * setupRepeatableJobs() processes these AFTER the main QUEUE_CONFIGS loop.
 * It removes only the repeatable job whose BullMQ key matches this entry's
 * jobId — never all jobs for the queue — so multiple named schedules on the
 * same queue coexist safely.
 */
const NAMED_QUEUE_SCHEDULES: NamedQueueSchedule[] = [
  {
    queueName: QUEUE_NAMES.CRO03C_LIVE,
    jobName: "recover",
    repeatEveryMs: parseInt(process.env.CRO03C_LIVE_RECOVERY_INTERVAL_MS ?? "", 10) > 0
      ? parseInt(process.env.CRO03C_LIVE_RECOVERY_INTERVAL_MS!, 10)
      : (IS_DEV ? 5 * 60 * 1000 : 15 * 60 * 1000),
    jobId: "cro03c-live-recovery-repeatable",
  },
  {
    queueName:    QUEUE_NAMES.POST_ENRICHMENT,
    jobName:      "post-enrichment-intent-recovery",
    repeatEveryMs: parseInt(process.env.PE_INTENT_RECOVERY_INTERVAL_MS ?? "", 10) > 0
      ? parseInt(process.env.PE_INTENT_RECOVERY_INTERVAL_MS!, 10)
      : (IS_DEV ? 5 * 60 * 1000 : 15 * 60 * 1000), // 15 min prod, 5 min dev
    jobId: "pe-intent-recovery-repeatable",
  },
  {
    // Daily automated ZeroBounce validation run (#1616).
    // Fires each morning (default 6 AM UTC; override with ZEROBOUNCE_AUTO_RUN_CRON).
    // The handler checks zerobounce_auto_run_enabled in system_settings before doing
    // any work, so this schedule is safe to install unconditionally — no run starts
    // unless an admin explicitly enables it.
    queueName:    QUEUE_NAMES.ZEROBOUNCE_BATCH,
    jobName:      "zerobounce-auto-run",
    repeatEveryMs: 24 * 60 * 60 * 1000, // documentation only when cronPattern is set
    cronPattern:  process.env.ZEROBOUNCE_AUTO_RUN_CRON ?? "0 6 * * *", // 6 AM UTC daily
    jobId:        "zb-auto-run-repeatable",
  },
  {
    // CRO-03A qualification command outbox processor.
    // Picks up cro03a_qualification_commands rows written atomically with source-registry
    // import finalization and converts them to createCro03aQualificationRun() calls.
    // Runs every 2 minutes (dev: 5 min) with FOR UPDATE SKIP LOCKED so concurrent
    // schedule invocations are safe.
    queueName:    QUEUE_NAMES.CRO03A_QUALIFICATION,
    jobName:      "process-outbox",
    repeatEveryMs: IS_DEV ? 5 * 60 * 1000 : 2 * 60 * 1000, // 2 min prod, 5 min dev
    jobId:        "cro03a-qualification-outbox-repeatable",
  },
  {
    // CRO-03A stale-occurrence watchdog.
    // Checks for source-registry imports completed > 48h ago with undecided occurrences.
    // Writes a rate-limited audit_logs alert (one per run per day). Does not block deploy.
    // Runs daily at 7 AM UTC; override with CRO03A_WATCHDOG_CRON.
    queueName:    QUEUE_NAMES.CRO03A_QUALIFICATION,
    jobName:      "watchdog-stale-occurrences",
    repeatEveryMs: 24 * 60 * 60 * 1000, // documentation only when cronPattern is set
    cronPattern:  process.env.CRO03A_WATCHDOG_CRON ?? "0 7 * * *", // 7 AM UTC daily
    jobId:        "cro03a-watchdog-stale-occurrences-repeatable",
  },
  {
    // CRO-03A recurring geography-based qualification run.
    // Selects undecided South Florida-eligible occurrences (state/zip/city evaluated
    // in-process against the v2 geography reference) and creates a qualification run.
    // Runs every 10 minutes (dev: 15 min) to steadily drain the observation backlog.
    queueName:    QUEUE_NAMES.CRO03A_QUALIFICATION,
    jobName:      "recurring-geography-qualification",
    repeatEveryMs: IS_DEV ? 15 * 60 * 1000 : 10 * 60 * 1000,
    jobId:        "cro03a-recurring-geo-qualification-repeatable",
  },
  {
    // MI-07: master-lead-stager pending-intent recovery sweep.
    // Re-enqueues any committed pending intents that were not consumed due to a
    // queue-outage window between writeBusinessValidationResult() and BullMQ delivery.
    // Safe to run frequently — idempotency guards in the worker prevent double-staging.
    queueName:    QUEUE_NAMES.MASTER_LEAD_STAGER,
    jobName:      "recover-pending-intents",
    repeatEveryMs: IS_DEV ? 5 * 60 * 1000 : 10 * 60 * 1000, // 10 min prod, 5 min dev
    jobId:        "mi07-stager-recovery-repeatable",
  },
  {
    // MI-09: CRO-08A scheduler repeatable tick.
    queueName:    QUEUE_NAMES.CRO08A_SCHEDULER,
    jobName:      "tick",
    repeatEveryMs: IS_DEV ? 5 * 60 * 1000 : 10 * 60 * 1000,
    jobId:        "cro08a-scheduler-tick-repeatable",
  },
  {
    // MI-09: CRO-08A processor repeatable run.
    queueName:    QUEUE_NAMES.CRO08A_PROCESSOR,
    jobName:      "process",
    repeatEveryMs: IS_DEV ? 5 * 60 * 1000 : 15 * 60 * 1000,
    jobId:        "cro08a-processor-run-repeatable",
  },
];

/**
 * Why a queue's worker is or is not running, derived from the expected selection (profile/active config) and then the
 * live registry. An unselected queue is a deliberate state, not a failure; a selected queue without a ready worker is.
 */
export type QueueRuntimeState =
  | "active" | "expected_not_selected" | "selected_missing" | "selected_not_ready" | "unreadable";
/** The GHL queue's runtime capability is its own state: the worker can run while GHL writes are paused or unowned. */
export type QueueCapabilityState = "not_applicable" | "ghl_paused" | "ghl_owner_released" | "ghl_enabled" | "ghl_unreadable";
export type QueueFreshnessModel = "interval" | "cron" | "event_driven";
export interface QueueFreshness {
  model: QueueFreshnessModel;
  /** Only interval queues have an expected cadence. Event-driven and cron queues are never judged stale by silence. */
  expectedIntervalMs: number | null;
  /** Last completion observed by this process; never Redis-retained history. */
  lastObservedAt: string | null;
  status: "fresh" | "stale" | "no_observation_in_process" | "not_applicable" | "unavailable";
}
export const QUEUE_STALE_AFTER_INTERVALS = 3;

/** Pure freshness derivation shared by every consumer so thresholds cannot drift. */
export function deriveQueueFreshness(input: {
  hasCron: boolean;
  repeatEveryMs: number;
  runtimeState: QueueRuntimeState;
  paused: boolean | null;
  probeOk: boolean;
  lastObservedAt: string | null;
  nowMs?: number;
}): QueueFreshness {
  const model: QueueFreshnessModel = input.hasCron ? "cron" : input.repeatEveryMs > 0 ? "interval" : "event_driven";
  const expectedIntervalMs = model === "interval" ? input.repeatEveryMs : null;
  const base = { model, expectedIntervalMs, lastObservedAt: input.lastObservedAt };
  if (!input.probeOk || input.runtimeState === "unreadable") return { ...base, status: "unavailable" };
  if (model !== "interval" || input.runtimeState !== "active" || input.paused === true) return { ...base, status: "not_applicable" };
  if (!input.lastObservedAt) return { ...base, status: "no_observation_in_process" };
  const age = (input.nowMs ?? Date.now()) - new Date(input.lastObservedAt).getTime();
  return { ...base, status: age > QUEUE_STALE_AFTER_INTERVALS * input.repeatEveryMs ? "stale" : "fresh" };
}

export function deriveQueueRuntimeState(input: {
  expectedSelected: boolean; workerInstantiated: boolean; workerActive: boolean; probeOk: boolean;
}): QueueRuntimeState {
  if (!input.probeOk) return "unreadable";
  if (!input.expectedSelected) return "expected_not_selected";
  if (!input.workerInstantiated) return "selected_missing";
  return input.workerActive ? "active" : "selected_not_ready";
}

export interface QueueMetric {
  name: string;
  /** Selection expected from the background profile and active config, independent of instantiated workers. */
  expectedSelected: boolean;
  runtimeState: QueueRuntimeState;
  capabilityState: QueueCapabilityState;
  freshness: QueueFreshness;
  waiting: number | null;
  active: number | null;
  completed: number | null;
  failed: number | null;
  delayed: number | null;
  paused: boolean | null;
  repeatEveryMs: number;
  /** Last completion observed in this API/worker process, never Redis-retained history. */
  lastCompletedAt: string | null;
  /** Most recent completion retained in shared Redis; may belong to another process generation. */
  lastRetainedRedisCompletedAt: string | null;
  lastFailedAt: string | null;
  lastRetainedRedisFailedAt: string | null;
  workerSelected: boolean;
  workerActive: boolean;
  avgDurationMs: number | null;
  /** Current-process completions per hour, based on local worker events. */
  throughputPerHour: number | null;
  /** A failed probe is not an empty queue. */
  probeStatus: "ok" | "error";
  errorCode?: "QUEUE_METRICS_READ_FAILED";
}

export interface DlqItem {
  id: string;
  queueName: string;
  jobName: string;
  failureCode: string;
  attemptsMade: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
}

export interface DlqReadResult {
  items: DlqItem[];
  queueStatus: Array<{ source: string; status: "sampled" | "failed" | "not_initialized"; sampleLimitPerQueue?: number; errorCode?: string }>;
}

export interface QueueTopologySnapshot {
  manifestConfigCount: number;
  activeConfigCount: number;
  instantiatedQueueCount: number;
  instantiatedWorkerCount: number;
  readyWorkerCount: number;
  logicalJobCount: number;
  legacyGhlClaimed: boolean;
  /** BullMQ is only active when backed by a real Redis connection. */
  queueMode: QueueMode;
  /** W08: active BACKGROUND_JOB_PROFILE (off / core / selective / full) */
  activeProfile: string;
  /** W08: selected capability groups when profile=selective */
  selectedGroups: string[];
  processId: number;
  processIdentity: string | null;
  releaseSha: string | null;
  capturedAt: string;
}

export interface QueueFleetEvidence {
  status: "reconciled" | "unknown" | "degraded";
  scope: "cro03c_worker_inventory";
  authoritativeComplete: boolean;
  expectedProcessCount: number | null;
  observedProcessCount: number | null;
  observedBootCount: number | null;
  errorCode?: string;
}

export interface QueueHistoryEvidence {
  observationStartedAt: string;
  requestedWindowHours: number;
  availableWindowHours: number;
  partial: boolean;
  processIdentity: string;
  releaseSha: string | null;
  points: Record<string, Array<{
    startedAt: string;
    completed: number;
    failed: number;
  }>>;
}

export interface QueueTelemetryEvidence {
  status: "ok" | "degraded";
  scope: "local_process_with_reconciled_cro03c_worker_fleet";
  freshness: { capturedAt: string; observationStartedAt: string };
  topology: QueueTopologySnapshot;
  fleet: QueueFleetEvidence;
  queues: QueueMetric[];
  backlog: {
    probeStatus: "ok" | "error";
    dueEnrollmentCount: number | null;
    oldestDueMs: number | null;
    lastSequenceRunMs: number | null;
    errorCode?: string;
  };
  redis: {
    infoProbeStatus: "ok" | "error" | "not_initialized";
    observedAccountConnectedClients: number | null;
    capacity: RedisCapacityDiagnosis;
    errorCode?: string;
  };
  dlq: {
    sampleCount: number;
    complete: false;
    resultScope: "sampled_per_queue";
    queueStatus: DlqReadResult["queueStatus"];
  };
  history: QueueHistoryEvidence;
  degradations: string[];
}

type WorkerFailureClass =
  | "provider:connection-rejected"
  | "network:timeout"
  | "redis:command-timeout"
  | "redis:auth-failure"
  | "bullmq:stall"
  | "db:timeout"
  | "app:handler-error"
  | "unknown";

/** Classify a Worker error into a structured category without silently collapsing unknowns. */
function classifyWorkerError(err: Error): WorkerFailureClass {
  const msg = (err.message ?? "").toLowerCase();
  const code = ((err as any).code ?? "").toLowerCase();

  if (
    msg.includes("max number of clients") ||
    msg.includes("max clients reached") ||
    msg.includes("err max") ||
    msg.includes("connection limit")
  ) {
    return "provider:connection-rejected";
  }
  if (
    msg.includes("stalled") ||
    msg.includes("lock renewal") ||
    msg.includes("lock expired") ||
    msg.includes("could not renew")
  ) {
    return "bullmq:stall";
  }
  if (msg.includes("command timed out") || msg.includes("command timeout")) {
    return "redis:command-timeout";
  }
  if (
    msg.includes("wrongpass") ||
    msg.includes("noauth") ||
    msg.includes("err auth") ||
    msg.includes("invalid password") ||
    msg.includes("authentication failed") ||
    msg.includes("auth required")
  ) {
    return "redis:auth-failure";
  }
  if (
    msg.includes("statement timeout") ||
    msg.includes("query_canceled") ||
    msg.includes("canceling statement") ||
    (msg.includes("timeout") && (code === "57014" || msg.includes("db") || msg.includes("postgres") || msg.includes("database")))
  ) {
    return "db:timeout";
  }
  if (
    code === "etimedout" ||
    code === "econnrefused" ||
    code === "enotfound" ||
    code === "econnreset" ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("dns") ||
    msg.includes("tls") ||
    msg.includes("ssl") ||
    msg.includes("network")
  ) {
    return "network:timeout";
  }
  // "unknown" — do not silently collapse; explicit fallthrough required
  return "unknown";
}

/** Redact URLs, IPs, tokens, and email addresses from an error message for safe logging. */
function redactWorkerErrorMessage(message: string): string {
  return message
    .replace(/rediss?:\/\/[^\s"']+/gi, "redis://[REDACTED]")
    .replace(/https?:\/\/[^\s"']+/gi, "[URL-REDACTED]")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, "[IP-REDACTED]")
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[EMAIL-REDACTED]")
    .replace(/password[=:]\S+/gi, "password=[REDACTED]")
    .slice(0, 500);
}

let _queueManager: QueueManager | null = null;
// In-flight initialization promise. Guards against a race where two concurrent
// first-time callers (e.g. index.ts's startup call and a request-triggered
// enqueueStatementAnalysis()/free-contact-enrichment call landing in the same
// tick) could each see `_queueManager === null` and spin up two separate
// QueueManager instances — which would create duplicate GHL_SYNC queues/workers.
let _initPromise: Promise<QueueManager> | null = null;

// Process-lifetime GHL sync mode gate. Once the legacy setInterval fallback
// claims GHL sync duty (see claimLegacyGhlSync()), BullMQ must never create
// the GHL_SYNC queue/worker/repeatable-job again in this process — even if a
// later, unrelated call to getQueueManager() (e.g. to enqueue an enrichment
// job) succeeds in bringing up BullMQ for other queues. This is the single
// source of truth for "which mechanism owns GHL sync", independent of
// whether BullMQ itself is up or down.
let _legacyGhlSyncClaimed = false;

/** Called once by server/index.ts when it falls back to the legacy setInterval
 * GHL sync loop, so BullMQ (now or later) permanently excludes GHL_SYNC from
 * the queues/workers/repeatable-jobs it manages for the rest of this process. */
export function claimLegacyGhlSync(): void {
  if (_queueManager?.getQueue(QUEUE_NAMES.GHL_SYNC)) {
    throw new Error("Cannot claim legacy GHL sync after the BullMQ GHL_SYNC worker is initialized.");
  }
  _legacyGhlSyncClaimed = true;
}

export function isLegacyGhlSyncClaimed(): boolean {
  return _legacyGhlSyncClaimed;
}

export function deriveQueueMode(queueManagerReady: boolean, legacyGhlSyncClaimed: boolean): QueueMode {
  if (legacyGhlSyncClaimed) return "legacy_interval_partial";
  return queueManagerReady ? "bullmq_redis" : "unavailable";
}

/** The sole queue-mode authority for API and operator surfaces. */
export function getQueueMode(): QueueMode {
  return deriveQueueMode(_queueManager !== null, _legacyGhlSyncClaimed);
}

export async function getQueueManager(): Promise<QueueManager> {
  if (_queueManager) return _queueManager;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const qm = new QueueManager();
    try {
      await qm.initialize();
    } catch (err) {
      // initialize() can throw partway through setupQueues/setupWorkers/setupRepeatableJobs,
      // meaning some BullMQ queues/workers (e.g. GHL_SYNC) may already be created and
      // actively consuming repeatable jobs. Tear those down before propagating the error so
      // callers that fall back to the legacy setInterval mechanism never run both at once.
      console.error("[QueueManager] Initialization failed — shutting down partially-initialized queues/workers to prevent duplicate sync execution:", (err as Error).message);
      await qm.shutdown().catch(shutdownErr =>
        console.error("[QueueManager] Failed to tear down partially-initialized queue manager:", (shutdownErr as Error).message)
      );
      _initPromise = null;
      throw err;
    }
    _queueManager = qm;
    _initPromise = null;
    const { recoverStatementUploadCommands } = await import("./statement-command-worker");
    await recoverStatementUploadCommands();

    // (#1532) Inject coordinator reference so physical reconciliation can call
    // queue.pause()/queue.resume()/queue.isPaused() for Phase 4 pilot queues.
    try {
      const { outboundQueueCoordinator } = await import("./outbound-queue-coordinator");
      outboundQueueCoordinator.setQueueManager(qm);
    } catch (coordinatorErr: any) {
      console.warn("[QueueManager] Coordinator injection failed (non-fatal):", coordinatorErr.message);
    }

    return qm;
  })();

  return _initPromise;
}

/**
 * (#1532) Returns the initialized QueueManager if fully initialized; throws otherwise.
 * Route handlers and health probes MUST use this instead of getQueueManager() so they
 * report 'not_initialized' rather than lazily starting the full worker fleet.
 *
 * G-02 gate: no route, probe, or producer may create/start Workers.
 */
export function requireQueueManagerReady(): QueueManager {
  if (!_queueManager) {
    throw new Error(
      "QueueManager not yet initialized — use getQueueManager() from server/index.ts startup, " +
      "not from route handlers or health probes. This prevents lazy worker initialization from HTTP requests.",
    );
  }
  return _queueManager;
}

/**
 * (#1532) Returns the BullMQ Queue instance for producer-only operations (enqueue jobs).
 * Does NOT initialize workers or schedulers. Returns null if QueueManager is not yet ready.
 * Producers (enrichment triggers, promotional enrollment triggers, etc.) use this to enqueue
 * without accidentally spawning the full worker fleet.
 */
export function getQueueManagerProducers(): QueueManager | null {
  return _queueManager;
}

export interface WorkerCapabilityStatus {
  /** Whether the current BACKGROUND_JOB_PROFILE selects this physical queue at all. */
  selected: boolean;
  /** Whether the QueueManager singleton has fully initialized (workers constructed). */
  queueManagerReady: boolean;
  /** Whether a live BullMQ Worker is actually instantiated for this queue right now. */
  workerActive: boolean;
  activeProfile: BackgroundProfile;
  selectedGroups: WorkerCapabilityGroup[];
}

/**
 * Truthful, read-only answer to "can this queue's recurring tick actually run
 * right now" — combines profile/capability-group selection with the live
 * QueueManager's actual worker registry, so an admin status endpoint never
 * has to guess or infer from DB state alone.
 *
 * Safe to call before QueueManager initializes (returns queueManagerReady:false,
 * workerActive:false rather than throwing).
 */
export function getWorkerCapabilityStatus(queueName: string): WorkerCapabilityStatus {
  const activeProfile = getBackgroundProfile();
  const selectedGroups = activeProfile === "selective" ? getSelectiveGroups() : [];

  let selected: boolean;
  if (activeProfile === "off") {
    selected = false;
  } else if (activeProfile === "ghl-sync-only") {
    selected = queueName === QUEUE_NAMES.GHL_SYNC;
  } else if (activeProfile === "core") {
    selected = CORE_QUEUE_ALLOWLIST.includes(queueName);
  } else if (activeProfile === "selective") {
    selected = getQueuesForCapabilityGroups(selectedGroups).includes(queueName);
  } else {
    // "full" — every configured queue except the legacy-GHL-sync carve-out,
    // which does not apply to this queue.
    selected = QUEUE_CONFIGS.some((c) => c.name === queueName);
  }

  const queueManagerReady = isQueueManagerReady();
  const workerActive = queueManagerReady ? (_queueManager?.isQueueWorkerActive(queueName) ?? false) : false;

  return { selected, queueManagerReady, workerActive, activeProfile, selectedGroups };
}

/**
 * (#1532) Returns true if the QueueManager is fully initialized (queues + workers + schedules).
 */
export function isQueueManagerReady(): boolean {
  return _queueManager !== null;
}

export async function shutdownQueueManager(): Promise<void> {
  if (_queueManager) {
    await _queueManager.shutdown();
    _queueManager = null;
  }
  _initPromise = null;
}

/**
 * Live-update a queue's repeat interval without a process restart.
 * Delegates to QueueManager.updateQueueRepeatInterval().
 * Safe to call when QueueManager is not yet initialized — returns { updated: false }
 * without throwing.
 */
export async function updateQueueIntervalLive(
  queueName: string,
  newIntervalMs: number
): Promise<{ updated: boolean; effectiveMs: number }> {
  if (!_queueManager) return { updated: false, effectiveMs: newIntervalMs };
  return _queueManager.updateQueueRepeatInterval(queueName, newIntervalMs);
}

/**
 * Returns the currently-running repeat intervals for all queues as reported by
 * the live QueueManager instance. Returns an empty object when the manager is
 * not yet initialized.
 */
export function getEffectiveQueueIntervals(): Record<string, number> {
  if (!_queueManager) return {};
  return _queueManager.getEffectiveIntervals();
}

interface ThroughputEntry {
  count: number;
  recordedAt: number;
}

interface HistoryBucket {
  hour: number;
  completed: number;
  failed: number;
}

const HISTORY_HOURS = 24;

export class QueueManager {
  private queues: Map<string, Queue> = new Map();

  private workers: Map<string, Worker> = new Map();
  private readyWorkers: Set<string> = new Set();
  private processLastCompletedAt: Map<string, number> = new Map();
  private processLastFailedAt: Map<string, number> = new Map();
  private processCompletedCount: Map<string, number> = new Map();

  /** Expose underlying BullMQ Queue for one-off job enqueuing. */
  getQueue(name: string): Queue | undefined {
    return this.queues.get(name);
  }

  private queuePrefix(queueName: string): string | undefined {
    return getBullMqPrefixForQueue(queueName, getCro03cQueueTopologyHash());
  }

  /**
   * Truthful worker-capability check for a single physical queue name.
   * Used by admin status surfaces (e.g. Task #2002's Sunbiz backfill Resume
   * control) that must not report "running" when the runtime cannot
   * actually execute the queue's recurring tick.
   */
  isQueueWorkerActive(queueName: string): boolean {
    const worker = this.workers.get(queueName);
    return Boolean(worker && this.readyWorkers.has(queueName) && worker.isRunning());
  }

  private connection!: ConnectionOptions;
  private redisKeyPrefix: string | undefined;
  private cro03cHeartbeatTimer: NodeJS.Timeout | null = null;
  private cro03cHeartbeatKey: string | null = null;
  private sfpRuntimeOwnerTimer: NodeJS.Timeout | null = null;
  private readonly sfpWakeupSelectionVersionByQueue = new Map<string, number>();

  private throughputBaseline: Map<string, ThroughputEntry> = new Map();

  private jobHistory: Map<string, HistoryBucket[]> = new Map();
  private readonly observationStartedAt = new Date();

  /** Runtime-effective repeat intervals. Populated from QUEUE_CONFIGS at startup
   * and updated by updateQueueRepeatInterval() when an admin changes a setting. */
  private effectiveIntervals: Map<string, number> = new Map();

  /** Configs to actually manage. Gated by BACKGROUND_JOB_PROFILE:
   *   "off"      → [] (no workers constructed)
   *   "core"     → only queues in CORE_QUEUE_ALLOWLIST (starts empty, populated operationally)
   *   "selective:group1,group2" → only queues in the named capability groups
   *                               (see WORKER_CAPABILITY_GROUPS in background-profile.ts)
   *   "full"     → all queues except GHL_SYNC when legacy fallback is claimed
   *
   * W01: selective mode provides validated, bounded queue selection without enabling
   * all 29 queues. BACKGROUND_JOB_PROFILE=selective:enrichment,ghl-integration
   * starts only those two groups' physical queues.
   */
  private activeConfigs(): QueueConfig[] {
    const profile = getBackgroundProfile();
    if (profile === "off") return [];
    if (profile === "ghl-sync-only") {
      return QUEUE_CONFIGS.filter(c => c.name === QUEUE_NAMES.GHL_SYNC);
    }

    const legacyBase = _legacyGhlSyncClaimed
      ? QUEUE_CONFIGS.filter(c => c.name !== QUEUE_NAMES.GHL_SYNC)
      : QUEUE_CONFIGS;

    if (profile === "core") {
      const active = legacyBase.filter(c => CORE_QUEUE_ALLOWLIST.includes(c.name));
      if (active.length === 0 && CORE_QUEUE_ALLOWLIST.length === 0) {
        console.warn(
          "[QueueManager] profile=core but CORE_QUEUE_ALLOWLIST is empty — " +
          "no workers will start. Populate the allowlist operationally or use " +
          "BACKGROUND_JOB_PROFILE=selective:<groups> for named capability selection."
        );
      }
      return active;
    }

    if (profile === "selective") {
      const groups = getSelectiveGroups();
      const allowedQueues = getQueuesForCapabilityGroups(groups);
      const active = legacyBase.filter(c => allowedQueues.includes(c.name));
      console.log(JSON.stringify({
        event: "queue-manager:selective-profile",
        groups,
        allowedQueues,
        activeQueueCount: active.length,
        ts: new Date().toISOString(),
      }));
      return active;
    }

    // "full" — existing behavior
    if (_legacyGhlSyncClaimed) {
      console.warn("[QueueManager] Legacy GHL sync already active for this process — excluding GHL_SYNC from BullMQ setup.");
    }
    return legacyBase;
  }

  async initialize(): Promise<void> {
    this.redisKeyPrefix = getBullMqTestPrefix();
    this.connection = await getRedisConnection();
    await this.setupQueues();
    await this.startSfpRuntimeOwnerHeartbeat();

    // Prime kill-switch cache: one batched DB read for all active queue names
    // before any worker starts, so the first job execution never hits a cache miss.
    const activeNames = this.activeConfigs().map(c => c.name);
    if (activeNames.length > 0) {
      try {
        const { primeKillSwitchCache } = await import("./automation-kill-switch");
        const { db: dbInst } = await import("../db");
        const { automationRegistry: regTable } = await import("@shared/schema");
        const { inArray } = await import("drizzle-orm");
        const rows = await dbInst
          .select({ key: regTable.key, killSwitchEnabled: regTable.killSwitchEnabled })
          .from(regTable)
          .where(inArray(regTable.key, activeNames));
        primeKillSwitchCache(rows);
      } catch (primeErr) {
        console.warn("[QueueManager] Kill-switch cache prime failed — workers will query individually:", (primeErr as Error).message);
      }
    }

    await this.setupWorkers();
    await this.setupRepeatableJobs();
    await this.cleanupStaleActiveJobs();
    await this.startCro03cWorkerHeartbeat();
    // Auto-converge the CRO-03C deployment inventory immediately after publishing the
    // startup heartbeat.  This eliminates the manual "Issue Attestation" prerequisite:
    // the inventory is rebuilt from the live Redis fleet evidence on every startup so
    // the gate-diagnostics endpoint can open the ceremony without operator action.
    // Fire-and-forget (setImmediate) so a transient convergence error never blocks
    // the rest of startup.  Errors are logged but do not abort initialization.
    setImmediate(() => {
      Promise.resolve().then(async () => {
        try {
          const { convergeCro03cDeploymentInventory } = await import("./cro03-inventory-convergence");
          const result = await convergeCro03cDeploymentInventory({
            actorId: "system:startup",
            workerWaitMs: 15_000,
          });
          if (result.converged) {
            console.log(
              `[CRO03C] Startup inventory convergence: inventoryId=${result.inventoryId}` +
              ` workers=${result.workerCount} replayed=${result.replayed}`,
            );
          } else {
            console.warn(`[CRO03C] Startup inventory convergence deferred: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
          }
        } catch (err: unknown) {
          console.warn(`[CRO03C] Startup inventory convergence error (non-fatal): ${(err as Error)?.message}`);
        }
      });
    });

    // Recover source-registry import runs left in queued/running state by a prior crash.
    // Two phases:
    //   1. Cancel running runs with expired leases (worker likely crashed mid-run).
    //   2. Re-enqueue stranded queued runs (process crashed between DB insert and enqueue).
    // Runs after workers are set up so re-enqueued jobs are immediately processable.
    try {
      const {
        cancelStaleRuns,
        cancelStaleQueuedRuns,
        listStrandedQueuedRuns,
      } = await import("../services/source-registry/import-runner");

      // Phase 1: Cancel running runs with expired leases
      const cancelled = await cancelStaleRuns();
      if (cancelled > 0) {
        console.log(`[QueueManager] Startup: cancelled ${cancelled} stale source-registry running run(s) (expired lease)`);
      }

      // Phase 2: Re-enqueue stranded queued runs (process crashed before enqueue)
      const stranded = await listStrandedQueuedRuns();
      if (stranded.length > 0) {
        const sourceRegistryQueue = this.queues.get(QUEUE_NAMES.SOURCE_REGISTRY_IMPORT);
        if (sourceRegistryQueue) {
          for (const { runId, adapterKey } of stranded) {
            try {
              await sourceRegistryQueue.add(
                `source-registry-import:${adapterKey}`,
                { runId },
                { removeOnComplete: 50, removeOnFail: 100 }
              );
              console.log(`[QueueManager] Startup: re-enqueued stranded source-registry run ${runId} for adapter ${adapterKey}`);
            } catch (enqErr) {
              console.warn(`[QueueManager] Startup: failed to re-enqueue stranded run ${runId}:`, (enqErr as Error).message);
            }
          }
        }
      }

      // Phase 3: Cancel queued runs older than STALE_RUN_TIMEOUT_MS with no csv_data (unrecoverable)
      const cancelledQueued = await cancelStaleQueuedRuns();
      if (cancelledQueued > 0) {
        console.log(`[QueueManager] Startup: cancelled ${cancelledQueued} unrecoverable stale source-registry queued run(s)`);
      }
    } catch (srErr) {
      // Non-fatal: stale run recovery is best-effort
      console.warn("[QueueManager] Source registry stale-run recovery failed:", (srErr as Error).message);
    }

    // Emit structured startup topology log — no credentials, no PII, no Redis URLs.
    // Connection math (BullMQ v5 shared-client architecture):
    //   • 1 shared IORedis instance for ALL Queue non-blocking ops + Worker non-blocking ops
    //   • 1 blocking connection per instantiated Worker (internal .duplicate() — unavoidable)
    //   estimatedProcessConnections = 1 (shared) + instantiatedWorkerCount
    const { diagnoseRedisCapacity } = await import("./queue-connection");
    const snapshot = this.getTopologySnapshot();
    const capacity = diagnoseRedisCapacity({
      physicalWorkerCount: snapshot.instantiatedWorkerCount,
    });
    const REDIS_CONNECTION_WARN_THRESHOLD =
      parseInt(process.env.REDIS_CONNECTION_WARN_THRESHOLD ?? "18", 10) || 18;
    console.log(JSON.stringify({
      event: "queue-manager:initialized",
      manifestConfigCount: snapshot.manifestConfigCount,
      activeConfigCount: snapshot.activeConfigCount,
      instantiatedQueueCount: snapshot.instantiatedQueueCount,
      instantiatedWorkerCount: snapshot.instantiatedWorkerCount,
      readyWorkerCount: snapshot.readyWorkerCount,
      estimatedProcessConnections: capacity.estimatedProcessConnections,
      capacityStatus: capacity.status,
      legacyGhlClaimed: snapshot.legacyGhlClaimed,
      queueMode: snapshot.queueMode,
      processIdentity: snapshot.processIdentity,
      releaseSha: snapshot.releaseSha,
      sequencesRepeatEveryMs: SEQUENCES_REPEAT_EVERY_MS,
      ghlSyncRepeatEveryMs: GHL_SYNC_REPEAT_EVERY_MS,
      slaChecksRepeatEveryMs: SLA_CHECKS_REPEAT_EVERY_MS,
      capturedAt: snapshot.capturedAt,
    }));
    if (capacity.estimatedProcessConnections >= REDIS_CONNECTION_WARN_THRESHOLD) {
      console.warn(
        `[QueueManager] ⚠️  Redis connection headroom warning: ~${capacity.estimatedProcessConnections} estimated process connections ` +
        `(threshold=${REDIS_CONNECTION_WARN_THRESHOLD}). ` +
        `Set REDIS_CONNECTION_LIMIT env var to enable capacity status monitoring. ` +
        `Set REDIS_CONNECTION_WARN_THRESHOLD env var to adjust this threshold.`
      );
    }

    // Certification uses route-level readiness plus local fakes. The operational
    // sweep intentionally probes providers and must not run in zero-egress mode.
    if (process.env.VG_PROVIDER_DENY_MODE !== "1") {
      import("./health-monitor").then(m => m.runHealthChecks()).catch(e =>
        console.warn("[HealthMonitor] Startup check failed:", e)
      );
    } else {
      console.log("[HealthMonitor] Startup provider sweep skipped in certification deny mode.");
    }
  }

  private async startCro03cWorkerHeartbeat(): Promise<void> {
    const {
      CRO03C_WORKER_HEARTBEAT_INTERVAL_MS,
      createCro03cWorkerHeartbeat,
      cro03cHeartbeatKey,
      publishCro03cWorkerHeartbeat,
    } = await import("./cro03/runtime-heartbeat");
    const redis = this.connection as any;
    // W09: include stable environment + deployment fields so heartbeats can
    // be bound to their deployment namespace independently of PID.
    const heartbeat = createCro03cWorkerHeartbeat({
      releaseSha: process.env.RELEASE_SHA ?? "",
      processIdentity: process.env.PROCESS_IDENTITY,
      queueTopologyHash: getCro03cQueueTopologyHash(),
      environmentIdentity: process.env.NODE_ENV,
      deploymentIdentity: process.env.REPL_DEPLOYMENT_ID ?? process.env.REPL_ID,
      enabledGroups: process.env.BACKGROUND_JOB_PROFILE ?? "off",
    });
    const publish = async () => {
      const configuredWorkers = this.activeConfigs().length;
      if (this.readyWorkers.size < configuredWorkers) {
        console.warn(JSON.stringify({
          event: "cro03c:worker-heartbeat-deferred",
          readyWorkerCount: this.readyWorkers.size,
          expectedWorkerCount: configuredWorkers,
          releaseSha: process.env.RELEASE_SHA ?? null,
          timestamp: new Date().toISOString(),
        }));
        return;
      }
      await publishCro03cWorkerHeartbeat(redis, this.redisKeyPrefix, {
        ...heartbeat,
        timestamp: new Date().toISOString(),
      });
    };
    await publish();
    this.cro03cHeartbeatKey = cro03cHeartbeatKey(this.redisKeyPrefix, heartbeat.bootIdentity);
    this.cro03cHeartbeatTimer = setInterval(() => {
      publish().catch((error: Error) =>
        console.error("[QueueManager] CRO03C worker heartbeat publish failed:", error.message));
    }, CRO03C_WORKER_HEARTBEAT_INTERVAL_MS);
    this.cro03cHeartbeatTimer.unref?.();
  }

  private async startSfpRuntimeOwnerHeartbeat(): Promise<void> {
    const sfpQueueNames = new Set<QueueName>([
      QUEUE_NAMES.SFP_CAMPAIGN_STAGING,
      QUEUE_NAMES.SFP_FREE_CLASSIFICATION,
      QUEUE_NAMES.SFP_CONTINUOUS_DISCOVERY,
      QUEUE_NAMES.SFP_CONTINUOUS_VALIDATION,
      QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY,
    ]);
    const activeSfpConfigs = this.activeConfigs().filter((config) => sfpQueueNames.has(config.name));
    if (!activeSfpConfigs.length) return;
    const checkAndWake = async () => {
      try {
        const {
          getSfpRuntimeReleaseSelectionStatus,
          renewSfpRuntimeDeploymentOwner,
        } = await import("./cro03/sfp-provider-operations");
        const status = await getSfpRuntimeReleaseSelectionStatus();
        if (!status.currentReleaseSelected || !status.selectedRelease) return;

        // Selection can happen after this process started held. Wake its
        // already-running SFP workers immediately; they perform their normal
        // owner claims/gates. The heartbeat itself remains renewal-only.
        for (const config of activeSfpConfigs) {
          const queue = this.queues.get(config.name);
          const selectedVersion = status.selectedRelease.selectionVersion;
          if (!queue || (this.sfpWakeupSelectionVersionByQueue.get(config.name) ?? 0) >= selectedVersion) continue;
          try {
            await queue.add(config.jobName, {}, {
              jobId: `sfp-selected-${config.name}-${selectedVersion}`,
              removeOnComplete: true,
              removeOnFail: true,
            });
            this.sfpWakeupSelectionVersionByQueue.set(config.name, selectedVersion);
          } catch (error: any) {
            console.warn(`[QueueManager] SFP selection wakeup enqueue failed for ${config.name}: ${String(error?.message ?? error)}`);
          }
        }

        if (status.ownerLive)
          await withTransactionPhase("sfp_runtime_selection_watch_renewal",renewSfpRuntimeDeploymentOwner);
      } catch (error: any) {
        const summary = summarizeFailureForLog(error);
        console.warn(`[QueueManager] Routine-SFP runtime owner unavailable: ${summary}`);
      }
    };
    await checkAndWake();
    this.sfpRuntimeOwnerTimer = setInterval(() => {
      void checkAndWake();
    }, 30_000);
    this.sfpRuntimeOwnerTimer.unref?.();
  }

  /**
   * On startup, remove any BullMQ jobs that are stuck in the "active" state
   * from a previous process that crashed mid-job. Jobs older than 2× lockDuration
   * (240 s) can never renew their lock and will generate an endless stream of
   * "could not renew lock" errors that block new work from being processed.
   */
  private async cleanupStaleActiveJobs(): Promise<void> {
    const STALE_THRESHOLD_MS = 2 * 120_000; // 2× lockDuration
    const now = Date.now();
    let totalCleaned = 0;

    for (const [name, queue] of this.queues) {
      try {
        const activeJobs = await queue.getActive();
        for (const job of activeJobs) {
          const startedAt = job.processedOn ?? 0;
          if (startedAt > 0 && now - startedAt > STALE_THRESHOLD_MS) {
            try {
              await job.moveToFailed(
                new Error(`Stale active job cleaned up on startup (active for ${Math.round((now - startedAt) / 1000)}s)`),
                job.token ?? "startup-cleanup",
                true, // remove from active list
              );
              console.log(`[QueueManager] Cleaned stale active job ${job.id} from queue:${name} (${Math.round((now - startedAt) / 1000)}s old)`);
              totalCleaned++;
            } catch (moveErr) {
              // moveToFailed can fail if another worker already claimed it — safe to ignore
              console.warn(`[QueueManager] Could not move stale job ${job.id} in queue:${name} to failed:`, (moveErr as Error).message);
            }
          }
        }
      } catch (err) {
        // Non-fatal: if Redis is unreachable at startup we still want to continue
        console.warn(`[QueueManager] Stale job cleanup failed for queue:${name}:`, (err as Error).message);
      }
    }

    if (totalCleaned > 0) {
      console.log(`[QueueManager] Startup cleanup: moved/removed ${totalCleaned} stale active job(s)`);
    }
  }

  private async setupQueues(): Promise<void> {
    for (const config of this.activeConfigs()) {
      const queue = new Queue(config.name, {
        connection: this.connection,
        prefix: this.queuePrefix(config.name),
        defaultJobOptions: {
          attempts: config.attempts,
          backoff: {
            type: "exponential",
            delay: config.backoffDelay,
          },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 200 },
        },
      });
      this.queues.set(config.name, queue);
    }
  }

  private async setupWorkers(): Promise<void> {
    const { featureFlags } = await import("./feature-flags");

    for (const config of this.activeConfigs()) {
      const processor = this.buildProcessor(config.name, featureFlags);
      const worker = new Worker(config.name, processor, {
        connection: this.connection,
        prefix: this.queuePrefix(config.name),
        concurrency: config.concurrency,
        // Give each job 2 minutes to complete before BullMQ considers the lock
        // expired. The previous default of 30 s was too short for Serper/GHL
        // network calls and AI scoring jobs, causing "could not renew lock".
        lockDuration: 120_000,
        // Check for stalled jobs every 30 s (job grabbed by worker but lock
        // renewal stopped — e.g. worker process crashed).
        stalledInterval: 30_000,
        // Allow a job to be recovered from stalled state up to 2 times before
        // marking it failed. Prevents infinite stall loops on a consistently
        // slow job while still tolerating a single transient network hiccup.
        maxStalledCount: 2,
      });

      worker.on("completed", (job: Job) => {
        const duration = Date.now() - (job.processedOn ?? Date.now());
        if (process.env.NODE_ENV !== "production" || job.opts.repeat) {
          console.log(`[Queue:${config.name}] Job ${job.id} completed in ${duration}ms`);
        }
        this.recordHistoryEvent(config.name, "completed");
        this.processLastCompletedAt.set(config.name, Date.now());
        this.processCompletedCount.set(config.name, (this.processCompletedCount.get(config.name) ?? 0) + 1);
        // Reset consecutive failure count in background_jobs so the health dashboard
        // reflects a clean run without needing to wait for a separate read.
        import("./job-registry").then(({ recordWorkerSuccess }) =>
          recordWorkerSuccess(config.name).catch(e =>
            console.error(`[QueueManager] recordWorkerSuccess failed for ${config.name}:`, e)
          )
        );
        // Update automation_registry last_run_at
        const returnValue = job.returnvalue as { checked?: number; resendsSent?: number; processed?: number; reminded?: number; errors?: number } | null | undefined;
        const recordsAffected = returnValue
          ? (returnValue.resendsSent ?? returnValue.reminded ?? returnValue.processed ?? null)
          : null;
        const runErrors = returnValue?.errors ?? null;
        import("../db").then(({ db: dbInst }) =>
          import("@shared/schema").then(({ automationRegistry: reg }) =>
            import("drizzle-orm").then(({ eq: eqOp }) =>
              dbInst
                .update(reg)
                .set({
                  lastRunAt: new Date(),
                  lastRunRecordsAffected: recordsAffected ?? 0,
                  lastRunErrors: runErrors ?? 0,
                  updatedAt: new Date(),
                })
                .where(eqOp(reg.key, config.name))
                .catch(e => console.error(`[QueueManager] registry update failed for ${config.name}:`, e))
            )
          )
        );
      });

      worker.on("failed", async (job: Job | undefined, err: Error) => {
        if (!job) return;
        const attemptsRemaining = (job.opts.attempts ?? 1) - job.attemptsMade;
        const failureCode = classifyWorkerError(err);
        console.error(JSON.stringify({
          event: "queue:job-failed",
          queueName: config.name,
          jobName: job.name,
          attempts: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
          failureCode,
          // Message text can carry SQL or contact data, so log only the error class name and a
          // short code (e.g. a Postgres SQLSTATE). This makes "unknown" failures traceable.
          errorName: /^[A-Za-z0-9_]{1,60}$/.test(String(err?.name ?? "")) ? String(err.name) : null,
          errorCode: /^[A-Za-z0-9_]{2,40}$/.test(String((err as any)?.code ?? "")) ? String((err as any).code) : null,
        }));
        this.recordHistoryEvent(config.name, "failed");
        this.processLastFailedAt.set(config.name, Date.now());

        // Persist the failure to background_jobs and get the durable consecutive count.
        // This keeps health monitoring accurate across restarts and surfaced on the
        // Operator Dashboard (which reads background_jobs via getJobStatuses()).
        const { recordWorkerFailure } = await import("./job-registry");
        const consecutiveCount = await recordWorkerFailure(config.name, failureCode).catch(() => 0);

        if (consecutiveCount >= WORKER_FAILURE_ALERT_THRESHOLD) {
          const event = sanitizeDeadLetterEvent({
            queueName: config.name,
            jobName: job.name,
            failureCode,
            attempts: job.attemptsMade,
            maxAttempts: job.opts.attempts ?? 1,
            occurredAt: new Date().toISOString(),
            source: "consecutive_failure_threshold",
            retryable: attemptsRemaining > 0,
          });
          console.error(JSON.stringify({
            event: "queue:consecutive-failure-threshold",
            queueName: event.queueName,
            jobName: event.jobName,
            failureCode: event.failureCode,
            consecutiveFailures: consecutiveCount,
            threshold: WORKER_FAILURE_ALERT_THRESHOLD,
          }));
          storage.createReviewQueueItem({
            sourceType: "dead_letter_job" as any,
            sourceId: 0,
            status: "pending",
            notes: "Queue crossed the consecutive-failure review threshold. See canonical BullMQ retention for operational details.",
            metadata: event,
          }).catch(() => console.error(JSON.stringify({
            event: "queue:threshold-review-persist-failed",
            queueName: event.queueName,
            failureCode: event.failureCode,
          })));
        }

        if (attemptsRemaining <= 0) {
          await this.createReviewQueueItem(config.name, job, err).catch(e =>
            console.error("[QueueManager] Failed to create review queue item:", e)
          );

          // ── SOURCE_REGISTRY_IMPORT: terminal failure finalization ───────────
          // When all BullMQ retry attempts are exhausted the run row is still 'queued'
          // (reset by the last retryable throw). Mark it permanently failed and clear
          // csv_data so the unique partial index releases the adapter slot and the
          // admin UI stops polling.
          if (config.name === QUEUE_NAMES.SOURCE_REGISTRY_IMPORT) {
            try {
              const jobData = job.data as { runId?: string };
              if (jobData?.runId) {
                const { pool: _pool } = await import("../db");
                await _pool.query(
                  `UPDATE source_import_runs
                   SET status = 'failed', completed_at = NOW(), csv_data = NULL,
                       error_text = $2
                   WHERE id = $1::uuid AND status IN ('queued', 'running')`,
                  [jobData.runId, `SOURCE_REGISTRY_EXHAUSTED: all BullMQ retry attempts exhausted. Last error: ${err.message.substring(0, 1600)}`]
                );
                console.warn(JSON.stringify({
                  event: "source_registry:run_exhausted",
                  runId: jobData.runId,
                  attempts: job.attemptsMade,
                }));
              }
            } catch (finErr) {
              console.error("[QueueManager] source-registry terminal finalization failed:", (finErr as Error).message);
            }
          }
        }
      });

      // ── Worker lifecycle telemetry ───────────────────────────────────────────
      // Structured logs for ready / error / closed events.
      // Never logs: Redis URLs, credentials, job payloads, contact PII, merchant data.

      worker.on("ready", () => {
        this.readyWorkers.add(config.name);
        console.log(JSON.stringify({
          event: "worker:ready",
          queue: config.name,
          processId: process.pid,
          processIdentity: process.env.PROCESS_IDENTITY ?? null,
          releaseSha: process.env.RELEASE_SHA ?? null,
          timestamp: new Date().toISOString(),
        }));
      });

      // Extend existing error listener with structured classification + redaction.
      worker.on("error", (err: Error) => {
        const failureClass = classifyWorkerError(err);
        const redactedMessage = redactWorkerErrorMessage(err.message ?? "");
        console.error(JSON.stringify({
          event: "worker:error",
          queue: config.name,
          errorClass: err.constructor?.name ?? "Error",
          errorCode: (err as any).code ?? null,
          redactedMessage,
          failureClass,
          processId: process.pid,
          processIdentity: process.env.PROCESS_IDENTITY ?? null,
          releaseSha: process.env.RELEASE_SHA ?? null,
          timestamp: new Date().toISOString(),
        }));
      });

      worker.on("closed", () => {
        this.readyWorkers.delete(config.name);
        console.log(JSON.stringify({
          event: "worker:closed",
          queue: config.name,
          processId: process.pid,
          processIdentity: process.env.PROCESS_IDENTITY ?? null,
          releaseSha: process.env.RELEASE_SHA ?? null,
          timestamp: new Date().toISOString(),
        }));
      });

      this.workers.set(config.name, worker);
    }
  }

  private buildProcessor(queueName: QueueName, featureFlags: any) {
    return async (_job: Job): Promise<void> => {
      // ── Per-job pool instrumentation ─────────────────────────────────────
      const jobStartMs = Date.now();
      const { pool: _pool } = await import("../db");
      console.log(JSON.stringify({
        event: "job:start",
        queue: queueName,
        jobId: _job.id,
        poolWaiting: _pool.waitingCount,
        poolTotal: _pool.totalCount,
        ts: new Date().toISOString(),
      }));

      // ── DB context tagging ───────────────────────────────────────────────
      // Sets correlationId + normalizedRoute on the AsyncLocalStorage context
      // so that any db:slow_query log emitted during this job carries the
      // queue name and job ID, making pool-bottleneck root-cause trivial.
      setDbContext({
        correlationId: _job.id ?? `${queueName}-${Date.now()}`,
        normalizedRoute: `BullMQ ${queueName}`,
      });

      try {

      // ── Automation kill-switch gate ──────────────────────────────────────
      // Check registry before executing. If kill_switch_enabled = true, skip.
      // W10: When a kill-switch fires, write a durable audit record so the
      // operator can see that authoritative work was suppressed and why.
      // A BullMQ job that simply returns without executing is indistinguishable
      // from one that ran successfully — the audit record provides the evidence.
      try {
        const { isAutomationEnabled } = await import("./automation-kill-switch");
        if (!(await isAutomationEnabled(queueName))) {
          console.info(`[AutomationRegistry] Queue ${queueName} is kill-switched, skipping job ${_job.id}`);
          // W10: write durable held record — non-fatal.
          // Schema: audit_logs(action text NN, entity_type text NN, entity_id int,
          //   actor_type text, actor_id text, details jsonb, created_at timestamp)
          try {
            const { db: _auditDb } = await import("../db");
            const { sql: _auditSql } = await import("drizzle-orm");
            await _auditDb.execute(_auditSql`
              INSERT INTO audit_logs (action, entity_type, entity_id, actor_type, actor_id, details, created_at)
              VALUES (
                'job.kill_switch_suppressed',
                'queue',
                NULL,
                'system',
                'queue-manager',
                ${JSON.stringify(sanitizeAuditPayload({
                  queue: queueName,
                  jobId: _job.id ?? null,
                  jobName: _job.name,
                  reason: "kill_switch_enabled",
                }))}::jsonb,
                NOW()
              )
            `);
          } catch (_auditErr) {
            console.warn(`[AutomationRegistry] Kill-switch audit write failed for ${queueName}:`, (_auditErr as Error).message);
          }
          return;
        }
      } catch (ksErr) {
        // C-05 (#1626): kill-switch check failed — FAIL CLOSED. If we cannot
        // read the registry, we cannot prove the queue is enabled; skip the
        // job rather than proceeding blind.
        console.warn(`[AutomationRegistry] Kill-switch check failed for ${queueName} — failing closed, retrying job ${_job.id}:`, (ksErr as Error).message);
        // W10: write durable held record for check failure too
        try {
          const { db: _auditDb } = await import("../db");
          const { sql: _auditSql } = await import("drizzle-orm");
          await _auditDb.execute(_auditSql`
            INSERT INTO audit_logs (action, entity_type, entity_id, actor_type, actor_id, details, created_at)
            VALUES (
              'job.kill_switch_suppressed',
              'queue',
              NULL,
              'system',
              'queue-manager',
              ${JSON.stringify(sanitizeAuditPayload({
                queue: queueName,
                jobId: _job.id ?? null,
                jobName: _job.name,
                reason: "kill_switch_check_failed",
                error: (ksErr as Error).message?.slice(0, 200) ?? "unknown",
              }))}::jsonb,
              NOW()
            )
          `);
        } catch (_auditErr) {
          console.warn(`[AutomationRegistry] Kill-switch check-failure audit write failed for ${queueName}:`, (_auditErr as Error).message);
        }
        // Throw rather than return so BullMQ retries the job via normal backoff
        // instead of marking it complete and permanently losing durable work.
        throw new Error(
          `[AutomationRegistry] Kill-switch registry unreachable for ${queueName} — job will be retried`,
        );
      }

      // ── W01: Per-job logical capability gate (selective mode) ────────────────
      // The physical queue filter (activeConfigs) already limits WHICH queues
      // start Workers, but a single physical queue can host logical jobs from
      // multiple capability groups (e.g. the `enrichment` queue also processes
      // `campaign-queue-run` and `inbound-confirmation-followup`). This gate
      // enforces default-deny at the processor boundary so that only jobs whose
      // logical capability group is in the active groups list are executed.
      // FAIL-CLOSED: any error in the gate itself suppresses the job. This is
      // intentional — a malfunctioning gate must not let outreach/GHL work run
      // under an enrichment-only profile.
      const _runtimeProfile = getBackgroundProfile();
      if (_runtimeProfile === "selective" || _runtimeProfile === "ghl-sync-only") {
        // ── Selective capability gate ─────────────────────────────────────────
        // Evaluate inside a try/catch so any gate error is caught. We use
        // _shouldDelayJob / _gcGateError flags rather than throwing inside the
        // try-block to ensure DelayedError always propagates OUTSIDE the catch
        // (BullMQ must receive it; swallowing it causes normal completion which
        // permanently loses durable application-level state, e.g. a pending
        // promotional_enrollment_jobs row that only re-queues on 'deferred').
        let _gcGateError: Error | null = null;
        let _shouldDelayJob = false; // set when moveToDelayed succeeds
        let _moveToDelayedFailed = false; // set when moveToDelayed itself throws
        try {
          const { getSelectiveGroups: _getGroups, getJobCapabilityGroup: _getJobGroup } =
            await import("./background-profile");
          const _activeGroups = _getGroups();
          const _jobGroup = _getJobGroup(queueName, _job.name);
          const _profileSelected = isQueueSelectedByBackgroundProfile(queueName);
          const _groupSelected = _runtimeProfile === "ghl-sync-only"
            ? queueName === QUEUE_NAMES.GHL_SYNC && _jobGroup === "ghl-integration"
            : _jobGroup === null
              || _activeGroups.includes(_jobGroup as any)
              || (queueName === QUEUE_NAMES.GHL_SYNC && _activeGroups.includes("ghl-sync-only" as any));
          if (!_profileSelected || !_groupSelected) {
            console.info(JSON.stringify({
              event: "job:selective_capability_suppressed",
              queue: queueName,
              jobName: _job.name,
              jobGroup: _jobGroup,
              activeGroups: _activeGroups,
              profile: _runtimeProfile,
              profileSelected: _profileSelected,
              jobId: _job.id,
              ts: new Date().toISOString(),
            }));
            try {
              const { db: _gcDb } = await import("../db");
              const { sql: _gcSql } = await import("drizzle-orm");
              await _gcDb.execute(_gcSql`
                INSERT INTO audit_logs (action, entity_type, entity_id, actor_type, actor_id, details, created_at)
                VALUES (
                  'job.selective_capability_suppressed',
                  'queue', NULL, 'system', 'queue-manager',
                  ${JSON.stringify(sanitizeAuditPayload({
                    queue: queueName,
                    jobId: _job.id ?? null,
                    jobName: _job.name,
                    jobGroup: _jobGroup,
                    activeGroups: _activeGroups,
                    profile: _runtimeProfile,
                    profileSelected: _profileSelected,
                    reason: "selective_capability_gate",
                  }))}::jsonb,
                  NOW()
                )
              `);
            } catch (_gcAuditErr) {
              console.warn(`[SelectiveProfile] Audit write failed:`, (_gcAuditErr as Error).message);
            }
            // Delay the BullMQ job so it is preserved for later authorized
            // execution. We set a flag here — the actual throw of DelayedError
            // must happen OUTSIDE the outer try/catch so it cannot be caught
            // by _gcGateError and turned into a silent return.
            const _SELECTIVE_DEFER_MS = 5 * 60_000; // 5 minutes
            try {
              await _job.moveToDelayed(Date.now() + _SELECTIVE_DEFER_MS, _job.token ?? undefined);
              _shouldDelayJob = true;
            } catch (_deferErr) {
              _moveToDelayedFailed = true;
              console.warn(
                `[SelectiveProfile] moveToDelayed failed for job=${_job.name} id=${_job.id}: ` +
                `${(_deferErr as Error).message}. Job will be retried via normal BullMQ backoff.`,
              );
            }
          }
        } catch (_gcErr) {
          _gcGateError = _gcErr instanceof Error ? _gcErr : new Error(String(_gcErr));
        }

        // ── Post-gate dispatch (outside try/catch so DelayedError reaches BullMQ) ──
        if (_shouldDelayJob) {
          // moveToDelayed succeeded — signal BullMQ to honor the delayed state.
          throw new DelayedError();
        }
        if (_moveToDelayedFailed) {
          // moveToDelayed failed — let BullMQ retry via normal backoff rather
          // than marking the job complete.
          throw new Error(
            `[SelectiveProfile] Suppressed job ${_job.name} could not be deferred; ` +
            `retrying via BullMQ backoff.`,
          );
        }
        // FAIL-CLOSED: gate check error → throw so BullMQ retries rather than
        // completing the job (completing would silently lose durable state).
        if (_gcGateError !== null) {
          console.error(
            `[SelectiveProfile] Per-job capability gate check FAILED (fail-closed) for ` +
            `queue=${queueName} job=${_job.name}: ${_gcGateError.message}`,
          );
          throw new Error(
            `[SelectiveProfile] Capability gate error for ${_job.name}: ${_gcGateError.message}`,
          );
        }
      }

      // ── Worker heartbeat ─────────────────────────────────────────────────────
      // Write a timestamp so the operator dashboard can detect stale workers.
      try {
        const { storage: hbStorage } = await import("../storage");
        await hbStorage.setSystemSetting(`worker_heartbeat_${queueName}`, Date.now());
      } catch (_hbErr) {
        // Non-fatal — heartbeat write should never block the actual job.
      }

      switch (queueName) {
        case QUEUE_NAMES.CRO03C_LIVE: {
          const { dispatchCro03cLive, recoverCro03cLiveDispatches } = await import("./cro03/live-worker");
          if (_job.name === "recover") {
            await recoverCro03cLiveDispatches();
          } else {
            await dispatchCro03cLive(typeof _job.data?.commandId === "string" ? _job.data.commandId : undefined);
          }
          // MI-06: After the main enrichment dispatch:
          // 1. Consume pending business_validation_intents (with active command authority).
          // 2. Retry DNS-indeterminate businesses that have new staged candidates.
          try {
            const {
              reclaimExpiredBusinessValidationClaims,
              dispatchPendingWinnerSelections,
              dispatchPendingBusinessValidationIntents,
              dispatchDnsIndeterminateRetries,
              markStaleBusinessEmails,
            } = await import("./cro03/business-validation-service");
            // Step 0: Reclaim pre-I/O expired claimed intents back to pending so
            // crashed-worker recoveries complete within one tick.
            const reclaimResult = await reclaimExpiredBusinessValidationClaims({ limit: 20 });
            if (reclaimResult.reclaimed > 0) {
              console.log(`[CRO03C BizReclaim] reclaimed=${reclaimResult.reclaimed}`);
            }
            // Step 1: Select winners for businesses with staged candidates.
            const winnerResult = await dispatchPendingWinnerSelections({ limit: 10 });
            if (winnerResult.triggered > 0 || winnerResult.errors > 0) {
              console.log(`[CRO03C BizWinner] triggered=${winnerResult.triggered} errors=${winnerResult.errors}`);
            }
            // Step 2: Consume pending validation intents (with active command authority).
            const bizResult = await dispatchPendingBusinessValidationIntents({ limit: 10 });
            if (bizResult.dispatched > 0 || bizResult.errors > 0) {
              console.log(`[CRO03C BizEmail] dispatched=${bizResult.dispatched} errors=${bizResult.errors}`);
            }
            // Step 3: Retry DNS-indeterminate businesses.
            const dnsResult = await dispatchDnsIndeterminateRetries({ limit: 5 });
            if (dnsResult.triggered > 0 || dnsResult.errors > 0) {
              console.log(`[CRO03C BizDNS] retried=${dnsResult.triggered} errors=${dnsResult.errors}`);
            }
            // Step 4: Mark provider_valid results as stale after 180 days (sampled — full
            // scan happens at most once per tick but is capped to avoid timeout).
            // Matches the 180-day validation aging window.
            const staleResult = await markStaleBusinessEmails({ limit: 50 });
            if (staleResult.marked > 0) {
              console.log(`[CRO03C BizStale] marked=${staleResult.marked}`);
            }
          } catch (bizErr: any) {
            // Never let business validation errors kill the main enrichment tick.
            console.error("[CRO03C BizEmail] dispatch error:", bizErr?.message ?? bizErr);
          }
          break;
        }
        case QUEUE_NAMES.CRO03A_QUALIFICATION: {
          const {
            processCro03aQualificationRunQueueSafe,
            recoverCro03aQualificationRunsQueueSafe,
            processOutboxCro03aQualificationCommands,
            watchdogCro03aStaleOccurrences,
            processRecurringCro03aGeographyQualification,
            backfillCro03aObservationGeography,
          } = await import("./cro03a/qualification-service");
          if (_job.name === "run" && typeof _job.data?.runId === "string") {
            await processCro03aQualificationRunQueueSafe(_job.data.runId);
          } else if (_job.name === "process-outbox") {
            const result = await processOutboxCro03aQualificationCommands();
            console.log(`[CRO03A Outbox] processed=${result.processed} failed=${result.failed}`);
          } else if (_job.name === "watchdog-stale-occurrences") {
            const result = await watchdogCro03aStaleOccurrences();
            console.log(`[CRO03A Watchdog] staleRuns=${result.staleRunCount} alertsWritten=${result.alertsWritten}`);
          } else if (_job.name === "recurring-geography-qualification") {
            // Run observation geography backfill first (bounded batch) so that
            // non-resolvable observations get stamped and excluded from future ticks.
            const backfillResult = await backfillCro03aObservationGeography(200);
            if (backfillResult.featureDetected) {
              console.log(
                `[CRO03A GeoBackfill] processed=${backfillResult.processed} eligible=${backfillResult.eligible} ineligible=${backfillResult.ineligible}`,
              );
            }
            const result = await processRecurringCro03aGeographyQualification({ limit: 500 });
            if (result) {
              console.log(`[CRO03A GeoQual] runId=${result.runId} total=${result.totalCount} replayed=${result.replayed}`);
            } else {
              console.log("[CRO03A GeoQual] no undecided South Florida occurrences found");
            }
          } else {
            await recoverCro03aQualificationRunsQueueSafe();
          }
          break;
        }
        case QUEUE_NAMES.DEAL_STAGE_EFFECTS: {
          const { dispatchDealStageEffectIntents } = await import("./deal-stage-effect-worker");
          await dispatchDealStageEffectIntents();
          break;
        }
        case QUEUE_NAMES.CHARGEBACK_COMMANDS: {
          const { recoverChargebackSubmissionCommands } = await import("./chargeback-submission-service");
          await recoverChargebackSubmissionCommands();
          break;
        }
        case QUEUE_NAMES.GHL_SYNC: {
          // W12: job name changed from generic "run" to "ghl-sync-tick" for
          // logical identity. Accept both to tolerate any pre-existing BullMQ
          // repeatable jobs with the old name until they drain.
          await runGhlSyncTick();
          break;
        }
        case QUEUE_NAMES.SLA_CHECKS: {
          await runSlaCheckTick();
          break;
        }
        case QUEUE_NAMES.SUNBIZ_FULL_BACKFILL: {
          const { runSunbizBackfillMicrobatch } = await import("./sunbiz-full-backfill");
          await runSunbizBackfillMicrobatch();
          break;
        }
        case QUEUE_NAMES.SEQUENCES: {
          // Queue-depth guard: warn when jobs are piling up faster than they finish.
          // With concurrency=1 and a 10-min repeat interval a healthy queue should
          // have 0–1 waiting jobs. >2 means the repeat interval is too short for the
          // actual run duration, or a prior run is still holding the acquireJobLock.
          try {
            const seqQueue = this.queues.get(QUEUE_NAMES.SEQUENCES);
            if (seqQueue) {
              const counts = await seqQueue.getJobCounts("waiting", "active", "delayed");
              const waiting = counts.waiting ?? 0;
              const active  = counts.active  ?? 0;
              if (waiting > 2) {
                console.warn(
                  `[Queue:sequences] depth warning — waiting=${waiting} active=${active}. ` +
                  `The repeat interval may be shorter than the actual run duration. ` +
                  `Consider increasing SEQUENCES repeatEveryMs or the run is stalled.`
                );
              } else {
                console.log(`[Queue:sequences] depth ok — waiting=${waiting} active=${active}`);
              }
            }
          } catch (_depthErr) {
            // Non-fatal: depth check should never block the actual tick
          }

          // Sequence rows are purpose-classified at their claim boundary; this
          // runner must remain available for explicitly transactional/human
          // response rows rather than globally treating that mixed queue as
          // promotional.
          decideCr06PromotionalLifecycle({ boundary: "queue_runner", purpose: "transactional" });
          if (featureFlags.LEGACY_OUTREACH_ENABLED) {
            await runSequencesTick();
          } else {
            // The legacy flag stays a containment switch for old producers. A live,
            // unexpired operator release is its own explicit authority: run only the
            // sequence worker, restricted to enrollments inside that release (no
            // campaign queue, no Sunbiz auto-convert, no legacy enrollment).
            const { readCanonicalReleaseControl, controlHasLiveAuthority, reconcileCanonicalReleases } = await import("./sfp-canonical-release");
            // Deadlines are applied on every tick BEFORE deciding whether anything is live, so an expired
            // admission window or journey is always cleaned up even when no release remains to run.
            await reconcileCanonicalReleases().catch((error) => {
              console.error("[SFP_CANONICAL_RELEASE_RECONCILE_FAILED]", error instanceof Error ? error.name : "UnknownError");
            });
            const control = await readCanonicalReleaseControl().catch(() => null);
            if (control && controlHasLiveAuthority(control)) {
              const { processSequenceEnrollments } = await import("./sequence-worker");
              await processSequenceEnrollments({ canonicalReleaseOnly: true });
            }
          }
          break;
        }
        case QUEUE_NAMES.ENRICHMENT: {
          if (_job.name === "campaign-queue-run" && typeof _job.data?.runId === "string") {
            if (decideCr06PromotionalLifecycle({ boundary: "queue_runner", purpose: "promotional" }).allowed) {
              const { processCampaignQueueRun } = await import("./campaign-engine");
              await processCampaignQueueRun(_job.data.runId);
            }
          } else if (_job.name === "statement-blueprint" && typeof _job.data?.dealId === "number") {
            await runStatementBlueprintJob(_job.data.dealId);
          } else if (_job.name === "free-contact-enrichment" && typeof _job.data?.businessId === "number") {
            await runFreeBusinessEnrichmentForBusiness(_job.data.businessId);
          } else if (_job.name === "free-contact-enrichment" && typeof _job.data?.merchantId === "number") {
            await runFreeContactEnrichmentForMerchant(_job.data.merchantId);
          } else if (_job.name === "inbound-confirmation-followup") {
            const { runInboundConfirmationFollowupJob } = await import("./ghl-workflow-enrollment");
            await runInboundConfirmationFollowupJob(_job.data);
          } else if (_job.name === "readiness_recalculation" && typeof _job.data?.contactId === "number") {
            const { computeDataReadinessScore, READINESS_MODEL_VERSION } = await import("./contact-readiness");
            const contact = await storage.getContact(_job.data.contactId);
            if (contact) {
              const r = computeDataReadinessScore(contact);
              await storage.updateContactReadiness(
                contact.id, r.score, r.grade, r.breakdown as Record<string, unknown>, READINESS_MODEL_VERSION,
              );
            }
          } else if (_job.name === "contact_lead_scoring" && typeof _job.data?.contactId === "number") {
            const { db: dbInst } = await import("../db");
            const { sql: sqlTag, eq: eqOp } = await import("drizzle-orm");
            const { contactLeadScoringJobs } = await import("@shared/schema");
            const { scoreContactBatchSafe } = await import("./lead-scoring");

            let contactId: number = _job.data.contactId;
            const { resolveLiveContactId } = await import("./contact-identity");
            contactId = await resolveLiveContactId(contactId);
            const dbRowId: number | undefined = _job.data.dbRowId;

            try {
              let activeRow: { id: number; requestedGeneration: number; processedGeneration: number } | undefined;

              if (dbRowId !== undefined) {
                const rows = await dbInst
                  .select({
                    id: contactLeadScoringJobs.id,
                    requestedGeneration: contactLeadScoringJobs.requestedGeneration,
                    processedGeneration: contactLeadScoringJobs.processedGeneration,
                  })
                  .from(contactLeadScoringJobs)
                  .where(eqOp(contactLeadScoringJobs.id, dbRowId))
                  .limit(1);
                activeRow = rows[0];
              }

              if (!activeRow) {
                const rows = await dbInst
                  .select({
                    id: contactLeadScoringJobs.id,
                    requestedGeneration: contactLeadScoringJobs.requestedGeneration,
                    processedGeneration: contactLeadScoringJobs.processedGeneration,
                  })
                  .from(contactLeadScoringJobs)
                  .where(eqOp(contactLeadScoringJobs.contactId, contactId))
                  .limit(1);
                activeRow = rows[0];
              }

              if (!activeRow) {
                return;
              }

              const { requestedGeneration: reqGen, processedGeneration: procGen } = activeRow;

              if (reqGen <= procGen) {
                await dbInst.execute(sqlTag`
                  UPDATE contact_lead_scoring_jobs
                  SET status       = 'completed',
                      completed_at = NOW(),
                      updated_at   = NOW()
                  WHERE id = ${activeRow.id}
                `);
                return;
              }

              await dbInst.execute(sqlTag`
                UPDATE contact_lead_scoring_jobs
                SET status             = 'processing',
                    execution_attempts = execution_attempts + 1,
                    updated_at         = NOW()
                WHERE id = ${activeRow.id}
              `);

              const scoringContact = await storage.getContact(contactId);
              if (!scoringContact) {
                await dbInst.execute(sqlTag`
                  UPDATE contact_lead_scoring_jobs
                  SET status       = 'contact_not_found',
                      updated_at   = NOW()
                  WHERE id = ${activeRow.id}
                `);
                return;
              }

              const inputVersionSnapshot = scoringContact.lastMeaningfulContactMutationAt ?? null;

              await scoreContactBatchSafe(contactId, { inputVersionSnapshot });

              const afterRows = await dbInst
                .select({ requestedGeneration: contactLeadScoringJobs.requestedGeneration })
                .from(contactLeadScoringJobs)
                .where(eqOp(contactLeadScoringJobs.id, activeRow.id))
                .limit(1);
              const latestReqGen = afterRows[0]?.requestedGeneration ?? reqGen;

              if (latestReqGen > reqGen) {
                // More work arrived while we were processing this generation.
                // We CANNOT safely re-enqueue from within an active BullMQ job
                // because the current job's stable jobId is still active in Redis
                // and queue.add() with the same jobId will be a no-op (dedup).
                // Instead, set status = pending_enqueue so the recovery worker
                // picks this up on the very next enrichment tick (by which time
                // this job will have completed and the jobId freed).
                await dbInst.execute(sqlTag`
                  UPDATE contact_lead_scoring_jobs
                  SET processed_generation = ${reqGen},
                      status               = 'pending_enqueue',
                      next_attempt_at      = NOW() + INTERVAL '5 seconds',
                      updated_at           = NOW()
                  WHERE id = ${activeRow.id}
                `);
              } else {
                await dbInst.execute(sqlTag`
                  UPDATE contact_lead_scoring_jobs
                  SET processed_generation = ${reqGen},
                      status               = 'completed',
                      completed_at         = NOW(),
                      updated_at           = NOW()
                  WHERE id = ${activeRow.id}
                `);
              }
            } catch (workerErr) {
              const isTerminalAttempt = (_job.attemptsMade ?? 0) >= (_job.opts?.attempts ?? 3) - 1;
              if (isTerminalAttempt) {
                await dbInst.execute(sqlTag`
                  UPDATE contact_lead_scoring_jobs
                  SET status         = 'failed_terminal',
                      last_error_code = ${(workerErr as Error).message?.slice(0, 200) ?? "error"},
                      updated_at      = NOW()
                  WHERE contact_id = ${contactId}
                    AND status NOT IN ('completed', 'contact_not_found', 'failed_terminal')
                `).catch((e) => console.error("[LeadScoring] Failed to mark failed_terminal:", e));
              }
              throw workerErr;
            }
          } else if (_job.name === "promotional-enrollment-eval" && typeof _job.data?.promotionalEnrollmentJobId === "number") {
            const { db: dbInst } = await import("../db");
            const { promotionalEnrollmentJobs } = await import("@shared/schema");
            const { eq } = await import("drizzle-orm");
            const { evaluatePromotionalEnrollmentEligibility } = await import("./promotional-enrollment-eligibility");
            const { autoEnrollFromTrigger } = await import("./sequence-worker");

            const jobRowId: number = _job.data.promotionalEnrollmentJobId;
            if (!decideCr06PromotionalLifecycle({ boundary: "queue_runner", purpose: "promotional" }).allowed) {
              await dbInst
                .update(promotionalEnrollmentJobs)
                .set({ status: "blocked", reasonCodes: ["no_usable_channel"], processedAt: new Date() })
                .where(eq(promotionalEnrollmentJobs.id, jobRowId));
              return;
            }
            let contactId: number = _job.data.contactId;
            const {
              CONTACT_MERGE_EFFECT_HOLD_REASON,
              resolveLiveContactRedirect,
            } = await import("./contact-identity");
            const redirect = await resolveLiveContactRedirect(contactId);
            contactId = redirect.effectiveContactId;
            const triggerType: string = _job.data.triggerType;
            const formType: string | null = _job.data.formType ?? null;
            const isResubmission: boolean = _job.data.isResubmission ?? false;

            // Top-level try/catch ensures the row never gets stranded in "processing"
            // regardless of where an error originates (eligibility eval, enroll, DB write).
            try {
              if (redirect.effectHold) {
                await dbInst.execute(sql`
                  UPDATE promotional_enrollment_jobs
                  SET status='deferred_queue_unavailable',
                      reason_codes=ARRAY(
                        SELECT DISTINCT unnest(
                          COALESCE(reason_codes,ARRAY[]::text[])
                          || ARRAY[${CONTACT_MERGE_EFFECT_HOLD_REASON}]::text[]
                        )
                      ),
                      attempts=attempts+1,
                      processed_at=NULL
                  WHERE id=${jobRowId}
                `);
                return;
              }
              await dbInst
                .update(promotionalEnrollmentJobs)
                .set({ status: "processing", attempts: (_job.attemptsMade ?? 0) + 1 })
                .where(eq(promotionalEnrollmentJobs.id, jobRowId));

              const eligibility = await evaluatePromotionalEnrollmentEligibility(
                contactId,
                triggerType,
                { isResubmission }
              );

              if (!eligibility.eligible) {
                await dbInst
                  .update(promotionalEnrollmentJobs)
                  .set({
                    status: "blocked",
                    reasonCodes: eligibility.reasonCodes,
                    processedAt: new Date(),
                  })
                  .where(eq(promotionalEnrollmentJobs.id, jobRowId));
              } else {
                let enrollResult: { count: number; enrollmentIds: number[]; alreadyEnrolledCount: number } = {
                  count: 0,
                  enrollmentIds: [],
                  alreadyEnrolledCount: 0,
                };
                enrollResult = await autoEnrollFromTrigger(
                  triggerType,
                  { contactId, formType: formType ?? undefined },
                  {
                    preEvaluated: { contactabilityByChannel: eligibility.contactabilityByChannel },
                    promotionalIntent: {
                      idempotencyKey: `promotional-job:${jobRowId}`,
                      actorId: "promotional-enrollment-worker",
                      source: "promotional_enrollment_job",
                    },
                  }
                );

                // Determine terminal status:
                // - "enrolled"            → at least one new enrollment created
                // - "already_enrolled"    → sequences matched but contact already in all of them (none new)
                // - "no_matching_sequence"→ no active sequences matched the trigger at all
                const terminalStatus: string =
                  enrollResult.count > 0
                    ? "enrolled"
                    : enrollResult.alreadyEnrolledCount > 0
                      ? "already_enrolled"
                      : "no_matching_sequence";

                await dbInst
                  .update(promotionalEnrollmentJobs)
                  .set({
                    status: terminalStatus,
                    enrollmentIds: enrollResult.enrollmentIds.length > 0 ? enrollResult.enrollmentIds : null,
                    reasonCodes: null,
                    processedAt: new Date(),
                  })
                  .where(eq(promotionalEnrollmentJobs.id, jobRowId));
              }
            } catch (workerErr) {
              // Durably mark failed so the row exits "processing" even if BullMQ retries are exhausted.
              try {
                await dbInst
                  .update(promotionalEnrollmentJobs)
                  .set({
                    status: "failed",
                    reasonCodes: [(workerErr as Error).message?.slice(0, 200) ?? "error"],
                    processedAt: new Date(),
                  })
                  .where(eq(promotionalEnrollmentJobs.id, jobRowId));
              } catch (updateErr) {
                console.error("[PromotionalEnrollment] Failed to mark row as failed:", updateErr);
              }
              throw workerErr;
            }
          } else {
            await runEnrichmentTick();
            const { recoverValidationIntents } = await import("./provider-readiness-control");
            await recoverValidationIntents();
            const { recoverCampaignQueueRuns } = await import("./campaign-engine");
            await recoverCampaignQueueRuns();
            const { recoverDeferredPromotionalEnrollments } = await import("./promotional-enrollment-eligibility");
            await recoverDeferredPromotionalEnrollments();
          }
          break;
        }
        case QUEUE_NAMES.FREE_ENRICHMENT_LANE: {
          // MI-09 corrective item 1: this is the ONLY handler for the physical
          // `free-enrichment-lane` queue. It must never import a paid-provider,
          // ZeroBounce, GHL, sequence, campaign, or outreach module — directly
          // or transitively through ./free-enrichment-lane.ts (enforced by
          // scripts/scan-capability-consumer-registry.ts).
          const { featureFlags: _feFlags } = await import("./feature-flags");
          if (!_feFlags.FREE_ENRICHMENT_ENABLED) {
            break;
          }
          const { db: _feDb } = await import("../db");
          const { sql: _feSql } = await import("drizzle-orm");

          // ── Correction #4: stuck-business-crawl reaper ──────────────────
          // Businesses left in free_enrichment_status='processing' well past
          // any realistic enrichment duration are the result of a hard process
          // crash (kill/OOM/deploy restart). Nothing in the in-process
          // try/finally can observe those exits, so without this reaper the
          // row permanently blocks re-eligibility. Reset to 'failed' so the
          // normal retry logic can re-claim them, and write one audit_logs row
          // per reclaimed business so the auto-recovery is inspectable.
          try {
            const BUSINESS_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
            const bizStaleThreshold = new Date(Date.now() - BUSINESS_STALE_MS);
            const reclaimedBizRows = (((await _feDb.execute(_feSql`
              UPDATE businesses
              SET free_enrichment_status = 'failed',
                  free_enrichment_last_error_code = 'PROCESSING_TIMEOUT_AUTO_RECLAIMED'
              WHERE free_enrichment_status = 'processing'
                AND free_enrichment_last_attempt_at < ${bizStaleThreshold}
              RETURNING id
            `)) as any).rows ?? []) as { id: unknown }[];
            if (reclaimedBizRows.length > 0) {
              console.log(`[FreeEnrich] Reclaimed ${reclaimedBizRows.length} stuck-processing business(es)`);
              for (const bizRow of reclaimedBizRows) {
                await _feDb.execute(_feSql`
                  INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
                  VALUES ('free_enrichment_processing_auto_reclaimed', 'business', ${String(bizRow.id)},
                          'system', 'free-enrichment-lane-reaper',
                          ${JSON.stringify(sanitizeAuditPayload({ staleAfterMs: BUSINESS_STALE_MS }))}::jsonb)
                `).catch((auditErr: any) => console.error('[FreeEnrich] Audit log error:', auditErr?.message));
              }
            }
          } catch (reaperErr: any) {
            // Reaper failure is non-fatal to the main enrichment tick.
            console.error('[FreeEnrich] Stuck-business reaper error (non-fatal):', reaperErr?.message);
          }
          const { businessLacksDbprLineageSql } = await import("./dbpr");
          // Default is sized to clear the current backlog in days while the
          // single-consumer lane still prevents overlapping crawls. Operators
          // may tune within a hard bound without changing code.
          const configuredFreeBatch = Number.parseInt(process.env.FREE_ENRICHMENT_BATCH_SIZE ?? "50", 10);
          const FREE_LANE_BATCH = Number.isFinite(configuredFreeBatch)
            ? Math.max(1, Math.min(100, configuredFreeBatch))
            : 50;
          const eligibleRows = await _feDb.execute(_feSql`
            SELECT id FROM (
              SELECT id FROM businesses b
              WHERE b.website_domain IS NOT NULL
                AND b.record_class = 'canonical'
                AND b.free_enrichment_status IS NULL
                AND ${businessLacksDbprLineageSql(_feSql`b.id`)}

              UNION ALL

              SELECT id FROM businesses b
              WHERE b.website_domain IS NOT NULL
                AND b.record_class = 'canonical'
                AND b.free_enrichment_status = 'failed'
                AND b.free_enrichment_attempt_count < 3
                AND ${businessLacksDbprLineageSql(_feSql`b.id`)}

              UNION ALL

              SELECT id FROM businesses b
              WHERE b.website_domain IS NOT NULL
                AND b.record_class = 'canonical'
                AND b.free_enrichment_status = 'enriched'
                AND b.free_enrichment_completed_at < NOW() - INTERVAL '90 days'
                AND ${businessLacksDbprLineageSql(_feSql`b.id`)}
            ) eligible
            ORDER BY id
            LIMIT ${FREE_LANE_BATCH}
          `);
          const businessIds: number[] = (((eligibleRows as any).rows ?? eligibleRows) as any[]).map((r) => Number(r.id));
          if (businessIds.length === 0) {
            console.debug("[Queue:free-enrichment-lane] no eligible businesses");
            break;
          }
          const { runFreeEnrichmentLane } = await import("./free-enrichment-lane");
          try {
            const results = await runFreeEnrichmentLane(businessIds);
            const counts = results.reduce((acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; }, {} as Record<string, number>);
            console.log(`[Queue:free-enrichment-lane] processed ${results.length}: ${JSON.stringify(counts)}`);
          } catch (laneErr: any) {
            if (String(laneErr?.message) === "FREE_ENRICHMENT_LANE_BUSY") {
              console.debug("[Queue:free-enrichment-lane] lane busy, skipping this tick");
              break;
            }
            throw laneErr;
          }
          break;
        }
        case QUEUE_NAMES.DISCOVERY: {
          if (featureFlags.LEGACY_OUTREACH_ENABLED) {
            await runDiscoveryTick();
          }
          break;
        }
        case QUEUE_NAMES.CRO02_OBSERVATION: {
          const { observeCommercialReportingPopulation } = await import("./commercial-resolution");
          await Promise.all([
            observeCommercialReportingPopulation({ subjectType: "contact" }),
            observeCommercialReportingPopulation({ subjectType: "deal" }),
          ]);
          break;
        }
        case QUEUE_NAMES.DIGESTS: {
          await runDigestsTick();
          break;
        }
        case QUEUE_NAMES.MID_INGESTION: {
          await runMidIngestionTick();
          break;
        }
        case QUEUE_NAMES.ONBOARDING_REMINDER: {
          await runOnboardingReminderTick();
          break;
        }
        case QUEUE_NAMES.ACTIVATION_MONITOR: {
          await runActivationMonitorTick();
          break;
        }
        case QUEUE_NAMES.MERCHANT_SUCCESS: {
          await runMerchantSuccessTick();
          break;
        }
        case QUEUE_NAMES.WINBACK_OUTREACH: {
          await runWinbackOutreachTick();
          break;
        }
        case QUEUE_NAMES.ABANDONED_STATEMENT: {
          // Not gated by SDR_ENABLED — statement follow-up is a core ops task,
          // independent of whether the full SDR pipeline is active.
          const { runAbandonedStatementCheck } = await import("./abandoned-statement-worker");
          await runAbandonedStatementCheck();
          break;
        }
        case QUEUE_NAMES.EXECUTIVE_SNAPSHOT: {
          const { acquireJobLock, releaseJobLock } = await import("./job-registry");
          const lease = await acquireJobLock("executive-snapshot");
          if (lease.status !== "acquired") break;
          const lockToken = lease.lockToken;
          try {
            const { buildExecutiveSnapshot } = await import("./executive-kpi");
            const { generateExecutiveAi } = await import("./executive-ai");
            const { db: dbInst } = await import("../db");
            const { executiveWeeklySnapshots } = await import("@shared/schema");
            const snap = await buildExecutiveSnapshot(new Date());
            const aiResult = await generateExecutiveAi(snap);
            await dbInst
              .insert(executiveWeeklySnapshots)
              .values({
                weekStart: snap.weekStart,
                closedWonRevenue: snap.closedWonRevenue.toString(),
                grossProfit: snap.grossProfit.toString(),
                netProfit: snap.netProfit.toString(),
                grossMarginPct: snap.grossMarginPct.toString(),
                netMarginPct: snap.netMarginPct.toString(),
                pipelineValue: snap.pipelineValue.toString(),
                newDealsClosed: snap.newDealsClosed,
                proposalsSent: snap.proposalsSent,
                statementsReceived: snap.statementsReceived,
                meetingsBooked: snap.meetingsBooked,
                outreachAttempts: snap.outreachAttempts,
                perRepBreakdown: snap.perRepBreakdown as any,
                goalsVsActuals: snap.goalsVsActuals as any,
                gptBriefing: aiResult.gptBriefing,
                claudeCoaching: aiResult.claudeCoaching as any,
                generatedAt: new Date(),
                trigger: "schedule",
              })
              .onConflictDoUpdate({
                target: executiveWeeklySnapshots.weekStart,
                set: {
                  closedWonRevenue: snap.closedWonRevenue.toString(),
                  grossProfit: snap.grossProfit.toString(),
                  netProfit: snap.netProfit.toString(),
                  grossMarginPct: snap.grossMarginPct.toString(),
                  netMarginPct: snap.netMarginPct.toString(),
                  pipelineValue: snap.pipelineValue.toString(),
                  newDealsClosed: snap.newDealsClosed,
                  proposalsSent: snap.proposalsSent,
                  statementsReceived: snap.statementsReceived,
                  meetingsBooked: snap.meetingsBooked,
                  outreachAttempts: snap.outreachAttempts,
                  perRepBreakdown: snap.perRepBreakdown as any,
                  goalsVsActuals: snap.goalsVsActuals as any,
                  gptBriefing: aiResult.gptBriefing,
                  claudeCoaching: aiResult.claudeCoaching as any,
                  generatedAt: new Date(),
                  trigger: "schedule",
                  createdAt: new Date(),
                },
              });
            console.log(`[ExecutiveSnapshot] Weekly snapshot written for week ${snap.weekStart}`);
          } finally {
            await releaseJobLock("executive-snapshot", true, undefined, lockToken).catch(() => {});
          }
          break;
        }
        case QUEUE_NAMES.SYSTEM_AUDIT: {
          const { runSystemAudit } = await import("./system-audit/runner");
          await runSystemAudit("schedule");
          break;
        }
        case QUEUE_NAMES.DB_BACKUP: {
          const { runDatabaseBackup } = await import("./db-backup");
          await runDatabaseBackup("scheduled");
          break;
        }
        case QUEUE_NAMES.ENROLLMENT_RECOVERY: {
          const { recoverDeferredEnrollments } = await import("./sequence-enrollment-recovery");
          await recoverDeferredEnrollments();
          break;
        }
        case QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY: {
          const { retryDeferredEnrollments } = await import("./ghl-enrollment-recovery");
          await retryDeferredEnrollments();
          break;
        }
        case QUEUE_NAMES.HEALTH_MONITOR: {
          const { runHealthChecks } = await import("./health-monitor");
          await runHealthChecks();
          break;
        }
        case QUEUE_NAMES.PIPELINE_SILENCE_CHECK: {
          const { runPipelineSilenceCheck } = await import("./pipeline-silence-check");
          await runPipelineSilenceCheck();
          break;
        }
        case QUEUE_NAMES.PROPOSAL_FOLLOWUP: {
          // Not gated by SDR_ENABLED — proposal follow-up is a core sales ops task.
          const { runProposalFollowUpCheck } = await import("./proposal-followup-worker");
          await runProposalFollowUpCheck();
          break;
        }
        case QUEUE_NAMES.PARTNER_MONTHLY_DIGEST: {
          const { sendMonthlyPartnerResidualsSummary } = await import("./partner-notifications");
          await sendMonthlyPartnerResidualsSummary();
          break;
        }
        case QUEUE_NAMES.VOICEMAIL_SYNC: {
          // Gate: only run when VOICEMAIL_SYNC_ENABLED is set (checked inside the tick as well)
          if (process.env.VOICEMAIL_SYNC_ENABLED === "true") {
            const { runVoicemailSyncTick } = await import("./ghl-voicemail-sync");
            await runVoicemailSyncTick();
          }
          break;
        }
        case QUEUE_NAMES.ZEROBOUNCE_BATCH: {
          if (_job.name === "validation-intent" && typeof _job.data?.intentId === "string") {
            // Task #1956 step 6: re-homed here (was QUEUE_NAMES.ENRICHMENT) so
            // this real-spend path is governed by the "email-validation"
            // capability group, matching the legacy campaign-engine path.
            const { processValidationIntent } = await import("./provider-readiness-control");
            await processValidationIntent(_job.data.intentId);
          } else if (_job.name === "zerobounce-auto-run") {
            // Scheduled daily auto-run (#1616): checks system_settings gate before
            // creating a campaign/run; safe to no-op if disabled or budget exhausted.
            const { runZeroBounceAutoRun } = await import("./zerobounce-campaign-worker");
            const result = await runZeroBounceAutoRun();
            console.log(`[Queue:zerobounce-batch-validate] auto-run outcome: ${result.outcome}`);
          } else {
            // Event-driven run enqueued by POST /api/contacts/validate-emails-batch
            const { processZeroBounceRun } = await import("./zerobounce-campaign-worker");
            const runId = (_job.data as { runId?: string })?.runId;
            if (!runId) throw new Error("zerobounce-batch-validate job missing runId");
            await processZeroBounceRun(runId);
          }
          break;
        }
        case QUEUE_NAMES.STATEMENT_UPLOAD: {
          const { executeStatementUploadCommand, recoverStatementUploadCommands } = await import("./statement-command-worker");
          if (_job.name === "recover") {
            await recoverStatementUploadCommands();
            break;
          }
          const commandId = _job.data?.commandId;
          if (typeof commandId !== "string") throw new Error("statement command id required");
          await executeStatementUploadCommand(commandId);
          await recoverStatementUploadCommands();
          break;
        }
        case QUEUE_NAMES.POST_ENRICHMENT: {
          if (_job.name === "post-enrichment-intent-recovery") {
            // Recovery path: dispatch to the dedicated recovery worker function.
            // This MUST NOT go through processPostEnrichmentJob() to keep the two
            // paths cleanly separated (kill line from 1548C spec).
            const { recoverPendingEnrollmentIntents } = await import("./post-enrichment-worker");
            const workerId = `pe-recovery-${process.pid}-${_job.id ?? "noid"}`;
            await recoverPendingEnrollmentIntents(workerId);
          } else {
            // Event-driven path: standard post-enrichment automation
            const { processPostEnrichmentJob } = await import("./post-enrichment-worker");
            await processPostEnrichmentJob(_job.data as import("./post-enrichment-worker").PostEnrichmentJobData);
          }
          break;
        }
        case QUEUE_NAMES.SOURCE_REGISTRY_IMPORT: {
          const { runSourceImport } = await import("../services/source-registry/import-runner");
          const { runId } = _job.data as { runId: string };
          if (!runId) throw new Error("source-registry-import job missing runId");
          // All intent (adapterKey, isFullSnapshot, csvBuffer) is read from the DB row.
          // The BullMQ payload contains ONLY runId — no source PII or intent in Redis.
          await runSourceImport({ runId });
          break;
        }
        case QUEUE_NAMES.CRO08A_SCHEDULER: {
          const { processCro08aSchedulerTick } = await import("../workers/cro08a-scheduler.worker");
          const result = await processCro08aSchedulerTick();
          console.log(`[Queue:cro08a-scheduler] tick result: ${JSON.stringify(result)}`);
          break;
        }
        case QUEUE_NAMES.CRO08A_PROCESSOR: {
          const { processCro08aOccurrence } = await import("../workers/cro08a-processor.worker");
          const extendLock = async () => { try { await _job.extendLock(_job.token ?? "", 120_000); } catch {} };
          const result = await processCro08aOccurrence({ extendLock });
          if (result.claimed) {
            console.log(`[Queue:cro08a-processor] processed occurrence ${result.occurrenceId}: ${result.enumeratedCount} enumerated, reconciled=${result.reconciled}`);
          }
          break;
        }
        case QUEUE_NAMES.SFP_CAMPAIGN_STAGING: {
          const { processSfpCampaignStagingTick } = await import("./cro03/sfp-campaign-staging-worker");
          const result = await processSfpCampaignStagingTick();
          if (result.processed > 0) {
            console.log(`[SfpCampaignStaging] held ${result.succeeded}/${result.processed}; failed=${result.failed}`);
          }
          if (result.pausedEnrollment?.attempted > 0) {
            console.log(
              `[SfpReadyHeldConsumer] attempted=${result.pausedEnrollment.attempted} completed=${result.pausedEnrollment.completed} held=${result.pausedEnrollment.held} retrying=${result.pausedEnrollment.retrying} deadLettered=${result.pausedEnrollment.deadLettered}`,
            );
          }
          break;
        }
        case QUEUE_NAMES.SFP_FREE_CLASSIFICATION: {
          const { processSfpFreeClassificationTick } = await import("./cro03/sfp-free-classification-continuation");
          // Provider-free windows drain back-to-back inside a bounded budget so
          // a large unclassified backlog clears in hours; the paid escalation
          // runs once, in the first iteration only.
          const drainDeadline = Date.now() + 6 * 60 * 1000;
          let result = await processSfpFreeClassificationTick();
          if (result.claimed) console.log(`[SfpFreeClassification] ${JSON.stringify(result)}`);
          for (let i = 0; i < 60 && result.claimed && result.state === "running" && Date.now() < drainDeadline; i++) {
            result = await processSfpFreeClassificationTick(undefined, { skipSideWork: true });
            if (result.claimed) console.log(`[SfpFreeClassification] ${JSON.stringify(result)}`);
          }
          break;
        }
        case QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY: {
          // Give the existing provider-free linker a bounded serial opportunity
          // on the existing local schedule, before a whole upload occupies it.
          // No new queue, provider tick, control change or cursor reset.
          const { processContactLinkAutomationTick } = await import("./contact-link-automation");
          let linkingFailure;
          let linkingFailed = false;
          try {
            const linked = await processContactLinkAutomationTick();
            if (linked.ran) console.log(`[ContactLinkAutomation] ${JSON.stringify(linked)}`);
          } catch (error) {
            linkingFailure = error;
            linkingFailed = true;
          }
          // Each boundary keeps its own fatal outcome and claim fences. A
          // retained-row failure must not skip independently claimed uploads.
          const { processCanonicalImportRecoveryTick } = await import("./canonical-import-recovery-worker");
          let recovered;
          let retainedFailure;
          let retainedFailed = false;
          try { recovered = await processCanonicalImportRecoveryTick(); }
          catch (error) { retainedFailure = error; retainedFailed = true; }
          if (recovered?.ran) console.log(`[CanonicalImportRecovery] ${JSON.stringify(recovered)}`);
          // Reuse request-free ordinary upload recovery on the existing serial
          // schedule; no customer restart or second recovery queue is required.
          const { resumeExpiredCsvImports } = await import("./csv-import-recovery");
          const { processPersistedCsvImport } = await import("./csv-import-processor");
          let uploadsResumed = 0;
          let uploadFailure;
          let uploadFailed = false;
          try { uploadsResumed = await resumeExpiredCsvImports(processPersistedCsvImport); }
          catch (error) { uploadFailure = error; uploadFailed = true; }
          if (uploadsResumed) console.log(`[CsvImportRecovery] Resumed ${uploadsResumed} expired executions`);
          // Local preparation of recently uploaded contacts. Runs on this serial local-only schedule so a new upload's
          // outstanding contacts drain without waiting for the 30-minute discovery tick (which also keeps running the
          // same lane). No provider tick, spend or send is reachable from here; it uses the same preparation lease.
          let uploadCohortMore=false;
          try {
            const { processCanonicalRecipientPreparationTick } = await import("./canonical-recipient-preparation-worker");
            const cohortRun: any = await processCanonicalRecipientPreparationTick({ uploadCohortOnly: true, cohortBudgetMs: 4 * 60_000 });
            if (cohortRun.ran && cohortRun.uploadCohort) {
              if (cohortRun.uploadCohort.pages > 0 || cohortRun.completionDrain?.pages > 0) console.log(`[UploadCohortPreparation] ${JSON.stringify({
                ...cohortRun.uploadCohort, cohortCycles: cohortRun.cohortCycles, completionDrain: cohortRun.completionDrain })}`);
              uploadCohortMore = cohortRun.uploadCohort.more === true || cohortRun.completionDrain?.more === true;
            }
          } catch (error: any) {
            console.error("[UploadCohortPreparation] held", safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          if (linkingFailed) throw new Error("CANONICAL_IMPORT_INDEPENDENT_LINKING_FAILED",
            {cause:{linkingFailure,retainedFailure,uploadFailure}});
          if (retainedFailed && uploadFailed)
            throw new Error("CANONICAL_IMPORT_INDEPENDENT_BOUNDARIES_FAILED",
              {cause:{originalError:retainedFailure,cleanupError:uploadFailure}});
          if (retainedFailed) throw retainedFailure;
          if (uploadFailed) throw uploadFailure;
          if ((recovered?.ran && recovered.budgetExhausted) || uploadCohortMore) {
            const { canonicalImportContinuationOptions } = await import("./canonical-import-recovery-scheduling");
            // Serial continuation: no extra concurrency, no provider work and
            // no ten-minute wait between batches. Deduplicate repeat-triggered
            // and continuation-triggered wakeups while one is already queued.
            const recoveryQueue=this.queues.get(QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY);
            if (!recoveryQueue) throw new Error("CANONICAL_IMPORT_RECOVERY_QUEUE_UNAVAILABLE");
            await recoveryQueue.add("continue", {},canonicalImportContinuationOptions(_job.id));
          }
          break;
        }
        case QUEUE_NAMES.SFP_CONTINUOUS_DISCOVERY: {
          // Optional operator request from the enrichment backlog page. Same workers, same gates:
          // it only enlarges the local staged-email budget, repeats local recipient preparation and,
          // when asked, wakes the already-governed provider ticks. Ordinary scheduled ticks carry none.
          const { parseBacklogProcessRequest, recordBacklogPriorityRun, backlogValidationWakeJobId, backlogPassBounds } = await import("./canonical-enrichment-backlog-run");
          const priorityRequest = parseBacklogProcessRequest((_job.data as any)?.priorityRequest);
          const priorityRun: Record<string, unknown> = { staged: null, preparationPasses: 0, prepared: 0, providerTicks: "not_requested" };
          const priorityStartedAt = new Date().toISOString();
          // Local-only reconciliation does not depend on discovery providers
          // being enabled. Its own durable program/pause checkpoint is authoritative.
          const { processContactLinkCoverageServerTick } = await import("./contact-link-coverage");
          try {
            const coverage = await processContactLinkCoverageServerTick();
            if (coverage.ran) console.log(`[ContactLinkCoverage] ${JSON.stringify(coverage)}`);
          } catch (error: any) {
            console.error("[ContactLinkCoverage] bounded page deferred", safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          try {
            const { processContactBusinessReconciliationServerTick } = await import("./contact-business-reconciliation");
            const reconciliation = await processContactBusinessReconciliationServerTick();
            if (reconciliation.ran) console.log(`[ContactBusinessReconciliation] ${JSON.stringify(reconciliation)}`);
          } catch (error: any) {
            console.error("[ContactBusinessReconciliation] bounded page deferred", safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          try {
            const { processEffectiveVerticalProjectionTick } = await import("./crm-effective-vertical-projection");
            const verticals = await processEffectiveVerticalProjectionTick();
            if (verticals.ran) console.log(`[CrmEffectiveVerticalProjection] ${JSON.stringify(verticals)}`);
          } catch (error: any) {
            console.error("[CrmEffectiveVerticalProjection] held", safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          try {
            const { processContactLinkAutomationTick } = await import("./contact-link-automation");
            const links = await processContactLinkAutomationTick();
            if (links.ran) console.log(`[ContactLinkAutomation] ${JSON.stringify(links)}`);
          } catch (error: any) {
            console.error("[ContactLinkAutomation] held", safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          try {
            // Closed unless an administrator enables it. Applies the independent domain + company + location
            // policy through the audited writer; local only, no provider call, send or enrollment.
            const { processDomainLocationAutomationTick } = await import("./contact-domain-location-automation");
            const domainLinks = await processDomainLocationAutomationTick();
            if (domainLinks.ran) console.log(`[DomainLocationAutomation] ${JSON.stringify(domainLinks)}`);
          } catch (error: any) {
            console.error("[DomainLocationAutomation] held", safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          if (process.env.RETAINED_SUNBIZ_BUSINESS_COMPLETION_ENABLED !== "false") try {
            // Local-only: complete legacy Sunbiz promotions that never produced a business (contactless
            // prospects, South Florida). No provider call, contact, enrollment or send.
            const {processRetainedSunbizBusinessCompletionTick}=await import("./retained-sunbiz-business-completion");
            const completed=await processRetainedSunbizBusinessCompletionTick({limit:100});
            if (completed.eligible>0||completed.wrapped||completed.lockStatus!=="acquired") console.log(`[RetainedSunbizCompletion] ${JSON.stringify(completed)}`);
          } catch(error:any) {
            console.error("[RetainedSunbizCompletion] held",safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          try {
            // Serper contact-page stage: one governed /search request per accepted in-territory business whose free
            // website search found no email, then the bounded first-party reader stages any role inbox. Closed unless
            // the operator enables serper_contact_page_stage; creates no contact, link, enrollment or send.
            const {runSerperContactPageStage}=await import("./serper-contact-page-stage");
            const contactPages=await runSerperContactPageStage();
            if (contactPages.ran&&contactPages.examined>0) console.log(`[SerperContactPageStage] ${JSON.stringify(contactPages)}`);
          } catch(error:any) {
            console.error("[SerperContactPageStage] held",safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          try {
            // Local-only: staged first-party emails -> contacts verified-linked to their
            // exact business. No provider call, send or enrollment; preparation below owns
            // recipient selection and validation intent/receipt reuse.
            const {runStagedEmailMaterialization}=await import("./free-discovery/staged-email-materialization");
            const staged=await runStagedEmailMaterialization({
              // Pages of 100 until the queue is empty, 5 minutes elapse or 2,000 candidates are examined.
              // The old fixed 25 per 30-minute tick left ~25k staged emails waiting for weeks.
              limit:100,actorId:"system:staged-email-materialization",
              // An operator request carries its own validated bounds; scheduled ticks keep the defaults.
              drain:backlogPassBounds(priorityRequest).stagedDrain,
            });
            priorityRun.staged={examined:staged.examined,pages:staged.pages,created:staged.created,linkedExisting:staged.linkedExisting,alreadyLinked:staged.alreadyLinked,held:staged.held,failed:staged.failed};
            if (staged.examined>0) console.log(`[StagedEmailMaterialization] ${JSON.stringify({examined:staged.examined,pages:staged.pages,created:staged.created,linkedExisting:staged.linkedExisting,alreadyLinked:staged.alreadyLinked,held:staged.held,failed:staged.failed})}`);
          } catch(error:any) {
            console.error("[StagedEmailMaterialization] held",safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          try {
            const {processCanonicalRegistryProjectionTick}=await import("./canonical-registry-projection-worker");
            const registry=await processCanonicalRegistryProjectionTick();
            if (registry.ran) console.log(`[CanonicalRegistryProjection] ${JSON.stringify(registry)}`);
          } catch(error:any) {
            console.error("[CanonicalRegistryProjection] held",safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          try {
            const {processCanonicalRecipientPreparationTick}=await import("./canonical-recipient-preparation-worker");
            // Stale-package refresh is the slow lane (several seconds per recipient). Scheduled ticks give it a larger
            // time share; an operator request keeps passing while it is still making progress, bounded to 10 minutes.
            const preparationStartedAt=Date.now();
            let lastStaleExamined=0;
            let lastPriorityExamined=0;
            // The requested time budget also bounds starting further recipient-selection passes (a started pass finishes);
            // at least one pass always runs, and the old 10-minute ceiling can no longer exceed the request.
            const {preparationDeadlineMs,maxPreparationPasses:requestedPasses}=backlogPassBounds(priorityRequest);
            const SCHEDULED_PREPARATION_MAX_MS=6*60_000;
            const maxPreparationPasses=priorityRequest ? requestedPasses : 4;
            for (let pass=0;pass<maxPreparationPasses;pass++) {
              if (priorityRequest && pass>=1 && Date.now()-preparationStartedAt>=preparationDeadlineMs) break;
              // Keep passing while either slow lane or the priority lane is still making progress.
              if (priorityRequest && pass>=3 && ((lastStaleExamined===0 && lastPriorityExamined===0) || Date.now()-preparationStartedAt>10*60_000)) break;
              // A scheduled tick also keeps passing while the priority lane is still reaching new recipients, bounded to
              // a few passes and six minutes, so a freshly uploaded cohort is not limited to one pass per 30 minutes.
              if (!priorityRequest && pass>=1 && (lastPriorityExamined===0 || Date.now()-preparationStartedAt>SCHEDULED_PREPARATION_MAX_MS)) break;
              // An operator request gives the priority lane a larger guaranteed share than a scheduled tick.
              const preparations=await processCanonicalRecipientPreparationTick({
                // Later scheduled passes skip the long stale-package share; the first pass already gave it its window.
                staleBudgetMs:priorityRequest ? 90_000 : pass===0 ? 60_000 : 30_000,
                ...(priorityRequest ? {priorityReserveMs:60_000} : {}),
              });
              lastStaleExamined=Number((preparations as any).stalePackage?.examined ?? 0);
              lastPriorityExamined=Number((preparations as any).priority?.examined ?? 0);
              if (preparations.ran) console.log(`[CanonicalRecipientPreparation] ${JSON.stringify(preparations)}`);
              priorityRun.preparationPasses=pass+1;
              if (!preparations.ran) break;
              priorityRun.prepared=Number(priorityRun.prepared)+Number((preparations as any).prepared ?? 0)
                +Number((preparations as any).priority?.prepared ?? 0)+Number((preparations as any).completion?.prepared ?? 0)+Number((preparations as any).stalePackage?.prepared ?? 0);
            }
          } catch(error:any) {
            console.error("[CanonicalRecipientPreparation] held",safeCanonicalEnrichmentFailureDiagnostics(error));
          }
          if (priorityRequest?.scope === "local_only") {
            priorityRun.providerTicks = "skipped_local_only";
          } else {
            const { processSfpContinuousDiscoveryTick } = await import("./cro03/sfp-continuous-discovery");
            const result = await processSfpContinuousDiscoveryTick();
            if (result.ran) console.log(`[SfpContinuousDiscovery] ${JSON.stringify(result)}`);
            if (priorityRequest) {
              priorityRun.providerTicks = result.ran ? "discovery_ran_under_existing_controls" : "discovery_did_not_run_under_existing_controls";
              // Wake the shared validation tick once; its own pause, budget and receipt rules still apply.
              try {
                const validationQueue = this.queues.get(QUEUE_NAMES.SFP_CONTINUOUS_VALIDATION);
                await validationQueue?.add("tick", {}, { jobId: backlogValidationWakeJobId() });
              } catch (error: any) {
                priorityRun.providerTicks = "validation_wake_failed";
                console.error("[CanonicalBacklog] validation wake failed", safeCanonicalEnrichmentFailureDiagnostics(error));
              }
            }
          }
          if (priorityRequest) await recordBacklogPriorityRun(priorityRequest, priorityStartedAt, priorityRun);
          break;
        }
        case QUEUE_NAMES.SFP_CONTINUOUS_VALIDATION: {
          const { processSfpContinuousValidationTick } = await import("./cro03/sfp-continuous-discovery");
          const result = await processSfpContinuousValidationTick();
          if (result.ran) console.log(`[SfpContinuousValidation] ${JSON.stringify(result)}`);
          break;
        }
        case QUEUE_NAMES.MASTER_LEAD_STAGER: {
          const { processMasterLeadStagingIntent, recoverPendingIntents } = await import("../workers/master-lead-stager.worker");

          if (_job.name === "recover-pending-intents") {
            // Periodic recovery sweep — re-enqueues committed pending intents older
            // than 5 min that were never delivered to BullMQ (e.g. post-queue-outage).
            const result = await recoverPendingIntents({ olderThanMinutes: 5, limit: 200 });
            if (result.recovered > 0) {
              console.log(`[MasterLeadStager] Recovery sweep re-enqueued ${result.recovered} pending intents`);
            }
            break;
          }

          // Regular staging job: consume a master_lead_staging_intents row.
          // Payload contains only intentId — no PII/email in Redis.
          // Pass isTerminalAttempt so the worker only marks the intent 'failed' on the
          // last attempt; transient failures leave the intent 'pending' so BullMQ can retry.
          const { intentId } = _job.data as { intentId: string };
          if (!intentId) throw new Error("master-lead-stager job missing intentId");
          const attemptsAllowed = _job.opts?.attempts ?? 5;
          const isTerminalAttempt = (_job.attemptsMade ?? 0) >= attemptsAllowed - 1;
          await processMasterLeadStagingIntent(intentId, { isTerminalAttempt });
          break;
        }
        default:
          throw new Error(`Unknown queue: ${queueName}`);
      }

      } catch (err) {
        // ── Transient DB-exhaustion deferral ──────────────────────────────
        // If the job failed because the pool was saturated (connection-acquisition
        // timeout or unexpected connection termination), move it to the delayed
        // set rather than consuming a retry attempt. This avoids a thundering
        // herd of retries making pool pressure worse.
        if (err instanceof Error && (
          err.message.includes("timeout exceeded when trying to connect") ||
          err.message.includes("Connection terminated unexpectedly")
        )) {
          const DEFER_MS = 30_000;
          let _deferred = false;
          try {
            await _job.moveToDelayed(Date.now() + DEFER_MS, _job.token ?? "db-defer");
            _deferred = true;
            console.warn(JSON.stringify({
              event: "job:db_deferred",
              queue: queueName,
              jobId: _job.id,
              deferMs: DEFER_MS,
              ts: new Date().toISOString(),
            }));
          } catch {
            // moveToDelayed itself failed — fall through and let normal retry handle it
          }
          // Throw DelayedError OUTSIDE the inner catch so it cannot be swallowed.
          // BullMQ workers detect DelayedError and preserve the delayed state
          // without attempting moveToCompleted or consuming a retry attempt.
          if (_deferred) throw new DelayedError();
        }
        throw err;
      } finally {
        const { pool: _poolFinal } = await import("../db");
        console.log(JSON.stringify({
          event: "job:end",
          queue: queueName,
          jobId: _job.id,
          durationMs: Date.now() - jobStartMs,
          poolWaiting: _poolFinal.waitingCount,
          poolTotal: _poolFinal.totalCount,
          ts: new Date().toISOString(),
        }));
      }
    };
  }

  private async setupRepeatableJobs(): Promise<void> {
    // Load operator-persisted interval overrides from system_settings so that an
    // admin change made via PUT /api/admin/settings/worker-intervals survives a
    // process restart.  Floor guards are re-applied here to be safe.
    let ghlOverrideMs: number | null = null;
    let slaOverrideMs: number | null = null;
    try {
      const [ghlRaw, slaRaw] = await Promise.all([
        storage.getSystemSetting("ghl_sync_interval_ms"),
        storage.getSystemSetting("sla_check_interval_ms"),
      ]);
      if (typeof ghlRaw === "number" && Number.isFinite(ghlRaw) && ghlRaw >= GHL_SYNC_REPEAT_FLOOR_MS) {
        ghlOverrideMs = ghlRaw;
      }
      if (typeof slaRaw === "number" && Number.isFinite(slaRaw) && slaRaw >= SLA_CHECKS_REPEAT_FLOOR_MS) {
        slaOverrideMs = slaRaw;
      }
    } catch (overrideErr) {
      // Non-fatal: if system_settings is unavailable at startup, fall back to env/defaults
      console.warn("[QueueManager] Could not load interval overrides from system_settings:", (overrideErr as Error).message);
    }

    // Stagger the initial fire of every-N-ms repeatable jobs so queues with
    // identical intervals (e.g. the three 60s queues: cro03a, deal-stage-effects,
    // chargeback-commands) don't burst simultaneously and saturate the DB pool.
    // Each queue's repeatable schedule is offset by STAGGER_MS * its position
    // in the config list. Cron-pattern queues are calendar-driven and unaffected.
    const STAGGER_MS = 15_000; // 15 s between each non-cron queue's first fire
    let staggerIdx = 0;

    for (const config of this.activeConfigs()) {
      // Skip event-driven queues that have no repeatable schedule (repeatEveryMs === 0).
      // These queues are populated by ad-hoc queue.add() calls (e.g. post-enrichment
      // jobs fired inline by the enrichment pipeline) and must not get a repeatable job.
      if (!config.cronPattern && config.repeatEveryMs === 0) continue;

      const queue = this.queues.get(config.name);
      if (!queue) continue;

      const baseScheduleId = `${config.name}-repeatable`;
      const existing = await queue.getRepeatableJobs();
      // Do not delete schedules that merely share this physical queue.
      for (const job of existing.filter((job) => isOwnedRepeatableSchedule(job, config.jobName, baseScheduleId))) {
        await queue.removeRepeatableByKey(job.key);
      }

      // Resolve effective interval: persisted override > config default.
      let effectiveMs = config.repeatEveryMs;
      if (!config.cronPattern) {
        if (config.name === QUEUE_NAMES.GHL_SYNC && ghlOverrideMs !== null) effectiveMs = ghlOverrideMs;
        if (config.name === QUEUE_NAMES.SLA_CHECKS && slaOverrideMs !== null) effectiveMs = slaOverrideMs;
        this.effectiveIntervals.set(config.name, effectiveMs);
      }

      const scheduleOffset = config.cronPattern ? 0 : staggerIdx * STAGGER_MS;
      staggerIdx++;

      await queue.add(config.jobName, {}, {
        repeat: config.cronPattern
          ? { pattern: config.cronPattern }
          : {
              every: effectiveMs,
              // startDate offsets when BullMQ computes the first "next run".
              // Because the schedule key includes the startDate, every process
              // restart with the same stagger order gets the same offset, giving
              // stable, predictable distribution across the repeat interval.
              startDate: new Date(Date.now() + scheduleOffset),
            },
        jobId: baseScheduleId,
      });

      // Immediate startup job intentionally removed (F-07).
      // Previously: queue.add(config.jobName, {}, { delay: scheduleOffset + random })
      // Rationale: all 29 queues firing simultaneously at startup compresses
      // kill-switch + heartbeat DB load into a narrow window, contributing to
      // pool saturation. Repeatable schedule is sufficient — the first run fires
      // at scheduleOffset (staggered), not immediately.
    }
    if (ghlOverrideMs !== null) console.log(`[QueueManager] GHL sync interval loaded from system_settings: ${ghlOverrideMs}ms`);
    if (slaOverrideMs !== null) console.log(`[QueueManager] SLA checks interval loaded from system_settings: ${slaOverrideMs}ms`);

    // ── Named queue schedules ─────────────────────────────────────────────────
    // Install additional repeatable jobs on event-driven queues (repeatEveryMs=0
    // in QUEUE_CONFIGS). Each named schedule is installed independently — only its
    // own matching repeatable job is replaced, never jobs from other named entries
    // or from the base queue config. This satisfies P1-1: a second schedule entry
    // on the same physical queue does NOT delete any other queue's jobs.
    for (const sched of NAMED_QUEUE_SCHEDULES) {
      const queue = this.queues.get(sched.queueName);
      if (!queue) continue;

      // Match the exact descriptor: BullMQ v5 hashes jobId into the key and
      // omits it from returned metadata; name-only matching is unsafe.
      const existingJobs = await queue.getRepeatableJobs();
      for (const job of existingJobs) {
        // Exact identity only: substrings can match an unrelated future schedule.
        if (isOwnedRepeatableSchedule(job, sched.jobName, sched.jobId)) {
          await queue.removeRepeatableByKey(job.key);
        }
      }

      await queue.add(sched.jobName, {}, {
        repeat: sched.cronPattern
          ? { pattern: sched.cronPattern }
          : { every: sched.repeatEveryMs },
        jobId: sched.jobId,
      });

      const schedDesc = sched.cronPattern
        ? `cron="${sched.cronPattern}"`
        : `every ${sched.repeatEveryMs}ms`;
      console.log(`[QueueManager] Named schedule installed: ${sched.jobName} on ${sched.queueName} ${schedDesc} (jobId=${sched.jobId})`);
    }
  }

  /**
   * Live-update the repeat interval for a queue without restarting the process.
   * Replaces only the owned base repeatable schedule and re-adds with the new
   * interval. The effectiveIntervals map is updated so callers can read back the
   * current value. Cron-pattern queues are not supported (returns false).
   */
  async updateQueueRepeatInterval(queueName: string, newIntervalMs: number): Promise<{ updated: boolean; effectiveMs: number }> {
    const queue = this.queues.get(queueName);
    if (!queue) return { updated: false, effectiveMs: newIntervalMs };

    const config = QUEUE_CONFIGS.find(c => c.name === queueName);
    if (!config) return { updated: false, effectiveMs: newIntervalMs };
    if (config.cronPattern) return { updated: false, effectiveMs: newIntervalMs };

    const baseScheduleId = `${queueName}-repeatable`;
    const existing = await queue.getRepeatableJobs();
    for (const job of existing.filter((job) => isOwnedRepeatableSchedule(job, config.jobName, baseScheduleId))) {
      await queue.removeRepeatableByKey(job.key);
    }

    // Add a new repeatable job with the updated interval
    await queue.add(config.jobName, {}, {
      repeat: { every: newIntervalMs },
      jobId: baseScheduleId,
    });

    // Track runtime override
    this.effectiveIntervals.set(queueName, newIntervalMs);
    console.log(`[QueueManager] updateQueueRepeatInterval: ${queueName} → ${newIntervalMs}ms`);
    return { updated: true, effectiveMs: newIntervalMs };
  }

  /** Returns the currently-running repeat interval for a queue, or null if unknown. */
  getEffectiveInterval(queueName: string): number | null {
    return this.effectiveIntervals.get(queueName) ?? null;
  }

  /** Returns all currently-running repeat intervals keyed by queue name. */
  getEffectiveIntervals(): Record<string, number> {
    return Object.fromEntries(this.effectiveIntervals);
  }

  /**
   * Returns a structured, PII-free snapshot of the current queue topology.
   * Safe to include in operator dashboards and structured logs.
   * No Redis URLs, credentials, job payloads, contact/merchant data.
   */
  getTopologySnapshot(): QueueTopologySnapshot {
    // W08: include effective profile and selected groups so topology is
    // self-describing and the hash change when the profile changes is visible.
    const profile = getBackgroundProfile();
    const selectedGroups = profile === "selective" ? getSelectiveGroups() : [];
    return {
      manifestConfigCount: QUEUE_CONFIGS.length,
      activeConfigCount: this.activeConfigs().length,
      instantiatedQueueCount: this.queues.size,
      instantiatedWorkerCount: this.workers.size,
      readyWorkerCount: this.readyWorkers.size,
      logicalJobCount: QUEUE_CONFIGS.length + NAMED_QUEUE_SCHEDULES.length,
      legacyGhlClaimed: isLegacyGhlSyncClaimed(),
      queueMode: getQueueMode(),
      activeProfile: profile,
      selectedGroups,
      processId: process.pid,
      processIdentity: process.env.PROCESS_IDENTITY?.trim() || `process:${process.pid}`,
      releaseSha: process.env.RELEASE_SHA ?? null,
      capturedAt: new Date().toISOString(),
    };
  }

  private recordHistoryEvent(queueName: string, type: "completed" | "failed"): void {
    if (!this.jobHistory.has(queueName)) {
      this.jobHistory.set(queueName, []);
    }
    const buckets = this.jobHistory.get(queueName)!;
    const hourKey = Math.floor(Date.now() / (1000 * 60 * 60));
    let bucket = buckets.find(b => b.hour === hourKey);
    if (!bucket) {
      bucket = { hour: hourKey, completed: 0, failed: 0 };
      buckets.push(bucket);
      if (buckets.length > HISTORY_HOURS) buckets.splice(0, buckets.length - HISTORY_HOURS);
    }
    if (type === "completed") bucket.completed++;
    else bucket.failed++;
  }

  getJobHistory(): QueueHistoryEvidence {
    const result: QueueHistoryEvidence["points"] = {};
    const nowHour = Math.floor(Date.now() / (1000 * 60 * 60));

    for (const [name, buckets] of this.jobHistory.entries()) {
      result[name] = buckets
        .filter((bucket) => bucket.hour <= nowHour)
        .sort((a, b) => a.hour - b.hour)
        .map((bucket) => ({
          startedAt: new Date(bucket.hour * 60 * 60 * 1000).toISOString(),
          completed: bucket.completed,
          failed: bucket.failed,
        }));
    }
    const availableWindowHours = Math.min(
      HISTORY_HOURS,
      Math.max(1, Math.ceil((Date.now() - this.observationStartedAt.getTime()) / (60 * 60 * 1000))),
    );
    return {
      observationStartedAt: this.observationStartedAt.toISOString(),
      requestedWindowHours: HISTORY_HOURS,
      availableWindowHours,
      partial: availableWindowHours < HISTORY_HOURS,
      processIdentity: process.env.PROCESS_IDENTITY?.trim() || `process:${process.pid}`,
      releaseSha: process.env.RELEASE_SHA?.trim() || null,
      points: result,
    };
  }

  private async createReviewQueueItem(queueName: string, job: Job, err: Error): Promise<void> {
    const failureCode = classifyWorkerError(err);
    const event = sanitizeDeadLetterEvent({
      queueName,
      jobName: job.name,
      failureCode,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      occurredAt: new Date().toISOString(),
      source: "bullmq",
      retryable: false,
    });
    try {
      await storage.createReviewQueueItem({
        sourceType: "dead_letter_job" as any,
        sourceId: 0,
        status: "pending",
        notes: "BullMQ job exhausted all configured attempts. See canonical BullMQ retention for operational details.",
        metadata: event,
      });
      console.warn(JSON.stringify({
        event: "queue:terminal-exhaustion",
        queueName: event.queueName,
        jobName: event.jobName,
        attempts: event.attempts,
        failureCode: event.failureCode,
      }));
      const { sendCriticalAlert } = await import("./system-audit/slack-notifier");
      const alertResult = await sendCriticalAlert({
        subsystem: "queues",
        status: "error",
        summary: `Queue terminal exhaustion: ${event.queueName ?? "unknown"}/${event.jobName ?? "unknown"}`,
        details: event,
      });
      if (alertResult.feedStatus === "failed" || alertResult.transportStatus === "failed") {
        console.error(JSON.stringify({
          event: "queue:terminal-exhaustion-alert-degraded",
          claimStatus: alertResult.claimStatus,
          feedStatus: alertResult.feedStatus,
          transportStatus: alertResult.transportStatus,
          incidentFingerprint: alertResult.incidentFingerprint,
        }));
      }
    } catch (storageErr: any) {
      console.error(JSON.stringify({
        event: "queue:dead-letter-review-persist-failed",
        queueName: event.queueName,
        jobName: event.jobName,
        failureCode: event.failureCode,
      }));
      await storage.createAuditLog({
        action: "dead_letter_job",
        entityType: "system",
        details: event,
      });
    }
  }

  async getAllQueueMetrics(): Promise<{ queues: QueueMetric[]; queueMode: QueueMode; status: "ok" | "degraded" }> {
    const metrics: QueueMetric[] = [];
    const expectedNames = new Set(this.activeConfigs().map(c => c.name));
    let ghlCapability: QueueCapabilityState = "ghl_unreadable";
    try {
      const { getGhlSyncControl } = await import("./ghl-sync-control");
      const control = await getGhlSyncControl();
      ghlCapability = !control.enabled ? "ghl_paused"
        : (!control.ownerProfile || !control.selectedRuntime) ? "ghl_owner_released"
        : "ghl_enabled";
    } catch { ghlCapability = "ghl_unreadable"; }
    // Derived fields are computed once per queue so every branch (ok / unreadable) reports the same contract.
    const derived = (config: QueueConfig, probeOk: boolean, paused: boolean | null, lastObservedAt: string | null) => {
      const expectedSelected = expectedNames.has(config.name);
      const runtimeState = deriveQueueRuntimeState({
        expectedSelected, workerInstantiated: this.workers.has(config.name),
        workerActive: this.isQueueWorkerActive(config.name), probeOk,
      });
      return {
        expectedSelected, runtimeState,
        capabilityState: (config.name === QUEUE_NAMES.GHL_SYNC ? ghlCapability : "not_applicable") as QueueCapabilityState,
        freshness: deriveQueueFreshness({
          hasCron: Boolean(config.cronPattern),
          repeatEveryMs: this.effectiveIntervals.get(config.name) ?? config.repeatEveryMs,
          runtimeState, paused, probeOk, lastObservedAt,
        }),
      };
    };

    for (const config of QUEUE_CONFIGS) {
      const queue = this.queues.get(config.name);
      if (!queue) {
        // A queue the profile does not select has nothing to read: a deliberate state, not a failed probe.
        // A selected queue with no instantiated Queue object is a real read failure.
        const notExpected = !expectedNames.has(config.name);
        metrics.push({
          name: config.name,
          ...derived(config, notExpected, null, null),
          waiting: null,
          active: null,
          completed: null,
          failed: null,
          delayed: null,
          paused: null,
          repeatEveryMs: this.effectiveIntervals.get(config.name) ?? config.repeatEveryMs,
          lastCompletedAt: null,
          lastRetainedRedisCompletedAt: null,
          lastFailedAt: null,
          lastRetainedRedisFailedAt: null,
          workerSelected: expectedNames.has(config.name),
          workerActive: this.isQueueWorkerActive(config.name),
          avgDurationMs: null,
          throughputPerHour: null,
          probeStatus: notExpected ? "ok" : "error",
          ...(notExpected ? {} : { errorCode: "QUEUE_METRICS_READ_FAILED" as const }),
        });
        continue;
      }

      try {
        const [waiting, active, completed, failed, delayed, isPaused] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
          queue.isPaused(),
        ]);

        const recentCompleted = await queue.getCompleted(0, 4);
        const recentFailed = await queue.getFailed(0, 0);

        const lastRetainedRedisCompletedAt = recentCompleted[0]?.finishedOn
          ? new Date(recentCompleted[0].finishedOn).toISOString()
          : null;
        const lastRetainedRedisFailedAt = recentFailed[0]?.finishedOn
          ? new Date(recentFailed[0].finishedOn).toISOString()
          : null;
        const processCompletedAt = this.processLastCompletedAt.get(config.name);
        const processFailedAt = this.processLastFailedAt.get(config.name);
        const lastCompletedAt = processCompletedAt ? new Date(processCompletedAt).toISOString() : null;
        const lastFailedAt = processFailedAt ? new Date(processFailedAt).toISOString() : null;

        let avgDurationMs: number | null = null;
        if (recentCompleted.length > 0) {
          const durations = recentCompleted
            .filter(j => j.processedOn && j.finishedOn)
            .map(j => j.finishedOn! - j.processedOn!);
          if (durations.length > 0) {
            avgDurationMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
          }
        }

        const now = Date.now();
        let throughputPerHour: number | null = null;
        const localCompleted = this.processCompletedCount.get(config.name) ?? 0;
        const baseline = this.throughputBaseline.get(config.name);
        if (baseline) {
          const elapsedHours = (now - baseline.recordedAt) / (1000 * 60 * 60);
          if (elapsedHours > 0) {
            const delta = localCompleted - baseline.count;
            throughputPerHour = delta >= 0 ? Math.round(delta / elapsedHours) : null;
          }
        }
        this.throughputBaseline.set(config.name, { count: localCompleted, recordedAt: now });

        metrics.push({
          name: config.name,
          ...derived(config, true, isPaused, lastCompletedAt),
          waiting,
          active,
          completed,
          failed,
          delayed,
          paused: isPaused,
            repeatEveryMs: this.effectiveIntervals.get(config.name) ?? config.repeatEveryMs,
          lastCompletedAt,
          lastRetainedRedisCompletedAt,
          lastFailedAt,
          lastRetainedRedisFailedAt,
          workerSelected: expectedNames.has(config.name),
          workerActive: this.isQueueWorkerActive(config.name),
          avgDurationMs,
          throughputPerHour,
          probeStatus: "ok",
        });
      } catch (err: any) {
        metrics.push({
          name: config.name,
          ...derived(config, false, null, null),
          waiting: null,
          active: null,
          completed: null,
          failed: null,
          delayed: null,
          paused: null,
          repeatEveryMs: config.repeatEveryMs,
          lastCompletedAt: null,
          lastRetainedRedisCompletedAt: null,
          lastFailedAt: null,
          lastRetainedRedisFailedAt: null,
          workerSelected: expectedNames.has(config.name),
          workerActive: this.isQueueWorkerActive(config.name),
          avgDurationMs: null,
          throughputPerHour: null,
          probeStatus: "error",
          errorCode: "QUEUE_METRICS_READ_FAILED",
        });
      }
    }

    return {
      queues: metrics,
      queueMode: getQueueMode(),
      status: metrics.some((metric) => metric.probeStatus === "error"
        || metric.runtimeState === "selected_missing" || metric.runtimeState === "selected_not_ready")
        ? "degraded"
        : "ok",
    };
  }

  private async getFleetEvidence(topology: QueueTopologySnapshot): Promise<QueueFleetEvidence> {
    const releaseSha = topology.releaseSha ?? "";
    const deploymentIdentity = process.env.REPL_DEPLOYMENT_ID ?? process.env.REPL_ID ?? "";
    const environmentIdentity = process.env.NODE_ENV ?? "";
    const redis = getSharedRedisClientIfReady();
    if (!/^[a-f0-9]{40}$/i.test(releaseSha) || !deploymentIdentity || !environmentIdentity || !redis) {
      return {
        status: "unknown",
        scope: "cro03c_worker_inventory",
        authoritativeComplete: false,
        expectedProcessCount: null,
        observedProcessCount: null,
        observedBootCount: null,
        errorCode: "FLEET_AUTHORITY_UNAVAILABLE",
      };
    }
    try {
      const [{ currentCro03cDeploymentInventory }, { readCro03cWorkerFleet }] = await Promise.all([
        import("./cro03/deployment-inventory"),
        import("./cro03/runtime-heartbeat"),
      ]);
      const inventory = await currentCro03cDeploymentInventory({
        deploymentIdentity,
        environmentIdentity,
        releaseSha,
        queueTopologyHash: getCro03cQueueTopologyHash(),
      });
      // W09: bind verification to this deployment's env/namespace so cross-env
      // heartbeats on shared Redis are rejected.
      const fleet = await readCro03cWorkerFleet({
        redis,
        prefix: this.redisKeyPrefix,
        expectedReleaseSha: releaseSha,
        expectedQueueTopologyHash: getCro03cQueueTopologyHash(),
        expectedProcessIdentities: inventory.workerIdentities,
        expectedEnvironmentIdentity: environmentIdentity,
        expectedDeploymentIdentity: deploymentIdentity,
      });
      return {
        status: fleet.complete ? "reconciled" : "degraded",
        scope: "cro03c_worker_inventory",
        authoritativeComplete: fleet.complete,
        expectedProcessCount: inventory.workerIdentities.length,
        observedProcessCount: fleet.heartbeats.length,
        observedBootCount: new Set(fleet.heartbeats.map((heartbeat) => heartbeat.bootIdentity)).size,
        ...(fleet.complete ? {} : { errorCode: "FLEET_SCAN_INCOMPLETE" }),
      };
    } catch (error) {
      return {
        status: "degraded",
        scope: "cro03c_worker_inventory",
        authoritativeComplete: false,
        expectedProcessCount: null,
        observedProcessCount: null,
        observedBootCount: null,
        errorCode: error instanceof Error ? error.message.slice(0, 100) : "FLEET_RECONCILIATION_FAILED",
      };
    }
  }

  async getTelemetryEvidence(): Promise<QueueTelemetryEvidence> {
    const capturedAt = new Date().toISOString();
    const topology = this.getTopologySnapshot();
    const [metrics, dlqRead, fleet] = await Promise.all([
      this.getAllQueueMetrics(),
      this.getDeadLetterItemsWithStatus(),
      this.getFleetEvidence(topology),
    ]);
    const degradations: string[] = [];

    let dueEnrollmentCount: number | null = null;
    let oldestDueMs: number | null = null;
    let lastSequenceRunMs: number | null = null;
    let backlogStatus: QueueTelemetryEvidence["backlog"]["probeStatus"] = "ok";
    let backlogErrorCode: string | undefined;
    try {
      const { db } = await import("../db");
      const backlogResult = await db.execute(sql`
        SELECT COUNT(*)::int AS backlog, MIN(next_action_at) AS oldest_due_at
        FROM sequence_enrollments
        WHERE status = 'active' AND next_action_at IS NOT NULL AND next_action_at <= NOW()
      `);
      const row = backlogResult.rows[0] as any;
      dueEnrollmentCount = Number(row?.backlog ?? 0);
      oldestDueMs = row?.oldest_due_at ? Date.now() - new Date(row.oldest_due_at).getTime() : null;
      const lastRunRaw = await storage.getSystemSetting("sequence_worker_last_run");
      lastSequenceRunMs =
        lastRunRaw && typeof lastRunRaw === "object" && (lastRunRaw as any).duration_ms !== undefined
          ? Number((lastRunRaw as any).duration_ms)
          : null;
    } catch {
      backlogStatus = "error";
      backlogErrorCode = "SEQUENCE_BACKLOG_READ_FAILED";
      degradations.push(backlogErrorCode);
    }

    let observedAccountConnectedClients: number | null = null;
    let infoProbeStatus: QueueTelemetryEvidence["redis"]["infoProbeStatus"] = "not_initialized";
    let redisErrorCode: string | undefined;
    const redis = getSharedRedisClientIfReady();
    if (redis) {
      try {
        const infoRaw = await redis.info("clients");
        const match = infoRaw.match(/(?:^|\r?\n)connected_clients:(\d+)/);
        if (!match) throw new Error("CONNECTED_CLIENTS_MISSING");
        observedAccountConnectedClients = Number(match[1]);
        infoProbeStatus = "ok";
      } catch {
        infoProbeStatus = "error";
        redisErrorCode = "REDIS_CLIENT_INFO_READ_FAILED";
        degradations.push(redisErrorCode);
      }
    } else {
      redisErrorCode = "REDIS_CLIENT_NOT_INITIALIZED";
      degradations.push(redisErrorCode);
    }
    const capacity = diagnoseRedisCapacity({
      physicalWorkerCount: topology.instantiatedWorkerCount,
      observedAccountConnectedClients,
      deploymentProcessCount: fleet.authoritativeComplete ? fleet.observedProcessCount : null,
    });

    if (metrics.status === "degraded") degradations.push("QUEUE_METRICS_DEGRADED");
    const sfpRepeatableQueues = [
      QUEUE_NAMES.SFP_CAMPAIGN_STAGING,
      QUEUE_NAMES.SFP_FREE_CLASSIFICATION,
      QUEUE_NAMES.SFP_CONTINUOUS_DISCOVERY,
      QUEUE_NAMES.SFP_CONTINUOUS_VALIDATION,
      QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY,
    ];
    const observedForMs = Date.now() - this.observationStartedAt.getTime();
    for (const queueName of sfpRepeatableQueues) {
      if (!this.queues.has(queueName)) continue; // capability group was not selected
      const config = QUEUE_CONFIGS.find((candidate) => candidate.name === queueName);
      const intervalMs = this.effectiveIntervals.get(queueName) ?? config?.repeatEveryMs ?? 0;
      const graceMs = Math.max(intervalMs * 2, 60_000);
      if (!this.isQueueWorkerActive(queueName)) {
        degradations.push(`SFP_WORKER_NOT_READY:${queueName}`);
      } else {
        const lastTick = this.processLastCompletedAt.get(queueName);
        if (lastTick === undefined && observedForMs > graceMs) {
          degradations.push(`SFP_WORKER_TICK_NOT_OBSERVED:${queueName}`);
        } else if (lastTick !== undefined && Date.now() - lastTick > graceMs) {
          degradations.push(`SFP_WORKER_TICK_STALE:${queueName}`);
        }
      }
    }
    if (dlqRead.queueStatus.some((source) => source.status !== "sampled")) {
      degradations.push("DLQ_SAMPLE_INCOMPLETE");
    }
    if (fleet.status !== "reconciled") degradations.push("FLEET_NOT_RECONCILED");
    if (capacity.status !== "safe") degradations.push(`REDIS_CAPACITY_${capacity.status.toUpperCase()}`);

    return {
      status: degradations.length ? "degraded" : "ok",
      scope: "local_process_with_reconciled_cro03c_worker_fleet",
      freshness: {
        capturedAt,
        observationStartedAt: this.observationStartedAt.toISOString(),
      },
      topology,
      fleet,
      queues: metrics.queues,
      backlog: {
        probeStatus: backlogStatus,
        dueEnrollmentCount,
        oldestDueMs,
        lastSequenceRunMs,
        ...(backlogErrorCode ? { errorCode: backlogErrorCode } : {}),
      },
      redis: {
        infoProbeStatus,
        observedAccountConnectedClients,
        capacity,
        ...(redisErrorCode ? { errorCode: redisErrorCode } : {}),
      },
      dlq: {
        sampleCount: dlqRead.items.length,
        complete: false,
        resultScope: "sampled_per_queue",
        queueStatus: dlqRead.queueStatus,
      },
      history: this.getJobHistory(),
      degradations: [...new Set(degradations)],
    };
  }

  async getDeadLetterItemsWithStatus(): Promise<DlqReadResult> {
    const items: DlqItem[] = [];
    const queueStatus: DlqReadResult["queueStatus"] = [];

    for (const config of QUEUE_CONFIGS) {
      const queue = this.queues.get(config.name);
      if (!queue) {
        queueStatus.push({ source: config.name, status: "not_initialized" });
        continue;
      }

      try {
        const failedJobs = await queue.getFailed(0, 49);
        for (const job of failedJobs) {
          if (!job.id) continue;
          const attemptsAllowed = job.opts.attempts ?? 1;
          if (job.attemptsMade >= attemptsAllowed) {
            items.push({
              id: `${config.name}::${job.id}`,
              queueName: config.name,
              jobName: job.name,
              failureCode: "terminal_exhaustion",
              attemptsMade: job.attemptsMade,
              timestamp: job.timestamp,
              processedOn: job.processedOn ?? null,
              finishedOn: job.finishedOn ?? null,
            });
          }
        }
        queueStatus.push({ source: config.name, status: "sampled", sampleLimitPerQueue: 50 });
      } catch {
        queueStatus.push({ source: config.name, status: "failed", errorCode: "QUEUE_READ_FAILED" });
      }
    }

    return { items: items.sort((a, b) => b.timestamp - a.timestamp), queueStatus };
  }

  async getDeadLetterItems(): Promise<DlqItem[]> {
    return (await this.getDeadLetterItemsWithStatus()).items;
  }

  async retryDeadLetterJob(compositeId: string): Promise<void> {
    const [queueName, jobId] = compositeId.split("::");
    const queue = this.queues.get(queueName as QueueName);
    if (!queue) throw new Error(`Queue not found: ${queueName}`);

    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    await job.retry();
    console.log(`[QueueManager] Retried dead-letter job ${jobId} in ${queueName}`);
  }

  async discardDeadLetterJob(compositeId: string): Promise<void> {
    const [queueName, jobId] = compositeId.split("::");
    if (!queueName || !jobId) throw new Error(`Invalid compositeId: ${compositeId}`);
    const queue = this.queues.get(queueName as QueueName);
    if (!queue) throw new Error(`Queue not found: ${queueName}`);

    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    // Guard: only allow removing jobs that are in the failed state AND have
    // exhausted all retry attempts. This prevents the endpoint from being used
    // to delete waiting, delayed, or still-retrying operational work.
    const state = await job.getState();
    if (state !== "failed") {
      throw new Error(`Job ${jobId} is in state "${state}", not "failed" — refusing to discard`);
    }
    const attemptsAllowed = job.opts.attempts ?? 1;
    if (job.attemptsMade < attemptsAllowed) {
      throw new Error(
        `Job ${jobId} has only made ${job.attemptsMade}/${attemptsAllowed} attempts — it may still be retried; refusing to discard`,
      );
    }

    await job.remove();
    console.log(`[QueueManager] Discarded dead-letter job ${jobId} from ${queueName}`);
  }

  /**
   * Fetch ALL exhausted failed jobs from a single queue, paginating until
   * the result set is fully drained.  BullMQ's getFailed(start, end) uses
   * zero-based inclusive indexes, so we step through in PAGE_SIZE batches.
   */
  private async getAllExhaustedFailedJobs(queue: Queue): Promise<Job[]> {
    const PAGE_SIZE = 500;
    const exhausted: Job[] = [];
    let start = 0;

    while (true) {
      const page = await queue.getFailed(start, start + PAGE_SIZE - 1);
      for (const job of page) {
        if (!job.id) continue;
        const attemptsAllowed = job.opts.attempts ?? 1;
        if (job.attemptsMade >= attemptsAllowed) {
          exhausted.push(job);
        }
      }
      if (page.length < PAGE_SIZE) break; // last page — we've seen everything
      start += PAGE_SIZE;
    }

    return exhausted;
  }

  /**
   * Bulk-purge dead-letter jobs from all queues.
   * @param olderThanDays  Only remove jobs whose timestamp is older than this many days.
   *                       Pass 0 (or omit) to remove ALL exhausted failed jobs.
   * @returns Number of jobs removed.
   */
  async purgeDeadLetterItems(olderThanDays = 0): Promise<number> {
    const cutoffMs = olderThanDays > 0 ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : Infinity;
    let removed = 0;

    for (const config of QUEUE_CONFIGS) {
      const queue = this.queues.get(config.name);
      if (!queue) continue;

      try {
        const exhaustedJobs = await this.getAllExhaustedFailedJobs(queue);
        for (const job of exhaustedJobs) {
          if (olderThanDays > 0 && job.timestamp >= cutoffMs) continue; // too recent
          try {
            await job.remove();
            removed++;
          } catch {
            // best-effort; job may already be gone
          }
        }
      } catch {
        // queue unavailable — skip
      }
    }

    console.log(`[QueueManager] Purged ${removed} dead-letter job(s) (olderThanDays=${olderThanDays})`);
    return removed;
  }

  async pauseQueue(name: string): Promise<void> {
    const queue = this.queues.get(name as QueueName);
    // A capability profile may intentionally leave a certified queue
    // uninstantiated (for example, the provider-denied/off profile).  Pausing
    // that queue is already effective, so treat it as an idempotent no-op.
    // Preserve the error for unknown names so operator typos remain visible.
    if (!queue) {
      if (QUEUE_CONFIGS.some((config) => config.name === name)) return;
      throw new Error(`Queue not found: ${name}`);
    }
    await queue.pause();
  }

  async resumeQueue(name: string): Promise<void> {
    const queue = this.queues.get(name as QueueName);
    if (!queue) {
      if (QUEUE_CONFIGS.some((config) => config.name === name)) return;
      throw new Error(`Queue not found: ${name}`);
    }
    await queue.resume();
  }

  async shutdown(timeoutMs = parseInt(process.env.QUEUE_SHUTDOWN_TIMEOUT_MS ?? "7000")): Promise<void> {
    console.log("[QueueManager] Graceful shutdown — waiting for in-flight jobs...");

    if (this.cro03cHeartbeatTimer) clearInterval(this.cro03cHeartbeatTimer);
    this.cro03cHeartbeatTimer = null;
    if (this.sfpRuntimeOwnerTimer) clearInterval(this.sfpRuntimeOwnerTimer);
    this.sfpRuntimeOwnerTimer = null;
    if (this.cro03cHeartbeatKey) {
      await (this.connection as any).del(this.cro03cHeartbeatKey).catch(() => undefined);
      this.cro03cHeartbeatKey = null;
    }

    const workerCloses = Array.from(this.workers.values()).map(w =>
      Promise.race([
        w.close(),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ])
    );

    await Promise.all(workerCloses);

    const queueCloses = Array.from(this.queues.values()).map(q => q.close());
    await Promise.all(queueCloses);

    console.log("[QueueManager] All queues and workers shut down");
  }
}

/**
 * W08: Hash covers the effective configuration — static topology PLUS the
 * active profile and selected capability groups.  A changed profile (off →
 * selective:enrichment, selective:enrichment → full) changes the hash and
 * invalidates any heartbeats or inventories signed against the prior value.
 *
 * Timestamps, secrets and boot IDs are intentionally excluded so the hash
 * is deterministic across restarts with the same configuration.
 */
export function getCro03cQueueTopologyHash(): string {
  const profile = getBackgroundProfile();
  const selectedGroups = profile === "selective" ? getSelectiveGroups().sort() : [];

  const topology = {
    // W08: include effective profile in hash
    effectiveProfile: profile,
    selectedGroups,
    queues: QUEUE_CONFIGS.map(({ name, concurrency, attempts, backoffDelay, repeatEveryMs, cronPattern, jobName }) => ({
      name, concurrency, attempts, backoffDelay, repeatEveryMs, cronPattern: cronPattern ?? null, jobName,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    namedSchedules: NAMED_QUEUE_SCHEDULES.map(({ queueName, jobName, repeatEveryMs, cronPattern, jobId }) => ({
      queueName, jobName, repeatEveryMs, cronPattern: cronPattern ?? null, jobId,
    })).sort((a, b) => a.jobId.localeCompare(b.jobId)),
  };
  return createHash("sha256").update(JSON.stringify(topology)).digest("hex");
}

async function runGhlSyncTick(): Promise<void> {
  const { runGhlFullSyncTick } = await import("./ghl-sync");
  await runGhlFullSyncTick();
}

async function runSlaCheckTick(): Promise<void> {
  const { runFullSlaLoop } = await import("./sla-worker");
  await runFullSlaLoop();
}

async function runSequencesTick(): Promise<void> {
  const { processSequenceEnrollments } = await import("./sequence-worker");
  const { processSendQueue } = await import("./campaign-engine");
  const { runSunbizAutoConvert } = await import("./sunbiz-cron");
  const { storage } = await import("../storage");

  // Isolate processSequenceEnrollments so a thrown error still (a) gets structured
  // job/tick-context logging, (b) does not block sibling sub-tasks in this tick,
  // and (c) does not skip the post-tick "sequence_runner_last_tick" health bookkeeping.
  let result: { processed?: number; sent?: number } = {};
  let sequenceError: Error | null = null;
  try {
    result = await processSequenceEnrollments();
    const { recordWorkerSuccess, JOB_NAMES } = await import("./job-registry");
    await recordWorkerSuccess(JOB_NAMES.SEQUENCE_ENROLLMENT_PROCESSOR);
  } catch (err) {
    sequenceError = err instanceof Error ? err : new Error(String(err));
    console.error(`[Queue:sequences] processSequenceEnrollments error (tick=sequences, job=processSequenceEnrollments):`, sequenceError.message);
    const { recordWorkerFailure, JOB_NAMES } = await import("./job-registry");
    await recordWorkerFailure(JOB_NAMES.SEQUENCE_ENROLLMENT_PROCESSOR, sequenceError.message);
  } finally {
    const tickAt = new Date().toISOString();
    await storage.setSystemSetting("sequence_runner_last_tick", {
      at: tickAt,
      processed: (result as any).processed ?? 0,
      sent: (result as any).sent ?? 0,
      enabled: true,
      ...(sequenceError ? { lastError: sequenceError.message } : {}),
    }).catch((err: Error) => console.error("[Queue:sequences] heartbeat write failed (setSystemSetting):", err.message));
    // Emit audit-log heartbeat so go-live-check.ts and monitoring can verify the
    // worker ran without relying on system_settings alone.
    await storage.createAuditLog({
      action: "sequence_worker_tick",
      entityType: "system",
      actorType: "system",
      details: {
        at: tickAt,
        processed: (result as any).processed ?? 0,
        sent: (result as any).sent ?? 0,
        ...(sequenceError ? { error: sequenceError.message } : {}),
      },
    }).catch((err: Error) => console.error("[Queue:sequences] heartbeat write failed (createAuditLog):", err.message));
  }

  if (!sequenceError && ((result as any).processed ?? 0) === 0) {
    (async () => {
      try {
        const { db: _db } = await import("../db");
        const { sql: _sql } = await import("drizzle-orm");
        const enrollCheck = await _db.execute(_sql`
          SELECT COUNT(*) AS c FROM sequence_enrollments WHERE status = 'active' LIMIT 1
        `);
        const hasActive = Number((enrollCheck.rows[0] as any)?.c ?? 0) > 0;
        if (hasActive) {
          const nowMs = Date.now();
          if (nowMs - seqNoOpAlertCooldown > 4 * 60 * 60 * 1000) {
            seqNoOpAlertCooldown = nowMs;
            const { sendCriticalAlert } = await import("./system-audit/slack-notifier");
            await sendCriticalAlert({
              subsystem: "sequences",
              status: "error",
              summary: "Sequence engine unexpected no-op — processSequenceEnrollments returned 0 processed with active enrollments in DB.",
              details: { hasActiveEnrollments: true, processed: 0, note: "Worker may be stalled, gated, or blocked by a lock." },
            });
          }
        }
      } catch (_e) {}
    })().catch(() => {});
  }

  await processSendQueue().catch(err => console.error("[Queue:sequences] Campaign send queue error:", err));
  // NOTE: Sunbiz auto-convert has been moved to runEnrichmentTick(), gated by SUNBIZ_ENRICHMENT_ENABLED.
  // It must not run under the LEGACY_OUTREACH_ENABLED gate — the two pipelines are independent.
}

async function runEnrichmentTick(): Promise<void> {
  // ── enrichment_progress startup reset ──────────────────────────────────────
  // If a prior run was interrupted (e.g. worker crash), reset the key to 'idle'
  // so the next scheduled tick can proceed. Cursor-based resume is not supported
  // by this architecture; only the status flag needs to be cleared.
  // (See task MI-01 for context — do NOT implement resumable-cursor recovery.)
  try {
    const { storage: _storage } = await import("../storage");
    const { db: _db } = await import("../db");
    const { auditLogs: _auditLogs } = await import("@shared/schema");
    const progressRaw = await _storage.getSystemSetting("enrichment_progress");
    if (progressRaw && (progressRaw as any).status === "interrupted") {
      const priorStatus = (progressRaw as any).status;
      const priorInterruptedAt = (progressRaw as any).interruptedAt ?? null;
      await _storage.setSystemSetting("enrichment_progress", {
        ...(progressRaw as any),
        status: "idle",
        interruptedAt: null,
        resetAt: new Date().toISOString(),
      });
      _db.insert(_auditLogs).values({
        action: "enrichment_progress_reset",
        entityType: "system",
        actorType: "system",
        details: { priorStatus, priorInterruptedAt },
      }).catch((e: any) => console.error("[Queue:enrichment] audit log insert failed:", e?.message));
      console.log("[Queue:enrichment] enrichment_progress was interrupted — reset to idle.");
    }
  } catch (resetErr: any) {
    console.error("[Queue:enrichment] enrichment_progress reset error (non-fatal):", resetErr?.message);
  }

  // Reclaim free-discovery generations left in state='running' by a batch
  // that crashed hard (kill/OOM/deploy restart) instead of throwing a
  // catchable error — no in-process try/finally can observe that case, so
  // without this periodic sweep the generation (and the telemetry counters
  // keyed off it) would report "in progress" forever. Cheap no-op when
  // nothing is stale; safe to run every tick.
  try {
    const { reclaimStaleFreeDiscoveryGenerations } = await import("./free-discovery/evidence-service");
    const reclaim = await reclaimStaleFreeDiscoveryGenerations();
    if (reclaim.reclaimed > 0) {
      console.log(`[Queue:enrichment] Reclaimed ${reclaim.reclaimed} stale free-discovery generation(s): ${reclaim.ids.join(", ")}`);
    }
  } catch (reclaimErr: any) {
    console.error("[Queue:enrichment] free-discovery generation reclaim error (non-fatal):", reclaimErr?.message);
  }

  const { processNextCro03Item, processNextCro03Mutation } = await import("./cro03/enrichment-factory");
  const { processNextCro03bRecipeItem } = await import("./cro03/admission-service");
  try {
    for (let processed = 0; processed < 5; processed++) {
      if (await processNextCro03Item() === "idle") break;
    }
    for (let processed = 0; processed < 10; processed++) {
      if (await processNextCro03Mutation() === "idle") break;
    }
    for (let processed = 0; processed < 10; processed++) {
      if (await processNextCro03bRecipeItem() === "idle") break;
    }
    const { recordWorkerSuccess, JOB_NAMES } = await import("./job-registry");
    await recordWorkerSuccess(JOB_NAMES.ENRICHMENT_QUEUE_PROCESSOR);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error("[Queue:enrichment] CRO-03 durable factory error:", e.message);
    const { recordWorkerFailure, JOB_NAMES } = await import("./job-registry");
    await recordWorkerFailure(JOB_NAMES.ENRICHMENT_QUEUE_PROCESSOR, e.message);
  }

  // ── Existing-contact backlog enrichment (task #1943) ─────────────────────
  // Reconnects the working Serper-backed contact enrichment path so the
  // existing CRM backlog (contacts missing email/phone/website) gets worked
  // through automatically instead of only via ad hoc admin batches. All
  // budget and circuit-breaker enforcement lives in SerperGateway/serper.ts —
  // this tick only needs to (a) skip cheaply when Serper is off so it doesn't
  // spin through the same stuck rows every 10 minutes, and (b) avoid
  // re-entering while a batch (admin-triggered or this tick) is already
  // running, which enrichContactBatch's own contactEnrichRunning flag covers.
  try {
    const { isSerperConfigured } = await import("./serper");
    const { serperGateway } = await import("./serper-gateway");
    const { isContactEnrichRunning, getContactIdsNeedingEnrichment, enrichContactBatch } = await import("./enrichment");
    if (isSerperConfigured() && !isContactEnrichRunning()) {
      const control = await serperGateway.getControl();
      // enabled alone is not enough — an open circuit blocks every provider
      // call, so launching a batch here would just spend the whole tick
      // discovering that (and enrichContactBatch's own per-contact gateway
      // check would abort it anyway). half_open is allowed through since the
      // gateway itself gates the actual probe request.
      if (control?.enabled && control.state !== "open") {
        const backlogIds = await getContactIdsNeedingEnrichment(25);
        if (backlogIds.length > 0) {
          await enrichContactBatch(backlogIds, { batchSize: 10 });
        }
      }
    }
  } catch (err) {
    console.error("[Queue:enrichment] Contact backlog enrichment error:", err);
  }

  // Sunbiz enrichment queue + auto-convert run independently of LEGACY_OUTREACH_ENABLED.
  // Both are gated directly on SUNBIZ_ENRICHMENT_ENABLED so operators can activate
  // the full Sunbiz lead pipeline without enabling the outreach engine.
  const { featureFlags: _enrichFlags } = await import("./feature-flags");
  if (_enrichFlags.SUNBIZ_ENRICHMENT_ENABLED) {
    // Step 1: Enrich pending Sunbiz entities (scrape/classify raw → enriched)
    const { processSunbizEnrichmentQueue, runSunbizAutoConvert } = await import("./sunbiz-cron");
    await processSunbizEnrichmentQueue().catch(err =>
      console.error("[Queue:enrichment] Sunbiz enrichment queue error:", err)
    );
    // Step 2: Convert enriched entities → prospects → contacts (auto-promote)
    await runSunbizAutoConvert().catch(err =>
      console.error("[Queue:enrichment] Sunbiz auto-convert error:", err)
    );
  }

  const { runLeadScoringDeferredRecovery } = await import("./contact-lead-scoring-trigger");
  await runLeadScoringDeferredRecovery().catch(err => console.error("[Queue:enrichment] Lead scoring deferred recovery error (best-effort):", err));

  // Correction #3: the 4-hour advisory-fence producer has been removed.
  // FREE_ENRICHMENT_LANE (15-min BullMQ repeatable) is now the sole scheduler
  // and canonical producer for per-business free enrichment. Having two competing
  // producers racing the same eligibility predicate violated the single-producer
  // contract and caused duplicate work during overlapping windows.
}

/**
 * MI-04 canonical path: selects from `businesses` ONLY and enqueues { businessId } jobs.
 * This function NEVER touches sdr_merchants, sdr_merchant_contacts, or any paid provider.
 * It is the only function the 4-hour cadence fence calls.
 *
 * The legacy sdr_merchants enrichment (`runFreeContactEnrichmentTick`) runs separately,
 * is not gated on FREE_ENRICHMENT_ENABLED, and is not part of the MI-04 pipeline.
 */
async function runCanonicalBusinessEnrichmentTick(): Promise<void> {
  const BATCH = 20;
  const { db: _db } = await import("../db");
  const { sql: _sql } = await import("drizzle-orm");

  // Task #1906: rewritten as a UNION ALL of three disjoint branches (rather
  // than a single OR predicate) so the planner can use each branch's own
  // partial index (businesses_free_enrich_queue_idx / _retryable_failed_idx /
  // _stale_idx, migrations 0250 + 0264) independently instead of falling
  // back to a sequential scan of the full `businesses` table. The branches
  // are mutually exclusive (free_enrichment_status is either null, 'failed',
  // or 'enriched'), so UNION ALL cannot introduce duplicate ids.
  const businessRows = await _db.execute(_sql`
    SELECT id FROM (
      SELECT id FROM businesses
      WHERE website_domain IS NOT NULL
        AND record_class = 'canonical'
        AND free_enrichment_status IS NULL

      UNION ALL

      SELECT id FROM businesses
      WHERE website_domain IS NOT NULL
        AND record_class = 'canonical'
        AND free_enrichment_status = 'failed'
        AND free_enrichment_attempt_count < 3

      UNION ALL

      SELECT id FROM businesses
      WHERE website_domain IS NOT NULL
        AND record_class = 'canonical'
        AND free_enrichment_status = 'enriched'
        AND free_enrichment_completed_at < NOW() - INTERVAL '90 days'
    ) eligible
    ORDER BY id
    LIMIT ${BATCH}
  `);
  const businesses: { id: number }[] = ((businessRows as any).rows ?? businessRows).map((r: any) => ({ id: Number(r.id) }));

  if (businesses.length === 0) {
    console.log("[CanonicalEnrich] No businesses pending free enrichment");
    return;
  }

  const qm = requireQueueManagerReady();
  const enrichmentQueue = qm.getQueue(QUEUE_NAMES.ENRICHMENT);
  if (!enrichmentQueue) {
    console.warn("[CanonicalEnrich] Enrichment queue not found — skipping job enqueue");
    return;
  }

  for (const b of businesses) {
    // Do NOT use a static jobId per businessId — completed jobs are retained
    // (removeOnComplete: count) and BullMQ silently skips new jobs with the same ID.
    // For the 90-day stale-enrichment path the same business must be enqueued again;
    // a static ID would block it indefinitely once the prior completed job is cached.
    // Deduplication within the same 4-hour cycle is handled by the handler's idempotency
    // check (free_enrichment_status + completed_at), not by BullMQ job ID.
    await enrichmentQueue.add(
      "free-contact-enrichment",
      { businessId: b.id },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: true,  // Remove immediately — no static-ID accumulation
        removeOnFail: { count: 100 },
      }
    ).catch((err: Error) => console.error(`[CanonicalEnrich] Failed to enqueue business ${b.id}:`, err));
  }
  console.log(`[CanonicalEnrich] Enqueued ${businesses.length} per-business enrichment jobs`);
}

/**
 * Legacy SDR merchants enrichment tick. Runs independently of FREE_ENRICHMENT_ENABLED.
 * This path writes sdr_merchant_contacts and may call paid providers; it is separate
 * from the MI-04 canonical business pipeline.
 */
async function runFreeContactEnrichmentTick(): Promise<void> {
  const BATCH = 20;
  const { db: _db } = await import("../db");
  const { sql: _sql } = await import("drizzle-orm");

  const { sdrMerchants } = await import("@shared/schema");
  const { and } = await import("drizzle-orm");
  const pending = await _db
    .select({ id: sdrMerchants.id })
    .from(sdrMerchants)
    .where(
      and(
        _sql`(${sdrMerchants.domain} IS NOT NULL OR ${sdrMerchants.website} IS NOT NULL)`,
        _sql`${sdrMerchants.ownerEnrichmentStatus} = 'pending'`,
        _sql`${sdrMerchants.doNotContactFlag} IS NOT TRUE`,
        _sql`NOT EXISTS (SELECT 1 FROM sdr_merchant_contacts mc WHERE mc.merchant_id = ${sdrMerchants.id} AND mc.email IS NOT NULL)`,
      )
    )
    .limit(BATCH);

  if (pending.length === 0) return;

  const qm = requireQueueManagerReady();
  const enrichmentQueue = qm.getQueue(QUEUE_NAMES.ENRICHMENT);
  if (!enrichmentQueue) {
    console.warn("[FreeEnrich] Enrichment queue not found — skipping legacy merchant enqueue");
    return;
  }

  for (const m of pending) {
    await enrichmentQueue.add(
      "free-contact-enrichment",
      { merchantId: m.id },
      {
        jobId: `free-contact-enrichment-${m.id}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
      }
    ).catch((err: Error) => console.error(`[FreeEnrich] Failed to enqueue merchant ${m.id}:`, err));
  }
  console.log(`[FreeEnrich] Enqueued ${pending.length} per-merchant enrichment jobs`);
}

async function runFreeContactEnrichmentForMerchant(merchantId: number): Promise<void> {
  const { db } = await import("../db");
  const { sdrMerchants } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const { runRdapEnrichment } = await import("./sdr/rdap-enrichment");
  const { runJsonLdEnrichment } = await import("./sdr/jsonld-enrichment");
  const { runContactPageEnrichment } = await import("./sdr/contactpage-enrichment");

  let emailFound = false;
  let transientError: Error | null = null;

  try {
    const rdap = await runRdapEnrichment(merchantId);
    if (rdap.emailFound) { emailFound = true; }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`[FreeEnrich] RDAP transient failure for merchant ${merchantId}:`, e.message);
    transientError = e;
  }

  if (!emailFound) {
    try {
      const jld = await runJsonLdEnrichment(merchantId);
      if (jld.emailFound) { emailFound = true; }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error(`[FreeEnrich] JSON-LD transient failure for merchant ${merchantId}:`, e.message);
      if (!transientError) transientError = e;
    }
  }

  if (!emailFound) {
    try {
      const cp = await runContactPageEnrichment(merchantId);
      if (cp.enriched) { emailFound = true; }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error(`[FreeEnrich] ContactPage transient failure for merchant ${merchantId}:`, e.message);
      if (!transientError) transientError = e;
    }
  }

  // Processor detection: merge into sdrLeadState.enrichmentData (non-fatal)
  try {
    const { detectProcessorsForDomain } = await import("./sdr/processor-detector");
    const { storage: stg } = await import("../storage");
    const [merchantRow] = await db.select().from(sdrMerchants).where(eq(sdrMerchants.id, merchantId));
    const domain = merchantRow?.domain || merchantRow?.website;
    if (domain) {
      const results = await detectProcessorsForDomain(
        domain,
        merchantRow.businessName,
        merchantRow.city ?? undefined,
        merchantRow.state ?? undefined
      );
      const detectionSource = results.length > 0 && results[0].detectionMethod === "serper" ? "serper" : "html";
      const leadState = await stg.getSdrLeadStateByMerchant(merchantId);
      if (leadState) {
        const existingEnrichment = (leadState.enrichmentData as Record<string, unknown>) ?? {};
        await stg.updateSdrLeadState(leadState.id, {
          enrichmentData: {
            ...existingEnrichment,
            processorSignals: results,
            processorDetectionAt: new Date().toISOString(),
            processorDetectionSource: detectionSource,
          },
        });
        console.log(`[FreeEnrich] Merchant ${merchantId}: processor detection merged (${results.length} signals via ${detectionSource})`);
      }
    }
  } catch (err) {
    console.error(`[FreeEnrich] Processor detection failed for merchant ${merchantId}:`, err);
  }

  if (emailFound) {
    await db.update(sdrMerchants)
      .set({ ownerEnrichmentStatus: "enriched", updatedAt: new Date() })
      .where(eq(sdrMerchants.id, merchantId))
      .catch(e => console.error(`[FreeEnrich] Status update failed for merchant ${merchantId}:`, e));
    console.log(`[FreeEnrich] Merchant ${merchantId}: enriched`);
  } else if (transientError) {
    throw new Error(`[FreeEnrich] Transient enrichment failure for merchant ${merchantId}: ${transientError.message}`);
  } else {
    await db.update(sdrMerchants)
      .set({ ownerEnrichmentStatus: "failed", updatedAt: new Date() })
      .where(eq(sdrMerchants.id, merchantId))
      .catch(e => console.error(`[FreeEnrich] Status update failed for merchant ${merchantId}:`, e));
    console.log(`[FreeEnrich] Merchant ${merchantId}: failed (no email found by any source)`);
  }
}

/**
 * Per-business free enrichment handler — MI-04 canonical pipeline.
 *
 * Kill-line contracts enforced here:
 * - Never calls Serper, Apollo, Outscraper, or ZeroBounce
 * - Never writes contacts or sdr_merchant_contacts rows
 * - Re-run on already-enriched businesses (within 90 days) is a no-op
 * - CRO-03 evidence written via createCro03SourceBatch() only
 */
export async function runFreeBusinessEnrichmentForBusiness(businessId: number): Promise<void> {
  const { db: _db } = await import("../db");
  const { sql: _sql } = await import("drizzle-orm");
  const { businessLacksDbprLineageSql } = await import("./dbpr");

  // Load business row
  const bizRows = ((await _db.execute(_sql`
    SELECT id, website_domain, canonical_name, free_enrichment_status, free_enrichment_completed_at, free_enrichment_attempt_count
    FROM businesses WHERE id = ${businessId}
  `)) as any).rows ?? [];
  const biz = bizRows[0];
  if (!biz) {
    console.warn(`[FreeEnrich-Business] Business ${businessId} not found — skipping`);
    return;
  }

  const domain: string | null = biz.website_domain;
  if (!domain) {
    console.warn(`[FreeEnrich-Business] Business ${businessId} has no website_domain — skipping`);
    // No-domain skips are safe to write unconditionally (no concurrent worker dispute).
    await _db.execute(_sql`
      UPDATE businesses SET free_enrichment_status = 'skipped', free_enrichment_last_attempt_at = NOW()
      WHERE id = ${businessId} AND website_domain IS NULL
    `);
    return;
  }

  // Atomic claim — exactly one concurrent worker wins.
  //
  // The WHERE predicate is the EXACT eligibility predicate from the scheduler and
  // health query, including the attempt_count < 3 cap. Rows beyond the cap, rows
  // already claimed (status='processing'), enriched-within-90-days rows, and rows
  // without a domain are all excluded. A losing worker exits immediately with no
  // adapter execution, no CRO-03 write, and no status overwrite.
  //
  // We also return website_domain from the UPDATE so we always use the domain that
  // was valid at claim time — not a value read before the UPDATE that could have
  // changed in between.
  const claimResult = ((await _db.execute(_sql`
    UPDATE businesses
    SET free_enrichment_status = 'processing',
        free_enrichment_last_attempt_at = NOW(),
        free_enrichment_attempt_count = COALESCE(free_enrichment_attempt_count, 0) + 1
    WHERE id = ${businessId}
      AND website_domain IS NOT NULL
      AND record_class = 'canonical'
      AND ${businessLacksDbprLineageSql(_sql`businesses.id`)}
      AND (
        free_enrichment_status IS NULL
        OR (free_enrichment_status = 'failed'
            AND COALESCE(free_enrichment_attempt_count, 0) < 3)
        OR (free_enrichment_status = 'enriched'
            AND free_enrichment_completed_at < NOW() - INTERVAL '90 days')
      )
    RETURNING id, website_domain, free_enrichment_attempt_count
  `)) as any).rows ?? [];

  if (claimResult.length === 0) {
    // Claim lost: another worker already claimed, row is not eligible, or
    // already enriched within 90 days. No work to do.
    console.log(`[FreeEnrich-Business] Business ${businessId} claim lost or not eligible — skipping`);
    return;
  }

  // Use the domain value returned from the atomic claim (not the pre-claim read).
  const claimedDomain: string = claimResult[0]?.website_domain;
  const attemptCount = Number(claimResult[0]?.free_enrichment_attempt_count ?? 1);

  // Overwrite the domain variable to ensure all downstream code uses the claimed value.
  if (claimedDomain !== domain) {
    console.log(`[FreeEnrich-Business] Domain changed between read and claim for business ${businessId}: using claimed domain '${claimedDomain}'`);
  }
  const activeDomain = claimedDomain;

  const evidencePayload: Record<string, unknown> = {
    domain: activeDomain,
    attemptCount,
    startedAt: new Date().toISOString(),
  };
  let finalStatus: "enriched" | "failed" = "failed";
  let lastErrorCode: string | null = null;
  // Track how many adapters reported fetchCompleted=true (i.e., made a real network
  // round-trip, regardless of whether they found any data). If EVERY adapter returns
  // fetchCompleted=false, the run encountered a total transport outage and must throw
  // so BullMQ retries. Zero-result completed fetches are fine and mark as enriched.
  let completedFetchCount = 0;

  try {
    // 1. RDAP — registrant org only, no contact writes
    try {
      const { runRdapBusinessEnrichment } = await import("./sdr/rdap-enrichment");
      const rdapResult = await runRdapBusinessEnrichment(businessId, activeDomain);
      if (rdapResult.fetchCompleted) completedFetchCount++;
      evidencePayload.rdap = { registrantOrg: rdapResult.registrantOrg, registrar: rdapResult.registrar };
    } catch (rdapErr: any) {
      console.error(`[FreeEnrich-Business] RDAP error for business ${businessId}:`, rdapErr?.message);
      evidencePayload.rdapError = rdapErr?.message;
      // fetchCompleted stays uncounted — thrown = transport failure
    }

    // 2. JSON-LD — business schema data + candidate emails (Correction #1)
    let jsonldEmailCount = 0;
    let jsonldEmails: string[] = [];
    try {
      const { runJsonLdBusinessEnrichment } = await import("./sdr/jsonld-enrichment");
      const jldResult = await runJsonLdBusinessEnrichment(businessId, activeDomain);
      if (jldResult.fetchCompleted) completedFetchCount++;
      jsonldEmailCount = jldResult.emailCount;
      jsonldEmails = jldResult.emails;
      evidencePayload.jsonld = { emailCount: jldResult.emailCount };
    } catch (jldErr: any) {
      console.error(`[FreeEnrich-Business] JSON-LD error for business ${businessId}:`, jldErr?.message);
      evidencePayload.jsonldError = jldErr?.message;
    }

    // 3. Contact-page — email candidate discovery (Correction #1: now returns actual emails)
    let contactPageEmailCount = 0;
    let contactPageEmails: string[] = [];
    try {
      const { runContactPageBusinessEnrichment } = await import("./sdr/contactpage-enrichment");
      const cpResult = await runContactPageBusinessEnrichment(businessId, activeDomain);
      if (cpResult.fetchCompleted) completedFetchCount++;
      contactPageEmailCount = cpResult.emailCount;
      contactPageEmails = cpResult.emails;
      evidencePayload.contactPage = { emailCount: cpResult.emailCount };
    } catch (cpErr: any) {
      console.error(`[FreeEnrich-Business] ContactPage error for business ${businessId}:`, cpErr?.message);
      evidencePayload.contactPageError = cpErr?.message;
    }

    // 3a. Persist discovered email addresses as encrypted free_discovery_candidates
    //     (Correction #1: business enrichment must store actual addresses, not only counts).
    //     Uses the domain cache to avoid recording candidates that were already crawled
    //     within the TTL. Every candidate is ranked and deduplicated by normalized hash.
    try {
      const {
        createFreeDiscoveryGeneration, completeFreeDiscoveryGeneration,
        recordFreeDiscoveryCandidate, getDomainCache, markDomainCrawled,
        newFreeDiscoveryRunKey,
      } = await import("./free-discovery/evidence-service");

      // Merge all discovered emails. JSON-LD schema markup = high confidence (85);
      // contact-page crawl = lower confidence (60). Dedup by normalized address.
      const emailsBySource = new Map<string, { source: string; confidence: number }>();
      for (const e of jsonldEmails) {
        if (!emailsBySource.has(e)) emailsBySource.set(e, { source: "jsonld", confidence: 85 });
      }
      for (const e of contactPageEmails) {
        if (!emailsBySource.has(e)) emailsBySource.set(e, { source: "contact_page", confidence: 60 });
      }

      if (emailsBySource.size > 0) {
        // Check domain cache — if a fresh cache hit exists, those addresses are already
        // staged for this domain; only record truly new ones discovered this run.
        const cacheState = await getDomainCache(activeDomain);
        const cachedEmails = new Set(cacheState.emails.map(c => c.email));

        // Create a generation to group this business's candidates together.
        const runKey = newFreeDiscoveryRunKey(`biz-enrich-${businessId}`);
        const { id: generationId } = await createFreeDiscoveryGeneration({
          runKey,
          actorId: "free-enrichment-pipeline",
          reason: "business_free_enrichment",
          purpose: "email_discovery",
        });

        let candidatesWritten = 0;
        for (const [email, { source, confidence }] of emailsBySource) {
          const isNewCrawl = !cachedEmails.has(email);
          try {
            await recordFreeDiscoveryCandidate({
              generationId,
              subjectType: "business",
              businessId,
              domain: activeDomain,
              email,
              source,
              attributionScope: "role",
              confidence,
              // Only refresh the domain cache for emails found by an outbound crawl,
              // not for addresses already known from a previous generation's cache.
              refreshDomainCache: isNewCrawl,
            });
            candidatesWritten++;
          } catch (candidateErr: any) {
            console.warn(`[FreeEnrich-Business] Candidate write skipped for business ${businessId} (${email}):`, candidateErr?.message);
          }
        }

        // If no emails were found at all, mark the domain as crawled-with-no-results
        // so it isn't recrawled every batch within the cache TTL.
        if (emailsBySource.size === 0 && contactPageEmailCount === 0) {
          await markDomainCrawled(activeDomain, generationId).catch(() => {});
        }

        await completeFreeDiscoveryGeneration(generationId);
        evidencePayload.candidatesWritten = candidatesWritten;
        console.log(`[FreeEnrich-Business] Business ${businessId}: ${candidatesWritten} candidate(s) staged`);
      } else if (contactPageEmailCount === 0 && jsonldEmailCount === 0) {
        // Record a negative-result crawl on the domain cache so the next batch
        // tick skips recrawling this domain within the TTL window.
        const runKey = newFreeDiscoveryRunKey(`biz-enrich-${businessId}-neg`);
        const { id: negGenId } = await createFreeDiscoveryGeneration({
          runKey, actorId: "free-enrichment-pipeline",
          reason: "business_free_enrichment_negative", purpose: "email_discovery",
        });
        await markDomainCrawled(activeDomain, negGenId).catch(() => {});
        await completeFreeDiscoveryGeneration(negGenId);
      }
    } catch (candidatePersistErr: any) {
      // Candidate persistence failure does not prevent CRO-03 evidence from being written —
      // the count-based evidence is still correct and complete. Log prominently so it is
      // visible but don't propagate: a retry would re-discover the same emails.
      console.error(`[FreeEnrich-Business] Candidate persistence error for business ${businessId}:`, candidatePersistErr?.message);
    }

    // 4. HTML-only processor detection (MI-04 kill-line: NO Serper fallback)
    const processorSignalRows: Array<{ vendor: string; signalType: string; method: string; confidence: number; evidence: string }> = [];
    try {
      const { safeFetch } = await import("./sdr/safe-fetch");
      // Import from the Serper-free HTML-only module (kill-line: no Serper in import graph)
      const { detectProcessorsFromHtmlOnly } = await import("./sdr/processor-detector-html-only");
      const htmlUrl = activeDomain.startsWith("http") ? activeDomain : `https://${activeDomain}`;
      const htmlResp = await safeFetch(htmlUrl, { timeoutMs: 10000 });
      // null = transport failure (timeout/DNS/SSRF block); count only non-null responses
      if (htmlResp !== null) {
        completedFetchCount++;
        if (htmlResp.ok) {
          // body is eagerly read by safeFetch — no separate async read needed
          const html = htmlResp.body ?? "";
          const detections = detectProcessorsFromHtmlOnly(html, htmlUrl);
          evidencePayload.processorSignals = { count: detections.length, vendors: detections.map(d => d.vendor) };

          // Write processor_signals rows (canonical authority)
          for (const detection of detections) {
            try {
              // ON CONFLICT target uses the unique index added in migration 0251:
              //   (business_id, vendor_name, detection_method)
              // Without a named target, ON CONFLICT DO NOTHING would not deduplicate.
              await _db.execute(_sql`
                INSERT INTO processor_signals (business_id, signal_type, vendor_name, detection_method, confidence_score, evidence, detected_at)
                VALUES (${businessId}, ${detection.signalType}, ${detection.vendor}, ${detection.detectionMethod}, ${detection.confidence}, ${detection.evidence}, NOW())
                ON CONFLICT (business_id, vendor_name, detection_method) DO NOTHING
              `);
              processorSignalRows.push({ vendor: detection.vendor, signalType: detection.signalType, method: detection.detectionMethod, confidence: detection.confidence, evidence: detection.evidence });
            } catch (sigErr: any) {
              console.error(`[FreeEnrich-Business] processor_signals write error for business ${businessId}:`, sigErr?.message);
            }
          }
        }
      } else {
        evidencePayload.processorError = "safeFetch returned null (SSRF block or transport failure)";
      }
    } catch (procErr: any) {
      console.error(`[FreeEnrich-Business] Processor detection error for business ${businessId}:`, procErr?.message);
      evidencePayload.processorError = procErr?.message;
    }

    // Guard: if EVERY adapter returned fetchCompleted=false (or threw), treat the run
    // as a total transport outage and propagate an error so BullMQ can retry.
    // This prevents a DNS blackout or broad site outage from being silently recorded
    // as a successful enrichment and suppressing retries for 90 days.
    if (completedFetchCount === 0) {
      throw new Error(
        `ALL_ADAPTERS_TRANSPORT_FAILED: business ${businessId} (domain=${activeDomain}) — ` +
        `all fetch attempts failed (timeout/DNS/SSRF). Will retry via BullMQ.`
      );
    }

    // Summary for businesses.free_enrichment_evidence (counts + hashes, NOT raw evidence authority)
    const evidenceSummary = {
      rdapOrg: (evidencePayload.rdap as any)?.registrantOrg ?? null,
      jsonldEmailCount,
      contactPageEmailCount,
      processorSignalCount: processorSignalRows.length,
      processorVendors: processorSignalRows.map(r => r.vendor),
      collectedAt: new Date().toISOString(),
    };

    // 5. CRO-03 evidence — createCro03SourceBatch() only (immutable hash/provenance contract).
    // This is a required step: failure propagates to BullMQ for retry so evidence is
    // never permanently lost. Do NOT catch-and-swallow this call.
    //
    // Idempotency key: content-addressed by ALL stable subject payload fields.
    // Must include every field that appears in the CRO-03 payload below, so that
    // any change in evidence (rdapOrg, email counts, vendor list) produces a new key.
    // This prevents CRO03_IDEMPOTENCY_PAYLOAD_MISMATCH on retries or stale-refresh runs
    // where the same vendor list exists but other evidence fields changed.
    const rdapOrgForKey = (evidencePayload.rdap as any)?.registrantOrg ?? "";
    const { createHash } = await import("crypto");

    // Sort signal rows ONCE and reuse the same sorted array for both the idempotency
    // fingerprint and the CRO-03 payload. CRO-03 hashes arrays order-sensitively;
    // if fingerprint and payload use different orderings (e.g. sorted vs. detector order),
    // the key resolves to an existing batch whose selection hash doesn't match the new
    // payload order → CRO03_IDEMPOTENCY_PAYLOAD_MISMATCH on any replay.
    const sortedSignals = [...processorSignalRows].sort((a, b) => {
      const t1 = `${a.vendor}:${a.method}:${a.confidence}`;
      const t2 = `${b.vendor}:${b.method}:${b.confidence}`;
      return t1 < t2 ? -1 : t1 > t2 ? 1 : 0;
    });

    // Fingerprint covers EVERY field in the CRO-03 payload so that any evidence change
    // produces a new key → a new observation rather than a PAYLOAD_MISMATCH.
    const signalsTuples = sortedSignals.map(r => `${r.vendor}:${r.method}:${r.confidence}`).join("|");
    const contentFingerprint = createHash("sha256")
      .update([
        businessId,
        activeDomain,
        rdapOrgForKey,
        jsonldEmailCount,
        contactPageEmailCount,
        signalsTuples,
      ].join("::"))
      .digest("hex")
      .slice(0, 16);
    const cro03IdempotencyKey = `free-enrichment-business-${businessId}-${contentFingerprint}`;

    const { createCro03SourceBatch } = await import("./cro03/source-staging");
    await createCro03SourceBatch({
      idempotencyKey: cro03IdempotencyKey,
      actorType: "system",
      actorId: "free-enrichment-pipeline",
      purpose: "staging_review",
      subjects: [
        {
          subjectType: "business",
          subjectKey: String(businessId),
          sourceSystem: "free_enrichment",
          payload: {
            domain: activeDomain,
            rdapOrg: rdapOrgForKey || null,
            jsonldEmailCount,
            contactPageEmailCount,
          },
          provenance: { sourceSystem: "free_enrichment", stage: "rdap", observedAt: new Date().toISOString() },
          timestampProvenance: "ingestion_only",
        },
        ...(sortedSignals.length > 0 ? [{
          subjectType: "business" as const,
          subjectKey: String(businessId),
          sourceSystem: "html_processor_detection",
          payload: {
            domain: activeDomain,
            // Same sorted array used in fingerprint — order is canonical and deterministic.
            signals: sortedSignals.map(r => ({ vendor: r.vendor, method: r.method, confidence: r.confidence })),
          },
          provenance: { sourceSystem: "html_processor_detection", observedAt: new Date().toISOString() },
          timestampProvenance: "ingestion_only" as const,
        }] : []),
      ],
    });
    // CRO-03 succeeded — now it is safe to mark enriched
    finalStatus = "enriched";
    await _db.execute(_sql`
      UPDATE businesses
      SET free_enrichment_status = 'enriched',
          free_enrichment_completed_at = NOW(),
          free_enrichment_evidence = ${JSON.stringify(evidenceSummary)}::jsonb
      WHERE id = ${businessId}
    `);
    console.log(`[FreeEnrich-Business] Business ${businessId} enriched: ${JSON.stringify(evidenceSummary)}`);

  } catch (err: any) {
    lastErrorCode = err?.message?.slice(0, 200) ?? "UNKNOWN_ERROR";
    console.error(`[FreeEnrich-Business] Fatal error for business ${businessId}:`, err?.message);
    await _db.execute(_sql`
      UPDATE businesses
      SET free_enrichment_status = 'failed',
          free_enrichment_last_error_code = ${lastErrorCode}
      WHERE id = ${businessId}
    `);
    throw err; // Let BullMQ retry
  }
}

/**
 * One-off BullMQ job processor for statement blueprint/analysis.
 * Transitions deal analysisStatus: pending → processing → complete/failed.
 * Re-throws on error so BullMQ can retry up to the configured attempt limit.
 */
async function runStatementBlueprintJob(dealId: number): Promise<void> {
  await storage.updateDeal(dealId, { analysisStatus: "processing" }).catch(() => {});
  try {
    const { generateDealBlueprint } = await import("./deal-blueprint");
    await generateDealBlueprint(dealId);
    await storage.updateDeal(dealId, { analysisStatus: "complete" }).catch(() => {});
    console.log(`[Queue:enrichment] Statement blueprint complete for deal #${dealId}`);

    // NEW: structured analyzer runs after blueprint — non-fatal
    try {
      const { analyzeStatement } = await import("./statement-analyzer");
      await analyzeStatement(dealId);

      // Advance contact lifecycle to STATEMENT_ANALYZED and trigger NBA recompute
      const deal = await storage.getDeal(dealId);
      if (deal?.contactId) {
        const { onStatementAnalyzed } = await import("./statement-acquisition");
        onStatementAnalyzed(deal.contactId, dealId).catch(err =>
          console.warn(`[Queue:enrichment] onStatementAnalyzed failed for deal #${dealId}:`, err.message),
        );
      }
    } catch (analyzeErr: any) {
      console.error(`[Queue:enrichment] Structured analysis failed for deal #${dealId} (non-fatal):`, analyzeErr.message);
      storage.createAuditLog({
        action: "statement_analysis_failed",
        entityType: "deal",
        entityId: dealId,
        actorType: "system",
        details: { error: analyzeErr.message, timestamp: new Date().toISOString() },
      }).catch(() => {});
    }

    // Run underwriting engine after analysis completes (non-fatal)
    try {
      const { runUnderwritingEngine } = await import("./underwriting-engine");
      const deal = await storage.getDeal(dealId);
      if (deal) {
        const result = await runUnderwritingEngine({ deal });
        await storage.createUnderwritingDecision({
          dealId,
          decision: result.decision,
          score: result.score,
          reasons: result.reasons,
          rulesSnapshot: result.rulesSnapshot,
          decidedAt: new Date(),
        });

        await storage.createAuditLog({
          action: "underwriting_auto_decision",
          entityType: "deal",
          entityId: dealId,
          actorType: "system",
          details: {
            decision: result.decision,
            score: result.score,
            reasons: result.reasons,
            rulesSnapshot: result.rulesSnapshot,
            timestamp: new Date().toISOString(),
          },
        });

        if (result.decision === "approve") {
          const { advanceDealStage } = await import("./deal-stage-service");
          await advanceDealStage(dealId, "Proposal Sent", "underwriting_auto_approve");
          console.log(`[Underwriting] Deal #${dealId} auto-approved — advanced to Proposal Sent`);
        } else {
          // Hold or review: explicitly lock deal into Review In Progress
          const { advanceDealStage } = await import("./deal-stage-service");
          await advanceDealStage(dealId, "Review In Progress", "underwriting_flag");
          const title = result.decision === "hold"
            ? `Underwriting HOLD — Deal #${dealId} requires immediate review`
            : `Underwriting Review Required — Deal #${dealId}`;
          await storage.createNotification({
            channel: "internal",
            title,
            message: result.reasons[0] ?? "Deal flagged for manual review",
            type: "alert",
            metadata: {
              dealId,
              decision: result.decision,
              score: result.score,
              link: `/dashboard/underwriting`,
              eventType: "underwriting_flagged",
            },
          });
          console.log(`[Underwriting] Deal #${dealId} decision=${result.decision} score=${result.score}`);
        }
      }
    } catch (uwErr: any) {
      console.error(`[Underwriting] Engine failed for deal #${dealId} (non-fatal):`, uwErr.message);
    }
  } catch (err: any) {
    await storage.updateDeal(dealId, { analysisStatus: "failed" }).catch(() => {});
    throw err; // re-throw → BullMQ retries + dead-letter on exhaustion
  }
}

/**
 * Enqueue a one-off statement-blueprint job to the enrichment queue.
 * Returns the BullMQ job ID on success, or null if the queue is unavailable
 * (e.g. Redis not configured or QueueManager not yet initialised).
 */
export async function enqueueStatementAnalysis(dealId: number): Promise<string | null> {
  try {
    const qm = requireQueueManagerReady();
    const queue = qm.getQueue(QUEUE_NAMES.ENRICHMENT);
    if (!queue) return null;
    const job = await queue.add("statement-blueprint", { dealId }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      jobId: `statement-blueprint-${dealId}-${Date.now()}`,
    });
    console.log(`[Queue:enrichment] Enqueued statement-blueprint for deal #${dealId} → job ${job.id}`);
    return job.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Enqueue a one-off zerobounce-batch-validate job for a run (#1541).
 * Returns the BullMQ job ID, or null if the queue is unavailable
 * (Redis down / QueueManager not initialised) — callers must treat null as
 * a hard failure and mark the run interrupted; there is NO in-process fallback.
 */
export async function enqueueZeroBounceRun(runId: string): Promise<string | null> {
  try {
    const qm = requireQueueManagerReady();
    const queue = qm.getQueue(QUEUE_NAMES.ZEROBOUNCE_BATCH);
    if (!queue) return null;
    const job = await queue.add("run", { runId }, {
      attempts: 1,
      jobId: `zb-run-${runId}`,
    });
    console.log(`[Queue:zerobounce-batch-validate] Enqueued run ${runId} → job ${job.id}`);
    return job.id ?? null;
  } catch (err: any) {
    console.error(`[Queue:zerobounce-batch-validate] Failed to enqueue run ${runId}:`, err?.message ?? err);
    return null;
  }
}

async function runDiscoveryTick(): Promise<void> {
  const { runDailyOutreach } = await import("./daily-outreach");
  await runDailyOutreach();
}

async function runDigestsTick(): Promise<void> {
  const { checkAndSendDigests } = await import("./digest-service");
  await checkAndSendDigests();
}

async function runOnboardingReminderTick(): Promise<void> {
  const { runOnboardingReminderTick: tick } = await import("./onboarding-reminder");
  await tick();
}

async function runActivationMonitorTick(): Promise<void> {
  const { acquireJobLock, releaseJobLock, JOB_NAMES } = await import("./job-registry");
  // JOB_NAMES may not have ACTIVATION_MONITOR yet — use string directly as fallback
  const jobKey = (JOB_NAMES as any).ACTIVATION_MONITOR ?? "activation-monitor";
  const lease = await acquireJobLock(jobKey);
  if (lease.status !== "acquired") return;
  const lockToken = lease.lockToken;

  try {
    const { runActivationMonitor } = await import("./merchant-activation-monitor");
    const result = await runActivationMonitor();
    if (result.alerts > 0) {
      console.log(`[Queue:activation-monitor] ${result.alerts} unactivated MID alert(s) sent (${result.checked} checked)`);
    }
    await releaseJobLock(jobKey, true, undefined, lockToken);
  } catch (err: any) {
    await releaseJobLock(jobKey, false, err.message, lockToken);
    throw err;
  }
}

async function runMerchantSuccessTick(): Promise<void> {
  const { acquireJobLock, releaseJobLock } = await import("./job-registry");
  const jobKey = "merchant-success";
  const lease = await acquireJobLock(jobKey);
  if (lease.status !== "acquired") return;
  const lockToken = lease.lockToken;

  try {
    const { runMerchantSuccessSequences } = await import("./merchant-success-sequences");
    const result = await runMerchantSuccessSequences();
    if (result.enrolled > 0) {
      console.log(`[Queue:merchant-success] ${result.enrolled} enrollment(s) created across ${result.checked} activated MIDs`);
    }
    await releaseJobLock(jobKey, true, undefined, lockToken);
  } catch (err: any) {
    await releaseJobLock(jobKey, false, err.message, lockToken);
    throw err;
  }
}

async function runWinbackOutreachTick(): Promise<void> {
  const { acquireJobLock, releaseJobLock } = await import("./job-registry");
  const jobKey = "winback-outreach";
  const lease = await acquireJobLock(jobKey);
  if (lease.status !== "acquired") return;
  const lockToken = lease.lockToken;

  try {
    const { runWinbackOutreachEngine } = await import("./winback-outreach-engine");
    const result = await runWinbackOutreachEngine();
    if (result.sent > 0) {
      console.log(`[Queue:winback-outreach] sent=${result.sent} suppressed=${result.suppressed} errors=${result.errors}`);
    }
    await releaseJobLock(jobKey, true, undefined, lockToken);
  } catch (err: any) {
    await releaseJobLock(jobKey, false, err.message, lockToken);
    throw err;
  }
}

async function runMidIngestionTick(): Promise<void> {
  const { acquireJobLock, releaseJobLock, JOB_NAMES } = await import("./job-registry");
  const lease = await acquireJobLock(JOB_NAMES.MID_INGESTION);
  if (lease.status !== "acquired") return;
  const lockToken = lease.lockToken;

  try {
    // REV-05A: import from registry (not processor-api) — registry holds
    // #1737-domain functions and returns {held:true} until REV-06A certifies them.
    const { ingestMidDataForActiveMids } = await import("./processors/registry");
    const result = await ingestMidDataForActiveMids();
    if (result.held) {
      console.log("[Queue:mid-ingestion] held pending task #1737 (REV-06A) — skipped");
    } else if (result.processed > 0 || result.errors > 0) {
      console.log(`[Queue:mid-ingestion] ${result.processed} processed, ${result.errors} errors`);
    }
    await releaseJobLock(JOB_NAMES.MID_INGESTION, true, undefined, lockToken);
  } catch (err: any) {
    await releaseJobLock(JOB_NAMES.MID_INGESTION, false, err.message, lockToken);
    throw err;
  }

  // After ingestion succeeds: run attrition analysis to flag at-risk merchants.
  // Fire-and-forget — a failure here must never surface as a job failure that
  // triggers queue retries or blocks the next ingestion cycle.
  import("./merchant-attrition-monitor").then(({ runAttritionAnalysis }) =>
    runAttritionAnalysis()
  ).catch(e =>
    console.error("[Queue:mid-ingestion] Attrition analysis error (non-fatal):", e)
  );
}
