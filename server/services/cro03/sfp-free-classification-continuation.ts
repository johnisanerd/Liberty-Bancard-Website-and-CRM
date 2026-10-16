/** Restart-safe SFP Phase A continuation. One tick advances a bounded
 * 25-business watermark. The deterministic pass is always provider-free;
 * unresolved verticals are separately retried only through the existing,
 * authorized OpenAI SFP adapter. No contact, enrollment, campaign, or send
 * path is reachable here. */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { CLASSIFIER_VERSION } from "./sfp-vertical-classifier";
import { runPreCohortClassificationBridge } from "./sfp-classification-bridge";
import { getSfpProviderReadiness } from "./sfp-provider-operations";
import { resolveGeographyForBusiness } from "./sfp-geography-resolver";

const rows = (r: any): any[] => r?.rows ?? r ?? [];
/** Per-tick follow-up work (geography re-checks) stays small. */
const RUN_LIMIT = 25;
/** Free, provider-less watermark window per bridge run. */
const WINDOW_LIMIT = 500;
/** OpenAI escalations per tick (paid). */
const ESCALATION_LIMIT = 200;

export async function getSfpFreeClassificationContinuation(programId: string) {
  return rows(await db.execute(sql`
    SELECT * FROM sfp_free_classification_continuations
     WHERE program_id=${programId}::uuid
  `))[0] ?? null;
}

/** Start a bounded pass for explicit operator use. The scheduled worker also
 * opens/reopens passes automatically for the active SFP v2 program. */
export async function startSfpFreeClassificationContinuation(programId: string) {
  const program = rows(await db.execute(sql`
    SELECT id,policy_version,taxonomy_version,is_active FROM sfp_programs
     WHERE id=${programId}::uuid
  `))[0];
  if (!program || !program.is_active || Number(program.taxonomy_version) !== 2) {
    throw new Error("SFP_FREE_CONTINUATION_REQUIRES_ACTIVE_V2_PROGRAM");
  }
  const existing = await getSfpFreeClassificationContinuation(programId);
  if (existing?.state === "running" && existing.lease_expires_at &&
      new Date(existing.lease_expires_at).getTime() > Date.now()) {
    throw new Error("SFP_FREE_CONTINUATION_TICK_ACTIVE");
  }
  if (existing?.state === "running" || existing?.state === "paused") {
    if (Number(existing.policy_version) !== Number(program.policy_version) ||
        Number(existing.taxonomy_version) !== 2 || Number(existing.classifier_version) !== CLASSIFIER_VERSION) {
      throw new Error("SFP_FREE_CONTINUATION_POLICY_CHANGED_RESTART_REQUIRED");
    }
    return rows(await db.execute(sql`
      UPDATE sfp_free_classification_continuations
         SET state='running',last_error=NULL,updated_at=NOW()
       WHERE program_id=${programId}::uuid AND (state='paused' OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at<NOW())))
       RETURNING *
    `))[0] ?? existing;
  }
  // The upper bound is pinned for this pass so ongoing Sunbiz ingestion
  // cannot keep moving the finish line. The worker advances the watermark
  // automatically after completion.
  const started = rows(await db.execute(sql`
    INSERT INTO sfp_free_classification_continuations
      (program_id,state,high_water_business_id,stop_business_id,policy_version,taxonomy_version,classifier_version,
       scanned_count,processed_count,target_count,rejected_count,lease_token,lease_expires_at,last_error,last_tick_at,started_at,updated_at)
     VALUES (${programId}::uuid,'running',0,(SELECT COALESCE(MAX(id),0) FROM businesses WHERE record_class='canonical'),
            ${Number(program.policy_version)},2,${CLASSIFIER_VERSION},0,0,0,0,NULL,NULL,NULL,NULL,NOW(),NOW())
    ON CONFLICT (program_id) DO UPDATE SET
        state='running',high_water_business_id=0,stop_business_id=EXCLUDED.stop_business_id,
       policy_version=EXCLUDED.policy_version,taxonomy_version=2,classifier_version=${CLASSIFIER_VERSION},
       scanned_count=0,processed_count=0,target_count=0,rejected_count=0,
       lease_token=NULL,lease_expires_at=NULL,last_error=NULL,last_tick_at=NULL,started_at=NOW(),updated_at=NOW()
       WHERE sfp_free_classification_continuations.state IN ('idle','completed')
    RETURNING *
  `))[0];
  return started ?? await getSfpFreeClassificationContinuation(programId);
}

