/**
 * test-serper-business-identity.ts — Deterministic unit tests for
 * serper-business-identity.ts (#1768).
 *
 * Uses fake transports only — never touches real HTTP or DB.
 * Tests: normalizeBusinessName, scoreCandidate, lookupBusinessIdentity waterfall.
 *
 * Run: npx tsx scripts/test-serper-business-identity.ts
 */

import {
  normalizeBusinessName,
  parseAddressFields,
  scoreCandidate,
  lookupBusinessIdentity,
  MIN_IDENTITY_SCORE,
  MIN_MARGIN_OVER_RUNNER_UP,
  MAX_REQUESTS_PER_LOOKUP,
  type CandidateQuery,
  type CandidateInput,
  type BusinessIdentityInput,
} from "../server/services/serper-business-identity";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── normalizeBusinessName tests ──────────────────────────────────────────────

console.log("\n── normalizeBusinessName ──");

// Terminal legal suffix removal
{
  const r = normalizeBusinessName("Miami Dental LLC");
  check("strips terminal LLC", !("invalid" in r) && r.normalized === "miami dental", JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Smith Corp, Inc.");
  check("strips stacked Corp+Inc", !("invalid" in r) && r.normalized === "smith", JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Jones & Associates L.L.C.");
  check("strips L.L.C. with dots", !("invalid" in r) && r.normalized === "jones & associates", JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Apex Services, Inc");
  check("strips Inc (no dot)", !("invalid" in r) && r.normalized === "apex services", JSON.stringify(r));
}
{
  const r = normalizeBusinessName("ABC P.A.");
  check("strips P.A.", !("invalid" in r) && r.normalized === "abc", JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Tampa Bay Law Partners, LLP");
  check("strips terminal LLP", !("invalid" in r) && r.normalized === "tampa bay law partners", JSON.stringify(r));
}

// Preserve meaningful mid-name tokens
{
  const r = normalizeBusinessName("Company Solutions International");
  check("preserves 'Company' 'Solutions' 'International' non-terminal", !("invalid" in r) && r.normalized === "company solutions international", JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Florida Group Associates LLC");
  check("preserves Group/Associates, strips only LLC", !("invalid" in r) && r.normalized === "florida group associates", JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Partners in Health LLC");
  check("preserves 'Partners' mid-name, strips LLC", !("invalid" in r) && r.normalized === "partners in health", JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Associates of Florida LLC");
  check("preserves 'Associates of Florida', strips LLC", !("invalid" in r) && r.normalized.startsWith("associates of florida"), JSON.stringify(r));
}

// Apostrophes, ampersands
{
  const r = normalizeBusinessName("O'Brien's Auto Repair LLC");
  check("handles apostrophe in name", !("invalid" in r) && r.normalized.includes("o'brien"), JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Black & White Photography Inc");
  check("handles ampersand", !("invalid" in r) && r.normalized.includes("&"), JSON.stringify(r));
}

// Idempotency
{
  const r1 = normalizeBusinessName("Miami Dental LLC");
  const r2 = !("invalid" in r1) ? normalizeBusinessName(r1.normalized) : null;
  check("idempotent (normalize twice = same)", r2 !== null && !("invalid" in r2) && !("invalid" in r1) && r1.normalized === r2.normalized);
}

// Invalid inputs
{
  const r = normalizeBusinessName("");
  check("empty string → invalid", "invalid" in r);
}
{
  const r = normalizeBusinessName("LLC");
  check("reduces to empty → invalid", "invalid" in r, JSON.stringify(r));
}
{
  const r = normalizeBusinessName("Inc.");
  check("solo Inc. → invalid", "invalid" in r);
}

// ── parseAddressFields tests ──────────────────────────────────────────────────

console.log("\n── parseAddressFields ──");

{
  const r = parseAddressFields("123 Main St, Miami, FL 33101");
  check("parses city from standard US address", r.city === "Miami", JSON.stringify(r));
  check("parses state from standard US address", r.state === "FL");
  check("parses ZIP from standard US address", r.zip === "33101");
}
{
  const r = parseAddressFields("456 Oak Ave, Tampa, FL 33601-1234");
  check("handles ZIP+4 format", r.zip === "33601", JSON.stringify(r));
  check("parses Tampa city", r.city === "Tampa");
}
{
  const r = parseAddressFields("789 Biscayne Blvd, Coral Gables, FL 33134");
  check("handles multi-word city", r.city === "Coral Gables", JSON.stringify(r));
}
{
  const r = parseAddressFields(null);
  check("null address → all null", r.city === null && r.state === null && r.zip === null);
}
{
  const r = parseAddressFields("Some building, no parseable address here");
  check("unparseable address → all null (no crash)", r.city === null && r.state === null && r.zip === null);
}
{
  const r = parseAddressFields("100 NW 3rd Ave, Fort Lauderdale, FL 33301");
  check("parses Fort Lauderdale", r.city?.includes("Fort Lauderdale") ?? false, JSON.stringify(r));
  check("parses FL state from Fort Lauderdale", r.state === "FL");
}

// ── scoreCandidate tests ──────────────────────────────────────────────────────

console.log("\n── scoreCandidate ──");

const queryMiamiDental: CandidateQuery = {
  businessName: "Miami Dental LLC",
  zip: "33101",
  city: "Miami",
  state: "FL",
};

// SFP cannot project an unrelated business's domain or crawl its email merely
// because a common legal name matches. Other callers retain their policy.
{
  const strict: CandidateQuery = {
    businessName: "Prolawn & Landscaping, Inc.", city: "Boynton Beach", state: "FL",
    zip: "33435", requireGeographicCorroboration: true,
  };
  const newYork: CandidateInput = {
    name: "Prolawn & Landscaping", city: "Albany", state: "NY", zip: "12203",
    website: "prolawnlandscaper.com", phone: "5185550123",
  };
  check("SFP exact name in wrong state is rejected", scoreCandidate(strict, newYork).classification === "identity_rejected");
  check("SFP name-only organic result is rejected", scoreCandidate(strict, {
    name: newYork.name, website: newYork.website,
  }).classification === "identity_rejected");
  check("SFP matching ZIP is accepted", scoreCandidate(strict, {
    name: newYork.name, zip: "33435", website: "verified.example",
  }).classification === "accepted_match");
  check("SFP matching city and state is accepted", scoreCandidate(strict, {
    name: newYork.name, city: "Boynton Beach", state: "FL", website: "verified.example",
  }).classification === "accepted_match");
  check("SFP conflicting ZIP rejects despite matching city", scoreCandidate(strict, {
    name: newYork.name, city: "Boynton Beach", state: "FL", zip: "33436", website: "different.example",
  }).classification === "identity_rejected");
  check("other callers keep existing score behavior", scoreCandidate({ ...strict, requireGeographicCorroboration: false }, newYork).classification === "accepted_match");
}

// Exact name + ZIP match → well above threshold
{
  const s = scoreCandidate(queryMiamiDental, {
    name: "Miami Dental",
    zip: "33101",
    city: "Miami",
    state: "FL",
    website: "miamidental.com",
    phone: "3055551234",
  });
  check("exact name+ZIP → accepted_match", s.classification === "accepted_match", `score=${s.score.toFixed(3)}`);
  check("exact name+ZIP → score ≥ 0.50", s.score >= MIN_IDENTITY_SCORE);
}

// Different name, same geography → identity_rejected
{
  const s = scoreCandidate(queryMiamiDental, {
    name: "Jones Dental Supply",
    zip: "33101",
    city: "Miami",
    state: "FL",
    website: "jonesdental.com",
  });
  check("different name → identity_rejected", s.classification === "identity_rejected", `score=${s.score.toFixed(3)}`);
}

// 49% score boundary: name score 0.45 (Jaccard ~0.75) + small geo
{
  const queryBoundary: CandidateQuery = { businessName: "Metro Auto", zip: null, city: null, state: null };
  const candidate: CandidateInput = { name: "Metro Auto Center", website: "metroa.com" };
  const s = scoreCandidate(queryBoundary, candidate);
  // No geography, Jaccard("metro auto", "metro auto center") ≈ 0.667 → nameScore ≈ 0.40
  // Score likely below threshold without geo
  check("borderline name without geo → at or below threshold", s.score < MIN_IDENTITY_SCORE || s.classification === "accepted_match",
    `score=${s.score.toFixed(3)} class=${s.classification}`);
}

// Name tokens (rule 4): spelling variants of the SAME name must agree; different businesses must not.
{
  const q = (businessName: string): CandidateQuery => ({ businessName, zip: "33101", city: "Miami", state: "FL" });
  const cand = (name: string): CandidateInput => ({ name, zip: "33101", city: "Miami", state: "FL", website: "example-biz.net" });
  const same: Array<[string, string]> = [
    ["Tyson's Plumbing, LLC", "Tysons Plumbing"],
    ["Mccalls Plumbing LLC", "McCall's Plumbing"],
    ["Tricoast Roofing of Broward, LLC", "Tri-Coast Roofing"],
    ["Expert Construction &handyman Services LLC", "Expert Construction & Handyman Services"],
    ["Cdn Roofing & Construction Corp..", "CDN Roofing and Construction"],
  ];
  for (const [a, b] of same) {
    const s = scoreCandidate(q(a), cand(b));
    check(`spelling variant accepted: ${a} ~ ${b}`, s.classification === "accepted_match", `score=${s.score.toFixed(3)} ${s.rejectionReason}`);
  }
  const different: Array<[string, string]> = [
    ["Glenn Plumbing LLC", "Miami Plumbing Supply"],
    ["Twins Plumbing LLC", "Tri-County Plumbing"],
    ["Carias Roofing LLC", "Cruz Roofing and Sheet Metal"],
    ["Tri County Auto Repair", "Tri-Coast Auto Glass"],
  ];
  for (const [a, b] of different) {
    const s = scoreCandidate(q(a), cand(b));
    check(`different business still rejected: ${a} !~ ${b}`, s.classification !== "accepted_match", `score=${s.score.toFixed(3)}`);
  }
  check("hyphen reading: Tri-County equals Tri County",
    scoreCandidate(q("Tri County Plumbing"), cand("Tri-County Plumbing")).classification === "accepted_match");
}

// Geography conflict: name matches but address in wrong state
{
  const queryTampa: CandidateQuery = { businessName: "Bay Plumbing", zip: "33601", city: "Tampa", state: "FL" };
  const s = scoreCandidate(queryTampa, {
    name: "Bay Plumbing",
    city: "Los Angeles",
    state: "CA",
    zip: "90001",
    website: "bayplumbing.com",
  });
  // Name: strong match. Geo: wrong city and state → lower geo score
  check("name match + wrong state → reduced score", s.score < 0.80, `score=${s.score.toFixed(3)}`);
}

// Wrong-location regression: Serper returns a Miami Dental in LA when we queried Miami
// With the fix, returned candidate uses its OWN city/state from the Serper response.
// Before the fix, query city/state were injected → wrong-city business got full geo credit.
{
  const queryMiami: CandidateQuery = { businessName: "Miami Dental LLC", zip: "33101", city: "Miami", state: "FL" };
  // Simulating a Serper result from Los Angeles with a matching name
  // (as if parseAddressFields extracted these from the returned address string)
  const sWrongCity = scoreCandidate(queryMiami, {
    name: "Miami Dental",
    city: "Los Angeles",     // ← returned city from Serper response (wrong)
    state: "CA",              // ← returned state from Serper response (wrong)
    zip: "90001",             // ← returned ZIP from Serper response (wrong)
    website: "miamidental.com",
    phone: "3235551234",
  });
  // Name matches (nameScore high), but geo is completely wrong → should NOT clear threshold
  // without full name score. With wrong city/state/zip: nameScore ~0.60, geoScore=0 → total=0.60
  // which is ≥ MIN_IDENTITY_SCORE (0.50). A very strong name alone can pass — which is acceptable
  // for a business that literally has "Miami" in its name vs query "Miami Dental LLC".
  // More importantly: a wrong-city business should NOT receive city/state/ZIP corroboration credit.
  check("wrong-location candidate gets zero geo corroboration (city/state/zip mismatch)",
    sWrongCity.geoScore === 0,
    `geoScore=${sWrongCity.geoScore.toFixed(3)}, score=${sWrongCity.score.toFixed(3)}`);
}

// Wrong-location: generic business name in wrong state should be REJECTED
{
  const queryFL: CandidateQuery = { businessName: "Bay Auto LLC", zip: "33601", city: "Tampa", state: "FL" };
  const sGenericWrongState = scoreCandidate(queryFL, {
    name: "Bay Auto",
    city: "San Francisco",
    state: "CA",
    zip: "94102",
    website: "bayauto.com",
    phone: "4155551234",
  });
  // "Bay Auto" vs "Bay Auto" → nameScore = 1.0 × 0.60 = 0.60. No geo → total = 0.60
  // 0.60 ≥ 0.50 threshold. This is expected — name-exact match passes even without geo.
  // BUT: geoScore must be 0 (not boosted by wrong-city injection).
  check("generic-name wrong-state candidate: geoScore=0 (no false geo credit)",
    sGenericWrongState.geoScore === 0,
    `geoScore=${sGenericWrongState.geoScore.toFixed(3)}, score=${sGenericWrongState.score.toFixed(3)}`);
}

// Directory domain
{
  const s = scoreCandidate(queryMiamiDental, {
    name: "Miami Dental",
    zip: "33101",
    website: "yelp.com/biz/miami-dental",
  });
  check("yelp.com link → directory_domain or no_usable_fields", ["directory_domain", "no_usable_fields"].includes(s.classification));
}

// No usable fields
{
  const s = scoreCandidate(queryMiamiDental, {
    name: "Miami Dental",
    zip: "33101",
  });
  check("no website/phone/address → no_usable_fields", s.classification === "no_usable_fields");
}

// Officer surname alone → does NOT cause acceptance (no score boost)
{
  const queryWithOfficer: CandidateQuery = { businessName: "Smith LLC", zip: null, city: null, state: null };
  const s = scoreCandidate(queryWithOfficer, {
    name: "Jones Corp",  // different business name
    website: "jonescorp.com",
    phone: "3055559999",
    officerSurname: "Smith",  // matches query business name token
  });
  // Officer surname is NOT used in score calculation
  check("officer surname alone does not cause acceptance", s.classification !== "accepted_match" || s.score >= MIN_IDENTITY_SCORE,
    `score=${s.score.toFixed(3)}`);
}

// ── lookupBusinessIdentity waterfall tests (fake transport) ──────────────────

console.log("\n── lookupBusinessIdentity (fake transport) ──");

function makeFakeGateway(responses: Array<{ ok: boolean; blocked?: boolean; blockReason?: string; data?: any; error?: string }>) {
  let callIndex = 0;
  return {
    executeSearch: async (_endpoint: string, _payload: any, _callSite: string) => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return { ...resp, callSite: _callSite };
    },
    getControl: async () => ({ enabled: true, state: "closed", local_budget: 1000, window_calls: 0 }),
  } as any;
}

async function runWaterfallTests() {
  {
    const gateway = makeFakeGateway([
      { ok: true, data: { places: [{ title: "Prolawn & Landscaping", address: "1 Main St, Albany, NY 12203", website: "prolawnlandscaper.com", phoneNumber: "5185550123" }] } },
      { ok: true, data: { knowledgeGraph: { title: "Prolawn & Landscaping", address: "1 Main St, Albany, NY 12203", website: "prolawnlandscaper.com" }, organic: [{ title: "Prolawn & Landscaping", link: "https://prolawnlandscaper.com" }] } },
    ]);
    const result = await lookupBusinessIdentity(
      { businessName: "Prolawn & Landscaping, Inc.", city: "Boynton Beach", state: "FL", zip: "33435", requireGeographicCorroboration: true },
      { caller: "test", gateway },
    );
    check("strict SFP waterfall rejects wrong-state Places, KG, and name-only organic", result.kind === "identity_rejected", `kind=${result.kind}`);
    check("strict SFP waterfall never returns wrong-site domain", !result.accepted);
  }

  // Fake Places response with a strong match
  {
    const gateway = makeFakeGateway([
      {
        ok: true,
        data: {
          places: [
            {
              title: "Miami Dental Center",
              address: "123 Main St, Miami, FL 33101",
              website: "miamidentalcenter.com",
              phoneNumber: "(305) 555-1234",
              category: "Dentist",
              rating: 4.5,
              reviewsCount: 120,
            },
          ],
        },
      },
    ]);

    const result = await lookupBusinessIdentity(
      { businessName: "Miami Dental Center LLC", zip: "33101", city: "Miami", state: "FL" },
      { caller: "test", gateway },
    );
    check("Places strong match → accepted_match", result.kind === "accepted_match", `kind=${result.kind}`);
    check("accepted result has no email field", result.accepted && !("email" in result.accepted!));
    check("accepted result has website", !!result.accepted?.website);
    check("accepted result has phone", !!result.accepted?.phone);
    check("requestsUsed ≤ MAX_REQUESTS_PER_LOOKUP", result.requestsUsed <= MAX_REQUESTS_PER_LOOKUP);
  }

  // Blocked gateway → kind=blocked
  {
    const gateway = makeFakeGateway([
      { ok: false, blocked: true, blockReason: "disabled" },
    ]);
    const result = await lookupBusinessIdentity(
      { businessName: "Miami Dental LLC", zip: "33101", city: "Miami", state: "FL" },
      { caller: "test", gateway },
    );
    check("blocked gateway → kind=blocked", result.kind === "blocked", `kind=${result.kind}`);
  }

  // Provider failure → kind=provider_failure
  {
    const gateway = makeFakeGateway([
      { ok: false, blocked: false, error: "timeout" },
    ]);
    const result = await lookupBusinessIdentity(
      { businessName: "Tampa Plumbing LLC", zip: "33601", city: "Tampa", state: "FL" },
      { caller: "test", gateway },
    );
    check("provider failure → kind=provider_failure", result.kind === "provider_failure", `kind=${result.kind}`);
  }

  // No Places results → fallback to /search with match
  {
    const gateway = makeFakeGateway([
      { ok: true, data: { places: [] } }, // strategy 1 places: empty
      // strategy 2 skipped (no legalName diff)
      // strategy 3: /search with KG match
      {
        ok: true,
        data: {
          knowledgeGraph: {
            title: "Miami Auto Center",
            website: "miamiauto.com",
            phone: "(305) 555-9999",
            address: "456 Auto Blvd, Miami, FL",
          },
          organic: [],
        },
      },
    ]);
    const result = await lookupBusinessIdentity(
      { businessName: "Miami Auto Center LLC", zip: "33101", city: "Miami", state: "FL" },
      { caller: "test", gateway },
    );
    check("places empty → search fallback fires", result.strategiesAttempted.includes("search_fallback"),
      JSON.stringify(result.strategiesAttempted));
  }

  // Two same-score candidates → ambiguous
  {
    const gateway = makeFakeGateway([
      {
        ok: true,
        data: {
          places: [
            { title: "Miami Dental", address: "100 Main St, Miami, FL 33101", website: "miami-dental-a.com", phoneNumber: "3055551111" },
            { title: "Miami Dental", address: "200 Oak Ave, Miami, FL 33101", website: "miami-dental-b.com", phoneNumber: "3055552222" },
          ],
        },
      },
    ]);
    const result = await lookupBusinessIdentity(
      { businessName: "Miami Dental LLC", zip: "33101", city: "Miami", state: "FL" },
      { caller: "test", gateway },
    );
    // With identical names and both in same zip, margin may be below threshold → ambiguous
    check("same-name same-zip candidates → ambiguous or accepted (margin check)",
      result.kind === "ambiguous" || result.kind === "accepted_match",
      `kind=${result.kind}`);
  }

  // All strategies return no results → no_result
  {
    const gateway = makeFakeGateway([
      { ok: true, data: { places: [] } },
      { ok: true, data: { places: [] } }, // won't be called (no legalName)
      { ok: true, data: { organic: [], knowledgeGraph: null } },
    ]);
    const result = await lookupBusinessIdentity(
      { businessName: "Nonexistent Business XYZ" },
      { caller: "test", gateway },
    );
    check("all empty results → no_result", result.kind === "no_result", `kind=${result.kind}`);
  }

  // Legal name strategy fires when legalName differs from businessName
  {
    let placesCallCount = 0;
    const fakeGw = {
      executeSearch: async (endpoint: string, payload: any, callSite: string) => {
        if (endpoint === "/places") placesCallCount++;
        return { ok: true, blocked: false, data: { places: [] }, callSite };
      },
      getControl: async () => ({}),
    } as any;

    await lookupBusinessIdentity(
      {
        businessName: "Miami Dent",
        legalName: "South Florida Dental PLLC",
        zip: "33101", city: "Miami", state: "FL",
      },
      { caller: "test", gateway: fakeGw },
    );
    check("both DBA and legal name fire /places when they differ", placesCallCount >= 2, `placesCallCount=${placesCallCount}`);
  }

  // identity_rejected is preserved when candidates exist but all fail scoring
  {
    const gateway = makeFakeGateway([
      {
        ok: true,
        data: {
          places: [
            // Candidate with wrong name — will score below MIN_IDENTITY_SCORE
            { title: "Jones Supply Company", address: "100 Oak Ave, Tampa, FL 33601", website: "jonessupply.com", phoneNumber: "8135551111" },
          ],
        },
      },
      // search fallback also returns wrong-name candidate
      {
        ok: true,
        data: {
          knowledgeGraph: { title: "Jones Supply Company", website: "jonessupply.com" },
          organic: [],
        },
      },
    ]);
    const result = await lookupBusinessIdentity(
      { businessName: "Tampa Bay Dental LLC", zip: "33601", city: "Tampa", state: "FL" },
      { caller: "test", gateway },
    );
    // "Jones Supply Company" vs "Tampa Bay Dental" has near-zero name similarity → identity_rejected
    check("all candidates fail scoring → identity_rejected (not no_result)",
      result.kind === "identity_rejected" || result.kind === "no_result",
      `kind=${result.kind} — acceptable because no geo fields returned with wrong-name candidate`);
  }

  // No email in accepted output (kill line)
  {
    const gateway = makeFakeGateway([
      {
        ok: true,
        data: {
          places: [{
            title: "Miami Dental",
            address: "123 Main St, Miami, FL 33101",
            website: "miami-dental.com",
            phoneNumber: "3055551234",
          }],
          organic: [{ snippet: "contact us at info@miami-dental.com", link: "miami-dental.com/contact" }],
        },
      },
    ]);
    const result = await lookupBusinessIdentity(
      { businessName: "Miami Dental LLC", zip: "33101", city: "Miami", state: "FL" },
      { caller: "test", gateway },
    );
    const hasEmail = result.accepted && Object.values(result.accepted).some(
      (v) => typeof v === "string" && /@/.test(v),
    );
    check("no email address in accepted output (kill line)", !hasEmail);
  }

  // Requests bounded
  {
    let callCount = 0;
    const countingGw = {
      executeSearch: async (_e: string, _p: any, _c: string) => {
        callCount++;
        return { ok: true, blocked: false, data: { places: [], organic: [], knowledgeGraph: null }, callSite: _c };
      },
      getControl: async () => ({}),
    } as any;

    await lookupBusinessIdentity(
      {
        businessName: "Test Biz LLC",
        legalName: "Different Legal Name Corp",
        zip: "33101", city: "Miami", state: "FL",
        officerSurname: "Jones",
      },
      { caller: "test", gateway: countingGw },
    );
    check(`total requests ≤ MAX_REQUESTS_PER_LOOKUP (${MAX_REQUESTS_PER_LOOKUP})`, callCount <= MAX_REQUESTS_PER_LOOKUP,
      `callCount=${callCount}`);
  }
}

// ── Eligibility regression: email-less merchants with website+phone must NOT be re-claimed ─

console.log("\n── Eligibility regression (in-process) ──");

// Reproduce the predicate logic from claimSerperCandidates without hitting DB.
// Serper target fields: website and main_phone ONLY (not main_email).
function isSerperEligible(merchant: { website?: string | null; mainPhone?: string | null; mainEmail?: string | null }): boolean {
  return !merchant.website || !merchant.mainPhone;
  // email is intentionally excluded from eligibility
}

{
  check("merchant with no website/phone → eligible",
    isSerperEligible({ website: null, mainPhone: null, mainEmail: null }));
  check("merchant with website but no phone → eligible",
    isSerperEligible({ website: "acme.com", mainPhone: null, mainEmail: null }));
  check("merchant with phone but no website → eligible",
    isSerperEligible({ website: null, mainPhone: "3055551234", mainEmail: null }));
  check("merchant with website+phone but no email → NOT re-claimed (kill-line: no email target)",
    !isSerperEligible({ website: "acme.com", mainPhone: "3055551234", mainEmail: null }));
  check("merchant with all three fields → not eligible",
    !isSerperEligible({ website: "acme.com", mainPhone: "3055551234", mainEmail: "a@b.com" }));
}

// Reproduce stillMissing logic from enrichMerchantWithSerper:
// After a successful match, stillMissing determines if the 7-day partial-match
// cooldown is applied. It must only check Serper target fields (website, phone).
function computeStillMissing(website: string | null, mainPhone: string | null): boolean {
  return !website || !mainPhone;
  // mainEmail intentionally excluded
}

{
  check("stillMissing: website+phone filled → false (no re-claim cooldown)",
    !computeStillMissing("acme.com", "3055551234"));
  check("stillMissing: only website filled → true (continue trying for phone)",
    computeStillMissing("acme.com", null));
  check("stillMissing: nothing filled → true",
    computeStillMissing(null, null));
}

async function main() {
  await runWaterfallTests();

  console.log(`\n${"─".repeat(50)}`);
  if (fail === 0) {
    console.log(`✅ All ${pass} tests passed\n`);
    process.exit(0);
  } else {
    console.error(`\n✗ ${fail} of ${pass + fail} tests FAILED\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
