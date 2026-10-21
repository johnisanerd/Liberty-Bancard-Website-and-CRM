import type { Express } from "express";
import { isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { z } from "zod";
import { enrollInGhlWorkflow, enrollInGhlWorkflowCompliant } from "../services/ghl-workflows";
import { REVIEW_CHECKLIST_ITEMS } from "@shared/schema";
import { serverError } from "../utils/server-error";
import crypto from "crypto";
import { sanitizeDeadLetterEvent } from "../services/audit-sanitizer";

const DLQ_CURSOR_VERSION = 1;
const MAX_DLQ_CURSOR_BYTES = 512;
const MAX_DLQ_PAGE_SIZE = 100;
type DlqCursor = { v: number; snapshotId: number; afterId: number };
function dlqCursorSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
  if (!secret) throw new Error("DLQ_CURSOR_SECRET_UNAVAILABLE");
  return secret;
}
export function encodeDlqCursor(cursor: DlqCursor): string {
  const json = JSON.stringify(cursor);
  if (Buffer.byteLength(json) > MAX_DLQ_CURSOR_BYTES) throw new Error("DLQ_CURSOR_TOO_LARGE");
  const encoded = Buffer.from(json).toString("base64url");
  return `${encoded}.${crypto.createHmac("sha256", dlqCursorSecret()).update(encoded).digest("base64url")}`;
}
export function decodeDlqCursor(raw: unknown): DlqCursor | null {
  try {
    if (typeof raw !== "string" || raw.length > MAX_DLQ_CURSOR_BYTES * 2) return null;
    const [encoded, signature, extra] = raw.split(".");
    if (!encoded || !signature || extra) return null;
    const expected = crypto.createHmac("sha256", dlqCursorSecret()).update(encoded).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return value?.v === DLQ_CURSOR_VERSION
      && Number.isSafeInteger(value.snapshotId) && value.snapshotId >= 0
      && Number.isSafeInteger(value.afterId) && value.afterId >= 0 ? value : null;
  } catch { return null; }
}

