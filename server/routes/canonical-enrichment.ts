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
