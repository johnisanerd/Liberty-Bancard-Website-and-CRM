import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { requireRole } from "../replit_integrations/auth";
import {
  getGhlSyncControl,
  getCurrentGhlRuntimeIdentity,
  hashGhlCustomFieldInventory,
  hashNativeWorkflowInventory,
  patchGhlSyncControl,
  recordGhlNativeReview,
  revokeGhlNativeReview,
  verifyGhlNativeReview,
  getGhlReviewVerificationRecord,
  type NativeReview,
} from "../services/ghl-sync-control";
import { hashGhlScopeRules, readGhlScopeRules } from "../services/ghl-scope-rules";
import { getGhlCustomFieldInventory, getGhlNativeWorkflowInventory } from "../services/ghl";
import { PREPARED_NATIVE_REVIEW } from "../data/ghl-prepared-native-review";
import { comparePreparedReview } from "../services/ghl-prepared-review";

const operationSchema = z.object({
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(300),
  fields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).min(1).max(40),
  tags: z.array(z.string().min(1).max(100)).max(100),
  stageIds: z.array(z.string().min(1).max(100)).max(100),
  safetyEvidence: z.string().trim().min(8).max(500),
  purpose: z.string().trim().min(8).max(300),
  customFieldIds: z.array(z.string().min(1).max(128)).max(100),
}).strict();

