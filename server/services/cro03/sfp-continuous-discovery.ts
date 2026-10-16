/**
 * Continuous, restart-safe SFP paid-discovery + validation orchestrator.
 *
 * Closes the one real automation gap in the SFP pipeline: paid Serper
 * domain-discovery and ZeroBounce validation previously only ran via manual
 * admin "arm pilot" / execute calls (1-25 businesses at a time), and even
 * after being automated here, each tick call did exactly ONE bounded batch
 * (10 Serper lookups / 25 validations) and returned — with a 10-minute
 * repeat interval that made those small fixed batches the real throughput
 * throughput ceiling for the whole pipeline.
 *
 * Each exported tick function now DRAINS: it keeps taking bounded, safe,
 * idempotent batches back-to-back. Discovery selects current program/business
 * facts directly; historical cohorts remain supported only by their explicit
 * downstream consumers. No ordinary discovery tick freezes a cohort.
 * Draining continues until one of its own
 * stop conditions fires (provider health, or a
 * wall-clock time budget safely inside the
 * queue's own repeat interval and lock/lease durations). It invents no new
 * authority: every write still goes through provider enable/circuit controls,
 * identity quarantine, cooldown
 * exclusion, and the sfp_outreach_eligibility / ready_held boundary.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { sanitizeAuditPayload } from "../audit-sanitizer";
import {
  getProgramReadOnly,
  isSfpValidationPromotionEnabled,
} from "./south-florida-prospecting";
import { executeSfpSerperDiscovery, executeSfpPaidPersonAndIdentityDiscovery } from "./sfp-paid-waterfall";
import { previewSfpValidation, executeSfpValidation } from "./sfp-validation";
import { getSfpProviderReadiness } from "./sfp-provider-operations";
import { safeSfpFailureDiagnostics } from "./sfp-failure-diagnostics";
import { hasSfpValidationProgress, readIndependentSfpDiscoveryReadiness } from "./sfp-continuous-progress";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

// Per-call safety ceiling (matches the historical admin "arm pilot" ceiling
// at lead-ops.ts:3344 / the executeSfpSerperDiscovery internal cap of 25).
// This is NOT the tick's overall throughput — see the drain loops below,
// which call this repeatedly until a real stop condition fires.
const SERPER_BATCH_PER_CALL = 25;
// Outscraper/Apollo person+identity lookups stay at the prior per-call size.
const PERSON_IDENTITY_BATCH_PER_CALL = 10;
const VALIDATION_INTENTS_PER_TICK = 500;
const VALIDATION_PREFILTER_PER_TICK = 1000;
const VALIDATION_BATCH_PER_CALL = 25; // SFP_VALIDATION_MAX enforced again inside executeSfpValidation

// Wall-clock ceiling per tick invocation. Both continuous ticks repeat every
// 10 minutes (queue-manager.ts NAMED_QUEUE_SCHEDULES); this budget keeps a
// single tick well inside that window so a draining tick never overlaps the
// next scheduled invocation or outlives its own bounded lease.
const DRAIN_TIME_BUDGET_MS = 7 * 60 * 1000;
// Safety valve: even with a genuinely huge backlog and no provider pause,
// cap the number of provider calls a single tick will attempt so a runaway
// loop (e.g. a bug that keeps finding "eligible" work that never clears)
// cannot spin indefinitely inside the time budget.
const MAX_CALLS_PER_TICK = 200;
// Phase 1 (Serper) gets at most this much of the overall drain window. A
// large Serper backlog must never consume the whole tick and starve Phase 2
// (Outscraper/Apollo) — those providers are independently enabled
// on their own, and previously got zero real calls in production ticks
// where Serper alone filled DRAIN_TIME_BUDGET_MS. Phase 2 always gets the
// remainder of the overall window (DRAIN_TIME_BUDGET_MS - this, or more if
// Phase 1 finishes early), never less.
const PHASE1_TIME_BUDGET_MS = 4 * 60 * 1000;

function deadline(): number {
  return Date.now() + DRAIN_TIME_BUDGET_MS;
}

async function auditTick(action: string, outcome: string, details: Record<string, unknown>) {
  await db.execute(sql`
    INSERT INTO audit_logs (user_id, action, entity_type, entity_key, details, actor_type, actor_id)
    VALUES ('system', ${action}, 'sfp_program', 'south_florida_v2',
            ${JSON.stringify(sanitizeAuditPayload({ outcome, ...details }))}::jsonb, 'system', 'sfp-continuous-discovery')
  `).catch(() => {});
}

export interface SfpContinuousDiscoveryTickResult {
  ran: boolean;
  reason?: string;
  cohortRunIds?: string[];
  newlyFrozenCount?: number;
  calls?: number;
  providerRequests?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  noResult?: number;
  waterfallProcessed?: number;
  waterfallSucceeded?: number;
  waterfallFailed?: number;
  stopReason?: string;
  waterfallStopReason?: string;
  elapsedMs?: number;
}

/** Per-cohort stage-attempt keys persist in stage history, not the wall clock. */
async function nextStageAttemptKey(cohortRunId: string, stage: string, suffix: string): Promise<string> {
  const prior = rows(await db.execute(sql`
    SELECT COUNT(*)::bigint AS run_count
      FROM sfp_stage_runs WHERE cohort_run_id=${cohortRunId}::uuid AND stage=${stage}
  `))[0];
  return `sfp-continuous:${cohortRunId}:${suffix}:${Number(prior?.run_count ?? 0) + 1}`;
}

