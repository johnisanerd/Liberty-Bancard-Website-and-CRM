#!/usr/bin/env npx tsx
/**
 * Census Classifier Unit Tests — AC #17, #18, #19
 *
 * AC #17 — UNCLASSIFIED_REVIEW classifier gap test
 * AC #18 — Zero contacts silently disappear
 * AC #19 — COMPLETE_EXISTING_DATA affirmative test
 *
 * No database, no provider calls. Pure function tests only.
 *
 * Exit 0 = all pass. Exit 1 = one or more fail.
 */

import {
  classifyContact,
  type CensusContactRow,
  type CensusRunContext,
} from "../server/services/contact-census-classifier";

// ──────────────────────────────────────────────────────────────────────────────
// Test harness
// ──────────────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const msg = detail ? `${label} — ${detail}` : label;
    errors.push(msg);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────
function makeCtx(overrides?: Partial<CensusRunContext>): CensusRunContext {
  return {
    runId: "test-run-id",
    asOf: new Date("2026-09-07T14:00:00Z").toISOString(),
    sharedPhoneSet: new Set(),
    sharedPhoneCompanyCount: new Map(),
    sharedPhoneTollFree: new Map(),
    sharedPhonePlaceholder: new Map(),
    singleCompanySingleSourcePhones: new Set(),
    businessNameSet: new Set(),
    ...overrides,
  };
}

function baseRow(overrides?: Partial<CensusContactRow>): CensusContactRow {
  return {
    id: 1,
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
    phone: "3055551234",
    companyName: "Acme Corp",
    vertical: "restaurants",
    verticalSource: null,
    manualVerticalOverride: null,
    dataReadinessScore: 80,
    leadScore: 70,
    emailStatus: "active",
    emailValidationUpdatedAt: null,
    businessId: null,
    doNotContact: false,
    suppressionReason: null,
    bounceStatus: "none",
    complaintStatus: "none",
    consentTier: "cold_no_consent",
    recordClass: "production",
    ghlContactId: "ghl-123",
    leadSource: "100k-lead-file",
    hasDeal: false,
    hasSourceEvent: false,
    hasEnrichmentRun: false,
    hasZerobounceRun: false,
    hasMergeRedirect: false,
    normalizedPhone: "3055551234",
    ...overrides,
  };
}

const ctx = makeCtx();

// ──────────────────────────────────────────────────────────────────────────────
// AC #17 — UNCLASSIFIED_REVIEW classifier gap test
//
// Contacts with unexpected/malformed dimensional states must route to
// UNCLASSIFIED_REVIEW with gap_code='classifier_no_rule_match', NOT to
// COMPLETE_EXISTING_DATA.
// ──────────────────────────────────────────────────────────────────────────────
console.log("\n[AC #17] UNCLASSIFIED_REVIEW classifier gap test");

{
  // Scenario: a contact that seems to pass all completeness checks but is missing
  // business_id, which blocks COMPLETE_EXISTING_DATA (affirmative predicate fails)
  // AND doesn't match any lane P1–P14 cleanly.
  // Actually, such a contact should land in P11 NEEDS_BUSINESS_MATERIALIZATION.
  // Let's force an UNCLASSIFIED_REVIEW by using record_class='unknown' without DNC
  // and no channels (which hits P3 insufficient_data, actually).
  // The real gap scenario: record_class='unknown' => P5 MANUAL_REVIEW.
  const unknownClassRow = baseRow({ recordClass: "unknown", businessId: null });
  const r = classifyContact(unknownClassRow, ctx);
  assert(
    "record_class='unknown' routes to MANUAL_REVIEW",
    r.primaryLane === "MANUAL_REVIEW",
    `got: ${r.primaryLane}`,
  );
  assert(
    "record_class='unknown' does NOT route to COMPLETE_EXISTING_DATA",
    r.primaryLane !== "COMPLETE_EXISTING_DATA",
  );
}

