/**
 * CR-04 Outreach Queue routes. Every projection and enrollment action consumes
 * the same scoped channel-qualified authority.
 */
import type { Express, Request } from "express";
import { createHash } from "crypto";
import { isDashboardUser, requireRole } from "../replit_integrations/auth";
import { pool } from "../db";
import { storage } from "../storage";
import { serverError } from "../utils/server-error";
import { invalidPagination, parseStrictPagination } from "../services/crm-object-access";
import {
  CR04_POLICY_VERSION,
  evaluateCr04ChannelQualification,
  freezeCr04Cohort,
  enrollThroughCr04Fence,
  queryCr04ReadyProjection,
  listCr04Assignees,
  type Cr04ActorScope,
  type Cr04Channel,
  type Cr04ReadyFilters,
} from "../services/cr04-cohort-ready-authority";

function actorScope(req: Request): Cr04ActorScope | null {
  const user = req.user as any;
  if (!["admin", "manager", "agent"].includes(user?.role)) return null;
  return {
    role: user.role,
    actorId: String(user.id ?? user.email ?? "unknown"),
    email: typeof user.email === "string" ? user.email : null,
  };
}

function parseChannel(value: unknown): Cr04Channel | null {
  const channel = String(value ?? "email");
  return channel === "email" || channel === "manual_call" || channel === "sms" ? channel : null;
}

function parseFilters(query: Record<string, unknown>, channel: Cr04Channel): Cr04ReadyFilters {
  const score = ["hot", "warm", "cold"].includes(String(query.score)) ? String(query.score) as Cr04ReadyFilters["score"] : undefined;
  return {
    channel,
    score,
    vertical: query.vertical ? String(query.vertical) : undefined,
    city: query.city ? String(query.city) : undefined,
    assignedTo: query.assignedTo ? String(query.assignedTo) : undefined,
  };
}

function parseFreezeFilters(value: unknown, channel: Cr04Channel): Cr04ReadyFilters | null {
  if (value == null) return { channel };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["score", "vertical", "city", "assignedTo", "channel"].includes(key))) return null;
  const string = (key: "vertical" | "city" | "assignedTo") => {
    const value = source[key];
    return value == null || (typeof value === "string" && value.length <= 120);
  };
  if (!string("vertical") || !string("city") || !string("assignedTo") ||
      (source.score != null && !["hot", "warm", "cold"].includes(String(source.score))) ||
      (source.channel != null && source.channel !== channel)) return null;
  return {
    channel,
    score: source.score as Cr04ReadyFilters["score"] | undefined,
    vertical: source.vertical as string | undefined,
    city: source.city as string | undefined,
    assignedTo: source.assignedTo as string | undefined,
  };
}

