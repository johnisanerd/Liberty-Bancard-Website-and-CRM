import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "Serper contact-page stage certification", requireRedis: false });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { db, pool } = await import("../../server/db");
const stage = await import("../../server/services/serper-contact-page-stage");
const nonce = randomUUID().replaceAll("-", "").slice(0, 10);
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };
let seq = 0;
const enrollments0 = (await pool.query(`SELECT count(*)::int n FROM sequence_enrollments`)).rows[0].n;

async function business(label: string) {
  const domain = `${label}${nonce}.test`;
  const name = `Scp ${label} ${nonce} Dental LLC`;
  const b = (await pool.query(`INSERT INTO businesses (canonical_name,normalized_name,website_domain,city,state,record_class)
    VALUES($1,$2,$3,'Miami','FL','canonical') RETURNING id`, [name, `${name.toLowerCase()}${seq++}`, domain])).rows[0];
  return { businessId: Number(b.id), domain };
}
const lookups = async (businessId: number) => (await pool.query(
  `SELECT * FROM serper_contact_page_lookups WHERE business_id=$1 ORDER BY created_at`, [businessId])).rows;

interface Script { search?: any; pages?: Record<string, { html?: string; ok?: boolean; unreachable?: boolean }>; delayMs?: number }
function deps(script: Script, calls: { search: any[]; pages: string[] }, targets: Array<{ businessId: number; domain: string }> = [],
  gate = { enabled: true, perRunRequests: 10 }) {
  return {
    search: async (payload: object) => {
      calls.search.push(payload);
      if (script.delayMs) await new Promise(r => setTimeout(r, script.delayMs));
      return typeof script.search === "function" ? script.search(payload) : script.search;
    },
    readPage: async (url: string) => {
      calls.pages.push(url);
      const p = script.pages?.[url];
      if (!p || p.unreachable) return { status: "unreachable" as const, httpOk: false };
      return { status: "fetched" as const, httpOk: p.ok !== false, html: p.ok === false ? undefined : (p.html ?? "") };
    },
    select: async () => targets,
    sleep: async () => {},
    readGate: async () => gate,
  };
}
const fresh = () => ({ search: [] as any[], pages: [] as string[] });
const ok = (data: any) => ({ ok: true, blocked: false, status: 200, data, callSite: "t" });

