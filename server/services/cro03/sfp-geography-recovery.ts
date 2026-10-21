/**
 * Retained-evidence geography recovery.
 *
 * Businesses whose own city/state/ZIP fields do not resolve are parked by the classification bridge as
 * `geography_review` and never reach website classification. Many of them nevertheless have retained,
 * evidence-backed address facts that were never turned into a location row:
 *   - the structured provider address string kept on businesses.street_address
 *     ("207 Vine Ave, Clearwater, Florida, United States, 33755");
 *   - linked contacts' provider address / city / state;
 *   - the postal address the business's own website declares in schema.org JSON-LD (first-party, free).
 *
 * This module only reads those facts, parses them deterministically (an address component is used only
 * when the text states it) and, when the existing resolver gives a definite answer (in-territory, or a
 * verified out-of-territory state), records ONE business_locations row carrying that evidence. It never
 * guesses a county (county_fips stays NULL; the versioned reference maps ZIP/city exactly as for every other
 * location), never uses a phone area code, never treats a registry (Sunbiz) principal address as an
 * operating site, and never spends: no provider call is reachable from here.
 *
 * Unresolved geography stays "geography_review" with the recovery attempt versioned on the item, so an
 * unchanged business is not re-read every tick; it is never converted into vertical (non-target) evidence.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  resolveGeographyForBusiness, resolveGeographyFromCandidates,
  type LocationCandidateInput,
} from "./sfp-geography-resolver";
import {
  extractWebsiteClassificationEvidence, type WebsiteClassificationEvidence, type WebsiteJsonLdOrganization,
} from "./sfp-website-evidence";

const rows = (result: any): any[] => result?.rows ?? result ?? [];

/** Bump when parsing, source set or acceptance rules change; items are revisited under a new version. */
export const GEOGRAPHY_RECOVERY_VERSION = "retained_geography_recovery_v2";
export const GEOGRAPHY_RECOVERY_RETRY_DAYS = 7;
/** Businesses recovered at once within a tick (each does at most two 6s reads of its own site). */
export const GEOGRAPHY_RECOVERY_CONCURRENCY = 4;

export type RecoveredAddressSource = "business_address" | "contact_address" | "contact_fields" | "website_jsonld";

export interface RecoveredAddress {
  source: RecoveredAddressSource;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** Supporting source reference: which retained fact or page entity states this address, and how it was tied to the business. */
  reference?: Record<string, unknown>;
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME",
  maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN",
  texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};
const STATE_CODES = new Set(Object.values(US_STATES));
const COUNTRY_TOKENS = new Set(["united states", "united states of america", "usa", "us", "u.s.a.", "u.s."]);
const ZIP_TOKEN = /^(\d{5})(?:-\d{4})?$/;

/** The US state a token names (full name or two-letter code), as a two-letter code; null otherwise. */
function stateCodeOf(token: string): string | null {
  const t = token.trim().replace(/\.$/, "");
  const upper = t.toUpperCase();
  if (upper.length === 2 && STATE_CODES.has(upper)) return upper;
  return US_STATES[t.toLowerCase()] ?? null;
}

/**
 * Pure: parse a comma-separated provider address ("street, city, state[, United States][, zip]"). A component is
 * returned only when the text states it. A string that names a non-US country, has no recognizable US state, or
 * has no city/ZIP yields null, so "England, United Kingdom" or "12451 Metro Parkway, #101" recover nothing.
 */
