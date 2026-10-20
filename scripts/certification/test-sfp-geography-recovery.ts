#!/usr/bin/env tsx
/**
 * Run ONLY on a disposable migrated DB. Proves retained-evidence geography recovery for businesses parked as
 * geography_review: deterministic parsing, no county guessing, outside-territory stays excluded, unresolved
 * geography stays distinct from vertical evidence, first-party website reads (injected, never network),
 * bounded retry, failure isolation and zero provider/contact/enrollment writes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";

await assertDisposableTestInfrastructure({ operation: "SFP geography recovery certification", requireRedis: false });
process.env.CRO03_PROVIDER_TRANSPORT_ENABLED = "false";
const { pool } = await import("../../server/db");
const {
  startSfpFreeClassificationContinuation, processSfpFreeClassificationTick,
} = await import("../../server/services/cro03/sfp-free-classification-continuation");
const { parseStructuredAddress } = await import("../../server/services/cro03/sfp-geography-recovery");
const { extractJsonLdPostalAddresses } = await import("../../server/services/cro03/sfp-website-evidence");

let checks = 0;
const ok = (cond: unknown, message: string) => { assert.ok(cond, message); checks++; };
const eq = (a: unknown, b: unknown, message: string) => { assert.deepEqual(a, b, message); checks++; };

// ---- pure parsing -------------------------------------------------------------------------------------------
eq(parseStructuredAddress("207 Vine Ave, Clearwater, Florida, United States, 33755", "business_address"),
  { source: "business_address", streetAddress: "207 Vine Ave", city: "Clearwater", state: "FL", postalCode: "33755" }, "full provider address");
eq(parseStructuredAddress("Sarasota, Florida, United States, 34233", "business_address")?.city, "Sarasota", "city/state/zip only");
eq(parseStructuredAddress("Windermere, Florida, United States", "business_address")?.postalCode, null, "no ZIP is not invented");
eq(parseStructuredAddress("12 Main St, Boca Raton, FL 33432", "business_address")?.postalCode, "33432", "state+zip token");
eq(parseStructuredAddress("England, United Kingdom", "business_address"), null, "non-US country recovers nothing");
eq(parseStructuredAddress("Valencia, Valencian Community, Spain", "contact_address"), null, "unknown region recovers nothing");
eq(parseStructuredAddress("12451 Metro Parkway, #101", "business_address"), null, "no state recovers nothing");
eq(parseStructuredAddress("", "business_address"), null, "empty");
const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"LocalBusiness","name":"X",
  "address":{"@type":"PostalAddress","streetAddress":"1 A St","addressLocality":"Hollywood","addressRegion":"FL","postalCode":"33020","addressCountry":"US"}},
  {"@type":"Organization","address":{"@type":"PostalAddress","addressLocality":"London","addressCountry":"GB"}}]}</script>
  <script type="application/ld+json">{not json</script></html>`;
eq(extractJsonLdPostalAddresses(html), [{ streetAddress: "1 A St", city: "Hollywood", state: "FL", postalCode: "33020" }], "JSON-LD US address only; malformed ignored");

// ---- database fixtures --------------------------------------------------------------------------------------
const nonce = randomUUID().slice(0, 8);
const programId = String((await pool.query(`
  INSERT INTO sfp_programs (name,county_fips,vertical_ids,max_cohort_size,policy_version,taxonomy_version,is_active,created_by)
  VALUES ($1,ARRAY['12086','12011'],ARRAY['Construction/Trades/Home Services'],25,52,2,true,'disposable-cert') RETURNING id
`, [`sfp-geo-recovery-${nonce}`])).rows[0].id);

async function business(name: string, o: { street?: string; domain?: string; phone?: string } = {}) {
  const r = (await pool.query(`
    INSERT INTO businesses (canonical_name,normalized_name,vertical,street_address,website_domain,main_phone,status,record_class)
    VALUES ($1,$1,NULL,$2,$3,$4,'active','canonical') RETURNING id
  `, [`${name} ${nonce}`, o.street ?? null, o.domain ?? null, o.phone ?? null])).rows[0];
  return Number(r.id);
}
const A = await business("Reliable Roofing A", { street: "207 Vine Ave, Miami, Florida, United States, 33130" });
const B = await business("Seaside Restaurant B");
await pool.query(`INSERT INTO contacts (email,phone,first_name,last_name,business_id,city,state,address)
  VALUES ($1,'+13055550100','P','Q',$2,'Boca Raton','Florida','100 Main St, Boca Raton, Florida, United States, 33432')`, [`b-${nonce}@geo-cert.test`, B]);
const C = await business("Reliable Roofing C", { street: "266 Crystal Grove Blvd, Lutz, Florida, United States, 33548-6460" });
const D = await business("Reliable Roofing D", { street: "400 Nassau St W, East Canton, Ohio, United States, 44730-1114" });
const E = await business("Seaside Restaurant E", { domain: "e-site.test" });
const F = await business("Reliable Roofing F", { domain: "f-site.test" });
const G = await business("Reliable Roofing G", { phone: "13055551234" });
const H = await business("Reliable Roofing H", { street: "England, United Kingdom" });
const I = await business("Reliable Roofing I", { domain: "i-site.test" });
const J = await business("Reliable Roofing J", { street: "9 Palm Way, Hollywood, Florida, United States, 33020" });
await pool.query(`UPDATE businesses SET city='Tampa',state='Florida' WHERE id=$1`, [C]); // known-state city outside the reference
const all = [A, B, C, D, E, F, G, H, I, J];
const first = Math.min(...all), last = Math.max(...all);

const before = (await pool.query(`SELECT
  (SELECT COUNT(*)::int FROM provider_operations) AS providers,
  (SELECT COUNT(*)::int FROM sequence_enrollments) AS enrollments`)).rows[0];

const calls: string[] = [];
const evidenceShell = (extra: any = {}) => ({
  sourceUrl: "x", pageType: "unknown", jsonLdTypes: [], titleTokens: [], metaTokens: [], serviceTokens: [], categoryTokens: [],
  capturedAt: new Date().toISOString(), contentHash: "stub", ...extra,
});
const extractWebsiteEvidence = async (url: string) => {
  calls.push(url);
  const host = new URL(url).hostname;
  if (host === "e-site.test") {
    return evidenceShell({ jsonLdAddresses: [{ streetAddress: "1 A St", city: "Hollywood", state: "FL", postalCode: "33020" }] });
  }
  if (host === "f-site.test") return { error: "http_500" };
  if (host === "i-site.test") throw new Error("boom");
  return { error: "not_found" };
};

// First sweep parks the unresolved businesses as geography_review / outside_territory (no side work).
await startSfpFreeClassificationContinuation(programId);
await pool.query(`UPDATE sfp_free_classification_continuations SET high_water_business_id=$2,stop_business_id=$3 WHERE program_id=$1`,
  [programId, first - 1, last]);
await processSfpFreeClassificationTick(programId, { bridgeDeps: { extractWebsiteEvidence } as any });
const route = async (id: number) => {
  const row = (await pool.query(`SELECT outcome_code FROM sfp_classification_items WHERE business_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
  try { return JSON.parse(row?.outcome_code ?? "{}"); } catch { return {}; }
};
for (const id of [A, B, C, D, E, F, G, H, I]) {
  ok(["geography_review", "outside_territory"].includes((await route(id)).route), `business ${id} parked before recovery`);
}
eq(calls.length, 0, "unresolved geography does not reach website evidence in the ordinary sweep");
const evidenceCount = async (ids: number[]) => Number((await pool.query(
  `SELECT count(*) n FROM sfp_classification_evidence WHERE business_id=ANY($1::int[])`, [ids])).rows[0].n);
eq(await evidenceCount([A, B, C, D, E, F, G, H, I]), 0, "no vertical evidence is written for parked geography");

// Make this the automatic program so recovery + follow-ups run, with the ordinary window exhausted.
await pool.query(`UPDATE sfp_programs SET name='south-florida-v1' WHERE id=$1`, [programId]);
await pool.query(`UPDATE sfp_free_classification_continuations SET state='completed',stop_business_id=$2,high_water_business_id=$2 WHERE program_id=$1`, [programId, last]);
await processSfpFreeClassificationTick(undefined, { bridgeDeps: { extractWebsiteEvidence } as any, geographyRecoveryDeps: { extractWebsiteEvidence } });

const locs = async (id: number) => (await pool.query(`SELECT city,state,postal_code,county_fips FROM business_locations WHERE business_id=$1 ORDER BY id`, [id])).rows;
eq(await locs(A), [{ city: "Miami", state: "FL", postal_code: "33130", county_fips: null }], "A recovered from retained provider address; county not guessed");
eq((await locs(B)).map((r: any) => r.postal_code), ["33432"], "B recovered from linked contact address");
eq((await locs(E)).map((r: any) => r.city), ["Hollywood"], "E recovered from first-party JSON-LD address");
eq((await locs(J)).map((r: any) => r.postal_code), ["33020"], "J recovered from retained address");
eq((await locs(D)).map((r: any) => r.state), ["OH"], "D verified out-of-territory fact recorded");
for (const id of [C, F, G, H, I]) eq(await locs(id), [], `business ${id} has no invented location`);

for (const id of [A, B, E, J]) {
  const r = await route(id);
  ok(r.route === "geography_review_revisited" || r.prior || (await evidenceCount([id])) > 0, `business ${id} re-entered classification`);
  ok((await evidenceCount([id])) > 0, `business ${id} received classification evidence once geography resolved`);
}
eq(await evidenceCount([D]), 0, "out-of-territory business is not classified");
eq(await evidenceCount([C, F, G, H, I]), 0, "unresolved geography is never turned into vertical evidence");
eq((await route(D)).route, "outside_territory", "D stays outside_territory (distinct from unresolved)");
for (const id of [C, F, G, H, I]) eq((await route(id)).route, "geography_review", `business ${id} stays geography_review`);
const stamp = async (id: number) => (await route(id));
eq((await stamp(F)).geographyRecovery?.websiteError, "http_500", "website failure recorded, not hidden");
eq((await stamp(I)).geographyRecovery?.websiteError, "fetch_failed", "extractor throw is isolated to its business");
for (const id of [C, F, G, H, I]) eq((await stamp(id)).geographyRecoveryVersion, "retained_geography_recovery_v1", `business ${id} attempt versioned`);
ok((await pool.query(`SELECT count(*)::int n FROM sfp_classification_evidence WHERE cost_micros<>0`)).rows[0].n === 0, "all evidence provider-free");
checks++;

// Unchanged businesses are not re-read; website retry only after the interval.
const callsAfterFirst = calls.length;
await processSfpFreeClassificationTick(undefined, { bridgeDeps: { extractWebsiteEvidence } as any, geographyRecoveryDeps: { extractWebsiteEvidence } });
eq(calls.length, callsAfterFirst, "no repeat website reads inside the retry window");
await pool.query(`UPDATE sfp_classification_items SET outcome_code=(outcome_code::jsonb || jsonb_build_object('geographyRecoveryAt',(NOW()-INTERVAL '8 days')::text))::text
  WHERE business_id=$1 AND state='skipped'`, [F]);
await processSfpFreeClassificationTick(undefined, { bridgeDeps: { extractWebsiteEvidence } as any, geographyRecoveryDeps: { extractWebsiteEvidence } });
ok(calls.length > callsAfterFirst, "stale attempt is retried after the interval");
ok(calls.slice(callsAfterFirst).every((u) => u.includes("f-site.test")), "only the stale business is retried");

// Retained-only mode never touches the network seam.
const K = await business("Reliable Roofing K", { domain: "k-site.test" });
await pool.query(`INSERT INTO sfp_classification_items(run_id,business_id,state,outcome_code)
  SELECT id,$2,'skipped','{"route":"geography_review"}' FROM sfp_classification_runs WHERE program_id=$1 ORDER BY created_at LIMIT 1`, [programId, K]);
const { processGeographyRecovery } = await import("../../server/services/cro03/sfp-geography-recovery");
const beforeK = calls.length;
await processGeographyRecovery({ id: programId, policy_version: 52 }, 15, { extractWebsiteEvidence, allowWebsiteRead: false });
eq(calls.length, beforeK, "allowWebsiteRead=false performs no website read");

const after = (await pool.query(`SELECT
  (SELECT COUNT(*)::int FROM provider_operations) AS providers,
  (SELECT COUNT(*)::int FROM sequence_enrollments) AS enrollments`)).rows[0];
eq(after, before, "zero provider operations and enrollments");
console.log(`PASS: ${checks} SFP geography recovery checks; retained evidence only, no county guessing, no provider spend`);
await pool.end();
