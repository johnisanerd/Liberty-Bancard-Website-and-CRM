/**
 * Production-scale measurement of the SFP reconsideration discovery and escalation-pending queries.
 *
 * Seeds a disposable database with the production shape observed read-only on 2026-10-17
 * (93,140 canonical businesses, 15,367 with a website domain, 103,187 current-version classification
 * rows over 80,972 businesses, 128,754 classification items, all existing rows without an input
 * fingerprint), then reports for each query: actual runtime, rows scanned/produced, buffers, and the
 * plan's node types. Nothing here touches production or a provider.
 *
 * Usage: npx tsx scripts/run-sfp2060-certification-disposable.ts --only reconsideration-scale
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";

await assertDisposableTestInfrastructure({ operation: "SFP reconsideration scale measurement" });

const { pool } = await import("../../server/db");
const { CLASSIFIER_VERSION, SFP_TARGET_VERTICALS_V2 } = await import("../../server/services/cro03/sfp-vertical-classifier");
const { SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION } = await import("../../server/services/cro03/sfp-vertical-acceptance");
const { sfpReconsiderationDueSql, SFP_WEBSITE_RECHECK_DAYS } = await import("../../server/services/cro03/sfp-reconsideration");
const { sfpInputFingerprintSql, sfpRetainedListingCategoryHashesSql, sfpWebsiteSourceMarkerSql } = await import("../../shared/sfp-input-fingerprint");
const discovery = await import("../../server/services/cro03/sfp-reconsideration-discovery");

const BUSINESSES = 93_140;
const WITH_DOMAIN = 15_367;
const EVIDENCE_BUSINESSES = 80_972;
const PROVISIONAL = 71_817, NON_TARGET = 13_690, COMPLETED_REVIEW = 9_245, TARGET_UNTIERED = 4_428, TARGET_HIGH = 4_182;
const EVIDENCE = PROVISIONAL + NON_TARGET + COMPLETED_REVIEW + TARGET_UNTIERED + TARGET_HIGH;
const ITEMS_PER_RUN = [BUSINESSES, 128_754 - BUSINESSES];
const POLICY = 2;
const TARGET_IDS = [...SFP_TARGET_VERTICALS_V2] as string[];
const versions = { policyVersion: POLICY, classifierVersion: CLASSIFIER_VERSION, taxonomyVersion: 2 as const };
const prefix = `scale_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const programId = randomUUID();
await pool.query(`INSERT INTO sfp_programs (id,name,county_fips,vertical_ids,taxonomy_version,policy_version,is_active,created_by)
  VALUES($1,$2,ARRAY['12086'],$3::text[],2,$4,TRUE,'system:scale')`, [programId, `${prefix}-program`, TARGET_IDS, POLICY]);

console.log(`[scale] seeding ${BUSINESSES} businesses...`);
await pool.query(`INSERT INTO businesses (canonical_name,normalized_name,record_class,website_domain,city,state,postal_code,vertical)
  SELECT 'Scale ' || g, '${prefix}' || g, 'canonical',
         CASE WHEN g <= ${WITH_DOMAIN} THEN 'site' || g || '.scale.test' END, 'Miami','FL','33130',
         CASE WHEN g % 7 = 0 THEN 'Dentist' END
    FROM generate_series(1, ${BUSINESSES}) g`);
const firstId = Number((await pool.query(`SELECT min(id) m FROM businesses WHERE normalized_name LIKE '${prefix}%'`)).rows[0].m);

console.log(`[scale] seeding ${EVIDENCE} classification rows...`);
// Row r belongs to business ((r-1) % EVIDENCE_BUSINESSES)+1. The first PROVISIONAL rows are provisional
// no-attempt results; the rest are completed rows. Domains cluster at low ids, so provisional rows for
// businesses with a website exist at production-like density.
await pool.query(`INSERT INTO sfp_classification_evidence
  (business_id,evidence_hash,source_refs,classifier_version,taxonomy_version,policy_version,model_version,outcome,reason_codes,
   idempotency_key,terminal_state,admission_tier,resolved_vertical_id,created_at)
  SELECT ${firstId} + ((r-1) % ${EVIDENCE_BUSINESSES}), '${prefix}h' || r, '[]'::jsonb, ${CLASSIFIER_VERSION}, 2, ${POLICY},
         CASE WHEN r > ${PROVISIONAL} + ${NON_TARGET} + ${COMPLETED_REVIEW} THEN NULL END,
         CASE WHEN r <= ${PROVISIONAL} THEN 'review_required'
              WHEN r <= ${PROVISIONAL} + ${NON_TARGET} THEN 'non_target'
              WHEN r <= ${PROVISIONAL} + ${NON_TARGET} + ${COMPLETED_REVIEW} THEN 'review_required'
              ELSE 'target' END,
         CASE WHEN r <= ${PROVISIONAL} THEN '["FREE_ONLY_NO_ESCALATION"]'::jsonb ELSE '[]'::jsonb END,
         '${prefix}k' || r,
         CASE WHEN r <= ${PROVISIONAL} THEN 'provisional' ELSE 'completed' END,
         CASE WHEN r > ${EVIDENCE} - ${TARGET_HIGH} THEN 'resolved_high' END,
         CASE WHEN r > ${EVIDENCE} - ${TARGET_HIGH} THEN 'Healthcare' END,
         NOW() - make_interval(secs => (${EVIDENCE} - r))
    FROM generate_series(1, ${EVIDENCE}) r`);

console.log("[scale] seeding classification runs and items...");
const runIds: string[] = [];
for (let i = 0; i < ITEMS_PER_RUN.length; i++) {
  const id = randomUUID();
  runIds.push(id);
  await pool.query(`INSERT INTO sfp_classification_runs (id,program_id,idempotency_key,actor_id,state,max_businesses,policy_version,classifier_version,config_hash)
    VALUES($1,$2,$3,'system:scale','completed',100000,$4,$5,'x')`, [id, programId, `${prefix}-run-${i}`, POLICY, CLASSIFIER_VERSION]);
  await pool.query(`INSERT INTO sfp_classification_items (run_id,business_id,state,completed_at,created_at)
    SELECT $1::uuid, ${firstId} + g - 1, CASE WHEN g % 7 = 0 THEN 'skipped' ELSE 'completed' END, NOW() - interval '60 days', NOW() - interval '60 days'
      FROM generate_series(1, ${ITEMS_PER_RUN[i]}) g`, [id]);
}
await pool.query("ANALYZE businesses; ANALYZE sfp_classification_evidence; ANALYZE sfp_classification_items;");

type Measure = { name: string; ms: number; rows: number; sharedHit: number; sharedRead: number; nodes: string[]; seqScans: string[] };
const results: Measure[] = [];
async function explain(name: string, query: string, params: unknown[] = []): Promise<Measure> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params)).rows[0]["QUERY PLAN"][0];
    await client.query("ROLLBACK");
    const nodes: string[] = [], seq: string[] = [];
    (function walk(n: any) {
      nodes.push(n["Node Type"]);
      if (n["Node Type"] === "Seq Scan") seq.push(`${n["Relation Name"]}(${n["Actual Rows"]}x${n["Actual Loops"]})`);
      (n.Plans ?? []).forEach(walk);
    })(plan.Plan);
    const m: Measure = {
      name, ms: Math.round(plan["Execution Time"]), rows: plan.Plan["Actual Rows"],
      sharedHit: plan.Plan["Shared Hit Blocks"], sharedRead: plan.Plan["Shared Read Blocks"],
      nodes: [...new Set(nodes)], seqScans: seq,
    };
    results.push(m);
    console.log(`[scale] ${name}: ${m.ms} ms, ${m.rows} rows, buffers hit=${m.sharedHit} read=${m.sharedRead}, seq=[${seq.join(", ")}]`);
    return m;
  } finally { client.release(); }
}

const LIMIT = 25;
// Queries exactly as committed in eb85ed29 (pre-repair): latest completed rows are computed for the
// whole table before the limit applies.
const latestCompleted = `(SELECT DISTINCT ON (x.business_id) x.* FROM sfp_classification_evidence x
   WHERE x.policy_version=${POLICY} AND x.classifier_version=${CLASSIFIER_VERSION} AND x.taxonomy_version=2 AND x.terminal_state='completed'
   ORDER BY x.business_id,x.created_at DESC,x.id DESC)`;
const oldDue = `SELECT e.business_id FROM ${latestCompleted} e JOIN businesses b ON b.id=e.business_id AND b.record_class='canonical'
  WHERE ${sfpReconsiderationDueSql("e", "b", versions)}
    AND NOT EXISTS (SELECT 1 FROM sfp_classification_evidence r WHERE r.business_id=b.id AND r.policy_version=e.policy_version
      AND r.classifier_version=e.classifier_version AND r.taxonomy_version=2 AND r.terminal_state='provisional' AND r.created_at>e.created_at
      AND r.created_at>NOW()-INTERVAL '1 day' AND r.acceptance_policy_version=${SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION}
      AND r.input_fingerprint=${sfpInputFingerprintSql("b")})
  ORDER BY e.business_id LIMIT ${LIMIT}`;
const oldUnread = `SELECT p.business_id FROM sfp_classification_evidence p JOIN businesses b ON b.id=p.business_id AND b.record_class='canonical'
  WHERE p.policy_version=${POLICY} AND p.classifier_version=${CLASSIFIER_VERSION} AND p.taxonomy_version=2 AND p.terminal_state='provisional'
    AND p.reason_codes @> '["FREE_ONLY_WEBSITE_EVIDENCE_NOT_FETCHED"]'::jsonb AND NULLIF(btrim(b.website_domain),'') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sfp_classification_evidence n WHERE n.business_id=p.business_id AND n.policy_version=p.policy_version
      AND n.classifier_version=p.classifier_version AND n.taxonomy_version=2 AND n.created_at>p.created_at)
  ORDER BY p.business_id LIMIT ${LIMIT}`;
const oldRecheck = `SELECT e.business_id FROM ${latestCompleted} e JOIN businesses b ON b.id=e.business_id AND b.record_class='canonical'
  WHERE e.outcome='target' AND e.acceptance_facts->>'websiteSourceUrl' IS NOT NULL
    AND NOT ${sfpReconsiderationDueSql("e", "b", versions)}
    AND NOT EXISTS (SELECT 1 FROM sfp_classification_items i JOIN sfp_classification_runs r ON r.id=i.run_id
      WHERE i.business_id=b.id AND r.policy_version=e.policy_version AND i.state='completed'
        AND i.completed_at>NOW()-make_interval(days => ${SFP_WEBSITE_RECHECK_DAYS}))
  ORDER BY e.business_id LIMIT ${LIMIT}`;

const escalationPending = (await import("../../server/services/cro03/sfp-free-classification-continuation")).pendingEscalationSql(versions, 200);

async function repairedMeasure(label: string) {
  for (const [name, q] of Object.entries(discovery.reconsiderationExplainQueries({
    versions, limit: LIMIT, windowSize: discovery.RECONSIDERATION_WINDOW, cursor: firstId - 1, maxId: firstId - 1 + discovery.RECONSIDERATION_WINDOW,
  }))) await explain(`AFTER ${label} ${name}`, q);
}

// ── Scenario 1: the shape production has at publish time (no fingerprints, 4,428 untiered targets) ──
console.log("\n[scale] ── scenario 1: production shape at publish (all rows without fingerprint) ──");
const before = [
  await explain("BEFORE publish-shape due", oldDue),
  await explain("BEFORE publish-shape unread", oldUnread),
  await explain("BEFORE publish-shape recheck", oldRecheck),
  await explain("escalation-pending publish-shape", escalationPending),
];
await repairedMeasure("publish-shape");
const expectedUntiered = new Set((await pool.query(`SELECT business_id FROM sfp_classification_evidence
  WHERE outcome='target' AND admission_tier IS NULL AND input_fingerprint IS NULL`)).rows.map((r: any) => Number(r.business_id)));
const t0 = Date.now();
const seen = new Map<number, string>();
let ticks = 0, cursor = 0, pass = 1, maxTickMs = 0;
while (pass === 1) {
  const started = Date.now();
  await pool.query("DELETE FROM system_settings WHERE key=$1", [discovery.reconsiderationCursorKey(programId, versions)]);
  await discovery.writeReconsiderationCursor(programId, versions, { businessId: cursor, pass });
  const result = await discovery.discoverReconsiderationWork({ programId, versions, limit: LIMIT });
  maxTickMs = Math.max(maxTickMs, Date.now() - started);
  for (const w of result.work) seen.set(w.businessId, w.kind);
  cursor = result.next.businessId; pass = result.next.pass; ticks++;
  assert(ticks < 2000, "a pass must terminate");
}
console.log(`[scale] full pass simulation: ${ticks} ticks, ${seen.size} businesses surfaced, slowest tick ${maxTickMs} ms, total ${Date.now() - t0} ms`);
assert.equal(seen.size, expectedUntiered.size, "every legacy untiered target is surfaced exactly once in one pass");
for (const id of expectedUntiered) assert.equal(seen.get(id), "due", `legacy untiered business ${id} is due`);
const windowsNeeded = Math.ceil(BUSINESSES / discovery.RECONSIDERATION_WINDOW);
console.log(`[scale] pass over ${BUSINESSES} businesses needs >= ${windowsNeeded} window ticks and ceil(${expectedUntiered.size}/${LIMIT})=${Math.ceil(expectedUntiered.size / LIMIT)} work ticks`);

// ── Scenario 2: steady state after reconsideration (every row fingerprinted, nothing due) ──
// The evidence table is insert-only; the disposable harness disables its immutability trigger once.
await pool.query("ALTER TABLE sfp_classification_evidence DISABLE TRIGGER USER");
await pool.query(`UPDATE sfp_classification_evidence e SET input_fingerprint=${sfpInputFingerprintSql("b")},
  acceptance_policy_version=${SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION},
  reason_codes=e.reason_codes || jsonb_build_array(${sfpWebsiteSourceMarkerSql("b")})
  FROM businesses b WHERE b.id=e.business_id`);
await pool.query("ALTER TABLE sfp_classification_evidence ENABLE TRIGGER USER");
await pool.query("ANALYZE sfp_classification_evidence");
console.log("\n[scale] ── scenario 2: steady state (every row fingerprinted, none due) ──");
const beforeSteady = [
  await explain("BEFORE steady due", oldDue),
  await explain("BEFORE steady unread", oldUnread),
  await explain("BEFORE steady recheck", oldRecheck),
  await explain("escalation-pending steady", escalationPending),
];
await repairedMeasure("steady");
{
  await discovery.writeReconsiderationCursor(programId, versions, { businessId: 0, pass: 10 });
  let steadyTicks = 0, steadyMax = 0, passNo = 10, found = 0;
  const started = Date.now();
  while (passNo === 10) {
    const t = Date.now();
    const r = await discovery.discoverReconsiderationWork({ programId, versions, limit: LIMIT });
    steadyMax = Math.max(steadyMax, Date.now() - t);
    found += r.work.length;
    await discovery.writeReconsiderationCursor(programId, versions, r.next);
    passNo = r.next.pass; steadyTicks++;
    assert(steadyTicks < 100);
  }
  console.log(`[scale] steady full pass: ${steadyTicks} ticks, ${found} found, slowest tick ${steadyMax} ms, total ${Date.now() - started} ms`);
  assert.equal(found, 0, "nothing is due when every row is current");
  assert(steadyTicks <= Math.ceil(BUSINESSES / (discovery.RECONSIDERATION_WINDOW * discovery.RECONSIDERATION_MAX_WINDOWS_PER_TICK)) + 1);
}
console.log(JSON.stringify({ before: [...before, ...beforeSteady].map((m) => ({ name: m.name, ms: m.ms })), after: results.filter((m) => m.name.startsWith("AFTER")).map((m) => ({ name: m.name, ms: m.ms })) }));
assert(results.length > 0);
console.log(`[scale] done; seeded prefix ${prefix}`);
await pool.end();
void sfpRetainedListingCategoryHashesSql;