export function parseStructuredAddress(
  text: string | null | undefined, source: RecoveredAddressSource,
): RecoveredAddress | null {
  if (typeof text !== "string") return null;
  const tokens = text.split(",").map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 8) return null;
  let postalCode: string | null = null;
  let state: string | null = null;
  // Peel from the right: ZIP / "FL 33130", country, state, then the city.
  const last = tokens[tokens.length - 1];
  const zipOnly = ZIP_TOKEN.exec(last);
  const stateZip = /^([A-Za-z .]+?)\s+(\d{5})(?:-\d{4})?$/.exec(last);
  if (zipOnly) { postalCode = zipOnly[1]; tokens.pop(); }
  else if (stateZip && stateCodeOf(stateZip[1])) { postalCode = stateZip[2]; state = stateCodeOf(stateZip[1]); tokens.pop(); }
  if (tokens.length && COUNTRY_TOKENS.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();
  if (!state && tokens.length) {
    const candidate = stateCodeOf(tokens[tokens.length - 1]);
    if (candidate) { state = candidate; tokens.pop(); }
  }
  if (!state) return null;
  const city = tokens.length ? tokens[tokens.length - 1] : null;
  if (city && (/\d/.test(city) || city.length > 60)) return null;
  const streetTokens = city ? tokens.slice(0, -1) : tokens;
  if (!city && !postalCode) return null;
  return { source, streetAddress: streetTokens.length ? streetTokens.join(", ") : null, city, state, postalCode };
}

const ENTITY_SUFFIX_TOKENS = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "the", "pllc", "pa", "pc",
  "lp", "llp", "llc.", "and",
]);
const nameTokens = (value: string | null | undefined): string[] =>
  String(value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((t) => t && !ENTITY_SUFFIX_TOKENS.has(t));
const domainOf = (value: string | null | undefined): string => {
  let host = String(value ?? "").trim().toLowerCase();
  try { host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname; } catch { /* keep raw */ }
  return host.replace(/^www\./, "");
};

/**
 * Pure: do two organization names describe the same business? Token sets must be equal, or one must be a subset of
 * the other with at least two shared distinctive tokens ("Seaside Restaurant" within "Seaside Restaurant Group").
 * A single shared token never matches, so "Miami Herald" cannot be mistaken for "Miami Roofing".
 */
export function organizationNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = new Set(nameTokens(a));
  const right = new Set(nameTokens(b));
  if (left.size === 0 || right.size === 0) return false;
  const shared = [...left].filter((t) => right.has(t)).length;
  if (shared === left.size && shared === right.size) return true;
  return shared >= 2 && (shared === left.size || shared === right.size);
}

export interface BusinessIdentity { names: string[]; domain: string }

/**
 * Pure: ownership of a page-declared organization. Accepted only when the entity's own url is the business's
 * domain, or its name matches the business name (or the business's domain label, e.g. "Kauai Coffee Company"
 * on kauaicoffee.com). Entities that merely appear on the page (publisher, partner, venue) fail both tests.
 */
export function websiteEntityMatchesBusiness(
  entity: Pick<WebsiteJsonLdOrganization, "name" | "url">, business: BusinessIdentity,
): "domain" | "name" | null {
  if (entity.url && business.domain) {
    const host = domainOf(entity.url);
    if (host === business.domain || host.endsWith(`.${business.domain}`)) return "domain";
  }
  if (entity.name) {
    if (business.names.some((n) => organizationNamesMatch(entity.name, n))) return "name";
    const label = business.domain.split(".")[0] ?? "";
    const squashed = nameTokens(entity.name).join("");
    if (label.length >= 5 && squashed === label.replace(/[^a-z0-9]/g, "")) return "name";
  }
  return null;
}

/** Addresses the business's own page declares for the business (or a branch nested under it); other entities are ignored. */
export function websiteAddresses(
  organizations: WebsiteJsonLdOrganization[], business: BusinessIdentity, pageUrl: string,
): RecoveredAddress[] {
  const out: RecoveredAddress[] = [];
  for (const entity of organizations) {
    const matchedBy = websiteEntityMatchesBusiness(entity, business);
    if (!matchedBy) continue;
    for (const a of entity.addresses) {
      const zip = a.postalCode ? ZIP_TOKEN.exec(a.postalCode.trim())?.[1] ?? null : null;
      const state = a.state ? stateCodeOf(a.state) : null;
      const city = a.city && !/\d/.test(a.city) && a.city.length <= 60 ? a.city : null;
      // A bare ZIP or a city with a stated state is a stated fact; a city alone is not enough to place a business.
      if (!zip && !(city && state)) continue;
      out.push({
        source: "website_jsonld", streetAddress: a.streetAddress, city, state, postalCode: zip,
        reference: { kind: "website_jsonld", pageUrl, entityName: entity.name, entityUrl: entity.url,
          branchName: entity.branchName, matchedBy },
      });
    }
  }
  return out;
}

