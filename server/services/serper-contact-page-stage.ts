/**
 * Serper contact-page stage.
 *
 * For accepted, in-territory businesses whose free website email search finished with nothing usable (and which
 * hold no staged, main or contact email), spend ONE Serper /search request to find the business's own contact
 * pages, read at most MAX_PAGES of them with the bounded first-party reader, and stage any role inbox found as
 * ordinary first-party evidence. The existing staged-email materializer, audited relationship writer and recipient
 * preparation take it from there; this stage creates no contact, link, queue, enrollment or send.
 *
 * Rules:
 *  - Only the existing SerperGateway is used. Gateway blocks stop the run and record nothing.
 *  - Only result URLs on the business's own registrable domain are read. Snippets and titles are never mined for
 *    addresses and are not stored; only the URL, host, position and the returned field NAMES are retained.
 *  - Each attempt is one durable row: the claim (one active claim per business), the idempotent operation key, the
 *    retained provider evidence, request count versus reported credits (NULL = not reported), and the remembered
 *    outcome. Unchanged inputs are not bought again until the outcome expires or the rule version changes.
 *  - The stage is closed unless system_settings.serper_contact_page_stage is {enabled:true, perRunRequests:N>0}. It
 *    shares no allowance with the unlabeled-discovery scope and adds no cap of its own beyond the per-run limit.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import type { SerperGatewayResult } from "./serper-gateway";
import {
  extractCandidatesFromPage, isRoleInboxEmail, registrableDomain, selectContactDiscoveryEmail,
} from "./sdr/contactpage-enrichment";

/** Bump when query construction, URL selection, page reading or acceptance can change an outcome. */
export const SERPER_CONTACT_PAGE_RULE_VERSION = 1;
export const SERPER_CONTACT_PAGE_SETTING_KEY = "serper_contact_page_stage";
export const SERPER_CONTACT_PAGE_CALL_SITE = "serper-contact-page-stage";
export const MAX_RESULT_URLS = 10;
export const MAX_PAGES = 3;
export const MAX_STAGED_PER_BUSINESS = 3;
const NEGATIVE_TTL_DAYS = 30;
const UNREADABLE_TTL_DAYS = 7;
const FAILURE_TTL_MS = 60 * 60 * 1000;
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const PAGE_GAP_MS = 500;

const rows = (result: any): any[] => result?.rows ?? result ?? [];

