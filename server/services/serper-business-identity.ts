/**
 * serper-business-identity.ts — Structured business-identity lookup (#1768)
 *
 * Provides a governed, identity-validated business lookup separate from the
 * generic web-evidence `searchBusiness()`. Uses Places-first waterfall with
 * deterministic name similarity + geographic corroboration scoring.
 *
 * Kill lines enforced by this module:
 *  - First result never accepted without identity + geography validation
 *  - Officer/agent surname alone never causes acceptance
 *  - Email addresses from snippets are never collected or returned
 *  - All calls flow through SerperGateway (no raw fetch)
 *  - No raw query, response, email, phone, personal name, or address in logs
 */

import type { SerperGateway } from "./serper-gateway";

// ── Threshold constants (named + justified by fixture tests) ─────────────────

/** Minimum identity score (0–1) for a candidate to be accepted outright.
 *
 * Justification: A score of 0.50 requires either exact normalized-name match
 * (0.60 alone) or near-name match + ZIP corroboration (0.45 + 0.10 = 0.55).
 * Fixture: "Miami Dental LLC" vs "Miami Dental" at Jaccard 0.67 + ZIP 0.10 = 0.77 → accept.
 *          "Smith LLC" vs "Jones Corp" at Jaccard 0.00 + city 0.05 = 0.05 → reject. */
export const MIN_IDENTITY_SCORE = 0.50;

/** Minimum margin by which the top candidate must beat the runner-up.
 *
 * Justification: Two equally-named businesses in the same city cannot be
 * disambiguated — both score identically. A 0.10 margin filters these.
 * Fixture: two "Miami Auto" shops at identical score → ambiguous, not accepted. */
export const MIN_MARGIN_OVER_RUNNER_UP = 0.10;

/** Maximum Serper requests per `lookupBusinessIdentity()` call.
 *
 * Justification: 4 strategies × 1 call each, with Places capped at 2. */
export const MAX_REQUESTS_PER_LOOKUP = 4;

/**
 * Version of the matcher and query rules. Lookup memory is keyed to this value, so
 * bumping it reopens every business that was last judged under an older rule.
 * Bump whenever scoring, geography checks, query construction or the fallback
 * policy change in a way that can alter an outcome.
 *   1 = original matcher (state compared as plain text)
 *   2 = SFP returned-geography gate
 *   3 = FL/Florida normalization, per-candidate reason codes, fallback gate
 */
export const SERPER_MATCHER_RULE_VERSION = 3;

