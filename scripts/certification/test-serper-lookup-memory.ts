import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary, getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Serper lookup memory, matcher and unlabeled allowance" });
applyCertificationProviderDenyBoundary({ fatal: true });
process.env.SERPER_API_KEY = "serper-memory-disposable-only";
process.env.OUTSCRAPER_API_KEY = "serper-memory-disposable-only";
process.env.APOLLO_API_KEY = "serper-memory-disposable-only";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "serper-memory-disposable-only";

const { db, pool } = await import("../../server/db");
const { executeSfpSerperDiscovery } = await import("../../server/services/cro03/sfp-paid-waterfall");
const { programDiscoverySelection } = await import("../../server/services/cro03/sfp-discovery-scope");
const memory = await import("../../server/services/cro03/sfp-serper-lookup-memory");
const allowanceMod = await import("../../server/services/cro03/sfp-serper-allowance");
const identity = await import("../../server/services/serper-business-identity");

const id = randomUUID().slice(0, 8);
const actor = `serper-memory-${id}`;
let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [SERPER-MEM-${String(checks).padStart(2, "0")}] ${message}`); };
const rows = (r: any): any[] => r?.rows ?? r ?? [];

// ── Pure matcher checks (no database) ────────────────────────────────────────
{
  const q = { businessName: "Cedar Dental", zip: "33130", city: "Miami", requireGeographicCorroboration: true } as const;
  const cand = { name: "Cedar Dental", address: "101 Health Avenue, Miami, FL 33130", city: "Miami", state: "FL", zip: "33130", website: "cedar.example", source: "places" as const };
  const fl = identity.scoreCandidate({ ...q, state: "FL" }, cand);
  const full = identity.scoreCandidate({ ...q, state: "Florida" }, cand);
  check(fl.classification === "accepted_match" && full.classification === "accepted_match" && fl.score === full.score,
    "FL and Florida produce the identical accepted result and score");
  const wrong = identity.scoreCandidate({ ...q, state: "Florida" }, { ...cand, state: "GA", zip: "30301", city: "Atlanta" });
  check(wrong.rejectionReason === "state_conflict", "A different state is still rejected with a state_conflict reason");
  const organic = identity.scoreCandidate({ ...q, state: "FL" }, { name: "Cedar Dental", website: "cedar.example", source: "organic" });
  check(organic.rejectionReason === "organic_unsupported_geography" && organic.source === "organic",
    "An organic result without returned geography carries its own reason code");
  const kg = identity.scoreCandidate({ ...q, state: "FL" }, { name: "Cedar Dental", website: "cedar.example", source: "knowledge_graph" });
  check(identity.summarizeRejectionReasons([kg]) === "kg_geography_uncorroborated:1",
    "Knowledge-graph rejections are distinguished from organic ones in the summary");
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,'admin')`, [actor, `${actor}@fixture.invalid`]);
await (await import("../helpers/sfp-runtime-test-identity")).selectSfpRuntimeTestRelease(actor);
const { authorizePaidBudget, MI09_PAID_BUDGET_TYPED_CONFIRMATION } = await import("../../server/services/mi09-pilot-authority");
await authorizePaidBudget({ authorizedBy: actor, typedConfirmation: MI09_PAID_BUDGET_TYPED_CONFIRMATION });
const programId = (await pool.query(`INSERT INTO sfp_programs (name,county_fips,vertical_ids,is_active,taxonomy_version,created_by)
  VALUES($1,ARRAY['12086'],ARRAY['Healthcare'],TRUE,2,$2) RETURNING id`, [actor, actor])).rows[0].id;
