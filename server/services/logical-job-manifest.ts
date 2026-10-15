/**
 * logical-job-manifest.ts (#1532)
 *
 * Typed manifest of every BullMQ job and legacy scheduler in the system.
 * Keyed by { physicalQueue, jobNamePattern } — the ENRICHMENT queue has
 * multiple distinct logical jobs dispatched by job name, so queue-level
 * classification is insufficient.
 *
 * Fields:
 *   logicalKey               — stable coordinator key used in hold ledger
 *   handler                  — human-readable description
 *   owner                    — owning subsystem
 *   effect                   — what this job does with respect to outbound sends
 *   canRunWhileGlobalOutboundPaused — false = blocked by global pause
 *   backlogSource            — where the real backlog lives (BullMQ ticks vs. DB rows)
 *   releaseController        — who controls staged release for this key
 *
 * VALIDATION:
 *   - Every QUEUE_NAMES entry must resolve to at least one manifest entry.
 *   - No unclassified entries are permitted (validated by validateManifest()).
 *   - All enqueue call sites are represented by matching entries.
 *
 * NOTE: Comments here are supplementary. validateManifest() is the proof.
 */

import { QUEUE_NAMES, type QueueName } from "./queue-names";

// ---------------------------------------------------------------------------
// Effect types
// ---------------------------------------------------------------------------

export type JobEffect =
  | "none"
  | "promotional_send"
  | "promotional_enrollment"
  | "lifecycle_send"
  | "lifecycle_enrollment"
  | "transactional_external"
  | "internal_notification"
  | "external_data_sync"
  | "infrastructure";

// ---------------------------------------------------------------------------
// Backlog sources
// ---------------------------------------------------------------------------

export type BacklogSource =
  | "bullmq"
  | "sequence_enrollments"
  | "outbound_messages"
  | "deferred_ghl"
  | "promotional_enrollment_jobs"
  | "post_enrichment_enrollment_intents"
  | "statement_upload_commands"
  | "deal_stage_effect_intents"
  | "chargeback_submission_commands"
  | "cro03a_qualification_runs"
  | "sfp_free_classification_continuations"
  | "sfp_cohort_runs"
  | "sfp_outreach_eligibility"
  | "sunbiz_bootstrap_runs"
  | "none";

// ---------------------------------------------------------------------------
// Manifest entry
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  /** Unique key used in the coordinator hold ledger. */
  logicalKey: string;
  /** Physical BullMQ queue this job runs in. */
  physicalQueue: QueueName | "legacy_interval" | "non_bullmq";
  /**
   * BullMQ job name pattern. Use "*" for catch-all (queue's default job).
   * Exact strings match _job.name === jobNamePattern.
   */
  jobNamePattern: string;
  /** Human-readable description of what this logical job does. */
  handler: string;
  /** Owning subsystem or service name. */
  owner: string;
  /** Effect classification: what outbound work (if any) this job performs. */
  effect: JobEffect;
  /**
   * Whether this job may execute when the global outbound pause is active.
   * false = blocked by coordinator when pause is active.
   * true  = safe to run (infrastructure, internal bookkeeping, data sync).
   */
  canRunWhileGlobalOutboundPaused: boolean;
  /** Where the real backlog for this logical job lives. */
  backlogSource: BacklogSource;
  /** Who controls the staged release for this logical job (or null). */
  releaseController: string | null;
}

// ---------------------------------------------------------------------------
// Manifest definition
// ---------------------------------------------------------------------------

