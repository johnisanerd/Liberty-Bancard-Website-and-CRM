import crypto from "crypto";
import { pool } from "../db";
import {
  classifyGhlOperation,
  ghlBodyContainsPermissionWrite,
  isKnownPermissionCustomFieldKey,
  isRegisteredGhlWriteTemplate,
  resolveGhlWriteTemplate,
  type GhlCapability,
} from "./ghl-capability-policy";
import { resolveRoutineSfpDeploymentIdentity } from "../../shared/sfp-publish-build-identity";
import { effectiveGhlScopeRules, hashGhlScopeRules, stableStringify, readGhlScopeRules, type GhlScopeRules } from "./ghl-scope-rules";

const SETTING_KEY = "ghlSyncControl";
const VERIFICATION_KEY = "ghlNativeReviewVerification";

/**
 * Persistent approval contract (#2105 7A). An approved native review has no calendar expiry: it stays valid until the
 * owner revokes it or a bound fact changes. Reviews recorded under any other contract version (including the earlier
 * 24-hour reviews) are never converted and never regain authority.
 */
export const GHL_APPROVAL_CONTRACT_VERSION = 2;
/** Provider evidence (workflow inventory, custom-field map) is cached this long and shared by concurrent callers. */
export const GHL_EVIDENCE_CACHE_TTL_MS = 20_000;
const GHL_EVIDENCE_FAILURE_TTL_MS = 5_000;

export interface NativeWorkflowEvidence {
  locationId: string;
  id: string;
  status: string;
  updatedAt: string;
  version: string;
}
export interface NativeCustomFieldEvidence {
  id: string;
  key: string;
  dataType?: string;
}

export interface NativeReview {
  state: "unverified" | "approved" | "revoked";
  /** Approval contract version; only the current version can carry authority. */
  contractVersion?: number;
  reviewedAt: string | null;
  evidenceReference: string | null;
  /** Hash of every fact the approval binds (see computeReviewContractRevision). */
  contractRevision?: string;
  scopeRules?: GhlScopeRules;
  scopeRulesRevision?: string;
  revokedAt?: string | null;
  revokedBy?: string | null;
  revocationReason?: string | null;
  locationId?: string;
  allowedOperations: Array<{
    method: string;
    path: string;
    fields: string[];
    tags: string[];
    stageIds: string[];
    safetyEvidence: string;
    purpose: string;
    customFieldIds: string[];
  }>;
  reviewerId?: string;
  inventoryRevision?: string;
  workflows?: NativeWorkflowEvidence[];
  workflowActionEvidence?: Array<{
    workflowId: string;
    disposition: "reviewed_safe" | "no_native_triggers";
    evidenceReference: string;
    observedUpdatedAt: string;
    observedVersion: string;
    definitionHash: string;
    changeMetadata: string;
  }>;
  customFields?: NativeCustomFieldEvidence[];
  customFieldInventoryRevision?: string;
}

export interface GhlSyncControl {
  enabled: boolean;
  permissionsEnabled: boolean;
  epoch: number;
  ownerProfile: string | null;
  selectedRuntime: string | null;
  transitioning?: boolean;
  nativeReview: NativeReview;
}

export interface GhlCrmDecision {
  allowed: boolean;
  capability: GhlCapability;
  epoch: number;
  reasonCode: string;
  reason?: string;
  method: string;
  path: string;
  body?: unknown;
  locationId: string | null;
  reviewRevision?: string;
}

export function getCurrentGhlRuntimeIdentity(): string | null {
  return resolveRoutineSfpDeploymentIdentity({
    releaseSha: process.env.RELEASE_SHA,
    publishArtifactSha: process.env.SFP_PUBLISH_ARTIFACT_SHA,
    publishBuildId: process.env.SFP_PUBLISH_BUILD_ID,
    platformDeploymentId: process.env.REPL_DEPLOYMENT_ID,
  });
}

export function isGhlRuntimeWriteSelected(control: GhlSyncControl, runtimeIdentity: string | null): boolean {
  return !!runtimeIdentity && control.ownerProfile === "ghl-sync-only"
    && control.selectedRuntime === runtimeIdentity;
}

function defaultControl(): GhlSyncControl {
  return {
    enabled: false,
    permissionsEnabled: false,
    epoch: 0,
    ownerProfile: null,
    selectedRuntime: null,
    transitioning: false,
    nativeReview: {
      state: "unverified", reviewedAt: null, evidenceReference: null,
      allowedOperations: [],
    },
  };
}

function parseControl(value: any): GhlSyncControl {
  const fallback = defaultControl();
  if (!value || typeof value !== "object") return fallback;
  const control: GhlSyncControl = {
    enabled: value.enabled === true,
    permissionsEnabled: value.permissionsEnabled === true,
    epoch: Number.isSafeInteger(Number(value.epoch)) ? Number(value.epoch) : 0,
    ownerProfile: value.ownerProfile === "ghl-sync-only" ? "ghl-sync-only" : null,
    selectedRuntime: typeof value.selectedRuntime === "string" ? value.selectedRuntime : null,
    transitioning: value.transitioning === true,
    nativeReview: value.nativeReview && typeof value.nativeReview === "object"
      ? value.nativeReview as NativeReview : fallback.nativeReview,
  };
  if (control.nativeReview.state === "approved" && !isApprovedReview(control.nativeReview)) {
    control.nativeReview.state = "unverified";
  }
  return control;
}

export async function getGhlSyncControl(): Promise<GhlSyncControl> {
  const result = await pool.query<{ value: any }>(
    "SELECT value FROM system_settings WHERE key = $1", [SETTING_KEY],
  );
  if (!result.rows.length) return defaultControl();
  const raw = result.rows[0].value;
  return parseControl(typeof raw === "string" ? JSON.parse(raw) : raw);
}