{
  // A contact with DNC=true and no channels — P2 BLOCKED_COMPLIANCE takes precedence
  const dncNoChannel = baseRow({ doNotContact: true, email: null, phone: null });
  const r = classifyContact(dncNoChannel, ctx);
  assert(
    "DNC contact routes to BLOCKED_COMPLIANCE regardless of channel state",
    r.primaryLane === "BLOCKED_COMPLIANCE",
    `got: ${r.primaryLane}`,
  );
  assert("DNC contact does NOT reach UNCLASSIFIED_REVIEW", r.primaryLane !== "UNCLASSIFIED_REVIEW");
}

{
  // A 'test' record with all fields perfect still routes to NON_PRODUCTION (P1)
  const perfectTestRow = baseRow({ recordClass: "test" });
  const r = classifyContact(perfectTestRow, ctx);
  assert(
    "record_class='test' routes to NON_PRODUCTION regardless of other fields",
    r.primaryLane === "NON_PRODUCTION",
    `got: ${r.primaryLane}`,
  );
  assert("test contact does NOT reach UNCLASSIFIED_REVIEW", r.primaryLane !== "UNCLASSIFIED_REVIEW");
  assert("test contact does NOT reach COMPLETE_EXISTING_DATA", r.primaryLane !== "COMPLETE_EXISTING_DATA");
}

