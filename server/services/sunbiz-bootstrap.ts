/**
 * Sunbiz → canonical-business bootstrap (Task #1956, Step 2).
 *
 * Materializes real `businesses` rows from hot/warm Sunbiz entities through a
 * bounded, previewable batch. Idempotency rests on a durable claim keyed by
 * the Sunbiz entity's stable source identity (filing_number), enforced by a
 * DB unique index (sunbiz_bootstrap_claims_filing_number_unique) — NOT on
 * advisory locks, business-name matching, or generated business IDs alone.
 *
 * Every materialized business gets a canonical_source_links row
 * (source_system='sunbiz', source_type='sunbiz_entity', stable_key=filing
 * number) preserving lineage back to the originating Sunbiz entity.
 *
 * This module is intentionally wired only to the governed admin route. It is
 * not wired to any cron/worker or scheduled tick; every invocation is bounded
 * and requires the route's typed confirmation gate.
 */
import { sql } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "../db";
import type { SunbizEntity } from "@shared/schema";
import { initializeSunbizBootstrapBusinessClass } from "./commercial-classification-authority";
import { lockCommercialGraphNodes } from "./commercial-graph-locks";
import {
  resolveOrganization,
  peekOrganizationResolution,
} from "./organization-resolver";
import { evaluateSouthFloridaGeography, CRO03A_GEOGRAPHY_REFERENCE_VERSION } from "./cro03a/geography";

function rows<T = any>(result: unknown): T[] {
  return (result as { rows?: T[] })?.rows ?? [];
}

const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 25;

// A claim that has sat in 'claimed' status longer than this is treated as
// abandoned (the process that took it crashed or was killed mid-resolution)
// and becomes eligible for reclaim by a later run, same as a 'failed' claim.
const STALE_CLAIM_MINUTES = 15;

// A filing that has failed resolution this many times is moved to the
// terminal 'dead_letter' claim status instead of being retried forever by
// the full-backfill worker (see runSunbizBackfillMicrobatch below).
export const SUNBIZ_BACKFILL_MAX_RETRIES = 5;

export interface SunbizBootstrapCandidate {
  id: number;
  filingNumber: string;
  entityName: string;
  website: string | null;
  phone: string | null;
  principalCity: string | null;
  principalState: string | null;
  principalZip?: string | null;
}

/**
 * Selects unclaimed hot/warm Sunbiz entities with enough identity signal to
 * attempt organization resolution. Excludes any entity whose filing_number
 * already has a non-failed claim row. Failed claims remain selectable so an
 * explicit rerun can recover them; successful claims remain permanently
 * idempotently excluded.
 */
export async function selectSunbizBootstrapCandidates(
  limit = DEFAULT_BATCH_LIMIT,
  opts: { filingNumberLike?: string; afterId?: number; geography?: "south_florida" | "any" } = {},
): Promise<SunbizBootstrapCandidate[]> {
  return (await selectSunbizBootstrapCandidateWindow(limit, opts)).candidates;
}

/**
 * Same selection as selectSunbizBootstrapCandidates(), but also reports the
 * highest sunbiz_entities.id actually examined in the underlying scan window
 * (which, for geography=="south_florida", can be higher than the highest
 * *eligible* candidate id, since ineligible rows are fetched and filtered
 * out in-process). The full-backfill phase cursor (sunbiz-full-backfill.ts)
 * needs this to advance past a long run of non-South-Florida ids without
 * re-scanning the same ineligible window on every tick, while still never
 * advancing past a still-retryable id (handled by the caller via the
 * returned candidates + outcomes, not via maxIdExamined).
 */
export async function selectSunbizBootstrapCandidateWindow(
  limit = DEFAULT_BATCH_LIMIT,
  opts: { filingNumberLike?: string; afterId?: number; geography?: "south_florida" | "any" } = {},
): Promise<{ candidates: SunbizBootstrapCandidate[]; maxIdExamined: number | null }> {
  const boundedLimit = Math.min(MAX_BATCH_LIMIT, Math.max(1, Math.floor(limit)));
  const geography = opts.geography ?? "any";

  // filingNumberLike is test-only (never passed by the production routes).
  // When it IS set, the query must not rely on the id-ordered hot/warm partial
  // index scan below: fixture rows always land at the newest (highest) ids,
  // so a `LIKE` filter that matches nothing else in the ~1.9M-row table forces
  // Postgres to walk the entire hot/warm index before concluding there's no
  // LIMIT match. Route it through idx_sunbiz_filing_number (a plain btree on
  // filing_number) instead, using a sargable range bound derived from the
  // literal prefix so the planner can seek directly to the matching rows
  // rather than scanning by id.
  let filingNumberRangeClause = sql`TRUE`;
  if (opts.filingNumberLike) {
    const prefix = opts.filingNumberLike.replace(/%+$/, "");
    if (prefix) {
      // Exclusive upper bound: prefix with its last char's code point + 1,
      // e.g. "abc" -> "abd", which bounds every string starting with "abc".
      const upperBound = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      filingNumberRangeClause = sql`se.filing_number >= ${prefix} AND se.filing_number < ${upperBound}`;
    }
  }

  // South Florida prioritization (Task #2002 corrective patch) filters using
  // the same versioned CRO-03A geography reference the rest of the CRM's
  // qualification pipeline uses (evaluateSouthFloridaGeography()), not an ad
  // hoc principal_city/principal_state string check. Because the evaluator's
  // rules (county > ZIP > city, ambiguous/unknown never eligible) are richer
  // than a plain SQL predicate, geography=="south_florida" over-fetches a
  // wider candidate window from Postgres (still bounded, still id-ordered,
  // still governed by the same claim/retry NOT EXISTS predicate) and then
  // evaluates + filters in-process, returning at most `boundedLimit` rows.
  // This never treats ambiguous/unknown geography as eligible: only
  // evidenceClass in {verified, zip_inferred, city_inferred} with
  // eligible===true passes through.
  const geographyOverfetchLimit = geography === "south_florida" ? boundedLimit * 40 : boundedLimit;

  const rows = (await db.execute(sql`
    SELECT se.id, se.filing_number, se.entity_name, se.website, se.phone,
           se.principal_city, se.principal_state, se.principal_zip
    FROM sunbiz_entities se
    WHERE se.filing_number IS NOT NULL
      AND se.entity_name IS NOT NULL
      AND se.score IN ('hot', 'warm')
      AND (se.website IS NOT NULL OR se.phone IS NOT NULL
           OR (se.principal_city IS NOT NULL AND se.principal_state IS NOT NULL))
      AND (${opts.filingNumberLike ?? null}::text IS NULL OR se.filing_number LIKE ${opts.filingNumberLike ?? null}::text)
      AND (${filingNumberRangeClause})
      AND (${opts.afterId ?? null}::int IS NULL OR se.id > ${opts.afterId ?? null}::int)
      AND NOT EXISTS (
        SELECT 1 FROM sunbiz_bootstrap_claims c
        WHERE c.filing_number = se.filing_number
          AND NOT (
            (c.status = 'failed' AND c.retry_count < ${SUNBIZ_BACKFILL_MAX_RETRIES})
            OR (c.status = 'claimed' AND c.claimed_at < now() - (${STALE_CLAIM_MINUTES} || ' minutes')::interval)
          )
      )
    ORDER BY se.id ASC
    LIMIT ${geographyOverfetchLimit}
  `)).rows as any[];

  const mapped: SunbizBootstrapCandidate[] = rows.map((r) => ({
    id: Number(r.id),
    filingNumber: String(r.filing_number),
    entityName: String(r.entity_name),
    website: r.website ?? null,
    phone: r.phone ?? null,
    principalCity: r.principal_city ?? null,
    principalState: r.principal_state ?? null,
    principalZip: r.principal_zip ?? null,
  }));

  // mapped is already ordered by se.id ASC (see ORDER BY above), so the last
  // element is the highest id in the scanned window.
  const maxIdExamined = mapped.length === 0 ? null : mapped[mapped.length - 1].id;

  if (geography !== "south_florida") {
    return { candidates: mapped.slice(0, boundedLimit), maxIdExamined };
  }

  return boundSouthFloridaCandidateWindow(mapped, boundedLimit);
}