export function hashNativeWorkflowInventory(workflows: NativeWorkflowEvidence[]): string {
  const canonical = workflows.slice().sort((a, b) => a.id.localeCompare(b.id))
    .map(w => `${w.locationId}\0${w.id}\0${w.status}\0${w.updatedAt}\0${w.version}`).join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function hashGhlCustomFieldInventory(fields: NativeCustomFieldEvidence[]): string {
  const canonical = fields.slice().sort((a, b) => a.id.localeCompare(b.id))
    .map(field => `${field.id}\0${field.key}\0${field.dataType ?? ""}`).join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Hash of everything the owner approved. A stored review whose content no longer matches this hash is not approved. */
export function computeReviewContractRevision(review: NativeReview): string {
  const operations = (review.allowedOperations ?? []).map(op => ({
    method: op.method.toUpperCase(), path: op.path, fields: op.fields.slice().sort(),
    tags: op.tags.slice().sort(), stageIds: op.stageIds.slice().sort(),
    customFieldIds: op.customFieldIds.slice().sort(), purpose: op.purpose, safetyEvidence: op.safetyEvidence,
  })).sort((x, y) => `${x.method} ${x.path}`.localeCompare(`${y.method} ${y.path}`));
  const evidence = (review.workflowActionEvidence ?? []).map(item => ({ ...item }))
    .sort((x, y) => x.workflowId.localeCompare(y.workflowId));
  return crypto.createHash("sha256").update(stableStringify({
    contractVersion: review.contractVersion, locationId: review.locationId, operations,
    customFieldInventoryRevision: review.customFieldInventoryRevision, inventoryRevision: review.inventoryRevision,
    scopeRulesRevision: review.scopeRulesRevision, evidence, evidenceReference: review.evidenceReference,
    reviewerId: review.reviewerId, reviewedAt: review.reviewedAt,
  })).digest("hex");
}

/** Stamps and seals an approval under the current contract. Used by the review recorder and by certification fixtures. */
export function sealGhlApprovedReview(
  review: NativeReview, meta: { reviewerId: string; reviewedAt: Date; scopeRules: GhlScopeRules },
): NativeReview {
  const stamped: NativeReview = {
    ...review, state: "approved", contractVersion: GHL_APPROVAL_CONTRACT_VERSION,
    reviewedAt: meta.reviewedAt.toISOString(), reviewerId: meta.reviewerId,
    scopeRules: meta.scopeRules, scopeRulesRevision: hashGhlScopeRules(meta.scopeRules),
    revokedAt: null, revokedBy: null, revocationReason: null,
  };
  return { ...stamped, contractRevision: computeReviewContractRevision(stamped) };
}

/** Structural validity of an approval. There is no age or expiry condition: elapsed time alone never changes it. */
export function isApprovedReview(review: NativeReview): boolean {
  if (review.state !== "approved" || review.contractVersion !== GHL_APPROVAL_CONTRACT_VERSION
      || review.revokedAt || !review.reviewedAt || !review.reviewerId
      || !review.evidenceReference || !review.inventoryRevision || !Array.isArray(review.workflows)
      || !Array.isArray(review.workflowActionEvidence) || !Array.isArray(review.customFields)
      || !Array.isArray(review.allowedOperations) || review.allowedOperations.length === 0
      || !review.customFieldInventoryRevision || !review.scopeRules || !review.scopeRulesRevision
      || hashGhlScopeRules(review.scopeRules) !== review.scopeRulesRevision
      || hashGhlCustomFieldInventory(review.customFields) !== review.customFieldInventoryRevision
      || !review.contractRevision || computeReviewContractRevision(review) !== review.contractRevision) return false;
  const reviewed = Date.parse(review.reviewedAt);
  const knownWorkflowStatuses = new Set(["active", "published", "draft", "inactive", "unpublished", "paused", "disabled", "deleted"]);
  const validInventory = review.workflows.every(workflow =>
    !!workflow.id && !!workflow.locationId && !!workflow.status && knownWorkflowStatuses.has(workflow.status)
    && !!workflow.updatedAt && !!workflow.version);
  const validOperations = review.allowedOperations.every(operation =>
    isRegisteredGhlWriteTemplate(operation.method, operation.path)
    && !!operation.purpose?.trim() && !!operation.safetyEvidence?.trim()
    && Array.isArray(operation.fields) && operation.fields.length > 0
    && Array.isArray(operation.tags) && Array.isArray(operation.stageIds)
    && Array.isArray(operation.customFieldIds));
  const covered = validInventory && validOperations
    && review.workflowActionEvidence.length === review.workflows.length
    && new Set(review.workflowActionEvidence.map(item => item.workflowId)).size === review.workflowActionEvidence.length
    && review.workflows.every(workflow =>
      review.workflowActionEvidence!.some(item => item.workflowId === workflow.id
        && !!item.evidenceReference?.trim() && !!item.changeMetadata?.trim()
        && /^[a-f0-9]{64}$/i.test(item.definitionHash)
        && item.observedUpdatedAt === workflow.updatedAt
        && item.observedVersion === workflow.version));
  return covered && Number.isFinite(reviewed)
    && hashNativeWorkflowInventory(review.workflows) === review.inventoryRevision;
}

export function isGhlCrmDecisionCurrent(
  decision: GhlCrmDecision,
  control: GhlSyncControl,
  liveInventoryRevision?: string,
  now = Date.now(),
  fieldMap?: NativeCustomFieldEvidence[],
  scopeRulesRevision?: string,
): boolean {
  void now; // approvals carry no calendar expiry; the argument is kept for call-site stability
  if (!decision.allowed || control.epoch !== decision.epoch) return false;
  if (decision.capability === "communication" || decision.capability === "unknown"
      || decision.capability === "crm_read" || decision.capability === "diagnostic_read") return true;
  if (control.transitioning) return false;
  if (ghlBodyContainsPermissionWrite(decision.body) && !control.permissionsEnabled) return false;
  if (decision.capability === "permission_write" && !control.permissionsEnabled) return false;
  if (decision.capability === "crm_write" && !control.enabled) return false;
  if (!isApprovedReview(control.nativeReview)
      || control.nativeReview.inventoryRevision !== decision.reviewRevision
      || control.nativeReview.locationId !== (decision.locationId || process.env.GHL_LOCATION_ID || null)
      || !liveInventoryRevision || liveInventoryRevision !== decision.reviewRevision
      || !fieldMap || hashGhlCustomFieldInventory(fieldMap) !== control.nativeReview.customFieldInventoryRevision
      || !scopeRulesRevision || scopeRulesRevision !== control.nativeReview.scopeRulesRevision) return false;
  const operation = control.nativeReview.allowedOperations.find(candidate =>
    candidate.method.toUpperCase() === decision.method
    && resolveGhlWriteTemplate(decision.method, decision.path) === candidate.path);
  return !!operation && payloadCovered(decision.body, operation, control.nativeReview.locationId ?? null, fieldMap);
}

function normalizePath(path: string): string {
  return path.split("?")[0].replace(/\/+$/, "") || "/";
}

function payloadCovered(
  body: unknown,
  allowed: NativeReview["allowedOperations"][number],
  locationId: string | null,
  fieldMap: Array<{ id: string; key: string }> = [],
): boolean {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, any> : {};
  const forbidden = new Set(["workflowId", "workflowIds", "automationId", "triggerId"]);
  if (obj.locationId !== undefined && String(obj.locationId) !== locationId) return false;
  if (Object.keys(obj).some(key => forbidden.has(key))) return false;
  const actualFields = Object.keys(obj).filter(key => !["contactId", "id", "locationId"].includes(key)).sort();
  if (actualFields.some(key => !allowed.fields.includes(key))) return false;
  for (const [key, value] of Object.entries(obj)) {
    if (["customFields", "tags", "stageIds"].includes(key)) continue;
    if (value !== null && typeof value === "object") return false;
  }
  if (obj.customFields !== undefined) {
    if (!Array.isArray(obj.customFields)) return false;
    for (const field of obj.customFields) {
      if (!field || typeof field !== "object" || Array.isArray(field)) return false;
      if (Object.keys(field).some(key => !["id", "key", "field_value", "value"].includes(key))) return false;
      if (typeof field.id !== "string" || !allowed.customFieldIds.includes(field.id)) return false;
      const verifiedField = fieldMap.find(candidate => candidate.id === field.id);
      if (!verifiedField || (field.key !== undefined && field.key !== verifiedField.key)) return false;
      if (classifyGhlOperation("PUT", "/contacts/permission-policy-check", body) === "permission_write"
          && !isKnownPermissionCustomFieldKey(verifiedField.key)) return false;
      const fieldValue = field.field_value ?? field.value;
      if (fieldValue !== null && typeof fieldValue === "object") return false;
    }
  }
  if (obj.tags !== undefined && (!Array.isArray(obj.tags)
      || obj.tags.some((tag: unknown) => typeof tag !== "string" || !allowed.tags.includes(tag)))) return false;
  if (obj.stageIds !== undefined && (!Array.isArray(obj.stageIds)
      || obj.stageIds.some((stage: unknown) => typeof stage !== "string" || !allowed.stageIds.includes(stage)))) return false;
  if (obj.pipelineStageId !== undefined && (typeof obj.pipelineStageId !== "string" || !allowed.stageIds.includes(obj.pipelineStageId))) return false;
  if (obj.stageId !== undefined && (typeof obj.stageId !== "string" || !allowed.stageIds.includes(obj.stageId))) return false;
  return actualFields.length > 0;
}

type EvidenceSlot = {
  entry?: { value: unknown; at: number };
  failure?: { error: Error; at: number };
  inflight?: Promise<unknown>;
};
const evidenceSlots = new Map<string, EvidenceSlot>();
let evidenceClock: () => number = () => Date.now();

/** Test seam: a controlled clock for the provider-evidence cache. */
export function setGhlEvidenceClockForTest(clock: (() => number) | null): void {
  evidenceClock = clock ?? (() => Date.now());
}
export function resetGhlEvidenceCache(): void { evidenceSlots.clear(); }

/**
 * Bounded provider-evidence cache with single-flight: concurrent callers share one provider request, a success is
 * reused for GHL_EVIDENCE_CACHE_TTL_MS, and a failure is remembered for a few seconds so an outage does not turn every
 * contact into its own provider request. Never serves a value older than the TTL, so verification that cannot be
 * refreshed holds writes instead of trusting stale facts.
 */
async function cachedEvidence<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const slot = evidenceSlots.get(key) ?? {};
  evidenceSlots.set(key, slot);
  const now = evidenceClock();
  if (slot.entry && now - slot.entry.at < GHL_EVIDENCE_CACHE_TTL_MS) return slot.entry.value as T;
  if (slot.failure && now - slot.failure.at < GHL_EVIDENCE_FAILURE_TTL_MS) throw slot.failure.error;
  if (slot.inflight) return slot.inflight as Promise<T>;
  slot.inflight = fetcher().then(value => {
    slot.entry = { value, at: evidenceClock() };
    slot.failure = undefined;
    return value;
  }, error => {
    slot.entry = undefined;
    slot.failure = { error: error instanceof Error ? error : new Error(String(error)), at: evidenceClock() };
    throw slot.failure.error;
  }).finally(() => { slot.inflight = undefined; });
  return slot.inflight as Promise<T>;
}

async function getVerifiedCustomFieldMap(
  locationId: string | null | undefined, options: { fresh?: boolean } = {},
): Promise<NativeCustomFieldEvidence[]> {
  const { getGhlCustomFieldInventory } = await import("./ghl");
  if (options.fresh) return getGhlCustomFieldInventory(locationId);
  return cachedEvidence(`fields:${locationId ?? ""}`, () => getGhlCustomFieldInventory(locationId));
}

async function getVerifiedWorkflowInventory(locationId: string | null | undefined): Promise<NativeWorkflowEvidence[]> {
  const { getGhlNativeWorkflowInventory } = await import("./ghl");
  return cachedEvidence(`workflows:${locationId ?? ""}`, () => getGhlNativeWorkflowInventory(locationId));
}

export type GhlReviewVerificationStatus = "unchanged" | "unavailable" | "changed" | "not_approved" | "revoked";

export interface GhlReviewVerification {
  status: GhlReviewVerificationStatus;
  checkedAt: string;
  changedFacts: string[];
  unavailable: string[];
  workflows?: NativeWorkflowEvidence[];
  fieldMap?: NativeCustomFieldEvidence[];
  scopeRules?: GhlScopeRules;
}

/** Plain-language list of the bound facts that differ from the approval. Pure. */
export function describeChangedFacts(
  review: NativeReview,
  live: { workflows: NativeWorkflowEvidence[]; fields: NativeCustomFieldEvidence[]; scopeRules: GhlScopeRules },
): string[] {
  const facts: string[] = [];
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map(row => [row.id, row]));
  const reviewedWorkflows = byId(review.workflows ?? []);
  const liveWorkflows = byId(live.workflows);
  for (const [id, workflow] of liveWorkflows) {
    const before = reviewedWorkflows.get(id);
    if (!before) facts.push(`workflow ${id} added`);
    else if (before.status !== workflow.status || before.updatedAt !== workflow.updatedAt || before.version !== workflow.version) {
      facts.push(`workflow ${id} changed (${before.status}/${before.version} -> ${workflow.status}/${workflow.version})`);
    }
  }
  for (const id of reviewedWorkflows.keys()) if (!liveWorkflows.has(id)) facts.push(`workflow ${id} removed`);
  const reviewedFields = byId(review.customFields ?? []);
  const liveFields = byId(live.fields);
  for (const [id, field] of liveFields) {
    const before = reviewedFields.get(id);
    if (!before) facts.push(`custom field ${field.key} (${id}) added`);
    else if (before.key !== field.key || (before.dataType ?? "") !== (field.dataType ?? "")) {
      facts.push(`custom field ${id} changed (${before.key}/${before.dataType || "no type"} -> ${field.key}/${field.dataType || "no type"})`);
    }
  }
  for (const [id, field] of reviewedFields) if (!liveFields.has(id)) facts.push(`custom field ${field.key} (${id}) removed`);
  const reviewedRules = review.scopeRules as unknown as Record<string, unknown> | undefined;
  const liveRules = live.scopeRules as unknown as Record<string, unknown>;
  for (const key of Object.keys(liveRules)) {
    if (JSON.stringify(reviewedRules?.[key]) !== JSON.stringify(liveRules[key])) facts.push(`export scope rule ${key} changed`);
  }
  return facts;
}