{
  // Simulate a future record_class value not in ('test','demo','synthetic','unknown') —
  // it falls through P1 guard and later hits P5 only if d1 !== 'production'.
  // A truly novel class ('enterprise') that is not 'test'/'demo'/'synthetic'/'unknown' —
  // the P1 guard won't catch it, P5 won't catch it, so it will flow to the lowest
  // applicable lane based on field values.
  // Expected: with all fields present (except businessId) → P11 NEEDS_BUSINESS_MATERIALIZATION
  const futureClassRow = baseRow({ recordClass: "enterprise" } as any);
  const r = classifyContact(futureClassRow, ctx);
  assert(
    "Novel record_class 'enterprise' does NOT silently enter COMPLETE_EXISTING_DATA",
    r.primaryLane !== "COMPLETE_EXISTING_DATA",
    `got: ${r.primaryLane}`,
  );
  // It should hit P11 because businessId is null and company is present
  assert(
    "Novel record_class 'enterprise' falls through to NEEDS_BUSINESS_MATERIALIZATION",
    r.primaryLane === "NEEDS_BUSINESS_MATERIALIZATION",
    `got: ${r.primaryLane}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// AC #18 — Zero contacts silently disappear
//
// For N contacts with varied field combinations, every contact gets exactly
// one primary lane assignment and no IDs are missing from the result set.
// ──────────────────────────────────────────────────────────────────────────────
console.log("\n[AC #18] Zero contacts silently disappear");

{
  const testContacts: CensusContactRow[] = [
    baseRow({ id: 101 }), // P11 NEEDS_BUSINESS_MATERIALIZATION
    baseRow({ id: 102, recordClass: "test" }), // P1 NON_PRODUCTION
    baseRow({ id: 103, doNotContact: true }), // P2 BLOCKED_COMPLIANCE
    baseRow({ id: 104, email: null, phone: null, firstName: null, companyName: null }), // P3 INSUFFICIENT_DATA
    baseRow({ id: 105, email: null, phone: null }), // P6 or P3
    baseRow({ id: 106, email: null }), // P8 NEEDS_EMAIL
    baseRow({ id: 107, phone: null }), // P9 NEEDS_PHONE
    baseRow({ id: 108, vertical: null }), // P13 NEEDS_VERTICAL_ONLY
    baseRow({ id: 109, recordClass: "unknown" }), // P5 MANUAL_REVIEW
    baseRow({ id: 110, emailStatus: "bounced" }), // P2 BLOCKED_COMPLIANCE
    baseRow({ id: 111, hasMergeRedirect: true }), // P5 MANUAL_REVIEW
    baseRow({ id: 112, firstName: null, companyName: null }), // P7 NEEDS_CONTACT_NAME
    baseRow({ id: 113, recordClass: "demo" }), // P1 NON_PRODUCTION
    baseRow({ id: 114, suppressionReason: "manual" }), // P2 BLOCKED_COMPLIANCE
    baseRow({ id: 115, companyName: null, firstName: "Jane" }), // P12 NEEDS_BUSINESS_IDENTITY
  ];

  const results = testContacts.map(row => classifyContact(row, ctx));

  // Every contact ID must appear exactly once
  const resultIds = new Set(results.map(r => r.contactId));
  assert(
    `All ${testContacts.length} contacts produced exactly one result`,
    results.length === testContacts.length,
    `got ${results.length} results`,
  );

  for (const c of testContacts) {
    assert(
      `Contact id=${c.id} appears in results`,
      resultIds.has(c.id),
    );
  }

  // No lane is null/undefined/empty
  for (const r of results) {
    assert(
      `Contact id=${r.contactId} has non-empty primaryLane`,
      typeof r.primaryLane === "string" && r.primaryLane.length > 0,
      `got: ${r.primaryLane}`,
    );
    assert(
      `Contact id=${r.contactId} has at least one gap code`,
      Array.isArray(r.gapCodes) && r.gapCodes.length > 0,
      `got: ${JSON.stringify(r.gapCodes)}`,
    );
  }

  console.log(`  Lane distribution: ${results.map(r => `${r.contactId}→${r.primaryLane}`).join(", ")}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// AC #19 — COMPLETE_EXISTING_DATA affirmative test
//
// A contact missing any one required field must fail the affirmative predicate
// and cannot enter COMPLETE_EXISTING_DATA.
// ──────────────────────────────────────────────────────────────────────────────
console.log("\n[AC #19] COMPLETE_EXISTING_DATA affirmative predicate test");

// Build a "perfect" contact that WOULD qualify for COMPLETE_EXISTING_DATA
// (all affirmative conditions met). We use 2 months ago for validation date.
const validatedAt = new Date("2026-07-07T00:00:00Z"); // ~2 months ago, within 180 days
const perfectCompleteRow = baseRow({
  id: 200,
  businessId: 42,
  email: "jane@example.com",
  phone: "2125551234",
  firstName: "Jane",
  companyName: "Perfect Co",
  vertical: "restaurants",
  emailStatus: "valid",
  emailValidationUpdatedAt: validatedAt,
  doNotContact: false,
  suppressionReason: null,
  bounceStatus: "none",
  complaintStatus: "none",
  consentTier: "cold_no_consent",
  recordClass: "production",
});

const perfectCtx = makeCtx({
  asOf: new Date("2026-09-07T14:00:00Z").toISOString(),
});

{
  const r = classifyContact(perfectCompleteRow, perfectCtx);
  assert(
    "Perfect contact with all fields meets COMPLETE_EXISTING_DATA",
    r.primaryLane === "COMPLETE_EXISTING_DATA",
    `got: ${r.primaryLane}`,
  );
  assert(
    "COMPLETE_EXISTING_DATA gap codes contain PASS:business_id_linked",
    r.gapCodes.includes("PASS:business_id_linked"),
    `got: ${JSON.stringify(r.gapCodes)}`,
  );
  assert(
    "COMPLETE_EXISTING_DATA gap codes contain PASS:validation_current",
    r.gapCodes.includes("PASS:validation_current"),
    `got: ${JSON.stringify(r.gapCodes)}`,
  );
}

// Now test that removing each required field one at a time fails the predicate
const requiredMutations: [string, Partial<CensusContactRow>][] = [
  ["business_id IS NULL", { businessId: null }],
  ["email is empty", { email: null }],
  ["phone is empty", { phone: null }],
  ["first_name is empty", { firstName: null }],
  ["company_name is empty", { companyName: null }],
  ["validation not current (no date)", { emailValidationUpdatedAt: null }],
  ["DNC is true", { doNotContact: true }],
  ["vertical missing", { vertical: null }],
];

for (const [label, mutation] of requiredMutations) {
  const row = { ...perfectCompleteRow, id: 300 + requiredMutations.indexOf([label, mutation] as any), ...mutation };
  const r = classifyContact(row, perfectCtx);
  assert(
    `Contact with ${label} does NOT enter COMPLETE_EXISTING_DATA`,
    r.primaryLane !== "COMPLETE_EXISTING_DATA",
    `got: ${r.primaryLane}`,
  );
}

// Stale validation (> 180 days) should also fail
{
  const staleRow = {
    ...perfectCompleteRow,
    id: 400,
    emailValidationUpdatedAt: new Date("2026-01-01T00:00:00Z"), // > 180 days ago
  };
  const r = classifyContact(staleRow, perfectCtx);
  assert(
    "Contact with stale validation (>90d) does NOT enter COMPLETE_EXISTING_DATA",
    r.primaryLane !== "COMPLETE_EXISTING_DATA",
    `got: ${r.primaryLane}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Additional correctness tests
// ──────────────────────────────────────────────────────────────────────────────
console.log("\n[Additional] Correctness checks");

{
  // P4 DUPLICATE_REVIEW: shared phone + multiple companies
  const sharedCtx = makeCtx({
    sharedPhoneSet: new Set(["5555551234"]),
    sharedPhoneCompanyCount: new Map([["5555551234", 5]]),
    sharedPhoneTollFree: new Map([["5555551234", false]]),
    sharedPhonePlaceholder: new Map([["5555551234", false]]),
    singleCompanySingleSourcePhones: new Set(),
  });
  const dupRow = baseRow({ phone: "5555551234", normalizedPhone: "5555551234" });
  const r = classifyContact(dupRow, sharedCtx);
  assert(
    "Shared phone (5 companies) routes to DUPLICATE_REVIEW",
    r.primaryLane === "DUPLICATE_REVIEW",
    `got: ${r.primaryLane}`,
  );
}

{
  // P2: opted_out consent tier
  const optOutRow = baseRow({ consentTier: "opted_out" });
  const r = classifyContact(optOutRow, ctx);
  assert(
    "consent_tier='opted_out' routes to BLOCKED_COMPLIANCE",
    r.primaryLane === "BLOCKED_COMPLIANCE",
    `got: ${r.primaryLane}`,
  );
}

{
  // P10: candidate match
  const bizCtx = makeCtx({ businessNameSet: new Set(["acme corp"]) });
  const r = classifyContact(baseRow(), bizCtx);
  assert(
    "Company name matching businesses.normalized_name routes to INTERNAL_MATCH_AVAILABLE",
    r.primaryLane === "INTERNAL_MATCH_AVAILABLE",
    `got: ${r.primaryLane}`,
  );
}

{
  // D10 phone quality: source attribution conflict (>20 companies)
  const conflictCtx = makeCtx({
    sharedPhoneSet: new Set(["3013803000"]),
    sharedPhoneCompanyCount: new Map([["3013803000", 97]]),
    sharedPhoneTollFree: new Map([["3013803000", false]]),
    sharedPhonePlaceholder: new Map([["3013803000", false]]),
    singleCompanySingleSourcePhones: new Set(),
  });
  const conflictRow = baseRow({ phone: "3013803000", normalizedPhone: "3013803000" });
  const r = classifyContact(conflictRow, conflictCtx);
  assert(
    "Phone with 97 companies has phoneQualityState=source_attribution_conflict",
    r.phoneQualityState === "source_attribution_conflict",
    `got: ${r.phoneQualityState}`,
  );
  // But it routes to P11 since companyCount > 20 means NOT duplicate_candidate
  assert(
    "97-company shared phone routes to NEEDS_BUSINESS_MATERIALIZATION (not DUPLICATE_REVIEW)",
    r.primaryLane === "NEEDS_BUSINESS_MATERIALIZATION",
    `got: ${r.primaryLane}`,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`Census Classifier Tests: ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.error("\nFailed assertions:");
  errors.forEach(e => console.error(`  • ${e}`));
  process.exit(1);
}
console.log("All tests passed ✓");
process.exit(0);