const business = async (name: string, vertical: string | null = "Healthcare", state = "FL") =>
  (await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,city,state,postal_code,street_address,vertical,record_class)
    VALUES($1,lower($1),'Miami',$2,'33130','101 Health Avenue',$3,'canonical') RETURNING id`, [name, state, vertical])).rows[0].id;
await pool.query(`UPDATE provider_controls SET enabled=TRUE,circuit_state='closed',local_budget_units=1000000 WHERE provider='serper'`);
await pool.query(`UPDATE serper_control SET enabled=TRUE,state='closed',window_calls=0,local_budget=100000,
  window_ends_at=NOW()+INTERVAL '1 day' WHERE id=1`);

const web = await business(`Cedar Dental ${id}`);
const noWeb = await business(`Bravo Clinic ${id}`, "Healthcare", "Florida");
const noMatch = await business(`Alpha Dental ${id}`);
const rejected = await business(`Delta Pharmacy ${id}`);
const failing = await business(`Echo Therapy ${id}`);

type Response = { status: number; body: unknown };
let serperCalls = 0;
const queries: string[] = [];
const place = (title: string, website: string | null) => ({
  title, address: "101 Health Avenue, Miami, FL 33130", website, phoneNumber: "(305) 555-0123", category: "Medical clinic",
});
const respond = (path: string, q: string): Response => {
  const text = q.toLowerCase();
  if (path === "/search") return { status: 200, body: { organic: [], credits: 1 } };
  if (text.includes("cedar dental")) return { status: 200, body: { places: [place(`Cedar Dental ${id}`, "https://www.cedar-dental.example")], credits: 1 } };
  if (text.includes("bravo clinic")) return { status: 200, body: { places: [place(`Bravo Clinic ${id}`, null)], credits: 1 } };
  if (text.includes("delta pharmacy")) return { status: 200, body: { places: [place("Omega Hardware Supply", "https://omega-hardware.example")], credits: 1 } };
  if (text.includes("echo therapy")) return { status: 500, body: { message: "upstream error" } };
  return { status: 200, body: { places: [], credits: 1 } };
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const url = new URL(String(input));
  if (url.hostname !== ["google", "serper", "dev"].join(".")) return originalFetch(input, init);
  serperCalls++;
  const body = JSON.parse(String(init?.body ?? "{}"));
  queries.push(`${url.pathname}:${String(body.q ?? "")}`);
  const r = respond(url.pathname, String(body.q ?? ""));
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};
const run = (key: string, extra: Record<string, unknown> = {}) =>
  executeSfpSerperDiscovery({ programId, idempotencyKey: `${actor}:${key}`, actorId: actor, maxBusinesses: 25, ...extra } as any);
const classOf = async (businessId: number) =>
  (await pool.query(`SELECT outcome_class,rule_version FROM sfp_serper_lookup_memory WHERE business_id=$1`, [businessId])).rows[0];

try {
  // ── First pass: every outcome is remembered under its own class ────────────
  const first = await run("first");
  check(first.failed === 0, "First pass settles without scope errors");
  check((await classOf(web)) === undefined || (await classOf(web)).outcome_class === null,
    "A discovered website leaves no negative memory (the domain itself removes the business from selection)");
  check((await classOf(noWeb)).outcome_class === "accepted_no_website", "Accepted listing without a website is remembered as accepted_no_website");
  check((await classOf(noMatch)).outcome_class === "no_match", "A genuine empty result is remembered as no_match");
  check((await classOf(rejected)).outcome_class === "rejected", "Listings that failed identity are remembered as rejected");
  check((await classOf(failing)).outcome_class === "provider_failure", "A provider failure is its own class, never no_match");
  check((await classOf(rejected)).rule_version === identity.SERPER_MATCHER_RULE_VERSION, "Memory carries the matcher rule version");
  const dom = (await pool.query(`SELECT website_domain FROM businesses WHERE id=$1`, [web])).rows[0].website_domain;
  check(dom === "cedar-dental.example", "Accepted listing website is stored");
  const category = (await pool.query(`SELECT 1 FROM sfp_paid_candidate_evidence WHERE business_id=$1 AND field='listing_category'`, [noWeb])).rows;
  check(category.length === 1, "Listing category is kept as evidence when the listing has no website");
  const noWebDomain = (await pool.query(`SELECT count(*)::int n FROM sfp_paid_candidate_evidence WHERE business_id=$1 AND field='website_domain'`, [noWeb])).rows[0].n;
  check(noWebDomain === 0, "No website evidence is invented for a listing without a website");
  const rejectedCalls = queries.filter((q) => q.toLowerCase().includes("delta pharmacy"));
  check(rejectedCalls.length === 1 && rejectedCalls[0].startsWith("/places"),
    "The search fallback is skipped when Places already returned listings that were evaluated");
  const emptyCalls = queries.filter((q) => q.toLowerCase().includes("alpha dental"));
  check(emptyCalls.some((q) => q.startsWith("/search")), "The fallback still runs when Places returned nothing");
  const telemetry = (await pool.query(`SELECT count(*)::int n, COALESCE(sum(reported_credits),0)::int credits
    FROM serper_lookup_attempts WHERE rule_version=$1`, [identity.SERPER_MATCHER_RULE_VERSION])).rows[0];
  check(telemetry.n > 0 && telemetry.credits > 0, "Attempt telemetry records rule version and provider-reported credits");
  const nonHealthVertical = (await pool.query(`SELECT count(*)::int n FROM businesses WHERE id=ANY($1) AND vertical IS DISTINCT FROM 'Healthcare'`, [[web, noWeb, noMatch, rejected, failing]])).rows[0].n;
  check(nonHealthVertical === 0, "Discovery never writes or changes a vertical");

  // ── Second pass buys nothing already remembered ─────────────────────────────
  const callsBefore = serperCalls;
  const second = await run("second");
  check(serperCalls === callsBefore && second.processed === 0, "An unchanged second pass makes no provider request");

  // ── Reopening: expiry, rule version, changed inputs, provider failure ───────
  // The pre-existing 24-hour operation cooldown also applies; age it so that only memory decides.
  await pool.query(`UPDATE provider_operations SET created_at=created_at-INTERVAL '3 days' WHERE target_fingerprint LIKE 'business:%'`);
  const reopenSelection = async () => (await programDiscoverySelection(programId, `${actor}:probe:${randomUUID()}`, 25, "serper")).targets.map((t: any) => Number(t.id));
  check(!(await reopenSelection()).includes(noMatch), "Unexpired memory with unchanged inputs excludes the business");
  await pool.query(`UPDATE sfp_serper_lookup_memory SET expires_at=NOW()-INTERVAL '1 minute' WHERE business_id=$1`, [noMatch]);
  check((await reopenSelection()).includes(noMatch), "An expired entry reopens the business");
  await pool.query(`UPDATE sfp_serper_lookup_memory SET rule_version=rule_version-1 WHERE business_id=$1`, [rejected]);
  check((await reopenSelection()).includes(rejected), "A different matcher rule version reopens the business");
  await pool.query(`UPDATE businesses SET street_address='202 New Street' WHERE id=$1`, [noWeb]);
  check((await reopenSelection()).includes(noWeb), "Changed lookup inputs reopen the business");
  await pool.query(`UPDATE businesses SET street_address='101 Health Avenue' WHERE id=$1`, [noWeb]);
  check(!(await reopenSelection()).includes(noWeb), "Restoring the original inputs restores the exclusion");
  const failureTtl = (await pool.query(`SELECT (expires_at-observed_at) < INTERVAL '2 hours' AS short FROM sfp_serper_lookup_memory WHERE business_id=$1`, [failing])).rows[0].short;
  check(failureTtl === true, "Provider-failure memory is short-lived");
  check(Object.values(memory.SERPER_LOOKUP_MEMORY_TTL_HOURS).every((h) => Number.isFinite(h) && h > 0), "Every outcome class has a finite expiry; none is permanent");
  const stateVariant = await business(`Zulu Dental ${id}`, "Healthcare", "FL");
  const stateVariantFlorida = await business(`Zulu Dental ${id}`, "Healthcare", "Florida");
  await pool.query(`INSERT INTO sfp_serper_lookup_memory(business_id,purpose,requested_evidence,outcome_class,rule_version,input_fingerprint,observed_at,expires_at)
    SELECT b.id,'official_domain_discovery','website_domain','no_match',${identity.SERPER_MATCHER_RULE_VERSION},${memory.serperLookupInputFingerprintSql("b")},NOW(),NOW()+INTERVAL '1 day'
      FROM businesses b WHERE b.id=$1`, [stateVariant]);
  const fp = (await pool.query(`SELECT ${memory.serperLookupInputFingerprintSql("b")} fp FROM businesses b WHERE b.id=ANY($1) ORDER BY b.id`, [[stateVariant, stateVariantFlorida]])).rows;
  check(fp[0].fp === fp[1].fp, "The input fingerprint treats FL and Florida as the same state");

  // ── Exclusion is applied before the batch LIMIT ─────────────────────────────
  const bulk: number[] = [];
  for (let i = 0; i < 30; i++) bulk.push(await business(`Bulk Excluded ${i} ${id}`));
  await pool.query(`INSERT INTO sfp_serper_lookup_memory(business_id,purpose,requested_evidence,outcome_class,rule_version,input_fingerprint,observed_at,expires_at)
    SELECT b.id,'official_domain_discovery','website_domain','no_match',${identity.SERPER_MATCHER_RULE_VERSION},${memory.serperLookupInputFingerprintSql("b")},NOW(),NOW()+INTERVAL '1 day'
      FROM businesses b WHERE b.id=ANY($1)`, [bulk]);
  const fresh = await business(`Yankee Dental ${id}`);
  // Put every other fixture back under memory so the one fresh business is the only eligible row.
  await pool.query(`UPDATE sfp_serper_lookup_memory SET expires_at=NOW()+INTERVAL '1 day',claim_token=NULL,claim_expires_at=NULL,rule_version=${identity.SERPER_MATCHER_RULE_VERSION}
    WHERE business_id=ANY($1) AND outcome_class IS NOT NULL`, [[noMatch, rejected, failing]]);
  await pool.query(`INSERT INTO sfp_serper_lookup_memory(business_id,purpose,requested_evidence,outcome_class,rule_version,input_fingerprint,observed_at,expires_at)
    SELECT b.id,'official_domain_discovery','website_domain','no_match',${identity.SERPER_MATCHER_RULE_VERSION},${memory.serperLookupInputFingerprintSql("b")},NOW(),NOW()+INTERVAL '1 day'
      FROM businesses b WHERE b.id=$1`, [stateVariantFlorida]);
  const limited = await programDiscoverySelection(programId, `${actor}:limit:${randomUUID()}`, 1, "serper");
  check(limited.targets.length === 1 && Number(limited.targets[0].id) === fresh,
    "Thirty excluded businesses ahead of it cannot occupy a batch of one");

  // ── Atomic claim ────────────────────────────────────────────────────────────
  const tokens = Array.from({ length: 8 }, () => randomUUID());
  const wins = await Promise.all(tokens.map((t) => memory.claimSerperLookup(fresh, t)));
  check(wins.filter(Boolean).length === 1, "Concurrent workers: exactly one wins the claim for a business");
  check(!(await reopenSelection()).includes(fresh), "A claimed business is not selected by another worker");
  await memory.releaseSerperLookupClaim(fresh, tokens[wins.indexOf(true)]);
  check((await reopenSelection()).includes(fresh), "Releasing the claim makes the business selectable again");
  const stale = randomUUID();
  await memory.claimSerperLookup(fresh, stale);
  await pool.query(`UPDATE sfp_serper_lookup_memory SET claim_expires_at=NOW()-INTERVAL '1 minute' WHERE business_id=$1`, [fresh]);
  const takeover = randomUUID();
  check(await memory.claimSerperLookup(fresh, takeover), "An expired claim can be taken over");
  await memory.releaseSerperLookupClaim(fresh, takeover);

  // ── Provider failure retried after its short expiry ─────────────────────────
  await pool.query(`UPDATE sfp_serper_lookup_memory SET expires_at=NOW()-INTERVAL '1 minute',claim_token=NULL,claim_expires_at=NULL WHERE business_id=$1`, [failing]);
  const beforeFail = serperCalls;
  await run("retry-failure", { maxBusinesses: 5 });
  check(serperCalls > beforeFail, "An expired provider failure is retried");

  // ── Unlabeled scope: disabled by default, allowance enforced per request ────
  const unlabeled: number[] = [];
  for (let i = 0; i < 8; i++) unlabeled.push(await business(`Unlabeled Practice ${i} ${id}`, null));
  const beforeDisabled = serperCalls;
  await assert.rejects(() => run("unlabeled-off", { scope: "unlabeled" }), /SFP_UNLABELED_DISCOVERY_DISABLED/);
  check(serperCalls === beforeDisabled, "Unlabeled discovery is disabled by default and sends no request");
  const ordinary = (await programDiscoverySelection(programId, `${actor}:ordinary:${randomUUID()}`, 25, "serper")).targets.map((t: any) => Number(t.id));
  check(!ordinary.some((n: number) => unlabeled.includes(n)), "The ordinary scope never selects businesses without a vertical");
  const setGate = (value: unknown) => pool.query(
    `INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [allowanceMod.UNLABELED_DISCOVERY_SETTING_KEY, JSON.stringify(value)]);
  await setGate({ enabled: true, perRunRequests: 0, dailyRequests: 10 });
  await assert.rejects(() => run("unlabeled-zero", { scope: "unlabeled" }), /SFP_UNLABELED_DISCOVERY_DISABLED/);
  check(true, "A malformed or non-positive allowance keeps the scope closed");
  const unlabeledSelected = (await programDiscoverySelection(programId, `${actor}:unl:${randomUUID()}`, 25, "serper", "unlabeled")).targets.map((t: any) => Number(t.id));
  check(unlabeled.every((n) => unlabeledSelected.includes(n)) && !unlabeledSelected.includes(web),
    "The unlabeled scope selects only businesses with no effective vertical");

  await setGate({ enabled: true, perRunRequests: 1, dailyRequests: 100 });
  const beforeOne = serperCalls;
  await run("unlabeled-one", { scope: "unlabeled" });
  check(serperCalls - beforeOne === 1, "A per-run allowance of one stops a two-request lookup before its second request");
  const midStop = (await pool.query(`SELECT business_id FROM sfp_serper_lookup_memory WHERE business_id=ANY($1) AND outcome_class IS NOT NULL`, [unlabeled])).rows;
  check(midStop.length === 0, "A lookup stopped by the allowance records no negative memory");

  const used = await allowanceMod.readUnlabeledDiscoveryDailyUsage();
  await setGate({ enabled: true, perRunRequests: 50, dailyRequests: used.requests + 3 });
  const beforeDaily = serperCalls;
  await run("unlabeled-daily", { scope: "unlabeled" });
  check(serperCalls - beforeDaily === 3, "The daily allowance is enforced across runs and before every request");
  const unlabeledVerticals = (await pool.query(`SELECT count(*)::int n FROM businesses WHERE id=ANY($1) AND vertical IS NOT NULL`, [unlabeled])).rows[0].n;
  check(unlabeledVerticals === 0, "Unlabeled discovery never manufactures a vertical");

  const counts = (await pool.query(`SELECT
    (SELECT count(*)::integer FROM sequence_enrollments) enrollments,
    (SELECT count(*)::integer FROM communication_events) messages`)).rows[0];
  check(counts.enrollments === 0 && counts.messages === 0, "Discovery neither enrolls nor sends");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "All Serper traffic used the injected local transport; no external network attempted");
  console.log(`\nSERPER-MEMORY certification: ${checks} checks passed`);
} finally {
  globalThis.fetch = originalFetch;
  await pool.end();
}
