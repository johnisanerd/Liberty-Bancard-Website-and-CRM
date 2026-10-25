import assert from "node:assert/strict";
import { classifyGhlOperation } from "../server/services/ghl-capability-policy";
import { effectiveGhlScopeRules, hashGhlScopeRules } from "../server/services/ghl-scope-rules";
import {
  describeChangedFacts,
  evaluateGhlCapabilityPolicy,
  isApprovedReview,
  sealGhlApprovedReview,
  hashGhlCustomFieldInventory,
  hashNativeWorkflowInventory,
  isGhlCrmDecisionCurrent,
  isGhlRuntimeWriteSelected,
  type GhlSyncControl,
  type NativeWorkflowEvidence,
} from "../server/services/ghl-sync-control";

const now = Date.now();
const workflows: NativeWorkflowEvidence[] = [{
  locationId: "loc-1", id: "workflow-1", status: "published",
  updatedAt: "2025-01-01T00:00:00.000Z", version: "4",
}];
const revision = hashNativeWorkflowInventory(workflows);
const scopeRules = effectiveGhlScopeRules({});
const scopeRev = hashGhlScopeRules(scopeRules);
const fm: Array<{ id: string; key: string; dataType?: string }> = [];
const reviewedAtMs = now - 60_000;
const control: GhlSyncControl = {
  enabled: true,
  permissionsEnabled: true,
  epoch: 8,
  ownerProfile: null,
  selectedRuntime: "test",
  nativeReview: {
    state: "unverified",
    reviewedAt: null,
    evidenceReference: "admin-review-ticket-42",
    locationId: "loc-1",
    inventoryRevision: revision,
    workflows,
    workflowActionEvidence: [{
      workflowId: "workflow-1", disposition: "reviewed_safe", evidenceReference: "workflow-inspection-42",
      observedUpdatedAt: workflows[0].updatedAt, observedVersion: workflows[0].version,
      definitionHash: "a".repeat(64), changeMetadata: "reviewed workflow CHANGE metadata ticket 42",
    }],
    allowedOperations: [{
      method: "POST",
      path: "/contacts",
      fields: ["firstName", "lastName", "email"],
      tags: ["reviewed-tag"],
      stageIds: [],
      safetyEvidence: "contact-create-inspection-42",
      purpose: "Create contact identity fields only",
      customFieldIds: [],
    }],
    customFields: [],
    customFieldInventoryRevision: hashGhlCustomFieldInventory([]),
  },
};
control.nativeReview = sealGhlApprovedReview(control.nativeReview, {
  reviewerId: "owner-1", reviewedAt: new Date(reviewedAtMs), scopeRules,
});

assert.equal(classifyGhlOperation("GET", "/contacts"), "crm_read");
const readOnlyControl: GhlSyncControl = {
  ...control, enabled: false, permissionsEnabled: false,
  nativeReview: { ...control.nativeReview, state: "unverified" },
};
assert.equal(evaluateGhlCapabilityPolicy({
  method: "GET", path: "/contacts/search/duplicate?locationId=loc-1&email=fixture%40example.test",
  locationId: "loc-1",
}, readOnlyControl).allowed, true);
assert.equal(evaluateGhlCapabilityPolicy({
  method: "POST", path: "/contacts", body: { email: "fixture@example.test" }, locationId: "loc-1",
}, readOnlyControl).allowed, false);
assert.equal(classifyGhlOperation("POST", "/contacts/search", { query: "x" }), "crm_read");
assert.equal(classifyGhlOperation("POST", "/contacts/trigger/search", {}), "unknown");
assert.equal(classifyGhlOperation("POST", "/opportunities/search", { query: "x" }), "crm_read");
assert.equal(classifyGhlOperation("POST", "/contacts/c-1/search", { query: "x" }), "unknown");
assert.equal(classifyGhlOperation("GET", "/locations/loc-1/email-settings"), "diagnostic_read");
assert.equal(classifyGhlOperation("GET", "/locations/loc-1"), "diagnostic_read");
assert.equal(classifyGhlOperation("GET", "/workflows/?locationId=loc-1"), "diagnostic_read");
assert.equal(classifyGhlOperation("PATCH", "/contacts/c-1", { lb_sms_allowed: true }), "permission_write");
assert.equal(classifyGhlOperation("PUT", "/contacts/c-1", {
  customFields: [{ id: "cf-1", key: "lb_can_sms", field_value: "true" }],
}), "permission_write");
assert.equal(classifyGhlOperation("PUT", "/contacts/c-1", { firstName: "A", lb_sms_allowed: true }), "crm_write");
assert.equal(classifyGhlOperation("PUT", "/contacts/c-1", {
  firstName: "A", customFields: [{ id: "cf-1", key: "lb_can_sms", field_value: "true" }],
}), "crm_write");
assert.equal(classifyGhlOperation("POST", "/conversations/messages", { message: "hi" }), "communication");
assert.equal(classifyGhlOperation("PATCH", "/unknown/provider-resource", {}), "unknown");
assert.equal(evaluateGhlCapabilityPolicy(
  { method: "GET", path: "/contacts", locationId: "loc-1" },
  { ...control, enabled: false, permissionsEnabled: false }, undefined, now,
).allowed, true);
assert.equal(evaluateGhlCapabilityPolicy(
  { method: "POST", path: "/contacts/search", body: { query: "x" }, locationId: "loc-1" },
  { ...control, enabled: false, permissionsEnabled: false }, undefined, now,
).allowed, true);