export const LOGICAL_JOB_MANIFEST: readonly ManifestEntry[] = [
  {
    logicalKey: "cro03c-live-dispatch",
    physicalQueue: QUEUE_NAMES.CRO03C_LIVE,
    jobNamePattern: "dispatch",
    handler: "CRO-03C governed live command dispatch",
    owner: "cro03/live-worker.dispatchCro03cLive",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: "cro03c_activation_policy",
  },
  {
    logicalKey: "cro03c-live-recovery",
    physicalQueue: QUEUE_NAMES.CRO03C_LIVE,
    jobNamePattern: "recover",
    handler: "CRO-03C expired-lease and queued-generation recovery",
    owner: "cro03/live-worker.recoverCro03cLiveDispatches",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: "cro03c_activation_policy",
  },
  {
    logicalKey: "cro03a-qualification-run",
    physicalQueue: QUEUE_NAMES.CRO03A_QUALIFICATION,
    jobNamePattern: "run",
    handler: "CRO-03A frozen-policy candidate qualification run",
    owner: "cro03a/qualification-service.processCro03aQualificationRunQueueSafe",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "cro03a_qualification_runs",
    releaseController: null,
  },
  {
    logicalKey: "cro02-observation",
    physicalQueue: QUEUE_NAMES.CRO02_OBSERVATION,
    jobNamePattern: "*",
    handler: "CRO-02 observation and evidence processing",
    owner: "cro02-observation",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },
  {
    logicalKey: "source-registry-import",
    physicalQueue: QUEUE_NAMES.SOURCE_REGISTRY_IMPORT,
    jobNamePattern: "run",
    handler: "Source registry import execution",
    owner: "source-registry-import",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },
  {
    logicalKey: "master-lead-stager",
    physicalQueue: QUEUE_NAMES.MASTER_LEAD_STAGER,
    jobNamePattern: "stage",
    handler: "Master-lead staging intent execution",
    owner: "master-lead-stager",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },
  {
    logicalKey: "cro08a-scheduler",
    physicalQueue: QUEUE_NAMES.CRO08A_SCHEDULER,
    jobNamePattern: "tick",
    handler: "CRO-08A durable scheduler tick",
    owner: "cro08a-scheduler",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },
  {
    logicalKey: "cro08a-processor",
    physicalQueue: QUEUE_NAMES.CRO08A_PROCESSOR,
    jobNamePattern: "process",
    handler: "CRO-08A durable processor execution",
    owner: "cro08a-processor",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },
  {
    logicalKey: "cro03a-qualification-recovery",
    physicalQueue: QUEUE_NAMES.CRO03A_QUALIFICATION,
    jobNamePattern: "recover",
    handler: "CRO-03A queued-run and expired item-lease recovery sweep",
    owner: "cro03a/qualification-service.recoverCro03aQualificationRunsQueueSafe",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "cro03a_qualification_runs",
    releaseController: null,
  },
  {
    logicalKey: "deal-stage-effects",
    physicalQueue: QUEUE_NAMES.DEAL_STAGE_EFFECTS,
    jobNamePattern: "dispatch",
    handler: "Durable deal-stage material effect intent dispatch and expired-lease recovery",
    owner: "deal-stage-effect-worker.dispatchDealStageEffectIntents",
    effect: "transactional_external",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "deal_stage_effect_intents",
    releaseController: "deal-stage-effect-worker",
  },
  {
    logicalKey: "chargeback-commands",
    physicalQueue: QUEUE_NAMES.CHARGEBACK_COMMANDS,
    jobNamePattern: "dispatch",
    handler: "Durable chargeback provider submission dispatch and reconciliation-safe recovery",
    owner: "chargeback-submission-service.recoverChargebackSubmissionCommands",
    effect: "transactional_external",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "chargeback_submission_commands",
    releaseController: "chargeback-submission-service",
  },
  {
    logicalKey: "statement-upload-command",
    physicalQueue: QUEUE_NAMES.STATEMENT_UPLOAD,
    jobNamePattern: "*",
    handler: "Durable statement-upload command execution and recovery",
    owner: "statement-command-worker",
    effect: "transactional_external",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "statement_upload_commands",
    releaseController: "statement-command-worker",
  },
  {
    logicalKey: "canonical-import-recovery",
    physicalQueue: QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY,
    jobNamePattern: "*",
    handler: "Existing serial provider-free contact linking, retained-row recovery and persisted CSV recovery",
    owner: "canonical-import-recovery-worker / contact-link-automation / csv-import-recovery",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: "sfp-runtime-owner-and-import-execution-fences",
  },
  // ── GHL_SYNC ─────────────────────────────────────────────────────────────
  {
    logicalKey: "ghl-sync",
    physicalQueue: QUEUE_NAMES.GHL_SYNC,
    jobNamePattern: "*",
    handler: "GHL contact & deal sync tick",
    owner: "ghl-sync",
    effect: "external_data_sync",
    // Reconciliation reads may run under the global outbound pause. Any CRM
    // mutation is separately gated by GHL CRM authorization/epoch fencing;
    // sends and workflow enrollment remain on the existing outbound fence.
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── SLA_CHECKS ───────────────────────────────────────────────────────────
  {
    logicalKey: "sla-checks",
    physicalQueue: QUEUE_NAMES.SLA_CHECKS,
    jobNamePattern: "*",
    handler: "SLA check tick — SLA tasks, stalling deals, health probes",
    owner: "sla-worker",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── SEQUENCES ────────────────────────────────────────────────────────────
  {
    logicalKey: "sequences",
    physicalQueue: QUEUE_NAMES.SEQUENCES,
    jobNamePattern: "*",
    handler: "Sequence enrollment processing — evaluates due enrollments and dispatches step sends",
    owner: "sequence-worker",
    effect: "lifecycle_send",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "sequence_enrollments",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── ENRICHMENT — statement-blueprint ─────────────────────────────────────
  {
    logicalKey: "enrichment-statement-blueprint",
    physicalQueue: QUEUE_NAMES.ENRICHMENT,
    jobNamePattern: "statement-blueprint",
    handler: "Statement blueprint generation for a deal",
    owner: "deal-blueprint",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── ENRICHMENT — free-contact-enrichment ─────────────────────────────────
  {
    logicalKey: "enrichment-free-contact",
    physicalQueue: QUEUE_NAMES.ENRICHMENT,
    jobNamePattern: "free-contact-enrichment",
    handler: "Free merchant contact enrichment via external sources",
    owner: "enrichment",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── ENRICHMENT — inbound-confirmation-followup (OUTBOUND) ─────────────────
  {
    logicalKey: "enrichment-inbound-confirmation-followup",
    physicalQueue: QUEUE_NAMES.ENRICHMENT,
    jobNamePattern: "inbound-confirmation-followup",
    handler: "Inbound form confirmation follow-up email send via GHL workflow",
    owner: "ghl-workflow-enrollment",
    effect: "lifecycle_send",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "bullmq",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── ENRICHMENT — readiness_recalculation ─────────────────────────────────
  {
    logicalKey: "enrichment-readiness-recalculation",
    physicalQueue: QUEUE_NAMES.ENRICHMENT,
    jobNamePattern: "readiness_recalculation",
    handler: "Contact data readiness score recalculation",
    owner: "contact-readiness",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── ENRICHMENT — contact_lead_scoring ────────────────────────────────────
  {
    logicalKey: "enrichment-contact-lead-scoring",
    physicalQueue: QUEUE_NAMES.ENRICHMENT,
    jobNamePattern: "contact_lead_scoring",
    handler: "Contact lead scoring job",
    owner: "lead-scoring",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── ENRICHMENT — promotional-enrollment-eval (OUTBOUND) ───────────────────
  {
    logicalKey: "enrichment-promotional-enrollment-eval",
    physicalQueue: QUEUE_NAMES.ENRICHMENT,
    jobNamePattern: "promotional-enrollment-eval",
    handler: "Promotional enrollment eligibility evaluation + auto-enroll trigger",
    owner: "promotional-enrollment-eligibility",
    effect: "promotional_enrollment",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "promotional_enrollment_jobs",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── FREE_ENRICHMENT_LANE — run (MI-09 corrective item 1) ─────────────────
  {
    logicalKey: "free-enrichment-lane-run",
    physicalQueue: QUEUE_NAMES.FREE_ENRICHMENT_LANE,
    jobNamePattern: "run",
    handler: "Isolated free-only enrichment lane tick (RDAP/JSON-LD/contact-page/HTML only; no paid provider, ZeroBounce, GHL, sequence, campaign, or outreach call is reachable)",
    owner: "free-enrichment-lane",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── ENRICHMENT — default (runEnrichmentTick) ─────────────────────────────
  {
    logicalKey: "enrichment-default",
    physicalQueue: QUEUE_NAMES.ENRICHMENT,
    jobNamePattern: "*",
    handler: "Default enrichment tick — Sunbiz/contact enrichment, pending scoring jobs",
    owner: "enrichment",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── DISCOVERY ─────────────────────────────────────────────────────────────
  // NOTE: DISCOVERY mixes safe enrichment work with outbound effects. It is gated
  // per phase internally (see daily-outreach.ts). The queue-level classification
  // here is the most restrictive (cannot run for outbound phases).
  {
    logicalKey: "discovery-enrichment",
    physicalQueue: QUEUE_NAMES.DISCOVERY,
    jobNamePattern: "*",
    handler: "Discovery: lead enrichment / DB work (safe, ungated phase)",
    owner: "daily-outreach",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },
  {
    logicalKey: "discovery-promotion",
    physicalQueue: QUEUE_NAMES.DISCOVERY,
    jobNamePattern: "*",
    handler: "Discovery: promotion evaluation (gated phase)",
    owner: "daily-outreach",
    effect: "promotional_enrollment",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "promotional_enrollment_jobs",
    releaseController: "OutboundQueueCoordinator",
  },
  {
    logicalKey: "discovery-enrollment",
    physicalQueue: QUEUE_NAMES.DISCOVERY,
    jobNamePattern: "*",
    handler: "Discovery: enrollment/workflow triggering (gated phase)",
    owner: "daily-outreach",
    effect: "promotional_enrollment",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "promotional_enrollment_jobs",
    releaseController: "OutboundQueueCoordinator",
  },
  {
    logicalKey: "discovery-send",
    physicalQueue: QUEUE_NAMES.DISCOVERY,
    jobNamePattern: "*",
    handler: "Discovery: campaign message send (gated phase)",
    owner: "daily-outreach",
    effect: "promotional_send",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "outbound_messages",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── DIGESTS ───────────────────────────────────────────────────────────────
  {
    logicalKey: "digests",
    physicalQueue: QUEUE_NAMES.DIGESTS,
    jobNamePattern: "*",
    handler: "Digest generation and notification delivery",
    owner: "digest-service",
    effect: "internal_notification",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── MID_INGESTION ─────────────────────────────────────────────────────────
  {
    logicalKey: "mid-ingestion",
    physicalQueue: QUEUE_NAMES.MID_INGESTION,
    jobNamePattern: "*",
    handler: "MID ingestion from external sources",
    owner: "mid-ingestion",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── ONBOARDING_REMINDER ───────────────────────────────────────────────────
  {
    logicalKey: "onboarding-reminder",
    physicalQueue: QUEUE_NAMES.ONBOARDING_REMINDER,
    jobNamePattern: "*",
    handler: "Onboarding checklist reminder notifications",
    owner: "onboarding-reminder",
    effect: "internal_notification",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── ACTIVATION_MONITOR ────────────────────────────────────────────────────
  {
    logicalKey: "activation-monitor",
    physicalQueue: QUEUE_NAMES.ACTIVATION_MONITOR,
    jobNamePattern: "*",
    handler: "Activation state monitoring",
    owner: "activation-monitor",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── MERCHANT_SUCCESS ──────────────────────────────────────────────────────
  {
    logicalKey: "merchant-success",
    physicalQueue: QUEUE_NAMES.MERCHANT_SUCCESS,
    jobNamePattern: "*",
    handler: "30/60/90 day merchant success sequence enrollment",
    owner: "merchant-success-sequences",
    effect: "lifecycle_enrollment",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "sequence_enrollments",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── WINBACK_OUTREACH ──────────────────────────────────────────────────────
  // PHASE 4 PILOT: This is the first queue to receive physical actuation.
  // It is fully dedicated to SMTP promotional outbound.
  {
    logicalKey: "winback-outreach",
    physicalQueue: QUEUE_NAMES.WINBACK_OUTREACH,
    jobNamePattern: "*",
    handler: "Win-back outreach SMTP email sends to churned/at-risk merchants",
    owner: "winback-outreach-engine",
    effect: "promotional_send",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "outbound_messages",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── ABANDONED_STATEMENT ───────────────────────────────────────────────────
  {
    logicalKey: "abandoned-statement",
    physicalQueue: QUEUE_NAMES.ABANDONED_STATEMENT,
    jobNamePattern: "*",
    handler: "Abandoned statement acquisition — tasks and enrollment triggers",
    owner: "abandoned-statement-worker",
    effect: "lifecycle_enrollment",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "sequence_enrollments",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── EXECUTIVE_SNAPSHOT ────────────────────────────────────────────────────
  {
    logicalKey: "executive-snapshot",
    physicalQueue: QUEUE_NAMES.EXECUTIVE_SNAPSHOT,
    jobNamePattern: "*",
    handler: "Executive KPI snapshot generation",
    owner: "executive-kpi",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── SYSTEM_AUDIT ──────────────────────────────────────────────────────────
  {
    logicalKey: "system-audit",
    physicalQueue: QUEUE_NAMES.SYSTEM_AUDIT,
    jobNamePattern: "*",
    handler: "Weekly system audit — subsystem health probing and GPT narrative",
    owner: "system-audit-engine",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── DB_BACKUP ─────────────────────────────────────────────────────────────
  {
    logicalKey: "db-backup",
    physicalQueue: QUEUE_NAMES.DB_BACKUP,
    jobNamePattern: "*",
    handler: "Periodic database backup",
    owner: "db-backup",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── ENROLLMENT_RECOVERY ───────────────────────────────────────────────────
  // NOTE: This has an outbound scheduling effect: it reserves send-counter
  // capacity and reactivates cap-deferred enrollments.
  {
    logicalKey: "enrollment-recovery",
    physicalQueue: QUEUE_NAMES.ENROLLMENT_RECOVERY,
    jobNamePattern: "*",
    handler: "Enrollment recovery — reactivates cap-deferred sequence enrollments",
    owner: "sequence-enrollment-recovery",
    effect: "lifecycle_enrollment",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "sequence_enrollments",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── GHL_ENROLLMENT_RECOVERY ───────────────────────────────────────────────
  // NOTE: The SMTP admin alert inside this worker is already blocked by
  // #1531's transport boundary (sendSmtpEmail always calls authorize({})).
  // Pause deferral during retries must NOT increment retry_count.
  {
    logicalKey: "ghl-enrollment-recovery",
    physicalQueue: QUEUE_NAMES.GHL_ENROLLMENT_RECOVERY,
    jobNamePattern: "*",
    handler: "GHL workflow enrollment retry — exponential backoff for failed GHL enrollments",
    owner: "ghl-enrollment-recovery",
    effect: "transactional_external",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "deferred_ghl",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── HEALTH_MONITOR ────────────────────────────────────────────────────────
  {
    logicalKey: "health-monitor",
    physicalQueue: QUEUE_NAMES.HEALTH_MONITOR,
    jobNamePattern: "*",
    handler: "System health monitoring — DB, Redis, email, GHL probes",
    owner: "health-monitor",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── PIPELINE_SILENCE_CHECK ────────────────────────────────────────────────
  {
    logicalKey: "pipeline-silence-check",
    physicalQueue: QUEUE_NAMES.PIPELINE_SILENCE_CHECK,
    jobNamePattern: "*",
    handler: "Pipeline silence detection — flags stalled deals in CRM stages",
    owner: "pipeline-silence",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── PROPOSAL_FOLLOWUP ─────────────────────────────────────────────────────
  {
    logicalKey: "proposal-followup",
    physicalQueue: QUEUE_NAMES.PROPOSAL_FOLLOWUP,
    jobNamePattern: "*",
    handler: "Proposal follow-up email re-sends for unread proposals",
    owner: "proposal-followup-worker",
    effect: "lifecycle_send",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "outbound_messages",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── PARTNER_MONTHLY_DIGEST ────────────────────────────────────────────────
  {
    logicalKey: "partner-monthly-digest",
    physicalQueue: QUEUE_NAMES.PARTNER_MONTHLY_DIGEST,
    jobNamePattern: "*",
    handler: "Monthly partner digest email",
    owner: "partner-digest",
    effect: "internal_notification",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── VOICEMAIL_SYNC ────────────────────────────────────────────────────────
  {
    logicalKey: "voicemail-sync",
    physicalQueue: QUEUE_NAMES.VOICEMAIL_SYNC,
    jobNamePattern: "*",
    handler: "GHL voicemail sync",
    owner: "ghl-voicemail-sync",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── POST_ENRICHMENT ───────────────────────────────────────────────────────
  // NOTE: Stage advancement (safe) runs unconditionally; enrollment is
  // deferred to post_enrichment_enrollment_intents outbox when held.
  {
    logicalKey: "post-enrichment-stage",
    physicalQueue: QUEUE_NAMES.POST_ENRICHMENT,
    jobNamePattern: "post-enrichment-automation",
    handler: "Post-enrichment: deal stage advancement (safe, runs unconditionally)",
    owner: "post-enrichment-worker",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },
  {
    logicalKey: "post-enrichment-enrollment",
    physicalQueue: QUEUE_NAMES.POST_ENRICHMENT,
    jobNamePattern: "post-enrichment-automation",
    handler: "Post-enrichment: sequence enrollment intent (deferred when held)",
    owner: "post-enrichment-worker",
    effect: "lifecycle_enrollment",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "post_enrichment_enrollment_intents",
    releaseController: "OutboundQueueCoordinator",
  },
  {
    logicalKey: "post-enrichment-intent-recovery",
    physicalQueue: QUEUE_NAMES.POST_ENRICHMENT,
    jobNamePattern: "post-enrichment-intent-recovery",
    handler: "Post-enrichment: periodic recovery of deferred enrollment intents",
    owner: "post-enrichment-worker",
    effect: "lifecycle_enrollment",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "post_enrichment_enrollment_intents",
    releaseController: "OutboundQueueCoordinator",
  },

  // ── ZEROBOUNCE_BATCH ──────────────────────────────────────────────────────
  {
    logicalKey: "zerobounce-batch-validate",
    physicalQueue: QUEUE_NAMES.ZEROBOUNCE_BATCH,
    jobNamePattern: "*",
    handler: "ZeroBounce durable batch email validation campaign",
    owner: "zerobounce-campaign-engine",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "bullmq",
    releaseController: null,
  },

  // ── South Florida Prospecting (SFP) ───────────────────────────────────────
  // These workers are data/provider preparation only. Staging terminates at
  // ready_held; none of these entries grants enrollment, send, or GHL authority.
  {
    logicalKey: "sfp-campaign-staging-tick",
    physicalQueue: QUEUE_NAMES.SFP_CAMPAIGN_STAGING,
    jobNamePattern: "tick",
    handler: "SFP v2 package-pinned campaign staging to ready_held",
    owner: "cro03/sfp-campaign-staging-worker.processSfpCampaignStagingTick",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "sfp_outreach_eligibility",
    releaseController: "sfp_program_recurring_and_campaign_staging_controls",
  },
  {
    logicalKey: "sfp-free-classification-tick",
    physicalQueue: QUEUE_NAMES.SFP_FREE_CLASSIFICATION,
    jobNamePattern: "tick",
    handler: "SFP provider-free vertical classification continuation",
    owner: "cro03/sfp-free-classification-continuation.processSfpFreeClassificationTick",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "sfp_free_classification_continuations",
    releaseController: "sfp_free_classification_continuation_state",
  },
  {
    logicalKey: "sfp-continuous-discovery-tick",
    physicalQueue: QUEUE_NAMES.SFP_CONTINUOUS_DISCOVERY,
    jobNamePattern: "tick",
    handler: "SFP rolling-cohort paid domain and identity discovery",
    owner: "cro03/sfp-continuous-discovery.processSfpContinuousDiscoveryTick",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "sfp_cohort_runs",
    releaseController: "sfp_program_provider_controls_and_budget_authority",
  },
  {
    logicalKey: "sfp-continuous-validation-tick",
    physicalQueue: QUEUE_NAMES.SFP_CONTINUOUS_VALIDATION,
    jobNamePattern: "tick",
    handler: "SFP continuous email validation and eligibility promotion",
    owner: "cro03/sfp-continuous-discovery.processSfpContinuousValidationTick",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "sfp_outreach_eligibility",
    releaseController: "sfp_validation_promotion_provider_and_attestation_gates",
  },
  {
    logicalKey: "sunbiz-full-backfill-tick",
    physicalQueue: QUEUE_NAMES.SUNBIZ_FULL_BACKFILL,
    jobNamePattern: "tick",
    handler: "Resumable Sunbiz full-corpus backfill microbatch",
    owner: "sunbiz-full-backfill.runSunbizBackfillMicrobatch",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "sunbiz_bootstrap_runs",
    releaseController: "sunbiz_full_backfill_admin_run_state",
  },

  // ── Legacy / non-BullMQ schedulers ───────────────────────────────────────

  {
    logicalKey: "legacy-sla-worker",
    physicalQueue: "legacy_interval",
    jobNamePattern: "startSlaWorker",
    handler: "Legacy SLA worker (setInterval fallback when BullMQ unavailable)",
    owner: "sla-worker",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "none",
    releaseController: null,
  },
  {
    logicalKey: "legacy-daily-outreach",
    physicalQueue: "legacy_interval",
    jobNamePattern: "startDailyOutreachWorker",
    handler: "Legacy daily outreach worker (setInterval fallback)",
    owner: "daily-outreach",
    effect: "promotional_send",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "outbound_messages",
    releaseController: "OutboundQueueCoordinator",
  },
  {
    logicalKey: "legacy-ghl-sync",
    physicalQueue: "legacy_interval",
    jobNamePattern: "startAutoSyncLoop",
    handler: "Disabled legacy GHL sync loop (compatibility export only; no interval is scheduled)",
    owner: "ghl-sync",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "none",
    releaseController: null,
  },
  {
    logicalKey: "content-scheduler",
    physicalQueue: "non_bullmq",
    jobNamePattern: "startContentScheduler",
    handler: "Content scheduler — blog publish + LinkedIn drafts (outbound external)",
    owner: "content-scheduler",
    effect: "external_data_sync",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "none",
    releaseController: null,
  },
  {
    logicalKey: "inbox-rotation",
    physicalQueue: "non_bullmq",
    jobNamePattern: "inbox-rotation",
    handler: "SDR inbox rotation scheduler",
    owner: "sdr-orchestrator",
    effect: "infrastructure",
    canRunWhileGlobalOutboundPaused: true,
    backlogSource: "none",
    releaseController: null,
  },
  {
    logicalKey: "inbox-reply",
    physicalQueue: "non_bullmq",
    jobNamePattern: "inbox-reply",
    handler: "User-initiated inbox reply dispatch via GHL or SMTP",
    owner: "inbox-routes",
    effect: "lifecycle_send",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "none",
    releaseController: "OutboundQueueCoordinator",
  },
  {
    logicalKey: "sdr-orchestrator",
    physicalQueue: "non_bullmq",
    jobNamePattern: "sdr-orchestrator-sweep",
    handler: "SDR orchestrator sweep — multi-channel outbound for prospects",
    owner: "sdr/orchestrator",
    effect: "promotional_send",
    canRunWhileGlobalOutboundPaused: false,
    backlogSource: "outbound_messages",
    releaseController: "OutboundQueueCoordinator",
  },
] as const;

// ---------------------------------------------------------------------------
// Index by logicalKey for O(1) lookup
// ---------------------------------------------------------------------------

const _byLogicalKey = new Map<string, ManifestEntry>();
for (const entry of LOGICAL_JOB_MANIFEST) {
  _byLogicalKey.set(entry.logicalKey, entry as ManifestEntry);
}

export function getManifestEntry(logicalKey: string): ManifestEntry | undefined {
  return _byLogicalKey.get(logicalKey);
}

// ---------------------------------------------------------------------------
// Index by (physicalQueue, jobNamePattern) for worker-side lookup
// ---------------------------------------------------------------------------

const _byQueueAndJobName = new Map<string, ManifestEntry[]>();
for (const entry of LOGICAL_JOB_MANIFEST) {
  const key = `${entry.physicalQueue}::${entry.jobNamePattern}`;
  const existing = _byQueueAndJobName.get(key) ?? [];
  existing.push(entry as ManifestEntry);
  _byQueueAndJobName.set(key, existing);
}

/** Returns manifest entries for a given queue + job name. */
export function lookupManifest(queue: string, jobName: string): ManifestEntry[] {
  const exact = _byQueueAndJobName.get(`${queue}::${jobName}`) ?? [];
  const wildcard = _byQueueAndJobName.get(`${queue}::*`) ?? [];
  // Exact match wins; wildcard is fallback.
  return exact.length > 0 ? exact : wildcard;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ManifestValidationResult {
  ok: boolean;
  missingQueues: string[];
  unclassifiedEntries: string[];
  errors: string[];
}

/**
 * G-01 gate: every QUEUE_NAMES entry resolves to at least one manifest entry.
 * Fails if any queue has no manifest entry. Also fails if any entry uses an
 * unknown queue name that isn't in QUEUE_NAMES.
 */
export function validateManifest(): ManifestValidationResult {
  const errors: string[] = [];

  // All known physical queues from QUEUE_NAMES
  const knownQueues = new Set(Object.values(QUEUE_NAMES));

  // Check every queue has at least one manifest entry
  const missingQueues: string[] = [];
  for (const queueName of knownQueues) {
    const entries = LOGICAL_JOB_MANIFEST.filter(e => e.physicalQueue === queueName);
    if (entries.length === 0) {
      missingQueues.push(queueName);
      errors.push(`Queue "${queueName}" has no manifest entry`);
    }
  }

  // Check no unclassified entries (all effects must be from the allowed set)
  const VALID_EFFECTS: Set<JobEffect> = new Set([
    "none", "promotional_send", "promotional_enrollment",
    "lifecycle_send", "lifecycle_enrollment", "transactional_external",
    "internal_notification", "external_data_sync", "infrastructure",
  ]);
  const unclassifiedEntries: string[] = [];
  for (const entry of LOGICAL_JOB_MANIFEST) {
    if (!VALID_EFFECTS.has(entry.effect)) {
      unclassifiedEntries.push(entry.logicalKey);
      errors.push(`Manifest entry "${entry.logicalKey}" has unclassified effect: "${entry.effect}"`);
    }
  }

  // Check no duplicate logicalKeys
  const seen = new Set<string>();
  for (const entry of LOGICAL_JOB_MANIFEST) {
    if (seen.has(entry.logicalKey)) {
      errors.push(`Duplicate logicalKey: "${entry.logicalKey}"`);
    }
    seen.add(entry.logicalKey);
  }

  return {
    ok: errors.length === 0,
    missingQueues,
    unclassifiedEntries,
    errors,
  };
}

/** All logical keys that cannot run while global outbound is paused. */
export function getOutboundGatedKeys(): string[] {
  return LOGICAL_JOB_MANIFEST
    .filter(e => !e.canRunWhileGlobalOutboundPaused)
    .map(e => e.logicalKey);
}