export interface ContactPageStageGate { enabled: boolean; perRunRequests: number }
export function parseContactPageStageGate(raw: unknown): ContactPageStageGate {
  const v = raw as any;
  if (v && v.enabled === true && Number.isInteger(v.perRunRequests) && v.perRunRequests > 0) {
    return { enabled: true, perRunRequests: v.perRunRequests };
  }
  return { enabled: false, perRunRequests: 0 };
}
export async function readContactPageStageGate(): Promise<ContactPageStageGate> {
  const row = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key=${SERPER_CONTACT_PAGE_SETTING_KEY}`))[0];
  return parseContactPageStageGate(row?.value);
}

/** Lowercase host without scheme, www, path, query or fragment. Mirrored in SQL by contactPageMemoryExclusion. */
export function normalizeStageDomain(raw: string): string {
  return String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}
export function contactPageQuery(domain: string): string {
  return `site:${domain} (contact OR "contact us" OR email)`;
}
const fingerprintOf = (domain: string) => crypto.createHash("sha256")
  .update(JSON.stringify({ domain, query: contactPageQuery(domain), rule: SERPER_CONTACT_PAGE_RULE_VERSION })).digest("hex");

/** Selector exclusion: an unexpired claim, or an unexpired outcome under the same domain and rule version. */
export const contactPageMemoryExclusion = sql`NOT EXISTS (
  SELECT 1 FROM serper_contact_page_lookups l, businesses bx
   WHERE l.business_id = keyed.id AND bx.id = keyed.id AND (
     (l.status = 'claimed' AND l.claim_expires_at > now())
     OR (l.status <> 'claimed' AND l.expires_at > now() AND l.rule_version = ${SERPER_CONTACT_PAGE_RULE_VERSION}
         AND l.domain = split_part(regexp_replace(lower(btrim(bx.website_domain)),'^(https?://)?(www[.])?','','i'),'/',1))))`;

export interface PageRead { status: "fetched" | "unreachable"; httpOk: boolean; html?: string }
export interface ContactPageStageDeps {
  search: (payload: object) => Promise<SerperGatewayResult>;
  readPage: (url: string) => Promise<PageRead>;
  select: (limit: number) => Promise<Array<{ businessId: number; domain: string }>>;
  sleep: (ms: number) => Promise<void>;
  readGate: () => Promise<ContactPageStageGate>;
}

async function defaultDeps(): Promise<ContactPageStageDeps> {
  const { serperGateway } = await import("./serper-gateway");
  const { selectBusinessesAfterFreeEmailSearch } = await import("./canonical-enrichment-backlog");
  const { isSafeFetchTarget } = await import("./sdr/url-safety");
  const { safeFetch } = await import("./sdr/safe-fetch");
  return {
    search: payload => serperGateway.executeSearch("/search", payload, SERPER_CONTACT_PAGE_CALL_SITE),
    readPage: async url => {
      if (!(await isSafeFetchTarget(url))) return { status: "unreachable", httpOk: false };
      const resp = await safeFetch(url, { timeoutMs: 10000 });
      if (!resp) return { status: "unreachable", httpOk: false };
      return { status: "fetched", httpOk: resp.ok, html: resp.ok ? (resp.body ?? "") : undefined };
    },
    select: limit => selectBusinessesAfterFreeEmailSearch({ limit, extraWhere: contactPageMemoryExclusion }),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    readGate: readContactPageStageGate,
  };
}

interface ResultUrl { url: string; host: string; position: number | null; domainMatch: boolean }

export function parseSearchResults(data: any, domain: string): {
  resultUrls: ResultUrl[]; returnedFields: string[]; credits: number | null; organicCount: number;
} {
  const organic: any[] = Array.isArray(data?.organic) ? data.organic : [];
  const fields = new Set<string>(Object.keys(data && typeof data === "object" ? data : {}).map(k => `response.${k}`));
  const site = registrableDomain(domain);
  const resultUrls: ResultUrl[] = [];
  for (const item of organic.slice(0, MAX_RESULT_URLS)) {
    for (const k of Object.keys(item ?? {})) fields.add(`organic.${k}`);
    let parsed: URL | null = null;
    try { parsed = new URL(String(item?.link ?? "")); } catch { parsed = null; }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) continue;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    resultUrls.push({
      url: `${parsed.origin}${parsed.pathname}${parsed.search}`.slice(0, 400), host,
      position: Number.isFinite(item?.position) ? Number(item.position) : null,
      domainMatch: registrableDomain(host) === site,
    });
  }
  const credits = typeof data?.credits === "number" && Number.isFinite(data.credits) && data.credits >= 0
    ? Math.round(data.credits) : null;
  return { resultUrls, returnedFields: [...fields].sort(), credits, organicCount: organic.length };
}

const ASSET_PATH = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|mp3)$/i;
const CONTACT_PATH = /contact|reach|connect|touch|about|team|staff|location|visit|office/i;
export function chooseContactPages(urls: ResultUrl[]): ResultUrl[] {
  const seen = new Set<string>();
  const usable = urls.filter(u => {
    if (!u.domainMatch || ASSET_PATH.test(new URL(u.url).pathname) || seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });
  const score = (u: ResultUrl) => (CONTACT_PATH.test(new URL(u.url).pathname) ? 0 : 1);
  return usable.map((u, i) => ({ u, i })).sort((a, b) => score(a.u) - score(b.u) || a.i - b.i).slice(0, MAX_PAGES).map(x => x.u);
}

export interface BusinessStageResult {
  businessId: number;
  outcome: string;
  requestSent: boolean;
  reportedCredits: number | null;
  stagedCandidates: number;
}

async function finish(id: string, token: string, f: {
  status: "completed" | "provider_failure"; outcome: string; ttlMs: number; httpStatus?: number | null; credits?: number | null;
  retrievedAt?: Date | null; fields?: string[]; urls?: ResultUrl[]; pages?: unknown[]; candidateIds?: string[]; generationId?: string | null;
}): Promise<boolean> {
  const done = rows(await db.execute(sql`
    UPDATE serper_contact_page_lookups SET status=${f.status}, outcome_class=${f.outcome}, completed_at=now(),
           expires_at=now() + (${f.ttlMs}::bigint * interval '1 millisecond'), http_status=${f.httpStatus ?? null},
           reported_credits=${f.credits ?? null}, retrieved_at=${f.retrievedAt ? f.retrievedAt.toISOString() : null}::timestamptz,
           returned_fields=${JSON.stringify(f.fields ?? [])}::jsonb, result_urls=${JSON.stringify(f.urls ?? [])}::jsonb,
           pages_read=${JSON.stringify(f.pages ?? [])}::jsonb, candidate_ids=${JSON.stringify(f.candidateIds ?? [])}::jsonb,
           generation_id=${f.generationId ?? null}::uuid
     WHERE id=${id}::uuid AND claim_token=${token}::uuid AND status='claimed' RETURNING id`));
  return done.length === 1;
}

/** Runs one business. Never throws for provider/page failures; returns `blocked` when the shared gateway refused. */
export async function runContactPageStageForBusiness(
  target: { businessId: number; domain: string }, deps: ContactPageStageDeps,
): Promise<BusinessStageResult & { blocked?: boolean }> {
  const domain = normalizeStageDomain(target.domain);
  const base = { businessId: target.businessId, requestSent: false, reportedCredits: null as number | null, stagedCandidates: 0 };
  if (!domain || !domain.includes(".")) return { ...base, outcome: "skipped_no_domain" };
  const fingerprint = fingerprintOf(domain);
  const token = crypto.randomUUID();
  // Expired claims from a crashed run: the request may have been sent, so they count as one request and are remembered
  // briefly as a failure rather than being retried immediately.
  await db.execute(sql`UPDATE serper_contact_page_lookups SET status='abandoned', outcome_class='provider_failure',
      completed_at=now(), expires_at=now() + interval '1 hour'
    WHERE business_id=${target.businessId} AND status='claimed' AND claim_expires_at <= now()`);
  const attemptNo = Number(rows(await db.execute(sql`SELECT count(*)::int n FROM serper_contact_page_lookups
    WHERE business_id=${target.businessId}`))[0].n) + 1;
  const operationKey = `serper-contact-page:${target.businessId}:${fingerprint.slice(0, 16)}:${attemptNo}`;
  const query = contactPageQuery(domain);
  const claim = rows(await db.execute(sql`
    INSERT INTO serper_contact_page_lookups (business_id, operation_key, domain, input_fingerprint, rule_version, claim_token,
        claim_expires_at, query_text)
    VALUES (${target.businessId}, ${operationKey}, ${domain}, ${fingerprint}, ${SERPER_CONTACT_PAGE_RULE_VERSION}, ${token}::uuid,
        now() + (${CLAIM_LEASE_MS}::bigint * interval '1 millisecond'), ${query})
    ON CONFLICT DO NOTHING RETURNING id`))[0];
  if (!claim) return { ...base, outcome: "skipped_claimed_elsewhere" };
  const id = String(claim.id);

  // Reserve the request before sending: a crash after this point is counted as one request, never as zero.
  await db.execute(sql`UPDATE serper_contact_page_lookups SET requests_used=1, requested_at=now() WHERE id=${id}::uuid`);
  const response = await deps.search({ q: query, num: MAX_RESULT_URLS, gl: "us", hl: "en" });
  if (response.blocked) {
    // Nothing reached the provider: release the claim and record no outcome.
    await db.execute(sql`DELETE FROM serper_contact_page_lookups WHERE id=${id}::uuid AND claim_token=${token}::uuid`);
    return { ...base, outcome: `blocked:${response.blockReason ?? "unknown"}`, blocked: true };
  }
  if (!response.ok) {
    await finish(id, token, { status: "provider_failure", outcome: "provider_failure", ttlMs: FAILURE_TTL_MS, httpStatus: response.status ?? null });
    return { ...base, requestSent: true, outcome: "provider_failure" };
  }
  const retrievedAt = new Date();
  const parsed = parseSearchResults(response.data, domain);
  const common = { httpStatus: response.status ?? 200, credits: parsed.credits, retrievedAt, fields: parsed.returnedFields, urls: parsed.resultUrls };
  const sent = { ...base, requestSent: true, reportedCredits: parsed.credits };
  if (parsed.organicCount === 0) {
    await finish(id, token, { ...common, status: "completed", outcome: "no_result", ttlMs: NEGATIVE_TTL_DAYS * 86400000 });
    return { ...sent, outcome: "no_result" };
  }
  const pages = chooseContactPages(parsed.resultUrls);
  if (pages.length === 0) {
    await finish(id, token, { ...common, status: "completed", outcome: "no_first_party_url", ttlMs: NEGATIVE_TTL_DAYS * 86400000 });
    return { ...sent, outcome: "no_first_party_url" };
  }

  const pageLog: Array<{ url: string; status: string; httpOk: boolean; candidates: number; readAt: string }> = [];
  const found = new Map<string, { email: string; sourceUrl: string; evidenceType: "mailto" | "visible_text" }>();
  for (const [i, page] of pages.entries()) {
    if (i > 0) await deps.sleep(PAGE_GAP_MS);
    let read: PageRead;
    try { read = await deps.readPage(page.url); } catch { read = { status: "unreachable", httpOk: false }; }
    const candidates = read.html ? extractCandidatesFromPage(read.html, page.url) : [];
    pageLog.push({ url: page.url, status: read.status, httpOk: read.httpOk, candidates: candidates.length, readAt: new Date().toISOString() });
    for (const c of candidates) {
      const prior = found.get(c.email);
      if (!prior || (c.evidenceType === "mailto" && prior.evidenceType !== "mailto")) found.set(c.email, c);
    }
  }
  const withPages = { ...common, pages: pageLog, status: "completed" as const };
  if (pageLog.every(p => !p.httpOk)) {
    await finish(id, token, { ...withPages, outcome: "pages_unreadable", ttlMs: UNREADABLE_TTL_DAYS * 86400000 });
    return { ...sent, outcome: "pages_unreadable" };
  }
  // The shared hard gate (same registrable domain or a hosted mailbox) applies to every candidate; only role inboxes are
  // business-level evidence, so named addresses never become business candidates here.
  const eligible = [...found.values()].map(c => ({ c, sel: selectContactDiscoveryEmail([c], domain) }))
    .filter(x => x.sel.email);
  if (eligible.length === 0) {
    await finish(id, token, { ...withPages, outcome: "pages_no_email", ttlMs: NEGATIVE_TTL_DAYS * 86400000 });
    return { ...sent, outcome: "pages_no_email" };
  }
  const roles = eligible.filter(x => isRoleInboxEmail(x.c.email))
    .sort((a, b) => b.sel.confidence - a.sel.confidence || a.c.email.localeCompare(b.c.email)).slice(0, MAX_STAGED_PER_BUSINESS);
  if (roles.length === 0) {
    await finish(id, token, { ...withPages, outcome: "no_role_email", ttlMs: NEGATIVE_TTL_DAYS * 86400000 });
    return { ...sent, outcome: "no_role_email" };
  }

  const { createFreeDiscoveryGeneration, completeFreeDiscoveryGeneration, recordFreeDiscoveryCandidate } =
    await import("./free-discovery/evidence-service");
  const generation = await createFreeDiscoveryGeneration({
    runKey: `serper-contact-page:${operationKey}`, actorId: "serper-contact-page-stage",
    reason: "serper_contact_page_stage", purpose: "email_discovery",
  });
  const candidateIds: string[] = [];
  for (const { c, sel } of roles) {
    const rec = await recordFreeDiscoveryCandidate({
      generationId: generation.id, subjectType: "business", businessId: target.businessId, domain,
      email: c.email, source: "first_party_contact_page", attributionScope: "role", confidence: sel.confidence,
      refreshDomainCache: false,
    });
    candidateIds.push(rec.id);
  }
  await completeFreeDiscoveryGeneration(generation.id);
  await finish(id, token, {
    ...withPages, outcome: "candidate_staged", ttlMs: NEGATIVE_TTL_DAYS * 86400000,
    candidateIds, generationId: generation.id,
  });
  return { ...sent, outcome: "candidate_staged", stagedCandidates: candidateIds.length };
}

export interface ContactPageStageRun {
  ran: boolean; reason?: string; examined: number; requests: number; reportedCredits: number; creditsUnreported: number;
  stagedBusinesses: number; stagedCandidates: number; outcomes: Record<string, number>; stoppedBy?: string;
}

export async function runSerperContactPageStage(
  opts: { limit?: number } = {}, injected?: Partial<ContactPageStageDeps>,
): Promise<ContactPageStageRun> {
  const deps = { ...(await defaultDeps()), ...injected };
  const run: ContactPageStageRun = {
    ran: false, examined: 0, requests: 0, reportedCredits: 0, creditsUnreported: 0, stagedBusinesses: 0,
    stagedCandidates: 0, outcomes: {},
  };
  const gate = await deps.readGate();
  if (!gate.enabled) return { ...run, reason: "stage_closed" };
  const budget = Math.min(gate.perRunRequests, Math.max(1, opts.limit ?? gate.perRunRequests));
  run.ran = true;
  const targets = await deps.select(budget);
  let consecutiveFailures = 0;
  for (const target of targets) {
    if (run.requests >= budget) { run.stoppedBy = "per_run_requests"; break; }
    const result = await runContactPageStageForBusiness(target, deps);
    run.examined++;
    run.outcomes[result.outcome] = (run.outcomes[result.outcome] ?? 0) + 1;
    if (result.blocked) { run.stoppedBy = result.outcome; break; }
    if (result.requestSent) {
      run.requests++;
      if (result.reportedCredits === null) run.creditsUnreported++; else run.reportedCredits += result.reportedCredits;
    }
    if (result.stagedCandidates > 0) { run.stagedBusinesses++; run.stagedCandidates += result.stagedCandidates; }
    consecutiveFailures = result.outcome === "provider_failure" ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= 3) { run.stoppedBy = "consecutive_provider_failures"; break; }
  }
  return run;
}

/**
 * Read-only yield: requests versus provider-reported credits, and what the stage's staged addresses became.
 * A "qualified" business has a ready-held recipient intent on a contact of that business created after the lookup.
 * Credits are reported only where the provider reported them; `creditsReportedComplete` says whether the ratio is exact.
 */
export async function readSerperContactPageYield() {
  const r = rows(await db.execute(sql`
    WITH l AS (SELECT * FROM serper_contact_page_lookups WHERE status <> 'claimed'),
    staged AS (
      SELECT l.id lookup_id, l.business_id, l.retrieved_at, cid::uuid candidate_id
        FROM l CROSS JOIN LATERAL jsonb_array_elements_text(l.candidate_ids) cid),
    linked AS (
      SELECT DISTINCT s.business_id FROM staged s JOIN free_discovery_materialization_outcomes o ON o.candidate_id = s.candidate_id
       WHERE o.outcome IN ('linked','already_linked')),
    qualified AS (
      SELECT DISTINCT s.business_id FROM staged s
        JOIN contacts c ON c.business_id = s.business_id
        JOIN cr04_enrollment_intents i ON i.contact_id = c.id AND i.preparation_state = 'ready_held' AND i.created_at >= s.retrieved_at)
    SELECT
      (SELECT count(*)::int FROM l) attempts,
      (SELECT count(DISTINCT business_id)::int FROM l) businesses,
      (SELECT COALESCE(sum(requests_used),0)::int FROM l) requests,
      (SELECT COALESCE(sum(reported_credits),0)::int FROM l) reported_credits,
      (SELECT count(*)::int FROM l WHERE requests_used > 0 AND reported_credits IS NULL) requests_without_reported_credits,
      (SELECT count(DISTINCT business_id)::int FROM staged) businesses_with_staged_email,
      (SELECT count(*)::int FROM staged) staged_candidates,
      (SELECT count(*)::int FROM linked) businesses_linked,
      (SELECT count(*)::int FROM qualified) businesses_qualified,
      COALESCE((SELECT jsonb_object_agg(outcome_class, n) FROM (SELECT outcome_class, count(*)::int n FROM l GROUP BY 1) o), '{}'::jsonb) by_outcome`))[0];
  const n = (v: any) => Number(v ?? 0);
  const requests = n(r.requests), credits = n(r.reported_credits), qualified = n(r.businesses_qualified);
  return {
    attempts: n(r.attempts), businesses: n(r.businesses), requests, reportedCredits: credits,
    requestsWithoutReportedCredits: n(r.requests_without_reported_credits),
    creditsReportedComplete: n(r.requests_without_reported_credits) === 0,
    businessesWithStagedEmail: n(r.businesses_with_staged_email), stagedCandidates: n(r.staged_candidates),
    businessesLinked: n(r.businesses_linked), businessesQualified: qualified, byOutcome: r.by_outcome ?? {},
    qualifiedBusinessesPerRequest: requests ? qualified / requests : null,
    qualifiedBusinessesPerReportedCredit: credits ? qualified / credits : null,
  };
}