/** Ordinary discovery uses the current program and real business facts, not a
 * frozen cohort. All dispatch/settlement/recovery remains in the existing stage
 * and provider ledgers. Provider pauses are checked before selection or claims. */
export async function processSfpContinuousDiscoveryTick(): Promise<SfpContinuousDiscoveryTickResult> {
  const program=await getProgramReadOnly();
  if(!program?.isActive) return {ran:false,reason:"program_inactive"};
  const started=Date.now(),end=started+DRAIN_TIME_BUDGET_MS;
  let processed=0,succeeded=0,failed=0,noResult=0,providerRequests=0,calls=0;
  let waterfallProcessed=0,waterfallSucceeded=0,waterfallFailed=0;
  let stopReason="no_current_discovery_work",waterfallStopReason="no_current_person_identity_work";
  const key=async(suffix:string)=>{
    const count=rows(await db.execute(sql`SELECT count(*)::integer n FROM sfp_stage_runs
      WHERE program_id=${program.id}::uuid AND idempotency_key LIKE ${`sfp-program:${program.id}:${suffix}:%`}`))[0];
    return `sfp-program:${program.id}:${suffix}:${Number(count?.n ?? 0)+1}`;
  };
  const serperEnd=Math.min(end,started+PHASE1_TIME_BUDGET_MS);
  while(Date.now()<serperEnd && calls<MAX_CALLS_PER_TICK) {
    const readiness=await getSfpProviderReadiness("serper");
    if(!readiness.ready){stopReason=`provider_paused:${readiness.reason}`;break;}
    try {
      calls++;
      const result=await executeSfpSerperDiscovery({programId:program.id,
        idempotencyKey:await key("serper"),actorId:"system:sfp-continuous-discovery",
        maxBusinesses:SERPER_BATCH_PER_CALL});
      processed+=result.processed;succeeded+=result.succeeded;failed+=result.failed;
      noResult+=result.noResult ?? 0;providerRequests+=result.providerRequests ?? 0;
      if(!result.processed || !result.providerRequests) break;
      stopReason="drain_complete";
    } catch(error) {
      stopReason="discovery_failed";
      await auditTick("sfp_continuous_discovery_tick",stopReason,
        {programId:program.id,error:String((error as Error).message)});
      break;
    }
  }
  let waterfallCalls=0;
  while(Date.now()<end && waterfallCalls<MAX_CALLS_PER_TICK) {
    const readiness=await readIndependentSfpDiscoveryReadiness(getSfpProviderReadiness);
    const enabledProviders:Array<"outscraper"|"apollo">=[];
    if(readiness.outscraper.ready) enabledProviders.push("outscraper");
    if(readiness.apollo.ready) enabledProviders.push("apollo");
    if(!enabledProviders.length){waterfallStopReason="person_identity_providers_paused";break;}
    try {
      waterfallCalls++;
      const result=await executeSfpPaidPersonAndIdentityDiscovery({programId:program.id,
        idempotencyKey:await key("person-identity"),actorId:"system:sfp-continuous-discovery",
        maxBusinesses:PERSON_IDENTITY_BATCH_PER_CALL,includeSerperDiscovery:false,enabledProviders});
      waterfallProcessed+=result.processed;waterfallSucceeded+=result.succeeded;
      waterfallFailed+=result.failed;providerRequests+=result.providerRequests ?? 0;
      if(!result.processed || !result.providerRequests) break;
      waterfallStopReason="drain_complete";
    } catch(error) {
      waterfallStopReason="person_identity_failed";
      await auditTick("sfp_continuous_discovery_tick",waterfallStopReason,
        {programId:program.id,...safeSfpFailureDiagnostics(error)});
      break;
    }
  }
  if(Date.now()>=end) waterfallStopReason="time_budget_exhausted";
  const result={ran:true,cohortRunIds:[],newlyFrozenCount:0,calls:calls+waterfallCalls,
    processed,succeeded,failed,noResult,providerRequests,waterfallProcessed,waterfallSucceeded,
    waterfallFailed,stopReason,waterfallStopReason,elapsedMs:Date.now()-started};
  await auditTick("sfp_continuous_discovery_tick","program_drain_completed",{programId:program.id,...result});
  return result;
}

