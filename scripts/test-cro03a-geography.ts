#!/usr/bin/env npx tsx
/**
 * test-cro03a-geography.ts
 *
 * Validates the south-florida-fips-v2 geography reference against a
 * representative test corpus:
 *
 *  - Representative ZIPs and municipalities across all three target counties
 *  - Alternate city-name spellings and case variants
 *  - County and FIPS evidence paths
 *  - Cross-county conflict detection
 *  - Monroe denial (county disabled)
 *  - Non-Florida state rejection
 *  - Ambiguous / unknown locations
 *  - v1 legacy evaluator still works (non-regression)
 */

import {
  evaluateSouthFloridaGeography,
  evaluateSouthFloridaGeographyV1,
  CRO03A_GEOGRAPHY_REFERENCE_VERSION,
  CRO03A_GEOGRAPHY_REFERENCE_VERSION_V1,
  _ZIP_COUNTY_V2_FOR_TEST,
  _CITY_COUNTY_V2_FOR_TEST,
} from "../server/services/cro03a/geography";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, condition: boolean, extra?: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

function check(label: string, input: Parameters<typeof evaluateSouthFloridaGeography>[0], expected: {
  eligible: boolean;
  evidenceClass: string;
  county?: string | null;
  countyFips?: string | null;
  reasonCode?: string;
  version?: string;
}) {
  const r = evaluateSouthFloridaGeography(input);
  assert(`${label}: eligible`, r.eligible === expected.eligible, `got ${r.eligible}`);
  assert(`${label}: evidenceClass`, r.evidenceClass === expected.evidenceClass, `got ${r.evidenceClass}`);
  if ("county" in expected) assert(`${label}: county`, r.county === expected.county, `got ${r.county}`);
  if ("countyFips" in expected) assert(`${label}: countyFips`, r.countyFips === expected.countyFips, `got ${r.countyFips}`);
  if (expected.reasonCode) assert(`${label}: reasonCode`, r.reasonCodes.includes(expected.reasonCode), `got ${JSON.stringify(r.reasonCodes)}`);
  const v = expected.version ?? CRO03A_GEOGRAPHY_REFERENCE_VERSION;
  assert(`${label}: version`, r.referenceVersion === v, `got ${r.referenceVersion}`);
}

// ── State rejection ──────────────────────────────────────────────────────────
check("state=GA rejected", { state: "GA", city: "Atlanta" }, {
  eligible: false, evidenceClass: "verified", reasonCode: "STATE_NOT_FLORIDA",
});
check("state=NY rejected", { state: "NY", zip: "10001" }, {
  eligible: false, evidenceClass: "verified", reasonCode: "STATE_NOT_FLORIDA",
});
check("state=null with FL city not rejected as non-FL", { state: null, city: "Miami" }, {
  eligible: true, evidenceClass: "city_inferred", county: "Miami-Dade",
});

// ── Direct county evidence ───────────────────────────────────────────────────
check("county=Broward verified", { state: "FL", county: "Broward" }, {
  eligible: true, evidenceClass: "verified", county: "Broward", countyFips: "12011",
  reasonCode: "COUNTY_FIPS_VERIFIED",
});
check("county=Miami-Dade verified", { state: "FL", county: "Miami-Dade" }, {
  eligible: true, evidenceClass: "verified", county: "Miami-Dade", countyFips: "12086",
});
check("county=Palm Beach verified", { state: "FL", county: "Palm Beach" }, {
  eligible: true, evidenceClass: "verified", county: "Palm Beach", countyFips: "12099",
});
check("county=Monroe disabled", { state: "FL", county: "Monroe" }, {
  eligible: false, evidenceClass: "verified", county: "Monroe", countyFips: "12087",
  reasonCode: "COUNTY_DISABLED",
});
check("county variant: miami dade", { county: "miami dade" }, {
  eligible: true, evidenceClass: "verified", county: "Miami-Dade",
});
check("countyFips=12011 (Broward)", { countyFips: "12011" }, {
  eligible: true, evidenceClass: "verified", county: "Broward",
});
check("countyFips=12086 (Miami-Dade)", { countyFips: "12086" }, {
  eligible: true, evidenceClass: "verified", county: "Miami-Dade",
});
check("countyFips=12099 (Palm Beach)", { countyFips: "12099" }, {
  eligible: true, evidenceClass: "verified", county: "Palm Beach",
});
check("countyFips=12087 (Monroe disabled)", { countyFips: "12087" }, {
  eligible: false, evidenceClass: "verified", county: "Monroe",
});

