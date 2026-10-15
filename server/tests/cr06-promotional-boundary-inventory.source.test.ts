import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const walkTs = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? walkTs(path.join(dir, entry.name))
    : entry.isFile() && entry.name.endsWith(".ts")
      ? [path.join(dir, entry.name)]
      : []);

const authority = read("server/services/cr06-promotional-lifecycle-decision.ts");
assert.match(authority, /CR06_PROMOTIONAL_EXECUTION_DISABLED/);
assert.match(authority, /purpose\?: Cr06CommunicationPurpose/);
assert.match(authority, /purpose === "transactional" \|\| purpose === "human_response"/);

const boundaries: Record<string, readonly string[]> = {
  "server/services/promotional-enrollment-eligibility.ts": ["promotional_enrollment"],
  "server/services/campaign-engine.ts": ["campaign_queue", "campaign_claim", "campaign_transport"],
  "server/services/sequence-worker.ts": ["sequence_enrollment", "sequence_claim", "sequence_transport"],
  "server/services/bulk-enrollment-job.ts": ["bulk_enrollment"],
  "server/services/new-lead-enrollment-job.ts": ["new_lead_enrollment"],
  "server/services/workflow-executor.ts": ["workflow_enrollment"],
  "server/services/queue-manager.ts": ["queue_runner"],
  "server/services/sequence-enrollment-recovery.ts": ["legacy_release"],
};

for (const [file, requiredBoundaries] of Object.entries(boundaries)) {
  const source = read(file);
  assert.match(source, /cr06-promotional-lifecycle-decision/);
  for (const boundary of requiredBoundaries) {
    assert.match(
      source,
      new RegExp(`boundary:\\s*"${boundary}"|decideCr06SequenceLifecycle\\([^)]*,\\s*"${boundary}"\\)`),
      `${file} lacks CR-06 ${boundary} boundary`,
    );
  }
}

// Exhaustive inventory of production writers that create an active sequence
// enrollment. New direct storage, Drizzle, or raw-SQL writers fail this test
// until they are explicitly reviewed and added here.
const enrollmentMutationCounts: Record<string, number> = {
  "server/routes/activity.ts": 1,
  "server/routes/campaigns.ts": 2,
  "server/routes/contacts.ts": 1,
  "server/routes/deals.ts": 1,
  "server/routes/wizard.ts": 1,
  "server/services/abandoned-statement-worker.ts": 1,
  "server/services/bulk-enrollment-job.ts": 1,
  "server/services/canonical-recipient-preparation.ts": 1,
  "server/services/churn-score.ts": 1,
  "server/services/cro03/sfp-enrollment-bridge.ts": 1,
  "server/services/merchant-attrition-monitor.ts": 1,
  "server/services/merchant-success-sequences.ts": 1,
  "server/services/merchant-welcome.ts": 1,
  "server/services/new-lead-enrollment-job.ts": 2,
  "server/services/onboarding-reminder.ts": 1,
  "server/services/post-enrichment-worker.ts": 1,
  "server/services/sdr/voice-orchestrator.ts": 1,
  "server/services/sequence-worker.ts": 1,
  "server/services/smart-router.ts": 1,
  "server/services/statement-acquisition.ts": 1,
  "server/services/vas-upsell.ts": 1,
  "server/services/workflow-executor.ts": 1,
};
// The canonical preparation writer deliberately creates paused membership
// only. Include it in the exhaustive census without treating held staging as
// active promotional execution or reintroducing an activation gate.
const preparation = read("server/services/canonical-recipient-preparation.ts");
assert.match(preparation,
  /INSERT INTO sequence_enrollments[\s\S]*?VALUES \([\s\S]*?'paused',0,NULL,NOW\(\)/);
assert.match(preparation, /outboundAuthorized:\s*false/);
assert.match(preparation, /member\.status !== "paused"/);
assert.doesNotMatch(preparation, /SET\s+status\s*=\s*'active'/i);
const enrollmentMutationInventory = Object.keys(enrollmentMutationCounts).sort();

const mutationPattern =
  /^(?!\s*(?:\/\/|\*))(?:(?=[^\n]*\bstorage\.createSequenceEnrollment\s*\()[^\n]*|(?=[^\n]*\b(?:db|tx)\.insert\s*\(\s*sequenceEnrollments(?:Table)?\s*\))[^\n]*|(?=[^\n]*INSERT\s+INTO\s+sequence_enrollments)[^\n]*)/gim;
const discoveredMutations = [
  ...walkTs("server/routes"),
  ...walkTs("server/services"),
].filter(file => {
  mutationPattern.lastIndex = 0;
  return mutationPattern.test(read(file));
}).sort();

assert.deepEqual(
  discoveredMutations,
  enrollmentMutationInventory,
  "CR-06 active enrollment writer inventory changed; classify and fence every new boundary before updating this reviewed inventory",
);

for (const file of enrollmentMutationInventory) {
  const source = read(file);
  mutationPattern.lastIndex = 0;
  assert.equal(
    [...source.matchAll(mutationPattern)].length,
    enrollmentMutationCounts[file],
    `${file} enrollment mutation callsite count changed; every callsite requires a separate boundary review`,
  );
  if (file === "server/services/canonical-recipient-preparation.ts") {
    // This writer has the separately asserted paused-only contract above.
    // It cannot authorize execution; central lifecycle decisions remain
    // mandatory on every active writer and on all release/unpause paths.
    continue;
  }
  assert.match(source, /cr06-promotional-lifecycle-decision/, `${file} does not import the central CR-06 decision`);
  assert.match(
    source,
    /decideCr06(?:SequenceLifecycle|PromotionalLifecycle)\s*\(/,
    `${file} does not invoke the central CR-06 lifecycle decision`,
  );
  assert.match(
    source,
    /classifyCr06SequencePurpose\s*\(|decideCr06SequenceLifecycle\s*\(/,
    `${file} does not classify persisted sequence purpose`,
  );
}

// Active release/unpause paths are separately inventoried because they do not
// insert a row but can make an existing enrollment executable again.
const releaseMutationInventory = [
  "server/routes/sdr.ts",
  "server/services/sequence-enrollment-recovery.ts",
];
for (const file of releaseMutationInventory) {
  const source = read(file);
  assert.match(source, /cr06-promotional-lifecycle-decision/);
  assert.match(source, /boundary:\s*"legacy_release"|decideCr06SequenceLifecycle\([^)]*,\s*"legacy_release"\)/);
}

console.log("CR-06 promotional lifecycle boundary inventory passed");