export interface SfpContinuousValidationTickResult {
  ran: boolean;
  reason?: string;
  cohortRunIds?: string[];
  calls?: number;
  addressesValidated?: number;
  providerRequests?: number;
  validCount?: number;
  stopReason?: string;
  elapsedMs?: number;
}

/** Recover the existing shared queue for current canonically prepared targets.
 * Queued work is not a completed validation or a provider request. */
export async function processSfpContinuousValidationTick(): Promise<SfpContinuousValidationTickResult> {
  // Free (no spend) DNS/syntax/disposable prefilter first, so the paid queue
  // below never selects dead domains and ranks MX-less domains last.
  try {
    const {runEmailPrefilterBatch}=await import("../email-prefilter");
    const prefilter=await runEmailPrefilterBatch(VALIDATION_PREFILTER_PER_TICK);
    await auditTick("sfp_continuous_validation_tick","email_prefilter_batch",prefilter);
  } catch(error) {
    await auditTick("sfp_continuous_validation_tick","email_prefilter_failed",
      {error:String((error as Error).message).slice(0,300)});
  }
  if (!(await isSfpValidationPromotionEnabled())) {
    return {ran:false,reason:"validation_promotion_disabled"};
  }
  // Only durable, currently prepared recipients enter the shared queue. Frozen
  // cohorts are historical provenance, never automatic validation admission.
  const {recoverValidationIntents}=await import("../provider-readiness-control");
  const queued=await recoverValidationIntents(VALIDATION_INTENTS_PER_TICK);
  await auditTick("sfp_continuous_validation_tick","canonical_selected_queue_recovered",{queued});
  return {ran:queued>0,calls:0,addressesValidated:0,providerRequests:0,validCount:0,
    cohortRunIds:[],stopReason:queued ? "canonical_selected_validation_queued" : "no_current_selected_validation"};
}

