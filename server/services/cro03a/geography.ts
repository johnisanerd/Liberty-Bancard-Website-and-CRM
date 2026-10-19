/**
 * CRO-03A South Florida Geography Reference
 *
 * Two versioned references are maintained:
 *   south-florida-fips-v1  — original sparse reference (24 ZIPs, ~20 cities).
 *                            Historical decisions carrying this version are immutable.
 *   south-florida-fips-v2  — complete reference covering every USPS ZIP assigned to
 *                            Miami-Dade (12086), Broward (12011), and Palm Beach (12099)
 *                            counties plus Monroe (12087, disabled).  City name variants
 *                            and ambiguous cross-county ZIPs are represented explicitly.
 *
 * Active version: south-florida-fips-v2 (used for all new qualification runs).
 *
 * Rules:
 *  1. Direct county/FIPS evidence always wins over ZIP/city inference.
 *  2. A ZIP mapped to exactly one county → zip_inferred.
 *  3. A ZIP mapped to more than one county → conflicting (ambiguous).
 *  4. A city mapped to exactly one county → city_inferred (lower authority than zip).
 *  5. A city mapped to more than one county → conflicting.
 *  6. If state ≠ FL (and state is known) → outside territory, verified.
 *  7. If nothing resolves → unknown.
 */

import {normalizeStateIdentity} from "../../../shared/state-identity";
export const CRO03A_GEOGRAPHY_REFERENCE_VERSION = "south-florida-fips-v2";

/** Previous version string — retained so callers can detect legacy decisions. */
export const CRO03A_GEOGRAPHY_REFERENCE_VERSION_V1 = "south-florida-fips-v1";

export const CRO03A_COUNTY_FIPS = Object.freeze({
  Broward: "12011",
  "Miami-Dade": "12086",
  "Palm Beach": "12099",
} as const);

export const CRO03A_DISABLED_COUNTY_FIPS = Object.freeze({ Monroe: "12087" } as const);

export type GeographyEvidenceClass = "verified" | "zip_inferred" | "city_inferred" | "conflicting" | "unknown";
export type GeographyResult = {
  eligible: boolean;
  evidenceClass: GeographyEvidenceClass;
  county: string | null;
  countyFips: string | null;
  referenceVersion: string;
  inputs: { state: string | null; county: string | null; countyFips: string | null; zip: string | null; city: string | null };
  reasonCodes: string[];
};