try {
  // Gate: closed by default, malformed values stay closed.
  check(!stage.parseContactPageStageGate(undefined).enabled && !stage.parseContactPageStageGate({ enabled: true }).enabled
    && !stage.parseContactPageStageGate({ enabled: true, perRunRequests: 0 }).enabled
    && stage.parseContactPageStageGate({ enabled: true, perRunRequests: 3 }).perRunRequests === 3, "Gate parser fails closed");
  const closedCalls = fresh();
  const closed = await stage.runSerperContactPageStage({}, deps({}, closedCalls, [], { enabled: false, perRunRequests: 0 }));
  check(!closed.ran && closed.reason === "stage_closed" && closedCalls.search.length === 0, "Closed stage makes no provider request");

  // Staged role inbox from a first-party result page; third-party and named addresses excluded.
  const a = await business("a");
  const contactUrl = `https://${a.domain}/contact-us`;
  const callsA = fresh();
  const resA = await stage.runContactPageStageForBusiness(a, deps({
    search: ok({ searchParameters: { q: "x" }, credits: 1, organic: [
      { title: "Contact", link: contactUrl, snippet: `write bob@${a.domain}`, position: 1 },
      { title: "Yelp", link: `https://vendor-listing${nonce}.test/biz/a`, snippet: "x", position: 2 },
    ] }),
    pages: { [contactUrl]: { html: `<a href="mailto:info@${a.domain}">x</a> john.smith@${a.domain} help@vendor-agency${nonce}.test` } },
  }, callsA));
  check(resA.outcome === "candidate_staged" && resA.stagedCandidates === 1 && resA.requestSent && resA.reportedCredits === 1,
    `Role inbox staged: ${JSON.stringify(resA)}`);
  check(callsA.search.length === 1 && callsA.pages.length === 1 && callsA.pages[0] === contactUrl, "One request; only the business's own result page is read");
  const [rowA] = await lookups(a.businessId);
  check(rowA.status === "completed" && rowA.requests_used === 1 && rowA.reported_credits === 1 && rowA.query_text.includes(`site:${a.domain}`)
    && rowA.rule_version === stage.SERPER_CONTACT_PAGE_RULE_VERSION && rowA.retrieved_at && rowA.http_status === 200
    && rowA.operation_key.startsWith(`serper-contact-page:${a.businessId}:`), "Attempt retains query pin, retrieval time, usage and operation identity");
  check(rowA.result_urls.length === 2 && rowA.result_urls.find((u: any) => u.url === contactUrl)?.domainMatch === true
    && rowA.result_urls.find((u: any) => u.host.startsWith("vendor-listing"))?.domainMatch === false, "Result URLs, hosts and domain relation retained");
  check(rowA.returned_fields.includes("organic.link") && rowA.returned_fields.includes("response.credits"), "Returned field names retained");
  check(!JSON.stringify(rowA).includes("bob@") && !JSON.stringify(rowA).includes("info@"), "No addresses or snippets stored on the attempt");
  check(rowA.pages_read.length === 1 && rowA.pages_read[0].url === contactUrl, "Pages read retained");
  const cand = (await pool.query(`SELECT business_id,domain,source,attribution_scope,subject_type,disposition FROM free_discovery_candidates
    WHERE id = ANY(SELECT jsonb_array_elements_text($1::jsonb)::uuid)`, [JSON.stringify(rowA.candidate_ids)])).rows;
  check(cand.length === 1 && Number(cand[0].business_id) === a.businessId && cand[0].domain === a.domain && cand[0].source === "first_party_contact_page"
    && cand[0].attribution_scope === "role" && cand[0].subject_type === "business" && cand[0].disposition === "staged",
    "Staged as ordinary first-party business role evidence");
  check((await pool.query(`SELECT count(*)::int n FROM contacts WHERE business_id=$1`, [a.businessId])).rows[0].n === 0, "Stage creates no contact");

  // Memory: unexpired outcome excludes; changed domain or rule version reopens.
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const compiled = new PgDialect().sqlToQuery(sql`SELECT count(*)::int n FROM (SELECT id FROM businesses WHERE id=${a.businessId}) keyed WHERE ${stage.contactPageMemoryExclusion}`);
  const selectable = async () => Number((await pool.query(compiled.sql, compiled.params)).rows[0].n) === 1;
  check(!(await selectable()), "Unexpired outcome removes the business from selection");
  await pool.query(`UPDATE businesses SET website_domain=$2 WHERE id=$1`, [a.businessId, `changed${nonce}.test`]);
  check(await selectable(), "A changed website domain reopens the business");
  await pool.query(`UPDATE businesses SET website_domain=$2 WHERE id=$1`, [a.businessId, a.domain]);
  check(!(await selectable()), "Restoring the domain restores the memory");
  await pool.query(`UPDATE serper_contact_page_lookups SET rule_version=0 WHERE business_id=$1`, [a.businessId]);
  check(await selectable(), "A different rule version reopens the business");
  await pool.query(`UPDATE serper_contact_page_lookups SET rule_version=$2, expires_at=now()-interval '1 minute' WHERE business_id=$1`,
    [a.businessId, stage.SERPER_CONTACT_PAGE_RULE_VERSION]);
  check(await selectable(), "An expired outcome reopens the business");
  const again = fresh();
  const resA2 = await stage.runContactPageStageForBusiness(a, deps({ search: ok({ organic: [] }) }, again));
  check(resA2.outcome === "no_result" && (await lookups(a.businessId)).length === 2
    && new Set((await lookups(a.businessId)).map(r => r.operation_key)).size === 2, "Re-attempt after expiry gets a new operation identity");

  // Negative outcomes.
  const b = await business("b");
  const callsB = fresh();
  const resB = await stage.runContactPageStageForBusiness(b, deps({ search: ok({ organic: [] }) }, callsB));
  const [rowB] = await lookups(b.businessId);
  check(resB.outcome === "no_result" && callsB.pages.length === 0 && rowB.outcome_class === "no_result" && rowB.reported_credits === null
    && new Date(rowB.expires_at) > new Date(), "No result is remembered with an expiry; absent credits stay NULL");

  const c = await business("c");
  const resC = await stage.runContactPageStageForBusiness(c, deps({ search: ok({ organic: [{ link: `https://vendor-listing${nonce}.test/x`, position: 1 }] }) }, fresh()));
  check(resC.outcome === "no_first_party_url", "Only third-party results: nothing is read");

  const d = await business("d");
  const dUrl = `https://${d.domain}/contact`;
  const callsD = fresh();
  const resD = await stage.runContactPageStageForBusiness(d, deps({ search: ok({ organic: [{ link: dUrl, snippet: `info@${d.domain}`, position: 1 }] }), pages: { [dUrl]: { html: "<p>call us</p>" } } }, callsD));
  check(resD.outcome === "pages_no_email" && callsD.pages.length === 1, "Pages without addresses; snippet addresses are never used");

  const e = await business("e");
  const eUrl = `https://${e.domain}/team`;
  const resE = await stage.runContactPageStageForBusiness(e, deps({ search: ok({ organic: [{ link: eUrl, position: 1 }] }), pages: { [eUrl]: { html: `<a href="mailto:jane.doe@${e.domain}">Jane</a>` } } }, fresh()));
  check(resE.outcome === "no_role_email" && resE.stagedCandidates === 0, "A named address is never staged as business evidence");

  const f = await business("f");
  const fUrl = `https://${f.domain}/contact`;
  const resF = await stage.runContactPageStageForBusiness(f, deps({ search: ok({ organic: [{ link: fUrl, position: 1 }] }), pages: { [fUrl]: { unreachable: true } } }, fresh()));
  check(resF.outcome === "pages_unreadable", "Unreadable pages are remembered separately");

  // Page cap and ordering.
  const g = await business("g");
  const gUrls = ["/a", "/b", "/contact", "/c", "/about"].map(p => `https://${g.domain}${p}`);
  const callsG = fresh();
  await stage.runContactPageStageForBusiness(g, deps({ search: ok({ organic: gUrls.map((link, i) => ({ link, position: i + 1 })) }), pages: {} }, callsG));
  check(callsG.pages.length === stage.MAX_PAGES && callsG.pages[0].endsWith("/contact") && callsG.pages[1].endsWith("/about"), "Reads at most three pages, contact-like paths first");

  // Provider failure and gateway block.
  const h = await business("h");
  const resH = await stage.runContactPageStageForBusiness(h, deps({ search: { ok: false, blocked: false, status: 500, error: "x", callSite: "t" } }, fresh()));
  const [rowH] = await lookups(h.businessId);
  check(resH.outcome === "provider_failure" && rowH.status === "provider_failure" && rowH.requests_used === 1, "Provider failure counts as one request and is remembered briefly");
  const i = await business("i");
  const resI = await stage.runContactPageStageForBusiness(i, deps({ search: { ok: false, blocked: true, blockReason: "disabled", callSite: "t" } }, fresh()));
  check(resI.blocked && !resI.requestSent && (await lookups(i.businessId)).length === 0, "A gateway block records nothing and releases the claim");

  // Concurrent claims buy one lookup.
  const j = await business("j");
  const callsJ = fresh();
  const dj = deps({ search: ok({ organic: [] }), delayMs: 150 }, callsJ);
  const both = await Promise.all([stage.runContactPageStageForBusiness(j, dj), stage.runContactPageStageForBusiness(j, dj)]);
  check(callsJ.search.length === 1 && both.filter(r => r.outcome === "skipped_claimed_elsewhere").length === 1
    && (await lookups(j.businessId)).length === 1, "Concurrent claims send exactly one request");
  // An expired claim is abandoned and remembered as one request, never retried immediately.
  const k = await business("k");
  await pool.query(`INSERT INTO serper_contact_page_lookups (business_id,operation_key,domain,input_fingerprint,rule_version,claim_token,claim_expires_at,requests_used)
    VALUES($1,$2,$3,'x',$4,gen_random_uuid(),now()-interval '1 minute',1)`, [k.businessId, `serper-contact-page:${k.businessId}:old:1`, k.domain, stage.SERPER_CONTACT_PAGE_RULE_VERSION]);
  const callsK = fresh();
  await stage.runContactPageStageForBusiness(k, deps({ search: ok({ organic: [] }) }, callsK));
  const rowsK = await lookups(k.businessId);
  check(rowsK.some(r => r.status === "abandoned" && r.requests_used === 1 && r.outcome_class === "provider_failure"), "Expired claim is abandoned and counted as one request");

  // Per-run budget and consecutive failure stop.
  const t1 = await business("t1"), t2 = await business("t2"), t3 = await business("t3"), t4 = await business("t4");
  const callsR = fresh();
  const run = await stage.runSerperContactPageStage({}, deps({ search: ok({ credits: 1, organic: [] }) }, callsR, [t1, t2, t3, t4], { enabled: true, perRunRequests: 2 }));
  check(run.ran && run.requests === 2 && run.examined === 2 && run.stoppedBy === "per_run_requests" && run.reportedCredits === 2 && callsR.search.length === 2,
    `Per-run request limit holds: ${JSON.stringify(run)}`);
  const u1 = await business("u1"), u2 = await business("u2"), u3 = await business("u3"), u4 = await business("u4");
  const failRun = await stage.runSerperContactPageStage({}, deps({ search: { ok: false, blocked: false, status: 500, error: "x", callSite: "t" } }, fresh(), [u1, u2, u3, u4]));
  check(failRun.stoppedBy === "consecutive_provider_failures" && failRun.requests === 3, "Three consecutive provider failures stop the run");

  // The real selector (same ladder as the backlog read model) executes and excludes unclassified businesses.
  const program = (await pool.query(`SELECT 1 FROM sfp_programs WHERE is_active AND taxonomy_version=2 LIMIT 1`)).rows[0];
  if (!program) await pool.query(`INSERT INTO sfp_programs (name,county_fips,vertical_ids,is_active,taxonomy_version,created_by)
    VALUES($1,ARRAY['12086'],ARRAY['dental'],true,2,'cert')`, [`scp-${nonce}`]);
  const { selectBusinessesAfterFreeEmailSearch } = await import("../../server/services/canonical-enrichment-backlog");
  const picked = await selectBusinessesAfterFreeEmailSearch({ limit: 5, extraWhere: stage.contactPageMemoryExclusion });
  check(Array.isArray(picked) && !picked.some(x => x.businessId === a.businessId), "Real selector runs; unclassified fixtures are not selected");

  // Yield report separates requests from reported credits.
  const y = await stage.readSerperContactPageYield();
  check(y.requests >= 10 && y.stagedCandidates === 1 && y.businessesWithStagedEmail === 1 && y.requestsWithoutReportedCredits > 0
    && !y.creditsReportedComplete && y.reportedCredits >= 3 && y.businessesQualified === 0 && y.byOutcome.candidate_staged === 1,
    `Yield separates requests, credits and outcomes: ${JSON.stringify(y)}`);
  check((await pool.query(`SELECT count(*)::int n FROM sequence_enrollments`)).rows[0].n === enrollments0, "Stage enrolls nobody");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider network attempt");
  console.log(`Serper contact-page stage: ${checks} checks passed`);
} finally { await pool.end(); }