// ── ZIP inference — Miami-Dade ───────────────────────────────────────────────
for (const zip of ["33131", "33134", "33155", "33180", "33186", "33165", "33157", "33012"]) {
  check(`zip=${zip} → Miami-Dade eligible`, { state: "FL", zip }, {
    eligible: true, evidenceClass: "zip_inferred", county: "Miami-Dade", countyFips: "12086",
  });
}

// ── ZIP inference — Broward ──────────────────────────────────────────────────
for (const zip of ["33020", "33021", "33023", "33024", "33065", "33309", "33319", "33326"]) {
  check(`zip=${zip} → Broward eligible`, { state: "FL", zip }, {
    eligible: true, evidenceClass: "zip_inferred", county: "Broward", countyFips: "12011",
  });
}
// Deerfield Beach ZIPs are Broward, not Palm Beach
check("zip=33441 (Deerfield Beach) → Broward", { state: "FL", zip: "33441" }, {
  eligible: true, evidenceClass: "zip_inferred", county: "Broward",
});
check("zip=33442 (Deerfield Beach) → Broward", { state: "FL", zip: "33442" }, {
  eligible: true, evidenceClass: "zip_inferred", county: "Broward",
});

// ── ZIP inference — Palm Beach ───────────────────────────────────────────────
for (const zip of ["33431", "33432", "33433", "33458", "33460", "33480", "33487", "33401"]) {
  check(`zip=${zip} → Palm Beach eligible`, { state: "FL", zip }, {
    eligible: true, evidenceClass: "zip_inferred", county: "Palm Beach", countyFips: "12099",
  });
}

// ── ZIP inference — Monroe (disabled) ────────────────────────────────────────
check("zip=33040 (Key West) → Monroe disabled", { state: "FL", zip: "33040" }, {
  eligible: false, evidenceClass: "zip_inferred", county: "Monroe",
});
check("zip=33070 (Tavernier) → Monroe disabled", { state: "FL", zip: "33070" }, {
  eligible: false, evidenceClass: "zip_inferred", county: "Monroe",
});

// ── City inference — Miami-Dade ──────────────────────────────────────────────
for (const city of ["Miami", "Miami Beach", "Hialeah", "Coral Gables", "Homestead", "Doral", "Aventura", "North Miami", "Brickell"]) {
  check(`city="${city}" → Miami-Dade`, { state: "FL", city }, {
    eligible: true, evidenceClass: "city_inferred", county: "Miami-Dade",
  });
}

// ── City inference — Broward ─────────────────────────────────────────────────
for (const city of ["Fort Lauderdale", "Ft. Lauderdale", "Ft Lauderdale", "Hollywood", "Pembroke Pines", "Coral Springs", "Pompano Beach", "Davie", "Weston"]) {
  check(`city="${city}" → Broward`, { state: "FL", city }, {
    eligible: true, evidenceClass: "city_inferred", county: "Broward",
  });
}

// ── City inference — Palm Beach ──────────────────────────────────────────────
for (const city of ["West Palm Beach", "Boca Raton", "Delray Beach", "Boynton Beach", "Wellington", "Jupiter", "Lake Worth"]) {
  check(`city="${city}" → Palm Beach`, { state: "FL", city }, {
    eligible: true, evidenceClass: "city_inferred", county: "Palm Beach",
  });
}

// ── City inference — Monroe (disabled) ───────────────────────────────────────
check("city=Key West → Monroe disabled", { state: "FL", city: "Key West" }, {
  eligible: false, evidenceClass: "city_inferred", county: "Monroe",
});