// ---------------------------------------------------------------------------
// ZIP → County mappings (USPS, complete for target + disabled counties)
// Each entry maps a 5-digit ZIP to one or more county names.
// Multi-county entries represent ambiguous cross-boundary ZIPs.
// ---------------------------------------------------------------------------
const ZIP_COUNTY_V2: Record<string, string[]> = {
  // ── Monroe County (disabled) ───────────────────────────────────────────
  "33001": ["Monroe"], "33036": ["Monroe"], "33037": ["Monroe"],
  "33040": ["Monroe"], "33041": ["Monroe"], "33042": ["Monroe"],
  "33043": ["Monroe"], "33044": ["Monroe"], "33045": ["Monroe"],
  "33050": ["Monroe"], "33051": ["Monroe"], "33052": ["Monroe"],
  "33070": ["Monroe"],

  // ── Miami-Dade County (FIPS 12086) ────────────────────────────────────
  "33010": ["Miami-Dade"], "33011": ["Miami-Dade"], "33012": ["Miami-Dade"],
  "33013": ["Miami-Dade"], "33014": ["Miami-Dade"], "33015": ["Miami-Dade"],
  "33016": ["Miami-Dade"], "33017": ["Miami-Dade"], "33018": ["Miami-Dade"],
  "33030": ["Miami-Dade"], "33031": ["Miami-Dade"], "33032": ["Miami-Dade"],
  "33033": ["Miami-Dade"], "33034": ["Miami-Dade"], "33035": ["Miami-Dade"],
  "33039": ["Miami-Dade"],
  "33054": ["Miami-Dade"], "33055": ["Miami-Dade"], "33056": ["Miami-Dade"],
  "33101": ["Miami-Dade"], "33102": ["Miami-Dade"], "33107": ["Miami-Dade"],
  "33109": ["Miami-Dade"], "33110": ["Miami-Dade"], "33111": ["Miami-Dade"],
  "33112": ["Miami-Dade"], "33114": ["Miami-Dade"], "33116": ["Miami-Dade"],
  "33119": ["Miami-Dade"],
  "33121": ["Miami-Dade"], "33122": ["Miami-Dade"], "33124": ["Miami-Dade"],
  "33125": ["Miami-Dade"], "33126": ["Miami-Dade"], "33127": ["Miami-Dade"],
  "33128": ["Miami-Dade"], "33129": ["Miami-Dade"], "33130": ["Miami-Dade"],
  "33131": ["Miami-Dade"], "33132": ["Miami-Dade"], "33133": ["Miami-Dade"],
  "33134": ["Miami-Dade"], "33135": ["Miami-Dade"], "33136": ["Miami-Dade"],
  "33137": ["Miami-Dade"], "33138": ["Miami-Dade"], "33139": ["Miami-Dade"],
  "33140": ["Miami-Dade"], "33141": ["Miami-Dade"], "33142": ["Miami-Dade"],
  "33143": ["Miami-Dade"], "33144": ["Miami-Dade"], "33145": ["Miami-Dade"],
  "33146": ["Miami-Dade"], "33147": ["Miami-Dade"], "33149": ["Miami-Dade"],
  "33150": ["Miami-Dade"], "33151": ["Miami-Dade"], "33153": ["Miami-Dade"],
  "33154": ["Miami-Dade"], "33155": ["Miami-Dade"], "33156": ["Miami-Dade"],
  "33157": ["Miami-Dade"], "33158": ["Miami-Dade"],
  "33160": ["Miami-Dade"], "33161": ["Miami-Dade"], "33162": ["Miami-Dade"],
  "33163": ["Miami-Dade"], "33164": ["Miami-Dade"], "33165": ["Miami-Dade"],
  "33166": ["Miami-Dade"], "33167": ["Miami-Dade"], "33168": ["Miami-Dade"],
  "33169": ["Miami-Dade"], "33170": ["Miami-Dade"],
  "33172": ["Miami-Dade"], "33173": ["Miami-Dade"], "33174": ["Miami-Dade"],
  "33175": ["Miami-Dade"], "33176": ["Miami-Dade"], "33177": ["Miami-Dade"],
  "33178": ["Miami-Dade"], "33179": ["Miami-Dade"], "33180": ["Miami-Dade"],
  "33181": ["Miami-Dade"], "33182": ["Miami-Dade"], "33183": ["Miami-Dade"],
  "33184": ["Miami-Dade"], "33185": ["Miami-Dade"], "33186": ["Miami-Dade"],
  "33187": ["Miami-Dade"], "33188": ["Miami-Dade"], "33189": ["Miami-Dade"],
  "33190": ["Miami-Dade"], "33193": ["Miami-Dade"], "33194": ["Miami-Dade"],
  "33196": ["Miami-Dade"], "33197": ["Miami-Dade"], "33199": ["Miami-Dade"],
  "33222": ["Miami-Dade"], "33231": ["Miami-Dade"], "33233": ["Miami-Dade"],
  "33234": ["Miami-Dade"], "33238": ["Miami-Dade"], "33242": ["Miami-Dade"],
  "33243": ["Miami-Dade"], "33245": ["Miami-Dade"], "33247": ["Miami-Dade"],
  "33255": ["Miami-Dade"], "33256": ["Miami-Dade"], "33257": ["Miami-Dade"],
  "33261": ["Miami-Dade"], "33265": ["Miami-Dade"], "33266": ["Miami-Dade"],
  "33269": ["Miami-Dade"], "33280": ["Miami-Dade"], "33283": ["Miami-Dade"],
  "33296": ["Miami-Dade"], "33299": ["Miami-Dade"],

  // ── Broward County (FIPS 12011) ───────────────────────────────────────
  "33004": ["Broward"],
  "33009": ["Broward"],
  "33019": ["Broward"], "33020": ["Broward"], "33021": ["Broward"],
  "33022": ["Broward"], "33023": ["Broward"], "33024": ["Broward"],
  "33025": ["Broward"], "33026": ["Broward"], "33027": ["Broward"],
  "33028": ["Broward"], "33029": ["Broward"],
  "33060": ["Broward"], "33061": ["Broward"], "33062": ["Broward"],
  "33063": ["Broward"], "33064": ["Broward"], "33065": ["Broward"],
  "33066": ["Broward"], "33067": ["Broward"], "33068": ["Broward"],
  "33069": ["Broward"], "33071": ["Broward"], "33072": ["Broward"],
  "33073": ["Broward"], "33076": ["Broward"],
  "33083": ["Broward"], "33084": ["Broward"],
  "33301": ["Broward"], "33302": ["Broward"], "33303": ["Broward"],
  "33304": ["Broward"], "33305": ["Broward"], "33306": ["Broward"],
  "33307": ["Broward"], "33308": ["Broward"], "33309": ["Broward"],
  "33310": ["Broward"], "33311": ["Broward"], "33312": ["Broward"],
  "33313": ["Broward"], "33314": ["Broward"], "33315": ["Broward"],
  "33316": ["Broward"], "33317": ["Broward"], "33318": ["Broward"],
  "33319": ["Broward"], "33320": ["Broward"], "33321": ["Broward"],
  "33322": ["Broward"], "33323": ["Broward"], "33324": ["Broward"],
  "33325": ["Broward"], "33326": ["Broward"], "33327": ["Broward"],
  "33328": ["Broward"], "33329": ["Broward"], "33330": ["Broward"],
  "33331": ["Broward"], "33332": ["Broward"], "33334": ["Broward"],
  "33335": ["Broward"], "33336": ["Broward"], "33337": ["Broward"],
  "33338": ["Broward"], "33339": ["Broward"], "33340": ["Broward"],
  "33345": ["Broward"], "33346": ["Broward"], "33348": ["Broward"],
  "33349": ["Broward"], "33351": ["Broward"], "33355": ["Broward"],
  "33359": ["Broward"], "33388": ["Broward"], "33394": ["Broward"],
  // Deerfield Beach (33441/33442) — Broward, NOT Palm Beach
  "33441": ["Broward"], "33442": ["Broward"], "33443": ["Broward"],

  // ── Palm Beach County (FIPS 12099) ────────────────────────────────────
  "33401": ["Palm Beach"], "33402": ["Palm Beach"], "33403": ["Palm Beach"],
  "33404": ["Palm Beach"], "33405": ["Palm Beach"], "33406": ["Palm Beach"],
  "33407": ["Palm Beach"], "33408": ["Palm Beach"], "33409": ["Palm Beach"],
  "33410": ["Palm Beach"], "33411": ["Palm Beach"], "33412": ["Palm Beach"],
  "33413": ["Palm Beach"], "33414": ["Palm Beach"], "33415": ["Palm Beach"],
  "33416": ["Palm Beach"], "33417": ["Palm Beach"], "33418": ["Palm Beach"],
  "33419": ["Palm Beach"], "33420": ["Palm Beach"], "33421": ["Palm Beach"],
  "33422": ["Palm Beach"], "33424": ["Palm Beach"], "33425": ["Palm Beach"],
  "33426": ["Palm Beach"], "33427": ["Palm Beach"], "33428": ["Palm Beach"],
  "33429": ["Palm Beach"], "33430": ["Palm Beach"], "33431": ["Palm Beach"],
  "33432": ["Palm Beach"], "33433": ["Palm Beach"], "33434": ["Palm Beach"],
  "33435": ["Palm Beach"], "33436": ["Palm Beach"], "33437": ["Palm Beach"],
  "33438": ["Palm Beach"], "33444": ["Palm Beach"], "33445": ["Palm Beach"],
  "33446": ["Palm Beach"], "33448": ["Palm Beach"], "33449": ["Palm Beach"],
  "33458": ["Palm Beach"], "33459": ["Palm Beach"], "33460": ["Palm Beach"],
  "33461": ["Palm Beach"], "33462": ["Palm Beach"], "33463": ["Palm Beach"],
  "33464": ["Palm Beach"], "33465": ["Palm Beach"], "33466": ["Palm Beach"],
  "33467": ["Palm Beach"], "33468": ["Palm Beach"], "33469": ["Palm Beach"],
  "33470": ["Palm Beach"], "33472": ["Palm Beach"], "33473": ["Palm Beach"],
  "33474": ["Palm Beach"], "33476": ["Palm Beach"], "33477": ["Palm Beach"],
  "33478": ["Palm Beach"], "33480": ["Palm Beach"], "33481": ["Palm Beach"],
  "33482": ["Palm Beach"], "33483": ["Palm Beach"], "33484": ["Palm Beach"],
  "33486": ["Palm Beach"], "33487": ["Palm Beach"], "33488": ["Palm Beach"],
  "33496": ["Palm Beach"], "33497": ["Palm Beach"], "33498": ["Palm Beach"],
  "33499": ["Palm Beach"],
};