/** Non-identifying "reason:count" summary of rejected candidates, e.g. "name_mismatch:3,state_conflict:1". */
export function summarizeRejectionReasons(scored: Array<{ rejectionReason: string | null; source?: string }>): string | null {
  const counts = new Map<string, number>();
  for (const c of scored) {
    if (!c.rejectionReason) continue;
    const key = c.source === "knowledge_graph" ? `kg_${c.rejectionReason}` : c.rejectionReason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(",");
}

// ── Name normalizer ──────────────────────────────────────────────────────────

/** Terminal legal designators — only stripped at the END of the name.
 *
 * Important: terms like "Company", "Group", "Services", "Solutions",
 * "International", "Partners", "Associates", and "of Florida" are intentionally
 * NOT removed when they appear in a non-terminal position or are meaningful
 * parts of the brand. Only pure trailing legal suffixes are removed. */
const TERMINAL_LEGAL_SUFFIX_PATTERN =
  /[,.\s]*(?:L\.?L\.?C\.?|Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|L\.?L\.?P\.?|L\.?P\.?|P\.?L\.?L\.?C\.?|P\.?A\.?|P\.?C\.?)\.?$/gi;

export type NormalizeResult =
  | { normalized: string }
  | { invalid: true; reason: string };

/**
 * Shared, idempotent business-name normalizer.
 *
 * Steps:
 *  1. Unicode normalize (NFC)
 *  2. Remove only terminal legal designators (suffix variants + punctuation)
 *  3. Case-fold to lowercase
 *  4. Normalize interior whitespace
 *  5. Reject inputs that reduce to empty after normalization
 *
 * Does NOT remove: Company, Group, Services, Solutions, International,
 * Partners, Associates, "of Florida", abbreviations in the middle of a name.
 */
export function normalizeBusinessName(name: string): NormalizeResult {
  if (!name || typeof name !== "string") {
    return { invalid: true, reason: "input_not_a_string" };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { invalid: true, reason: "empty_input" };
  }

  // NFC normalize for consistent Unicode representation
  let result = trimmed.normalize("NFC");

  // Remove terminal legal designators iteratively (handles stacked suffixes
  // like "Smith Corp, Inc." → "Smith Corp" → "Smith")
  let prev: string;
  do {
    prev = result;
    result = result.replace(TERMINAL_LEGAL_SUFFIX_PATTERN, "").trim();
  } while (result !== prev);

  // Case-fold
  result = result.toLowerCase();

  // Normalize whitespace (collapse internal multiple spaces)
  result = result.replace(/\s+/g, " ").trim();

  if (result.length === 0) {
    return { invalid: true, reason: "reduces_to_empty_after_normalization" };
  }

  return { normalized: result };
}

// ── Token-set similarity (Jaccard on word tokens) ───────────────────────────

function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Directory/aggregator domain rejection ────────────────────────────────────

const DIRECTORY_DOMAINS = new Set([
  "google.com", "gstatic.com", "googleapis.com", "sunbiz.org",
  "wikipedia.org", "reddit.com", "pinterest.com", "tiktok.com",
  "apple.com", "amazon.com", "nextdoor.com", "dandb.com",
  "indeed.com", "glassdoor.com", "facebook.com", "linkedin.com",
  "yelp.com", "bbb.org", "yellowpages.com", "mapquest.com",
  "tripadvisor.com", "chamberofcommerce.com", "manta.com",
  "angi.com", "thumbtack.com", "homeadvisor.com", "instagram.com",
  "twitter.com", "x.com", "bing.com", "yahoo.com", "mapquest.com",
  "whitepages.com", "bizbuysell.com",
]);

function isDirectoryDomain(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(
      url.startsWith("http") ? url : `https://${url}`,
    ).hostname.replace(/^www\./, "");
    return DIRECTORY_DOMAINS.has(hostname) ||
      [...DIRECTORY_DOMAINS].some((d) => hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// ── Address field extractor (parse Serper returned addresses) ─────────────────

/**
 * Parse a US address string like "123 Main St, Miami, FL 33101" or
 * "456 Oak Ave, Tampa, FL 33601-1234" into city/state/ZIP fields.
 *
 * This is used to extract the RETURNED candidate's geography from the Serper
 * response, so that we score against what Serper actually found rather than
 * injecting the query's input values into every candidate's geo fields.
 *
 * Falls back gracefully — missing fields remain null.
 */
export function parseAddressFields(
  address: string | null | undefined,
): { city: string | null; state: string | null; zip: string | null } {
  if (!address) return { city: null, state: null, zip: null };

  // Try standard "..., City, ST ZIP" or "..., City, ST ZIP-PLUS4"
  // The state is 2 uppercase letters; ZIP is 5 digits optionally followed by -NNNN
  const usPattern = /,\s*([A-Za-z .']+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/;
  const match = address.match(usPattern);
  if (match) {
    return {
      city: match[1].trim() || null,
      state: match[2] || null,
      zip: match[3] || null,
    };
  }

  // Fallback: try to extract just ZIP from anywhere in the string
  const zipMatch = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return {
    city: null,
    state: null,
    zip: zipMatch ? zipMatch[1] : null,
  };
}

// ── Geographic corroboration helpers ─────────────────────────────────────────

function normalizeZip(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const digits = zip.replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

const US_STATE_CODES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", "district of columbia": "dc", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky",
  louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh",
  "new jersey": "nj", "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd",
  ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode island": "ri",
  "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};

/**
 * Canonical lowercase two-letter US state code. Accepts a code ("FL", "fl.") or a full
 * name ("Florida"); unrecognized values are returned cleaned so they still compare
 * equal only to themselves. Empty input returns "".
 */
export function normalizeStateCode(state: string | null | undefined): string {
  const cleaned = (state ?? "").trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return US_STATE_CODES[cleaned] ?? cleaned;
}

function normalizeCityState(city: string | null | undefined, state: string | null | undefined): string | null {
  const c = (city ?? "").trim().toLowerCase().replace(/[^a-z\s]/g, "");
  const s = normalizeStateCode(state);
  if (!c && !s) return null;
  return `${c}|${s}`;
}

function addressTokenOverlap(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  // Remove very common address words that don't distinguish
  const stopWords = new Set(["st", "ave", "blvd", "dr", "rd", "ln", "ct", "fl", "florida", "suite", "ste"]);
  for (const stop of stopWords) { tokA.delete(stop); tokB.delete(stop); }
  return jaccardSimilarity(tokA, tokB);
}

// ── Candidate scoring ─────────────────────────────────────────────────────────

export type CandidateClassification =
  | "accepted_match"
  | "ambiguous"
  | "identity_rejected"
  | "no_usable_fields"
  | "directory_domain";

/** Where a candidate came from. Organic results never carry a returned address. */
export type CandidateSource = "places" | "knowledge_graph" | "organic";

/** Non-identifying reason codes for every non-accepted candidate. */
export type CandidateRejectionReason =
  | "directory_domain"
  | "no_usable_fields"
  | "name_mismatch"
  | "score_below_threshold"
  | "state_conflict"
  | "zip_conflict"
  | "organic_unsupported_geography"
  | "geography_uncorroborated";

/** Name similarity below this (of a possible 0.60) means the names effectively differ. */
const NAME_MISMATCH_MAX_NAME_SCORE = 0.30;

export interface ScoredCandidate {
  score: number;
  classification: CandidateClassification;
  rejectionReason: CandidateRejectionReason | null;
  source: CandidateSource;
  nameScore: number;
  geoScore: number;
  website: string | null;
  phone: string | null;
  address: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
}

export interface CandidateQuery {
  businessName: string;
  /** SFP domain discovery requires returned geography, not query geography. */
  requireGeographicCorroboration?: boolean;
  zip?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
}

export interface CandidateInput {
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  website?: string | null;
  phone?: string | null;
  phoneNumber?: string | null;
  category?: string | null;
  rating?: number | string | null;
  reviewsCount?: number | string | null;
  /** Officer/agent-only hint — never used as standalone acceptance evidence */
  officerSurname?: string | null;
  source?: CandidateSource;
}

/**
 * Deterministic identity score for one candidate against the query.
 *
 * Score breakdown (max 1.0):
 *  - Name similarity (Jaccard token overlap): 0–0.60
 *  - ZIP match: 0.10
 *  - City+state match: 0.05 each
 *  - Address partial overlap: 0–0.10
 *
 * Geography corroboration adds up to 0.30 total. Legacy callers may accept
 * a strong name alone; SFP opts into a separate returned-geography gate so
 * a same-name business outside the program cannot become an official domain.
 *
 * Officer-surname-only hints are intentionally excluded from the score to
 * prevent accepting a wrong business that happens to share an officer name.
 */
export function scoreCandidate(
  query: CandidateQuery,
  candidate: CandidateInput,
): ScoredCandidate {
  const candidateName = candidate.name ?? "";
  const queryNorm = normalizeBusinessName(query.businessName);
  const candidateNorm = normalizeBusinessName(candidateName);

  // Name similarity
  let nameScore = 0;
  if (!("invalid" in queryNorm) && !("invalid" in candidateNorm)) {
    const qTokens = tokenize(queryNorm.normalized);
    const cTokens = tokenize(candidateNorm.normalized);
    nameScore = jaccardSimilarity(qTokens, cTokens) * 0.60;
  }

  // Geographic corroboration
  let geoScore = 0;
  const qZip = normalizeZip(query.zip);
  const cZip = normalizeZip(candidate.zip);
  // Businesses store both "FL" and "Florida"; returned addresses carry "FL".
  // Compare canonical codes so identical evidence yields identical results.
  const queryState = normalizeStateCode(query.state);
  const returnedState = normalizeStateCode(candidate.state);
  const conflictingState = !!(queryState && returnedState && queryState !== returnedState);
  const conflictingZip = !!(qZip && cZip && qZip !== cZip);
  const zipCorroborated = !!(qZip && cZip && qZip === cZip);
  const cityStateCorroborated = !!(
    query.city?.trim() && candidate.city?.trim() && queryState && returnedState &&
    query.city.trim().toLowerCase() === candidate.city.trim().toLowerCase() &&
    queryState === returnedState
  );
  if (qZip && cZip && qZip === cZip) {
    geoScore += 0.10;
  }
  const qCityState = normalizeCityState(query.city, query.state);
  const cCityState = normalizeCityState(candidate.city, candidate.state);
  if (qCityState && cCityState) {
    const [qCity, qState] = qCityState.split("|");
    const [cCity, cState] = cCityState.split("|");
    if (qCity && cCity && qCity === cCity) geoScore += 0.05;
    if (qState && cState && qState === cState) geoScore += 0.05;
  }
  const addrOverlap = addressTokenOverlap(query.address, candidate.address);
  geoScore += addrOverlap * 0.10;

  const score = Math.min(1.0, nameScore + geoScore);

  // Extract usable fields
  let website: string | null = null;
  if (candidate.website && !isDirectoryDomain(candidate.website)) {
    try {
      const url = new URL(
        candidate.website.startsWith("http")
          ? candidate.website
          : `https://${candidate.website}`,
      );
      website = url.hostname.replace(/^www\./, "");
    } catch {
      // malformed URL — skip
    }
  }

  const rawPhone = candidate.phone ?? candidate.phoneNumber ?? null;
  let phone: string | null = null;
  if (rawPhone) {
    const digits = rawPhone.replace(/[^\d]/g, "");
    if (digits.length >= 10) phone = digits.slice(-10);
  }

  const address = candidate.address ?? null;
  const category = candidate.category ?? null;
  const rating = candidate.rating != null ? parseFloat(String(candidate.rating)) : null;
  const reviewCount = candidate.reviewsCount != null ? parseInt(String(candidate.reviewsCount)) : null;

  const source: CandidateSource = candidate.source ?? "places";
  const base = { nameScore, geoScore, website, phone, address, category, rating, reviewCount, source };
  const reject = (
    classification: CandidateClassification,
    rejectionReason: CandidateRejectionReason,
  ): ScoredCandidate => ({ score, classification, rejectionReason, ...base });

  // Classification: check directory/aggregator domain first
  if (candidate.website && isDirectoryDomain(candidate.website) && !website) {
    return reject("directory_domain", "directory_domain");
  }

  // No usable fields
  if (!website && !phone && !address) {
    return reject("no_usable_fields", "no_usable_fields");
  }

  // Score too low
  if (score < MIN_IDENTITY_SCORE) {
    return reject(
      "identity_rejected",
      nameScore < NAME_MISMATCH_MAX_NAME_SCORE ? "name_mismatch" : "score_below_threshold",
    );
  }

  // A common-name website in another state is not the queried local business.
  // For SFP, organic results without an address must remain unverified rather
  // than inheriting geography from the search text or the queried business.
  if (query.requireGeographicCorroboration &&
      (conflictingState || conflictingZip || !(zipCorroborated || cityStateCorroborated))) {
    return reject(
      "identity_rejected",
      conflictingState ? "state_conflict"
        : conflictingZip ? "zip_conflict"
        : source === "organic" ? "organic_unsupported_geography"
        : "geography_uncorroborated",
    );
  }

  // All scoring done at this point; ambiguity resolved by caller after comparing all candidates
  return { score, classification: "accepted_match", rejectionReason: null, ...base };
}

// ── Outcome classification ────────────────────────────────────────────────────

export type LookupOutcomeKind =
  | "blocked"
  | "provider_failure"
  | "no_result"
  | "identity_rejected"
  | "ambiguous"
  | "accepted_match";

export interface LookupOutcome {
  kind: LookupOutcomeKind;
  reason?: string;
  /** Present when kind === "accepted_match" */
  accepted?: {
    website: string | null;
    phone: string | null;
    address: string | null;
    category: string | null;
    rating: number | null;
    reviewCount: number | null;
    score: number;
    strategy: string;
    endpoint: "/places" | "/search";
    requestsUsed: number;
  };
  /** All scored candidates for audit purposes (never includes email) */
  scoredCandidates?: ScoredCandidate[];
  /** Non-identifying rejection-reason counts across all scored candidates. */
  rejectionSummary?: string | null;
  /** Set when a strategy was deliberately not run, with the reason. */
  fallbackSkippedReason?: string;
  /** Credits the provider reported charging across this lookup; null when it reported none. */
  reportedCredits?: number | null;
  requestsUsed: number;
  strategiesAttempted: string[];
}

// ── Input shape for lookupBusinessIdentity ────────────────────────────────────

export interface BusinessIdentityInput {
  /** Primary name (DBA name if available) */
  businessName: string;
  requireGeographicCorroboration?: boolean;
  /** Legal/registered name (used as a second strategy when DBA differs) */
  legalName?: string | null;
  zip?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  /** Officer/agent surname — only combined with name+geography, never standalone */
  officerSurname?: string | null;
}

export interface BusinessIdentityContext {
  /** Caller identifier for telemetry */
  caller: string;
  /** SerperGateway instance (injectable for tests) */
  gateway?: SerperGateway;
  /**
   * Consulted immediately before EVERY provider request, including the second and later
   * requests of one lookup. Returning false stops the lookup before that request is sent
   * (the outcome is "blocked" with reason "allowance_exhausted" and nothing is counted).
   */
  authorizeRequest?: (request: { endpoint: "/places" | "/search" }) => boolean | Promise<boolean>;
  /** Awaited after each request that reached the provider, with the credits it reported (null = unknown). */
  onRequestSettled?: (info: { endpoint: "/places" | "/search"; reportedCredits: number | null }) => void | Promise<void>;
  /** Awaited when an authorized request was blocked locally and never reached the provider. */
  onRequestNotSent?: (info: { endpoint: "/places" | "/search" }) => void | Promise<void>;
}

// ── Attempt telemetry writer ─────────────────────────────────────────────────

export interface AttemptTelemetry {
  correlationHash: string;
  caller: string;
  strategyVersion: number;
  strategyName: string;
  endpoint: string;
  outcomeKind: LookupOutcomeKind;
  outcomeReason: string | null;
  resultCount: number;
  acceptedCount: number;
  rejectedCount: number;
  yieldWebsite: boolean;
  yieldPhone: boolean;
  yieldAddress: boolean;
  yieldCategory: boolean;
  elapsedMs: number;
  billedUnits: number;
  /** Credits the provider reported charging for this request, when it reports them. */
  reportedCredits?: number | null;
  ruleVersion?: number;
}

/** Async fire-and-forget telemetry insert — never throws. */
async function recordAttemptTelemetry(tel: AttemptTelemetry): Promise<void> {
  try {
    const { pool } = await import("../db");
    await pool.query(
      `INSERT INTO serper_lookup_attempts (
         correlation_hash, caller, strategy_version, strategy_name, endpoint,
         outcome_kind, outcome_reason, result_count, accepted_count, rejected_count,
         yield_website, yield_phone, yield_address, yield_category,
         elapsed_ms, billed_units, reported_credits, rule_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        tel.correlationHash,
        tel.caller.slice(0, 200),
        tel.strategyVersion,
        tel.strategyName.slice(0, 80),
        tel.endpoint.slice(0, 20),
        tel.outcomeKind,
        tel.outcomeReason?.slice(0, 200) ?? null,
        tel.resultCount,
        tel.acceptedCount,
        tel.rejectedCount,
        tel.yieldWebsite,
        tel.yieldPhone,
        tel.yieldAddress,
        tel.yieldCategory,
        tel.elapsedMs,
        tel.billedUnits,
        tel.reportedCredits ?? null,
        tel.ruleVersion ?? SERPER_MATCHER_RULE_VERSION,
      ],
    );
  } catch {
    // Telemetry failures must never block the enrichment path
  }
}

function reportedCreditsOf(data: any): number | null {
  const credits = data?.credits;
  return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? Math.round(credits) : null;
}

// ── Core lookup waterfall ─────────────────────────────────────────────────────

/**
 * Structured business-identity lookup using a Places-first waterfall.
 *
 * Strategy order:
 *  1. DBA or business name via /places with ZIP in query, city/state in location
 *  2. Legal/alternate name variant via /places (if different from strategy 1)
 *  3. /search fallback (when both Places strategies yield nothing)
 *  4. Officer-hint combined with name + geography only (optional, bounded)
 *
 * Acceptance requires identity score ≥ MIN_IDENTITY_SCORE AND a margin of
 * ≥ MIN_MARGIN_OVER_RUNNER_UP over the next-best candidate. Ambiguous results
 * never advance to canonical fields.
 *
 * No email collection at any point.
 */
export async function lookupBusinessIdentity(
  input: BusinessIdentityInput,
  context: BusinessIdentityContext,
): Promise<LookupOutcome> {
  const tracker: LookupTracker = { credits: null, fallbackSkippedReason: undefined };
  const outcome = await runLookup(input, context, tracker);
  const summary = outcome.scoredCandidates ? summarizeRejectionReasons(outcome.scoredCandidates) : null;
  return {
    ...outcome,
    rejectionSummary: summary,
    reportedCredits: tracker.credits,
    ...(tracker.fallbackSkippedReason ? { fallbackSkippedReason: tracker.fallbackSkippedReason } : {}),
  };
}

interface LookupTracker {
  credits: number | null;
  fallbackSkippedReason: string | undefined;
}

async function runLookup(
  input: BusinessIdentityInput,
  context: BusinessIdentityContext,
  tracker: LookupTracker,
): Promise<LookupOutcome> {
  // Injected unit transports must not initialize production database state.
  // The non-injected path still uses the identical governed gateway.
  const gateway = context.gateway ?? (await import("./serper-gateway")).serperGateway;
  const startedAt = Date.now();
  const strategyVersion = input.requireGeographicCorroboration ? 2 : 1;
  let requestsUsed = 0;
  const strategiesAttempted: string[] = [];

  // Stable, non-PII correlation hash for telemetry (hashes the query parameters,
  // never the response or personal data)
  const { createHash } = await import("node:crypto");
  const correlationHash = createHash("sha256")
    .update(
      JSON.stringify({
        name: normalizeBusinessName(input.businessName),
        zip: normalizeZip(input.zip),
        city: (input.city ?? "").toLowerCase().trim(),
        state: (input.state ?? "").toLowerCase().trim(),
        strategyVersion,
      }),
    )
    .digest("hex");

  const buildGeoLocation = (): string => {
    const parts = [input.city, input.state].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : "Florida, US";
  };

  const geoLocation = buildGeoLocation();

  const noteCredits = (data: unknown) => {
    const credits = reportedCreditsOf(data);
    if (credits !== null) tracker.credits = (tracker.credits ?? 0) + credits;
  };

  /** Execute a single /places call and score all candidates. */
  async function tryPlaces(
    nameVariant: string,
    strategyName: string,
  ): Promise<{ scored: ScoredCandidate[]; outcome: LookupOutcomeKind; reason?: string }> {
    const normResult = normalizeBusinessName(nameVariant);
    const queryName = "invalid" in normResult ? nameVariant : normResult.normalized;
    // ZIP is embedded in the query string for better local specificity
    const queryString = [queryName, input.zip].filter(Boolean).join(" ");

    if (context.authorizeRequest && !(await context.authorizeRequest({ endpoint: "/places" }))) {
      return { scored: [], outcome: "blocked", reason: "allowance_exhausted" };
    }
    strategiesAttempted.push(strategyName);
    const t0 = Date.now();

    const gatewayResult = await gateway.executeSearch(
      "/places",
      { q: queryString, location: geoLocation, gl: "us", hl: "en" },
      `serper_business_identity:${strategyName}`,
    );
    if (!gatewayResult.blocked) {
      requestsUsed++;
      await context.onRequestSettled?.({ endpoint: "/places", reportedCredits: reportedCreditsOf(gatewayResult.data) });
    } else {
      await context.onRequestNotSent?.({ endpoint: "/places" });
    }

    const elapsed = Date.now() - t0;

    if (gatewayResult.blocked) {
      await recordAttemptTelemetry({
        correlationHash, caller: context.caller,
        strategyVersion, strategyName, endpoint: "/places",
        outcomeKind: "blocked", outcomeReason: gatewayResult.blockReason ?? "blocked",
        resultCount: 0, acceptedCount: 0, rejectedCount: 0,
        yieldWebsite: false, yieldPhone: false, yieldAddress: false, yieldCategory: false,
        elapsedMs: elapsed, billedUnits: 0,
      });
      return { scored: [], outcome: "blocked", reason: gatewayResult.blockReason };
    }

    if (!gatewayResult.ok) {
      await recordAttemptTelemetry({
        correlationHash, caller: context.caller,
        strategyVersion, strategyName, endpoint: "/places",
        outcomeKind: "provider_failure", outcomeReason: gatewayResult.error ?? "provider_error",
        resultCount: 0, acceptedCount: 0, rejectedCount: 0,
        yieldWebsite: false, yieldPhone: false, yieldAddress: false, yieldCategory: false,
        elapsedMs: elapsed, billedUnits: 1,
      });
      return { scored: [], outcome: "provider_failure", reason: gatewayResult.error };
    }

    noteCredits(gatewayResult.data);
    const places: CandidateInput[] = (gatewayResult.data?.places ?? []).map((p: any) => {
      // Extract the candidate's ACTUAL returned geography from the address string.
      // This is critical: we must NOT inject the query's city/state/ZIP here, or a
      // wrong-city business would receive full geo corroboration credit.
      const returnedGeo = parseAddressFields(p.address ?? null);
      return {
        name: p.title ?? p.name ?? null,
        address: p.address ?? null,
        // Use returned fields if available; fall back to null (not query values)
        city: returnedGeo.city ?? null,
        state: returnedGeo.state ?? null,
        zip: returnedGeo.zip ?? null,
        website: p.website ?? null,
        phone: p.phoneNumber ?? null,
        category: p.category ?? null,
        rating: p.rating ?? null,
        reviewsCount: p.reviewsCount ?? null,
        source: "places" as const,
      };
    });

    const query: CandidateQuery = {
      businessName: nameVariant,
      requireGeographicCorroboration: input.requireGeographicCorroboration,
      zip: input.zip,
      city: input.city,
      state: input.state,
      address: input.address,
    };

    const scored = places.map((p) => scoreCandidate(query, p));
    const acceptedCount = scored.filter((s) => s.classification === "accepted_match").length;
    const rejectedCount = scored.filter((s) => s.classification === "identity_rejected").length;
    const best = scored[0];

    await recordAttemptTelemetry({
      correlationHash, caller: context.caller,
      strategyVersion, strategyName, endpoint: "/places",
      outcomeKind: acceptedCount > 0 ? "accepted_match" : scored.length === 0 ? "no_result" : "identity_rejected",
      outcomeReason: summarizeRejectionReasons(scored),
      reportedCredits: reportedCreditsOf(gatewayResult.data),
      resultCount: scored.length, acceptedCount, rejectedCount,
      yieldWebsite: scored.some((s) => s.classification === "accepted_match" && !!s.website),
      yieldPhone: scored.some((s) => s.classification === "accepted_match" && !!s.phone),
      yieldAddress: scored.some((s) => s.classification === "accepted_match" && !!s.address),
      yieldCategory: scored.some((s) => s.classification === "accepted_match" && !!s.category),
      elapsedMs: elapsed, billedUnits: 1,
    });

    return {
      scored,
      outcome: acceptedCount > 0 ? "accepted_match" : scored.length === 0 ? "no_result" : "identity_rejected",
    };
  }

  /** Execute a /search fallback and score candidates from organic results. */
  async function trySearch(
    nameVariant: string,
    strategyName: string,
  ): Promise<{ scored: ScoredCandidate[]; outcome: LookupOutcomeKind; reason?: string }> {
    const normResult = normalizeBusinessName(nameVariant);
    const queryName = "invalid" in normResult ? nameVariant : normResult.normalized;
    const queryString = [queryName, input.zip ?? input.city, input.state].filter(Boolean).join(" ");

    if (context.authorizeRequest && !(await context.authorizeRequest({ endpoint: "/search" }))) {
      return { scored: [], outcome: "blocked", reason: "allowance_exhausted" };
    }
    strategiesAttempted.push(strategyName);
    const t0 = Date.now();

    const gatewayResult = await gateway.executeSearch(
      "/search",
      { q: queryString, gl: "us", hl: "en", num: 10 },
      `serper_business_identity:${strategyName}`,
    );
    if (!gatewayResult.blocked) {
      requestsUsed++;
      await context.onRequestSettled?.({ endpoint: "/search", reportedCredits: reportedCreditsOf(gatewayResult.data) });
    } else {
      await context.onRequestNotSent?.({ endpoint: "/search" });
    }

    const elapsed = Date.now() - t0;

    if (gatewayResult.blocked) {
      await recordAttemptTelemetry({
        correlationHash, caller: context.caller,
        strategyVersion, strategyName, endpoint: "/search",
        outcomeKind: "blocked", outcomeReason: gatewayResult.blockReason ?? "blocked",
        resultCount: 0, acceptedCount: 0, rejectedCount: 0,
        yieldWebsite: false, yieldPhone: false, yieldAddress: false, yieldCategory: false,
        elapsedMs: elapsed, billedUnits: 0,
      });
      return { scored: [], outcome: "blocked", reason: gatewayResult.blockReason };
    }

    if (!gatewayResult.ok) {
      await recordAttemptTelemetry({
        correlationHash, caller: context.caller,
        strategyVersion, strategyName, endpoint: "/search",
        outcomeKind: "provider_failure", outcomeReason: gatewayResult.error ?? "provider_error",
        resultCount: 0, acceptedCount: 0, rejectedCount: 0,
        yieldWebsite: false, yieldPhone: false, yieldAddress: false, yieldCategory: false,
        elapsedMs: elapsed, billedUnits: 1,
      });
      return { scored: [], outcome: "provider_failure", reason: gatewayResult.error };
    }

    noteCredits(gatewayResult.data);
    // Extract candidates from knowledge graph + organic results (no email extraction)
    const candidates: CandidateInput[] = [];
    const kg = gatewayResult.data?.knowledgeGraph;
    if (kg) {
      // Parse returned geo from knowledge graph address — do NOT inject query values.
      const kgGeo = parseAddressFields(kg.address ?? null);
      candidates.push({
        name: kg.title ?? nameVariant,
        address: kg.address ?? null,
        city: kgGeo.city ?? null,
        state: kgGeo.state ?? null,
        zip: kgGeo.zip ?? null,
        website: kg.website ?? null,
        phone: kg.phone ?? null,
        category: kg.type ?? null,
        rating: null,
        reviewsCount: null,
        source: "knowledge_graph",
      });
    }

    for (const organic of (gatewayResult.data?.organic ?? []).slice(0, 5)) {
      // Organic results have no reliable address — city/state/zip remain null.
      // Purposely extract no email from snippets (kill line compliance).
      candidates.push({
        name: organic.title ?? null,
        address: null,
        city: null,
        state: null,
        zip: null,
        website: organic.link ?? null,
        phone: null,
        category: null,
        rating: null,
        reviewsCount: null,
        source: "organic",
      });
    }

    const query: CandidateQuery = {
      businessName: nameVariant,
      requireGeographicCorroboration: input.requireGeographicCorroboration,
      zip: input.zip,
      city: input.city,
      state: input.state,
      address: input.address,
    };

    const scored = candidates.map((c) => scoreCandidate(query, c));
    const acceptedCount = scored.filter((s) => s.classification === "accepted_match").length;
    const rejectedCount = scored.filter((s) => s.classification === "identity_rejected").length;

    await recordAttemptTelemetry({
      correlationHash, caller: context.caller,
      strategyVersion, strategyName, endpoint: "/search",
      outcomeKind: acceptedCount > 0 ? "accepted_match" : scored.length === 0 ? "no_result" : "identity_rejected",
      outcomeReason: summarizeRejectionReasons(scored),
      reportedCredits: reportedCreditsOf(gatewayResult.data),
      resultCount: scored.length, acceptedCount, rejectedCount,
      yieldWebsite: scored.some((s) => s.classification === "accepted_match" && !!s.website),
      yieldPhone: false, // /search does not yield phone
      yieldAddress: false, // /search organic results have no address
      yieldCategory: false,
      elapsedMs: elapsed, billedUnits: 1,
    });

    return {
      scored,
      outcome: acceptedCount > 0 ? "accepted_match" : scored.length === 0 ? "no_result" : "identity_rejected",
    };
  }

  /** Resolve ambiguity/acceptance across all scored candidates from one strategy. */
  function resolveFromScored(
    scored: ScoredCandidate[],
    strategyName: string,
    endpoint: "/places" | "/search",
  ): LookupOutcome | null {
    if (scored.length === 0) return null;

    const acceptable = scored
      .filter((s) => s.classification === "accepted_match")
      .sort((a, b) => b.score - a.score);

    if (acceptable.length === 0) return null;

    const best = acceptable[0];
    const runnerUp = acceptable[1] ?? scored.filter((s) => s !== best).sort((a, b) => b.score - a.score)[0];
    const margin = runnerUp ? best.score - runnerUp.score : 1;

    if (margin < MIN_MARGIN_OVER_RUNNER_UP) {
      return {
        kind: "ambiguous",
        reason: `margin_below_threshold:${margin.toFixed(3)}`,
        scoredCandidates: scored,
        requestsUsed,
        strategiesAttempted,
      };
    }

    return {
      kind: "accepted_match",
      accepted: {
        website: best.website,
        phone: best.phone,
        address: best.address,
        category: best.category,
        rating: best.rating,
        reviewCount: best.reviewCount,
        score: best.score,
        strategy: strategyName,
        endpoint,
        requestsUsed,
      },
      scoredCandidates: scored,
      requestsUsed,
      strategiesAttempted,
    };
  }

  // Track whether any strategy found candidates that were scored-but-rejected,
  // vs truly returning zero results. This preserves the distinction between
  // `identity_rejected` (we saw candidates but none passed scoring) and
  // `no_result` (provider returned nothing) in the final fallback outcome.
  let anyScoredCandidatesRejected = false;
  let allScoredCandidates: ScoredCandidate[] = [];

  function trackScoredCandidates(scored: ScoredCandidate[]) {
    if (scored.some((s) => s.classification === "identity_rejected")) {
      anyScoredCandidatesRejected = true;
    }
    allScoredCandidates = [...allScoredCandidates, ...scored];
  }

  // ── Strategy 1: DBA/primary name via /places ───────────────────────────────
  if (requestsUsed < MAX_REQUESTS_PER_LOOKUP) {
    const s1 = await tryPlaces(input.businessName, "places_primary_name");
    if (s1.outcome === "blocked") {
      return { kind: "blocked", reason: s1.reason, requestsUsed, strategiesAttempted };
    }
    if (s1.outcome === "provider_failure") {
      return { kind: "provider_failure", reason: s1.reason, requestsUsed, strategiesAttempted };
    }
    if (s1.scored.length > 0) {
      trackScoredCandidates(s1.scored);
      const resolved = resolveFromScored(s1.scored, "places_primary_name", "/places");
      if (resolved && (resolved.kind === "accepted_match" || resolved.kind === "ambiguous")) {
        return resolved;
      }
    }
  }

  // ── Strategy 2: Legal/alternate name via /places ───────────────────────────
  const alternateName = input.legalName &&
    input.legalName.trim().toLowerCase() !== input.businessName.trim().toLowerCase()
    ? input.legalName
    : null;

  if (alternateName && requestsUsed < MAX_REQUESTS_PER_LOOKUP) {
    const s2 = await tryPlaces(alternateName, "places_legal_name");
    if (s2.outcome === "blocked") {
      return { kind: "blocked", reason: s2.reason, requestsUsed, strategiesAttempted };
    }
    if (s2.outcome === "provider_failure") {
      return { kind: "provider_failure", reason: s2.reason, requestsUsed, strategiesAttempted };
    }
    if (s2.scored.length > 0) {
      trackScoredCandidates(s2.scored);
      const resolved = resolveFromScored(s2.scored, "places_legal_name", "/places");
      if (resolved && (resolved.kind === "accepted_match" || resolved.kind === "ambiguous")) {
        return resolved;
      }
    }
  }

  // ── Strategy 3: /search fallback ─────────────────────────────────────────
  // With returned geography required, an organic result can never be accepted (it has no
  // address); only a knowledge-graph panel can supply geography. The panel describes the
  // same Google listing Places already evaluated, so once Places returned listings and none
  // matched, the fallback only spends a request. It still runs when Places returned nothing,
  // the one case where a knowledge-graph panel can add information. Recorded 20,181
  // production fallback attempts accepted none.
  const placesReturnedListings = allScoredCandidates.some((c) => c.source === "places");
  const fallbackWorthRunning = !(input.requireGeographicCorroboration && placesReturnedListings);
  if (!fallbackWorthRunning) tracker.fallbackSkippedReason = "places_listings_already_evaluated";
  if (fallbackWorthRunning && requestsUsed < MAX_REQUESTS_PER_LOOKUP) {
    const s3 = await trySearch(input.businessName, "search_fallback");
    if (s3.outcome === "blocked") {
      return { kind: "blocked", reason: s3.reason, requestsUsed, strategiesAttempted };
    }
    if (s3.outcome === "provider_failure") {
      return { kind: "provider_failure", reason: s3.reason, requestsUsed, strategiesAttempted };
    }
    if (s3.scored.length > 0) {
      trackScoredCandidates(s3.scored);
      const resolved = resolveFromScored(s3.scored, "search_fallback", "/search");
      if (resolved && (resolved.kind === "accepted_match" || resolved.kind === "ambiguous")) {
        return resolved;
      }
    }
  }

  // ── Strategy 4: Officer-hint combined search (only if officer name provided) ─
  // Officer/agent surname is NEVER used as standalone evidence. It is only
  // combined with the business name + geography as an additional qualifier.
  if (input.officerSurname && requestsUsed < MAX_REQUESTS_PER_LOOKUP) {
    const officerHintName = `${input.businessName} ${input.officerSurname}`.trim();
    const s4 = await trySearch(officerHintName, "search_officer_hint");
    // Propagate blocked/provider_failure from officer strategy — do NOT silently
    // swallow them into no_result, which would incorrectly trigger SDR cooldown backoff.
    if (s4.outcome === "blocked") {
      return { kind: "blocked", reason: s4.reason, requestsUsed, strategiesAttempted };
    }
    if (s4.outcome === "provider_failure") {
      return { kind: "provider_failure", reason: s4.reason, requestsUsed, strategiesAttempted };
    }
    if (s4.scored.length > 0) {
      trackScoredCandidates(s4.scored);
      const resolved = resolveFromScored(s4.scored, "search_officer_hint", "/search");
      if (resolved && (resolved.kind === "accepted_match" || resolved.kind === "ambiguous")) {
        return resolved;
      }
    }
  }

  // All strategies exhausted with no acceptable candidate.
  // Preserve the distinction: if any strategy returned candidates that failed
  // identity scoring, report identity_rejected (the system saw candidates but
  // none passed). If all strategies returned zero results, report no_result.
  const finalKind: LookupOutcomeKind = anyScoredCandidatesRejected
    ? "identity_rejected"
    : "no_result";

  return {
    kind: finalKind,
    reason: anyScoredCandidatesRejected
      ? "all_candidates_failed_identity_scoring"
      : "all_strategies_exhausted",
    scoredCandidates: allScoredCandidates.length > 0 ? allScoredCandidates : undefined,
    requestsUsed,
    strategiesAttempted,
  };
}