/**
 * Bounds a South-Florida-eligible candidate window to at most `limit` rows,
 * and reports the cursor-safe maxIdExamined for that window.
 *
 * Bug this fixes (Task #2002 corrective patch): a scan window can contain
 * MORE eligible rows than fit in one microbatch (e.g. 35 eligible rows in a
 * 1000-row overfetch window, but boundedLimit=25). The previous
 * implementation reported maxIdExamined as the highest id in the ENTIRE
 * scanned window regardless of how many eligible rows were actually
 * returned as candidates -- so once the batch for the first 25 succeeded,
 * the cursor advanced past the id of the other 10 eligible-but-unprocessed
 * rows. Those 10 are not retryable-failures (they were never claimed or
 * attempted), so computeNextHighWaterEntityId's retryable-failure guard in
 * sunbiz-full-backfill.ts cannot protect them -- they would be silently and
 * permanently skipped for the South Florida lane.
 *
 * Fix: only advance maxIdExamined past the whole scanned window when EVERY
 * eligible row in it fit inside `limit`. When there are more eligible rows
 * than fit, maxIdExamined stops at the last row actually returned as a
 * candidate, so the next call (with afterId = that id) re-scans and finds
 * the remaining eligible rows.
 */
export function boundSouthFloridaCandidateWindow(
  scanned: SunbizBootstrapCandidate[],
  limit: number,
): { candidates: SunbizBootstrapCandidate[]; maxIdExamined: number | null } {
  const eligible = scanned.filter((c) => isSouthFloridaEligible(c));
  const candidates = eligible.slice(0, limit);
  const maxIdExamined =
    eligible.length > limit
      ? candidates[candidates.length - 1].id
      : scanned.length > 0
        ? scanned[scanned.length - 1].id
        : null;
  return { candidates, maxIdExamined };
}

/**
 * True only when the CRO-03A versioned geography reference resolves this
 * candidate's operating-location evidence to an eligible South Florida
 * county (Miami-Dade, Broward, Palm Beach) with evidenceClass in
 * {verified, zip_inferred, city_inferred}. Ambiguous ("conflicting") and
 * unresolved ("unknown") evidence are never treated as confirmed South
 * Florida -- they fall through to the remaining-universe pass instead.
 */
export function isSouthFloridaEligible(candidate: {
  principalState: string | null;
  principalCity: string | null;
  principalZip?: string | null;
}): boolean {
  const result = evaluateSouthFloridaGeography({
    state: candidate.principalState,
    zip: candidate.principalZip ?? null,
    city: candidate.principalCity,
  });
  return result.eligible;
}

export { CRO03A_GEOGRAPHY_REFERENCE_VERSION };

function domainFromWebsite(website: string | null): string | null {
  if (!website) return null;
  try {
    const withScheme = website.startsWith("http") ? website : `https://${website}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

function normalizedPhone(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * Queue (never execute inline) the canonical free-only enrichment handler
 * after a newly projected domain makes a matched canonical business crawlable.
 * This is reached only from an explicitly invoked bootstrap batch. Failure is
 * returned to the operator; it never falls back to paid discovery.
 */
async function enqueueProjectedDomainRecrawl(businessId: number, filingNumber: string): Promise<"queued" | "queue_unavailable" | "enqueue_failed"> {
  try {
    const { requireQueueManagerReady, QUEUE_NAMES } = await import("./queue-manager");
    const manager = requireQueueManagerReady();
    const queue = manager.getQueue(QUEUE_NAMES.ENRICHMENT);
    if (!queue) return "queue_unavailable";
    const stableJobKey = crypto.createHash("sha256").update(filingNumber).digest("hex").slice(0, 16);
    await queue.add(
      "free-contact-enrichment",
      { businessId },
      {
        jobId: `sunbiz-domain-recrawl-${businessId}-${stableJobKey}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
      },
    );
    return "queued";
  } catch (error: any) {
    console.warn(`[Sunbiz Bootstrap] Free recrawl enqueue failed for business ${businessId}: ${String(error?.message ?? error)}`);
    return "enqueue_failed";
  }
}

function toResolverInput(candidate: SunbizBootstrapCandidate) {
  return {
    canonicalName: candidate.entityName,
    websiteDomain: domainFromWebsite(candidate.website),
    mainPhone: candidate.phone,
    city: candidate.principalCity,
    state: candidate.principalState,
  };
}