/** Historical implementation retained for protocol reference, not scheduling. */
async function processLegacyCohortValidationTick(): Promise<SfpContinuousValidationTickResult> {
  const program = await getProgramReadOnly();
  if (!program || !program.isActive) return { ran: false, reason: "program_inactive" };
  if (!(await isSfpValidationPromotionEnabled())) {
    return { ran: false, reason: "validation_promotion_disabled" };
  }

  const tickStartedAt = Date.now();
  const end = deadline();
  const cohortRunIds = new Set<string>();
  let calls = 0, addressesValidated = 0, providerRequests = 0, validCount = 0;
  let stopReason = "drain_complete";
  const exhaustedCohorts = new Set<string>();

  while (Date.now() < end && calls < MAX_CALLS_PER_TICK) {
    const readiness = await getSfpProviderReadiness("zerobounce");
    if (!readiness.ready) {
      stopReason = `provider_paused:${readiness.reason}`;
      await auditTick("sfp_continuous_validation_tick", "provider_paused", { reason: readiness.reason });
      break;
    }

    const candidatesAll = rows(await db.execute(sql`
      SELECT id FROM sfp_cohort_runs
       WHERE program_id = ${program.id}::uuid AND cohort_state='frozen'
         AND voided_at IS NULL AND superseded_at IS NULL AND cohort_size > 0
       ORDER BY COALESCE((SELECT MAX(s.last_heartbeat_at) FROM sfp_stage_runs s
                           WHERE s.cohort_run_id=sfp_cohort_runs.id AND s.stage='validation'),frozen_at) ASC,
                frozen_at ASC,id ASC
    `));
    const candidates = candidatesAll.filter((c: any) => !exhaustedCohorts.has(String(c.id)));
    if (candidates.length === 0) { stopReason = "no_cohort_with_validation_work"; break; }

    let madeProgressThisPass = false;
    for (const c of candidates) {
      if (Date.now() >= end || calls >= MAX_CALLS_PER_TICK) break;
      const cohortRunId = String(c.id);
      try {
        const { promoteRoutineSfpValidationCandidates } = await import("../free-discovery/evidence-service");
        const admission = await promoteRoutineSfpValidationCandidates(VALIDATION_BATCH_PER_CALL, cohortRunId);
        await auditTick("sfp_continuous_validation_admission", "admission_batch_completed", {
          cohortRunId, ...admission,
        });
        const preview = await previewSfpValidation(cohortRunId);
        if (!preview.gateOpen || preview.selectedCandidates.length === 0) {
          exhaustedCohorts.add(cohortRunId);
          continue;
        }
        calls++;
        const result = await executeSfpValidation(cohortRunId, {
          idempotencyKey: await nextStageAttemptKey(cohortRunId, "validation", "validate"),
          actorId: "system:sfp-continuous-discovery",
          maxValidations: VALIDATION_BATCH_PER_CALL,
          snapshotHash: preview.snapshotHash,
        });
        cohortRunIds.add(cohortRunId);
        addressesValidated += result.addressesValidated;
        providerRequests += result.providerRequests;
        validCount += result.validCount;
        const advanced = hasSfpValidationProgress(result);
        if (advanced) madeProgressThisPass = true;
        await auditTick("sfp_continuous_validation_tick", "validation_batch_completed", {
          cohortRunId, addressesValidated: result.addressesValidated, validCount: result.validCount,
          eligibilityRowsCreated: result.eligibilityRowsCreated,
          selectionAdvanced: advanced,
        });
        if (!advanced) exhaustedCohorts.add(cohortRunId);
      } catch (err: any) {
        await auditTick("sfp_continuous_validation_tick", "validation_failed", { cohortRunId, error: String(err?.message ?? err) });
        exhaustedCohorts.add(cohortRunId);
      }
    }
    if (!madeProgressThisPass) { stopReason = "no_cohort_with_validation_work"; break; }
  }

  if (Date.now() >= end) stopReason = "time_budget_exhausted";
  if (calls >= MAX_CALLS_PER_TICK) stopReason = "max_calls_per_tick_reached";

  const summary = {
    ran: calls > 0,
    cohortRunIds: [...cohortRunIds],
    calls, addressesValidated, providerRequests, validCount,
    stopReason,
    elapsedMs: Date.now() - tickStartedAt,
  };
  await auditTick("sfp_continuous_validation_tick", "drain_completed", summary);
  return summary;
}