// ── Unknown locations ─────────────────────────────────────────────────────────
check("zip=32801 (Orlando) → unknown", { state: "FL", zip: "32801" }, {
  eligible: false, evidenceClass: "unknown", reasonCode: "GEOGRAPHY_UNKNOWN",
});
check("city=Sarasota → unknown", { state: "FL", city: "Sarasota" }, {
  eligible: false, evidenceClass: "unknown", reasonCode: "GEOGRAPHY_UNKNOWN",
});
check("city=St. Petersburg → unknown", { state: "FL", city: "St. Petersburg" }, {
  eligible: false, evidenceClass: "unknown", reasonCode: "GEOGRAPHY_UNKNOWN",
});
check("city=Jacksonville → unknown", { state: "FL", city: "Jacksonville" }, {
  eligible: false, evidenceClass: "unknown", reasonCode: "GEOGRAPHY_UNKNOWN",
});
check("no inputs → unknown", {}, {
  eligible: false, evidenceClass: "unknown", reasonCode: "GEOGRAPHY_UNKNOWN",
});

// ── Evidence conflicts ────────────────────────────────────────────────────────
// County says Broward but ZIP says Miami-Dade → conflict
check("county=Broward + zip=33131 (Miami-Dade) → conflict", { state: "FL", county: "Broward", zip: "33131" }, {
  eligible: false, evidenceClass: "conflicting", reasonCode: "GEOGRAPHY_EVIDENCE_CONFLICT",
});

// ── v2 reference version stamped on results ──────────────────────────────────
{
  const r = evaluateSouthFloridaGeography({ state: "FL", zip: "33131" });
  assert("v2: referenceVersion = south-florida-fips-v2", r.referenceVersion === "south-florida-fips-v2");
}

// ── v1 non-regression ────────────────────────────────────────────────────────
{
  const r = evaluateSouthFloridaGeographyV1({ state: "FL", zip: "33301" });
  assert("v1: 33301 still zip_inferred Broward", r.eligible === true && r.evidenceClass === "zip_inferred");
  assert("v1: referenceVersion = south-florida-fips-v1", r.referenceVersion === "south-florida-fips-v1");
}
{
  // v1 did not cover 33131 (Brickell) — should be unknown under v1
  const r = evaluateSouthFloridaGeographyV1({ state: "FL", zip: "33131" });
  assert("v1: 33131 is unknown (sparse reference)", r.evidenceClass === "unknown");
}

// ── ZIP map integrity checks ──────────────────────────────────────────────────
const allZips = Object.keys(_ZIP_COUNTY_V2_FOR_TEST);
assert("v2 ZIP map has > 200 entries", allZips.length > 200, `got ${allZips.length}`);

// Every ZIP maps to at least one known county
const knownCounties = new Set(["Miami-Dade", "Broward", "Palm Beach", "Monroe"]);
for (const [zip, counties] of Object.entries(_ZIP_COUNTY_V2_FOR_TEST)) {
  for (const county of counties) {
    assert(`ZIP ${zip} → known county "${county}"`, knownCounties.has(county));
  }
}

// City map integrity: every city maps to at least one known county
for (const [city, counties] of Object.entries(_CITY_COUNTY_V2_FOR_TEST)) {
  for (const county of counties) {
    assert(`City "${city}" → known county "${county}"`, knownCounties.has(county), county);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
for(const state of ["FL"," fl ","Florida"," florida ","FLORIDA"]) {
  assert(`${state}: Broward/33301 alias eligibility`,
    evaluateSouthFloridaGeography({state,county:"Broward",zip:"33301"}).eligible===true);
  assert(`${state}: county/ZIP conflict remains held`,
    evaluateSouthFloridaGeography({state,county:"Broward",zip:"33131"}).eligible===false);
  assert(`${state}: Monroe remains disabled`,
    evaluateSouthFloridaGeography({state,county:"Monroe",zip:"33040"}).eligible===false);
}
assert("GA plus Florida county/ZIP stays rejected",
  evaluateSouthFloridaGeography({state:"GA",county:"Broward",zip:"33301"}).eligible===false);
assert("Unknown state text is not an alias",
  evaluateSouthFloridaGeography({state:"Flo Rida",county:"Broward",zip:"33301"}).eligible===false);
assert("Absent geography remains unknown",evaluateSouthFloridaGeography({}).eligible===false);
console.log(`\n=== Geography Reference Tests ===`);
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach(f => console.log(f));
  process.exit(1);
}
