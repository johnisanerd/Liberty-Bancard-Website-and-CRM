import {
  CanonicalReleaseError, describeCanonicalRelease, executeCanonicalRelease, previewCanonicalRelease,
  resolveCanonicalHold, revokeCanonicalRelease, writeReleasePolicy, type HoldResolution,
} from "../services/sfp-canonical-release";
import { readSfpLaunchInventory } from "../services/sfp-launch-inventory";
import type { Express } from "express";
import { isDashboardUser, requireRole } from "../replit_integrations/auth";
import { readCanonicalEnrichmentStatus } from "../services/canonical-enrichment-status";
import { readCanonicalEnrichmentBacklog } from "../services/canonical-enrichment-backlog";
import {
  BacklogProcessInputError, enqueueBacklogProcess, readLastBacklogPriorityRun, validateBacklogProcessRequest,
} from "../services/canonical-enrichment-backlog-run";
import { storage } from "../storage";
import {
  UploadLedgerInputError, listUploadLedgerRuns, readUploadLedgerPage, readUploadLedgerSummary,
} from "../services/canonical-upload-ledger";

export function registerCanonicalEnrichmentRoutes(app: Express) {
  app.get("/api/canonical-enrichment/status", isDashboardUser, requireRole("admin", "manager"), async (_req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await readCanonicalEnrichmentStatus());
    } catch {
      res.status(503).json({ message: "Canonical enrichment status is unavailable; counts were not calculated." });
    }
  });

  // One backlog across every intake family. Cached read model; `?fresh=1` forces a recount (admin only).
  app.get("/api/canonical-enrichment/backlog", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      const fresh = req.query.fresh === "1" && (req.user as any)?.role === "admin";
      const [backlog, lastPriorityRun] = await Promise.all([
        readCanonicalEnrichmentBacklog({ fresh }),
        readLastBacklogPriorityRun().catch(() => null),
      ]);
      res.json({ ...backlog, lastPriorityRun });
    } catch {
      res.status(503).json({ message: "The enrichment backlog is unavailable; nothing was counted." });
    }
  });

  // Current prepared recipients re-checked against every launch requirement. Read-only; sends nothing.
  app.get("/api/canonical-enrichment/launch-inventory", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      const fresh = req.query.fresh === "1" && (req.user as any)?.role === "admin";
      res.json(await readSfpLaunchInventory({ fresh }));
    } catch {
      res.status(503).json({ message: "The launch inventory is unavailable; nothing was counted." });
    }
  });

  // Narrow operator release of current canonical recipients. Preview is read-only. Execute and revoke
  // are admin-only and audit-logged. None of these lift the outbound pause.
  const actor = (req: any) => String(req.user?.id ?? req.user?.email ?? "unknown");
  const releaseError = (res: any, error: unknown) => {
    if (error instanceof CanonicalReleaseError) return res.status(error.status).json({ code: error.code, message: error.message });
    return res.status(503).json({ message: "The release request could not be completed; nothing was released." });
  };
  app.get("/api/canonical-enrichment/release", isDashboardUser, requireRole("admin", "manager"), async (_req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      const { readSenderCapacity } = await import("../services/sfp-sender-capacity");
      const [status, capacity] = await Promise.all([describeCanonicalRelease(), readSenderCapacity().catch(() => null)]);
      res.json({ ...status, capacity });
    } catch { res.status(503).json({ message: "The release state is unavailable." }); }
  });
  // Read-only: what each current launch package renders for a fictional recipient. Writes and sends nothing.
  app.get("/api/canonical-enrichment/seed-test/rendering", isDashboardUser, requireRole("admin"), async (_req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      const { previewSeedRendering } = await import("../services/sfp-seed-test");
      res.json(await previewSeedRendering());
    } catch { res.status(503).json({ message: "The seed rendering is unavailable; nothing was rendered." }); }
  });
  app.post("/api/canonical-enrichment/release/preview", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await previewCanonicalRelease(Number(req.body?.limit)));
    } catch (error) { releaseError(res, error); }
  });
  app.post("/api/canonical-enrichment/release/execute", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const commandKey = req.header("Idempotency-Key") ?? "";
      const result = await executeCanonicalRelease({
        requestedLimit: Number(req.body?.limit), snapshotHash: String(req.body?.snapshotHash ?? ""),
        commandKey, expiresInHours: Number(req.body?.expiresInHours), actorId: actor(req),
      });
      await storage.createAuditLog({
        action: "sfp_canonical_release_executed", entityType: "sfp_canonical_release",
        entityKey: result.release.releaseId, userId: actor(req),
        details: { replayed: result.replayed, releaseId: result.release.releaseId, size: result.release.enrollmentIds.length,
          admissionClosesAt: result.release.admissionClosesAt, journeyExpiresAt: result.release.journeyExpiresAt,
          snapshotHash: result.release.snapshotHash },
      } as any);
      res.json({ replayed: result.replayed, release: result.release });
    } catch (error) { releaseError(res, error); }
  });
  app.post("/api/canonical-enrichment/release/revoke", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const result = await revokeCanonicalRelease(actor(req));
      await storage.createAuditLog({
        action: "sfp_canonical_release_revoked", entityType: "sfp_canonical_release", userId: actor(req),
        details: { ...result },
      } as any);
      res.json(result);
    } catch (error) { releaseError(res, error); }
  });

  // Administrator-configurable admission policy (size ceiling, admission window, journey period). Bounded and audited.
  app.put("/api/canonical-enrichment/release/policy", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const policy = await writeReleasePolicy(req.body, actor(req));
      await storage.createAuditLog({
        action: "sfp_canonical_release_policy_updated", entityType: "sfp_canonical_release", userId: actor(req), details: { ...policy },
      } as any);
      res.json({ policy });
    } catch (error) { releaseError(res, error); }
  });
  // Operator decision for a held journey (uncertain delivery, repeated unsent). Never automatic.
  app.post("/api/canonical-enrichment/release/enrollments/:id/resolve", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const resolution = String(req.body?.resolution ?? "") as HoldResolution;
      if (!["delivered", "not_delivered", "clear_hold"].includes(resolution)) {
        return res.status(400).json({ code: "RESOLUTION_INVALID", message: "resolution must be delivered, not_delivered or clear_hold" });
      }
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ code: "ENROLLMENT_INVALID" });
      const result = await resolveCanonicalHold(id, resolution);
      await storage.createAuditLog({
        action: "sfp_canonical_hold_resolved", entityType: "sequence_enrollment", entityKey: String(id), userId: actor(req),
        details: { resolution, ...result },
      } as any);
      res.status(result.resolved ? 200 : 409).json(result);
    } catch (error) { releaseError(res, error); }
  });

  // Optional: ask the existing background worker to work the highest-priority backlog now.
  // It adds no new send, spend or enrollment path; ordinary scheduled passes continue regardless.
  app.post("/api/canonical-enrichment/backlog/process", isDashboardUser, requireRole("admin"), async (req, res) => {
    let request;
    try { request = validateBacklogProcessRequest(req.body); }
    catch (error) {
      if (error instanceof BacklogProcessInputError) return res.status(400).json({ message: error.message });
      return res.status(400).json({ message: "Invalid request." });
    }
    try {
      const result = await enqueueBacklogProcess(request);
      await storage.createAuditLog({
        action: "canonical_backlog_process_requested", entityType: "canonical_enrichment_backlog",
        entityKey: result.jobId ?? "not_queued", userId: String((req.user as any)?.id ?? ""),
        details: { ...request, accepted: result.accepted, alreadyQueued: result.alreadyQueued },
      });
      res.status(result.accepted ? 202 : 503).json(result);
    } catch {
      res.status(503).json({ message: "The request could not be queued; nothing was started." });
    }
  });

  // Read-only, paginated original-coordinate ledger. Bounded: at most 100 rows per page.
  const ledgerGuard = [isDashboardUser, requireRole("admin", "manager")] as const;
  const ledgerError = (res: any, error: unknown) => {
    if (error instanceof UploadLedgerInputError) return res.status(400).json({ code: error.message });
    return res.status(503).json({ message: "The upload ledger is unavailable; nothing was calculated." });
  };
  app.get("/api/canonical-enrichment/uploads", ...ledgerGuard, async (_req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json({ uploads: await listUploadLedgerRuns() }); }
    catch (error) { ledgerError(res, error); }
  });
  app.get("/api/canonical-enrichment/uploads/:executionId/summary", ...ledgerGuard, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json(await readUploadLedgerSummary(req.params.executionId)); }
    catch (error) { ledgerError(res, error); }
  });
  app.get("/api/canonical-enrichment/uploads/:executionId/rows", ...ledgerGuard, async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await readUploadLedgerPage({ executionId: req.params.executionId, after: req.query.after,
        limit: req.query.limit, filter: req.query.filter }));
    } catch (error) { ledgerError(res, error); }
  });
}