let lastVerificationSignature = "";
let lastVerificationPersistedAt = 0;
let lastUnchangedAt: string | null = null;

async function persistVerification(verification: GhlReviewVerification): Promise<void> {
  const signature = `${verification.status}|${verification.changedFacts.join(";")}|${verification.unavailable.join(";")}`;
  const now = evidenceClock();
  if (signature === lastVerificationSignature && now - lastVerificationPersistedAt < 60_000) return;
  if (verification.status === "unchanged") lastUnchangedAt = verification.checkedAt;
  try {
    const previous = (await pool.query<{ value: any }>("SELECT value FROM system_settings WHERE key=$1", [VERIFICATION_KEY])).rows[0]?.value;
    const prior = typeof previous === "string" ? JSON.parse(previous) : previous;
    const lastVerifiedAt = verification.status === "unchanged" ? verification.checkedAt
      : lastUnchangedAt ?? prior?.lastVerifiedAt ?? null;
    await pool.query(
      `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(key) DO UPDATE SET value=$2::jsonb,updated_at=NOW()`,
      [VERIFICATION_KEY, JSON.stringify({
        status: verification.status, checkedAt: verification.checkedAt, lastVerifiedAt,
        changedFacts: verification.changedFacts.slice(0, 50), unavailable: verification.unavailable,
      })],
    );
    lastVerificationSignature = signature;
    lastVerificationPersistedAt = now;
  } catch (error) {
    console.warn("[GHL CRM control] Could not persist native review verification", (error as Error).message);
  }
}

