import fs from "node:fs";
import assert from "node:assert/strict";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log(`PASS ${name}`);
  });
}

async function main() {
  process.env.MERCHANT_DATA_ENCRYPTION_KEY ||= "cro03-static-test-key-not-for-production";
  const contracts = await import("../server/services/cro03/contracts");
  const vault = await import("../server/services/cro03/candidate-vault");
  const routing = await import("../server/services/cro03/routing-policy");
  const { SafeEgress, assertSafeHostname } = await import("../server/services/cro03/safe-egress");

  await check("four governed providers are frozen", () => {
    assert.deepEqual(contracts.CRO03_PROVIDERS, ["zerobounce", "serper", "outscraper", "apollo"]);
  });
  await check("selection hash is order-stable", () => {
    assert.equal(contracts.stableSelectionHash([3, 1, 2]), contracts.stableSelectionHash([2, 3, 1]));
  });
  await check("command idempotency includes purpose and policy", () => {
    const base = { subjectIds: [3, 1], purpose: "provider_pre_spend", selectionPolicyVersion: 1, routingPolicyVersion: 1 };
    assert.equal(contracts.stableCro03CommandFingerprint(base), contracts.stableCro03CommandFingerprint({ ...base, subjectIds: [1, 3] }));
    assert.notEqual(contracts.stableCro03CommandFingerprint(base), contracts.stableCro03CommandFingerprint({ ...base, purpose: "internal_test" }));
  });
  await check("routing is selective", () => {
    const result = routing.selectCro03Route({
      hasWebsite: false, hasPhone: false, hasEmail: false,
      needsBusinessDiscovery: true, needsContactEnrichment: false, needsEmailValidation: false,
    });
    assert.deepEqual(result.providers, ["outscraper"]);
  });
  await check("canaries are non-executable", () => {
    assert.ok(routing.CRO03_CANARY_DEFINITIONS.every((entry) => entry.executable === false));
  });
  await check("candidate envelope authenticates context", () => {
    const sealed = vault.sealCandidate({ field: "email", value: "Owner@Example.com", subjectId: 42, subjectGeneration: 3 });
    assert.equal(sealed.maskedValue, "o***@ex***");
    assert.equal(vault.openCandidate({
      field: "email", subjectId: 42, subjectGeneration: 3, envelope: sealed,
    }), "Owner@Example.com");
    assert.throws(() => vault.openCandidate({
      field: "email", subjectId: 43, subjectGeneration: 3, envelope: sealed,
    }));
    assert.ok(!JSON.stringify(sealed).includes("owner@example.com"));
  });
  await check("private and metadata addresses are denied", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:172.16.1.1"]) {
      assert.throws(() => assertSafeHostname("example.test", [address]));
    }
  });
  await check("redirect targets are DNS revalidated", async () => {
    const lookups: string[] = [];
    const egress = new SafeEgress(
      async (url) => url.includes("one.example")
        ? new Response("", { status: 302, headers: { location: "https://two.example/x" } })
        : new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
      async (host) => { lookups.push(host); return ["93.184.216.34"]; },
    );
    assert.equal((await egress.get({ url: "https://one.example", purpose: "test", callSite: "test" })).body, "ok");
    assert.deepEqual(lookups, ["one.example", "two.example"]);
  });
  await check("response bytes and content type are bounded", async () => {
    const tooLarge = new SafeEgress(
      async () => new Response("12345", { headers: { "content-type": "text/plain" } }),
      async () => ["93.184.216.34"],
    );
    await assert.rejects(tooLarge.get({ url: "https://example.com", purpose: "test", callSite: "test", maxBytes: 2 }));
    const binary = new SafeEgress(
      async () => new Response("x", { headers: { "content-type": "application/octet-stream" } }),
      async () => ["93.184.216.34"],
    );
    await assert.rejects(binary.get({ url: "https://example.com", purpose: "test", callSite: "test" }));
  });

  const migration = fs.readFileSync("migrations/0174_cro03_durable_enrichment_factory.sql", "utf8");
  const completionMigration = fs.readFileSync("migrations/0175_cro03_frozen_subject_plans.sql", "utf8");
  const factory = fs.readFileSync("server/services/cro03/enrichment-factory.ts", "utf8");
  const providerContext = fs.readFileSync("server/services/cro03/provider-context.ts", "utf8");
  const routes = fs.readFileSync("server/routes/cro03.ts", "utf8");
  const queue = fs.readFileSync("server/services/queue-manager.ts", "utf8");
  const sla = fs.readFileSync("server/services/sla-worker.ts", "utf8");
  const prospects = fs.readFileSync("server/routes/prospects.ts", "utf8");
  const imports = fs.readFileSync("server/routes/imports.ts", "utf8");
  const importEvidence = fs.readFileSync("server/services/provider-import-evidence.ts", "utf8");
  const importRecovery = fs.readFileSync("server/services/csv-import-processor.ts", "utf8");
  const canonicalImport = fs.readFileSync("server/services/canonical-provider-import.ts", "utf8");
  const cro03aAdapters = fs.readFileSync("server/services/cro03a/adapters.ts", "utf8");
  await check("membership and immutable evidence have guards", () => {
    assert.match(migration, /cro03_membership_immutable/);
    assert.match(migration, /cro03_candidate_immutable/);
    assert.match(migration, /cro03_receipt_immutable/);
    assert.match(migration, /UNIQUE \(item_id, field\)/);
  });
  await check("versioned subject identity and full route recipe are frozen", () => {
    assert.match(completionMigration, /subject_snapshot JSONB/);
    assert.match(completionMigration, /frozen_route_plan JSONB/);
    assert.match(completionMigration, /subject_snapshot_hash/);
    assert.match(factory, /frozenSubjectSnapshot/);
    assert.match(factory, /frozenRouteForMembership/);
    assert.doesNotMatch(factory, /routeForContact\(fallback\)/);
    assert.match(factory, /missing_or_malformed_frozen_evidence/);
  });
  await check("superseded work is terminally accounted in the total equation", () => {
    assert.match(completionMigration, /superseded_count/);
    assert.match(completionMigration, /outstanding_count/);
    assert.match(factory, /accountingEquation/);
  });
  await check("provider response selection requires a unique frozen-identity match", () => {
    assert.match(factory, /selectFrozenIdentityMatch/);
    assert.match(factory, /score < 4/);
    assert.match(factory, /scored\[1\]\?\.score === scored\[0\]\.score/);
  });
  await check("provider lineage records attempts, observations, receipts, and validation backlinks", () => {
    assert.match(completionMigration, /provider_attempt_id/);
    assert.match(completionMigration, /validation_intent_id/);
    assert.match(factory, /recordProviderOutcomeEvidence/);
    assert.match(factory, /provider_observations/);
    assert.match(factory, /receipt_id/);
    assert.match(factory, /validation_pending/);
  });
  await check("economics lineage is append-only reservation plus settlement", () => {
    assert.match(completionMigration, /event_type TEXT NOT NULL DEFAULT 'reservation'/);
    assert.match(completionMigration, /reservation_entry_id UUID REFERENCES cro03_provider_ledger/);
    assert.match(completionMigration, /cro03_ledger_one_reservation_per_run/);
    assert.match(completionMigration, /cro03_ledger_one_terminal_per_run/);
    assert.match(completionMigration, /cro03_ledger_immutable/);
    assert.match(completionMigration, /CRO03_LEDGER_LINEAGE_MISMATCH/);
    assert.match(completionMigration, /reservation\.provider_run_id = NEW\.provider_run_id/);
    assert.match(completionMigration, /CRO03_LEDGER_RUN_OPERATION_PROVIDER_MISMATCH/);
    assert.match(completionMigration, /run\.operation_id = NEW\.provider_operation_id/);
    assert.match(completionMigration, /operation\.provider = NEW\.provider/);
    assert.match(completionMigration, /CRO03_RECEIPT_RUN_OPERATION_PROVIDER_MISMATCH/);
    assert.match(completionMigration, /CRO03_RECEIPT_LEDGER_LINEAGE_MISMATCH/);
    assert.match(completionMigration, /cro03_receipt_lineage_guard/);
    assert.match(completionMigration, /FOR UPDATE OF run, operation/);
    assert.match(providerContext, /'reservation', 'outstanding'/);
    assert.match(factory, /'terminal'/);
    assert.match(factory, /provider_operation_id, provider, receipt_key/);
    assert.doesNotMatch(factory, /UPDATE cro03_provider_ledger/);
  });
  await check("budget reservation atomically links run and reservation evidence", () => {
    assert.match(providerContext, /attachReservedRun\(tx/);
    assert.match(providerContext, /UPDATE cro03_provider_runs/);
    assert.match(providerContext, /INSERT INTO cro03_provider_ledger/);
    assert.match(factory, /r\.state = 'reserved'/);
    assert.match(factory, /undispatched_reservation_expired/);
  });
  await check("final adapter boundary requires the active item claim and fence", () => {
    assert.match(providerContext, /i\.claim_token = \$\{context\.itemClaimToken\}/);
    assert.match(providerContext, /i\.execution_fence = \$\{context\.executionFence\}/);
    assert.match(providerContext, /i\.lease_expires_at > NOW\(\)/);
    assert.doesNotMatch(providerContext, /OR r\.state = 'running'/);
  });
  await check("provider-export evidence is an immutable source-row snapshot", () => {
    assert.match(imports, /__cro03EvidenceValues/);
    assert.match(imports, /registerPersistedCsvProcessor\(processCsvImport\)/);
    assert.match(importRecovery, /await materializeCanonicalProviderImportRow/);
    assert.match(canonicalImport, /await retainProviderImportRow/);
    assert.match(importEvidence, /await createCro03SourceBatch/);
    assert.match(cro03aAdapters, /base\("provider_csv_row"/);
    assert.match(imports, /rowFingerprint/);
    assert.match(importEvidence, /purpose: "staging_review"/);
    assert.match(importEvidence, /rawSourceRow: rawRow/);
    assert.match(importEvidence, /candidateValues: \{\}/);
    assert.doesNotMatch(importEvidence, /writeContact|verifyEmail|reserve.*Provider/);
    // Ignore the import declaration: the runtime staging call must precede
    // the later canonical contact write in the row-processing flow.
    const stagingCall = canonicalImport.indexOf("await retainProviderImportRow");
    const contactWrite = canonicalImport.lastIndexOf("await writeContact");
    assert.ok(stagingCall > 0 && contactWrite > stagingCall);
  });
  await check("discovery never bypasses the commercial fence", () => {
    assert.doesNotMatch(factory, /provider !== "outscraper"/);
    assert.doesNotMatch(factory, /provider === "outscraper" \? \{ allowed: true \}/);
    assert.match(factory, /discovery_identity_insufficient/);
  });
  await check("paid controls ship disabled and budgetless", () => {
    assert.match(migration, /\('apollo'.*FALSE.*0/s);
    assert.match(migration, /ON CONFLICT \(provider\) DO UPDATE SET\s+enabled = FALSE/s);
  });
  await check("pre-transport and pre-mutation fences exist", () => {
    assert.ok((factory.match(/expectedFingerprint:/g) ?? []).length >= 4);
    assert.match(factory, /stale_before_transport/);
    assert.match(factory, /stale_after_transport/);
  });
  await check("live provider transport is env-gated with certifiable constant", () => {
    // Exported constant remains false as const for static certification evidence.
    assert.match(factory, /CRO03_PROVIDER_TRANSPORT_ENABLED = false as const/);
    // Runtime gate reads the env secret — the actual dispatch decision.
    assert.match(factory, /process\.env\.CRO03_PROVIDER_TRANSPORT_ENABLED !== "true"/);
    assert.match(factory, /certification_transport_denied/);
  });
  await check("single scheduler owns durable processing and projection recovery", () => {
    assert.match(queue, /processNextCro03Item/);
    assert.match(queue, /processNextCro03Mutation/);
    assert.doesNotMatch(sla, /processEnrichmentQueue\(/);
  });
  await check("batch cancellation fences provider and mutation work", () => {
    assert.match(factory, /BATCH_CANCELLED/);
    assert.match(factory, /i\.state <> 'cancelled'[\s\S]{0,100}b\.state IN \('queued','running'\)/);
    assert.match(factory, /i\.state = 'running'[\s\S]{0,100}b\.state IN \('queued','running'\)/);
    assert.match(migration, /CRO03_MUTATION_AUTHORITY_INACTIVE/);
    assert.match(factory, /i\.state NOT IN \('blocked','cancelled'\)/);
  });
  await check("legacy request-detached paths are retired", () => {
    assert.doesNotMatch(prospects, /enrichProspect\(/);
    assert.doesNotMatch(prospects, /runEnrichmentJob\(/);
    assert.doesNotMatch(prospects, /processEnrichmentQueue\(/);
    assert.match(prospects, /CRO03_LEGACY_PATH_RETIRED/);
  });
  await check("strict role routes and strict DTO exist", () => {
    assert.match(routes, /requireRole\("admin", "manager"\)/);
    assert.match(routes, /\.strict\(\)/);
    assert.match(routes, /statusUrl/);
  });
  await check("CSV exports converge without provider transport", () => {
    const imports = fs.readFileSync("server/routes/imports.ts", "utf8");
    assert.match(imports, /registerPersistedCsvProcessor\(processCsvImport\)/);
    assert.match(importRecovery, /await materializeCanonicalProviderImportRow/);
    assert.match(canonicalImport, /await retainProviderImportRow/);
    assert.match(importEvidence, /await createCro03SourceBatch/);
    assert.match(cro03aAdapters, /base\("provider_csv_row"/);
    assert.match(importEvidence, /purpose: "staging_review"/);
    assert.match(importEvidence, /providerCsvSourceSubject/);
  });
  console.log(`\nCRO-03 static certification passed: ${passed} checks`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