function normalizedIdentityName(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Generic legal-form/entity-type tokens carry zero corroborating identity
// signal — "llc", "inc", "corp" etc. appear on huge numbers of unrelated
// Sunbiz filings. Without stripping these, two entirely unrelated
// "... LLC" businesses that happen to share a domain or phone (shared
// registered agent, franchise hub) could pass token-overlap matching on the
// "llc" token alone. Every identity-name comparison in this module must
// strip these before comparing tokens.
const GENERIC_LEGAL_FORM_TOKENS = new Set([
  "llc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "ltd", "limited", "llp", "lllp", "lp", "pa", "pc", "pllc", "plc",
  "group", "holdings", "enterprises", "services", "solutions", "the",
]);

function meaningfulTokens(normalized: string): Set<string> {
  return new Set(
    normalized
      .split(" ")
      .filter((token) => token.length > 2 && !GENERIC_LEGAL_FORM_TOKENS.has(token)),
  );
}

export function compatibleIdentityName(a: string, b: string): boolean {
  const left = normalizedIdentityName(a);
  const right = normalizedIdentityName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  // A pure substring match ("joes pizza" within "joes pizza llc") is only
  // trusted once legal-form/stopword tokens are stripped from both sides —
  // otherwise "llc" alone would satisfy this branch for two unrelated "...
  // LLC" businesses.
  const leftCore = [...leftTokens].sort().join(" ");
  const rightCore = [...rightTokens].sort().join(" ");
  if (leftCore === rightCore) return true;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / Math.max(leftTokens.size, rightTokens.size) >= 0.6;
}

export function compatibleCityState(candidate: SunbizBootstrapCandidate, business: any): boolean {
  return !!candidate.principalCity && !!candidate.principalState &&
    candidate.principalCity.trim().toLowerCase() === String(business.city ?? "").trim().toLowerCase() &&
    candidate.principalState.trim().toLowerCase() === String(business.state ?? "").trim().toLowerCase();
}

/**
 * True only when both names are present and share literally no meaningful
 * token overlap (e.g. "Joe's Pizza LLC" vs "City Nail Salon Inc") — a
 * stronger signal than "not compatible", used to stop a same-city/state
 * coincidence from overriding an outright unrelated business name. A
 * same-city match on two genuinely unrelated businesses (shared registered
 * agent address, franchise hub, etc.) must not auto-link just because the
 * city/state happens to match.
 */
export function namesClearlyConflict(a: string, b: string): boolean {
  const left = normalizedIdentityName(a);
  const right = normalizedIdentityName(b);
  if (!left || !right) return false;
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap === 0;
}

async function wasPromotedByLegacySunbiz(filingNumber: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
    FROM sunbiz_entities se
    LEFT JOIN prospects p ON p.id = se.prospect_id
    WHERE se.filing_number = ${filingNumber}
      AND (
        p.id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM canonical_source_links csl
          WHERE csl.stable_key = ${filingNumber}
            AND NOT (csl.source_system = 'sunbiz' AND csl.source_type = 'sunbiz_entity')
            AND NOT (csl.source_system = 'sunbiz_entities' AND csl.source_type = 'sunbiz_filing')
        )
      )
    LIMIT 1
  `);
  return rows(result).length > 0;
}

async function findCRO03BCrosswalkBusiness(filingNumber: string): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT business_id
    FROM canonical_source_links
    WHERE source_system = 'sunbiz_entities'
      AND source_type = 'sunbiz_filing'
      AND stable_key = ${filingNumber}
    LIMIT 1
  `);
  const found = rows(result)[0] as { business_id: number } | undefined;
  return found ? Number(found.business_id) : null;
}

/**
 * Single source of truth for the typed-confirmation phrase, derived from the
 * actual candidate count (never the requested limit). Both the preview route
 * (what it advertises to the caller) and the run route (what it requires)
 * MUST call this same function so they can never drift apart on an
 * UNCHANGED corpus. See sunbizBootstrapPreviewTokens below for how the two
 * routes stay consistent even when the corpus/claims change between the two
 * calls.
 */
export function sunbizBootstrapConfirmationPhrase(candidateCount: number): string {
  return `RUN SUNBIZ BOOTSTRAP ${candidateCount}`;
}

interface SunbizBootstrapPreviewTokenRecord {
  confirmationPhrase: string;
  limit: number;
  filingNumberLike?: string;
  expiresAt: number;
  /**
   * The exact, ordered set of filing_numbers previewSunbizBootstrap()
   * selected when this token was minted. /run must select candidates again
   * (claims are live, so a stale in-memory list can't be executed directly)
   * but MUST verify the fresh selection is identical to this snapshot before
   * doing any claim/write work — otherwise a claim landing between preview
   * and run (another admin's batch, or this module's own stale-claim
   * recovery reordering the queue) can execute a materially different set of
   * entities than the admin reviewed and typed a count-derived confirmation
   * phrase for. See runSunbizBootstrapBatch's `expectedFilingNumbers` param
   * and SunbizBootstrapSnapshotDriftError.
   */
  candidateFilingNumbers: string[];
}

const PREVIEW_TOKEN_TTL_MS = 5 * 60 * 1000;

// In-memory, single-process, single-use preview tokens binding a specific
// preview response to the exact confirmation phrase it displayed. GET preview
// and POST run independently recomputing candidateCount left a real gap: an
// intervening claim (another admin's run, or this module's own stale-claim
// recovery) can change candidateCount between the two calls, silently
// rejecting exactly the phrase the UI just showed the caller. Binding run's
// validation to the token preview minted — not to a freshly recomputed count
// — closes that gap. Tokens are single-use and short-lived; if the corpus
// materially changed since the token was minted, the caller must re-preview
// rather than trust a stale count.
const sunbizBootstrapPreviewTokens = new Map<string, SunbizBootstrapPreviewTokenRecord>();

function pruneExpiredPreviewTokens(): void {
  const now = Date.now();
  for (const [token, record] of sunbizBootstrapPreviewTokens) {
    if (record.expiresAt <= now) sunbizBootstrapPreviewTokens.delete(token);
  }
}