export function registerOutreachQueueRoutes(app: Express) {
  app.get("/api/outreach-queue", isDashboardUser, async (req, res) => {
    try {
      const scope = actorScope(req);
      if (!scope) return res.status(403).json({ message: "Dashboard role required" });
      const pagination = parseStrictPagination(req.query as Record<string, unknown>, {
        defaultLimit: 50,
        maxLimit: 100,
        page: true,
      });
      if ("error" in pagination) return invalidPagination(res);
      const cursor = req.query.cursor == null ? 0 : Number(req.query.cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return invalidPagination(res);
      const channel = parseChannel(req.query.channel);
      if (!channel) return res.status(400).json({ message: "Invalid channel" });
      const result = await queryCr04ReadyProjection({
        scope,
        filters: parseFilters(req.query as Record<string, unknown>, channel),
        cursor,
        limit: pagination.limit,
      });
      res.json(result);
    } catch (err) {
      serverError(res, err);
    }
  });

  app.get("/api/outreach-queue/count", isDashboardUser, async (req, res) => {
    try {
      const scope = actorScope(req);
      if (!scope) return res.status(403).json({ message: "Dashboard role required" });
      const channel = parseChannel(req.query.channel);
      if (!channel) return res.status(400).json({ message: "Invalid channel" });
      // CR-04 does not support exact counts (qualification requires per-contact
      // evaluation which scales with the full contact set). Return the
      // "incomplete" sentinel immediately — calling queryCr04ReadyProjection
      // with limit:1 was doing 10 sequential DB round-trips to produce the
      // same null total, costing up to 60+ seconds under pool pressure.
      res.json({
        count: null,
        exact: false,
        incomplete: true,
        channel,
        policyVersion: CR04_POLICY_VERSION,
        asOf: new Date().toISOString(),
        reasonBuckets: {},
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  app.get(
    "/api/outreach-queue/assignees",
    isDashboardUser,
    requireRole("admin", "manager"),
    async (req, res) => {
      try {
        const scope = actorScope(req)!;
        const channel = parseChannel(req.query.channel);
        if (!channel) return res.status(400).json({ message: "Invalid channel" });
        res.json({
          assignees: await listCr04Assignees(scope),
          complete: true,
          policyVersion: CR04_POLICY_VERSION,
          channel,
        });
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.get("/api/outreach-queue/:id/explain", isDashboardUser, async (req, res) => {
    try {
      const scope = actorScope(req);
      if (!scope) return res.status(403).json({ message: "Dashboard role required" });
      const contactId = Number(req.params.id);
      if (!Number.isInteger(contactId) || contactId <= 0) return res.status(400).json({ message: "Invalid contact ID" });
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      if (scope.role !== "admin" && contact.assignedTo !== scope.email) {
        return res.status(404).json({ message: "Contact not found" });
      }
      const decisions = await Promise.all(
        (["email", "manual_call", "sms"] as Cr04Channel[]).map((channel) =>
          evaluateCr04ChannelQualification(contactId, { channel, scope }),
        ),
      );
      res.json({
        contactId,
        policyVersion: CR04_POLICY_VERSION,
        decisions,
        blocked: decisions.every((decision) => !decision.qualified),
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  app.post(
    "/api/outreach-queue/cohorts/freeze",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      try {
        const scope = actorScope(req)!;
        const channel = parseChannel(req.body?.channel);
        if (!channel) return res.status(400).json({ message: "Invalid channel" });
        const idempotencyKey = req.header("Idempotency-Key");
        if (!idempotencyKey || idempotencyKey.length > 200) {
          return res.status(400).json({ message: "Idempotency-Key is required" });
        }
        const filters = parseFreezeFilters(req.body?.filters, channel);
        if (!filters) return res.status(400).json({ message: "Invalid cohort filters" });
        const run = await freezeCr04Cohort({
          scope,
          channel,
          filters,
          idempotencyKey,
          createdBy: scope.actorId,
        });
        res.status(run.status === "frozen" ? 201 : 202).json(run);
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.post(
    "/api/outreach-queue/cohorts/:id/cancel",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      try {
        const id = String(req.params.id);
        if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ message: "Invalid cohort ID" });
        const result = await pool.query(
          `UPDATE cr04_cohort_runs
              SET status='cancelled', cancelled_at=COALESCE(cancelled_at,NOW())
             WHERE id=$1 AND status IN ('building','frozen','cancelled')
            RETURNING id,status,cancelled_at AS "cancelledAt"`,
          [id],
        );
        if (!result.rows[0]) return res.status(409).json({ message: "Cohort is not cancellable" });
        res.json(result.rows[0]);
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.post("/api/outreach-queue/:id/start", isDashboardUser, async (req, res) => {
    try {
      const scope = actorScope(req);
      if (!scope) return res.status(403).json({ message: "Dashboard role required" });
      const contactId = Number(req.params.id);
      if (!Number.isInteger(contactId) || contactId <= 0) return res.status(400).json({ message: "Invalid contact ID" });
      const channel = parseChannel(req.body?.channel);
      if (!channel) return res.status(400).json({ message: "Invalid channel" });
      const sequenceId = Number(req.body?.sequenceId);
      if (!Number.isInteger(sequenceId) || sequenceId <= 0) {
        return res.status(400).json({ message: "A server-qualified sequenceId is required" });
      }
      const idempotencyKey = req.header("Idempotency-Key");
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return res.status(400).json({ message: "Idempotency-Key is required" });
      }
      // Email uses the current canonical preparation authority, which needs no frozen cohort.
      // Other channels still require one.
      const cohortRunId = typeof req.body?.cohortRunId === "string" ? req.body.cohortRunId : null;
      if (channel !== "email" && !cohortRunId) {
        return res.status(422).json({ message: "A current frozen cohort is required" });
      }
      const result = await enrollThroughCr04Fence({
        contactId,
        sequenceId,
        channel,
        idempotencyKey,
        source: "outreach_queue",
        actor: scope,
        cohortRunId,
      });
      if ((result as any).blocked) {
        return res.status(422).json({
          message: "Contact is not currently qualified for this channel",
          decision: (result as any).decision,
        });
      }

      const enrollmentId = result.enrollmentId;
      const contact = await storage.getContact(contactId);
      if (contact?.outreachQueueSkippedAt) {
        await pool.query("UPDATE contacts SET outreach_queue_skipped_at=NULL WHERE id=$1", [contactId]);
      }
      await storage.createAuditLog({
        action: "cr04_promotional_enrollment",
        entityType: "contact",
        entityId: contactId,
        userId: (req.user as any)?.id ?? null,
        details: {
          source: "outreach_queue",
          channel,
          sequenceId,
          enrollmentId,
          policyVersion: CR04_POLICY_VERSION,
          idempotencyKeyHash: createHash("sha256").update(idempotencyKey).digest("hex"),
          replayed: result.replayed,
        },
      });
      res.json({
        success: true,
        accepted: (result as any).accepted ?? false,
        replayed: result.replayed,
        enrollmentId,
        sequenceId,
        alreadyEnrolled: (result as any).alreadyEnrolled ?? false,
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  app.post("/api/outreach-queue/:id/skip", isDashboardUser, async (req, res) => {
    try {
      const scope = actorScope(req);
      if (!scope) return res.status(403).json({ message: "Dashboard role required" });
      const contactId = Number(req.params.id);
      if (!Number.isInteger(contactId) || contactId <= 0) return res.status(400).json({ message: "Invalid contact ID" });
      const contact = await storage.getContact(contactId);
      if (!contact || (scope.role !== "admin" && contact.assignedTo !== scope.email)) {
        return res.status(404).json({ message: "Contact not found" });
      }
      await pool.query("UPDATE contacts SET outreach_queue_skipped_at=NOW() WHERE id=$1", [contactId]);
      await storage.createAuditLog({
        action: "outreach_queue_skip",
        entityType: "contact",
        entityId: contactId,
        userId: (req.user as any)?.id ?? null,
        details: { source: "outreach_queue", policyVersion: CR04_POLICY_VERSION },
      });
      res.json({ success: true });
    } catch (err) {
      serverError(res, err);
    }
  });
}