const contactCreate = { method: "POST", path: "/contacts", locationId: "loc-1", body: { firstName: "A", email: "a@example.test" } };
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, control, revision, now, fm, scopeRev).allowed, true);
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, { ...control, enabled: false }, revision, now, fm, scopeRev).reasonCode, "control_disabled");
assert.equal(evaluateGhlCapabilityPolicy({
  ...contactCreate,
  body: { firstName: "A", lb_sms_allowed: true },
}, { ...control, enabled: false, permissionsEnabled: true }, revision, now, fm, scopeRev).reasonCode, "control_disabled");
assert.equal(evaluateGhlCapabilityPolicy({
  ...contactCreate,
  body: { firstName: "A", lb_sms_allowed: true },
}, { ...control, enabled: true, permissionsEnabled: false }, revision, now, fm, scopeRev).reasonCode, "permissions_disabled");
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, {
  ...control, nativeReview: { ...control.nativeReview, state: "unverified" },
}, revision, now, fm, scopeRev).reasonCode, "native_review_unverified");
// Persistent approval: no calendar expiry. Usable at 25 hours and 7 days without any renewal.
for (const elapsed of [25 * 3600_000, 7 * 24 * 3600_000, 90 * 24 * 3600_000]) {
  assert.equal(evaluateGhlCapabilityPolicy(contactCreate, control, revision, now + elapsed, fm, scopeRev).allowed, true,
    `approval remains usable after ${elapsed} ms`);
}
// Legacy / other-contract, tampered, revoked and unsealed reviews carry no authority.
assert.equal(isApprovedReview({ ...control.nativeReview, contractVersion: 1 }), false);
assert.equal(isApprovedReview({ ...control.nativeReview, contractVersion: undefined }), false);
assert.equal(isApprovedReview({ ...control.nativeReview, reviewerId: "someone-else" }), false, "reviewer is bound");
assert.equal(isApprovedReview({ ...control.nativeReview, allowedOperations: [{ ...control.nativeReview.allowedOperations[0], tags: ["extra-tag"] }] }), false, "tag allow-list is bound");
assert.equal(isApprovedReview({ ...control.nativeReview, allowedOperations: [{ ...control.nativeReview.allowedOperations[0], fields: ["firstName", "lastName", "email", "phone"] }] }), false, "field allow-list is bound");
assert.equal(isApprovedReview({ ...control.nativeReview, locationId: "loc-2" }), false, "location is bound");
assert.equal(isApprovedReview({ ...control.nativeReview, scopeRules: { ...scopeRules, sourceLessLegacy: false } }), false, "scope rules are bound");
assert.equal(isApprovedReview({ ...control.nativeReview, evidenceReference: "different-evidence-ref" }), false, "evidence reference is bound");
assert.equal(isApprovedReview({ ...control.nativeReview, revokedAt: new Date(now).toISOString() }), false);
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, {
  ...control, nativeReview: { ...control.nativeReview, state: "revoked", revokedAt: new Date(now).toISOString() },
}, revision, now, fm, scopeRev).reasonCode, "native_review_revoked");
// Unavailable evidence is a hold; changed evidence is a block; each is distinguishable.
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, control, undefined, now, fm, scopeRev).reasonCode, "native_inventory_unavailable");
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, control, revision, now, undefined, scopeRev).reasonCode, "custom_field_inventory_unavailable");
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, control, revision, now, fm, undefined).reasonCode, "scope_rules_unavailable");
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, control, "changed-revision", now, fm, scopeRev).reasonCode, "native_inventory_changed");
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, control, revision, now, [{ id: "cf-new", key: "new_field" }], scopeRev).reasonCode, "custom_field_inventory_changed");
assert.equal(evaluateGhlCapabilityPolicy(contactCreate, control, revision, now, fm, hashGhlScopeRules({ ...scopeRules, sourceLessLegacy: false })).reasonCode, "scope_rules_changed");
{
  const facts = describeChangedFacts(control.nativeReview, {
    workflows: [{ ...workflows[0], version: "5" }, { locationId: "loc-1", id: "workflow-2", status: "draft", updatedAt: "2025-02-01T00:00:00.000Z", version: "1" }],
    fields: [{ id: "cf-9", key: "lb_do_not_contact", dataType: "TEXT" }],
    scopeRules: { ...scopeRules, createSourceCategories: ["manual_crm"] },
  });
  assert(facts.some(f => /workflow workflow-1 changed/.test(f)) && facts.some(f => /workflow workflow-2 added/.test(f))
    && facts.some(f => /lb_do_not_contact/.test(f)) && facts.some(f => /createSourceCategories/.test(f)), "changed facts are reported");
}
assert.equal(evaluateGhlCapabilityPolicy({
  ...contactCreate, body: { firstName: "A", locationId: "loc-other" },
}, control, revision, now, fm, scopeRev).reasonCode, "operation_not_reviewed");
assert.equal(evaluateGhlCapabilityPolicy({
  method: "PUT", path: "/contacts/c-1", locationId: "loc-1",
  body: { customFields: [{ id: "unverified-custom-field", key: "lb_can_sms", field_value: "true" }] },
}, {
  ...control,
  nativeReview: sealGhlApprovedReview({
    ...control.nativeReview,
    allowedOperations: [{
      method: "PUT", path: "/contacts/:contactId", fields: ["customFields"],
      tags: [], stageIds: [], safetyEvidence: "permission-change-evidence-42",
      purpose: "Project reviewed permission fields",
      customFieldIds: ["unverified-custom-field"],
    }],
  }, { reviewerId: "owner-1", reviewedAt: new Date(reviewedAtMs), scopeRules }),
}, revision, now, fm, scopeRev).reasonCode, "operation_not_reviewed");
assert.equal(evaluateGhlCapabilityPolicy({
  ...contactCreate, body: { firstName: "A", email: "a@example.test", unreviewedField: "bad" },
}, control, revision, now, fm, scopeRev).reasonCode, "operation_not_reviewed");
assert.equal(evaluateGhlCapabilityPolicy({
  method: "POST", path: "/contacts/c-1/workflow/w-1", body: {}, locationId: "loc-1",
}, control, revision, now, fm, scopeRev).reasonCode, "outbound_authority_required");
assert.equal(evaluateGhlCapabilityPolicy({
  method: "POST", path: "/conversations/messages", body: { message: "test" }, locationId: "loc-1",
}, control, revision, now, fm, scopeRev).reasonCode, "outbound_authority_required");
assert.equal(evaluateGhlCapabilityPolicy({
  method: "POST", path: "/contacts/c-1/enrollments", body: {}, locationId: "loc-1",
}, control, revision, now, fm, scopeRev).reasonCode, "outbound_authority_required");
assert.equal(evaluateGhlCapabilityPolicy({
  method: "POST", path: "/contacts/c-1/automation/trigger", body: { firstName: "A" }, locationId: "loc-1",
}, control, revision, now, fm, scopeRev).reasonCode, "outbound_authority_required");
assert.equal(evaluateGhlCapabilityPolicy({
  method: "POST", path: "/contacts/trigger/search", body: {}, locationId: "loc-1",
}, control, revision, now, fm, scopeRev).allowed, false);

