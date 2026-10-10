#!/usr/bin/env tsx
/** Run ONLY on a disposable migrated DB: cursor, replay, zero-spend and
 * zero-outbound assertions. Never runs on the shared dev or production DB. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "./test-infrastructure-guard";

await assertDisposableTestInfrastructure({ operation: "SFP free classification continuation certification", requireRedis: false });
// This certificate proves only the zero-provider lane; keep both the normal
// adapter gate and any site-evidence branch closed even on a misconfigured
// disposable environment.
process.env.CRO03_PROVIDER_TRANSPORT_ENABLED = "false";
const { pool } = await import("../server/db");
const {
  startSfpFreeClassificationContinuation,
  pauseSfpFreeClassificationContinuation,
  processSfpFreeClassificationTick,
  getSfpFreeClassificationContinuation,
} = await import("../server/services/cro03/sfp-free-classification-continuation");
const nonce = randomUUID();
const program = (await pool.query(`
  INSERT INTO sfp_programs (name,county_fips,vertical_ids,max_cohort_size,policy_version,taxonomy_version,is_active,created_by)
  VALUES ($1,ARRAY['12086'],ARRAY['Construction/Trades/Home Services'],25,41,2,true,'disposable-cert') RETURNING id
`, [`sfp-continuation-${nonce}`])).rows[0];
const programId = String(program.id);
async function business(name: string) {
  const result = (await pool.query(`
    INSERT INTO businesses (canonical_name,normalized_name,vertical,city,state,postal_code,status,record_class)
    VALUES ($1,$1,NULL,'Miami','FL','33101','active','canonical') RETURNING id
  `, [`${name} ${nonce}`])).rows[0];
  await pool.query(`INSERT INTO business_locations (business_id,is_primary,city,state,postal_code,county_fips)
    VALUES ($1,true,'Miami','FL','33101','12086')`, [result.id]);
  return Number(result.id);
}
const roofing = await business("Reliable Roofing");
const supplier = await business("Roofing Materials Supply");
const restaurant = await business("Seaside Restaurant");
const before = (await pool.query(`SELECT
  (SELECT COUNT(*)::int FROM provider_operations) AS providers,
  (SELECT COUNT(*)::int FROM contacts WHERE business_id=ANY($1::int[])) AS contacts,
  (SELECT COUNT(*)::int FROM sequence_enrollments se JOIN contacts c ON c.id=se.contact_id WHERE c.business_id=ANY($1::int[])) AS enrollments
`, [[roofing, supplier, restaurant]])).rows[0];

await startSfpFreeClassificationContinuation(programId);
// The disposable DB can contain seed fixtures; isolate the three created
// records while retaining the real SQL cursor and worker path.
await pool.query(`UPDATE sfp_free_classification_continuations
  SET high_water_business_id=$2,stop_business_id=$3 WHERE program_id=$1`,
  [programId, roofing - 1, restaurant]);
assert.equal((await pauseSfpFreeClassificationContinuation(programId))?.state, "paused");
assert.equal((await processSfpFreeClassificationTick(programId)).claimed, false);
assert.equal((await startSfpFreeClassificationContinuation(programId))?.state, "running");
const first = await processSfpFreeClassificationTick(programId);
assert.equal(first.claimed, true);
assert.equal(first.processed, 3);
assert.equal(first.target, 1);
assert.equal(first.scanned, 3);
const done = await processSfpFreeClassificationTick(programId);
assert.equal(done.state, "completed");
assert.equal((await processSfpFreeClassificationTick(programId)).claimed, false);
const cursor = await getSfpFreeClassificationContinuation(programId);
assert.equal(Number(cursor.processed_count), 3);
assert.equal(Number(cursor.high_water_business_id), restaurant);
const evidence = (await pool.query(`
  SELECT business_id,outcome,admission_tier,resolved_vertical_id,cost_micros,reason_codes,terminal_state
    FROM sfp_classification_evidence WHERE business_id=ANY($1::int[]) AND policy_version=41
`, [[roofing, supplier, restaurant]])).rows;
assert.equal(evidence.length, 3, "the bounded pass records target, non-target, and unresolved vertical evidence");
const targetEvidence = evidence.find((row: any) => Number(row.business_id) === roofing);
const supplierEvidence = evidence.find((row: any) => Number(row.business_id) === supplier);
const restaurantEvidence = evidence.find((row: any) => Number(row.business_id) === restaurant);
assert.equal(targetEvidence?.outcome, "target");
assert.equal(targetEvidence?.admission_tier, "resolved_high");
assert.equal(supplierEvidence?.outcome, "review_required");
const supplierReasons = Array.isArray(supplierEvidence?.reason_codes)
  ? supplierEvidence.reason_codes : JSON.parse(supplierEvidence?.reason_codes ?? "[]");
assert.ok(supplierReasons.includes("FREE_ONLY_NO_ESCALATION"));
assert.equal(supplierEvidence?.terminal_state, "provisional");
assert.equal(restaurantEvidence?.outcome, "non_target");
assert.ok(evidence.every((row: any) => Number(row.cost_micros) === 0), "all classification evidence is provider-free");
const after = (await pool.query(`SELECT
  (SELECT COUNT(*)::int FROM provider_operations) AS providers,
  (SELECT COUNT(*)::int FROM contacts WHERE business_id=ANY($1::int[])) AS contacts,
  (SELECT COUNT(*)::int FROM sequence_enrollments se JOIN contacts c ON c.id=se.contact_id WHERE c.business_id=ANY($1::int[])) AS enrollments
`, [[roofing, supplier, restaurant]])).rows[0];
assert.deepEqual(after, before, "free cursor must make zero provider, contact, or enrollment writes");
// Previously held full-state spellings are revisited without changing source
// revisions. A still-held alias is versioned once, not retried every tick.
const aliasEligible=await business("Reliable Roofing alias");
const aliasHeld=await business("Reliable Roofing Monroe alias");
await pool.query(`UPDATE businesses SET state='Florida',updated_at='2020-01-01'
  WHERE id=ANY($1::int[])`,[[aliasEligible,aliasHeld]]);
await pool.query(`UPDATE business_locations SET state=' florida ',updated_at='2020-01-01'
  WHERE business_id=ANY($1::int[])`,[[aliasEligible,aliasHeld]]);
await pool.query(`UPDATE businesses SET city='Key West',postal_code='33040' WHERE id=$1`,[aliasHeld]);
await pool.query(`UPDATE business_locations SET city='Key West',postal_code='33040',county_fips='12087'
  WHERE business_id=$1`,[aliasHeld]);
const priorRun=(await pool.query(`SELECT id FROM sfp_classification_runs WHERE program_id=$1
  ORDER BY created_at LIMIT 1`,[programId])).rows[0].id;
await pool.query(`INSERT INTO sfp_classification_items(run_id,business_id,state,outcome_code)
  SELECT $1,id,'skipped','{"route":"outside_territory"}'
  FROM businesses WHERE id=ANY($2::int[])`,[priorRun,[aliasEligible,aliasHeld]]);
await pool.query(`UPDATE sfp_programs SET name='south-florida-v1' WHERE id=$1`,[programId]);
await pool.query(`UPDATE sfp_free_classification_continuations SET state='completed',
  stop_business_id=$2,high_water_business_id=$2 WHERE program_id=$1`,[programId,aliasHeld]);
const aliasTick=await processSfpFreeClassificationTick();
assert.equal(aliasTick.processed,2,"Both unchanged Florida-alias holds are reconsidered");
assert.equal((await pool.query(`SELECT count(*)::int n FROM sfp_classification_items
  WHERE run_id=$1 AND state='completed' AND business_id=ANY($2::int[])`,
  [priorRun,[aliasEligible,aliasHeld]])).rows[0].n,2);
const heldLatest=(await pool.query(`SELECT outcome_code FROM sfp_classification_items
  WHERE business_id=$1 ORDER BY created_at DESC LIMIT 1`,[aliasHeld])).rows[0];
assert.equal(JSON.parse(heldLatest.outcome_code).geographyAliasPolicy,"florida_state_alias_v1");
const runsBeforeRepeat=Number((await pool.query(`SELECT count(*) n FROM sfp_classification_runs
  WHERE program_id=$1`,[programId])).rows[0].n);
assert.equal((await processSfpFreeClassificationTick()).processed,0,"Unchanged territory hold cannot monopolize followups");
assert.equal(Number((await pool.query(`SELECT count(*) n FROM sfp_classification_runs
  WHERE program_id=$1`,[programId])).rows[0].n),runsBeforeRepeat);
assert.equal(Number((await pool.query("SELECT count(*) n FROM provider_operations")).rows[0].n),before.providers);
console.log("SFP free continuation certification: cursor, pause/resume, one bounded run, replay and zero-spend passed");
console.log("Florida-alias followup: unchanged supported hold revisited; Monroe held once; no repeat run or provider spend");
await pool.end();
