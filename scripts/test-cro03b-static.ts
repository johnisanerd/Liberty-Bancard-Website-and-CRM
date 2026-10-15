import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CRO03B_UNIFIED_RECIPE, CRO03_BOUNDED_CRAWL_POLICY, isCro03BoundedCrawlTarget,
} from "../server/services/cro03/recipe-contract";
import { stableCro03RecipeHash } from "../server/services/cro03/contracts";
import { SafeEgress } from "../server/services/cro03/safe-egress";

let checks = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    checks++;
    console.log(`PASS ${name}`);
  });
}

async function main() {
  const migration = fs.readFileSync("migrations/0188_cro03b_unified_recipe.sql", "utf8");
  const admission = fs.readFileSync("server/services/cro03/admission-service.ts", "utf8");
  const projection = fs.readFileSync("server/services/cro03/projection-service.ts", "utf8");
  const readiness = fs.readFileSync("server/services/provider-readiness-control.ts", "utf8");
  const writer = fs.readFileSync("server/services/contact-writer.ts", "utf8");
  const routes = fs.readFileSync("server/routes/cro03.ts", "utf8");
  const queue = fs.readFileSync("server/services/queue-manager.ts", "utf8");
  const factory = fs.readFileSync("server/services/cro03/enrichment-factory.ts", "utf8");

  await check("unified recipe is immutable and hashable", () => {
    assert.ok(Object.isFrozen(CRO03B_UNIFIED_RECIPE));
    assert.match(stableCro03RecipeHash(CRO03B_UNIFIED_RECIPE), /^[0-9a-f]{64}$/);
    assert.equal(CRO03B_UNIFIED_RECIPE.steps.length, 11);
  });
  await check("each stage freezes exactly one execution and accounting owner", () => {
    for (const step of CRO03B_UNIFIED_RECIPE.steps) {
      assert.ok(step.executionOwner);
      assert.ok(step.accountingOwner);
      assert.ok(step.maxAttempts >= 1);
      assert.ok(step.evidenceTtlSeconds >= 1);
      assert.deepEqual(Object.keys(step.transitions).sort(), ["conflict", "no_result", "retryable_failure", "success"]);
    }
    const serper = CRO03B_UNIFIED_RECIPE.steps.find((step) => step.id === "serper")!;
    assert.equal(serper.executionOwner, "serper_gateway");
    assert.equal(serper.accountingOwner, "serper_gateway");
    const finalization = CRO03B_UNIFIED_RECIPE.steps.find((step) => step.id === "finalization")!;
    assert.equal(finalization.accountingOwner, "validation_worker");
  });
  await check("crawl is same-site and explicitly bounded", () => {
    assert.equal(CRO03_BOUNDED_CRAWL_POLICY.maxPages, 5);
    assert.equal(CRO03_BOUNDED_CRAWL_POLICY.maxRedirects, 3);
    assert.equal(CRO03_BOUNDED_CRAWL_POLICY.maxBytesPerPage, 512 * 1024);
    assert.equal(isCro03BoundedCrawlTarget("https://www.example.com", "https://example.com/contact"), true);
    assert.equal(isCro03BoundedCrawlTarget("https://example.com", "https://evil.test/contact"), false);
    assert.equal(isCro03BoundedCrawlTarget("https://example.com", "https://example.com/file.pdf"), false);
    assert.deepEqual(CRO03_BOUNDED_CRAWL_POLICY.rdap.outputFields, ["domain_registrant", "registry_id", "entity_status"]);
  });
  await check("SafeEgress is denied by default and pins each hop", async () => {
    await assert.rejects(new SafeEgress().get({
      url: "https://example.com", purpose: "crawl", callSite: "cro03b",
    }), /CRO03_EGRESS_TRANSPORT_DENIED/);
    let pins: readonly string[] = [];
    const egress = new SafeEgress(
      async (_url, _init, binding) => {
        pins = binding.pinnedAddresses;
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      },
      async () => ["93.184.216.34"],
    );
    await egress.get({ url: "https://example.com", purpose: "crawl", callSite: "cro03b" });
    assert.deepEqual(pins, ["93.184.216.34"]);
  });
  await check("migration is additive after 0187 and constrains provenance", () => {
    assert.match(migration, /timestamp_provenance IN \('source','import','ingestion_only'\)/);
    assert.match(migration, /cro03a_census_cursors/);
    assert.match(migration, /cro03b_recipe_commands/);
    assert.match(migration, /cro03b_projection_receipts/);
    assert.match(migration, /cro03b_finalization_receipts/);
    assert.doesNotMatch(migration, /\b(?:DROP TABLE|TRUNCATE)\b/i);
  });
  await check("atomic admission locks handoffs and derives ownership", () => {
    assert.match(admission, /FOR UPDATE OF h/);
    assert.match(admission, /owner_actor_id/);
    assert.match(admission, /CRO03B_MAX_HANDOFFS_PER_COMMAND = 250/);
    assert.match(admission, /cro03b_recipe_receipts/);
    assert.match(admission, /cro03a_consumption_receipts/);
    assert.doesNotMatch(admission, /consumerKey:\s*string/);
  });
  await check("queue owns CRO-03A recovery and CRO-03B processing", () => {
    assert.match(queue, /CRO03A_QUALIFICATION/);
    assert.match(queue, /recoverCro03aQualificationRunsQueueSafe/);
    assert.match(queue, /processNextCro03bRecipeItem/);
  });
  await check("intermediate projection suppresses every generic hook", () => {
    for (const flag of ["deferValidation", "deferReadiness", "deferLeadScoring", "suppressProviderProjection"]) {
      assert.match(writer, new RegExp(flag));
      assert.match(projection, new RegExp(`${flag}: true`));
    }
    assert.match(projection, /mode: "local_only"/);
    assert.match(projection, /CRO03B_CONTACT_MUST_BEGIN_UNLINKED/);
    assert.match(projection, /decideContactBusinessLink/);
  });
  await check("finalization creates one winning-email intent and defers scoring", () => {
    assert.match(projection, /purpose: "cro03_winning_email"/);
    assert.match(projection, /purpose='marketing_outreach'/);
    assert.match(projection, /cro03b_finalization_receipts/);
    assert.ok(projection.indexOf("enqueueValidationIntent") < projection.indexOf("requestContactLeadScoring"));
    assert.match(projection, /subject_generation.*email_mutation_generation/s);
    assert.match(readiness, /currentCanonicalValidationSelection/);
    assert.match(readiness, /claimCanonicalAddressValidation/);
    assert.match(readiness, /if \(!state\?\.enabled \|\| state\.circuit_state !== "closed"\)/);
    assert.match(readiness, /await markCanonicalAddressDispatch\(addressOwner,String\(operationId\),tx\)/);
    assert.doesNotMatch(projection, /suppressValidationEnqueue/);
  });
  await check("arbitration persists reproducibility and review outcomes", () => {
    assert.match(factory, /candidateSetHash/);
    assert.match(factory, /confidence_threshold/);
    assert.match(factory, /minimum_margin/);
    assert.match(factory, /high_authority_conflict/);
    assert.match(factory, /review_required/);
  });
  await check("authorization DTO rejects authority fields and caps commands", () => {
    assert.match(routes, /cro03bCommandSchema = z\.object/);
    assert.match(routes, /\.strict\(\)/);
    assert.match(routes, /requireRole\("admin", "manager"\)/);
    assert.match(routes, /requireRole\("admin"\)/);
    for (const forbidden of ["confidence", "recipeHash", "operationId", "sourceAuthority", "cost"]) {
      assert.doesNotMatch(routes.match(/const cro03bCommandSchema[\s\S]*?\.strict\(\);/)?.[0] ?? "", new RegExp(forbidden));
    }
  });
  await check("provider and outbound effects remain denied", () => {
    assert.match(factory, /CRO03_PROVIDER_TRANSPORT_ENABLED = false as const/);
    assert.doesNotMatch(`${admission}\n${projection}`, /\b(?:sendEmail|sendSms|applyPauseMutation|createSequenceEnrollment|createCampaign)\s*\(/);
    assert.doesNotMatch(projection, /contactProviderProjections/);
  });
  await check("legacy fencing is scoped and durable", () => {
    assert.match(admission, /isCro03bRecipeSubjectActive/);
    assert.match(admission, /cro03b_legacy_writer_fences/);
    assert.match(admission, /evidence_submitted.*skipped/s);
    assert.match(writer, /assertCro03bLegacySourceWriteAllowed/);
    assert.match(writer, /assertCro03bLegacyContactWriteAllowed/);
  });

  console.log(`\nCRO-03B static certification passed: ${checks} checks`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});