export async function pauseSfpFreeClassificationContinuation(programId: string) {
  return rows(await db.execute(sql`
    UPDATE sfp_free_classification_continuations SET state='paused',updated_at=NOW()
     WHERE program_id=${programId}::uuid AND state='running' RETURNING *
  `))[0] ?? await getSfpFreeClassificationContinuation(programId);
}

async function getAutomaticSfpProgram() {
  return rows(await db.execute(sql`
    SELECT id,policy_version,taxonomy_version,is_active,vertical_ids
      FROM sfp_programs WHERE name='south-florida-v1' AND is_active=TRUE
        AND taxonomy_version=2
      ORDER BY created_at DESC LIMIT 1
  `))[0];
}

async function ensureAutomaticSfpPass(program: any): Promise<void> {
  if (!program) return;
  const programId = String(program.id);
  const existing = await getSfpFreeClassificationContinuation(programId);
  if (!existing) {
    await startSfpFreeClassificationContinuation(programId);
    return;
  }
  // An explicit pause remains authoritative. New records wait for the
  // operator to resume rather than silently overriding that control.
  if (existing.state !== "completed") return;
  const latest = Number(rows(await db.execute(sql`
    SELECT COALESCE(MAX(id),0) AS latest_id
      FROM businesses WHERE record_class='canonical'
  `))[0]?.latest_id ?? 0);
  const versionChanged =
    Number(existing.policy_version) !== Number(program.policy_version) ||
    Number(existing.taxonomy_version) !== 2 ||
    Number(existing.classifier_version) !== CLASSIFIER_VERSION;
  // The watermark only moves forward, so a canonical business below it that
  // never produced evidence or a routed item (for example one that became
  // canonical after the cursor passed it) would otherwise never be visited.
  // Detect that gap and rewind: already-classified businesses are skipped by
  // the window query, so a rewind only does the missing work.
  const gap = !versionChanged && latest <= Number(existing.stop_business_id)
    ? rows(await db.execute(sql`
        SELECT 1 AS gap FROM businesses b
         WHERE b.record_class='canonical' AND b.id<=${Number(existing.stop_business_id)}
           AND NOT EXISTS (SELECT 1 FROM sfp_classification_evidence e
             WHERE e.business_id=b.id AND e.policy_version=${Number(program.policy_version)}
               AND e.taxonomy_version=2 AND e.classifier_version=${CLASSIFIER_VERSION})
           AND NOT EXISTS (SELECT 1 FROM sfp_classification_items i
             JOIN sfp_classification_runs r ON r.id=i.run_id
             WHERE i.business_id=b.id AND r.program_id=${programId}::uuid
               AND r.policy_version=${Number(program.policy_version)})
         LIMIT 1
      `))[0]
    : null;
  if (!versionChanged && !gap && latest <= Number(existing.stop_business_id)) return;
  await db.execute(sql`
    UPDATE sfp_free_classification_continuations
       SET state='running',
           high_water_business_id=${versionChanged || gap ? 0 : Number(existing.stop_business_id)},
           stop_business_id=${latest},
           policy_version=${Number(program.policy_version)},
           taxonomy_version=2,
           classifier_version=${CLASSIFIER_VERSION},
           lease_token=NULL,lease_expires_at=NULL,last_error=NULL,last_tick_at=NULL,
           started_at=NOW(),updated_at=NOW()
     WHERE program_id=${programId}::uuid AND state='completed'
  `);
}