export async function getGhlReviewVerificationRecord(): Promise<{
  status: string; checkedAt: string; lastVerifiedAt: string | null; changedFacts: string[]; unavailable: string[];
} | null> {
  const row = (await pool.query<{ value: any }>("SELECT value FROM system_settings WHERE key=$1", [VERIFICATION_KEY])).rows[0]?.value;
  if (!row) return null;
  return typeof row === "string" ? JSON.parse(row) : row;
}

/**
 * Verifies the approved contract against live provider evidence and the saved export-scope rules. Outcomes:
 *  - unchanged: the approved facts still hold;
 *  - unavailable: evidence could not be read (a hold: writes wait, nothing is approved or invalidated);
 *  - changed: a bound fact differs (a block: a new owner review is required);
 *  - not_approved / revoked: there is no usable approval.
 */
export async function verifyGhlNativeReview(
  control: GhlSyncControl, locationId?: string | null, options: { persist?: boolean } = {},
): Promise<GhlReviewVerification> {
  const checkedAt = new Date(evidenceClock()).toISOString();
  const review = control.nativeReview;
  const finish = async (verification: GhlReviewVerification) => {
    if (options.persist !== false) await persistVerification(verification);
    return verification;
  };
  if (review.state === "revoked") return finish({ status: "revoked", checkedAt, changedFacts: [], unavailable: [] });
  if (!isApprovedReview(review)) return finish({ status: "not_approved", checkedAt, changedFacts: [], unavailable: [] });
  const location = locationId || review.locationId || null;
  const unavailable: string[] = [];
  let workflows: NativeWorkflowEvidence[] | undefined;
  let fieldMap: NativeCustomFieldEvidence[] | undefined;
  let scopeRules: GhlScopeRules | undefined;
  try { workflows = await getVerifiedWorkflowInventory(location); } catch { unavailable.push("workflow inventory"); }
  try { fieldMap = await getVerifiedCustomFieldMap(location); } catch { unavailable.push("custom-field inventory"); }
  try { scopeRules = await readGhlScopeRules(); } catch { unavailable.push("export scope rules"); }
  if (!workflows || !fieldMap || !scopeRules) {
    return finish({ status: "unavailable", checkedAt, changedFacts: [], unavailable, workflows, fieldMap, scopeRules });
  }
  const changedFacts = (hashNativeWorkflowInventory(workflows) !== review.inventoryRevision
      || hashGhlCustomFieldInventory(fieldMap) !== review.customFieldInventoryRevision
      || hashGhlScopeRules(scopeRules) !== review.scopeRulesRevision)
    ? describeChangedFacts(review, { workflows, fields: fieldMap, scopeRules })
    : [];
  const changed = changedFacts.length > 0
    || hashNativeWorkflowInventory(workflows) !== review.inventoryRevision
    || hashGhlCustomFieldInventory(fieldMap) !== review.customFieldInventoryRevision
    || hashGhlScopeRules(scopeRules) !== review.scopeRulesRevision;
  return finish({
    status: changed ? "changed" : "unchanged", checkedAt,
    changedFacts: changed && changedFacts.length === 0 ? ["reviewed evidence differs from live evidence"] : changedFacts,
    unavailable: [], workflows, fieldMap, scopeRules,
  });
}

