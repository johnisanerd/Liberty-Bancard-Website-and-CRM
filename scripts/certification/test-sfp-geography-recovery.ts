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
const { parseStructuredAddress, websiteAddresses, organizationNamesMatch } = await import("../../server/services/cro03/sfp-geography-recovery");
const { extractJsonLdOrganizations } = await import("../../server/services/cro03/sfp-website-evidence");

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
const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"LocalBusiness","name":"X Plumbing","url":"https://x-plumbing.test",
  "address":{"@type":"PostalAddress","streetAddress":"1 A St","addressLocality":"Hollywood","addressRegion":"FL","postalCode":"33020","addressCountry":"US"}},
  {"@type":"Organization","name":"London Thing","address":{"@type":"PostalAddress","addressLocality":"London","addressCountry":"GB"}}]}</script>
  <script type="application/ld+json">{not json</script></html>`;
eq(extractJsonLdOrganizations(html), [{ name: "X Plumbing", url: "https://x-plumbing.test", branchName: null,
  addresses: [{ streetAddress: "1 A St", city: "Hollywood", state: "FL", postalCode: "33020" }] }], "JSON-LD US entity only; malformed and non-US ignored");

// Ownership: an Ohio business page that also names an unrelated Miami publisher must not inherit the publisher's address.
const ohioPage = `<script type="application/ld+json">{"@type":"Article","headline":"News","publisher":{"@type":"Organization","name":"Miami Daily Publishing","url":"https://miamidaily.test",
  "address":{"@type":"PostalAddress","addressLocality":"Miami","addressRegion":"FL","postalCode":"33130"}},
  "about":{"@type":"LocalBusiness","name":"Buckeye Tool Supply","url":"https://buckeye.test","address":{"@type":"PostalAddress","addressLocality":"Canton","addressRegion":"OH","postalCode":"44730"}}}</script>`;
const ohio = extractJsonLdOrganizations(ohioPage);
eq(ohio.length, 2, "both declared entities are reported with their own owner");
const ohioIdentity = { names: ["Buckeye Tool Supply, Inc."], domain: "buckeye.test" };
eq(websiteAddresses(ohio, ohioIdentity, "https://buckeye.test/").map((a) => a.city), ["Canton"], "only the business's own entity address is accepted");
eq(websiteAddresses(ohio, { names: ["Other Co"], domain: "other.test" }, "https://other.test/"), [], "no entity matches an unrelated business");
const branchPage = `<script type="application/ld+json">{"@type":"Organization","name":"Palm Dental Group","url":"https://palmdental.test","location":{"@type":"Place","name":"Palm Dental Boca","address":{"@type":"PostalAddress","addressLocality":"Boca Raton","addressRegion":"FL","postalCode":"33432"}}}</script>`;
const branch = websiteAddresses(extractJsonLdOrganizations(branchPage), { names: ["Palm Dental Group LLC"], domain: "palmdental.test" }, "https://palmdental.test/");
eq(branch.map((a) => a.city), ["Boca Raton"], "a branch nested under the business's own organization is accepted");
eq(branch[0].reference?.branchName, "Palm Dental Boca", "branch source reference retained");
eq(branch[0].reference?.matchedBy, "domain", "match basis retained");
eq(websiteAddresses(extractJsonLdOrganizations(`<script type="application/ld+json">{"@type":"Organization","name":"Kauai Coffee Company","address":{"@type":"PostalAddress","addressLocality":"Kalaheo","addressRegion":"HI","postalCode":"96741"}}</script>`),
  { names: ["www.kauaicoffee.com"], domain: "kauaicoffee.com" }, "https://kauaicoffee.com/").map((a) => a.state), ["HI"], "domain-label name match");
ok(organizationNamesMatch("Seaside Restaurant", "Seaside Restaurant Group LLC"), "subset with two distinctive tokens matches");
ok(!organizationNamesMatch("Miami Herald", "Miami Roofing"), "one shared token never matches");
ok(!organizationNamesMatch("Price Buster Auto Sales 19, Inc..", "Golden Oldies Auto Sales, Inc."), "different companies with shared generic words do not match");

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
await pool.query(`INSERT INTO contacts (email,phone,first_name,last_name,company_name,business_id,city,state,address)
  VALUES ($1,'+13055550100','P','Q','Seaside Restaurant B',$2,'Boca Raton','Florida','100 Main St, Boca Raton, Florida, United States, 33432')`, [`b-${nonce}@geo-cert.test`, B]);
const C = await business("Reliable Roofing C", { street: "266 Crystal Grove Blvd, Lutz, Florida, United States, 33548-6460" });
const D = await business("Reliable Roofing D", { street: "400 Nassau St W, East Canton, Ohio, United States, 44730-1114" });
const E = await business("Seaside Restaurant E", { domain: "e-site.test" });
const F = await business("Reliable Roofing F", { domain: "f-site.test" });
const G = await business("Reliable Roofing G", { phone: "13055551234" });
const H = await business("Reliable Roofing H", { street: "England, United Kingdom" });
const I = await business("Reliable Roofing I", { domain: "i-site.test" });
const J = await business("Reliable Roofing J", { street: "9 Palm Way, Hollywood, Florida, United States, 33020" });
await pool.query(`UPDATE businesses SET city='Tampa',state='Florida' WHERE id=$1`, [C]); // known-state city outside the reference
// L: contact linked to the business but carrying ANOTHER company's Florida address; M: page naming only an unrelated Miami publisher.
const L = await business("Reliable Roofing L", {});
await pool.query(`INSERT INTO contacts (email,phone,first_name,last_name,company_name,business_id,city,state,address)
  VALUES ($1,'+13055550101','P','Q','Golden Oldies Auto Sales',$2,'Hudson','Florida','18913 US Highway 19, Hudson, Florida, United States, 34667')`, [`l-${nonce}@geo-cert.test`, L]);
const M = await business("Reliable Roofing M", { domain: "m-site.test" });
const all = [A, B, C, D, E, F, G, H, I, J, L, M];
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
    return evidenceShell({ finalUrl: url, jsonLdOrganizations: [{ name: "Seaside Restaurant E", url: "https://e-site.test", branchName: null,
      addresses: [{ streetAddress: "1 A St", city: "Hollywood", state: "FL", postalCode: "33020" }] }] });
  }
  if (host === "m-site.test") {
    return evidenceShell({ finalUrl: url, jsonLdOrganizations: [{ name: "Miami Daily Publishing", url: "https://miamidaily.test", branchName: null,
      addresses: [{ streetAddress: null, city: "Miami", state: "FL", postalCode: "33130" }] }] });
  }
  if (host === "n-site.test") return { error: "not_found" };
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
for (const id of [A, B, C, D, E, F, G, H, I, L, M]) {
  ok(["geography_review", "outside_territory"].includes((await route(id)).route), `business ${id} parked before recovery`);
}
eq(calls.length, 0, "unresolved geography does not reach website evidence in the ordinary sweep");
const evidenceCount = async (ids: number[]) => Number((await pool.query(
  `SELECT count(*) n FROM sfp_classification_evidence WHERE business_id=ANY($1::int[])`, [ids])).rows[0].n);
eq(await evidenceCount([A, B, C, D, E, F, G, H, I, L, M]), 0, "no vertical evidence is written for parked geography");

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
for (const id of [C, F, G, H, I, L, M]) eq(await locs(id), [], `business ${id} has no invented or misattributed location`);

for (const id of [A, B, E, J]) {
  const r = await route(id);
  ok(r.route === "geography_review_revisited" || r.prior || (await evidenceCount([id])) > 0, `business ${id} re-entered classification`);
  ok((await evidenceCount([id])) > 0, `business ${id} received classification evidence once geography resolved`);
}
eq(await evidenceCount([D]), 0, "out-of-territory business is not classified");
eq(await evidenceCount([C, F, G, H, I, L, M]), 0, "unresolved geography is never turned into vertical evidence");
eq((await route(D)).route, "outside_territory", "D stays outside_territory (distinct from unresolved)");
for (const id of [C, F, G, H, I, L, M]) eq((await route(id)).route, "geography_review", `business ${id} stays geography_review`);
const stamp = async (id: number) => (await route(id));
eq((await stamp(F)).geographyRecovery?.websiteError, "http_500", "website failure recorded, not hidden");
eq((await stamp(I)).geographyRecovery?.websiteError, "fetch_failed", "extractor throw is isolated to its business");
for (const id of [C, F, G, H, I, L, M]) eq((await stamp(id)).geographyRecoveryVersion, "retained_geography_recovery_v2", `business ${id} attempt versioned`);
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

// Supporting source references are retained for every recorded location.
const audits = (await pool.query(`SELECT entity_key,details FROM audit_logs WHERE action='sfp.geography_recovery.location_recorded' AND entity_key = ANY($1::text[])`,
  [[A, B, E, J, D].map(String)])).rows;
const refOf = (id: number) => audits.find((r: any) => r.entity_key === String(id))?.details?.reference;
eq(refOf(A)?.kind, "business_address", "A reference: business provider address");
eq(refOf(B)?.kind, "contact_address", "B reference: contact address");
ok(refOf(B)?.contactId > 0 && refOf(B)?.matchedBy === "company_name", "B reference names the contact row and match basis");
eq(refOf(E)?.kind, "website_jsonld", "E reference: website entity");
ok(String(refOf(E)?.pageUrl).includes("e-site.test") && refOf(E)?.entityName === "Seaside Restaurant E" && refOf(E)?.matchedBy, "E reference keeps page URL, entity and match basis");

// Multi-history regression: several historical holds for one business must not re-select it inside the retry window.
const N = await business("Reliable Roofing N", { domain: "n-site.test" });
const runRow = (await pool.query(`SELECT id FROM sfp_classification_runs WHERE program_id=$1 ORDER BY created_at LIMIT 1`, [programId])).rows[0];
// One item per run is allowed per business, so historical holds live in separate (cloned) runs.
const historicalRuns = [String(runRow.id)];
for (const label of ["h1", "h2", "h3"]) {
  const cloned = await pool.query(`INSERT INTO sfp_classification_runs
      (program_id,idempotency_key,actor_id,state,max_businesses,policy_version,classifier_version,config_hash,created_at)
    SELECT program_id,idempotency_key || ':' || $2,actor_id,state,max_businesses,policy_version,classifier_version,config_hash,NOW()-INTERVAL '40 days'
      FROM sfp_classification_runs WHERE id=$1 RETURNING id`, [runRow.id, `${label}-${nonce}`]);
  historicalRuns.push(String(cloned.rows[0].id));
}
for (const [index, days] of [30, 20, 10, 0].entries()) {
  await pool.query(`INSERT INTO sfp_classification_items(run_id,business_id,state,outcome_code,created_at)
    VALUES ($1,$2,'skipped','{"route":"geography_review"}',NOW()-($3 || ' days')::interval)`, [historicalRuns[index], N, String(days)]);
}
const { processGeographyRecovery: recoverNow } = await import("../../server/services/cro03/sfp-geography-recovery");
const nCalls = () => calls.filter((u) => u.includes("n-site.test")).length;
await recoverNow({ id: programId, policy_version: 52 }, 15, { extractWebsiteEvidence });
const firstN = nCalls();
ok(firstN >= 1 && firstN <= 2, "N read once (homepage and contact page) on first attempt");
await recoverNow({ id: programId, policy_version: 52 }, 15, { extractWebsiteEvidence });
await recoverNow({ id: programId, policy_version: 52 }, 15, { extractWebsiteEvidence });
eq(nCalls(), firstN, "older unmarked historical items do not re-select a just-attempted business");
const slotUse = await recoverNow({ id: programId, policy_version: 52 }, 15, { extractWebsiteEvidence });
ok(slotUse.examined === 0 || !calls.slice(-2).some((u) => u.includes("n-site.test")), "no recovery slots consumed by the attempted business");

// Retained-only mode never touches the network seam.
const K = await business("Reliable Roofing K", { domain: "k-site.test" });
await pool.query(`INSERT INTO sfp_classification_items(run_id,business_id,state,outcome_code)
  SELECT id,$2,'skipped','{"route":"geography_review"}' FROM sfp_classification_runs WHERE program_id=$1 ORDER BY created_at LIMIT 1`, [programId, K]);
const { processGeographyRecovery } = await import("../../server/services/cro03/sfp-geography-recovery");
const beforeK = calls.length;
await processGeographyRecovery({ id: programId, policy_version: 52 }, 15, { extractWebsiteEvidence, allowWebsiteRead: false });
eq(calls.length, beforeK, "allowWebsiteRead=false performs no website read");

// Priority: with a single slot, a never-attempted business that has a production contact goes before one without.
const P1 = await business("Priority Plain Plumbing P1", { domain: "p1-site.test" });
const P2 = await business("Priority Linked Plumbing P2", { domain: "p2-site.test" });
for (const id of [P1, P2]) {
  await pool.query(`INSERT INTO sfp_classification_items(run_id,business_id,state,outcome_code)
    SELECT id,$2,'skipped','{"route":"geography_review"}' FROM sfp_classification_runs WHERE program_id=$1 ORDER BY created_at LIMIT 1`, [programId, id]);
}
await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,business_id)
  VALUES('Pri','Linked',$1,'','Priority Linked Plumbing P2','production',$2)`, [`pri.${Date.now()}@example.test`, P2]);
const priorityCalls = calls.length;
await processGeographyRecovery({ id: programId, policy_version: 52 }, 1, { extractWebsiteEvidence });
const touched = calls.slice(priorityCalls);
ok(touched.length > 0 && touched.every((u) => u.includes("p2-site.test")), "the business with a production contact is recovered first");

const after = (await pool.query(`SELECT
  (SELECT COUNT(*)::int FROM provider_operations) AS providers,
  (SELECT COUNT(*)::int FROM sequence_enrollments) AS enrollments`)).rows[0];
eq(after, before, "zero provider operations and enrollments");
console.log(`PASS: ${checks} SFP geography recovery checks; retained evidence only, no county guessing, no provider spend`);
await pool.end();