async function processPendingVerticalEscalations(program: any): Promise<{ escalated: number; costMicros: number }> {
  if (!program || process.env.CRO03_PROVIDER_TRANSPORT_ENABLED !== "true") {
    return { escalated: 0, costMicros: 0 };
  }
  const readiness = await getSfpProviderReadiness("openai_classification");
  if (!readiness.ready) return { escalated: 0, costMicros: 0 };
  const pending = rows(await db.execute(sql`
    SELECT DISTINCT ON (e.business_id) e.business_id
      FROM sfp_classification_evidence e
     WHERE e.policy_version=${Number(program.policy_version)}
       AND e.taxonomy_version=2 AND e.classifier_version=${CLASSIFIER_VERSION}
       AND e.terminal_state='provisional' AND e.outcome='review_required'
       AND (e.reason_codes @> '["FREE_ONLY_NO_ESCALATION"]'::jsonb
            OR e.reason_codes @> '["OPENAI_UNAVAILABLE"]'::jsonb
            OR e.reason_codes @> '["OPENAI_ESCALATION_NOT_CONFIGURED"]'::jsonb)
       AND NOT EXISTS (
         SELECT 1 FROM sfp_classification_evidence done
          WHERE done.business_id=e.business_id
            AND done.policy_version=e.policy_version
            AND done.taxonomy_version=e.taxonomy_version
            AND done.classifier_version=e.classifier_version
            AND done.terminal_state='completed'
            AND NOT (done.reason_codes @> '["FREE_ONLY_NO_ESCALATION"]'::jsonb
                     OR done.reason_codes @> '["OPENAI_UNAVAILABLE"]'::jsonb
                     OR done.reason_codes @> '["OPENAI_ESCALATION_NOT_CONFIGURED"]'::jsonb)
       )
     ORDER BY e.business_id,e.created_at DESC,e.evidence_hash ASC
     LIMIT ${ESCALATION_LIMIT}
  `));
  const businessIds = pending.map((row: any) => Number(row.business_id));
  if (businessIds.length === 0) return { escalated: 0, costMicros: 0 };

  const priorRuns = rows(await db.execute(sql`
    SELECT COUNT(*)::bigint AS run_count FROM sfp_classification_runs
     WHERE program_id=${String(program.id)}::uuid
  `))[0];
  const result = await runPreCohortClassificationBridge({
    programId: String(program.id),
    idempotencyKey: `sfp-free-continuation:${String(program.id)}:paid-escalation:${Number(priorRuns?.run_count ?? 0) + 1}:${businessIds.join(",")}`,
    actorId: "system:sfp-free-continuation",
    maxBusinesses: ESCALATION_LIMIT,
    targetIds: (Array.isArray(program.vertical_ids) ? program.vertical_ids : []).map(String),
    policyVersion: Number(program.policy_version),
    taxonomyVersion: 2,
    businessIdFilter: businessIds,
    allowGovernedSerperDomainDiscovery: false,
    freeOnly: false,
  });
  return { escalated: result.processed, costMicros: result.costMicros };
}

async function processResolvedGeographyFollowups(program: any): Promise<number> {
  if (!program) return 0;
  const pending = rows(await db.execute(sql`
    SELECT DISTINCT ON (i.business_id) i.business_id
      FROM sfp_classification_items i
      JOIN sfp_classification_runs r ON r.id=i.run_id
      JOIN businesses b ON b.id=i.business_id
     WHERE r.program_id=${String(program.id)}::uuid
       AND r.policy_version=${Number(program.policy_version)}
       AND i.state='skipped'
       AND (
         CASE WHEN left(i.outcome_code,1)='{' THEN i.outcome_code::jsonb ELSE '{}'::jsonb END
           @> '{"route":"geography_review"}'::jsonb
         OR CASE WHEN left(i.outcome_code,1)='{' THEN i.outcome_code::jsonb ELSE '{}'::jsonb END
           @> '{"route":"outside_territory"}'::jsonb
       )
       AND (
         b.updated_at > i.created_at
         OR EXISTS (
           SELECT 1 FROM business_locations l
            WHERE l.business_id=i.business_id
              AND COALESCE(l.updated_at,l.created_at) > i.created_at
         )
         OR (
           (CASE WHEN left(i.outcome_code,1)='{' THEN i.outcome_code::jsonb ELSE '{}'::jsonb END)
             ->>'geographyAliasPolicy' IS DISTINCT FROM 'florida_state_alias_v1'
           AND (upper(btrim(b.state))='FLORIDA' OR EXISTS (
             SELECT 1 FROM business_locations l WHERE l.business_id=i.business_id
               AND upper(btrim(l.state))='FLORIDA'
           ))
         )
       )
     ORDER BY i.business_id,i.created_at DESC
     LIMIT ${RUN_LIMIT}
  `));
  const checkedIds: number[] = [];
  const resolvedIds: number[] = [];
  for (const row of pending) {
    const businessId = Number(row.business_id);
    checkedIds.push(businessId);
    const resolution = await resolveGeographyForBusiness(businessId, db);
    if (resolution.outcome === "resolved") resolvedIds.push(businessId);
  }
  if (checkedIds.length === 0) return 0;

  const priorRuns = rows(await db.execute(sql`
    SELECT COUNT(*)::bigint AS run_count FROM sfp_classification_runs
     WHERE program_id=${String(program.id)}::uuid
  `))[0];
  const result = await runPreCohortClassificationBridge({
    programId: String(program.id),
    idempotencyKey: `sfp-free-continuation:${String(program.id)}:geography-followup:${Number(priorRuns?.run_count ?? 0) + 1}:${resolvedIds.join(",")}`,
    actorId: "system:sfp-free-continuation",
    maxBusinesses: RUN_LIMIT,
    targetIds: (Array.isArray(program.vertical_ids) ? program.vertical_ids : []).map(String),
    policyVersion: Number(program.policy_version),
    taxonomyVersion: 2,
    businessIdFilter: checkedIds,
    freeOnly: true,
  });
  if (result.costMicros !== 0) throw new Error("SFP_GEOGRAPHY_FOLLOWUP_NONZERO_COST");
  // Version the new held decision so an unchanged alias/territory conflict does
  // not monopolize the next ordinary tick. Changed site evidence still revisits.
  await db.execute(sql`UPDATE sfp_classification_items
    SET outcome_code=(CASE WHEN left(outcome_code,1)='{' THEN outcome_code::jsonb ELSE '{}'::jsonb END ||
      '{"geographyAliasPolicy":"florida_state_alias_v1"}'::jsonb)::text
    WHERE run_id=${result.runId}::uuid AND state='skipped'
      AND business_id=ANY(ARRAY[${sql.join(checkedIds.map(id=>sql`${id}`),sql`, `)}]::integer[])`);
  await db.execute(sql`
    UPDATE sfp_classification_items i
       SET state='completed',
           outcome_code=jsonb_build_object(
             'route',CASE WHEN i.business_id=ANY(ARRAY[${sql.join(resolvedIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
                          THEN 'geography_review_revisited' ELSE 'geography_review_rechecked' END,
             'prior',CASE WHEN left(i.outcome_code,1)='{' THEN i.outcome_code::jsonb ELSE '{}'::jsonb END,
              'classificationRunId',${String(result.runId)}::text
           )::text,
           completed_at=NOW(),updated_at=NOW()
      FROM sfp_classification_runs r
     WHERE r.id=i.run_id AND r.program_id=${String(program.id)}::uuid
       AND r.policy_version=${Number(program.policy_version)}
       AND i.business_id=ANY(ARRAY[${sql.join(checkedIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
       AND i.run_id<>${result.runId}::uuid
       AND i.state='skipped'
       AND (
         CASE WHEN left(i.outcome_code,1)='{' THEN i.outcome_code::jsonb ELSE '{}'::jsonb END
           @> '{"route":"geography_review"}'::jsonb
         OR CASE WHEN left(i.outcome_code,1)='{' THEN i.outcome_code::jsonb ELSE '{}'::jsonb END
           @> '{"route":"outside_territory"}'::jsonb
       )
  `);
  return checkedIds.length;
}