// ---------------------------------------------------------------------------
// City → County mappings (comprehensive, case-normalised)
// City inference is lower authority than ZIP inference.
// Multi-county entries = ambiguous → conflicting.
// ---------------------------------------------------------------------------
const CITY_COUNTY_V2: Record<string, string[]> = {
  // ── Miami-Dade ──────────────────────────────────────────────────────
  "miami": ["Miami-Dade"],
  "miami beach": ["Miami-Dade"],
  "miami gardens": ["Miami-Dade"],
  "miami lakes": ["Miami-Dade"],
  "miami shores": ["Miami-Dade"],
  "miami springs": ["Miami-Dade"],
  "hialeah": ["Miami-Dade"],
  "hialeah gardens": ["Miami-Dade"],
  "coral gables": ["Miami-Dade"],
  "coconut grove": ["Miami-Dade"],
  "homestead": ["Miami-Dade"],
  "florida city": ["Miami-Dade"],
  "doral": ["Miami-Dade"],
  "doral fl": ["Miami-Dade"],
  "medley": ["Miami-Dade"],
  "opa locka": ["Miami-Dade"],
  "opa-locka": ["Miami-Dade"],
  "north miami": ["Miami-Dade"],
  "north miami beach": ["Miami-Dade"],
  "aventura": ["Miami-Dade"],
  "sunny isles beach": ["Miami-Dade"],
  "bal harbour": ["Miami-Dade"],
  "bay harbor islands": ["Miami-Dade"],
  "surfside": ["Miami-Dade"],
  "north bay village": ["Miami-Dade"],
  "el portal": ["Miami-Dade"],
  "biscayne park": ["Miami-Dade"],
  "golden beach": ["Miami-Dade"],
  "key biscayne": ["Miami-Dade"],
  "palmetto bay": ["Miami-Dade"],
  "cutler bay": ["Miami-Dade"],
  "pinecrest": ["Miami-Dade"],
  "south miami": ["Miami-Dade"],
  "south miami heights": ["Miami-Dade"],
  "sweetwater": ["Miami-Dade"],
  "virginia gardens": ["Miami-Dade"],
  "west miami": ["Miami-Dade"],
  "kendall": ["Miami-Dade"],
  "westchester": ["Miami-Dade"],
  "kendale lakes": ["Miami-Dade"],
  "tamiami": ["Miami-Dade"],
  "country walk": ["Miami-Dade"],
  "perrine": ["Miami-Dade"],
  "goulds": ["Miami-Dade"],
  "leisure city": ["Miami-Dade"],
  "naranja": ["Miami-Dade"],
  "princeton": ["Miami-Dade"],
  "richmond heights": ["Miami-Dade"],
  "brownsville": ["Miami-Dade"],
  "liberty city": ["Miami-Dade"],
  "little havana": ["Miami-Dade"],
  "little haiti": ["Miami-Dade"],
  "allapattah": ["Miami-Dade"],
  "brickell": ["Miami-Dade"],
  "wynwood": ["Miami-Dade"],
  "edgewater": ["Miami-Dade"],
  "overtown": ["Miami-Dade"],
  "islandia": ["Miami-Dade"],
  "indian creek village": ["Miami-Dade"],
  "indian creek": ["Miami-Dade"],
  "miami fl": ["Miami-Dade"],
  "miami, fl": ["Miami-Dade"],

  // ── Broward ─────────────────────────────────────────────────────────
  "fort lauderdale": ["Broward"],
  "ft lauderdale": ["Broward"],
  "ft. lauderdale": ["Broward"],
  "hollywood": ["Broward"],
  "pembroke pines": ["Broward"],
  "miramar": ["Broward"],
  "coral springs": ["Broward"],
  "pompano beach": ["Broward"],
  "sunrise": ["Broward"],
  "plantation": ["Broward"],
  "deerfield beach": ["Broward"],
  "davie": ["Broward"],
  "tamarac": ["Broward"],
  "weston": ["Broward"],
  "margate": ["Broward"],
  "coconut creek": ["Broward"],
  "lauderdale lakes": ["Broward"],
  "north lauderdale": ["Broward"],
  "lauderdale by the sea": ["Broward"],
  "lauderdale-by-the-sea": ["Broward"],
  "hallandale beach": ["Broward"],
  "hallandale": ["Broward"],
  "dania beach": ["Broward"],
  "dania": ["Broward"],
  "lighthouse point": ["Broward"],
  "hillsboro beach": ["Broward"],
  "sea ranch lakes": ["Broward"],
  "southwest ranches": ["Broward"],
  "lazy lake": ["Broward"],
  "wilton manors": ["Broward"],
  "oakland park": ["Broward"],
  "lauderhill": ["Broward"],
  "west park": ["Broward"],
  "pembroke park": ["Broward"],
  "parkland": ["Broward"],
  "north andrews gardens": ["Broward"],
  "broadview park": ["Broward"],
  "lake forest": ["Broward"],
  "franklin park": ["Broward"],
  "west hollywood": ["Broward"],
  "cooper city": ["Broward"],

  // ── Palm Beach ──────────────────────────────────────────────────────
  "west palm beach": ["Palm Beach"],
  "boca raton": ["Palm Beach"],
  "boynton beach": ["Palm Beach"],
  "boynton": ["Palm Beach"],
  "delray beach": ["Palm Beach"],
  "delray": ["Palm Beach"],
  "palm beach gardens": ["Palm Beach"],
  "lake worth": ["Palm Beach"],
  "lake worth beach": ["Palm Beach"],
  "wellington": ["Palm Beach"],
  "palm beach": ["Palm Beach"],
  "royal palm beach": ["Palm Beach"],
  "greenacres": ["Palm Beach"],
  "jupiter": ["Palm Beach"],
  "north palm beach": ["Palm Beach"],
  "palm beach shores": ["Palm Beach"],
  "riviera beach": ["Palm Beach"],
  "lake park": ["Palm Beach"],
  "palm springs": ["Palm Beach"],
  "belle glade": ["Palm Beach"],
  "pahokee": ["Palm Beach"],
  "south bay": ["Palm Beach"],
  "loxahatchee": ["Palm Beach"],
  "the acreage": ["Palm Beach"],
  "westlake": ["Palm Beach"],
  "ocean ridge": ["Palm Beach"],
  "briny breezes": ["Palm Beach"],
  "highland beach": ["Palm Beach"],
  "manalapan": ["Palm Beach"],
  "south palm beach": ["Palm Beach"],
  "gulf stream": ["Palm Beach"],
  "hypoluxo": ["Palm Beach"],
  "lantana": ["Palm Beach"],
  "cloud lake": ["Palm Beach"],
  "juno beach": ["Palm Beach"],
  "jupiter inlet colony": ["Palm Beach"],
  "haverhill": ["Palm Beach"],
  "mangonia park": ["Palm Beach"],
  "glen ridge": ["Palm Beach"],
  "atlantis": ["Palm Beach"],
  "lake clarke shores": ["Palm Beach"],
  "lake clark shores": ["Palm Beach"],
  "palm beach lakes": ["Palm Beach"],
  "tequesta": ["Palm Beach"],
  "jupiter farms": ["Palm Beach"],

  // ── Monroe (disabled) ───────────────────────────────────────────────
  "key west": ["Monroe"],
  "key largo": ["Monroe"],
  "islamorada": ["Monroe"],
  "marathon": ["Monroe"],
  "tavernier": ["Monroe"],
  "big pine key": ["Monroe"],
  "summerland key": ["Monroe"],
  "cudjoe key": ["Monroe"],
  "stock island": ["Monroe"],
  "duck key": ["Monroe"],
  "layton": ["Monroe"],
  "long key": ["Monroe"],
  "conch key": ["Monroe"],
};