const reviewSchema = z.object({
  expectedEpoch: z.number().int().nonnegative(),
  evidenceReference: z.string().trim().min(8).max(500),
  locationId: z.string().min(1).max(100),
  inventoryRevision: z.string().regex(/^[a-f0-9]{64}$/i),
  allowedOperations: z.array(operationSchema).min(1).max(50),
  workflowActionEvidence: z.array(z.object({
    workflowId: z.string().min(1),
    disposition: z.enum(["reviewed_safe", "no_native_triggers"]),
    evidenceReference: z.string().trim().min(8).max(500),
    observedUpdatedAt: z.string(),
    observedVersion: z.string(),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/i),
    changeMetadata: z.string().trim().min(8).max(500),
  }).strict()).max(500),
  customFieldInventoryRevision: z.string().regex(/^[a-f0-9]{64}$/i),
  scopeRulesRevision: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

const revokeSchema = z.object({
  expectedEpoch: z.number().int().nonnegative(),
  reason: z.string().trim().min(8).max(500),
}).strict();

export type GhlApprovalStatus =
  | "approved_unchanged" | "verification_unavailable" | "review_required_changed" | "revoked" | "review_required";

/** Operator-facing approval status derived from the stored approval and a live verification. */
export function deriveApprovalStatus(
  review: NativeReview, verificationStatus: "unchanged" | "unavailable" | "changed" | "not_approved" | "revoked",
): GhlApprovalStatus {
  if (verificationStatus === "revoked" || review.state === "revoked") return "revoked";
  if (verificationStatus === "unchanged") return "approved_unchanged";
  if (verificationStatus === "unavailable") return "verification_unavailable";
  if (verificationStatus === "changed") return "review_required_changed";
  return "review_required";
}

function actorId(req: any): string {
  return String(req.user?.id ?? req.user?.claims?.sub ?? "").trim();
}

export function registerGhlSyncControlRoutes(
  app: Express,
  adminRole: RequestHandler = requireRole("admin"),
) {
  app.get("/api/admin/ghl/sync-control", adminRole, async (_req, res) => {
    try {
      return res.json({ control: await getGhlSyncControl() });
    } catch (error: any) {
      return res.status(503).json({ error: "GHL_SYNC_CONTROL_UNAVAILABLE", reason: String(error?.message ?? error) });
    }
  });

  app.patch("/api/admin/ghl/sync-control", adminRole, async (req, res) => {
    const user = actorId(req);
    if (!user) return res.status(401).json({ error: "Authenticated admin identity required" });
    const schema = z.object({
      expectedEpoch: z.number().int().nonnegative(),
      enabled: z.boolean().optional(),
      permissionsEnabled: z.boolean().optional(),
      ownerProfile: z.literal("ghl-sync-only").nullable().optional(),
      selectCurrentRuntime: z.literal(true).optional(),
    }).strict().refine(value => value.enabled !== undefined || value.permissionsEnabled !== undefined
      || value.ownerProfile !== undefined || value.selectCurrentRuntime === true);
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid GHL sync control update", issues: parsed.error.issues });
    if (parsed.data.selectCurrentRuntime && !getCurrentGhlRuntimeIdentity()) {
      return res.status(422).json({ error: "GHL_CURRENT_RUNTIME_IDENTITY_UNVERIFIED" });
    }
    try {
      return res.json({ control: await patchGhlSyncControl(parsed.data, user) });
    } catch (error: any) {
      const reason = String(error?.message ?? error);
      return res.status(reason.includes("EPOCH_CONFLICT") ? 409 : 503).json({ error: reason });
    }
  });

  app.get("/api/admin/ghl/native-trigger-safety", adminRole, async (_req, res) => {
    const control = await getGhlSyncControl().catch(() => null);
    if (!control) return res.status(503).json({ error: "GHL_SYNC_CONTROL_UNAVAILABLE" });
    const locationId = process.env.GHL_LOCATION_ID || "";
    const verification = await verifyGhlNativeReview(control, locationId, { persist: false }).catch(() => null);
    const record = await getGhlReviewVerificationRecord().catch(() => null);
    const approvalStatus = verification ? deriveApprovalStatus(control.nativeReview, verification.status) : "verification_unavailable";
    const review = control.nativeReview;
    const approval = {
      status: approvalStatus,
      reviewerId: review.reviewerId ?? null,
      reviewedAt: review.reviewedAt ?? null,
      locationId: review.locationId ?? null,
      lastCheckedAt: verification?.checkedAt ?? record?.checkedAt ?? null,
      lastVerifiedAt: verification?.status === "unchanged" ? verification.checkedAt : record?.lastVerifiedAt ?? null,
      changedFacts: verification?.changedFacts ?? record?.changedFacts ?? [],
      unavailable: verification?.unavailable ?? [],
      contractVersion: review.contractVersion ?? null,
      revokedAt: review.revokedAt ?? null,
      revokedBy: review.revokedBy ?? null,
      revocationReason: review.revocationReason ?? null,
      operations: (review.allowedOperations ?? []).map(op => ({ method: op.method, path: op.path, fields: op.fields, tags: op.tags })),
      scopeRules: review.scopeRules ?? null,
    };
    try {
      const workflows = verification?.workflows ?? await getGhlNativeWorkflowInventory(locationId);
      const customFields = verification?.fieldMap ?? await getGhlCustomFieldInventory(locationId);
      const scopeRules = verification?.scopeRules ?? await readGhlScopeRules();
      const inventoryRevision = hashNativeWorkflowInventory(workflows);
      const customFieldInventoryRevision = hashGhlCustomFieldInventory(customFields);
      return res.json({
        state: approvalStatus === "approved_unchanged" ? "reviewed_current" : "unreviewed_inventory",
        locationId,
        inventoryRevision,
        workflows,
        customFields,
        customFieldInventoryRevision,
        scopeRules,
        scopeRulesRevision: hashGhlScopeRules(scopeRules),
        approval,
        nativeReview: { ...review, state: approvalStatus === "approved_unchanged" ? "approved" : review.state === "revoked" ? "revoked" : "unverified" },
        warning: "Workflow inventory does not establish action safety; an administrator must inspect native actions and provide explicit evidence. Change detection relies on provider workflow metadata (status, updatedAt, version): a definition edit that does not move them cannot be detected from the public API.",
      });
    } catch (error: any) {
      return res.json({
        state: "unverified",
        locationId: process.env.GHL_LOCATION_ID || null,
        inventoryRevision: null,
        workflows: null,
        approval,
        nativeReview: review,
        reason: String(error?.message ?? error),
      });
    }
  });

  // Prepared, attributed review evidence plus a live comparison. Read-only: it records no review and no reviewer.
  app.get("/api/admin/ghl/native-trigger-safety/prepared-review", adminRole, async (_req, res) => {
    const locationId = process.env.GHL_LOCATION_ID || "";
    if (!locationId) return res.status(503).json({ error: "GHL_LOCATION_UNAVAILABLE" });
    try {
      const [workflows, customFields, scopeRules] = await Promise.all([
        getGhlNativeWorkflowInventory(locationId),
        getGhlCustomFieldInventory(locationId),
        readGhlScopeRules(),
      ]);
      const comparison = comparePreparedReview(PREPARED_NATIVE_REVIEW, {
        locationId,
        inventoryRevision: hashNativeWorkflowInventory(workflows),
        customFieldInventoryRevision: hashGhlCustomFieldInventory(customFields),
        scopeRulesRevision: hashGhlScopeRules(scopeRules),
        workflows,
        customFieldIds: customFields.map(field => field.id),
      });
      return res.json({ prepared: PREPARED_NATIVE_REVIEW, comparison });
    } catch (error: any) {
      return res.status(503).json({ error: "GHL_PREPARED_REVIEW_UNAVAILABLE", reason: String(error?.message ?? error) });
    }
  });

  app.post("/api/admin/ghl/native-trigger-safety/revoke", adminRole, async (req, res) => {
    const user = actorId(req);
    if (!user) return res.status(401).json({ error: "Authenticated admin identity required" });
    const parsed = revokeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A revocation reason is required", issues: parsed.error.issues });
    try {
      return res.json({ control: await revokeGhlNativeReview(parsed.data.reason, user, parsed.data.expectedEpoch) });
    } catch (error: any) {
      const reason = String(error?.message ?? error);
      return res.status(reason.includes("EPOCH_CONFLICT") ? 409 : 503).json({ error: reason });
    }
  });

  app.post("/api/admin/ghl/native-trigger-safety/review", adminRole, async (req, res) => {
    const user = actorId(req);
    if (!user) return res.status(401).json({ error: "Authenticated admin identity required" });
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Explicit native-trigger review evidence required", issues: parsed.error.issues });
    try {
      const input = parsed.data;
      const currentLocation = process.env.GHL_LOCATION_ID || "";
      if (!currentLocation || input.locationId !== currentLocation) {
        return res.status(422).json({ error: "GHL_NATIVE_REVIEW_LOCATION_MISMATCH" });
      }
      const workflows = await getGhlNativeWorkflowInventory(currentLocation);
      const customFields = await getGhlCustomFieldInventory(currentLocation);
      const revision = hashNativeWorkflowInventory(workflows);
      if (revision !== input.inventoryRevision) return res.status(409).json({ error: "GHL_NATIVE_INVENTORY_CHANGED" });
      const fieldRevision = hashGhlCustomFieldInventory(customFields);
      if (fieldRevision !== input.customFieldInventoryRevision) return res.status(409).json({ error: "GHL_CUSTOM_FIELD_INVENTORY_CHANGED" });
      const review: NativeReview = {
        state: "approved",
        reviewedAt: null,
        evidenceReference: input.evidenceReference,
        locationId: currentLocation,
        allowedOperations: input.allowedOperations,
        inventoryRevision: revision,
        workflows,
        workflowActionEvidence: input.workflowActionEvidence,
        customFieldInventoryRevision: fieldRevision,
        customFields,
        scopeRulesRevision: input.scopeRulesRevision,
      };
      const control = await recordGhlNativeReview(review, user, input.expectedEpoch);
      return res.json({ control });
    } catch (error: any) {
      const reason = String(error?.message ?? error);
      const status = reason.includes("EPOCH_CONFLICT") || reason.includes("INVENTORY_CHANGED") || reason.includes("SCOPE_RULES_CHANGED") ? 409
        : reason.includes("INCOMPLETE") || reason.includes("INVALID") || reason.includes("SELF_APPROVAL") ? 422 : 503;
      return res.status(status).json({ error: reason });
    }
  });
}