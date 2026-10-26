import assert from "node:assert/strict";
import { PREPARED_NATIVE_REVIEW } from "../server/data/ghl-prepared-native-review";
import { comparePreparedReview, type LiveReviewFacts } from "../server/services/ghl-prepared-review";

const p = PREPARED_NATIVE_REVIEW;
const fieldIds = [...new Set(p.allowedOperations.flatMap(op => op.customFieldIds))];
const live = (): LiveReviewFacts => ({
  locationId: p.locationId,
  inventoryRevision: p.inventoryRevision,
  customFieldInventoryRevision: p.customFieldInventoryRevision,
  scopeRulesRevision: p.scopeRulesRevision,
  workflows: p.workflowActionEvidence.map(e => ({
    id: e.workflowId, status: "draft", updatedAt: e.observedUpdatedAt, version: e.observedVersion, locationId: p.locationId,
  })),
  customFieldIds: fieldIds,
});

// Shape of the prepared package
assert.equal(p.workflowActionEvidence.length, 14);
assert.equal(new Set(p.workflowActionEvidence.map(e => e.workflowId)).size, 14);
assert.deepEqual(p.allowedOperations.map(op => `${op.method} ${op.path}`),
  ["POST /contacts", "PUT /contacts/:contactId", "POST /contacts/:contactId/tags", "DELETE /contacts/:contactId/tags"]);
for (const e of p.workflowActionEvidence) assert.match(e.definitionHash, /^[a-f0-9]{64}$/);
for (const h of [p.inventoryRevision, p.customFieldInventoryRevision, p.scopeRulesRevision]) assert.match(h, /^[a-f0-9]{64}$/);
for (const op of p.allowedOperations) {
  assert.ok(op.fields.length > 0 && op.purpose && op.safetyEvidence);
  if (op.customFieldIds.length) assert.ok(op.fields.includes("customFields"));
}
assert.ok(p.allowedOperations.every(op => !/opportunit|task|note|calendar|workflow/i.test(op.path)));

// Everything matches
assert.equal(comparePreparedReview(p, live()).allMatch, true);

// A moved workflow is reported, not substituted
const changed = live();
changed.workflows[3] = { ...changed.workflows[3], version: "99" };
changed.inventoryRevision = "f".repeat(64);
const c1 = comparePreparedReview(p, changed);
assert.equal(c1.allMatch, false);
assert.equal(c1.revisions.workflow, false);
assert.equal(c1.workflows.filter(w => !w.matches).length, 1);
assert.match(c1.workflows.find(w => !w.matches)!.changes.join(), /version/);

// A new live workflow with no evidence is a difference
const extra = live();
extra.workflows.push({ id: "new-workflow", status: "published", updatedAt: "2026-10-25T00:00:00.000Z", version: "1", locationId: p.locationId });
const c2 = comparePreparedReview(p, extra);
assert.equal(c2.allMatch, false);
assert.ok(c2.workflows.some(w => w.workflowId === "new-workflow" && !w.matches));

// A missing field id, scope change and location change are each reported
const fields = live();
fields.customFieldIds = fieldIds.slice(1);
fields.scopeRulesRevision = "e".repeat(64);
fields.locationId = "other";
const c3 = comparePreparedReview(p, fields);
assert.equal(c3.missingCustomFieldIds.length, 1);
assert.equal(c3.revisions.scopeRules, false);
assert.equal(c3.revisions.location, false);

console.log("ghl-prepared-review: all checks passed");