const decision = evaluateGhlCapabilityPolicy(contactCreate, control, revision, now, fm, scopeRev);
assert.equal(isGhlCrmDecisionCurrent(decision, control, revision, now, fm, scopeRev), true);
assert.equal(isGhlCrmDecisionCurrent(decision, { ...control, epoch: control.epoch + 1 }, revision, now, fm, scopeRev), false);
assert.equal(evaluateGhlCapabilityPolicy(
  { method: "PATCH", path: "/contacts/c-1", body: { lb_sms_allowed: true }, locationId: "loc-1" },
  { ...control, permissionsEnabled: false }, revision, now, fm, scopeRev,
).reasonCode, "permissions_disabled");

assert.equal(isGhlRuntimeWriteSelected({ ...control, ownerProfile: "ghl-sync-only", selectedRuntime: "build-a" }, "build-a"), true);
assert.equal(isGhlRuntimeWriteSelected({ ...control, ownerProfile: "ghl-sync-only", selectedRuntime: "build-a" }, "build-b"), false);
assert.equal(isGhlRuntimeWriteSelected({ ...control, ownerProfile: "ghl-sync-only", selectedRuntime: "build-a" }, null), false);
assert.equal(isGhlRuntimeWriteSelected({ ...control, ownerProfile: null, selectedRuntime: "build-a" }, "build-a"), false);
assert.equal(classifyGhlOperation("GET", "/locations/loc-1/customFields/automation/trigger"), "unknown");
assert.equal(classifyGhlOperation("GET", "/locations/loc-1/tags"), "diagnostic_read");
assert.equal(classifyGhlOperation("GET", "/calendars/cal-1/free-slots"), "crm_read");
console.log("GHL capability/control policy safety assertions passed.");