async function loadBusinessIdentity(businessId: number): Promise<BusinessIdentity & { streetAddress: string | null }> {
  const row = rows(await db.execute(sql`
    SELECT canonical_name,normalized_name,website_domain,street_address FROM businesses WHERE id=${businessId}
  `))[0];
  const names = [row?.canonical_name, row?.normalized_name].filter((n): n is string => typeof n === "string" && n.trim() !== "");
  return { names, domain: domainOf(row?.website_domain), streetAddress: row?.street_address ?? null };
}

/** Candidate addresses from facts already retained in the database for one business. */
export async function collectRetainedAddresses(businessId: number, identity?: BusinessIdentity & { streetAddress: string | null }): Promise<RecoveredAddress[]> {
  const out: RecoveredAddress[] = [];
  const who = identity ?? await loadBusinessIdentity(businessId);
  // The business's own provider address field describes the business itself.
  const own = parseStructuredAddress(who.streetAddress, "business_address");
  if (own) out.push({ ...own, reference: { kind: "business_address", businessId } });
  const contacts = rows(await db.execute(sql`
    SELECT id,company_name,city,state,address,primary_source_event_id,import_batch_id
      FROM contacts WHERE business_id=${businessId}
     ORDER BY id LIMIT 20
  `));
  for (const contact of contacts) {
    // business_id alone does not make a contact's address a business location: a contact can be linked to a
    // business while carrying another company's (or a person's) address. Require the contact's own company name
    // to be this business before its address counts, and keep the contact/source row as the supporting reference.
    if (!contact.company_name || !who.names.some((n) => organizationNamesMatch(contact.company_name, n))) continue;
    const reference = {
      kind: "contact_address", contactId: Number(contact.id), companyName: String(contact.company_name),
      primarySourceEventId: contact.primary_source_event_id ?? null, importBatchId: contact.import_batch_id ?? null,
      matchedBy: "company_name",
    };
    const parsed = parseStructuredAddress(contact.address, "contact_address");
    if (parsed) { out.push({ ...parsed, reference }); continue; }
    const state = contact.state ? stateCodeOf(String(contact.state)) : null;
    const city = contact.city ? String(contact.city).trim() : "";
    if (state && city && !/\d/.test(city)) {
      out.push({ source: "contact_fields", streetAddress: null, city, state, postalCode: null,
        reference: { ...reference, kind: "contact_fields" } });
    }
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    const key = JSON.stringify([a.city?.toLowerCase(), a.state, a.postalCode]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const asCandidate = (a: RecoveredAddress): LocationCandidateInput => ({
  locationId: null, isPrimary: false, city: a.city, state: a.state, postalCode: a.postalCode, countyFips: null,
});

export type RecoveryOutcome =
  | { status: "already_resolved" }
  | { status: "recovered"; sources: RecoveredAddressSource[]; locationIds: number[]; outcome: string; references: Record<string, unknown>[] }
  | { status: "unresolved"; websiteError: string | null; examined: number };

export interface GeographyRecoveryDeps {
  extractWebsiteEvidence?: (url: string, opts?: { timeoutMs?: number }) => Promise<WebsiteClassificationEvidence | { error: string }>;
  /** False in certification of the retained-only path; the production sweep reads the business's own site. */
  allowWebsiteRead?: boolean;
}

/**
 * Recover geography for one business. Writes at most one location per distinct, definite address; returns
 * what happened. Concurrency: the business row is locked so two workers cannot insert the same location.
 */
export async function recoverBusinessGeography(
  businessId: number, deps: GeographyRecoveryDeps = {},
): Promise<RecoveryOutcome> {
  const current = await resolveGeographyForBusiness(businessId, db);
  if (current.outcome === "resolved") return { status: "already_resolved" };

  const identity = await loadBusinessIdentity(businessId);
  const addresses = await collectRetainedAddresses(businessId, identity);
  let websiteError: string | null = null;
  const definite = (a: RecoveredAddress) => {
    const outcome = resolveGeographyFromCandidates([asCandidate(a)]).outcome;
    return outcome === "resolved" || outcome === "outside_territory";
  };
  if (!addresses.some((a) => definite(a)) && deps.allowWebsiteRead !== false) {
    const domain = identity.domain;
    if (domain && /^[a-z0-9.-]+$/.test(domain)) {
      const extract = deps.extractWebsiteEvidence ?? extractWebsiteClassificationEvidence;
      for (const path of ["", "/contact"]) {
        try {
          const result = await extract(`https://${domain}${path}`, { timeoutMs: 6000 });
          if ("error" in result) { websiteError = String(result.error); continue; }
          websiteError = null;
          addresses.push(...websiteAddresses(result.jsonLdOrganizations ?? [], identity, result.finalUrl ?? result.sourceUrl));
          if (addresses.some((a) => definite(a))) break;
        } catch {
          websiteError = "fetch_failed";
        }
      }
    }
  }

  const usable = addresses.filter((a) => definite(a));
  if (usable.length === 0) return { status: "unresolved", websiteError, examined: addresses.length };

  const locationIds: number[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM businesses WHERE id=${businessId} FOR UPDATE`);
    for (const a of usable) {
      const existing = rows(await tx.execute(sql`
        SELECT id FROM business_locations WHERE business_id=${businessId}
           AND city IS NOT DISTINCT FROM ${a.city} AND state IS NOT DISTINCT FROM ${a.state}
           AND postal_code IS NOT DISTINCT FROM ${a.postalCode} LIMIT 1
      `))[0];
      if (existing) continue;
      const inserted = rows(await tx.execute(sql`
        INSERT INTO business_locations (business_id,street_address,city,state,postal_code,is_primary)
        VALUES (${businessId},${a.streetAddress},${a.city},${a.state},${a.postalCode},
          NOT EXISTS(SELECT 1 FROM business_locations WHERE business_id=${businessId}))
        RETURNING id
      `))[0];
      locationIds.push(Number(inserted.id));
      // Durable supporting source reference: which retained fact/page entity placed this business here.
      await tx.execute(sql`
        INSERT INTO audit_logs(user_id,action,entity_type,entity_id,entity_key,details,actor_type,actor_id)
        VALUES ('system:sfp-geography-recovery','sfp.geography_recovery.location_recorded','business_location',
          ${Number(inserted.id)},${String(businessId)},
          ${JSON.stringify({ businessId, locationId: Number(inserted.id), version: GEOGRAPHY_RECOVERY_VERSION,
            source: a.source, reference: a.reference ?? null, city: a.city, state: a.state, postalCode: a.postalCode })}::jsonb,
          'system','sfp-geography-recovery')
      `);
    }
  });
  const after = await resolveGeographyForBusiness(businessId, db);
  return {
    status: "recovered", sources: [...new Set(usable.map((a) => a.source))], locationIds, outcome: after.outcome,
    references: usable.map((a) => a.reference ?? { kind: a.source }),
  };
}

/**
 * Bounded, restartable pass over parked geography items for the active policy. Attempts are versioned on the
 * item itself so an unchanged business is not retried until GEOGRAPHY_RECOVERY_RETRY_DAYS pass or the version
 * changes. The location rows it writes make the existing follow-up pass (which watches business_locations
 * timestamps) re-run classification for exactly those businesses.
 */
export async function processGeographyRecovery(
  program: { id: string; policy_version: number | string },
  limit: number,
  deps: GeographyRecoveryDeps = {},
): Promise<{ examined: number; recovered: number; unresolved: number }> {
  // The retry window is a BUSINESS-level checkpoint: pick each business's newest item first, and take the newest
  // recovery stamp across all of its items, so an older unmarked historical hold can never re-select a business
  // that was just attempted. Never-attempted businesses go first, then the longest-unattempted.
  const pending = rows(await db.execute(sql`
    WITH scoped AS (
      SELECT i.id,i.business_id,i.state,i.created_at,
             CASE WHEN left(i.outcome_code,1)='{' THEN i.outcome_code::jsonb ELSE '{}'::jsonb END AS j
        FROM sfp_classification_items i
        JOIN sfp_classification_runs r ON r.id=i.run_id
       WHERE r.program_id=${String(program.id)}::uuid
         AND r.policy_version=${Number(program.policy_version)}
    ),
    latest AS (
      SELECT DISTINCT ON (business_id) id,business_id,state,j
        FROM scoped ORDER BY business_id,created_at DESC,id DESC
    ),
    checkpoint AS (
      SELECT business_id,max((j->>'geographyRecoveryAt')::timestamptz) AS attempted_at
        FROM scoped WHERE j->>'geographyRecoveryVersion'=${GEOGRAPHY_RECOVERY_VERSION}
       GROUP BY business_id
    )
    SELECT l.id AS item_id,l.business_id
      FROM latest l
      JOIN businesses b ON b.id=l.business_id
      LEFT JOIN checkpoint c ON c.business_id=l.business_id
     WHERE l.state='skipped'
       AND l.j @> '{"route":"geography_review"}'::jsonb
       AND b.record_class='canonical'
       AND (c.attempted_at IS NULL OR c.attempted_at < NOW() - (${GEOGRAPHY_RECOVERY_RETRY_DAYS} * INTERVAL '1 day'))
     -- Never-attempted businesses first; within a tier, businesses that have a verified linked contact (the ones
     -- recovery can turn into recipients) before the rest, and Florida/unstated-state before businesses whose own
     -- record already names another state (those can only resolve to out-of-territory).
     ORDER BY (c.attempted_at IS NULL) DESC,
       EXISTS(SELECT 1 FROM contacts k WHERE k.business_id=l.business_id AND k.record_class='production') DESC,
       (upper(btrim(COALESCE(b.state,''))) IN ('','FL','FLORIDA')) DESC,
       c.attempted_at NULLS FIRST,l.business_id
     LIMIT ${limit}
  `));
  let recovered = 0;
  let unresolved = 0;
  let next = 0;
  // Each business waits on up to two bounded network reads of its own site, so a small worker pool keeps a larger
  // page inside the tick without raising any timeout. Each business is independent and row-locked on write.
  const worker = async () => {
    for (;;) {
      const row = pending[next++];
      if (!row) return;
      const businessId = Number(row.business_id);
      let result: RecoveryOutcome;
      try {
        result = await recoverBusinessGeography(businessId, deps);
      } catch (error: any) {
        // A single business failing must not stop the pass; it is retried on the next version/interval and logged.
        console.error(`[SfpGeographyRecovery] business ${businessId} failed: ${String(error?.message ?? error)}`);
        continue;
      }
      if (result.status === "recovered") recovered++; else unresolved++;
      const note = JSON.stringify({
        geographyRecoveryVersion: GEOGRAPHY_RECOVERY_VERSION,
        geographyRecoveryAt: new Date().toISOString(),
        geographyRecovery: result.status === "recovered"
          ? { status: "recovered", sources: result.sources, outcome: result.outcome, references: result.references }
          : result.status === "unresolved"
            ? { status: "unresolved", websiteError: result.websiteError, examined: result.examined }
            : { status: result.status },
      });
      await db.execute(sql`
        UPDATE sfp_classification_items
           SET outcome_code=(CASE WHEN left(outcome_code,1)='{' THEN outcome_code::jsonb ELSE '{}'::jsonb END || ${note}::jsonb)::text
         WHERE id=${String(row.item_id)}::uuid AND state='skipped'
      `);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GEOGRAPHY_RECOVERY_CONCURRENCY, pending.length) }, worker));
  return { examined: pending.length, recovered, unresolved };
}
