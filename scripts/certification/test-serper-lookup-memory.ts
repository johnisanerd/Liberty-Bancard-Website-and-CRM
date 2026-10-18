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
/** Credits the fake provider reports per request; null omits the field (unknown charge). */
let chargeCredits: number | null = 1;
const credited = (body: any) => (chargeCredits === null ? body : { ...body, credits: chargeCredits });
const queries: string[] = [];
const place = (title: string, website: string | null) => ({
  title, address: "101 Health Avenue, Miami, FL 33130", website, phoneNumber: "(305) 555-0123", category: "Medical clinic",
});
const respond = (path: string, q: string): Response => {
  const text = q.toLowerCase();
  if (path === "/search") return { status: 200, body: credited({ organic: [] }) };
  if (text.includes("cedar dental")) return { status: 200, body: credited({ places: [place(`Cedar Dental ${id}`, "https://www.cedar-dental.example")] }) };
  if (text.includes("bravo clinic")) return { status: 200, body: credited({ places: [place(`Bravo Clinic ${id}`, null)] }) };
  if (text.includes("delta pharmacy")) return { status: 200, body: credited({ places: [place("Omega Hardware Supply", "https://omega-hardware.example")] }) };
  if (text.includes("echo therapy")) return { status: 500, body: { message: "upstream error" } };
  return { status: 200, body: credited({ places: [] }) };
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

  // ── Inputs are pinned at claim time: an old outcome cannot suppress new inputs ──
  const inputsA = { canonicalName: `Yankee Dental ${id}`, streetAddress: "101 Health Avenue", city: "Miami", state: "FL", postalCode: "33130" };
  const fpA = await memory.serperLookupInputsFingerprint(inputsA);
  const currentFp = async (b: number) => (await pool.query(`SELECT ${memory.serperLookupInputFingerprintSql("b")} fp FROM businesses b WHERE b.id=$1`, [b])).rows[0].fp;
  check(fpA === await currentFp(fresh), "The explicit-input fingerprint equals the stored-row fingerprint");
  const pinToken = randomUUID();
  check(await memory.claimSerperLookup(fresh, pinToken, inputsA), "A claim pins the exact inputs the lookup is sent with");
  check((await pool.query(`SELECT claim_input_fingerprint FROM sfp_serper_lookup_memory WHERE business_id=$1`, [fresh])).rows[0].claim_input_fingerprint === fpA,
    "The pinned fingerprint is stored with the claim");
  await pool.query(`UPDATE businesses SET canonical_name=$2,normalized_name=lower($2) WHERE id=$1`, [fresh, `Yankee Dental Renamed ${id}`]);
  check(await memory.recordSerperLookupOutcome({ businessId: fresh, claimToken: randomUUID(), outcome: { kind: "no_result", requestsUsed: 2 } as any, discoveredDomain: false }) === null,
    "A wrong claim token cannot write an outcome (token fencing preserved)");
  check(await memory.recordSerperLookupOutcome({ businessId: fresh, claimToken: pinToken, outcome: { kind: "no_result", requestsUsed: 2 } as any, discoveredDomain: false }) === "no_match",
    "The claim holder records the outcome after the business changed in flight");
  const storedFp = (await pool.query(`SELECT input_fingerprint,claim_input_fingerprint FROM sfp_serper_lookup_memory WHERE business_id=$1`, [fresh])).rows[0];
  check(storedFp.input_fingerprint === fpA && storedFp.input_fingerprint !== await currentFp(fresh) && storedFp.claim_input_fingerprint === null,
    "The outcome is stored under the pinned inputs, not the changed ones, and the pin is cleared");
  check((await reopenSelection()).includes(fresh), "An outcome for the old inputs does not suppress the changed inputs");
  const staleSelection = randomUUID();
  check(!(await memory.claimSerperLookup(fresh, staleSelection, inputsA)), "A selection made under old inputs cannot claim after the inputs changed");
  check((await pool.query(`SELECT claim_token FROM sfp_serper_lookup_memory WHERE business_id=$1`, [fresh])).rows[0].claim_token === null,
    "A refused stale claim leaves no live claim");
  await pool.query(`UPDATE businesses SET canonical_name=$2,normalized_name=lower($2) WHERE id=$1`, [fresh, inputsA.canonicalName]);
  check(!(await reopenSelection()).includes(fresh), "Restoring the original inputs restores the exclusion for the original outcome");
  await pool.query(`DELETE FROM sfp_serper_lookup_memory WHERE business_id=$1`, [fresh]);

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
  const ledger = async () => (await pool.query(`SELECT count(*) FILTER (WHERE state<>'not_sent')::int requests,
    COALESCE(sum(COALESCE(settled_credits,reserved_credits)) FILTER (WHERE state<>'not_sent'),0)::int credits FROM sfp_serper_credit_ledger`)).rows[0];
  const resetAllowance = async () => {
    await pool.query(`DELETE FROM sfp_serper_credit_ledger`);
    await pool.query(`DELETE FROM serper_lookup_attempts`);
    await pool.query(`DELETE FROM sfp_serper_lookup_memory WHERE business_id=ANY($1)`, [unlabeled]);
    // Age the separate provider-operation cooldown so each schedule starts from the same pool.
    await pool.query(`UPDATE provider_operations SET created_at=created_at-INTERVAL '3 days' WHERE target_fingerprint LIKE 'business:%' AND created_at>NOW()-INTERVAL '2 days'`);
  };
  const gate = (over: Record<string, unknown> = {}) => ({ enabled: true, perRunRequests: 50, dailyRequests: 500, dailyCredits: 100, maxCreditsPerRequest: 3, ...over });

  // Gate parsing: a request-only or legacy credit setting cannot enforce a credit cap and stays closed.
  for (const bad of [
    { enabled: true, perRunRequests: 0, dailyRequests: 10, dailyCredits: 10, maxCreditsPerRequest: 1 },
    { enabled: true, perRunRequests: 5, dailyRequests: 10 },
    { enabled: true, perRunRequests: 5, dailyRequests: 10, dailyReportedCredits: 10 },
    { enabled: true, perRunRequests: 5, dailyRequests: 10, dailyCredits: 10 },
    { enabled: true, perRunRequests: 5, dailyRequests: 10, dailyCredits: 2, maxCreditsPerRequest: 3 },
  ]) {
    check(!allowanceMod.parseUnlabeledDiscoveryGate(bad).enabled, `Closed gate: ${JSON.stringify(bad)}`);
  }
  // The daily limits are optional; the per-request maximum and per-run limit are not.
  {
    const open = allowanceMod.parseUnlabeledDiscoveryGate({ enabled: true, perRunRequests: 5, maxCreditsPerRequest: 3 });
    check(open.enabled && open.dailyRequests === null && open.dailyCredits === null && open.maxCreditsPerRequest === 3,
      "A setting with no daily limits is enabled and records no daily ceiling");
    for (const malformed of [{ dailyRequests: 0 }, { dailyCredits: -1 }, { dailyCredits: "100" }, { dailyCredits: 2 }]) {
      check(!allowanceMod.parseUnlabeledDiscoveryGate({ enabled: true, perRunRequests: 5, maxCreditsPerRequest: 3, ...malformed }).enabled,
        `A malformed daily limit never becomes 'no limit': ${JSON.stringify(malformed)}`);
    }
    check(!allowanceMod.parseUnlabeledDiscoveryGate({ enabled: true, maxCreditsPerRequest: 3 }).enabled &&
      !allowanceMod.parseUnlabeledDiscoveryGate({ enabled: true, perRunRequests: 5 }).enabled,
      "The per-run limit and the per-request maximum stay required");
    await resetAllowance();
    const allowance = allowanceMod.createDurableRequestAllowance(open, randomUUID());
    let sent = 0;
    for (let i = 0; i < 5; i++) {
      if (!(await allowance.authorizeRequest({ endpoint: "/places" }))) break;
      sent++;
      await allowance.onRequestSettled({ endpoint: "/places", reportedCredits: 3 });
    }
    check(sent === 5 && allowance.snapshot().denial === null && !(await allowance.authorizeRequest({ endpoint: "/places" })) &&
      allowance.snapshot().denial === "per_run_requests",
      "Without daily limits requests are bounded only by the per-run limit, and each is still ledgered");
    await resetAllowance();
  }
  await setGate({ enabled: true, perRunRequests: 5, dailyRequests: 10, dailyReportedCredits: 10 });
  await assert.rejects(() => run("unlabeled-zero", { scope: "unlabeled" }), /SFP_UNLABELED_DISCOVERY_DISABLED/);
  check(true, "A setting without a hard credit cap keeps the scope closed");
  const unlabeledSelected = (await programDiscoverySelection(programId, `${actor}:unl:${randomUUID()}`, 25, "serper", "unlabeled")).targets.map((t: any) => Number(t.id));
  check(unlabeled.every((n) => unlabeledSelected.includes(n)) && !unlabeledSelected.includes(web),
    "The unlabeled scope selects only businesses with no effective vertical");

  // ── Allowance-stopped run: truthful counts, preserved work, safe continuation ──
  await resetAllowance();
  await setGate(gate({ perRunRequests: 1 }));
  const beforeOne = serperCalls;
  const stopped: any = await run("unlabeled-one", { scope: "unlabeled" });
  check(serperCalls - beforeOne === 1, "A per-run allowance of one stops a two-request lookup before its second request");
  check(stopped.selected === unlabeled.length && stopped.allowanceDeferred === stopped.selected && stopped.processed === 0 &&
    stopped.attempted === 1 && String(stopped.stopReason).startsWith("allowance_exhausted"),
    `The stopped run reports selected ${stopped.selected}, attempted ${stopped.attempted}, processed ${stopped.processed}, deferred ${stopped.allowanceDeferred}, reason ${stopped.stopReason}`);
  const stoppedRow = (await pool.query(`SELECT state,selected_count,processed_count,terminal_reason FROM sfp_stage_runs WHERE idempotency_key=$1`, [`${actor}:unlabeled-one`])).rows[0];
  check(stoppedRow.state === "partial" && stoppedRow.selected_count === unlabeled.length && stoppedRow.processed_count === 0 &&
    String(stoppedRow.terminal_reason).startsWith("allowance_exhausted"), "The stage run is partial with a visible stop reason, not completed");
  const midStop = (await pool.query(`SELECT business_id FROM sfp_serper_lookup_memory WHERE business_id=ANY($1) AND outcome_class IS NOT NULL`, [unlabeled])).rows;
  check(midStop.length === 0, "A lookup stopped by the allowance records no negative memory");
  const liveClaims = (await pool.query(`SELECT count(*)::int n FROM sfp_serper_lookup_memory WHERE business_id=ANY($1) AND claim_token IS NOT NULL`, [unlabeled])).rows[0].n;
  check(liveClaims === 0, "No claim is left behind by the stopped run");
  const remaining = (await programDiscoverySelection(programId, `${actor}:unl2:${randomUUID()}`, 25, "serper", "unlabeled")).targets.map((t: any) => Number(t.id));
  const partlyPaid = (await pool.query(`SELECT business_id FROM sfp_stage_items WHERE outcome_code='allowance_deferred'
    AND stage_run_id=(SELECT id FROM sfp_stage_runs WHERE idempotency_key=$1)`, [`${actor}:unlabeled-one`])).rows.map((r) => Number(r.business_id));
  check(partlyPaid.length === 1 && unlabeled.includes(partlyPaid[0]), "Exactly the one business stopped mid-lookup is marked allowance_deferred");
  check(unlabeled.filter((n) => n !== partlyPaid[0]).every((n) => remaining.includes(n)),
    "Every business the run never reached remains immediately selectable");
  check(!remaining.includes(partlyPaid[0]), "The partly paid business stays behind the existing 24-hour provider-operation cooldown");
  await pool.query(`UPDATE provider_operations SET created_at=created_at-INTERVAL '3 days' WHERE target_fingerprint LIKE 'business:%'`);
  await setGate(gate());
  const beforeContinue = serperCalls;
  const continued: any = await run("unlabeled-continue", { scope: "unlabeled" });
  check(continued.allowanceDeferred === 0 && continued.stopReason === null && continued.processed === unlabeled.length && continued.attempted === unlabeled.length,
    "A fresh ordinary run key continues and completes every deferred business");
  const outcomes = (await pool.query(`SELECT count(*)::int n FROM sfp_serper_lookup_memory WHERE business_id=ANY($1) AND outcome_class IS NOT NULL`, [unlabeled])).rows[0].n;
  check(outcomes === unlabeled.length && serperCalls > beforeContinue, "Continuation records one outcome per business");
  const dupEvidence = (await pool.query(`SELECT count(*)::int n FROM (SELECT business_id,field,normalized_value_hash FROM sfp_paid_candidate_evidence WHERE business_id=ANY($1)
    GROUP BY 1,2,3 HAVING count(*)>1) d`, [unlabeled])).rows[0].n;
  check(dupEvidence === 0, "Continuation creates no duplicate evidence");

  // ── Hard credit cap: reservation before each request ──────────────────────
  // Next-request overshoot: cap 10, each request really charges 3, bound 3.
  await resetAllowance(); chargeCredits = 3;
  await setGate(gate({ dailyCredits: 10, maxCreditsPerRequest: 3 }));
  let c0 = serperCalls;
  const overshoot: any = await run("cap-overshoot", { scope: "unlabeled" });
  const l1 = await ledger();
  check(serperCalls - c0 === 3 && l1.credits === 9 && l1.credits <= 10,
    `Cap 10 with 3-credit requests stops at ${serperCalls - c0} requests / ${l1.credits} credits, never above the cap`);
  check(overshoot.allowanceDeferred > 0 && String(overshoot.stopReason).includes("daily_credits"), "The run reports the credit-cap stop reason");
  // Missing charge fields: unknown stays at the reserved worst case, never zero.
  await resetAllowance(); chargeCredits = null;
  await setGate(gate({ dailyCredits: 10, maxCreditsPerRequest: 3 }));
  c0 = serperCalls;
  await run("cap-unknown", { scope: "unlabeled" });
  const l2 = await ledger();
  const unknownRows = (await pool.query(`SELECT count(*)::int n FROM sfp_serper_credit_ledger WHERE state='settled_unknown' AND settled_credits IS NULL`)).rows[0].n;
  check(serperCalls - c0 === 3 && l2.credits === 9 && unknownRows === 3,
    "Requests with no reported charge keep their reserved worst case; the cap still holds");
  // The reproduced schedule: cap 6, attested maximum 1, provider really charges 5 per request.
  // Reservations are serialized and the first over-bound charge closes the scope, so the loss is
  // one request's excess, not six requests' worth (30 credits).
  await resetAllowance(); chargeCredits = 5;
  await setGate(gate({ dailyCredits: 6, maxCreditsPerRequest: 1 }));
  c0 = serperCalls;
  const wrong: any = await run("cap-wrong-attestation", { scope: "unlabeled" });
  const l3 = await ledger();
  check(serperCalls - c0 === 1 && l3.credits === 5 && String(wrong.stopReason).includes("bound_exceeded"),
    `A wrong attested maximum (1 vs 5 charged) stops after ${serperCalls - c0} request / ${l3.credits} credits with reason ${wrong.stopReason}`);
  await assert.rejects(() => run("cap-wrong-attestation-2", { scope: "unlabeled" }), /ALLOWANCE_EXHAUSTED:bound_exceeded/);
  check(true, "The scope stays closed until the maximum is re-attested");
  await setGate(gate({ dailyCredits: 30, maxCreditsPerRequest: 5 }));
  c0 = serperCalls;
  await run("cap-reattested", { scope: "unlabeled" });
  const l3b = await ledger();
  check(serperCalls > c0 && l3b.credits <= 30, `After re-attesting a maximum of 5 the scope resumes and stays within the cap (${l3b.credits} credits)`);
  // Telemetry history alone (any caller, any age) invalidates a too-small attestation.
  await resetAllowance();
  await pool.query(`INSERT INTO serper_lookup_attempts(correlation_hash,caller,strategy_name,endpoint,outcome_kind,reported_credits,created_at)
    VALUES('history','cert','s','/places','no_result',4,NOW()-INTERVAL '90 days')`);
  await setGate(gate({ dailyCredits: 30, maxCreditsPerRequest: 3 }));
  c0 = serperCalls;
  await assert.rejects(() => run("cap-telemetry-history", { scope: "unlabeled" }), /ALLOWANCE_EXHAUSTED:bound_exceeded/);
  check(serperCalls === c0, "A 90-day-old reported charge above the attested maximum still closes the scope");
  chargeCredits = 1;
  // Failed telemetry writes cannot weaken the ledger.
  await resetAllowance(); chargeCredits = 3;
  await pool.query(`CREATE OR REPLACE FUNCTION cert_telemetry_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'telemetry down'; END $$`);
  await pool.query(`CREATE TRIGGER cert_telemetry_fail BEFORE INSERT ON serper_lookup_attempts FOR EACH ROW EXECUTE FUNCTION cert_telemetry_fail()`);
  try {
    await setGate(gate({ dailyCredits: 10, maxCreditsPerRequest: 3 }));
    c0 = serperCalls;
    await run("cap-telemetry-down", { scope: "unlabeled" });
    const l4 = await ledger();
    const telemetryRows = (await pool.query(`SELECT count(*)::int n FROM serper_lookup_attempts`)).rows[0].n;
    check(telemetryRows === 0 && serperCalls - c0 === 3 && l4.credits === 9, "With every telemetry write failing, the ledger alone still enforces the credit cap");
  } finally {
    await pool.query(`DROP TRIGGER cert_telemetry_fail ON serper_lookup_attempts`);
  }
  // Concurrent allowances (different runs/businesses) cannot jointly exceed the caps.
  await resetAllowance();
  const parallelGate = allowanceMod.parseUnlabeledDiscoveryGate(gate({ dailyRequests: 1, dailyCredits: 10, maxCreditsPerRequest: 3 }));
  const authorizeAndSettle = async (a: any) => {
    const ok = await a.authorizeRequest({ endpoint: "/places" });
    if (ok) await a.onRequestSettled({ endpoint: "/places", reportedCredits: 3 });
    return ok;
  };
  const reqRace = await Promise.all(Array.from({ length: 6 }, () =>
    authorizeAndSettle(allowanceMod.createDurableRequestAllowance(parallelGate, randomUUID()))));
  check(reqRace.filter(Boolean).length === 1 && (await ledger()).requests === 1, "Six concurrent runs against a one-request daily cap authorize exactly one request");
  await resetAllowance();
  const creditGate = allowanceMod.parseUnlabeledDiscoveryGate(gate({ dailyRequests: 100, dailyCredits: 7, maxCreditsPerRequest: 3 }));
  const creditRace = await Promise.all(Array.from({ length: 8 }, () =>
    authorizeAndSettle(allowanceMod.createDurableRequestAllowance(creditGate, randomUUID()))));
  check(creditRace.filter(Boolean).length === 2 && (await ledger()).credits === 6, "Eight concurrent runs against a 7-credit cap reserve at most two 3-credit requests");
  // At most one request in flight across runs: a second run waits for the first to settle.
  await resetAllowance();
  const flightGate = allowanceMod.parseUnlabeledDiscoveryGate(gate({ dailyCredits: 30, maxCreditsPerRequest: 3 }));
  const runA = allowanceMod.createDurableRequestAllowance(flightGate, randomUUID());
  const runB = allowanceMod.createDurableRequestAllowance(flightGate, randomUUID(), undefined, { inFlightWaitMs: 400 });
  check(await runA.authorizeRequest({ endpoint: "/places" }), "First run reserves its request");
  check(!(await runB.authorizeRequest({ endpoint: "/places" })) && runB.snapshot().denial === "request_in_flight",
    "A second run cannot reserve while the first request is unsettled");
  const runC = allowanceMod.createDurableRequestAllowance(flightGate, randomUUID(), undefined, { inFlightWaitMs: 5000 });
  const waiting = runC.authorizeRequest({ endpoint: "/places" });
  setTimeout(() => { void runA.onRequestSettled({ endpoint: "/places", reportedCredits: 1 }); }, 500);
  check(await waiting, "A waiting run proceeds once the in-flight request settles");
  // Retries and a lookup's second request: each physical request reserves separately.
  await resetAllowance();
  const retryAllowance = allowanceMod.createDurableRequestAllowance(allowanceMod.parseUnlabeledDiscoveryGate(gate({ dailyCredits: 9, maxCreditsPerRequest: 3 })), randomUUID());
  const seq: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const ok = await retryAllowance.authorizeRequest({ endpoint: i % 2 ? "/search" : "/places" });
    seq.push(ok);
    if (ok) await retryAllowance.onRequestSettled({ endpoint: "/places", reportedCredits: null });
  }
  check(seq.join() === "true,true,true,false,false" && (await ledger()).credits === 9, "Retries and second requests each reserve their own worst case");
  // A request blocked locally is released and does not consume the allowance.
  await resetAllowance();
  const blockedAllowance = allowanceMod.createDurableRequestAllowance(allowanceMod.parseUnlabeledDiscoveryGate(gate({ dailyCredits: 3, maxCreditsPerRequest: 3 })), randomUUID());
  check(await blockedAllowance.authorizeRequest({ endpoint: "/places" }), "First request reserves the whole cap");
  await blockedAllowance.onRequestNotSent({ endpoint: "/places" });
  check(await blockedAllowance.authorizeRequest({ endpoint: "/places" }), "A request that never reached the provider is released");
  // Ledger unavailable: fail closed.
  await resetAllowance();
  await pool.query(`ALTER TABLE sfp_serper_credit_ledger RENAME TO sfp_serper_credit_ledger_off`);
  try {
    await setGate(gate());
    c0 = serperCalls;
    await assert.rejects(() => run("cap-ledger-down", { scope: "unlabeled" }), /SFP_UNLABELED_DISCOVERY_ALLOWANCE_EXHAUSTED/);
    check(serperCalls === c0, "When the ledger cannot be read, no Serper request is sent");
  } finally {
    await pool.query(`ALTER TABLE sfp_serper_credit_ledger_off RENAME TO sfp_serper_credit_ledger`);
  }
  chargeCredits = 1;
  // ── Completed-key replay uses the ORIGINAL stored selection and request payload ──
  await resetAllowance();
  await pool.query(`UPDATE provider_operations SET created_at=created_at-INTERVAL '3 days' WHERE target_fingerprint LIKE 'business:%'`);
  await setGate(gate());
  const replayKey = `replay-${randomUUID()}`;
  const original: any = await run(replayKey, { scope: "unlabeled", maxBusinesses: 3 });
  const origRow = (await pool.query(`SELECT state,payload_hash,selection_snapshot FROM sfp_stage_runs WHERE idempotency_key=$1`, [`${actor}:${replayKey}`])).rows[0];
  check(original.replayed === false && origRow.state === "completed" && original.attempted === 3, "The original run completes three businesses");
  const callsBeforeReplay = serperCalls;
  const opsBefore = (await pool.query(`SELECT count(*)::int n FROM provider_operations`)).rows[0].n;
  const replay: any = await run(replayKey, { scope: "unlabeled", maxBusinesses: 3 });
  check(replay.replayed === true && replay.processed === original.processed && serperCalls === callsBeforeReplay &&
    (await pool.query(`SELECT count(*)::int n FROM provider_operations`)).rows[0].n === opsBefore,
    "A same-payload replay of a completed key returns the stored result with no purchase, even though the live pool has changed");
  await assert.rejects(() => run(replayKey, { scope: "unlabeled", maxBusinesses: 4 }), /SFP_IDEMPOTENCY_PAYLOAD_MISMATCH/);
  check(serperCalls === callsBeforeReplay, "A changed request under the same key is rejected without a purchase");
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