/** Queue tick. A DB lease fences overlapping workers; the cursor advances
 * only after its idempotent evidence run finishes. A crash replays the same
 * window after lease expiry; current evidence avoids reclassifying completed
 * target/non-target records. */
export async function processSfpFreeClassificationTick(programIdFilter?: string,
  options: { skipSideWork?: boolean } = {}): Promise<{
  claimed: boolean; programId?: string; scanned?: number; processed?: number; target?: number; state?: string;
  escalated?: number; escalationCostMicros?: number;
}> {
  const automaticProgram = programIdFilter ? null : await getAutomaticSfpProgram();
  if (automaticProgram) await ensureAutomaticSfpPass(automaticProgram);
  const automaticContinuation = automaticProgram
    ? await getSfpFreeClassificationContinuation(String(automaticProgram.id))
    : null;
  const followupsEnabled = Boolean(automaticProgram && automaticContinuation &&
    !["paused", "idle"].includes(String(automaticContinuation.state)));
  // Repeat drain iterations in one queue job skip follow-ups/escalation so the
  // paid OpenAI step runs at most once per scheduled tick.
  const runSideWork = followupsEnabled && !options.skipSideWork;
  const geographyFollowups = runSideWork
    ? await processResolvedGeographyFollowups(automaticProgram)
    : 0;
  const escalation = runSideWork
    ? await processPendingVerticalEscalations(automaticProgram)
    : { escalated: 0, costMicros: 0 };
  const claimed = rows(await db.execute(sql`
    UPDATE sfp_free_classification_continuations AS c
       SET lease_token=gen_random_uuid(),lease_expires_at=NOW()+INTERVAL '60 minutes',last_tick_at=NOW(),updated_at=NOW()
     WHERE c.program_id=(
       SELECT program_id FROM sfp_free_classification_continuations
        WHERE state='running' AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
           ${programIdFilter ? sql`AND program_id=${programIdFilter}::uuid` : sql``}
        ORDER BY started_at,program_id FOR UPDATE SKIP LOCKED LIMIT 1
     ) AND c.state='running'
       AND (c.lease_expires_at IS NULL OR c.lease_expires_at<NOW())
     RETURNING c.*
  `))[0];
  if (!claimed) return {
    claimed: false, escalated: escalation.escalated, escalationCostMicros: escalation.costMicros,
    processed: geographyFollowups,
  };
  const programId = String(claimed.program_id);
  const token = String(claimed.lease_token);
  try {
    const program = rows(await db.execute(sql`
      SELECT policy_version,taxonomy_version,is_active,vertical_ids FROM sfp_programs WHERE id=${programId}::uuid
    `))[0];
    if (!program || !program.is_active || Number(program.policy_version) !== Number(claimed.policy_version) ||
        Number(program.taxonomy_version) !== 2 || Number(claimed.classifier_version) !== CLASSIFIER_VERSION) {
      throw new Error("SFP_FREE_CONTINUATION_POLICY_CHANGED");
    }
    const window = rows(await db.execute(sql`
      SELECT id FROM businesses WHERE record_class='canonical'
        AND id>${Number(claimed.high_water_business_id)} AND id<=${Number(claimed.stop_business_id)}
        AND NOT EXISTS (
          SELECT 1 FROM sfp_classification_evidence e
           WHERE e.business_id=businesses.id AND e.policy_version=${Number(claimed.policy_version)}
             AND e.taxonomy_version=2 AND e.classifier_version=${CLASSIFIER_VERSION}
        )
       ORDER BY id LIMIT ${WINDOW_LIMIT}
    `));
    if (window.length === 0) {
      await db.execute(sql`
        UPDATE sfp_free_classification_continuations
           SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
         WHERE program_id=${programId}::uuid AND state='running' AND lease_token=${token}::uuid AND lease_expires_at>NOW()
      `);
       return {
         claimed: true, programId, scanned: 0, processed: geographyFollowups, target: 0, state: "completed",
         escalated: escalation.escalated, escalationCostMicros: escalation.costMicros,
       };
    }
    const windowIds = window.map((r: any) => Number(r.id));
    let processed = 0;
    let target = 0;
    let rejected = 0;
    const stillCurrent = rows(await db.execute(sql`
      SELECT policy_version,taxonomy_version,is_active,vertical_ids
        FROM sfp_programs WHERE id=${programId}::uuid
    `))[0];
    if (!stillCurrent?.is_active || Number(stillCurrent.policy_version) !== Number(claimed.policy_version) ||
        Number(stillCurrent.taxonomy_version) !== 2) throw new Error("SFP_FREE_CONTINUATION_POLICY_CHANGED");
    const bridgeRun = await runPreCohortClassificationBridge({
      programId,
      idempotencyKey: `sfp-free-continuation:${programId}:policy:${Number(claimed.policy_version)}:pass:${Math.floor(new Date(claimed.started_at).getTime() / 1000)}:window:${Number(claimed.high_water_business_id)}-${windowIds[windowIds.length - 1]}`,
      actorId: "system:sfp-free-continuation",
      maxBusinesses: WINDOW_LIMIT,
      targetIds: (Array.isArray(stillCurrent.vertical_ids) ? stillCurrent.vertical_ids : []).map(String),
      policyVersion: Number(claimed.policy_version),
      taxonomyVersion: 2,
      businessIdFilter: windowIds,
      freeOnly: true,
    });
    if (bridgeRun.costMicros !== 0) throw new Error("SFP_FREE_CONTINUATION_NONZERO_COST");
    processed = bridgeRun.processed;
    target = bridgeRun.targetCount;
    rejected = bridgeRun.reviewRequiredCount;
    const nextCursor = windowIds[windowIds.length - 1];
    const updated = rows(await db.execute(sql`
      UPDATE sfp_free_classification_continuations
         SET high_water_business_id=${nextCursor},
              scanned_count=scanned_count+${windowIds.length},
             processed_count=processed_count+${processed},target_count=target_count+${target},
             rejected_count=rejected_count+${rejected},
             lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=NOW()
       WHERE program_id=${programId}::uuid AND state='running' AND lease_token=${token}::uuid AND lease_expires_at>NOW()
       RETURNING program_id
    `));
    if (updated.length === 0) throw new Error("SFP_FREE_CONTINUATION_LEASE_LOST");
    return { claimed: true,programId,scanned:windowIds.length,
      processed:processed + geographyFollowups,target,state:"running",escalated:escalation.escalated,
      escalationCostMicros:escalation.costMicros };
  } catch (error: any) {
    await db.execute(sql`
      UPDATE sfp_free_classification_continuations
         SET last_error=${String(error?.message ?? error).slice(0, 500)},
             lease_token=NULL,lease_expires_at=NULL,
             state=CASE WHEN ${String(error?.message ?? error).includes("POLICY_CHANGED")} THEN 'paused' ELSE state END,
             updated_at=NOW()
       WHERE program_id=${programId}::uuid AND lease_token=${token}::uuid
    `);
    throw error;
  }
}