function deny(capability: GhlCapability, control: GhlSyncControl, code: string, reason: string, args: any): GhlCrmDecision {
  return {
    allowed: false, capability, epoch: control.epoch, reasonCode: code, reason,
    method: args.method.toUpperCase(), path: normalizePath(args.path), body: args.body,
    locationId: args.locationId ?? null,
  };
}

/** Pure policy evaluator used by transport authorization and fail-closed tests. */
export function evaluateGhlCapabilityPolicy(args: {
  method: string; path: string; body?: unknown; locationId?: string;
}, control: GhlSyncControl, liveInventoryRevision?: string, now = Date.now(),
fieldMap?: NativeCustomFieldEvidence[], scopeRulesRevision?: string): GhlCrmDecision {
  void now; // approvals carry no calendar expiry
  const capability = classifyGhlOperation(args.method, args.path, args.body);
  const common = {
    allowed: true, capability, epoch: control.epoch, reasonCode: "allowed",
    method: args.method.toUpperCase(), path: normalizePath(args.path), body: args.body,
    locationId: args.locationId ?? null,
  } satisfies GhlCrmDecision;
  if (capability === "unknown" || capability === "communication") {
    return deny(capability, control, "outbound_authority_required", "Operation must use the existing outbound authorization protocol", args);
  }
  if (capability === "crm_read" || capability === "diagnostic_read") return common;
  if (control.transitioning) {
    return deny(capability, control, "control_transitioning", "GHL CRM control is changing; retry after it settles", args);
  }
  if (ghlBodyContainsPermissionWrite(args.body) && !control.permissionsEnabled) {
    return deny(capability, control, "permissions_disabled", "GHL permission projection is disabled", args);
  }
  if (capability === "permission_write" && !control.permissionsEnabled) {
    return deny(capability, control, "permissions_disabled", "GHL permission projection is disabled", args);
  }
  if (capability === "crm_write" && !control.enabled) {
    return deny(capability, control, "control_disabled", "GHL CRM writes are disabled", args);
  }
  const review = control.nativeReview;
  if (review.state === "revoked") {
    return deny(capability, control, "native_review_revoked", "The native-trigger approval was revoked", args);
  }
  if (!isApprovedReview(review)) {
    return deny(capability, control, "native_review_unverified", "An approved native-trigger review under the current contract is required", args);
  }
  if (review.locationId !== (args.locationId || process.env.GHL_LOCATION_ID || null)) {
    return deny(capability, control, "native_review_location_mismatch", "Native-trigger review is not pinned to this GHL location", args);
  }
  if (!liveInventoryRevision) {
    return deny(capability, control, "native_inventory_unavailable", "Live native workflow inventory could not be verified", args);
  }
  if (liveInventoryRevision !== review.inventoryRevision) {
    return deny(capability, control, "native_inventory_changed", "Live native workflow inventory differs from the reviewed revision", args);
  }
  if (!fieldMap) {
    return deny(capability, control, "custom_field_inventory_unavailable", "GHL custom-field IDs could not be verified", args);
  }
  if (hashGhlCustomFieldInventory(fieldMap) !== review.customFieldInventoryRevision) {
    return deny(capability, control, "custom_field_inventory_changed", "Live provider custom-field map differs from reviewed evidence", args);
  }
  if (!scopeRulesRevision) {
    return deny(capability, control, "scope_rules_unavailable", "Export scope rules could not be verified", args);
  }
  if (scopeRulesRevision !== review.scopeRulesRevision) {
    return deny(capability, control, "scope_rules_changed", "Saved export scope rules differ from the reviewed rules", args);
  }
  if (/[?#]/.test(args.path)) {
    return deny(capability, control, "operation_not_reviewed", "CRM writes with query or fragment suffixes are not in the exact operation allowlist", args);
  }
  const template = resolveGhlWriteTemplate(args.method, args.path);
  const op = review.allowedOperations.find(candidate =>
    candidate.method.toUpperCase() === args.method.toUpperCase()
    && candidate.path === template
    && isRegisteredGhlWriteTemplate(candidate.method, candidate.path));
  if (!op || !payloadCovered(args.body, op, review.locationId ?? null, fieldMap)) {
    return deny(capability, control, "operation_not_reviewed", "Exact operation and payload are not covered by the native-trigger review", args);
  }
  return { ...common, reviewRevision: review.inventoryRevision };
}

export async function authorizeGhlCrmOperation(args: {
  method: string; path: string; body?: unknown; locationId?: string;
}): Promise<GhlCrmDecision> {
  const capability = classifyGhlOperation(args.method, args.path, args.body);
  const control = await getGhlSyncControl();
  const common = {
    allowed: true, capability, epoch: control.epoch, reasonCode: "allowed",
    method: args.method.toUpperCase(), path: normalizePath(args.path), body: args.body,
    locationId: args.locationId ?? null,
  } satisfies GhlCrmDecision;

  // Do not exempt communication or unknown paths. Obtain the established
  // outbound authorization disposition here; transports still perform their
  // full register/recheck/inflight protocol immediately before I/O.
  if (capability === "communication" || capability === "unknown") {
    const { authorize } = await import("./outbound-pause-authority");
    const outbound = await authorize({});
    return outbound.allowed ? common : {
      ...common, allowed: false, reasonCode: outbound.reasonCode,
      reason: "Existing outbound pause authority denied this GHL operation",
    };
  }
  if (capability === "crm_read" || capability === "diagnostic_read") return common;
  if (!isGhlRuntimeWriteSelected(control, getCurrentGhlRuntimeIdentity())) {
    return deny(capability, control, "runtime_not_selected", "This published runtime is not selected for GHL CRM writes", args);
  }
  const verification = await verifyGhlNativeReview(control, args.locationId);
  if (verification.status === "revoked") {
    return deny(capability, control, "native_review_revoked", "The native-trigger approval was revoked", args);
  }
  if (verification.status === "not_approved") {
    return deny(capability, control, "native_review_unverified", "An approved native-trigger review under the current contract is required", args);
  }
  if (verification.status === "unavailable") {
    return deny(capability, control, "native_verification_unavailable",
      `Approval verification is temporarily unavailable (${verification.unavailable.join(", ")}); writes are held`, args);
  }
  if (verification.status === "changed") {
    return deny(capability, control, "native_review_changed",
      `Reviewed configuration changed: ${verification.changedFacts.slice(0, 5).join("; ")}`, args);
  }
  return evaluateGhlCapabilityPolicy(
    args, control, hashNativeWorkflowInventory(verification.workflows!), Date.now(),
    verification.fieldMap, hashGhlScopeRules(verification.scopeRules!),
  );
}

export async function recheckGhlCrmOperation(decision: GhlCrmDecision): Promise<boolean> {
  if (!decision.allowed) return false;
  const control = await getGhlSyncControl();
  let liveRevision: string | undefined;
  let fieldMap: NativeCustomFieldEvidence[] | undefined;
  let scopeRevision: string | undefined;
  if (decision.capability !== "communication" && decision.capability !== "unknown"
      && decision.capability !== "crm_read" && decision.capability !== "diagnostic_read") {
    if (!isGhlRuntimeWriteSelected(control, getCurrentGhlRuntimeIdentity())) return false;
    const verification = await verifyGhlNativeReview(control, decision.locationId);
    if (verification.status !== "unchanged") return false;
    liveRevision = hashNativeWorkflowInventory(verification.workflows!);
    fieldMap = verification.fieldMap;
    scopeRevision = hashGhlScopeRules(verification.scopeRules!);
  }
  return isGhlCrmDecisionCurrent(decision, control, liveRevision, Date.now(), fieldMap, scopeRevision);
}

/** CRM projections have their own allow-switch but still join the global pause
 * drain. Unlike outbound sends, they may run while state is paused; never during
 * activation, safe-default, or after the captured global epoch changes. */
export async function captureGhlCrmPauseEpoch(): Promise<bigint> {
  const result = await pool.query<{ state: string; epoch: string }>(
    "SELECT state,epoch::text FROM outbound_pause_control ORDER BY id LIMIT 1",
  );
  const row = result.rows[0];
  if (!row || !["paused", "unpaused"].includes(row.state)) {
    throw new Error("GHL_CRM_GLOBAL_PAUSE_STATE_UNVERIFIED");
  }
  return BigInt(row.epoch);
}

export async function recheckGhlCrmPauseEpoch(epoch: bigint): Promise<boolean> {
  try {
    const result = await pool.query<{ state: string; epoch: string }>(
      "SELECT state,epoch::text FROM outbound_pause_control ORDER BY id LIMIT 1",
    );
    const row = result.rows[0];
    return !!row && ["paused", "unpaused"].includes(row.state) && BigInt(row.epoch) === epoch;
  } catch { return false; }
}

export async function registerGhlCrmInflight(controlEpoch: number): Promise<string> {
  const token = crypto.randomUUID();
  const { registerInflight } = await import("./outbound-control-service");
  await registerInflight(token, -(BigInt(controlEpoch) + 1n));
  return token;
}

export function deregisterGhlCrmInflight(token: string): void {
  import("./outbound-control-service").then(({ deregisterInflight }) => deregisterInflight(token))
    .catch(error => console.warn("[GHL CRM control] Failed to deregister in-flight CRM write", error));
}

/** Every independent CRM adapter must join both CRM and global pause drains. */
export async function withGhlCrmInflight<T>(decision: GhlCrmDecision, io: () => Promise<T>): Promise<T> {
  const epoch = await captureGhlCrmPauseEpoch();
  const token = await registerGhlCrmInflight(decision.epoch);
  try {
    if (!await recheckGhlCrmOperation(decision) || !await recheckGhlCrmPauseEpoch(epoch)) {
      throw new Error("GHL CRM operation blocked: control_or_native_review_changed");
    }
    return await io();
  } finally {
    deregisterGhlCrmInflight(token);
  }
}

async function drainGhlCrmInflight(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM outbound_inflight_sends WHERE granted_epoch < 0 AND expires_at > NOW()",
    );
    if (Number(result.rows[0]?.count ?? 0) === 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("GHL_CRM_INFLIGHT_DRAIN_TIMEOUT");
}

/** Atomic epoch-CAS update. Fields for runtime identity are always derived server-side. */
export async function patchGhlSyncControl(input: {
  expectedEpoch: number;
  enabled?: boolean;
  permissionsEnabled?: boolean;
  ownerProfile?: "ghl-sync-only" | null;
  selectCurrentRuntime?: true;
}, actor: string): Promise<GhlSyncControl> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [73190421]);
    const result = await client.query<{ value: any }>(
      "SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [SETTING_KEY],
    );
    const raw = result.rows[0]?.value;
    const current = parseControl(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (current.epoch !== input.expectedEpoch) throw new Error("GHL_CONTROL_EPOCH_CONFLICT");
    if (input.selectCurrentRuntime && !getCurrentGhlRuntimeIdentity()) {
      throw new Error("GHL_CURRENT_RUNTIME_IDENTITY_UNVERIFIED");
    }
    const transition: GhlSyncControl = {
      ...current,
      transitioning: true,
      epoch: current.epoch + 1,
    };
    await client.query(
      `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(key) DO UPDATE SET value=$2::jsonb,updated_at=NOW()`,
      [SETTING_KEY, JSON.stringify(transition)],
    );
    await client.query(
      `INSERT INTO audit_logs(action,entity_type,entity_key,actor_type,actor_id,details,created_at)
       VALUES('ghl_sync_control_changed','system',$1,'user',$2,$3::jsonb,NOW())`,
      [SETTING_KEY, actor, JSON.stringify({ epoch: transition.epoch, transition: "started" })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await drainGhlCrmInflight();
  const finish = await pool.connect();
  try {
    await finish.query("BEGIN");
    await finish.query("SELECT pg_advisory_xact_lock($1)", [73190421]);
    const row = await finish.query<{ value: any }>("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [SETTING_KEY]);
    const raw = row.rows[0]?.value;
    const current = parseControl(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (current.epoch !== input.expectedEpoch + 1 || !current.transitioning) {
      throw new Error("GHL_CONTROL_EPOCH_CONFLICT");
    }
    const next: GhlSyncControl = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      permissionsEnabled: input.permissionsEnabled ?? current.permissionsEnabled,
      ownerProfile: input.ownerProfile === undefined ? current.ownerProfile : input.ownerProfile,
      selectedRuntime: input.selectCurrentRuntime ? getCurrentGhlRuntimeIdentity() : current.selectedRuntime,
      transitioning: false,
      epoch: current.epoch + 1,
    };
    await finish.query(
      "UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1",
      [SETTING_KEY, JSON.stringify(next)],
    );
    await finish.query(
      `INSERT INTO audit_logs(action,entity_type,entity_key,actor_type,actor_id,details,created_at)
       VALUES('ghl_sync_control_changed','system',$1,'user',$2,$3::jsonb,NOW())`,
      [SETTING_KEY, actor, JSON.stringify({ epoch: next.epoch, enabled: next.enabled, permissionsEnabled: next.permissionsEnabled, ownerProfile: next.ownerProfile, selectedRuntime: next.selectedRuntime, transition: "committed" })],
    );
    await finish.query("COMMIT");
    return next;
  } catch (error) {
    await finish.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    finish.release();
  }
}

export async function recordGhlNativeReview(review: NativeReview, actorId: string, expectedEpoch: number): Promise<GhlSyncControl> {
  const configuredLocation = process.env.GHL_LOCATION_ID || null;
  const providerFields = await getVerifiedCustomFieldMap(configuredLocation, { fresh: true });
  const liveScopeRules = await readGhlScopeRules();
  if (!review.scopeRulesRevision || review.scopeRulesRevision !== hashGhlScopeRules(liveScopeRules)) {
    throw new Error("GHL_SCOPE_RULES_CHANGED");
  }
  const providerFieldRevision = hashGhlCustomFieldInventory(providerFields);
  if (!review.locationId || !configuredLocation || review.locationId !== configuredLocation
      || review.workflows?.some(workflow => workflow.locationId !== review.locationId)
      || new Set(review.workflows?.map(workflow => workflow.id) ?? []).size !== (review.workflows?.length ?? 0)
      || !review.evidenceReference?.trim() || !review.inventoryRevision || !Array.isArray(review.workflows)
      || hashNativeWorkflowInventory(review.workflows) !== review.inventoryRevision) {
    throw new Error("GHL_NATIVE_REVIEW_EVIDENCE_UNVERIFIED");
  }
  if (review.customFieldInventoryRevision !== providerFieldRevision) {
    throw new Error("GHL_CUSTOM_FIELD_INVENTORY_CHANGED");
  }
  if (!review.allowedOperations.length || review.allowedOperations.some(op =>
    !op.method || !isRegisteredGhlWriteTemplate(op.method, op.path) || !op.fields.length
    || !op.safetyEvidence?.trim() || !op.purpose?.trim()
    || op.customFieldIds.some(id => !providerFields.some(field => field.id === id))
    || (op.customFieldIds.length > 0 && !op.fields.includes("customFields"))
    || op.fields.some(field => !/^[A-Za-z][A-Za-z0-9_]*$/.test(field)))) {
    throw new Error("GHL_NATIVE_REVIEW_ALLOWLIST_INVALID");
  }
  const actionEvidence = review.workflowActionEvidence ?? [];
  const workflowIds = new Set(review.workflows.map(workflow => workflow.id));
  if (actionEvidence.length !== workflowIds.size
      || new Set(actionEvidence.map(item => item.workflowId)).size !== actionEvidence.length
      || actionEvidence.some(item => {
        const workflow = review.workflows?.find(candidate => candidate.id === item.workflowId);
        return !workflow || !item.evidenceReference?.trim() || !item.changeMetadata?.trim()
          || !/^[a-f0-9]{64}$/i.test(item.definitionHash)
          || item.observedUpdatedAt !== workflow.updatedAt || item.observedVersion !== workflow.version;
      })) {
    throw new Error("GHL_NATIVE_WORKFLOW_ACTION_EVIDENCE_INCOMPLETE");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [73190421]);
    const result = await client.query<{ value: any }>("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [SETTING_KEY]);
    const raw = result.rows[0]?.value;
    const current = parseControl(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (current.epoch !== expectedEpoch) throw new Error("GHL_CONTROL_EPOCH_CONFLICT");
    const transition = { ...current, transitioning: true, epoch: current.epoch + 1 };
    await client.query(
      `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(key) DO UPDATE SET value=$2::jsonb,updated_at=NOW()`,
      [SETTING_KEY, JSON.stringify(transition)],
    );
    await client.query(
      `INSERT INTO audit_logs(action,entity_type,entity_key,actor_type,actor_id,details,created_at)
       VALUES('ghl_native_trigger_safety_reviewed','system',$1,'user',$2,$3::jsonb,NOW())`,
      [SETTING_KEY, actorId, JSON.stringify({ epoch: transition.epoch, transition: "started", evidenceReference: review.evidenceReference })],
    );
    await client.query("COMMIT");
    const now = new Date();
    const nativeReview = sealGhlApprovedReview({
      ...review,
      customFields: providerFields.map(field => ({ id: field.id, key: field.key, dataType: field.dataType ?? "" })),
    }, { reviewerId: actorId, reviewedAt: now, scopeRules: liveScopeRules });
    await drainGhlCrmInflight();
    const finish = await pool.connect();
    try {
      await finish.query("BEGIN");
      await finish.query("SELECT pg_advisory_xact_lock($1)", [73190421]);
      const finishRow = await finish.query<{ value: any }>("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [SETTING_KEY]);
      const finishRaw = finishRow.rows[0]?.value;
      const currentAfterDrain = parseControl(typeof finishRaw === "string" ? JSON.parse(finishRaw) : finishRaw);
      if (currentAfterDrain.epoch !== expectedEpoch + 1 || !currentAfterDrain.transitioning) {
        throw new Error("GHL_CONTROL_EPOCH_CONFLICT");
      }
      const next = {
        ...currentAfterDrain, nativeReview, transitioning: false, epoch: currentAfterDrain.epoch + 1,
      };
      await finish.query("UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1", [SETTING_KEY, JSON.stringify(next)]);
      await finish.query(
        `INSERT INTO audit_logs(action,entity_type,entity_key,actor_type,actor_id,details,created_at)
         VALUES('ghl_native_trigger_safety_reviewed','system',$1,'user',$2,$3::jsonb,NOW())`,
        [SETTING_KEY, actorId, JSON.stringify({ epoch: next.epoch, evidenceReference: nativeReview.evidenceReference, inventoryRevision: nativeReview.inventoryRevision, contractVersion: nativeReview.contractVersion, contractRevision: nativeReview.contractRevision, scopeRulesRevision: nativeReview.scopeRulesRevision, allowedOperations: nativeReview.allowedOperations, transition: "committed" })],
      );
      await finish.query("COMMIT");
      return next;
    } catch (error) {
      await finish.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      finish.release();
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
/**
 * Owner revocation. Bumps the control epoch and drains in-flight CRM writes, so no later mutation or retry can use
 * the approval. The reviewed content is retained as evidence; only a new review can restore authority.
 */
export async function revokeGhlNativeReview(reason: string, actorId: string, expectedEpoch: number): Promise<GhlSyncControl> {
  if (!reason?.trim()) throw new Error("GHL_NATIVE_REVIEW_REVOCATION_REASON_REQUIRED");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [73190421]);
    const result = await client.query<{ value: any }>("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [SETTING_KEY]);
    const raw = result.rows[0]?.value;
    const current = parseControl(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (current.epoch !== expectedEpoch) throw new Error("GHL_CONTROL_EPOCH_CONFLICT");
    await client.query(
      `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(key) DO UPDATE SET value=$2::jsonb,updated_at=NOW()`,
      [SETTING_KEY, JSON.stringify({ ...current, transitioning: true, epoch: current.epoch + 1 })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await drainGhlCrmInflight();
  const finish = await pool.connect();
  try {
    await finish.query("BEGIN");
    await finish.query("SELECT pg_advisory_xact_lock($1)", [73190421]);
    const row = await finish.query<{ value: any }>("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [SETTING_KEY]);
    const raw = row.rows[0]?.value;
    const stored = typeof raw === "string" ? JSON.parse(raw) : raw;
    const current = parseControl(stored);
    if (current.epoch !== expectedEpoch + 1 || !current.transitioning) throw new Error("GHL_CONTROL_EPOCH_CONFLICT");
    const priorReview = (stored?.nativeReview && typeof stored.nativeReview === "object" ? stored.nativeReview : current.nativeReview) as NativeReview;
    const next: GhlSyncControl = {
      ...current, transitioning: false, epoch: current.epoch + 1,
      nativeReview: {
        ...priorReview, state: "revoked", revokedAt: new Date().toISOString(), revokedBy: actorId,
        revocationReason: reason.trim().slice(0, 500),
      },
    };
    await finish.query("UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1", [SETTING_KEY, JSON.stringify(next)]);
    await finish.query(
      `INSERT INTO audit_logs(action,entity_type,entity_key,actor_type,actor_id,details,created_at)
       VALUES('ghl_native_review_revoked','system',$1,'user',$2,$3::jsonb,NOW())`,
      [SETTING_KEY, actorId, JSON.stringify({ epoch: next.epoch, reason: next.nativeReview.revocationReason, contractRevision: priorReview.contractRevision ?? null, transition: "committed" })],
    );
    await finish.query("COMMIT");
    return next;
  } catch (error) {
    await finish.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    finish.release();
  }
}
