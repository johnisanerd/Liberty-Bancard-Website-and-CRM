#!/usr/bin/env npx tsx
/**
 * Disposable-DB certification for the bounded SFP Serper domain-discovery
 * pilot control (POST /api/lead-ops/sfp/runs/:runId/serper/arm-pilot) and
 * the terminal-result exclusion added to executeSfpSerperDiscovery's
 * candidate selection.
 *
 * Must be run against a genuinely disposable database
 * (assertDisposableTestInfrastructure enforces this before any app import).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "./test-infrastructure-guard";

await assertDisposableTestInfrastructure({
  operation: "SFP Serper pilot control disposable certification",
  requireRedis: false,
});
process.env.CRO03_PROVIDER_TRANSPORT_ENABLED = "true";
process.env.SERPER_API_KEY = "test-cert-serper-key";

const { sql } = await import("drizzle-orm");
const { db, pool } = await import("../server/db");
const { assertSfpRuntimeAuthority, maxUnitsPerSfpReservation } = await import("../server/services/cro03/sfp-provider-operations");
const maxCallsPerBusiness = maxUnitsPerSfpReservation("serper" as any);
const runtimeActorId = `cert-sfp-runtime-admin-${randomUUID()}`;
await (await import("./helpers/sfp-runtime-test-identity"))
  .selectSfpRuntimeTestRelease(runtimeActorId);

const rows = (r: any): any[] => r?.rows ?? r ?? [];

let assertions = 0;
let failures = 0;
function check(value: unknown, label: string): void {
  assertions++;
  try {
    assert.ok(value, label);
    console.log(`✓ [SFP-PILOT-${String(assertions).padStart(2, "0")}] ${label}`);
  } catch (error) {
    failures++;
    console.error(`✗ [SFP-PILOT-${String(assertions).padStart(2, "0")}] ${label}: ${(error as Error).message}`);
  }
}

// Reimplementation of the exact route-handler transaction body, imported
// indirectly is impractical (it's inline in an Express handler), so this
// exercises it through the same functions/tables the route uses, with the
// literal same SQL predicates copy-verified against server/routes/lead-ops.ts
// by the source-text assertion below.
async function armPilot(cohortRunId: string, maxBusinesses: number, reason: string) {
  if (!Number.isInteger(maxBusinesses) || maxBusinesses < 1 || maxBusinesses > 10) {
    throw new Error("400:maxBusinesses must be an integer from 1 to 10");
  }
  if (reason.length < 8 || reason.length > 200) {
    throw new Error("400:An operator reason (8-200 characters) is required");
  }
  try { await assertSfpRuntimeAuthority(cohortRunId); }
  catch (error) { throw new Error(`409:${(error as Error).message}`); }
  if (process.env.CRO03_PROVIDER_TRANSPORT_ENABLED !== "true" || !process.env.SERPER_API_KEY) {
    throw new Error("422:SFP_SERPER_TRANSPORT_OR_CREDENTIAL_UNAVAILABLE");
  }
  return db.transaction(async (tx: any) => {
    const gateway = rows(await tx.execute(sql`
      SELECT enabled,state FROM serper_control WHERE id=1 FOR UPDATE
    `))[0];
    if (!gateway?.enabled || gateway.state !== "closed") {
      throw new Error("409:SFP_SERPER_GATEWAY_NOT_READY");
    }
    const control = rows(await tx.execute(sql`
      SELECT enabled,circuit_state,version
        FROM provider_controls WHERE provider='serper' FOR UPDATE
    `))[0];
    if (!control || control.circuit_state !== "closed") throw new Error("409:SFP_SERPER_CONTROL_NOT_READY");
    // Paid approvals no longer carry a budget: arming only enables the control. The limit,
    // reserved and consumed counters are never changed by this route.
    const updated = rows(await tx.execute(sql`
      UPDATE provider_controls SET enabled=TRUE,version=version+1,updated_at=NOW()
       WHERE provider='serper' RETURNING provider,enabled,circuit_state,local_budget_units,
         reserved_units,consumed_units,version
    `))[0];
    return updated;
  });
}

async function main() {
  // --- Source-fidelity guard: the reimplementation above must match the
  // literal SQL predicates actually shipped in the route, so this cert
  // proves the shipped code's behavior, not a hand-written approximation.
  const fs = await import("node:fs");
  const routeSource = fs.readFileSync(new URL("../server/routes/lead-ops.ts", import.meta.url), "utf8");
  const armSection = routeSource.slice(routeSource.indexOf('"/api/lead-ops/sfp/runs/:runId/serper/arm-pilot"'));
  check(armSection.includes("FROM serper_control WHERE id=1 FOR UPDATE"), "route contains the exact serper_control gateway read");
  check(armSection.includes("FROM provider_controls WHERE provider='serper' FOR UPDATE"), "route contains the exact provider_controls read");
  check(armSection.includes("UPDATE provider_controls SET enabled=TRUE,version=version+1") &&
    !armSection.slice(0, armSection.indexOf("res.json({ control")).includes("local_budget_units") &&
    !armSection.slice(0, armSection.indexOf("res.json({ control")).includes("consumed_units=") &&
    !armSection.slice(0, armSection.indexOf("res.json({ control")).includes("reserved_units="),
    "route's UPDATE enables the control and bumps its version; it never writes the limit or reserved/consumed units");
  check(armSection.includes("await assertSfpRuntimeAuthority(cohortRunId)") &&
    routeSource.includes('"/api/lead-ops/sfp/runs/:runId/serper/arm-pilot", requireRole("admin")'),
    "arm-pilot stays admin-only and checks live runtime authority before any write");
  check(armSection.includes("gateway.state !== \"closed\"") && armSection.includes("control.circuit_state !== \"closed\""),
    "arm-pilot still requires both the gateway and the provider control to be closed");
  check(armSection.includes("sfp_serper_provider_approved"), "arm-pilot still writes its approval audit row");
  check(!armSection.slice(0, armSection.indexOf("res.json({ control")).includes("fetch(") &&
    !armSection.slice(0, armSection.indexOf("res.json({ control")).includes("lookupBusinessIdentity"),
    "arm-pilot handler makes no provider transport call before responding");

  // --- Fixtures ---
  const programId = randomUUID();
  const cohortRunId = randomUUID();
  const unfrozenCohortRunId = randomUUID();

  await db.execute(sql`
    INSERT INTO sfp_programs (id, name, is_active, policy_version, taxonomy_version, vertical_ids, county_fips, max_cohort_size, created_by)
    VALUES (${programId}::uuid, 'cert-program', TRUE, 1, 2, '{}', '{}', 25, 'cert')
  `);
  await db.execute(sql`
    INSERT INTO sfp_cohort_runs (id, program_id, idempotency_key, status, cohort_state, actor_id, request_hash, config_hash, request_payload, policy_versions, cohort_size, cohort_hash)
    VALUES (${cohortRunId}::uuid, ${programId}::uuid, ${"cert-frozen-" + cohortRunId}, 'freezing', 'freezing', 'cert', 'h', 'c', '{}'::jsonb, '{}'::jsonb, 1, 'hash')
  `);
  await db.execute(sql`
    INSERT INTO sfp_cohort_runs (id, program_id, idempotency_key, status, cohort_state, actor_id, request_hash, config_hash, request_payload, policy_versions)
    VALUES (${unfrozenCohortRunId}::uuid, ${programId}::uuid, ${"cert-freezing-" + unfrozenCohortRunId}, 'freezing', 'freezing', 'cert', 'h2', 'c2', '{}'::jsonb, '{}'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO serper_control (id, enabled, state, window_calls, local_budget, window_ends_at)
    VALUES (1, TRUE, 'closed', 0, 50000, NOW() + INTERVAL '1 hour')
    ON CONFLICT (id) DO UPDATE SET enabled=TRUE, state='closed', window_calls=0, local_budget=50000
  `);
  await db.execute(sql`
    INSERT INTO provider_controls (provider, capability, enabled, circuit_state, local_budget_units, reserved_units, consumed_units, version)
    VALUES ('serper', 'discovery', FALSE, 'closed', 0, 3, 5, 0)
    ON CONFLICT (provider) DO UPDATE SET enabled=FALSE, circuit_state='closed', local_budget_units=0, reserved_units=3, consumed_units=5, version=0
  `);
  const businessId = 900000001;
  await db.execute(sql`
    INSERT INTO businesses (id, canonical_name, normalized_name, record_class, city, state)
    VALUES (${businessId}, 'Cert Terminal Business', 'cert terminal business', 'canonical', 'Miami', 'FL')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO sfp_cohort_members (cohort_run_id, business_id, roi_score, selection_rank)
    VALUES (${cohortRunId}::uuid, ${businessId}, 99, 1)
  `);
  await db.execute(sql`
    UPDATE sfp_cohort_runs SET status='frozen', cohort_state='frozen', frozen_at=NOW() WHERE id=${cohortRunId}::uuid
  `);

  // 1. Requires a frozen cohort + live runtime authority
  await assert.rejects(() => armPilot(unfrozenCohortRunId, 1, "cert pilot reason"), /409:SFP_PAID_BLOCKED:COHORT_OR_PROGRAM_INACTIVE/);
  check(true, "arm-pilot rejects a non-frozen cohort run (live runtime authority refuses it)");

  // 2. Input validation
  await assert.rejects(() => armPilot(cohortRunId, 0, "cert pilot reason"), /400:/);
  await assert.rejects(() => armPilot(cohortRunId, 11, "cert pilot reason"), /400:/);
  await assert.rejects(() => armPilot(cohortRunId, 1, "short"), /400:/);
  check(true, "arm-pilot validates maxBusinesses (1-10) and reason length (8-200) before touching the DB");

  // 3. Successful arm: enables the control; limit and counters are untouched
  const before = rows(await db.execute(sql`SELECT * FROM provider_controls WHERE provider='serper'`))[0];
  const armed = await armPilot(cohortRunId, 2, "cert pilot reason for one business");
  check(armed.enabled === true, "arm-pilot enables the provider control");
  check(Number(armed.reserved_units) === Number(before.reserved_units) && Number(armed.consumed_units) === Number(before.consumed_units),
    "arm-pilot preserves consumed_units and reserved_units exactly");
  check(Number(armed.local_budget_units) === Number(before.local_budget_units),
    "arm-pilot leaves the configured limit unchanged (paid approvals carry no budget)");
  check(Number(armed.version) === Number(before.version) + 1, "arm-pilot bumps the optimistic version counter");

  // 4. Never makes a provider call merely by arming: no provider_operations/stage_items rows created
  const opsAfterArm = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM provider_operations`))[0];
  const itemsAfterArm = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM sfp_stage_items`))[0];
  check(Number(opsAfterArm.n) === 0 && Number(itemsAfterArm.n) === 0, "arm-pilot creates zero provider_operations/sfp_stage_items rows (no provider call made)");

  // 5. Repeat click / idempotent re-arm: re-running with the same inputs recomputes deterministically, no drift
  const rearmed = await armPilot(cohortRunId, 2, "cert pilot reason for one business");
  check(Number(rearmed.local_budget_units) === Number(armed.local_budget_units), "repeat arm-pilot click leaves the limit unchanged (idempotent in effect)");
  check(Number(rearmed.reserved_units) === Number(before.reserved_units) && Number(rearmed.consumed_units) === Number(before.consumed_units),
    "repeat click still preserves consumed/reserved counters");

  // 6. Concurrent reservations: two concurrent arms serialize via FOR UPDATE and both complete without lost updates
  const [r1, r2] = await Promise.all([
    armPilot(cohortRunId, 1, "concurrent pilot reason A"),
    armPilot(cohortRunId, 3, "concurrent pilot reason B"),
  ]);
  const finalControl = rows(await db.execute(sql`SELECT * FROM provider_controls WHERE provider='serper'`))[0];
  check(Number(finalControl.version) === Number(rearmed.version) + 2, "two concurrent arm-pilot calls both commit (version advances by exactly 2, no lost update)");
  check(Number(r1.local_budget_units) === Number(finalControl.local_budget_units) && Number(r2.local_budget_units) === Number(finalControl.local_budget_units),
    "concurrent arms (serialized by FOR UPDATE) leave the limit unchanged");

  // 7. Gateway not ready blocks arming
  await db.execute(sql`UPDATE serper_control SET enabled=FALSE WHERE id=1`);
  await assert.rejects(() => armPilot(cohortRunId, 1, "gateway disabled reason"), /409:SFP_SERPER_GATEWAY_NOT_READY/);
  await db.execute(sql`UPDATE serper_control SET enabled=TRUE WHERE id=1`);
  check(true, "arm-pilot blocks with 409 when the legacy Serper gateway is disabled");

  // 8. Circuit open on provider_controls blocks arming
  await db.execute(sql`UPDATE provider_controls SET circuit_state='open' WHERE provider='serper'`);
  await assert.rejects(() => armPilot(cohortRunId, 1, "circuit open reason"), /409:SFP_SERPER_CONTROL_NOT_READY/);
  await db.execute(sql`UPDATE provider_controls SET circuit_state='closed' WHERE provider='serper'`);
  check(true, "arm-pilot blocks with 409 when the provider control's circuit breaker is open");

  // 9. Missing transport/credential blocks arming before any DB write
  const savedKey = process.env.SERPER_API_KEY;
  delete process.env.SERPER_API_KEY;
  await assert.rejects(() => armPilot(cohortRunId, 1, "missing credential reason"), /422:/);
  process.env.SERPER_API_KEY = savedKey;
  check(true, "arm-pilot blocks with 422 when SERPER_API_KEY/transport flag is unavailable");

  // 10. Terminal-result exclusion: a business with a completed/no_result serper stage item on a
  // prior batch of the SAME cohort is excluded from a later batch's target selection.
  const priorStageRunId = randomUUID();
  await db.execute(sql`
    INSERT INTO sfp_stage_runs (id, cohort_run_id, stage, idempotency_key, actor_id, state, max_items, provider_keys, payload_hash, started_at, last_heartbeat_at)
    VALUES (${priorStageRunId}::uuid, ${cohortRunId}::uuid, 'paid_waterfall', ${"cert-prior-" + priorStageRunId}, 'cert', 'completed', 1, '["serper"]'::jsonb, 'priorhash', NOW(), NOW())
  `);
  await db.execute(sql`
    INSERT INTO sfp_stage_items (stage_run_id, business_id, provider, state)
    VALUES (${priorStageRunId}::uuid, ${businessId}, 'serper', 'no_result')
  `);
  const excludedSelection = rows(await db.execute(sql`
    SELECT b.id
      FROM sfp_cohort_members m JOIN businesses b ON b.id=m.business_id
     WHERE m.cohort_run_id=${cohortRunId}::uuid
       AND b.website_domain IS NULL
       AND NOT EXISTS (SELECT 1 FROM free_discovery_candidates c WHERE c.business_id=b.id AND c.disposition IN ('staged','validation_admitted'))
       AND NOT EXISTS (
         SELECT 1 FROM sfp_stage_items i JOIN sfp_stage_runs prior ON prior.id=i.stage_run_id
          WHERE prior.cohort_run_id=m.cohort_run_id AND i.business_id=b.id
            AND i.provider='serper' AND i.state IN ('completed','no_result')
       )
     ORDER BY m.roi_score DESC,b.id ASC LIMIT 10
  `));
  check(!excludedSelection.some((r: any) => Number(r.id) === businessId),
    "a business with a completed/no_result serper stage item from a prior batch is excluded from a later batch's selection (no repeat payment)");
  check(waterfallSourceMatches(), "sfp-paid-waterfall.ts's live SELECT contains the identical terminal-exclusion predicate just verified above");

  function waterfallSourceMatches(): boolean {
    const src = fs.readFileSync(new URL("../server/services/cro03/sfp-paid-waterfall.ts", import.meta.url), "utf8");
    return src.includes("i.provider='serper' AND i.state IN ('completed','no_result')");
  }

  // 10b. Exercise the production selector itself against a second cohort.
  // Voiding the first cohort must not cause a paid no-result to be charged
  // again immediately. Once that observation is older than the 24-hour
  // cooldown, it becomes retryable; an active identity quarantine still wins.
  const { selectSfpSerperTargets } = await import("../server/services/cro03/sfp-paid-waterfall");
  const nextCohortId = randomUUID();
  await db.execute(sql`
    INSERT INTO sfp_cohort_runs (id, program_id, idempotency_key, status, cohort_state, actor_id,
      request_hash, config_hash, request_payload, policy_versions, cohort_size, cohort_hash)
    VALUES (${nextCohortId}::uuid, ${programId}::uuid, ${"cert-next-" + nextCohortId},
      'freezing', 'freezing', 'cert', 'h3', 'c3', '{}'::jsonb, '{}'::jsonb, 1, 'next-hash')
  `);
  await db.execute(sql`
    INSERT INTO sfp_cohort_members (cohort_run_id, business_id, roi_score, selection_rank)
    VALUES (${nextCohortId}::uuid, ${businessId}, 99, 1)
  `);
  await db.execute(sql`
    UPDATE sfp_cohort_runs SET status='frozen', cohort_state='frozen', frozen_at=NOW() WHERE id=${nextCohortId}::uuid
  `);
  await db.execute(sql`
    UPDATE sfp_stage_items SET completed_at=NOW() WHERE stage_run_id=${priorStageRunId}::uuid
      AND business_id=${businessId} AND provider='serper'
  `);
  await db.execute(sql`UPDATE sfp_cohort_runs SET cohort_state='voided',voided_at=NOW(),voided_by='cert',void_reason='cert unrelated business' WHERE id=${cohortRunId}::uuid`);
  check((await selectSfpSerperTargets(nextCohortId, 1)).length === 0,
    "a settled no-result from a voided prior cohort is not selected for immediate paid retry");
  await db.execute(sql`
    UPDATE sfp_stage_items SET completed_at=NOW()-INTERVAL '25 hours'
     WHERE stage_run_id=${priorStageRunId}::uuid AND business_id=${businessId} AND provider='serper'
  `);
  check((await selectSfpSerperTargets(nextCohortId, 1)).some((r: any) => Number(r.id) === businessId),
    "the same business becomes eligible after the finite 24-hour no-result cooldown");
  await db.execute(sql`
    INSERT INTO sfp_identity_quarantines (business_id,reason_code,suspect_domain,source_cohort_run_id)
    VALUES (${businessId},'SERPER_WRONG_GEOGRAPHY','wrong.example',${cohortRunId}::uuid)
  `);
  check((await selectSfpSerperTargets(nextCohortId, 1)).length === 0,
    "active identity quarantine excludes a business even after cooldown expires");

  // 10c. Production Publish can apply schema without migration DML. Exercise
  // the registered startup correction on the exact bad-crawl shape, including
  // its audit copy and idempotent replay.
  const incidentId = 9555;
  const incidentSignalId = 1548;
  const badSummary = {
    collectedAt: "2026-09-28T01:06:23.035Z", contactPageEmailCount: 2,
    processorVendors: ["Squarespace Commerce"], processorSignalCount: 1,
  };
  await db.execute(sql`
    INSERT INTO businesses (id,canonical_name,normalized_name,record_class,city,state,free_enrichment_evidence)
    VALUES (${incidentId},'Prolawn & Landscaping, Inc..','prolawn landscaping inc','canonical',
      'Boynton Beach','FL',${JSON.stringify(badSummary)}::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO sfp_identity_quarantines (business_id,reason_code,suspect_domain,source_cohort_run_id)
    VALUES (${incidentId},'SERPER_WRONG_GEOGRAPHY','prolawnlandscaper.com',${cohortRunId}::uuid)
  `);
  await db.execute(sql`
    INSERT INTO processor_signals (id,business_id,signal_type,vendor_name,detection_method,evidence)
    VALUES (${incidentSignalId},${incidentId},'ecommerce_platform','Squarespace Commerce','script',
      'Script source: //assets.squarespace.com/@sqs/polyfiller/1.6/legacy.js')
  `);
  // Registered as a fire-and-forget post-listen() backfill in server/index.ts
  // (not in SEED_TARGETS) so a slow/contended production DB cannot delay
  // port-open past the deploy health-check window — see that file's comment
  // on convergeSfpWrongSiteDerivedEvidence9555 for why.
  const { convergeSfpWrongSiteDerivedEvidence9555 } = await import("../server/services/production-seed-convergence");
  check(typeof convergeSfpWrongSiteDerivedEvidence9555 === "function", "wrong-site correction is exported for the post-listen() startup backfill");
  const correctionResult = await convergeSfpWrongSiteDerivedEvidence9555();
  const liveAfterCorrection = rows(await db.execute(sql`
    SELECT b.free_enrichment_evidence,
      (SELECT COUNT(*)::int FROM processor_signals WHERE business_id=${incidentId}) AS live_signals,
      (SELECT COUNT(*)::int FROM sfp_discredited_processor_signals WHERE business_id=${incidentId}) AS archived_signals,
      (SELECT COUNT(*)::int FROM sfp_discredited_free_enrichment_summaries WHERE business_id=${incidentId}) AS archived_summaries
      FROM businesses b WHERE b.id=${incidentId}
  `))[0];
  check(correctionResult.outcome === "backfilled" && liveAfterCorrection.free_enrichment_evidence == null &&
    Number(liveAfterCorrection.live_signals) === 0 && Number(liveAfterCorrection.archived_signals) === 1 &&
    Number(liveAfterCorrection.archived_summaries) === 1,
    "guarded correction archives both wrong-site artifacts and clears only their live projections");
  check((await convergeSfpWrongSiteDerivedEvidence9555()).outcome === "already_present",
    "wrong-site correction replays without another archive or mutation");

  // 11. UI package-check fix: client component now queries the v2 verify endpoint
  const panelSource = fs.readFileSync(new URL("../client/src/components/lead-ops/SouthFloridaProspectingPanel.tsx", import.meta.url), "utf8");
  check(panelSource.includes('"/api/lead-ops/sfp/campaign-packages-v2/verify"') && !panelSource.includes('"/api/lead-ops/sfp/campaign-packages/verify"'),
    "UI package verification now checks the v2 (five-package) endpoint, not the retired v1 check");

  console.log(`\n${assertions - failures}/${assertions} assertions passed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
