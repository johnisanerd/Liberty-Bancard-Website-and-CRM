import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "effective vertical projection slicing certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool } = await import("../../server/db");
const { processEffectiveVerticalProjectionTick } = await import("../../server/services/crm-effective-vertical-projection");
const { effectiveBusinessVerticalSql, effectiveContactVerticalSql,
  effectiveBusinessVerticalStatusSql, effectiveContactVerticalStatusSql } = await import("../../shared/effective-vertical");
const prefix = `proj_slice_${randomUUID().replaceAll("-", "")}`;
const key = "crm_effective_vertical_projection_v1";
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };
const state = async () => (await pool.query("SELECT value FROM system_settings WHERE key=$1", [key])).rows[0].value;
// Stored values that disagree with the authoritative reader, across businesses and contacts.
const mismatches = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM businesses b WHERE b.canonical_name LIKE $1 AND (b.effective_vertical_id,b.effective_vertical_status)
    IS DISTINCT FROM (${effectiveBusinessVerticalSql("b")},${effectiveBusinessVerticalStatusSql("b")})) businesses,
  (SELECT count(*)::int FROM contacts c WHERE c.first_name LIKE $1 AND (c.effective_vertical_id,c.effective_vertical_status)
    IS DISTINCT FROM (${effectiveContactVerticalSql("c")},${effectiveContactVerticalStatusSql("c")})) contacts`,
  [`${prefix}%`])).rows[0];
try {
  const total = 120;
  await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,record_class,vertical)
    SELECT $1||n,$1||n,'canonical',CASE WHEN n%3=0 THEN 'Automotive' WHEN n%3=1 THEN 'Dental' ELSE NULL END
    FROM generate_series(1,${total}) n`, [prefix]);
  await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class,vertical,business_id)
    SELECT $1||n,'',$1||n||'@example.invalid','','production',CASE WHEN n%2=0 THEN 'Automotive' ELSE NULL END,
      (SELECT id FROM businesses WHERE canonical_name=$1||n)
    FROM generate_series(1,${total}) n`, [prefix]);
  check((await mismatches()).businesses > 0, "Fixture starts with stored verticals that disagree with the authoritative reader");
  await pool.query("DELETE FROM system_settings WHERE key=$1", [key]);

  // Failure case 1: a slice that exceeds its statement timeout is rolled back and retried smaller; the tick still commits.
  let stalls = 0;
  let result: any = await processEffectiveVerticalProjectionTick(60, {
    sliceTimeoutMs: 300,
    faultInjection: (lane, rows) => (rows > 20 && stalls++ < 6 ? 600 : 0),
  });
  check(result.ran && stalls > 0 && result.slowSlices > 0, "Over-timeout slices were actually injected and detected");
  check(result.businessesScanned > 0 && result.contactsScanned > 0, "A tick with timed-out slices still commits real progress");
  const afterFirst = await state();
  check(afterFirst.businessCursor > 0 && afterFirst.contactCursor > 0, "The checkpoint advanced past the timed-out slices");

  // Failure case 2: a slice that cannot succeed at any size aborts the tick and leaves the checkpoint untouched.
  const before = await state();
  await assert.rejects(processEffectiveVerticalProjectionTick(60, { sliceTimeoutMs: 100, faultInjection: () => 500 }));
  checks++;
  const afterFailure = await state();
  check(afterFailure.businessCursor === before.businessCursor && afterFailure.contactCursor === before.contactCursor
    && afterFailure.businessesScanned === before.businessesScanned, "A failed tick leaves cursor and counters exactly as checkpointed");
  check((await pool.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok", [key])).rows[0].ok,
    "A failed tick does not retain the projection lock");
  await pool.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);

  // Restart/resume: small ticks complete the frozen pass; stored values converge with the authoritative reader.
  for (let tick = 0; tick < 200 && (await state()).verifiedCycles < 1; tick++) result = await processEffectiveVerticalProjectionTick(25);
  check((await state()).verifiedCycles >= 1, "Resumed slices complete a full verified pass");
  const diff = await mismatches();
  check(diff.businesses === 0 && diff.contacts === 0, "Stored business and contact verticals equal the authoritative reader after the pass");
  check(result.outboundChanges === 0 && result.providerCalls === 0, "Projection stays local");
  await assert.rejects(processEffectiveVerticalProjectionTick(Number.NaN), /PAGE_LIMIT_INVALID/);
  checks++;
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider or network attempts");
  console.log(`PASS: ${checks} effective vertical projection slicing checks`);
} finally { await pool.end(); }
