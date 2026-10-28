import type { Express, Request } from "express";
import { z } from "zod";
import { requireRole } from "../replit_integrations/auth";
import { serverError } from "../utils/server-error";
import {
  CR06_DISPATCH_AVAILABLE,
  CR06_GATE_CONFIRMATION,
  CR06_MAX_PREPARED_MEMBERS,
  applyCr06Rollout,
  approveCr06Program,
  assertCr06DispatchUnavailable,
  getCr06Catalog,
  getCr06RolloutManifest,
  getCr06Run,
  preflightCr06,
  prepareCr06,
  reconcileCr06PreparationReservations,
  setCr06CampaignGate,
} from "../services/cr06-premium-campaigns";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const cap = z.coerce.number().int().min(1).max(CR06_MAX_PREPARED_MEMBERS);

function actorId(req: Request): string {
  const user = req.user as any;
  return String(user?.email ?? user?.id ?? "unknown-admin");
}

function idempotencyKey(req: Request): string | null {
  const value = req.get("Idempotency-Key");
  return value && value.length >= 8 && value.length <= 200 ? value : null;
}

function cr06Error(res: any, error: unknown) {
  const message = error instanceof Error ? error.message : "CR06_UNKNOWN_ERROR";
  if (error instanceof z.ZodError) {
    return res.status(400).json({ code: "CR06_INVALID_COMMAND", message: "Invalid governed command" });
  }
  if (message.includes("NOT_FOUND")) return res.status(404).json({ code: message, message: "Governed object not found" });
  if (message.includes("CAP_OUT_OF_RANGE") || message.includes("REQUIRED")) {
    return res.status(400).json({ code: message, message: "Invalid governed command" });
  }
  if (message.startsWith("CR06_")) return res.status(409).json({ code: message, message: "Governed command was not applied" });
  return serverError(res, error);
}

export function registerCr06Routes(app: Express) {
  app.get("/api/admin/cr06/manifest", requireRole("admin", "manager"), (_req, res) => {
    res.json(getCr06RolloutManifest());
  });

  // Derived read-only catalog contract (current/template/historical/uninstalled/unresolved + readiness states).
  app.get("/api/admin/catalog-truth", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { loadCatalogTruth } = await import("../services/catalog-truth");
      res.json(await loadCatalogTruth());
    } catch (error) {
      serverError(res, error);
    }
  });

  app.get("/api/admin/cr06/catalog", requireRole("admin", "manager"), async (_req, res) => {
    try {
      res.json(await getCr06Catalog());
    } catch (error) {
      serverError(res, error);
    }
  });

  app.post("/api/admin/cr06/rollout", requireRole("admin"), async (req, res) => {
    try {
      const parsed = z.object({ dryRun: z.boolean().default(true) }).strict().parse(req.body ?? {});
      const result = await applyCr06Rollout({ actorId: actorId(req), dryRun: parsed.dryRun });
      res.status(parsed.dryRun ? 200 : 201).json(result);
    } catch (error) {
      cr06Error(res, error);
    }
  });

  app.post("/api/admin/cr06/programs/:id/approve", requireRole("admin"), async (req, res) => {
    try {
      const input = z.object({
        expectedHash: hash,
        confirmation: z.literal("CR06_APPROVE_EXACT_IMMUTABLE_PACKAGE"),
      }).strict().parse(req.body);
      const result = await approveCr06Program({
        programArtifactId: uuid.parse(req.params.id),
        expectedHash: input.expectedHash,
        reviewerId: actorId(req),
      });
      res.json(result);
    } catch (error) {
      cr06Error(res, error);
    }
  });

  app.get("/api/admin/cr06/preflight", requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = z.object({
        programArtifactId: uuid,
        cohortRunId: uuid,
        cap: cap.default(CR06_MAX_PREPARED_MEMBERS),
      }).parse(req.query);
      res.json(await preflightCr06(input));
    } catch (error) {
      cr06Error(res, error);
    }
  });

  app.post("/api/admin/cr06/gates", requireRole("admin"), async (req, res) => {
    try {
      const key = idempotencyKey(req);
      if (!key) return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key is required" });
      const input = z.object({
        programArtifactId: uuid,
        cohortRunId: uuid,
        preflightHash: hash,
        cap,
        state: z.enum(["open", "closed"]),
        confirmation: z.string().optional(),
        expiresAt: z.string().datetime(),
      }).strict().parse(req.body);
      const gate = await setCr06CampaignGate({
        ...input,
        confirmation: input.confirmation,
        actorId: actorId(req),
        idempotencyKey: key,
        expiresAt: new Date(input.expiresAt),
      });
      res.json({
        ...gate,
        globalPauseChanged: false,
        preparationStarted: false,
        dispatchStarted: false,
        requiredOpenConfirmation: CR06_GATE_CONFIRMATION,
      });
    } catch (error) {
      cr06Error(res, error);
    }
  });

  app.post("/api/admin/cr06/prepare", requireRole("admin"), async (req, res) => {
    try {
      const key = idempotencyKey(req);
      if (!key) return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key is required" });
      const input = z.object({
        programArtifactId: uuid,
        cohortRunId: uuid,
        cap,
        confirmation: z.literal("CR06_PREPARE_HELD_SENDING_OFF"),
      }).strict().parse(req.body);
      const result = await prepareCr06({
        programArtifactId: input.programArtifactId,
        cohortRunId: input.cohortRunId,
        cap: input.cap,
        actorId: actorId(req),
        idempotencyKey: key,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      cr06Error(res, error);
    }
  });

  app.get("/api/admin/cr06/runs/:id", requireRole("admin"), async (req, res) => {
    try {
      const run = await getCr06Run(uuid.parse(req.params.id));
      if (!run) return res.status(404).json({ message: "Preparation run not found" });
      res.json(run);
    } catch (error) {
      cr06Error(res, error);
    }
  });

  app.post("/api/admin/cr06/runs/:id/reservations/reconcile", requireRole("admin"), async (req, res) => {
    try {
      const key = idempotencyKey(req);
      if (!key) return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid Idempotency-Key is required" });
      const input = z.object({
        transition: z.enum(["expired", "reconciled", "superseded"]),
        reason: z.string().trim().min(1).max(500).optional(),
      }).strict().parse(req.body);
      const result = await reconcileCr06PreparationReservations({
        preparationRunId: uuid.parse(req.params.id),
        transition: input.transition,
        reason: input.reason,
        actorId: actorId(req),
        idempotencyKey: key,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      cr06Error(res, error);
    }
  });

  app.post("/api/admin/cr06/runs/:id/release", requireRole("admin"), (req, res) => {
    try {
      // Validate the opaque governed identity even while external dispatch is
      // unavailable; malformed input must never be confused with a release denial.
      uuid.parse(req.params.id);
    } catch (error) {
      return cr06Error(res, error);
    }
    assertCr06DispatchUnavailable();
    return res.status(403).json({
      code: "CR06_FINAL_DISPATCH_NOT_AUTHORIZED",
      message: "Preparation remains held. Final external dispatch requires a separately authorized future release.",
      dispatchAvailable: CR06_DISPATCH_AVAILABLE,
    });
  });
}