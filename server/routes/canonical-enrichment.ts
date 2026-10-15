import type { Express } from "express";
import { isDashboardUser, requireRole } from "../replit_integrations/auth";
import { readCanonicalEnrichmentStatus } from "../services/canonical-enrichment-status";
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