export function issueSunbizBootstrapPreviewToken(
  confirmationPhrase: string,
  limit: number,
  candidateFilingNumbers: string[],
  filingNumberLike?: string,
): string {
  pruneExpiredPreviewTokens();
  const token = crypto.randomUUID();
  sunbizBootstrapPreviewTokens.set(token, {
    confirmationPhrase,
    limit,
    filingNumberLike,
    candidateFilingNumbers: [...candidateFilingNumbers].sort(),
    expiresAt: Date.now() + PREVIEW_TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Thrown by runSunbizBootstrapBatch() when the candidate set it selects at
 * execution time does not exactly match the snapshot a preview token was
 * minted against. Thrown BEFORE any claim/write happens — the batch never
 * touches the DB with a mismatched set.
 */
export class SunbizBootstrapSnapshotDriftError extends Error {
  code = "candidate_snapshot_drifted" as const;
  constructor(public readonly expected: string[], public readonly actual: string[]) {
    super(
      `Candidate set changed since preview (expected ${expected.length} entities, found ${actual.length}); re-preview before running.`,
    );
  }
}

/**
 * Read-only lookup: does NOT delete the token. Use this to validate a
 * request (limit match, confirmation phrase match) before deciding whether
 * to consume it — a typo'd confirmation should not burn the token, or the
 * caller is forced to re-preview (and risk a changed candidateCount) just to
 * fix a typo.
 */
export function peekSunbizBootstrapPreviewToken(token: string): SunbizBootstrapPreviewTokenRecord | null {
  pruneExpiredPreviewTokens();
  return sunbizBootstrapPreviewTokens.get(token) ?? null;
}

/** Single-use: consuming a valid token deletes it immediately. Call this only once validation (limit + confirmation) has already passed. */
export function consumeSunbizBootstrapPreviewToken(token: string): SunbizBootstrapPreviewTokenRecord | null {
  pruneExpiredPreviewTokens();
  const record = sunbizBootstrapPreviewTokens.get(token);
  if (!record) return null;
  sunbizBootstrapPreviewTokens.delete(token);
  return record;
}

export interface SunbizBootstrapPreview {
  candidateCount: number;
  wouldCreate: number;
  wouldMatchExisting: number;
  wouldDefer: number;
  candidates: Array<{ filingNumber: string; entityName: string; outcome: "would_create" | "matched" | "deferred" }>;
}

/**
 * Dry run: reports exactly what runSunbizBootstrapBatch() would do, without
 * claiming anything or writing to businesses/canonical_source_links. Uses
 * peekOrganizationResolution() (no lock, no write) so the preview count is a
 * true prediction of the actual insert count on an unchanged fixture/corpus.
 */
export async function previewSunbizBootstrap(limit = DEFAULT_BATCH_LIMIT, opts: { filingNumberLike?: string } = {}): Promise<SunbizBootstrapPreview> {
  const candidates = await selectSunbizBootstrapCandidates(limit, opts);
  const result: SunbizBootstrapPreview = {
    candidateCount: candidates.length,
    wouldCreate: 0,
    wouldMatchExisting: 0,
    wouldDefer: 0,
    candidates: [],
  };

  for (const candidate of candidates) {
    const peek = await peekOrganizationResolution(toResolverInput(candidate));
    if (peek.kind === "would_create") {
      result.wouldCreate++;
      result.candidates.push({ filingNumber: candidate.filingNumber, entityName: candidate.entityName, outcome: "would_create" });
    } else if (peek.kind === "matched" &&
        !compatibleIdentityName(candidate.entityName, peek.business.canonicalName) &&
        (!compatibleCityState(candidate, peek.business) ||
          namesClearlyConflict(candidate.entityName, peek.business.canonicalName))) {
      result.wouldDefer++;
      result.candidates.push({ filingNumber: candidate.filingNumber, entityName: candidate.entityName, outcome: "deferred" });
    } else if (peek.kind === "matched") {
      result.wouldMatchExisting++;
      result.candidates.push({ filingNumber: candidate.filingNumber, entityName: candidate.entityName, outcome: "matched" });
    } else {
      result.wouldDefer++;
      result.candidates.push({ filingNumber: candidate.filingNumber, entityName: candidate.entityName, outcome: "deferred" });
    }
  }

  return result;
}

// ── Record-class repair (one-time BT-06 initialization correction) ────────
//
// Before this correction, the bootstrap assigned the legacy 'canonical'
// class directly. Classification now goes through BT-06 after the bootstrap
// claim and exact Sunbiz source link have been verified in the same
// transaction. Only a still-unknown business with a completed, evidence-backed
// bootstrap is initialized to production; weak or stale source evidence stays
// quarantined as unknown.
//
// This repair is scoped as narrowly as possible: only businesses that are
// PROVEN to be a Sunbiz-bootstrap "created" outcome (not "matched_existing",
// which must never have its record_class touched) and that still carry the
// pre-fix 'unknown' default, and for which the exact Sunbiz source lineage
// row genuinely exists (proving the claim's finalize step actually completed
// for this business/filing pair, not a partial or unrelated row). It never
// widens to "any unknown business" — other ingestion paths intentionally rely
// on fail-closed 'unknown' classification, and this repair must not silently
// reclassify those.
const RECORD_CLASS_REPAIR_COHORT_SQL = sql`
  SELECT b.id, b.canonical_name AS canonical_name, c.filing_number AS filing_number
  FROM sunbiz_bootstrap_claims c
  JOIN businesses b ON b.id = c.business_id
  JOIN canonical_source_links csl
    ON csl.business_id = b.id
   AND csl.source_system = 'sunbiz'
   AND csl.source_type = 'sunbiz_entity'
   AND csl.stable_key = c.filing_number
  WHERE c.status = 'created'
    AND b.record_class = 'unknown'
  ORDER BY b.id
`;

export interface SunbizRecordClassRepairRow {
  id: number;
  canonicalName: string;
  filingNumber: string;
}

export interface SunbizRecordClassRepairPreview {
  cohortCount: number;
  rows: SunbizRecordClassRepairRow[];
}

/** Read-only: derives the exact repair cohort from the database. Never writes. */
export async function previewSunbizRecordClassRepair(): Promise<SunbizRecordClassRepairPreview> {
  const result = rows(await db.execute(RECORD_CLASS_REPAIR_COHORT_SQL)) as Array<{
    id: number;
    canonical_name: string;
    filing_number: string;
  }>;
  return {
    cohortCount: result.length,
    rows: result.map((r) => ({ id: r.id, canonicalName: r.canonical_name, filingNumber: r.filing_number })),
  };
}

export function sunbizRecordClassRepairConfirmationPhrase(cohortCount: number): string {
  return `REPAIR SUNBIZ RECORD CLASS ${cohortCount}`;
}

interface SunbizRecordClassRepairTokenRecord {
  confirmationPhrase: string;
  businessIds: number[];
  expiresAt: number;
}

const sunbizRecordClassRepairTokens = new Map<string, SunbizRecordClassRepairTokenRecord>();

function pruneExpiredRepairTokens(): void {
  const now = Date.now();
  for (const [token, record] of sunbizRecordClassRepairTokens) {
    if (record.expiresAt <= now) sunbizRecordClassRepairTokens.delete(token);
  }
}

export function issueSunbizRecordClassRepairToken(confirmationPhrase: string, businessIds: number[]): string {
  pruneExpiredRepairTokens();
  const token = crypto.randomUUID();
  sunbizRecordClassRepairTokens.set(token, {
    confirmationPhrase,
    businessIds: [...businessIds].sort((a, b) => a - b),
    expiresAt: Date.now() + PREVIEW_TOKEN_TTL_MS,
  });
  return token;
}

export function peekSunbizRecordClassRepairToken(token: string): SunbizRecordClassRepairTokenRecord | null {
  pruneExpiredRepairTokens();
  return sunbizRecordClassRepairTokens.get(token) ?? null;
}

export function consumeSunbizRecordClassRepairToken(token: string): SunbizRecordClassRepairTokenRecord | null {
  pruneExpiredRepairTokens();
  const record = sunbizRecordClassRepairTokens.get(token);
  if (!record) return null;
  sunbizRecordClassRepairTokens.delete(token);
  return record;
}

export interface SunbizRecordClassRepairResult {
  attemptedCount: number;
  repairedCount: number;
  repairedIds: number[];
  classificationEventIds: number[];
  quarantinedIds: number[];
}

/**
 * Executes the repair. Idempotent by construction: it re-derives the SAME
 * proven cohort live (not trusting the token's snapshot to still be
 * 'unknown') and updates only rows that are STILL 'unknown' at execution
 * time, scoped to the exact business IDs the token captured. Re-running this
 * after a successful repair (or after nothing qualifies any more) always
 * updates zero rows rather than erroring or reclassifying anything new.
 */
export async function runSunbizRecordClassRepair(expectedBusinessIds: number[]): Promise<SunbizRecordClassRepairResult> {
  if (expectedBusinessIds.length === 0) {
    return {
      attemptedCount: 0,
      repairedCount: 0,
      repairedIds: [],
      classificationEventIds: [],
      quarantinedIds: [],
    };
  }
  const repairedIds: number[] = [];
  const classificationEventIds: number[] = [];
  const quarantinedIds: number[] = [];
  for (const businessId of [...new Set(expectedBusinessIds)]) {
    const initialized = await db.transaction(async (tx) => {
      await lockCommercialGraphNodes(tx, [{ type: "business", id: businessId }]);
      const proven = rows(await tx.execute(sql`
        SELECT b.id, c.filing_number
        FROM sunbiz_bootstrap_claims c
        JOIN businesses b ON b.id = c.business_id
        JOIN canonical_source_links csl
          ON csl.business_id = b.id
         AND csl.source_system = 'sunbiz'
         AND csl.source_type = 'sunbiz_entity'
         AND csl.stable_key = c.filing_number
        WHERE c.status = 'created'
          AND b.record_class = 'unknown'
          AND b.id = ${businessId}
        FOR UPDATE OF b, c
      `))[0] as { id: number; filing_number: string } | undefined;
      if (!proven) return null;
      return initializeSunbizBootstrapBusinessClass({
        businessId: Number(proven.id),
        filingNumber: proven.filing_number,
        claimMode: "completed_bootstrap",
        transaction: tx,
      });
    });
    if (initialized?.decision === "initialized" && initialized.applied && initialized.eventId != null) {
      repairedIds.push(businessId);
      classificationEventIds.push(initialized.eventId);
    } else if (initialized?.decision === "quarantined") {
      quarantinedIds.push(businessId);
    }
  }
  return {
    attemptedCount: expectedBusinessIds.length,
    repairedCount: repairedIds.length,
    repairedIds,
    classificationEventIds,
    quarantinedIds,
  };
}

export interface SunbizBootstrapRunOutcome {
  filingNumber: string;
  entityName: string;
  outcome: "created" | "matched_existing" | "deferred_collision" | "identity_review" | "already_claimed" | "failed" | "dead_letter" | "lost_lease";
  businessId?: number;
  projectedDomain?: boolean;
  projectedPhone?: boolean;
  domainConflict?: boolean;
  phoneConflict?: boolean;
  freeRecrawl?: "not_needed" | "queued" | "queue_unavailable" | "enqueue_failed";
  classificationEventId?: number;
  classificationDecision?: "initialized" | "quarantined" | "preserved";
  classificationReasonCode?: string;
  error?: string;
}

interface SunbizFinalizeResult {
  won: boolean;
  projection: SunbizProjectionResult | null;
  classificationEventId?: number;
  classificationDecision?: "initialized" | "quarantined" | "preserved";
  classificationReasonCode?: string;
}

interface SunbizProjectionResult {
  lineageConflict: boolean;
  projectedDomain: boolean;
  projectedPhone: boolean;
  domainConflict: boolean;
  phoneConflict: boolean;
}

/**
 * Add filing lineage and project only absent identifiers. The source link is
 * checked before any field mutation and again after conflict-tolerant insert;
 * a filing already attached to a different business is never reassigned.
 */
async function attachLineageAndProjectMissingFields(
  tx: any,
  candidate: SunbizBootstrapCandidate,
  businessId: number,
): Promise<SunbizProjectionResult> {
  const existingLineage = rows(await tx.execute(sql`
    SELECT business_id FROM canonical_source_links
    WHERE source_system = 'sunbiz' AND source_type = 'sunbiz_entity'
      AND stable_key = ${candidate.filingNumber}
    FOR UPDATE
  `))[0] as { business_id: number } | undefined;
  if (existingLineage && Number(existingLineage.business_id) !== businessId) {
    return { lineageConflict: true, projectedDomain: false, projectedPhone: false, domainConflict: true, phoneConflict: true };
  }

  await tx.execute(sql`
    INSERT INTO canonical_source_links (business_id, source_system, source_type, stable_key, registry_id)
    VALUES (${businessId}, 'sunbiz', 'sunbiz_entity', ${candidate.filingNumber}, NULL)
    ON CONFLICT (source_system, source_type, stable_key) DO NOTHING
  `);
  const verifiedLineage = rows(await tx.execute(sql`
    SELECT business_id FROM canonical_source_links
    WHERE source_system = 'sunbiz' AND source_type = 'sunbiz_entity'
      AND stable_key = ${candidate.filingNumber}
    FOR UPDATE
  `))[0] as { business_id: number } | undefined;
  if (!verifiedLineage || Number(verifiedLineage.business_id) !== businessId) {
    return { lineageConflict: true, projectedDomain: false, projectedPhone: false, domainConflict: true, phoneConflict: true };
  }

  const business = rows(await tx.execute(sql`
    SELECT website_domain, main_phone, record_class
    FROM businesses WHERE id = ${businessId} FOR UPDATE
  `))[0] as { website_domain: string | null; main_phone: string | null; record_class: string } | undefined;
  if (!business || business.record_class !== "production") {
    return { lineageConflict: false, projectedDomain: false, projectedPhone: false, domainConflict: false, phoneConflict: false };
  }

  const candidateDomain = domainFromWebsite(candidate.website);
  const candidatePhone = candidate.phone?.trim() || null;
  const candidatePhoneDigits = normalizedPhone(candidatePhone);
  const usableDomain = candidateDomain && candidateDomain.includes(".") && !candidateDomain.includes(" ") ? candidateDomain : null;
  const usablePhone = candidatePhoneDigits.length >= 7 ? candidatePhone : null;
  const currentDomain = String(business.website_domain ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const currentPhoneDigits = normalizedPhone(business.main_phone);

  let domainConflict = Boolean(usableDomain && currentDomain && currentDomain !== usableDomain);
  let phoneConflict = Boolean(usablePhone && currentPhoneDigits && currentPhoneDigits !== candidatePhoneDigits);
  const domainOwner = usableDomain && !currentDomain
    ? rows(await tx.execute(sql`
        SELECT id FROM businesses
        WHERE id <> ${businessId}
          AND regexp_replace(lower(regexp_replace(trim(website_domain), '^www\\.', '')), '\\.$', '') = ${usableDomain}
        LIMIT 1
      `))[0]
    : null;
  const phoneOwner = usablePhone && !currentPhoneDigits
    ? rows(await tx.execute(sql`
        SELECT id FROM businesses
        WHERE id <> ${businessId}
          AND regexp_replace(coalesce(main_phone, ''), '[^0-9]', '', 'g') = ${candidatePhoneDigits}
        LIMIT 1
      `))[0]
    : null;
  if (domainOwner) domainConflict = true;
  if (phoneOwner) phoneConflict = true;

  const projectDomain = Boolean(usableDomain && !currentDomain && !domainConflict);
  const projectPhone = Boolean(usablePhone && !currentPhoneDigits && !phoneConflict);
  if (projectDomain || projectPhone) {
    await tx.execute(sql`
      UPDATE businesses
      SET website_domain = CASE WHEN ${projectDomain} THEN ${usableDomain} ELSE website_domain END,
          main_phone = CASE WHEN ${projectPhone} THEN ${usablePhone} ELSE main_phone END,
          updated_at = now()
      WHERE id = ${businessId} AND record_class = 'production'
    `);
  }
  if (projectDomain) {
    // This business previously had no domain, so any no-domain skip or old
    // freshness state cannot describe a crawl of the newly projected domain.
    // Leave an in-flight worker untouched; only a non-processing row is made
    // eligible for the explicitly queued free-only recrawl.
    await tx.execute(sql`
      UPDATE businesses
      SET free_enrichment_status = NULL,
          free_enrichment_completed_at = NULL,
          free_enrichment_last_error_code = NULL
      WHERE id = ${businessId}
        AND record_class = 'production'
        AND free_enrichment_status IS DISTINCT FROM 'processing'
    `);
  }
  return { lineageConflict: false, projectedDomain: projectDomain, projectedPhone: projectPhone, domainConflict, phoneConflict };
}

/**
 * Executes a bounded batch. For each candidate:
 *   1. Attempt to durably claim the filing_number via
 *      INSERT ... ON CONFLICT (filing_number) DO NOTHING (or reclaim a failed
 *      or stale-abandoned claim). If no row is returned, another run already
 *      holds a live claim on this entity. The claim row's own `claimed_at`
 *      (returned by the claiming statement) becomes this executor's lease
 *      fencing token for every subsequent write.
 *   2. Only once claimed, call resolveOrganization() (transactional,
 *      advisory-locked) to either match an existing business or create one.
 *   3. Finalize inside a transaction that FIRST re-locks the claim row with
 *      `WHERE claimed_at = <lease token>` — i.e. a compare-and-swap on the
 *      lease, not just a plain filing_number match. If a second executor
 *      reclaimed this filing (because this executor stalled past
 *      STALE_CLAIM_MINUTES) and already finalized it, the fenced re-lock
 *      finds zero rows (claimed_at no longer matches), so this executor's
 *      resume cannot overwrite the winner's terminal status/business
 *      association — it reports "lost_lease" and writes nothing. This is a
 *      fencing-token pattern, not a plain filing_number keyed update: every
 *      finalize path (success, deferred, failure) uses it.
 *
 * Never call this against the full ~250K hot/warm corpus in one invocation —
 * `limit` bounds the batch. Not wired to any scheduler; caller-invoked only.
 *
 * Known residual limitation: resolveOrganization() itself runs OUTSIDE this
 * fencing transaction (it has its own transactional/advisory-lock semantics
 * that this module does not control). If this executor loses its lease
 * during the resolveOrganization() call, a business row it creates can be
 * left orphaned (no lineage, no claim association) rather than silently
 * duplicated or corrupting the winner's state — the fencing check still
 * prevents the previously-reported bug (a stale executor overwriting a
 * live winner's terminal status). Losing a lease requires stalling past
 * STALE_CLAIM_MINUTES mid-batch, which is rare in practice for a
 * caller-invoked, small (<=25) bounded batch.
 */
export async function runSunbizBootstrapBatch(
  limit = DEFAULT_BATCH_LIMIT,
  opts: { filingNumberLike?: string; afterId?: number } = {},
  expectedFilingNumbers?: string[],
): Promise<SunbizBootstrapRunOutcome[]> {
  let candidates: SunbizBootstrapCandidate[];
  // Pre-established leases from the atomic snapshot-acquisition path below,
  // keyed by filing_number, so the per-candidate loop can skip re-claiming
  // entities it already atomically holds.
  const preAcquiredLeases = new Map<string, unknown>();

  if (expectedFilingNumbers) {
    // Snapshot-binding: when a caller passes the filing_number set a preview
    // token was minted against, this batch may ONLY execute exactly that
    // set. A prior version of this check re-selected candidates fresh and
    // compared the resulting list to `expectedFilingNumbers`, then claimed
    // each one individually in a separate statement — but that left a
    // TOCTOU race: two concurrent confirmed runs could both pass the
    // comparison before either claimed anything, then split the claims
    // between them, each executing a partial subset the admin never
    // reviewed as such.
    //
    // Instead, acquire a claim on EVERY expected filing_number atomically,
    // inside one transaction, re-verifying live eligibility (the same
    // predicate selectSunbizBootstrapCandidates uses) as part of the same
    // INSERT. If any single acquisition fails — raced by a concurrent run,
    // or the entity is no longer eligible since preview — the whole
    // transaction throws and Postgres rolls back every claim this batch
    // took, so a drifted run performs zero durable writes. Only once ALL
    // expected filings are held does this function proceed to resolve/
    // finalize them (reusing the leases already acquired here).
    const expected = [...expectedFilingNumbers].sort();
    const acquired: Array<{ filingNumber: string; entityId: number; claimedAt: unknown }> = [];
    {
      await db.transaction(async (tx) => {
        for (const filingNumber of expected) {
          const rows = (await tx.execute(sql`
            INSERT INTO sunbiz_bootstrap_claims (filing_number, sunbiz_entity_id, status)
            SELECT se.filing_number, se.id, 'claimed'
            FROM sunbiz_entities se
            WHERE se.filing_number = ${filingNumber}
              AND se.filing_number IS NOT NULL
              AND se.entity_name IS NOT NULL
              AND se.score IN ('hot', 'warm')
              AND (se.website IS NOT NULL OR se.phone IS NOT NULL
                   OR (se.principal_city IS NOT NULL AND se.principal_state IS NOT NULL))
            ON CONFLICT (filing_number) DO UPDATE
              SET status = 'claimed', claimed_at = now(), completed_at = NULL, deferred_reason_code = NULL
              WHERE sunbiz_bootstrap_claims.status = 'failed'
                 OR (sunbiz_bootstrap_claims.status = 'claimed'
                     AND sunbiz_bootstrap_claims.claimed_at < now() - (${STALE_CLAIM_MINUTES} || ' minutes')::interval)
            RETURNING sunbiz_entity_id, claimed_at
          `)).rows as any[];

          if (rows.length === 0) {
            // Either the entity is no longer eligible (disqualified, or
            // missing since preview) or another executor already holds a
            // live claim on it. Throwing here rolls back every claim this
            // transaction already took above, so the batch ends with zero
            // durable writes, not a partial subset.
            throw new SunbizBootstrapSnapshotDriftError(expected, acquired.map((a) => a.filingNumber));
          }
          acquired.push({ filingNumber, entityId: Number(rows[0].sunbiz_entity_id), claimedAt: rows[0].claimed_at });
        }
      });
    }

    for (const a of acquired) preAcquiredLeases.set(a.filingNumber, a.claimedAt);

    const entityIds = acquired.map((a) => a.entityId);
    const detailRows = (await db.execute(sql`
      SELECT id, filing_number, entity_name, website, phone, principal_city, principal_state, principal_zip
      FROM sunbiz_entities
      WHERE id = ANY(${sql.raw(`ARRAY[${entityIds.join(",")}]::int[]`)})
    `)).rows as any[];
    const byFilingNumber = new Map(
      detailRows.map((r) => [
        String(r.filing_number),
        {
          id: Number(r.id),
          filingNumber: String(r.filing_number),
          entityName: String(r.entity_name),
          website: r.website ?? null,
          phone: r.phone ?? null,
          principalCity: r.principal_city ?? null,
          principalState: r.principal_state ?? null,
          principalZip: r.principal_zip ?? null,
        } as SunbizBootstrapCandidate,
      ]),
    );
    // Preserve the expected (sorted) order; every filing is guaranteed
    // present since acquisition above throws on any miss.
    candidates = expected.map((fn) => byFilingNumber.get(fn)!);
  } else {
    candidates = await selectSunbizBootstrapCandidates(limit, opts);
  }

  const outcomes: SunbizBootstrapRunOutcome[] = [];
  const runId = crypto.randomUUID();
  const recordOutcome = async (outcome: SunbizBootstrapRunOutcome) => {
    outcomes.push(outcome);
    try {
      const attempt = rows(await db.execute(sql`
        SELECT COALESCE(MAX(attempt_number), 0)::int + 1 AS attempt_number
        FROM sunbiz_bootstrap_ledger_events
        WHERE filing_number = ${outcome.filingNumber}
      `))[0] as { attempt_number: number } | undefined;
      const reasonCode = outcome.outcome === "identity_review"
        ? "identity_review_required"
        : outcome.outcome === "deferred_collision"
          ? "deferred_collision"
          : outcome.outcome === "failed"
            ? "processing_failed"
            : null;
      await db.execute(sql`
        INSERT INTO sunbiz_bootstrap_ledger_events
          (filing_number, run_id, attempt_number, outcome, deferred_reason_code, business_id, actor)
        VALUES (
          ${outcome.filingNumber}, ${runId}, ${Number(attempt?.attempt_number ?? 1)},
          ${outcome.outcome}, ${reasonCode}, ${outcome.businessId ?? null}, 'system'
        )
      `);
    } catch {
      // Ledger is observational only; its failure must never affect business
      // or source-link writes.
      console.warn(`[Sunbiz Bootstrap] Ledger insert failed for filing ${outcome.filingNumber}; outcome=${outcome.outcome}`);
    }
  };

  for (const candidate of candidates) {
    let myLeaseToken: unknown;
    if (preAcquiredLeases.has(candidate.filingNumber)) {
      // Already atomically claimed above as part of the all-or-none
      // snapshot acquisition; no separate claim statement needed here.
      myLeaseToken = preAcquiredLeases.get(candidate.filingNumber);
    } else {
      const claimRows = (await db.execute(sql`
        INSERT INTO sunbiz_bootstrap_claims (filing_number, sunbiz_entity_id, status)
        VALUES (${candidate.filingNumber}, ${candidate.id}, 'claimed')
        ON CONFLICT (filing_number) DO UPDATE
          SET status = 'claimed', claimed_at = now(), completed_at = NULL, deferred_reason_code = NULL
          WHERE sunbiz_bootstrap_claims.status = 'failed'
             OR (sunbiz_bootstrap_claims.status = 'claimed'
                 AND sunbiz_bootstrap_claims.claimed_at < now() - (${STALE_CLAIM_MINUTES} || ' minutes')::interval)
        RETURNING id, claimed_at
      `)).rows as any[];

      if (claimRows.length === 0) {
        await recordOutcome({ filingNumber: candidate.filingNumber, entityName: candidate.entityName, outcome: "already_claimed" });
        continue;
      }

      // Lease fencing token: the EXACT claimed_at value this executor was
      // just granted. Every later write to this claim row must be
      // conditioned on claimed_at still equalling this value — if another
      // executor reclaimed the row (which always bumps claimed_at), that
      // write becomes a no-op instead of an overwrite.
      myLeaseToken = claimRows[0].claimed_at;
    }

    if (await wasPromotedByLegacySunbiz(candidate.filingNumber)) {
      const won = await db.transaction(async (tx) => {
        const locked = rows(await tx.execute(sql`
          SELECT id FROM sunbiz_bootstrap_claims
          WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
          FOR UPDATE
        `));
        if (!locked.length) return false;
        await tx.execute(sql`
          UPDATE sunbiz_bootstrap_claims
          SET status = 'deferred_collision', deferred_reason_code = 'legacy_sunbiz_promotion_exists', completed_at = now()
          WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
        `);
        return true;
      });
      await recordOutcome({
        filingNumber: candidate.filingNumber,
        entityName: candidate.entityName,
        outcome: won ? "deferred_collision" : "lost_lease",
      });
      continue;
    }

    const crosswalkBusinessId = await findCRO03BCrosswalkBusiness(candidate.filingNumber);
    if (crosswalkBusinessId != null) {
      const finalized = await db.transaction(async (tx) => {
        const locked = rows(await tx.execute(sql`
          SELECT id FROM sunbiz_bootstrap_claims
          WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
          FOR UPDATE
        `));
        if (!locked.length) return { won: false, projection: null as SunbizProjectionResult | null };
        const projection = await attachLineageAndProjectMissingFields(tx, candidate, crosswalkBusinessId);
        if (projection.lineageConflict) {
          await tx.execute(sql`
            UPDATE sunbiz_bootstrap_claims
            SET status = 'deferred_collision', deferred_reason_code = 'sunbiz_lineage_business_conflict', completed_at = now()
            WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
          `);
          return { won: true, projection };
        }
        await tx.execute(sql`
          UPDATE sunbiz_bootstrap_claims
          SET status = 'matched_existing', business_id = ${crosswalkBusinessId}, completed_at = now()
          WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
        `);
        return { won: true, projection };
      });
      const projection = finalized.projection;
      const freeRecrawl = finalized.won && projection?.projectedDomain
        ? await enqueueProjectedDomainRecrawl(crosswalkBusinessId, candidate.filingNumber)
        : "not_needed";
      await recordOutcome({
        filingNumber: candidate.filingNumber,
        entityName: candidate.entityName,
        outcome: !finalized.won ? "lost_lease" : projection?.lineageConflict ? "deferred_collision" : "matched_existing",
        ...(!projection?.lineageConflict && finalized.won ? { businessId: crosswalkBusinessId } : {}),
        ...(projection ? {
          projectedDomain: projection.projectedDomain,
          projectedPhone: projection.projectedPhone,
          domainConflict: projection.domainConflict,
          phoneConflict: projection.phoneConflict,
        } : {}),
        ...(finalized.won && projection?.projectedDomain ? { freeRecrawl } : {}),
        ...(projection?.lineageConflict ? { error: "Sunbiz filing lineage already belongs to a different business." } : {}),
      });
      continue;
    }

    let identityReview = false;
    const priorClaimBusinessRows = rows(await db.execute(sql`
      SELECT business_id FROM sunbiz_bootstrap_claims
      WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
    `)) as Array<{ business_id: number | null }>;
    const previouslyAssociatedBusinessId = priorClaimBusinessRows[0]?.business_id == null
      ? null
      : Number(priorClaimBusinessRows[0].business_id);
    let resolution: Awaited<ReturnType<typeof resolveOrganization>> | {
      kind: "deferred";
      reasonCode: "IDENTITY_REVIEW_REQUIRED";
      candidateIds: number[];
    };
    try {
      // New roots start quarantined at the database default. Their class is
      // initialized only after the claim and source lineage are atomically
      // verified below; a matched business is never reclassified.
      resolution = await resolveOrganization({
        ...toResolverInput(candidate),
      });
      if (resolution.kind === "matched" &&
          resolution.business.id !== previouslyAssociatedBusinessId &&
          !compatibleIdentityName(candidate.entityName, resolution.business.canonicalName) &&
          (!compatibleCityState(candidate, resolution.business) ||
            namesClearlyConflict(candidate.entityName, resolution.business.canonicalName))) {
        identityReview = true;
        resolution = {
          kind: "deferred",
          reasonCode: "IDENTITY_REVIEW_REQUIRED",
          candidateIds: [resolution.business.id],
        };
      }
    } catch (err: any) {
      // Retry/dead-letter: bump retry_count; once it reaches the threshold
      // this filing becomes permanently terminal (dead_letter) so it stops
      // being re-selected by both the bounded admin route and the full
      // backfill worker, instead of retrying the same failure forever.
      const fenced = (await db.execute(sql`
        UPDATE sunbiz_bootstrap_claims
        SET status = CASE WHEN retry_count + 1 >= ${SUNBIZ_BACKFILL_MAX_RETRIES} THEN 'dead_letter' ELSE 'failed' END,
            retry_count = retry_count + 1,
            deferred_reason_code = ${String(err?.message ?? err).slice(0, 250)},
            completed_at = now()
        WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
        RETURNING id, status
      `)).rows as any[];
      await recordOutcome(
        fenced.length === 0
          ? { filingNumber: candidate.filingNumber, entityName: candidate.entityName, outcome: "lost_lease" }
          : {
              filingNumber: candidate.filingNumber,
              entityName: candidate.entityName,
              outcome: fenced[0].status === "dead_letter" ? "dead_letter" : "failed",
              error: String(err?.message ?? err),
            },
      );
      continue;
    }

    const finalStatus =
      resolution.kind === "created" ? "created" : resolution.kind === "matched" ? "matched_existing" : "deferred_collision";
    const businessId = resolution.kind === "created" || resolution.kind === "matched" ? resolution.business.id : undefined;

    // Finalize (lineage insert + claim status) atomically, gated by a
    // fenced re-lock of the claim row so a stale executor resuming after a
    // reclaim can never overwrite the current holder's result.
    const finalized: SunbizFinalizeResult = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        SELECT id FROM sunbiz_bootstrap_claims
        WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
        FOR UPDATE
      `)).rows as any[];
      if (locked.length === 0) return { won: false, projection: null as SunbizProjectionResult | null };

      if (resolution.kind === "created" || resolution.kind === "matched") {
        if (resolution.kind === "created") {
          await lockCommercialGraphNodes(tx, [{ type: "business", id: resolution.business.id }]);
        }
        const projection = await attachLineageAndProjectMissingFields(tx, candidate, resolution.business.id);
        if (projection.lineageConflict) {
          await tx.execute(sql`
            UPDATE sunbiz_bootstrap_claims
            SET status = 'deferred_collision', deferred_reason_code = 'sunbiz_lineage_business_conflict', completed_at = now()
            WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
          `);
          return { won: true, projection };
        }
        const classification = resolution.kind === "created"
          ? await initializeSunbizBootstrapBusinessClass({
              businessId: resolution.business.id,
              filingNumber: candidate.filingNumber,
              claimMode: "active_lease",
              claimLease: myLeaseToken,
              transaction: tx,
            })
          : null;
        await tx.execute(sql`
          UPDATE sunbiz_bootstrap_claims
          SET status = ${finalStatus}, business_id = ${resolution.business.id}, completed_at = now()
          WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
        `);
        return {
          won: true,
          projection,
          ...(classification?.eventId != null ? { classificationEventId: classification.eventId } : {}),
          ...(classification ? { classificationDecision: classification.decision } : {}),
          ...(classification?.reasonCode ? { classificationReasonCode: classification.reasonCode } : {}),
        };
      } else {
        await tx.execute(sql`
          UPDATE sunbiz_bootstrap_claims
          SET status = 'deferred_collision',
              deferred_reason_code = ${identityReview ? "identity_review_required" : resolution.reasonCode},
              completed_at = now()
          WHERE filing_number = ${candidate.filingNumber} AND claimed_at = ${myLeaseToken}
        `);
        return { won: true, projection: null as SunbizProjectionResult | null };
      }
    });

    if (!finalized.won) {
      await recordOutcome({ filingNumber: candidate.filingNumber, entityName: candidate.entityName, outcome: "lost_lease" });
      continue;
    }

    if (resolution.kind === "created" || resolution.kind === "matched") {
      const projection = finalized.projection;
      if (projection?.lineageConflict) {
        await recordOutcome({
          filingNumber: candidate.filingNumber,
          entityName: candidate.entityName,
          outcome: "deferred_collision",
          error: "Sunbiz filing lineage already belongs to a different business.",
        });
        continue;
      }
      const freeRecrawl = projection?.projectedDomain
        ? await enqueueProjectedDomainRecrawl(resolution.business.id, candidate.filingNumber)
        : "not_needed";
      await recordOutcome({
        filingNumber: candidate.filingNumber,
        entityName: candidate.entityName,
        outcome: resolution.kind === "created" ? "created" : "matched_existing",
        businessId,
        ...(projection ? {
          projectedDomain: projection.projectedDomain,
          projectedPhone: projection.projectedPhone,
          domainConflict: projection.domainConflict,
          phoneConflict: projection.phoneConflict,
        } : {}),
        ...(projection?.projectedDomain ? { freeRecrawl } : {}),
        ...(finalized.classificationEventId != null ? { classificationEventId: finalized.classificationEventId } : {}),
        ...(finalized.classificationDecision ? { classificationDecision: finalized.classificationDecision } : {}),
        ...(finalized.classificationReasonCode ? { classificationReasonCode: finalized.classificationReasonCode } : {}),
      });
    } else {
      await recordOutcome({
        filingNumber: candidate.filingNumber,
        entityName: candidate.entityName,
        outcome: identityReview ? "identity_review" : "deferred_collision",
      });
    }
  }

  return outcomes;
}