export function registerReviewQueueRoutes(app: Express) {
  app.get("/api/review-queue/checklist-items", isDashboardUser, requireRole("admin", "manager"), (_req, res) => {
    res.json(REVIEW_CHECKLIST_ITEMS);
  });

  app.get("/api/review-queue/pending-count", isDashboardUser, requireRole("admin", "manager"), async (_req, res) => {
    try {
      const agg = await storage.getReviewQueueAggregates();
      res.json({ count: agg.pending, pending: agg.pending, approved: agg.approved, total: agg.total, deadLetter: agg.deadLetter });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/review-queue", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      if(req.query.status!==undefined&&(typeof req.query.status!=="string"||!["pending","approved"].includes(req.query.status)))
        return res.status(400).json({message:"Invalid review status: one pending or approved value is required"});
      const status = req.query.status as string | undefined;
      // Dead-letter history can hold tens of thousands of rows; it is read through the
      // paged /dead-letter-events route, not mixed into the review list.
      const items = await storage.getReviewQueue(status, { excludeDeadLetters: true });
      res.json(items);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/review-queue/dead-letter-events", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const requestedLimit = Number(req.query.limit ?? 50);
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_DLQ_PAGE_SIZE) {
        return res.status(400).json({ message: "limit must be an integer between 1 and 100" });
      }
      const supplied = req.query.cursor;
      const cursor = supplied == null ? null : decodeDlqCursor(supplied);
      if (supplied != null && !cursor) return res.status(400).json({ message: "Invalid DLQ history cursor" });
      const snapshotId = cursor?.snapshotId ?? await storage.getDeadLetterEventSnapshotId();
      const events = await storage.getDeadLetterEventHistory({ snapshotId, afterId: cursor?.afterId, limit: requestedLimit });
      const last = events[events.length - 1];
      res.json({
        source_type: "dead_letter_job",
        snapshot_id: snapshotId,
        events,
        next_cursor: events.length === requestedLimit && last
          ? encodeDlqCursor({ v: DLQ_CURSOR_VERSION, snapshotId, afterId: last.id })
          : null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Admin-only: move pending dead-letter history for one queue to "archived". Rows are kept,
  // only their status changes. expectedCount must equal the live match count or nothing changes.
  app.post("/api/review-queue/dead-letter-events/archive", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const body = z.object({
        queueName: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
        jobName: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).optional(),
        createdBefore: z.string().datetime(),
        expectedCount: z.number().int().min(0).max(1_000_000),
        dryRun: z.boolean().default(true),
      }).strict().parse(req.body);
      const user = req.user as any;
      // The archive and its audit row commit together; an audit failure rolls the archive back.
      const result = await storage.archiveDeadLetterEvents({
        queueName: body.queueName,
        jobName: body.jobName,
        createdBefore: new Date(body.createdBefore),
        expectedCount: body.expectedCount,
        dryRun: body.dryRun,
        audit: { userId: user?.id ? String(user.id) : undefined },
      });
      if (!result.countMatches) {
        return res.status(409).json({ message: "Live match count differs from expectedCount; nothing was archived", matched: result.matched, expectedCount: body.expectedCount });
      }
      res.json({ dryRun: body.dryRun, matched: result.matched, archived: result.archived });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.get("/api/review-queue/:id", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const item = await storage.getReviewQueueItem(Number(req.params.id));
      if (!item || (item.sourceType === "dead_letter_job" && item.status === "archived")) return res.status(404).json({ message: "Not found" });
      res.json(item.sourceType === "dead_letter_job"
        ? {
            ...item,
            notes: "Dead-letter event; operational details remain in canonical BullMQ retention.",
            metadata: sanitizeDeadLetterEvent(item.metadata),
          }
        : item);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.patch("/api/review-queue/:id/checklist", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const existing = await storage.getReviewQueueItem(Number(req.params.id));
      if (!existing) return res.status(404).json({ message: "Not found" });
      if (existing.status === "approved") {
        return res.status(400).json({ message: "Cannot modify checklist on an already-approved item" });
      }
      const schema = z.object({
        checklistState: z.record(z.boolean()),
      });
      const { checklistState } = schema.parse(req.body);
      const updated = await storage.updateReviewQueueItem(Number(req.params.id), { checklistState });
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.post("/api/review-queue/:id/approve", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const item = await storage.getReviewQueueItem(Number(req.params.id));
      if (!item) return res.status(404).json({ message: "Not found" });
      if (item.status === "approved") return res.status(400).json({ message: "Already approved" });
      if (item.status !== "pending") return res.status(400).json({ message: `Cannot approve an item in ${item.status} status` });

      const totalItems = REVIEW_CHECKLIST_ITEMS.length;
      const checkedItems = REVIEW_CHECKLIST_ITEMS.filter(
        (ci) => (item.checklistState as Record<string, boolean>)?.[ci.key] === true
      ).length;
      if (checkedItems < totalItems) {
        return res.status(400).json({
          message: `All checklist items must be completed before approving. (${checkedItems}/${totalItems} done)`,
        });
      }

      const user = req.user as any;
      const schema = z.object({ ghlWorkflowId: z.string().optional() });
      const { ghlWorkflowId } = schema.parse(req.body);

      // Conditional pending -> approved transition: an item archived since it was read cannot be revived,
      // and the audit row and GHL enrollment below happen only after this transition succeeds.
      const updated = await storage.approveReviewQueueItemIfPending(Number(req.params.id), {
        approvedBy: user?.id ? String(user.id) : "unknown",
        approvedAt: new Date(),
        ghlWorkflowId: ghlWorkflowId || undefined,
      });
      if (!updated) return res.status(409).json({ message: "Item is no longer pending" });

      await storage.createAuditLog({
        userId: user?.id ? String(user.id) : undefined,
        action: "review_queue_approved",
        entityType: "review_queue",
        entityId: item.id,
        details: {
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          approvedBy: user?.email || user?.id,
          ghlWorkflowId: ghlWorkflowId || null,
        },
      });

      if (ghlWorkflowId) {
        const meta = item.metadata as Record<string, any> | null;
        let ghlContactId = meta?.ghlContactId;
        if (!ghlContactId && meta?.contactId) {
          const contact = await storage.getContact(Number(meta.contactId)).catch(() => undefined);
          ghlContactId = contact?.ghlContactId || undefined;
        }
        if (ghlContactId) {
          enrollInGhlWorkflowCompliant({
            workflowKey: ghlWorkflowId,
            ghlContactId,
            contactId: meta?.contactId ? Number(meta.contactId) : undefined,
            metadata: { reviewQueueId: item.id, sourceType: item.sourceType },
          }).catch((err) => console.error("[ReviewQueue] GHL enrollment failed:", err.message));
        } else {
          console.warn(`[ReviewQueue] GHL workflow ${ghlWorkflowId} requested on approval #${item.id} but no ghlContactId found — skipping enrollment`);
        }
      }

      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });
}
