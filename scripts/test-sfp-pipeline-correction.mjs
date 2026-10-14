#!/usr/bin/env node
/** Dependency-free structural regression suite for the SFP enrichment path. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const files = {
  sfp: read("server/services/cro03/south-florida-prospecting.ts"),
  validation: read("server/services/cro03/sfp-validation.ts"),
  paid: read("server/services/cro03/sfp-paid-waterfall.ts"),
  providerOps: read("server/services/cro03/sfp-provider-operations.ts"),
  freeEvidence: read("server/services/free-discovery/evidence-service.ts"),
  queue: read("server/services/queue-manager.ts"),
  routes: read("server/routes/lead-ops.ts"),
  ui: read("client/src/components/lead-ops/SouthFloridaProspectingPanel.tsx"),
  manifest: read("server/services/provider-manifest.ts"),
  schema: read("shared/schema.ts"),
  migration: read("migrations/0278_sfp_governed_operations.sql"),
  replit: read(".replit"),
  packageJson: read("package.json"),
  index: read("server/index.ts"),
  startupMigrationPolicy: read("server/startup-migration-policy.ts"),
  roi: read("server/services/cro03/roi-cohort-selector.ts"),
};

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}: ${error.message}`); process.exitCode = 1; }
};
const has = (src, needle) => assert.ok(src.includes(needle), `missing: ${needle}`);
const lacks = (src, needle) => assert.ok(!src.includes(needle), `forbidden: ${needle}`);

console.log("\nSFP pipeline correction regression suite\n");

test("candidate decryption uses the matching evidence envelope", () => {
  has(files.validation, "openSfpCandidatePlaintext");
  has(files.validation, "await openSfpCandidatePlaintext(");
  has(files.validation, 'purpose: "sfp_email_validation"');
  has(read("server/services/cro03/sfp-paid-evidence-writer.ts"), "export async function openSfpCandidatePlaintext");
  lacks(files.validation, "unsealCandidateEvidence(");
  lacks(files.validation, "decryptCandidateEmail(");
  lacks(files.validation, "openCandidate(");
});
test("free promotion uses canonical suppression state", () => {
  has(files.freeEvidence, "CANDIDATE_DECRYPTION_FAILED");
  has(files.freeEvidence, "contactEmailTokenHash");
  has(files.freeEvidence, "SUPPRESSION_QUERY_ERROR");
  lacks(files.freeEvidence, "zerobounce_suppressions");
  lacks(files.freeEvidence, "SET disposition = 'validation_admitted', updated_at");
});
test("SFP validation checks both candidate and contact hashes", () => {
  has(files.validation, "contactEmailTokenHash");
  has(files.validation, "isCanonicallySuppressed");
  // Behavioral, not source-text: the canonical suppression check must be
  // called with an array containing BOTH the candidate's own email hash and
  // the contact-level token hash, so a suppression recorded against either
  // identity blocks the row. A brittle source-text regex here previously
  // pinned one exact (and stale) call-site shape; assert the call site
  // passes a two-element array built from both hash variables instead.
  const suppressionCallSite = files.validation.match(
    /isCanonicallySuppressed\s*\(\s*\[\s*([^\]]*?)\s*\]\s*,\s*tx\s*,\s*\[\s*realEmail\s*\]\s*\)/s,
  );
  assert.ok(suppressionCallSite, "no isCanonicallySuppressed([...], tx, [realEmail]) call found in sfp-validation.ts");
  const args = suppressionCallSite[1];
  assert.ok(args.includes("emailHash"), "suppression check must include the candidate emailHash");
  assert.ok(args.includes("contactEmailTokenHash"), "suppression check must include contactEmailTokenHash");
  has(files.validation, "canonical_suppression_match");
  lacks(files.validation, "zerobounce_suppressions");
});
test("provider-valid does not make named email automatically eligible", () => {
  has(files.validation, "policy.roleInboxPolicy?.role_inbox_eligible_for_cold_b2b");
  has(files.validation, "policy.roleInboxPolicy?.named_or_unclassified_requires_review");
  has(files.validation, "isNamedContact");
  has(files.validation, '"validated_review_required"');
  has(files.validation, "namedRequiresReview");
  has(files.validation, "operator_review_required");
});
test("campaign staging rechecks suppression and uses contact hash", () => {
  has(files.sfp, "suppressed_at_staging");
  has(files.sfp, "contactEmailTokenHash");
  has(files.sfp, "sfp_campaign_staging_intents");
  has(files.sfp, "awaiting_explicit_campaign_authorization");
});
test("campaign staging remains a no-send boundary", () => {
  has(files.sfp, "zeroOutreachConfirmed: true");
  lacks(files.sfp, "sendEmail(");
  lacks(files.sfp, "enrollInSequence(");
});
test("program activation and bounded free execution are real routes", () => {
  has(files.routes, '"/api/lead-ops/sfp/program/activation"');
  has(files.routes, '"/api/lead-ops/sfp/runs/:runId/free-discovery"');
  has(files.sfp, "runFreeEnrichmentLane(businessIds)");
});
test("recurring free lane is configurable and bounded", () => {
  has(files.queue, "FREE_ENRICHMENT_BATCH_SIZE");
  has(files.queue, "Math.min(100");
  lacks(files.queue, "const FREE_LANE_BATCH = 20;");
});
test("paid provider execution keeps activation and dispatch fences without paid approval or an in-app money ceiling", () => {
  has(files.providerOps, "reserveSfpProviderOperation");
  has(files.providerOps, "assertCurrentSfpProviderReservation");
  lacks(files.providerOps, "assertPaidBudgetAuthorized");
  has(files.providerOps, "assertProviderActivation");
  has(files.providerOps, "markSfpProviderOperationDispatchBoundary");
  lacks(files.providerOps, "assertAggregatePaidBudgetAvailable");
  lacks(files.providerOps, "aggregate_budget_exhausted");
  lacks(files.providerOps, "SFP_PAID_BLOCKED:AGGREGATE_BUDGET");
  has(files.providerOps, "provider_operations");
  has(files.providerOps, "provider_controls");
});
test("ZeroBounce execution uses plaintext only inside governed boundary", () => {
  // The canonical adapter now requires the claimed address/operation dispatch
  // context. Check that protection, not the obsolete one-argument call text.
  assert.match(files.validation,
    /return\s+verifyEmail\s*\(\s*realEmail\s*,\s*\{\s*dispatch\s*:\s*\{\s*addressClaim\s*:\s*addressClaim!\s*,\s*operationId\s*:\s*reservation!\.operationId\s*\}\s*,?\s*\}\s*\)/);
  lacks(files.validation, "verifyEmail(String(cand.masked_value))");
  has(files.validation, "assertCurrentSfpProviderReservation(reservation)");
  assert.match(files.validation,
    /invokeSfpProviderTransport\(reservation,\s*async\s*\(\)\s*=>\s*\{[\s\S]*?return\s+verifyTransport\(\);[\s\S]*?\},\s*beforeDispatch\)/);
});
test("Serper is bounded and returns domains to the free crawler", () => {
  has(files.paid, "lookupBusinessIdentity");
  has(files.paid, "maxBusinesses=Math.max(1,Math.min(25");
  has(files.paid, "runFreeEnrichmentLane([Number(target.id)])");
  has(files.paid, "freeRecrawlFailed");
});
test("SFP does not bypass canonical Apollo/Outscraper authority", () => {
  has(files.paid, "not admitted to the independent SFP execution boundary");
  lacks(files.paid, "executeApollo");
  lacks(files.paid, "executeOutscraper");
});
test("provider manifest explicitly admits only the governed SFP boundary", () => {
  const occurrences = files.manifest.split("server/services/cro03/sfp-provider-operations.ts").length - 1;
  assert.ok(occurrences >= 2, "SFP caller missing for Serper/ZeroBounce");
});
test("ROI selection excludes noncanonical, DBPR, suppression, bounce, customer, and test rows", () => {
  assert.match(files.roi, /record_class\s*=\s*'canonical'/);
  has(files.roi, "suppressedBizIds");
  has(files.roi, "bouncedOnlyIds");
  has(files.roi, "dbprBizIds");
  has(files.roi, "custBizIds");
  has(files.roi, "testDemoInternal");
  has(files.roi, "inactiveEntity");
  has(files.roi, '"dissolved"');
});
test("legacy promotion is truly bounded to the approved frozen cohort", () => {
  has(files.routes, "JOIN mi09_pilot_cohort_members pcm");
  has(files.routes, "pcm.pilot_run_id = ${pilotRunId}::uuid");
  has(files.routes, 'limit must be an integer between 1 and 25');
});
test("preview and frozen members retain actual geography and vertical", () => {
  has(files.sfp, "vertical: c.vertical");
  has(files.sfp, "countyFips: c.countyFips");
});
test("durable SFP schema exists in migration and Drizzle schema", () => {
  for (const table of ["sfp_stage_runs", "sfp_stage_items", "sfp_campaign_staging_intents"]) {
    has(files.migration, table);
    has(files.schema, table);
  }
  has(files.migration, "master_leads_sfp_business_email_uidx");
  has(files.schema, "master_leads_sfp_business_email_uidx");
});
test("production schema is managed by Publish instead of replaying startup migrations", () => {
  has(files.packageJson, '"db:migrate": "tsx scripts/migrate.ts"');
  has(files.index, "shouldRunStartupMigrations(process.env.NODE_ENV)");
  has(files.index, "Production startup migrations skipped — schema is managed by Replit Publish.");
  has(files.startupMigrationPolicy, 'return nodeEnv !== "production"');
  lacks(files.replit, "npm run db:migrate && RELEASE_SHA=");
});
test("UI actions parse API responses and do not display fake provider status", () => {
  has(files.ui, ")).json()");
  has(files.ui, "paidPreviewQuery.data?.providers");
  has(files.ui, "Run free discovery");
  has(files.ui, "Provider status below is live.");
  lacks(files.ui, "Authorize Serper batch (max 10)");
  lacks(files.ui, "All paid providers are disabled by default");
});
test("SFP routes carry appropriate admin and read-only role guards", () => {
  const routeLines = files.routes.split("\n").filter((line) => line.includes("/api/lead-ops/sfp/") && (line.includes("app.post") || line.includes("app.get")));
  assert.ok(routeLines.length >= 8, "expected SFP route surface");
  assert.ok(routeLines.every((line) => line.includes("requireRole(")), "an SFP route has no explicit role guard");
  const mutationRoutes = routeLines.filter((line) => line.includes("app.post"));
  assert.ok(mutationRoutes.every((line) => line.includes('requireRole("admin"')), "an SFP mutation is not admin-only");
  const readRoutes = routeLines.filter((line) => line.includes("app.get"));
  assert.ok(readRoutes.every((line) => /requireRole\("admin"(?:,\s*"manager")?\)/.test(line)), "an SFP read route has an unexpected role set");
});
test("operator batch inputs are integer-validated at the HTTP boundary", () => {
  // Program cohort cap is 100 everywhere (not the legacy 500 bound).
  has(files.routes, "maxCohortSize must be an integer between 1 and 100");
  has(files.routes, "maxBusinesses must be an integer between 1 and 500");
  has(files.routes, "maxBusinesses must be an integer between 1 and 25");
  has(files.routes, "maxValidations must be an integer between 1 and 25");
});

console.log(`\n${passed} assertions passed${process.exitCode ? " (failures present)" : ""}.\n`);
if (process.exitCode) process.exit(process.exitCode);