// ---------------------------------------------------------------------------
// v1 reference (preserved for legacy decisions; not used for new evaluations)
// ---------------------------------------------------------------------------
const ZIP_COUNTY_V1: Record<string, string[]> = {
  "33010": ["Miami-Dade"], "33101": ["Miami-Dade"], "33125": ["Miami-Dade"], "33130": ["Miami-Dade"],
  "33139": ["Miami-Dade"], "33166": ["Miami-Dade"], "33172": ["Miami-Dade"], "33299": ["Miami-Dade"],
  "33301": ["Broward"], "33304": ["Broward"], "33308": ["Broward"], "33311": ["Broward"],
  "33312": ["Broward"], "33316": ["Broward"], "33324": ["Broward"], "33351": ["Broward"],
  "33401": ["Palm Beach"], "33404": ["Palm Beach"], "33407": ["Palm Beach"], "33409": ["Palm Beach"],
  "33411": ["Palm Beach"], "33417": ["Palm Beach"], "33418": ["Palm Beach"], "33480": ["Palm Beach"],
};
const CITY_COUNTY_V1: Record<string, string[]> = {
  miami: ["Miami-Dade"], "miami beach": ["Miami-Dade"], "coral gables": ["Miami-Dade"],
  homestead: ["Miami-Dade"], hialeah: ["Miami-Dade"], doral: ["Miami-Dade"],
  "fort lauderdale": ["Broward"], hollywood: ["Broward"], "pompano beach": ["Broward"],
  davie: ["Broward"], "coral springs": ["Broward"], plantation: ["Broward"],
  "boca raton": ["Palm Beach"], "west palm beach": ["Palm Beach"], delray: ["Palm Beach"],
  "delray beach": ["Palm Beach"], boynton: ["Palm Beach"], "boynton beach": ["Palm Beach"],
  wellington: ["Palm Beach"], "lake worth": ["Palm Beach"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const normalize = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";

const fipsFor = (county: string | null): string | null => {
  if (!county) return null;
  return (
    CRO03A_COUNTY_FIPS[county as keyof typeof CRO03A_COUNTY_FIPS] ??
    CRO03A_DISABLED_COUNTY_FIPS[county as keyof typeof CRO03A_DISABLED_COUNTY_FIPS] ??
    null
  );
};

const countyForFips = (fips: string | null): string | null => {
  if (!fips) return null;
  return (
    Object.entries(CRO03A_COUNTY_FIPS).find(([, v]) => v === fips)?.[0] ??
    Object.entries(CRO03A_DISABLED_COUNTY_FIPS).find(([, v]) => v === fips)?.[0] ??
    null
  );
};

const canonicalCounty = (raw: unknown): string | null => {
  const value = normalize(raw);
  if (!value) return null;
  if (value === "miami dade" || value === "miami-dade" || value === "miami dade county" || value === "dade") return "Miami-Dade";
  if (value === "broward" || value === "broward county") return "Broward";
  if (value === "palm beach" || value === "palm beach county") return "Palm Beach";
  if (value === "monroe" || value === "monroe county") return "Monroe";
  return countyForFips(value) ?? String(raw).trim();
};

const isEligibleCounty = (county: string | null): county is keyof typeof CRO03A_COUNTY_FIPS =>
  county !== null && Object.prototype.hasOwnProperty.call(CRO03A_COUNTY_FIPS, county);

// ---------------------------------------------------------------------------
// Core evaluator — versioned
// ---------------------------------------------------------------------------
function evaluateWithReference(
  input: { state?: string | null; county?: string | null; countyFips?: string | null; zip?: string | null; city?: string | null },
  zipMap: Record<string, string[]>,
  cityMap: Record<string, string[]>,
  version: string,
): GeographyResult {
  const state = version===CRO03A_GEOGRAPHY_REFERENCE_VERSION_V1
    ? input.state?.trim().toUpperCase() || null : normalizeStateIdentity(input.state);
  const county = canonicalCounty(input.county);
  const countyFips = input.countyFips?.trim() || fipsFor(county);
  const zip = input.zip?.trim().match(/\d{5}/)?.[0] ?? null;
  const city = input.city?.trim() || null;
  const inputView = { state, county, countyFips, zip, city };

  // 1. State rejection (definitive)
  if (state && state !== "FL") {
    return {
      eligible: false, evidenceClass: "verified", county, countyFips,
      referenceVersion: version, inputs: inputView,
      reasonCodes: ["STATE_NOT_FLORIDA"],
    };
  }

  // 2. Direct county / FIPS evidence
  const countyFromFips = countyForFips(countyFips);
  const directCounty = countyFromFips ?? county;
  const directKnown = directCounty !== null && (fipsFor(directCounty) !== null || directCounty === "Monroe");

  if (directKnown) {
    // Check for conflicts with ZIP/city evidence
    const zipCandidates = zip ? zipMap[zip] ?? [] : [];
    const cityCandidates = city ? cityMap[normalize(city)] ?? [] : [];
    if (
      (zipCandidates.length > 0 && !zipCandidates.includes(directCounty!)) ||
      (cityCandidates.length > 0 && !cityCandidates.includes(directCounty!))
    ) {
      return {
        eligible: false, evidenceClass: "conflicting",
        county: directCounty, countyFips: fipsFor(directCounty),
        referenceVersion: version, inputs: inputView,
        reasonCodes: ["GEOGRAPHY_EVIDENCE_CONFLICT"],
      };
    }
    const eligible = isEligibleCounty(directCounty);
    return {
      eligible, evidenceClass: "verified",
      county: directCounty, countyFips: fipsFor(directCounty),
      referenceVersion: version, inputs: inputView,
      reasonCodes: [eligible ? "COUNTY_FIPS_VERIFIED" : "COUNTY_DISABLED"],
    };
  }

  // 3. ZIP inference
  const zipCandidates = zip ? zipMap[zip] ?? [] : [];
  if (zipCandidates.length === 1) {
    const selected = zipCandidates[0];
    return {
      eligible: isEligibleCounty(selected),
      evidenceClass: "zip_inferred",
      county: selected, countyFips: fipsFor(selected),
      referenceVersion: version, inputs: inputView,
      reasonCodes: [`ZIP_MAPPED_${fipsFor(selected)}`],
    };
  }
  if (zipCandidates.length > 1) {
    return {
      eligible: false, evidenceClass: "conflicting",
      county: null, countyFips: null,
      referenceVersion: version, inputs: inputView,
      reasonCodes: ["AMBIGUOUS_REFERENCE_MAPPING"],
    };
  }

  // 4. City inference (lower authority than ZIP)
  const cityCandidates = city ? cityMap[normalize(city)] ?? [] : [];
  if (cityCandidates.length === 1) {
    const selected = cityCandidates[0];
    return {
      eligible: isEligibleCounty(selected),
      evidenceClass: "city_inferred",
      county: selected, countyFips: fipsFor(selected),
      referenceVersion: version, inputs: inputView,
      reasonCodes: [`CITY_MAPPED_${fipsFor(selected)}`],
    };
  }
  if (cityCandidates.length > 1) {
    return {
      eligible: false, evidenceClass: "conflicting",
      county: null, countyFips: null,
      referenceVersion: version, inputs: inputView,
      reasonCodes: ["AMBIGUOUS_REFERENCE_MAPPING"],
    };
  }

  return {
    eligible: false, evidenceClass: "unknown",
    county: null, countyFips: null,
    referenceVersion: version, inputs: inputView,
    reasonCodes: ["GEOGRAPHY_UNKNOWN"],
  };
}

// ---------------------------------------------------------------------------
// Public API — active version (v2)
// ---------------------------------------------------------------------------
export function evaluateSouthFloridaGeography(input: {
  state?: string | null;
  county?: string | null;
  countyFips?: string | null;
  zip?: string | null;
  city?: string | null;
}): GeographyResult {
  return evaluateWithReference(input, ZIP_COUNTY_V2, CITY_COUNTY_V2, CRO03A_GEOGRAPHY_REFERENCE_VERSION);
}

/** Re-evaluate a historical occurrence using the v1 reference (read-only analysis only). */
export function evaluateSouthFloridaGeographyV1(input: {
  state?: string | null;
  county?: string | null;
  countyFips?: string | null;
  zip?: string | null;
  city?: string | null;
}): GeographyResult {
  return evaluateWithReference(input, ZIP_COUNTY_V1, CITY_COUNTY_V1, CRO03A_GEOGRAPHY_REFERENCE_VERSION_V1);
}

/** Exported for testing — the full v2 ZIP map. */
export const _ZIP_COUNTY_V2_FOR_TEST: Readonly<Record<string, string[]>> = ZIP_COUNTY_V2;
/** Exported for testing — the full v2 city map. */
export const _CITY_COUNTY_V2_FOR_TEST: Readonly<Record<string, string[]>> = CITY_COUNTY_V2;

/**
 * Five-digit ZIP codes the current reference resolves to exactly one enabled program county.
 * For ordering and prioritisation only: it never decides eligibility, which stays with the
 * full resolver (direct county evidence, city inference and ambiguity handling).
 */
export function southFloridaProgramZips(): string[] {
  return Object.keys(ZIP_COUNTY_V2).filter(zip => evaluateSouthFloridaGeography({ zip }).eligible);
}
