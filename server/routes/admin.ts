import type { Express } from "express";
import { publicUser } from "@shared/public-user";
import { commandAccount, AccountCommandError } from "../services/account-lifecycle";
import { isAuthenticated, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { authStorage } from "../replit_integrations/auth/storage";
import { storage } from "../storage";
import { db, pool } from "../db";
import { auditChange } from "../services/audit-change";
import { z } from "zod";
import { insertAgentMerchantSchema, insertAgentQuotaSchema, insertAgentSchema, insertConsentAuditLogSchema, insertDataDeleteRequestSchema, insertHealthAlertSchema, insertResidualReportSchema, insertReviewRequestSchema, insertSendingIdentitySchema, ALLOWED_SENDING_DOMAINS, users, contacts, deals, auditLogs, automationRegistry, merchantMids, insertMerchantMidSchema } from "@shared/schema";
import { createMerchantMid, updateMerchantMid, writeMidAccessReceipt } from "../services/merchant-mid-service";
import { desc, eq, isNull, and, gte, or, like, count, not, sql } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import path from "path";
import { publicLeadRateLimit } from "../middleware/public-rate-limit";
import { sendSmtpEmail, getSmtpStatus, isSmtpConfigured } from "../services/smtp-email";
import { getWorkflowRegistryWithStatus } from "../services/ghl-workflows";
import { summarizeChannelSafety } from "../services/contactability";
import { classifyEligibility } from "../services/deal-eligibility";
import { serverError, safeMessage } from "../utils/server-error";
import { requireGhlRouteMutationAllowed } from "./ghl-mutation-pause";
import { authorizeDealAccess, denyCrmObject } from "../services/crm-object-access";

import { getPilotRepIdsAsync, invalidatePilotCache } from "./field-territories";
import { registerContactLinkCoverageRoutes } from "./contact-link-coverage";
import {registerImportLockDiagnosticRoutes} from "./import-lock-diagnostics";
import {registerTestimonialRoutes} from "./testimonials";

export function registerAdminRoutes(app: Express) {
  registerContactLinkCoverageRoutes(app);
  registerImportLockDiagnosticRoutes(app);

  app.get("/api/admin/contact-business-matches/preview", isDashboardUser, requireRole("admin"), async (req, res) => {
    const parsed = z.object({
      afterContactId: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(25).default(25),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ message: "Invalid matching preview parameters" });
    try {
      const { previewCorroboratedContactBusinessLinks } = await import("../services/contact-business-corroborated-links");
      res.json(await previewCorroboratedContactBusinessLinks(parsed.data));
    } catch (error) { serverError(res, error); }
  });
  app.post("/api/admin/contact-business-matches/confirm", isDashboardUser, requireRole("admin"), async (req, res) => {
    const parsed = z.object({ items: z.array(z.object({
      contactId: z.number().int().positive(), businessId: z.number().int().positive(),
      snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict()).min(1).max(25) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid company match confirmation" });
    try {
      const { confirmCorroboratedContactBusinessLink } = await import("../services/contact-business-corroborated-links");
      const outcomes = [];
      for (const item of parsed.data.items) {
        outcomes.push(await confirmCorroboratedContactBusinessLink(item, String((req.user as any).id)));
      }
      await auditChange({
        userId: String((req.user as any).id), action: "corroborated_company_matches_confirmed",
        entityType: "contact_business_link_batch", entityKey: "batch",
        after: { outcomes, rule: "company_contact_corroboration_v2" },
      });
      res.json({ outcomes, paidProviderCalls: 0 });
    } catch (error) { serverError(res, error); }
  });

  app.get(
    "/api/admin/contact-business-system-links/preview",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      const afterContactId = req.query.afterContactId === undefined ? 0 : Number(req.query.afterContactId);
      const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
      if (!Number.isSafeInteger(afterContactId) || afterContactId < 0) {
        return res.status(400).json({ message: "afterContactId must be a non-negative integer" });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
        return res.status(400).json({ message: "limit must be an integer between 1 and 25" });
      }
      try {
        const { previewContactBusinessSystemLinks } = await import("../services/contact-business-system-links");
        const preview = await previewContactBusinessSystemLinks({ afterContactId, limit });
        res.json(preview);
      } catch (err) {
        if ((err as Error)?.message === "COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING") {
          return res.status(409).json({ message: "SFP contact-link database contracts are not installed on this environment" });
        }
        serverError(res, err);
      }
    },
  );

  app.post(
    "/api/admin/contact-business-system-links/apply",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      const parsed = z.object({
        items: z.array(z.object({
          contactId: z.number().int().positive(),
          businessId: z.number().int().positive(),
          sourceLinkId: z.string().uuid(),
          sourceEntityId: z.number().int().positive().nullable(),
          snapshotHash: z.string().regex(/^[a-f0-9]{64}$/i),
        }).strict()).min(1).max(25),
      }).strict().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid system link apply request", errors: parsed.error.errors });
      }
      try {
        // Reject an unready batch before applying any link or writing its audit.
        const { assertSystemLinkDatabaseGuard } = await import("../services/commercial-link-authority");
        await assertSystemLinkDatabaseGuard(db);
        const { applyContactBusinessSystemLink } = await import("../services/contact-business-system-links");
        const outcomes = [];
        for (const item of parsed.data.items) {
          outcomes.push(await applyContactBusinessSystemLink(item));
        }
        if (outcomes.some((outcome: any) => outcome.code === "COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING")) {
          return res.status(409).json({
            message: "SFP contact-link database contracts changed during apply; inspect per-item outcomes",
            outcomes,
            writes: outcomes.filter((outcome: any) => outcome.status === "applied").length,
            paidProviderCalls: 0,
          });
        }
        await auditChange({
          userId: String((req.user as any)?.id ?? ""),
          action: "contact_business_system_link_batch_applied",
          entityType: "contact_business_system_link_batch",
          entityKey: parsed.data.items.map(item => item.contactId).join(","),
          details: {
            outcomes: outcomes.map((outcome: any) => ({
              contactId: outcome.contactId, businessId: outcome.businessId ?? null,
              status: outcome.status, code: outcome.code ?? null, decisionId: outcome.decisionId ?? null,
            })),
            paidProviderCalls: 0,
          },
        });
        res.json({
          outcomes,
          writes: outcomes.filter((outcome: any) => outcome.status === "applied").length,
          paidProviderCalls: 0,
        });
      } catch (err) {
        if ((err as Error)?.message === "COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING") {
          return res.status(409).json({ message: "SFP contact-link database contracts are not installed on this environment" });
        }
        serverError(res, err);
      }
    },
  );

  // ── Field Sales Pilot management ──────────────────────────────────────────
  // GET  /api/admin/field-sales-pilot  — list all reps with pilot status
  app.get("/api/admin/field-sales-pilot", requireRole("admin", "manager"), async (req, res) => {
    try {
      const [pilotIds, repUsers] = await Promise.all([
        getPilotRepIdsAsync(),
        storage.getUsersByRole(["admin", "manager", "agent"]),
      ]);
      const pilotSet = new Set(pilotIds);
      const reps = repUsers.map((u) => ({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        inPilot: pilotSet.has(u.id),
      }));
      res.json({ reps, pilotIds });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PUT /api/admin/field-sales-pilot/:userId  — toggle a rep's pilot membership
  app.put("/api/admin/field-sales-pilot/:userId", requireRole("admin", "manager"), async (req, res) => {
    try {
      const targetUserId = String(req.params.userId);
      const { enabled } = req.body as { enabled: boolean };
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }

      const current = await getPilotRepIdsAsync();
      const currentSet = new Set(current);
      if (enabled) {
        currentSet.add(targetUserId);
      } else {
        currentSet.delete(targetUserId);
      }
      const next = Array.from(currentSet);
      await storage.setSystemSetting("field_pilot_reps", next);
      invalidatePilotCache();

      await storage.createAuditLog({
        action: enabled ? "field_pilot_rep_added" : "field_pilot_rep_removed",
        entityType: "user",
        entityId: 0,
        actorType: "admin",
        details: { targetUserId, enabled, actorId: (req.user as any)?.id ?? null },
      }).catch(() => {});

      res.json({ ok: true, pilotIds: next });
    } catch (err: any) {
      serverError(res, err);
    }
  });
  // === ADMIN: SESSION MANAGEMENT ===
  app.get("/api/admin/users/:id/sessions", requireRole('admin'), async (req, res) => {
    try {
      const sessions = await authStorage.getActiveSessionsForUser(String(String(req.params.id)));
      res.json(sessions);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.delete("/api/admin/sessions/:sessionRecordId", requireRole('admin'), async (req, res) => {
    try {
      await authStorage.revokeSessionById(String(req.params.sessionRecordId));
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.delete("/api/admin/users/:id/sessions", requireRole('admin'), async (req, res) => {
    try {
      await authStorage.invalidateAllUserSessions(String(String(req.params.id)));
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === ADMIN: USER MANAGEMENT ===
  app.get("/api/admin/users", requireRole('admin'), async (req, res) => {
    try {
      const allUsers = await db.select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        authProvider: users.authProvider,
        emailVerified: users.emailVerified,
        totpEnabled: users.totpEnabled,
        permissions: users.permissions,
        accountState: users.accountState,
        accountVersion: users.accountVersion,
        createdAt: users.createdAt,
      }).from(users).orderBy(desc(users.createdAt));
      res.json(allUsers);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/admin/mfa-settings", requireRole('admin'), async (req, res) => {
    try {
      const { systemSettings } = await import("@shared/schema");
      const { eq: eqOp } = await import("drizzle-orm");
      const [setting] = await db.select().from(systemSettings).where(eqOp(systemSettings.key, "mfa_required"));
      res.json({ mfaRequired: setting?.value === true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/admin/mfa-settings", requireRole('admin'), async (req, res) => {
    try {
      const { mfaRequired } = req.body;
      if (typeof mfaRequired !== 'boolean') return res.status(400).json({ message: "mfaRequired must be a boolean" });
      const { systemSettings } = await import("@shared/schema");
      const { eq: eqOp } = await import("drizzle-orm");
      await db.insert(systemSettings).values({ key: "mfa_required", value: mfaRequired }).onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: mfaRequired, updatedAt: new Date() },
      });
      res.json({ mfaRequired });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === PCI ASSESSMENT CHECKLIST ===
  const PCI_ASSESSMENT_SETTINGS_KEY = "pci_assessment_checklist_state";

  app.get("/api/admin/pci-assessment", isDashboardUser, async (req, res) => {
    try {
      const { systemSettings } = await import("@shared/schema");
      const { eq: eqOp } = await import("drizzle-orm");
      const [setting] = await db.select().from(systemSettings).where(eqOp(systemSettings.key, PCI_ASSESSMENT_SETTINGS_KEY));
      const value = (setting?.value as { checkedRequirementIds?: string[]; updatedAt?: string; updatedBy?: string } | null) ?? null;
      res.json({
        checkedRequirementIds: Array.isArray(value?.checkedRequirementIds) ? value!.checkedRequirementIds : [],
        updatedAt: value?.updatedAt ?? null,
        updatedBy: value?.updatedBy ?? null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.patch("/api/admin/pci-assessment", isDashboardUser, async (req, res) => {
    try {
      const { checkedRequirementIds } = req.body || {};
      if (!Array.isArray(checkedRequirementIds) || !checkedRequirementIds.every((id: unknown) => typeof id === "string")) {
        return res.status(400).json({ message: "checkedRequirementIds must be an array of strings" });
      }
      const { PCI_REQUIREMENT_ID_SET } = await import("@shared/pci-requirements");
      const unknownIds = checkedRequirementIds.filter((id: string) => !PCI_REQUIREMENT_ID_SET.has(id));
      if (unknownIds.length > 0) {
        return res.status(400).json({ message: `Unknown PCI requirement id(s): ${unknownIds.join(", ")}` });
      }
      const { systemSettings } = await import("@shared/schema");
      const dedupedIds = Array.from(new Set(checkedRequirementIds));
      const value = {
        checkedRequirementIds: dedupedIds,
        updatedAt: new Date().toISOString(),
        updatedBy: (req.user as any)?.id ?? null,
      };
      await db.insert(systemSettings).values({ key: PCI_ASSESSMENT_SETTINGS_KEY, value }).onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
      res.json(value);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/users/:id/reset-2fa", requireRole('admin'), async (req, res) => {
    try {
      const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(req.body);
      const result = await commandAccount({ actorId: String((req.user as any).id), userId: String(req.params.id),
        expectedVersion, action: "reset_mfa" });
      res.json(result.user);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof AccountCommandError) return res.status(err.status).json({ message: err.message });
      serverError(res, err);
    }
  });

  app.put("/api/admin/users/:id/role", requireRole('admin'), async (req, res) => {
    try {
      const { role, expectedVersion } = z.object({ role: z.enum(["admin", "manager", "agent", "merchant"]),
        expectedVersion: z.number().int().positive() }).strict().parse(req.body);
      const result = await commandAccount({ actorId: String((req.user as any).id), userId: String(req.params.id),
        expectedVersion, action: "role", role });
      res.json(result.user);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof AccountCommandError) return res.status(err.status).json({ message: err.message });
      serverError(res, err);
    }
  });

  app.post("/api/admin/users/:id/lifecycle", requireRole("admin"), async (req, res) => {
    try {
      const { action, expectedVersion } = z.object({ action: z.enum(["deactivate", "reactivate"]),
        expectedVersion: z.number().int().positive() }).strict().parse(req.body);
      res.json(await commandAccount({ actorId: String((req.user as any).id), userId: String(req.params.id),
        action, expectedVersion }));
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof AccountCommandError) return res.status(err.status).json({ message: err.message });
      serverError(res, err);
    }
  });

  // === AGENTS ===
  app.get("/api/agents", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const agentsList = await storage.getAgents();
      res.json(agentsList);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /** GET /api/agents/readiness — per-agent readiness report (manager/admin only) */
  app.get("/api/agents/readiness", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const allAgents = await storage.getAgents();
      const today = new Date();
      const { agentQuotas, tasks: tasksTable, callLogs: callLogsTable, contacts: contactsTable } = await import("@shared/schema");
      const { lte: lteOp, isNotNull: isNotNullOp } = await import("drizzle-orm");

      const report = await Promise.all(allAgents.map(async (agent) => {
        const reasons: string[] = [];
        // 1. Binding check
        let userRole: string | null = null;
        if (!agent.userId) {
          reasons.push("unbound");
        } else {
          const [userRow] = await db.select({ role: users.role })
            .from(users).where(eq(users.id, agent.userId)).limit(1);
          if (!userRow) {
            reasons.push("user_missing");
          } else {
            userRole = userRow.role ?? null;
            if (userRow.role !== "agent") reasons.push("wrong_role");
          }
        }
        // 2. Quota check
        const quotaRows = await db.select().from(agentQuotas).where(eq(agentQuotas.agentId, agent.id));
        const activeQuota = quotaRows.find(q => {
          const s = new Date(q.periodStart), e = new Date(q.periodEnd);
          return today >= s && today <= e;
        });
        if (!activeQuota) reasons.push("no_quota");
        // 3. Territory
        if (!agent.territory) reasons.push("no_territory");
        // 4. Assignment count
        const [assignCount] = await db.select({ count: sql<number>`cast(count(*) as integer)` })
          .from(contactsTable)
          .where(and(eq(contactsTable.assignedTo, agent.email), isNull(contactsTable.archivedAt)));
        const assignmentCount = assignCount?.count ?? 0;
        // 5. CR-04 eligible count (manual_call channel)
        let cr04EligibleCount: number | null = null;
        try {
          const { evaluateCr04ChannelQualification } = await import("../services/cr04-cohort-ready-authority");
          const assignedContacts = await db.select({ id: contactsTable.id })
            .from(contactsTable)
            .where(and(eq(contactsTable.assignedTo, agent.email), isNull(contactsTable.archivedAt)))
            .limit(200);
          let eligible = 0;
          await Promise.all(assignedContacts.map(async (c) => {
            try {
              const dec = await evaluateCr04ChannelQualification(c.id, { channel: "manual_call" });
              if (dec.decision === "qualified") eligible++;
            } catch { /* skip */ }
          }));
          cr04EligibleCount = eligible;
        } catch { cr04EligibleCount = null; }
        // 6. Overdue tasks
        const [overdueResult] = await db.select({ count: sql<number>`cast(count(*) as integer)` })
          .from(tasksTable)
          .where(and(
            or(eq(tasksTable.assignedTo, agent.email), eq(tasksTable.assignedTo, `${agent.firstName} ${agent.lastName}`)),
            lteOp(tasksTable.dueDate, today),
            or(eq(tasksTable.status, "pending"), eq(tasksTable.status, "in_progress")),
          ));
        const overdueTasksCount = overdueResult?.count ?? 0;
        // 7. Last activity
        const [lastCallRow] = await db.select({ createdAt: callLogsTable.createdAt })
          .from(callLogsTable)
          .leftJoin(contactsTable, eq(callLogsTable.contactId, contactsTable.id))
          .where(eq(contactsTable.assignedTo, agent.email))
          .orderBy(desc(callLogsTable.createdAt))
          .limit(1);
        const lastActivityAt = lastCallRow?.createdAt ?? null;
        const ready = reasons.length === 0;
        return {
          agentId: agent.id,
          name: `${agent.firstName} ${agent.lastName}`,
          email: agent.email,
          status: agent.status,
          territory: agent.territory ?? null,
          ready,
          reasons,
          assignmentCount,
          cr04EligibleCount,
          overdueTasksCount,
          lastActivityAt,
        };
      }));
      res.json(report);
    } catch (err: any) { serverError(res, err); }
  });

  /** GET /api/agents/rep-metrics — per-agent call/appointment/task stats with optional date-range filter */
  app.get("/api/agents/rep-metrics", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const { gte: gteOp, lt: ltOp } = await import("drizzle-orm");
      const { callLogs: callLogsTable, calendarEvents: calendarEventsTable, tasks: tasksTable, contacts: contactsTable, agents: agentsTable } = await import("@shared/schema");

      // Date range: default "this week"
      const rangeParam = (req.query.range as string) ?? "week";
      const customFrom = req.query.from as string | undefined;
      const customTo = req.query.to as string | undefined;

      function getRangeBounds(range: string): { from: Date; to: Date } {
        const now = new Date();
        if (range === "custom" && customFrom && customTo) {
          const fromDate = new Date(customFrom + "T00:00:00");
          const toDate = new Date(customTo + "T00:00:00");
          toDate.setDate(toDate.getDate() + 1); // exclusive upper bound — makes end-date inclusive
          return { from: fromDate, to: toDate };
        }
        if (range === "month") {
          const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
          const to = new Date(now);
          to.setDate(to.getDate() + 1);
          to.setHours(0, 0, 0, 0);
          return { from, to };
        }
        // default: this week (Mon–end of today)
        const day = now.getDay(); // 0=Sun
        const diff = (day === 0 ? -6 : 1 - day);
        const from = new Date(now);
        from.setDate(now.getDate() + diff);
        from.setHours(0, 0, 0, 0);
        const to = new Date(now);
        to.setDate(to.getDate() + 1);
        to.setHours(0, 0, 0, 0);
        return { from, to };
      }

      const { from, to } = getRangeBounds(rangeParam);

      // Canonical call outcome values persisted by LogCallSheet.tsx:
      //   Connected, Connected - Interested, Connected - Not a Fit,
      //   Connected - Send Review Summary, Connected - Needs Proposal → human conversation
      //   Left VM → voicemail
      //   No Answer → no answer
      function classifyOutcome(outcome: string | null): "human_conversation" | "voicemail" | "no_answer" | "other" {
        if (!outcome) return "other";
        if (outcome.startsWith("Connected")) return "human_conversation";
        if (outcome === "Left VM") return "voicemail";
        if (outcome === "No Answer") return "no_answer";
        return "other";
      }

      const allAgents = await db.select().from(agentsTable).orderBy(agentsTable.lastName);

      const report = await Promise.all(allAgents.map(async (agent) => {
        const agentEmail = agent.email;
        // calendar_events.owner_id stores users.id (see activity.ts:728)
        const agentUserId = agent.userId ?? null;

        // ── Call log counts by outcome (outbound only, assigned contacts) ──
        let callsByOutcome: Record<string, number> | null = null;
        try {
          const rows = await db
            .select({ outcome: callLogsTable.outcome, count: sql<number>`cast(count(*) as integer)` })
            .from(callLogsTable)
            .leftJoin(contactsTable, eq(callLogsTable.contactId, contactsTable.id))
            .where(
              and(
                eq(contactsTable.assignedTo, agentEmail),
                eq(callLogsTable.direction, "outbound"),
                gteOp(callLogsTable.createdAt, from),
                ltOp(callLogsTable.createdAt, to),
              )
            )
            .groupBy(callLogsTable.outcome);

          callsByOutcome = {};
          let totalCalls = 0;
          let humanConversation = 0;
          let voicemail = 0;
          let noAnswer = 0;
          for (const r of rows) {
            const key = r.outcome ?? "unknown";
            callsByOutcome[key] = r.count;
            totalCalls += r.count;
            const bucket = classifyOutcome(r.outcome);
            if (bucket === "human_conversation") humanConversation += r.count;
            else if (bucket === "voicemail") voicemail += r.count;
            else if (bucket === "no_answer") noAnswer += r.count;
          }
          callsByOutcome._total = totalCalls;
          callsByOutcome.human_conversation = humanConversation;
          callsByOutcome.voicemail_or_no_answer = voicemail + noAnswer;
        } catch {
          callsByOutcome = null;
        }

        // ── Calendar event counts by status (attributed via users.id) ──
        let appointmentsByStatus: Record<string, number> | null = null;
        try {
          if (!agentUserId) {
            // Unbound agents have no calendar events to count
            appointmentsByStatus = { _total: 0, scheduled: 0, completed: 0, no_show: 0, cancelled: 0 };
          } else {
            const rows = await db
              .select({ status: calendarEventsTable.status, count: sql<number>`cast(count(*) as integer)` })
              .from(calendarEventsTable)
              .where(
                and(
                  eq(calendarEventsTable.ownerId, agentUserId),
                  gteOp(calendarEventsTable.startTime, from),
                  ltOp(calendarEventsTable.startTime, to),
                )
              )
              .groupBy(calendarEventsTable.status);
            appointmentsByStatus = {};
            let total = 0;
            for (const r of rows) {
              const key = r.status ?? "unknown";
              appointmentsByStatus[key] = r.count;
              total += r.count;
            }
            appointmentsByStatus._total = total;
          }
        } catch {
          appointmentsByStatus = null;
        }

        // ── Task completion counts ──
        let taskStats: { completed: number; pending: number; overdue: number } | null = null;
        try {
          const agentFullName = `${agent.firstName} ${agent.lastName}`;
          const [completed] = await db
            .select({ count: sql<number>`cast(count(*) as integer)` })
            .from(tasksTable)
            .where(
              and(
                or(eq(tasksTable.assignedTo, agentEmail), eq(tasksTable.assignedTo, agentFullName)),
                eq(tasksTable.status, "completed"),
                gteOp(tasksTable.completedAt, from),
                ltOp(tasksTable.completedAt, to),
              )
            );
          const [pending] = await db
            .select({ count: sql<number>`cast(count(*) as integer)` })
            .from(tasksTable)
            .where(
              and(
                or(eq(tasksTable.assignedTo, agentEmail), eq(tasksTable.assignedTo, agentFullName)),
                or(eq(tasksTable.status, "pending"), eq(tasksTable.status, "in_progress")),
              )
            );
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const [overdue] = await db
            .select({ count: sql<number>`cast(count(*) as integer)` })
            .from(tasksTable)
            .where(
              and(
                or(eq(tasksTable.assignedTo, agentEmail), eq(tasksTable.assignedTo, agentFullName)),
                or(eq(tasksTable.status, "pending"), eq(tasksTable.status, "in_progress")),
                ltOp(tasksTable.dueDate, todayStart),
              )
            );
          taskStats = {
            completed: completed?.count ?? 0,
            pending: pending?.count ?? 0,
            overdue: overdue?.count ?? 0,
          };
        } catch {
          taskStats = null;
        }

        return {
          agentId: agent.id,
          name: `${agent.firstName} ${agent.lastName}`,
          email: agentEmail,
          status: agent.status,
          boundUserId: agentUserId,
          callsByOutcome,
          appointmentsByStatus,
          taskStats,
        };
      }));

      res.json({ range: rangeParam, from: from.toISOString(), to: to.toISOString(), agents: report });
    } catch (err: any) { serverError(res, err); }
  });

  app.get("/api/agents/:id", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const agent = await storage.getAgent(Number(String(req.params.id)));
      if (!agent) return res.status(404).json({ message: "Not found" });
      res.json(agent);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/agents", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const body = { ...req.body };
      if (body.hireDate && typeof body.hireDate === 'string') { body.hireDate = new Date(body.hireDate); }
      const input = insertAgentSchema.parse(body);
      const agent = await storage.createAgent(input);
      res.status(201).json(agent);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      serverError(res, err);
    }
  });

  app.patch("/api/agents/:id", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const body = { ...req.body };
      if (body.hireDate && typeof body.hireDate === 'string') { body.hireDate = new Date(body.hireDate); }
      const updated = await storage.updateAgent(Number(String(req.params.id)), body);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.delete("/api/agents/:id", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const agent = await storage.getAgent(Number(String(req.params.id)));
      if (!agent) return res.status(404).json({ message: "Not found" });
      res.status(409).json({ message: "Rep profile retirement does not deactivate its login. Use User Management's recoverable account controls.", code: "ACCOUNT_LIFECYCLE_COMMAND_REQUIRED" });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === AGENT BINDING (Rep Identity) ===

  /** GET /api/agents/:id/binding-status — returns binding state for a single agent */
  app.get("/api/agents/:id/binding-status", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const agentId = Number(String(req.params.id));
      if (!Number.isInteger(agentId) || agentId <= 0) return res.status(400).json({ message: "Invalid agent id" });
      const agent = await storage.getAgent(agentId);
      if (!agent) return res.status(404).json({ message: "Not found" });
      if (!agent.userId) return res.json({ status: "unbound" });
      const [userRow] = await db.select({ id: users.id, email: users.email, role: users.role })
        .from(users).where(eq(users.id, agent.userId)).limit(1);
      if (!userRow) return res.json({ status: "conflict", reason: "user_missing" });
      const status = userRow.role === "agent" ? "bound" : "conflict";
      res.json({
        status,
        userEmail: userRow.email,
        userRole: userRow.role,
        boundAt: agent.updatedAt,
      });
    } catch (err: any) { serverError(res, err); }
  });

  /** POST /api/agents/:id/bind-user — preview or commit user→agent binding */
  app.post("/api/agents/:id/bind-user", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const agentId = Number(String(req.params.id));
      if (!Number.isInteger(agentId) || agentId <= 0) return res.status(400).json({ message: "Invalid agent id" });
      const schema = z.object({ userId: z.string().min(1), previewOnly: z.boolean() });
      const { userId, previewOnly } = schema.parse(req.body);
      const [agent, userRow] = await Promise.all([
        storage.getAgent(agentId),
        db.select({ id: users.id, email: users.email, role: users.role })
          .from(users).where(eq(users.id, userId)).limit(1).then(r => r[0] ?? null),
      ]);
      if (!agent) return res.status(404).json({ message: "Agent not found" });
      if (!userRow) return res.status(400).json({ message: "User not found" });
      if (userRow.role !== "agent") return res.status(400).json({ message: `User role is '${userRow.role}'; must be 'agent' to bind` });
      // Check for conflicting active binding on another agent
      const conflictRows = await db.execute(sql`
        SELECT id, first_name, last_name FROM agents
        WHERE user_id = ${userId} AND status = 'active' AND id != ${agentId}
        LIMIT 1
      `);
      const conflict = (conflictRows as any).rows?.[0];
      if (conflict) {
        return res.status(409).json({
          message: `User ${userRow.email} is already bound to active agent #${conflict.id} (${conflict.first_name} ${conflict.last_name}). Deactivate that agent first or rebind to a different user.`,
          conflictAgentId: conflict.id,
        });
      }
      if (previewOnly) {
        return res.json({
          preview: true,
          agentId,
          userId,
          userEmail: userRow.email,
          agentName: `${agent.firstName} ${agent.lastName}`,
          currentUserId: agent.userId ?? null,
          valid: true,
        });
      }
      // Commit
      await storage.updateAgent(agentId, { userId } as any);
      await auditChange({
        actorType: "user",
        userId: (req.user as any)?.id ?? null,
        action: "agent_user_bound",
        entityType: "agent",
        entityId: agentId,
        before: { userId: agent.userId ?? null },
        after: { userId },
      });
      res.json({ success: true, agentId, userId, userEmail: userRow.email });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if ((err as any)?.code === "23505") return res.status(409).json({ message: "This user is already bound to an active agent." });
      serverError(res, err);
    }
  });



  // === AGENT QUOTAS ===
  app.get("/api/agent-quotas", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const quotas = await storage.getAgentQuotas();
      res.json(quotas);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/agent-quotas", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const input = insertAgentQuotaSchema.parse(req.body);
      const quota = await storage.createAgentQuota(input);
      res.status(201).json(quota);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      serverError(res, err);
    }
  });

  app.put("/api/agent-quotas/:id", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const updated = await storage.updateAgentQuota(Number(String(req.params.id)), req.body);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === AGENT MERCHANTS (admin/manager only) ===
  app.get("/api/agent-merchants", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const agentId = req.query.agentId ? Number(req.query.agentId) : undefined;
      const rows = await storage.getAgentMerchants(agentId);
      // REV-05A: Mask MID in agent-merchant list response.
      const { maskMid } = await import("../utils/mask-mid");
      res.json(rows.map((r: any) => ({ ...r, mid: maskMid(r.mid), hasMid: !!r.mid })));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/agent-merchants/deal/:dealId", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const rows = await storage.getAgentMerchantsByDeal(Number(req.params.dealId));
      const row = rows[0] ?? null;
      if (!row) return res.json(null);
      // REV-05A: Mask MID in agent-merchant detail response.
      const { maskMid } = await import("../utils/mask-mid");
      res.json({ ...row, mid: maskMid(row.mid), hasMid: !!row.mid });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/agent-merchants/deal/:dealId/assign", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const dealId = Number(req.params.dealId);
      const { agentId } = req.body;

      const existing = await storage.getAgentMerchantsByDeal(dealId);
      for (const row of existing) {
        await storage.unassignMerchantFromAgent(row.id);
      }

      if (!agentId) {
        return res.json({ success: true, assignment: null });
      }

      const agent = await storage.getAgent(Number(agentId));
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      let merchantName: string | undefined;
      if (deal.contactId) {
        const contact = await storage.getContact(deal.contactId);
        if (contact) {
          merchantName = contact.companyName || `${contact.firstName} ${contact.lastName}`.trim() || undefined;
        }
      }

      const row = await storage.assignMerchantToAgent({
        agentId: Number(agentId),
        dealId,
        merchantName,
        mid: deal.mid || undefined,
      });
      // REV-05A: Mask MID in assignment response.
      const { maskMid: _maskMidAssign } = await import("../utils/mask-mid");
      const safeRow = { ...row, mid: _maskMidAssign((row as any).mid), hasMid: !!(row as any).mid };
      res.json({ success: true, assignment: safeRow });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/agent-merchants", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const input = insertAgentMerchantSchema.parse(req.body);
      const existingAssignments = await storage.getAgentMerchantsByDeal(input.dealId);
      if (existingAssignments.length > 0) {
        return res.status(409).json({ message: "Merchant is already assigned to an agent. Unassign it first." });
      }
      const row = await storage.assignMerchantToAgent(input);
      // REV-05A: Mask MID in agent-merchant create response.
      const { maskMid: _maskMidCreate } = await import("../utils/mask-mid");
      res.status(201).json({ ...row, mid: _maskMidCreate((row as any).mid), hasMid: !!(row as any).mid });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      serverError(res, err);
    }
  });

  app.patch("/api/agent-merchants/:id", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const { mid, merchantName } = req.body || {};
      const updates: Record<string, unknown> = {};
      if (mid !== undefined) updates.mid = mid === "" ? null : mid;
      if (merchantName !== undefined) updates.merchantName = merchantName === "" ? null : merchantName;
      if (Object.keys(updates).length === 0) return res.status(400).json({ message: "No editable fields supplied" });
      const updated = await storage.updateAgentMerchant(Number(String(req.params.id)), updates as any);
      if (!updated) return res.status(404).json({ message: "Not found" });
      // REV-05A: Mask MID in agent-merchant update response.
      const { maskMid: _maskMidUpdate } = await import("../utils/mask-mid");
      res.json({ ...updated, mid: _maskMidUpdate((updated as any).mid), hasMid: !!(updated as any).mid });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.delete("/api/agent-merchants/:id", requireRole('admin', 'manager'), async (req, res) => {
    try {
      await storage.unassignMerchantFromAgent(Number(String(req.params.id)));
      res.status(204).send();
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === RESIDUAL CALCULATOR (admin only) ===
  app.post("/api/agents/residual-calculator", requireRole('admin'), async (req, res) => {
    try {
      const { agentId, totalResidual, month } = req.body;
      if (!agentId || totalResidual === undefined) {
        return res.status(400).json({ message: "agentId and totalResidual are required" });
      }
      const agent = await storage.getAgent(Number(agentId));
      if (!agent) return res.status(404).json({ message: "Agent not found" });

      const total = parseFloat(String(totalResidual));
      const splitPct = (agent.commissionSplitPercent ?? 50) / 100;

      const assignedMerchants = await storage.getAgentMerchants(Number(agentId));

      let breakdown: Array<{ id: number; dealId: number; merchantName: string; share: number; repShare: number; ownerShare: number; source: string }> = [];

      if (month) {
        const monthResiduals = await storage.getMerchantResidualsByMonth(month);
        const assignedDealIds = new Set(assignedMerchants.map(m => m.dealId));
        const actualResiduals = monthResiduals.filter(r => r.dealId && assignedDealIds.has(r.dealId));

        if (actualResiduals.length > 0) {
          const actualTotal = actualResiduals.reduce((s, r) => s + parseFloat(r.netRevenue || "0"), 0);
          const scaleFactor = actualTotal > 0 ? total / actualTotal : 1;
          breakdown = actualResiduals.map(r => {
            const share = parseFloat(r.netRevenue || "0") * scaleFactor;
            return {
              id: r.id,
              dealId: r.dealId!,
              merchantName: r.merchantName || `Merchant #${r.dealId}`,
              share,
              repShare: share * splitPct,
              ownerShare: share * (1 - splitPct),
              source: "actual",
            };
          });
        }
      }

      if (breakdown.length === 0) {
        const perMerchantShare = assignedMerchants.length > 0 ? total / assignedMerchants.length : 0;
        breakdown = assignedMerchants.map(m => ({
          id: m.id,
          dealId: m.dealId,
          merchantName: m.merchantName || `Merchant #${m.dealId}`,
          share: perMerchantShare,
          repShare: perMerchantShare * splitPct,
          ownerShare: perMerchantShare * (1 - splitPct),
          source: "estimated",
        }));
      }

      const repPayout = breakdown.reduce((s, b) => s + b.repShare, 0) || total * splitPct;
      const ownerOverride = total - repPayout;

      res.json({
        agentId: agent.id,
        agentName: `${agent.firstName} ${agent.lastName}`,
        splitPercent: agent.commissionSplitPercent ?? 50,
        totalResidual: total,
        repPayout,
        ownerOverride,
        month: month || null,
        breakdown,
        breakdownSource: breakdown.length > 0 ? breakdown[0].source : "estimated",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === RESIDUAL REPORTS ===
  app.get("/api/residual-reports", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const reports = await storage.getResidualReports();
      res.json(reports);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/residual-reports", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const input = insertResidualReportSchema.parse(req.body);
      const report = await storage.createResidualReport(input, { actorType: "user", userId: (req.user as any)?.id ?? null });
      res.status(201).json(report);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      serverError(res, err);
    }
  });

  app.get("/api/residual-reports/:id", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const report = await storage.getResidualReport(Number(String(req.params.id)));
      if (!report) return res.status(404).json({ message: "Not found" });
      res.json(report);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/merchant-residuals", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const month = req.query.month as string | undefined;
      const dealId = req.query.dealId ? Number(req.query.dealId) : undefined;
      const agentId = req.query.agentId ? Number(req.query.agentId) : undefined;
      if (dealId) {
        const residuals = await storage.getMerchantResidualsByDeal(dealId);
        res.json(residuals);
      } else if (agentId && month) {
        const residuals = await storage.getMerchantResidualsByMonth(month);
        res.json(residuals.filter(r => r.agentId === agentId));
      } else if (agentId) {
        const residuals = await storage.getMerchantResiduals();
        res.json(residuals.filter(r => r.agentId === agentId));
      } else if (month) {
        const residuals = await storage.getMerchantResidualsByMonth(month);
        res.json(residuals);
      } else {
        const residuals = await storage.getMerchantResiduals();
        res.json(residuals);
      }
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === HEALTH ALERTS ===
  app.get("/api/health-alerts", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const alerts = await storage.getActiveHealthAlerts();
      res.json(alerts);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/health-alerts/deal/:dealId", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const alerts = await storage.getHealthAlertsByDeal(Number(req.params.dealId));
      res.json(alerts);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/health-alerts", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertHealthAlertSchema.parse(req.body);
      const alert = await storage.createHealthAlert(input);
      res.status(201).json(alert);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      serverError(res, err);
    }
  });

  app.patch("/api/health-alerts/:id", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const updated = await storage.updateHealthAlert(Number(String(req.params.id)), req.body);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === CONSENT AUDIT LOGS ===
  app.get("/api/consent-audit", requireRole('admin', 'manager'), async (req, res) => {
    try {
      const logs = await storage.getConsentAuditLogs();
      res.json(logs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/consent-audit/contact/:contactId", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const logs = await storage.getConsentAuditLogsByContact(Number(req.params.contactId));
      res.json(logs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/consent-audit", isDashboardUser, requireRole("admin", "manager"), (_req, res) => {
    res.status(405).json({ message: "Consent evidence is append-only and may only be created by a typed authority command." });
  });


  // === DATA DELETE REQUESTS ===
  app.post("/api/data-requests", publicLeadRateLimit, async (req, res) => {
    if (req.query.probe === "1") return res.json({ probe: true, endpoint: "/api/data-requests" });
    try {
      const input = insertDataDeleteRequestSchema.parse(req.body);
      const request = await storage.createDataDeleteRequest(input);
      res.status(201).json(request);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.get("/api/data-requests", requireRole('admin'), async (req, res) => {
    try {
      const requests = await storage.getDataDeleteRequests();
      res.json(requests);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/data-requests/:id", requireRole('admin'), async (req, res) => {
    try {
      const {privacyReviewCommand,reviewPrivacyRequest}=await import("../services/privacy-review-command");
      const {bindWorkActor}=await import("../services/work-item-command");
      const {strictRecordId}=await import("@shared/work-item-commands");
      const input=privacyReviewCommand.parse(req.body);
      res.json(await reviewPrivacyRequest(strictRecordId.parse(req.params.id),
        bindWorkActor(req.user,input.expectedActorId,input.expectedAccountVersion),input));
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:err.errors[0].message});
      const {WorkCommandError}=await import("../services/work-item-command");
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      serverError(res, err);
    }
  });


  // === REVIEW REQUESTS ===
  // GET /api/review-requests and PATCH /api/review-requests/:id are registered in
  // server/routes/lifecycle.ts with isDashboardUser + requireRole("admin","manager") guards.

  app.get("/api/review-requests/deal/:dealId", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.dealId);
      if (!await authorizeDealAccess(req, res, dealId)) return;
      const requests = await storage.getReviewRequestsByDeal(dealId);
      res.json(requests);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/review-requests", isDashboardUser, async (req, res) => {
    try {
      const input = insertReviewRequestSchema.parse(req.body);
      if (!input.dealId) return denyCrmObject(res);
      if (!await authorizeDealAccess(req, res, input.dealId)) return;
      const request = await storage.createReviewRequest(input);
      res.status(201).json(request);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      serverError(res, err);
    }
  });

  // === TESTIMONIAL SUBMISSIONS (staff review inbox) ===
  registerTestimonialRoutes(app);

  app.get("/api/admin/processor-adapters", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getAllAdapterStatuses } = await import("../services/processors/registry");
      const statuses = getAllAdapterStatuses();
      res.json({ adapters: statuses });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/processor-adapters/ping", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { pingAllAdapters, getAllAdapterStatuses } = await import("../services/processors/registry");
      const pingResults = await pingAllAdapters();
      const statuses = getAllAdapterStatuses();
      res.json({ ping: pingResults, adapters: statuses });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── REV-05A: Processor Activation Snapshot Management ──────────────────────
  //
  // Transport is fail-closed until a confirmed snapshot exists.
  // Owner must provide: processorProgram, entitlements, authorized base URL,
  // and supported operations before boarding activates.

  // GET /api/admin/processor-activation-snapshots — list all snapshots
  app.get("/api/admin/processor-activation-snapshots", requireRole("admin"), async (_req, res) => {
    try {
      const { db: _db } = await import("../db");
      const { processorActivationSnapshots } = await import("@shared/schema");
      const { desc } = await import("drizzle-orm");
      const rows = await _db.select().from(processorActivationSnapshots)
        .orderBy(desc(processorActivationSnapshots.createdAt));
      res.json({ snapshots: rows });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // POST /api/admin/processor-activation-snapshots — create a new snapshot
  // Requires admin + explicit owner confirmation fields.
  app.post("/api/admin/processor-activation-snapshots", requireRole("admin"), async (req, res) => {
    try {
      const {
        processorName, processorProgram, sandboxEntitlement, productionEntitlement,
        authorizedBaseUrl, supportedOperations, ownerConfirm, notes,
      } = req.body as {
        processorName?: string;
        processorProgram?: string;
        sandboxEntitlement?: boolean;
        productionEntitlement?: boolean;
        authorizedBaseUrl?: string;
        supportedOperations?: string[];
        ownerConfirm?: boolean;  // explicit confirmation from the owner
        notes?: string;
      };

      if (!processorName || !processorProgram) {
        return res.status(400).json({ message: "processorName and processorProgram are required" });
      }
      // REV-05A: Reject activation snapshots for non-production processors.
      // Mock is a test-only adapter and must never be authorized for real transport.
      // An admin-created Mock snapshot would allow fake MID production via the
      // activation snapshot gate and violates the boarding authority contract.
      //
      // NMI is listed here once a processor-specific domain allowlist is established;
      // until then it is excluded to prevent an unvalidatable snapshot that would
      // authorize NMI transport against an arbitrary URL.
      const PRODUCTION_PROCESSOR_NAMES = ["payarc"];
      if (!PRODUCTION_PROCESSOR_NAMES.includes(processorName.toLowerCase())) {
        return res.status(400).json({
          message: `processorName '${processorName}' is not a supported production processor for activation snapshots. ` +
                   `Supported processors: ${PRODUCTION_PROCESSOR_NAMES.join(", ")}. ` +
                   `NMI and other processors require a processor-specific domain allowlist before being enabled here.`,
        });
      }
      const validPrograms = ["traditional", "payfac"];
      if (!validPrograms.includes(processorProgram)) {
        return res.status(400).json({ message: `processorProgram must be one of: ${validPrograms.join(", ")}` });
      }
      if (!ownerConfirm) {
        return res.status(400).json({
          message: "ownerConfirm: true is required. The account owner must explicitly confirm the processor program, " +
                   "entitlements, and authorized endpoints before transport activates.",
        });
      }

      // REV-05A: Require at least one entitlement, an authorized base URL, and
      // at least one supported operation before marking as owner_confirmed.
      // An incomplete snapshot would allow real provider I/O on an unconfigured processor.
      if (!sandboxEntitlement && !productionEntitlement) {
        return res.status(400).json({
          message: "At least one of sandboxEntitlement or productionEntitlement must be true. " +
                   "Confirm with Liberty's Payarc account which environments are authorized.",
        });
      }
      if (!authorizedBaseUrl) {
        return res.status(400).json({
          message: "authorizedBaseUrl is required. This is the processor API base URL authorized for this environment. " +
                   "For Payarc, use https://api.payarc.net or the sandbox equivalent. Confirm with the processor.",
        });
      }

      // REV-05A: SSRF guard — authorizedBaseUrl must be HTTPS and match the
      // processor-specific domain allowlist. An arbitrary URL would allow an admin
      // to exfiltrate merchant/owner/bank PII and the processor bearer token to an
      // attacker-controlled server.
      //
      // Domain allowlists are processor-specific. Adding a new processor here requires:
      //   1. Confirmed domain names from the processor's official documentation.
      //   2. Owner confirmation that the processor program is correct (already checked above).
      //   3. Separate allowlist entry below — never share allowlists across processors.
      const PROCESSOR_DOMAIN_ALLOWLISTS: Record<string, RegExp> = {
        payarc: /^(api\.|sandbox\.|staging\.)?payarc\.(net|com)$/i,
        // nmi: not yet defined — add *.nmi.net / *.tnmi.net once confirmed.
      };
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(authorizedBaseUrl);
      } catch {
        return res.status(400).json({
          message: "authorizedBaseUrl must be a valid absolute URL (e.g. https://api.payarc.net).",
        });
      }
      if (parsedUrl.protocol !== "https:") {
        return res.status(400).json({
          message: "authorizedBaseUrl must use HTTPS. HTTP URLs are not permitted for processor transport.",
        });
      }
      const domainAllowlist = PROCESSOR_DOMAIN_ALLOWLISTS[processorName.toLowerCase()];
      if (!domainAllowlist) {
        return res.status(400).json({
          message: `No domain allowlist is configured for processor '${processorName}'. ` +
                   "A processor-specific domain allowlist must be added to the server before creating a snapshot.",
        });
      }
      if (!domainAllowlist.test(parsedUrl.hostname)) {
        return res.status(400).json({
          message: `authorizedBaseUrl hostname '${parsedUrl.hostname}' is not on the ${processorName} domain allowlist. ` +
                   "Confirm the correct endpoint with the processor before creating the snapshot.",
        });
      }
      if (!supportedOperations || supportedOperations.length === 0) {
        return res.status(400).json({
          message: "supportedOperations is required (array of operation names like ['board_merchant','get_merchant_status']). " +
                   "Confirm the full list with Payarc before activating transport.",
        });
      }

      const now = new Date();
      const actorEmail = (req.user as any)?.email ?? "unknown";
      const status = "owner_confirmed";

      const { db: _db } = await import("../db");
      const { processorActivationSnapshots } = await import("@shared/schema");
      const [row] = await _db.insert(processorActivationSnapshots).values({
        processorName: processorName.toLowerCase(),
        processorProgram,
        sandboxEntitlement: sandboxEntitlement ?? false,
        productionEntitlement: productionEntitlement ?? false,
        authorizedBaseUrl: authorizedBaseUrl ?? null,
        supportedOperations: supportedOperations ?? [],
        ownerConfirmedAt: now,
        ownerConfirmedBy: actorEmail,
        status,
        notes: notes ?? null,
      }).returning();

      const { storage: _storage } = await import("../storage");
      await _storage.createAuditLog({
        action: "processor_activation_snapshot_created",
        entityType: "processor_activation_snapshot",
        entityId: row.id,
        details: {
          processorName: row.processorName,
          processorProgram: row.processorProgram,
          sandboxEntitlement: row.sandboxEntitlement,
          productionEntitlement: row.productionEntitlement,
          status: row.status,
          ownerConfirmedBy: row.ownerConfirmedBy,
          note: "Owner confirmed activation snapshot — processor transport now permitted.",
        },
      });

      res.status(201).json({ snapshot: row, message: "Activation snapshot created. Processor transport is now permitted for qualifying submissions." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PATCH /api/admin/processor-activation-snapshots/:id/expire — mark a snapshot as expired/held
  app.patch("/api/admin/processor-activation-snapshots/:id/expire", requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(String(String(req.params.id)), 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid snapshot ID" });

      const { db: _db } = await import("../db");
      const { processorActivationSnapshots } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [row] = await _db.update(processorActivationSnapshots)
        .set({ status: "expired_or_drifted", updatedAt: new Date() })
        .where(eq(processorActivationSnapshots.id, id))
        .returning();
      if (!row) return res.status(404).json({ message: "Snapshot not found" });
      res.json({ snapshot: row, message: "Snapshot marked as expired_or_drifted. Transport will be blocked until a new snapshot is created." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GHL CONTACT ID BACKFILL — durable bounded command ===
  app.post("/api/admin/backfill-ghl-contacts", requireRole("admin"), async (req, res) => {
    const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      return res.status(400).json({ code: "INVALID_IDEMPOTENCY_KEY", message: "idempotencyKey must contain 8–200 characters." });
    }
    try {
      const { createGhlContactBackfill } = await import("../services/ghl-specialized-commands");
      const run = await createGhlContactBackfill(String((req.user as any)?.id ?? "admin"), idempotencyKey);
      res.status(202).json({
        accepted: true,
        runId: run.runId,
        kind: run.kind,
        state: run.state,
        pollingUrl: "/api/admin/backfill-ghl-contacts/status?runId=" + encodeURIComponent(run.runId),
        stepUrl: `/api/admin/backfill-ghl-contacts/${run.runId}/step`,
        processed: run.processed,
        matched: run.matched,
        notFound: run.notFound,
        skipped: run.skipped,
        errors: run.errors,
        cursor: run.cursor,
        watermark: run.watermark,
        heartbeatAt: run.heartbeatAt,
        lastError: run.lastError,
        complete: run.state === "complete",
      });
    } catch (err: any) {
      if (err?.message === "GHL_SPECIALIZED_COMMAND_ACTIVE") {
        return res.status(409).json({ code: err.message, message: "Another GHL specialized command currently owns the active command slot." });
      }
      serverError(res, err);
    }
  });

  app.post("/api/admin/backfill-ghl-contacts/:runId/step", requireRole("admin"), async (req, res) => {
    try {
      const { stepGhlSpecializedRun, getGhlSpecializedRun } = await import("../services/ghl-specialized-commands");
      const runId = String(req.params.runId || "");
      const maxItems = req.body?.maxItems === undefined ? 50 : Number(req.body.maxItems);
      if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) {
        return res.status(400).json({ code: "INVALID_STEP_SIZE", message: "maxItems must be an integer between 1 and 50." });
      }
      const current = await getGhlSpecializedRun(runId);
      if (!current || current.kind !== "contact_id_backfill") {
        return res.status(404).json({ code: "GHL_BACKFILL_RUN_NOT_FOUND", message: "Backfill run was not found." });
      }
      const result = await stepGhlSpecializedRun(runId, maxItems);
      const run = result.run;
      res.status(result.leaseBusy ? 409 : 200).json({
        accepted: !result.leaseBusy,
        runId: run.runId,
        kind: run.kind,
        state: run.state,
        pollingUrl: `/api/admin/backfill-ghl-contacts/status?runId=${encodeURIComponent(run.runId)}`,
        stepUrl: `/api/admin/backfill-ghl-contacts/${run.runId}/step`,
        processed: run.processed,
        matched: run.matched,
        notFound: run.notFound,
        skipped: run.skipped,
        errors: run.errors,
        cursor: run.cursor,
        watermark: run.watermark,
        heartbeatAt: run.heartbeatAt,
        lastError: run.lastError,
        complete: run.state === "complete",
        activeLease: !!run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > Date.now(),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/admin/backfill-ghl-contacts/status", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { getGhlSpecializedRun, getLatestGhlBackfillStatus } = await import("../services/ghl-specialized-commands");
      const status = await getLatestGhlBackfillStatus();
      if (req.query.runId) {
        const run = await getGhlSpecializedRun(String(req.query.runId));
        if (!run || run.kind !== "contact_id_backfill") {
          return res.status(404).json({ code: "GHL_BACKFILL_RUN_NOT_FOUND", message: "Backfill run was not found." });
        }
        return res.json({
          ...status,
          run,
          runId: run.runId,
          kind: run.kind,
          state: run.state,
          cursor: run.cursor,
          watermark: run.watermark,
          processed: run.processed,
          matched: run.matched,
          notFound: run.notFound,
          skipped: run.skipped,
          errors: run.errors,
          heartbeatAt: run.heartbeatAt,
          lastError: run.lastError,
          complete: run.state === "complete",
          activeLease: !!run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > Date.now(),
        });
      }
      res.json(status);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GHL HEALTH CHECK (cached 30s) ===
  let _ghlHealthCache: { data: any; at: number } | null = null;
  const GHL_HEALTH_TTL_MS = 30_000;

  app.get("/api/admin/ghl-health", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const now = Date.now();
      if (_ghlHealthCache && now - _ghlHealthCache.at < GHL_HEALTH_TTL_MS) {
        return res.json({ ..._ghlHealthCache.data, cached: true });
      }
      const { checkGhlHealth } = await import("../services/ghl");
      // Race GHL probe against a 5-second deadline. Under pool pressure the
      // external API call can hang for 20 s × 3 retries = 60 s, blocking the
      // response. If it doesn't answer within 5 s we return a "slow" status
      // (the 30-s cache prevents hammering GHL on every poll).
      const GHL_HEALTH_PROBE_TIMEOUT_MS = 5_000;
      const timeoutResult = { connected: false, latencyMs: GHL_HEALTH_PROBE_TIMEOUT_MS, error: "health probe timed out" };
      const result = await Promise.race([
        checkGhlHealth(),
        new Promise<typeof timeoutResult>(resolve =>
          setTimeout(() => resolve(timeoutResult), GHL_HEALTH_PROBE_TIMEOUT_MS)
        ),
      ]);
      const ghlStatus = result.connected ? "ok" : (
        result.error?.toLowerCase().includes("not configured") ? "unconfigured" :
        result.error?.includes("timed out") ? "slow" : "expired"
      );

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Single query: failure count (last 24h) + last success timestamp in one pass.
      // Uses the (entity_type, entity_id) index; avoids 2 separate pool connections.
      const auditRow = await pool.query<{ failure_count: string; last_success: Date | null }>(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= $1 AND action = 'ghl_sync_failed')           AS failure_count,
          MAX(created_at) FILTER (WHERE action = 'ghl_sync_success')                         AS last_success
        FROM audit_logs
        WHERE entity_type = 'ghl_sync'
      `, [since24h.toISOString()]);

      const auditStats = auditRow.rows[0];

      const payload = {
        ...result,
        status: ghlStatus,
        failureCount: parseInt(auditStats?.failure_count ?? "0", 10),
        lastSync: auditStats?.last_success ? new Date(auditStats.last_success).toISOString() : null,
        checkedAt: new Date().toISOString(),
        cached: false,
      };
      _ghlHealthCache = { data: payload, at: now };
      res.json(payload);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GHL SYNC RETRY ===
  app.post("/api/admin/ghl-sync/retry", requireRole("admin", "manager"), async (req, res) => {
    try {
      return res.status(503).json({ code: "RECONCILIATION_COMMAND_REQUIRED", message: "GHL retry requires a durable reconciliation command." });
      const { contactId } = req.body;
      if (!contactId) return res.status(400).json({ message: "contactId is required" });

      const { isGhlConfigured, upsertGhlContact } = await import("../services/ghl");
      if (!isGhlConfigured()) {
        return res.status(503).json({ message: "GHL not configured. Set GHL_API_KEY and GHL_LOCATION_ID." });
      }
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, Number(contactId)));
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      if (!(await requireGhlRouteMutationAllowed(res))) return;
      const result = await upsertGhlContact(contact);
      await auditChange({ entityType: "ghl_sync", entityId: contact.id, entityKey: contact.email || String(contact.id), action: "ghl_sync_retry_success", details: { ghlContactId: result } });
      res.json({ success: true, ghlContactId: result });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GHL WORKFLOW ID TEST ===
  app.post("/api/admin/ghl-workflows/:workflowId/test", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { workflowId } = req.params;
      if (!workflowId || workflowId.length < 8) {
        return res.status(400).json({ valid: false, error: "Invalid workflow ID format" });
      }
      const { isGhlConfigured } = await import("../services/ghl");
      if (!isGhlConfigured()) {
        return res.status(503).json({ valid: false, error: "GHL not configured. Set GHL_API_KEY and GHL_LOCATION_ID." });
      }
      const apiKey = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
      const locationId = process.env.GHL_LOCATION_ID;
      const base = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
      const url = `${base}/workflows/${workflowId}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
          ...(locationId ? { "location-id": locationId } : {}),
        },
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        const wf = (data as any)?.workflow ?? data;
        const name = wf?.name || workflowId;
        const isActive = wf?.status === "published" || wf?.isActive === true || wf?.status === "active";
        if (!isActive && wf?.status !== undefined) {
          return res.json({ valid: true, active: false, name, warning: `Workflow exists but is not active (status: ${wf.status}). Contacts may not be enrolled.` });
        }
        return res.json({ valid: true, active: isActive !== false, name });
      } else if (resp.status === 404) {
        return res.json({ valid: false, error: "Workflow not found in GHL. Check the ID." });
      } else if (resp.status === 401 || resp.status === 403) {
        return res.json({ valid: false, error: "GHL token rejected. Re-authenticate in GHL Settings → Private Integrations." });
      } else {
        return res.json({ valid: false, error: `GHL returned HTTP ${resp.status}` });
      }
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GHL WORKFLOW REGISTRY LIVE VALIDATION ===
  app.post("/api/admin/ghl-workflow-registry/validate", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { validateGhlWorkflowRegistry } = await import("../services/ghl-workflows");
      const { isSdrGhlConfigured } = await import("../services/sdr/ghl-client");
      const { isGhlConfigured } = await import("../services/ghl");
      if (!isGhlConfigured() && !isSdrGhlConfigured()) {
        return res.status(503).json({ error: "GHL not configured — set GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID" });
      }
      const result = await validateGhlWorkflowRegistry();
      res.json({
        checkedCount: result.checkedCount,
        okCount: result.okCount,
        unresolvedKeys: result.unresolvedKeys,
        inactiveKeys: result.inactiveKeys,
        apiErrorKeys: result.apiErrorKeys,
        results: result.results,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === SYSTEM READINESS ===
  app.get("/api/admin/system-readiness", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isGhlConfigured } = await import("../services/ghl");
      const { isSmtpConfigured, getSmtpStatus } = await import("../services/smtp-email");
      const { GHL_WORKFLOW_REGISTRY } = await import("../services/ghl-workflows");
      const { featureFlags } = await import("../services/feature-flags");

      // GHL status
      let ghlStatus: "ok" | "expired" | "unconfigured" = "unconfigured";
      let ghlLocationName: string | undefined;
      const ghlConfigured = isGhlConfigured();
      if (ghlConfigured) {
        try {
          const { checkGhlHealth } = await import("../services/ghl");
          const test = await checkGhlHealth();
          ghlStatus = test.connected ? "ok" : "expired";
          ghlLocationName = test.locationName;
        } catch { ghlStatus = "expired"; }
      }

      // GHL workflow IDs
      const configuredWorkflows = GHL_WORKFLOW_REGISTRY.filter(
        w => !!(process.env[w.envKey])
      );
      const dbWorkflows: string[] = [];
      for (const w of GHL_WORKFLOW_REGISTRY) {
        if (!process.env[w.envKey]) {
          try {
            const saved = await storage.getSystemSetting(`ghl_workflow_env_${w.envKey}`);
            if (saved) dbWorkflows.push(w.envKey);
          } catch { /* ignore */ }
        }
      }
      const workflowIdsConfigured = configuredWorkflows.length + dbWorkflows.length;

      // SMTP
      const smtpStatus = getSmtpStatus();
      const smtpConfigured = isSmtpConfigured();

      // OpenAI
      const openaiConfigured = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY);

      // Redis
      const redisUrl = process.env.REDIS_URL;
      const redisReal = !!(redisUrl && redisUrl !== "");

      // Sending identities
      let sendingIdentityCount = 0;
      try {
        const identities = await storage.getSendingIdentities();
        sendingIdentityCount = identities.filter((i: any) => i.status === "active").length;
      } catch { /* ignore */ }

      // Feature flags
      const flags = {
        sdrEnabled: featureFlags.SDR_ENABLED,
        orchestratorEnabled: featureFlags.ORCHESTRATOR_ENABLED,
        legacyOutreachEnabled: featureFlags.LEGACY_OUTREACH_ENABLED,
        voiceAiEnabled: featureFlags.VOICE_AI_ENABLED,
        smsEnabled: featureFlags.SMS_ENABLED,
        nightlyDiscoveryEnabled: featureFlags.NIGHTLY_DISCOVERY_ENABLED,
      };

      // Key env vars presence
      const envChecks = {
        ghlToken: !!(process.env.GHL_PRIVATE_INTEGRATION_TOKEN),
        ghlLocationId: !!(process.env.GHL_LOCATION_ID),
        adminEmail: !!(process.env.ADMIN_DIGEST_EMAIL),
        serperApiKey: !!(process.env.SERPER_API_KEY),
        apolloApiKey: !!(process.env.APOLLO_API_KEY),
        apifyToken: !!(process.env.APIFY_API_TOKEN),
        outscraperKey: !!(process.env.OUTSCRAPER_API_KEY),
        appUrl: !!(process.env.APP_URL),
        payarcKey: !!(process.env.PAYARC_API_KEY),
        ghlWebhookSecret: !!(process.env.GHL_WEBHOOK_SECRET),
        smtpPass: !!(process.env.SMTP_PASS),
        smtpHost: !!(process.env.SMTP_HOST),
        smtpUser: !!(process.env.SMTP_USER),
        ghlDefaultWorkflow: !!(process.env.GHL_DEFAULT_WORKFLOW_ID),
        ghlBookingLink: !!(process.env.GHL_DEFAULT_BOOKING_LINK),
      };

      // Build action items
      const actions: string[] = [];
      if (!smtpConfigured) {
        if (!envChecks.smtpHost) actions.push("Set SMTP_HOST to enable email delivery fallback");
        else if (!envChecks.smtpPass) actions.push("Set SMTP_PASS — SMTP_HOST/USER are set but auth is missing, all transactional emails are silently failing");
      }
      if (ghlStatus === "unconfigured") {
        actions.push("Set GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID to enable GHL sync, comms, and workflows");
      } else if (ghlStatus === "expired") {
        actions.push("GHL token is expired — regenerate in GHL Settings → Private Integrations and update GHL_PRIVATE_INTEGRATION_TOKEN");
      }
      if (workflowIdsConfigured < GHL_WORKFLOW_REGISTRY.length) {
        actions.push(`Configure ${GHL_WORKFLOW_REGISTRY.length - workflowIdsConfigured} GHL Workflow IDs in GHL Workflow ID Manager — all automation is silently failing without them`);
      }
      if (!openaiConfigured) {
        actions.push("Set AI_INTEGRATIONS_OPENAI_API_KEY — AI enrichment, intent classification, blueprint/proposal generation will all fail");
      }
      if (sendingIdentityCount < 3) {
        actions.push(`Add more sending identities — only ${sendingIdentityCount} active (recommend 3+ for inbox rotation)`);
      }
      if (!redisReal) {
        actions.push("Set REDIS_URL for the required BullMQ job queue — background queues are unavailable without it");
      }
      if (!envChecks.adminEmail) {
        actions.push("Set ADMIN_DIGEST_EMAIL — daily/weekly digests have no recipient without it");
      }
      if (!envChecks.serperApiKey && flags.legacyOutreachEnabled) {
        actions.push("Set SERPER_API_KEY — required for deep enrichment in Outreach Command Center");
      }
      if (!envChecks.ghlWebhookSecret) {
        actions.push("Set GHL_WEBHOOK_SECRET — webhook signature validation is disabled (security risk)");
      }

      res.json({
        ghl: { status: ghlStatus, configured: ghlConfigured, locationName: ghlLocationName, workflowIdsConfigured, workflowIdsTotal: GHL_WORKFLOW_REGISTRY.length },
        smtp: { ...smtpStatus, configured: smtpConfigured },
        openai: { configured: openaiConfigured },
        redis: { real: redisReal, url: redisReal ? "configured" : "not set (BullMQ unavailable)" },
        sdr: flags,
        sendingIdentities: { activeCount: sendingIdentityCount },
        env: envChecks,
        actions,
        overallHealthy: actions.length === 0,
        criticalIssues: actions.filter(a => a.toLowerCase().includes("silently failing") || a.toLowerCase().includes("fail") || a.toLowerCase().includes("expired") || a.toLowerCase().includes("security")).length,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GHL FAILURES (admin + manager) ===
  app.get("/api/admin/ghl-failures", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const failures = await db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          entityKey: auditLogs.entityKey,
          details: auditLogs.details,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "ghl_sync"),
            or(like(auditLogs.action, "%fail%"), like(auditLogs.action, "%error%")),
            gte(auditLogs.createdAt, since24h)
          )
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(50);
      res.json({ logs: failures });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === EMAIL HEALTH: SMTP STATUS ===
  app.get("/api/admin/email-health/smtp-status", requireRole("admin", "manager"), async (req, res) => {
    try {
      const status = getSmtpStatus();
      res.json({
        configured: isSmtpConfigured(),
        hasHost: !!process.env.SMTP_HOST,
        hasUser: !!process.env.SMTP_USER,
        hasPass: !!process.env.SMTP_PASS,
        host: status.host,
        port: status.port,
        user: status.user,
        from: status.from,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === EMAIL HEALTH: SMTP TEST ===
  app.post("/api/admin/email-health/test-smtp", requireRole("admin", "manager"), async (req, res) => {
    try {
      const adminUser = req.user as any;
      const toEmail = adminUser?.email;
      if (!toEmail) {
        return res.status(400).json({ success: false, error: "No email address on your account" });
      }
      const result = await sendSmtpEmail({
        to: toEmail,
        subject: "Liberty Bancard — SMTP Test",
        html: `<p>This is a test email sent from the Liberty Bancard Email Health admin panel at ${new Date().toLocaleString()}.</p><p>If you received this, SMTP is configured correctly.</p>`,
        category: "internal_ops",
      });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === EMAIL HEALTH: GHL WORKFLOW STATUS ===
  app.get("/api/admin/email-health/ghl-status", requireRole("admin", "manager"), async (req, res) => {
    try {
      const workflows = await getWorkflowRegistryWithStatus();
      const configuredCount = workflows.filter(w => w.isSet).length;
      res.json({ workflows, total: workflows.length, configuredCount });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === EMAIL HEALTH: SENDING IDENTITIES CRUD ===
  app.get("/api/admin/sending-identities", requireRole("admin", "manager"), async (req, res) => {
    try {
      const identities = await storage.getSendingIdentities();
      res.json(identities);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  function validateSendingDomain(emailAddress: string | undefined): string | null {
    if (!emailAddress) return null;
    const atIdx = emailAddress.lastIndexOf("@");
    if (atIdx === -1) return "Email address must contain @";
    const domain = emailAddress.slice(atIdx + 1).toLowerCase();
    if (!(ALLOWED_SENDING_DOMAINS as readonly string[]).includes(domain)) {
      return `Domain "${domain}" is not allowed. Permitted domains: ${ALLOWED_SENDING_DOMAINS.join(", ")}`;
    }
    return null;
  }

  app.post("/api/admin/sending-identities", requireRole("admin", "manager"), async (req, res) => {
    try {
      const parsed = insertSendingIdentitySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
      }
      const domainError = validateSendingDomain(parsed.data.emailAddress);
      if (domainError) return res.status(400).json({ message: domainError });
      const identity = await storage.createSendingIdentity(parsed.data);
      res.status(201).json(identity);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.patch("/api/admin/sending-identities/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id) as string, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const parsed = insertSendingIdentitySchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
      }
      if (parsed.data.emailAddress) {
        const domainError = validateSendingDomain(parsed.data.emailAddress);
        if (domainError) return res.status(400).json({ message: domainError });
      }
      const identity = await storage.updateSendingIdentity(id, parsed.data);
      if (!identity) return res.status(404).json({ message: "Identity not found" });
      res.json(identity);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.delete("/api/admin/sending-identities/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id) as string, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const deleted = await storage.deleteSendingIdentity(id);
      if (!deleted) return res.status(404).json({ message: "Identity not found" });
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/admin/channel-safety-summary", requireRole("admin", "manager"), async (req, res) => {
    try {
      const summary = await summarizeChannelSafety();
      res.json(summary);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Build the set of businessIds that already have at least one active deal — refresh each batch
  async function getBusinessIdsWithDeals(): Promise<Set<number>> {
    const rows = await db
      .select({ businessId: contacts.businessId })
      .from(deals)
      .innerJoin(contacts, eq(deals.contactId, contacts.id))
      .where(and(isNull(deals.archivedAt), not(isNull(contacts.businessId))));
    const s = new Set<number>();
    for (const r of rows) { if (r.businessId) s.add(r.businessId); }
    return s;
  }

  // === DEAL BACKFILL: PREVIEW ===
  // Cursor-paginated full eligibility scan — deterministic, no extrapolation.
  // Optional `limit` in request body caps how many orphan contacts are scanned.
  app.post("/api/admin/contacts/backfill-deals/preview", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { source, vertical, minScore = 45, limit } = req.body || {};
      // Enforce warm/hot-only semantic: floor at 45 so cold contacts are never previewed
      const parsedScore = Math.max(45, Math.min(100, Number(minScore) || 45));
      // Honor caller-supplied limit; undefined = scan all
      const scanCap = limit ? Math.min(Math.max(Number(limit), 1), 100_000) : undefined;

      // Accurate total count via COUNT(*) — always reflects the full population
      const totalOrphanContacts = await storage.getOrphanContactCount({
        source: source || undefined,
        vertical: vertical || undefined,
        minScore: parsedScore,
      });

      // Full cursor-based eligibility scan — no sampling, no extrapolation
      const businessIdsWithDeals = await getBusinessIdsWithDeals();
      const skippedBreakdown = { cold: 0, existingDeal: 0, missingIdentity: 0, duplicateBusiness: 0, placeholderEmailOnly: 0, suppressedOrDnc: 0, anonymous: 0 };
      let wouldCreate = 0;
      const sampleDisplay: Awaited<ReturnType<typeof storage.getOrphanContactCandidates>> = [];
      let lastId: number | null = null;
      let scanned = 0;
      const previewBatch = 500;

      while (true) {
        const remaining = scanCap !== undefined ? scanCap - scanned : previewBatch;
        if (remaining <= 0) break;
        const batch = await storage.getOrphanContactCandidates({
          source: source || undefined,
          vertical: vertical || undefined,
          minScore: parsedScore,
          afterId: lastId ?? undefined,
          limit: Math.min(previewBatch, remaining),
        });
        if (batch.length === 0) break;
        for (const c of batch) {
          const verdict = classifyEligibility(c, businessIdsWithDeals, parsedScore);
          if (verdict === "eligible") {
            wouldCreate++;
            if (sampleDisplay.length < 5) sampleDisplay.push(c);
            // Mirror apply behavior: once a contact from a business is deemed eligible,
            // subsequent contacts sharing that businessId must be skipped (duplicate-business gate)
            if (c.businessId) businessIdsWithDeals.add(c.businessId);
          } else if (verdict === "cold") skippedBreakdown.cold++;
          else if (verdict === "anonymous") skippedBreakdown.anonymous++;
          else if (verdict === "placeholder_email") skippedBreakdown.placeholderEmailOnly++;
          else if (verdict === "suppressed_dnc") skippedBreakdown.suppressedOrDnc++;
          else if (verdict === "missing_identity") skippedBreakdown.missingIdentity++;
          else if (verdict === "duplicate_business") skippedBreakdown.duplicateBusiness++;
          lastId = c.id;
          scanned++;
        }
      }

      await storage.createAuditLog({
        action: "contacts_deal_backfill_previewed",
        entityType: "system",
        details: { totalOrphanContacts, scanned, wouldCreateDeals: wouldCreate, skippedBreakdown, minScore: parsedScore, source, vertical },
        userId: (req.user as any)?.id ?? null,
      });

      res.json({
        totalOrphanContacts,
        scanned,
        wouldCreateDeals: wouldCreate,
        skippedCold: skippedBreakdown.cold,
        skippedExistingDeal: skippedBreakdown.existingDeal,
        skippedMissingIdentity: skippedBreakdown.missingIdentity,
        skippedDuplicateBusiness: skippedBreakdown.duplicateBusiness,
        skippedPlaceholderEmailOnly: skippedBreakdown.placeholderEmailOnly,
        skippedSuppressedOrDnc: skippedBreakdown.suppressedOrDnc,
        skippedAnonymous: skippedBreakdown.anonymous,
        sampleCandidates: sampleDisplay,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === DEAL BACKFILL: START (async, cursor-paginated, resumable) ===
  // Uses afterId cursor so it never loads more than batchSize rows at a time —
  // safe for populations of 153k+ contacts. Progress is written after every batch.
  async function runBackfillAsync(opts: { minScore: number; batchSize: number; source?: string; vertical?: string; adminUserId: string | null; startedAt: string; initialTotal: number }) {
    const { minScore, batchSize, source, vertical, adminUserId, startedAt, initialTotal } = opts;

    let processed = 0;
    let dealsCreated = 0;
    let skipped = 0;
    const skippedBreakdown = { cold: 0, existingDeal: 0, missingIdentity: 0, duplicateBusiness: 0, placeholderEmailOnly: 0, suppressedOrDnc: 0, anonymous: 0 };
    let lastProcessedContactId: number | null = null;

    // Restore cursor from prior run (resumable)
    const savedProgress = await storage.getBackfillProgress() as any;
    if (savedProgress?.lastProcessedContactId && savedProgress?.status === "running") {
      processed = savedProgress.processed ?? 0;
      dealsCreated = savedProgress.dealsCreated ?? 0;
      skipped = savedProgress.skipped ?? 0;
      lastProcessedContactId = savedProgress.lastProcessedContactId ?? null;
      if (savedProgress.skippedBreakdown) Object.assign(skippedBreakdown, savedProgress.skippedBreakdown);
    }

    try {
      // Cursor loop — fetches batchSize rows at a time, no global pre-fetch
      while (true) {
        // Check cancel before every batch
        const currentProg = await storage.getBackfillProgress() as any;
        if (currentProg?.cancelRequested) {
          await storage.setBackfillProgress({
            status: "cancelled",
            processed, total: initialTotal, dealsCreated, skipped, skippedBreakdown,
            lastProcessedContactId,
            startedAt, updatedAt: new Date().toISOString(), completedAt: null,
            cancelRequested: true, error: null,
          });
          await storage.createAuditLog({ action: "contacts_deal_backfill_cancelled", entityType: "system", userId: adminUserId, details: { processed, dealsCreated, skipped } });
          return;
        }

        const batch = await storage.getOrphanContactCandidates({
          source, vertical, minScore,
          afterId: lastProcessedContactId ?? undefined,
          limit: batchSize,
        });

        if (batch.length === 0) break; // cursor exhausted — done

        // Refresh businessIds-with-deals once per batch to stay current
        const businessIdsWithDeals = await getBusinessIdsWithDeals();

        for (const c of batch) {
          const verdict = classifyEligibility(c, businessIdsWithDeals, minScore);
          if (verdict === "eligible") {
            try {
              await storage.createDeal({
                contactId: c.id,
                pipeline: "sales",
                stage: "New Lead",
                leadSource: c.leadSource || "backfill",
                notes: `Auto-created by deal backfill. Contact: ${c.firstName} ${c.lastName}${c.companyName ? ` (${c.companyName})` : ""}. Score: ${c.leadScore}.`,
              }, { actorType: "system", userId: adminUserId });
              dealsCreated++;
              businessIdsWithDeals.add(c.businessId!); // prevent duplicates within the same batch
            } catch (err) {
              console.error(`[DealBackfill] Deal creation failed for contact ${c.id}:`, err);
              skipped++;
              skippedBreakdown.existingDeal++;
            }
          } else {
            skipped++;
            if (verdict === "cold") skippedBreakdown.cold++;
            else if (verdict === "anonymous") skippedBreakdown.anonymous++;
            else if (verdict === "placeholder_email") skippedBreakdown.placeholderEmailOnly++;
            else if (verdict === "suppressed_dnc") skippedBreakdown.suppressedOrDnc++;
            else if (verdict === "missing_identity") skippedBreakdown.missingIdentity++;
            else if (verdict === "duplicate_business") skippedBreakdown.duplicateBusiness++;
          }
          processed++;
          lastProcessedContactId = c.id;
        }

        // Persist after every batch — re-read to preserve any cancel that arrived
        // during this batch (never unconditionally reset cancelRequested to false)
        const midProg = await storage.getBackfillProgress() as any;
        await storage.setBackfillProgress({
          status: "running",
          processed, total: initialTotal, dealsCreated, skipped, skippedBreakdown,
          lastProcessedContactId,
          startedAt, updatedAt: new Date().toISOString(), completedAt: null,
          cancelRequested: midProg?.cancelRequested ?? false, error: null,
        });

        await storage.createAuditLog({ action: "contacts_deal_backfill_batch_completed", entityType: "system", userId: adminUserId,
          details: { lastContactId: lastProcessedContactId, processed, dealsCreated, skipped } });

        await new Promise(r => setTimeout(r, 50)); // yield to event loop
      }

      await storage.setBackfillProgress({
        status: "completed",
        processed, total: initialTotal, dealsCreated, skipped, skippedBreakdown,
        lastProcessedContactId,
        startedAt, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        cancelRequested: false, error: null,
      });
      await storage.createAuditLog({ action: "contacts_deal_backfill_completed", entityType: "system", userId: adminUserId,
        details: { processed, dealsCreated, skipped, skippedBreakdown } });
    } catch (err: any) {
      console.error("[DealBackfill] Fatal error:", err);
      const prev = await storage.getBackfillProgress() as any;
      await storage.setBackfillProgress({
        ...(prev ?? {}),
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: safeMessage(err.message, "Backfill failed"),
      });
      await storage.createAuditLog({ action: "contacts_deal_backfill_failed", entityType: "system", userId: opts.adminUserId, details: { error: err.message } });
    }
  }

  app.post("/api/admin/contacts/backfill-deals", requireRole("admin", "manager"), async (req, res) => {
    try {
      if (!(globalThis as { __BT10_DURABLE_LONG_OPERATION_OWNER__?: boolean }).__BT10_DURABLE_LONG_OPERATION_OWNER__) {
        return res.status(503).json({ code: "DURABLE_COMMAND_REQUIRED", message: "Deal backfill requires a durable command." });
      }
      // Only accept the known safe fields; any caller-supplied count fields are intentionally ignored
      // to prevent a caller from spoofing a low count and bypassing the confirmation safeguard.
      const { confirmed, confirmationText, minScore = 45, batchSize = 200, source, vertical } = req.body || {};

      if (!confirmed) return res.status(400).json({ message: "confirmed: true is required" });

      // Enforce warm/hot-only semantic: floor at 45 so cold contacts never receive deals
      const clampedMinScore = Math.max(45, Math.min(100, Number(minScore) || 45));

      // Server-computed orphan count — conservative upper bound (actual eligible subset is smaller
      // after identity/DNC/placeholder/duplicate-business gates). Never trust caller-supplied counts.
      const orphanCount = await storage.getOrphanContactCount({
        source: source || undefined,
        vertical: vertical || undefined,
        minScore: clampedMinScore,
      });

      // Confirmation safeguard: typed phrase required when the orphan population is >= 100.
      // Using the server-side orphan count (not a client-provided value) prevents bypass.
      if (orphanCount >= 100 && confirmationText !== "CREATE DEALS") {
        return res.status(400).json({
          message: `${orphanCount} orphan contacts found (eligible subset will be smaller). Send confirmationText: "CREATE DEALS" to proceed.`,
          orphanCount,
        });
      }

      // Check if already running — allow override if run is stale (stuck > 1 hour without progress)
      const existing = await storage.getBackfillProgress() as any;
      const isRunning = existing?.status === "running";
      if (isRunning) {
        const updatedMs = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
        const stale = Date.now() - updatedMs > 60 * 60 * 1000; // 1 hour
        if (!stale) {
          return res.status(409).json({ message: "A backfill is already running. Check /status or cancel first." });
        }
        // Stale run — fall through and resume from persisted cursor
      }

      const adminUserId = (req.user as any)?.id ?? null;

      if (isRunning) {
        // Stale restart: preserve cursor — only reset the heartbeat timestamp so the run no
        // longer appears stale. runBackfillAsync will read the saved cursor and resume.
        await storage.setBackfillProgress({
          ...existing,
          status: "running",
          cancelRequested: false,
          updatedAt: new Date().toISOString(),
          error: null,
        });
      } else {
        // Fresh start: reset cursor and counters
        const startedAt = new Date().toISOString();
        await storage.setBackfillProgress({
          status: "running",
          processed: 0, total: orphanCount, dealsCreated: 0, skipped: 0,
          skippedBreakdown: { cold: 0, existingDeal: 0, missingIdentity: 0, duplicateBusiness: 0, placeholderEmailOnly: 0, suppressedOrDnc: 0, anonymous: 0 },
          lastProcessedContactId: null,
          startedAt,
          updatedAt: startedAt,
          completedAt: null,
          cancelRequested: false,
          error: null,
        });
      }

      const finalProgress = await storage.getBackfillProgress() as any;
      const startedAt = finalProgress?.startedAt ?? new Date().toISOString();
      const initialTotal = finalProgress?.total ?? orphanCount;

      await storage.createAuditLog({ action: "contacts_deal_backfill_started", entityType: "system", userId: adminUserId,
        details: { totalCandidates: initialTotal, minScore: clampedMinScore, batchSize, source, vertical, resumed: isRunning } });

      // Fire and forget — cursor-paginated async runner, never loads full population
      setImmediate(() => {
        runBackfillAsync({
          minScore: clampedMinScore,
          batchSize: Math.min(Math.max(Number(batchSize) || 200, 100), 500),
          source: source || undefined,
          vertical: vertical || undefined,
          adminUserId,
          startedAt,
          initialTotal,
        }).catch(err => console.error("[DealBackfill] Async runner error:", err));
      });

      res.status(202).json({ message: isRunning ? "Backfill resumed" : "Backfill started", totalCandidates: initialTotal });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === DEAL BACKFILL: STATUS ===
  app.get("/api/admin/contacts/backfill-deals/status", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const progress = await storage.getBackfillProgress();
      res.json(progress ?? { status: "idle", processed: 0, total: 0, dealsCreated: 0, skipped: 0, skippedBreakdown: {}, lastProcessedContactId: null, startedAt: null, updatedAt: null, completedAt: null, error: null });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === DEAL BACKFILL: CANCEL ===
  app.post("/api/admin/contacts/backfill-deals/cancel", requireRole("admin", "manager"), async (req, res) => {
    try {
      const existing = await storage.getBackfillProgress() as any;
      if (!existing || existing.status !== "running") {
        return res.status(400).json({ message: "No running backfill to cancel" });
      }
      await storage.setBackfillProgress({ ...existing, cancelRequested: true, updatedAt: new Date().toISOString() });
      await storage.createAuditLog({ action: "contacts_deal_backfill_cancelled", entityType: "system", userId: (req.user as any)?.id ?? null,
        details: { cancelledAt: new Date().toISOString() } });
      res.json({ message: "Cancel requested. The running backfill will stop after its current batch." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === autoCreateDealsForWarmContacts system setting ===
  app.get("/api/admin/settings/auto-create-deals-for-warm-contacts", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const val = await storage.getSystemSetting("auto_create_deals_for_warm_contacts");
      res.json({ autoCreateDealsForWarmContacts: val === true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/admin/settings/auto-create-deals-for-warm-contacts", requireRole("admin"), async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") return res.status(400).json({ message: "enabled must be a boolean" });
      await storage.setSystemSetting("auto_create_deals_for_warm_contacts", enabled);
      await storage.createAuditLog({ action: "setting_auto_create_deals_updated", entityType: "system", userId: (req.user as any)?.id ?? null, details: { autoCreateDealsForWarmContacts: enabled } });
      res.json({ autoCreateDealsForWarmContacts: enabled });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === Statement Acquisition Cadence Config ===

  /**
   * GET /api/admin/settings/statement-acquisition-config
   * Returns the current statement-chase cadence configuration.
   * Admins and managers can read; only admins can update.
   */
  app.get("/api/admin/settings/statement-acquisition-config", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getAcquisitionConfig } = await import("../services/statement-acquisition");
      const config = await getAcquisitionConfig();
      res.json({ config });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /**
   * PUT /api/admin/settings/statement-acquisition-config
   * Updates the statement-chase cadence configuration.
   * Validates all four integer-hour fields before persisting.
   * Immediately syncs the updated delays to the "Statement Chase (Auto)" sequence steps.
   *
   * Body: { upload_nudge_sms_hours, rep_task_hours, educational_email_hours, stall_escalation_days }
   */
  app.put("/api/admin/settings/statement-acquisition-config", requireRole("admin"), async (req, res) => {
    try {
      const { validateAcquisitionConfig, syncStatementChaseSteps } = await import("../services/statement-acquisition");

      // validateAcquisitionConfig throws with a descriptive message on any bad value
      let validated;
      try {
        validated = validateAcquisitionConfig(req.body);
      } catch (validationErr: any) {
        return res.status(400).json({ message: validationErr.message });
      }

      await storage.setSystemSetting("statement_acquisition_config", validated);

      // Immediately apply the new delays to the sequence step rows so the next
      // enrollment uses the updated cadence without a server restart.
      await syncStatementChaseSteps(validated).catch(err =>
        console.warn("[Admin] syncStatementChaseSteps after config update (non-fatal):", err.message),
      );

      await storage.createAuditLog({
        action: "statement_acquisition_config_updated",
        entityType: "system",
        userId: (req.user as any)?.id ?? null,
        details: { config: validated },
      });

      res.json({ config: validated });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // #1336 — Churn/attrition signal thresholds
  // GET /api/admin/settings/attrition-thresholds
  app.get("/api/admin/settings/attrition-thresholds", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const [volumeDrop, cbRatio] = await Promise.all([
        storage.getSystemSetting("attrition_volume_drop_threshold_pct"),
        storage.getSystemSetting("attrition_chargeback_ratio_threshold_pct"),
      ]);
      res.json({
        volumeDropPct: typeof volumeDrop === "number" ? volumeDrop : 20,
        cbRatioPct:    typeof cbRatio   === "number" ? cbRatio   : 0.75,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PUT /api/admin/settings/attrition-thresholds
  app.put("/api/admin/settings/attrition-thresholds", requireRole("admin"), async (req, res) => {
    try {
      const { volumeDropPct, cbRatioPct } = req.body as { volumeDropPct?: unknown; cbRatioPct?: unknown };
      if (typeof volumeDropPct !== "number" || volumeDropPct <= 0 || volumeDropPct > 100) {
        return res.status(400).json({ message: "volumeDropPct must be a positive number ≤100" });
      }
      if (typeof cbRatioPct !== "number" || cbRatioPct <= 0 || cbRatioPct > 100) {
        return res.status(400).json({ message: "cbRatioPct must be a positive number ≤100" });
      }
      await Promise.all([
        storage.setSystemSetting("attrition_volume_drop_threshold_pct", volumeDropPct),
        storage.setSystemSetting("attrition_chargeback_ratio_threshold_pct", cbRatioPct),
      ]);
      await storage.createAuditLog({
        action: "attrition_thresholds_updated",
        entityType: "system",
        userId: (req.user as any)?.id ?? null,
        details: { volumeDropPct, cbRatioPct },
      });
      res.json({ volumeDropPct, cbRatioPct });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // #1253 — Per-stage pipeline silence thresholds
  // GET /api/admin/settings/pipeline-silence-thresholds
  app.get("/api/admin/settings/pipeline-silence-thresholds", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const raw = await storage.getSystemSetting("pipeline_silence_thresholds");
      res.json({ thresholds: (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {} });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PUT /api/admin/settings/pipeline-silence-thresholds
  // Body: { thresholds: Record<string, number> } — keys are "pipeline::stage", values are hours
  app.put("/api/admin/settings/pipeline-silence-thresholds", requireRole("admin"), async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const thresholds = body.thresholds;
      if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
        return res.status(400).json({ message: "thresholds must be an object" });
      }
      // Validate: all values must be positive numbers
      for (const [key, val] of Object.entries(thresholds as Record<string, unknown>)) {
        if (typeof val !== "number" || val <= 0 || !isFinite(val)) {
          return res.status(400).json({ message: `Invalid threshold for "${key}": must be a positive number (hours)` });
        }
      }
      await storage.setSystemSetting("pipeline_silence_thresholds", thresholds);
      await storage.createAuditLog({
        action: "pipeline_silence_thresholds_updated",
        entityType: "system",
        userId: (req.user as any)?.id ?? null,
        details: { thresholds },
      });
      res.json({ thresholds });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ZeroBounce daily usage reporting. Usage is observed, not capped locally.
  app.get("/api/admin/settings/zerobounce-usage", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getZeroBounceUsageToday } = await import("../services/zerobounce-daily-limiter");
      res.json({ usedToday: await getZeroBounceUsageToday() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET/PUT /api/admin/settings/zerobounce-auto-run
  app.get("/api/admin/settings/zerobounce-auto-run", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const val = await storage.getSystemSetting("zerobounce_auto_run_enabled");
      res.json({ enabled: val === true || val === "true" });
    } catch (err: any) { serverError(res, err); }
  });
  app.put("/api/admin/settings/zerobounce-auto-run", requireRole("admin"), async (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") {
        return res.status(400).json({ message: "enabled (boolean) is required" });
      }
      await storage.setSystemSetting("zerobounce_auto_run_enabled", req.body.enabled);
      await storage.createAuditLog({
        action: "zerobounce_auto_run_updated",
        entityType: "system",
        userId: (req.user as any)?.id ?? null,
        details: { enabled: req.body.enabled },
      });
      res.json({ enabled: req.body.enabled });
    } catch (err: any) { serverError(res, err); }
  });

  // Consolidated ZeroBounce safety view for Settings → Integrations. The
  // automatic MI-09 lane is intentionally independent from operator-triggered
  // legacy batch validation and defaults to off when no setting exists.
  app.get("/api/admin/settings/zerobounce-safety", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getPaidProviderControls } = await import("../services/paid-provider-control");
      const snapshot = await getPaidProviderControls();
      res.json(snapshot.zeroBounce);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // BT-10 provider control. Credentials never enable spend: enablement is
  // explicitly controlled by an administrator and audited.
  app.get("/api/admin/provider-controls/zerobounce", requireRole("admin", "manager"), async (_req, res) => {
    const result = await db.execute(sql`
      SELECT provider, enabled, circuit_state, reserved_units,
             consumed_units, last_completed_at, last_outcome, updated_at
        FROM provider_controls WHERE provider = 'zerobounce'
    `);
    res.json({ control: (result as any).rows?.[0] ?? null });
  });
  app.put("/api/admin/provider-controls/zerobounce", requireRole("admin"), async (req, res) => {
    try {
      const { enabled } = req.body as { enabled?: unknown };
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be boolean" });
      }
      const result = await db.execute(sql`
        INSERT INTO provider_controls (provider, capability, enabled, circuit_state, reserved_units, consumed_units, version, updated_at)
        VALUES ('zerobounce', 'email_validation', ${enabled}, 'closed', 0, 0, 1, NOW())
        ON CONFLICT (provider) DO UPDATE
          SET enabled=EXCLUDED.enabled,
              version=provider_controls.version+1, updated_at=NOW()
        RETURNING provider, enabled, circuit_state, reserved_units, consumed_units, version
      `);
      await storage.createAuditLog({
        action: "provider_control_updated", entityType: "provider_control",
        userId: (req.user as any)?.id ?? null,
        details: { provider: "zerobounce", enabled },
      });
      res.json({ control: (result as any).rows?.[0] });
    } catch (err: any) { serverError(res, err); }
  });

  // Task #1956 step 5: same shared provider_controls authority extended to
  // outscraper/openai's CRO03C circuit breaker + emergency stop, closing the
  // confirmed hardening gap without creating a parallel control system.
  //
  // Corrective item 5 (Task #1971 continuation): apollo previously had NO
  // individual admin control route at all — serper has its own dedicated
  // /api/admin/serper/* set, zerobounce and outscraper/openai had this shared
  // route, but an admin could only ever touch apollo via the blanket
  // "emergency stop ALL paid providers" button. Added here for parity; the
  // real fail-closed enforcement (assertCro03cSharedProviderControlOpen /
  // provider-context.ts's reservation gate) already covered apollo — only
  // the admin control surface was missing.
  const CRO03C_SHARED_CONTROL_PROVIDERS = new Set(["outscraper", "openai", "apollo"]);
  const CRO03C_SHARED_CONTROL_CAPABILITY: Record<string, string> = {
    outscraper: "cro03_enrichment",
    openai: "cro03_classification",
    apollo: "contact_enrichment",
  };
  app.get("/api/admin/provider-controls/:provider", requireRole("admin", "manager"), async (req, res) => {
    const provider = String(req.params.provider);
    if (!CRO03C_SHARED_CONTROL_PROVIDERS.has(provider)) return res.status(404).json({ message: "unknown_provider" });
    const result = await db.execute(sql`
      SELECT provider, enabled, circuit_state, local_budget_units, reserved_units,
             consumed_units, last_completed_at, last_outcome, updated_at
        FROM provider_controls WHERE provider = ${provider}
    `);
    res.json({ control: (result as any).rows?.[0] ?? null });
  });
  app.put("/api/admin/provider-controls/:provider", requireRole("admin"), async (req, res) => {
    try {
      const provider = String(req.params.provider);
      if (!CRO03C_SHARED_CONTROL_PROVIDERS.has(provider)) return res.status(404).json({ message: "unknown_provider" });
      const { enabled, circuitState, budgetUnits } = req.body as { enabled?: unknown; circuitState?: unknown; budgetUnits?: unknown };
      if (typeof enabled !== "boolean" || !Number.isInteger(budgetUnits) || Number(budgetUnits) < 0 || Number(budgetUnits) > 1_000_000) {
        return res.status(400).json({ message: "enabled must be boolean and budgetUnits must be an integer from 0 to 1000000" });
      }
      const resolvedCircuitState = circuitState === "open" || circuitState === "half_open" ? circuitState : "closed";
      const result = await db.execute(sql`
        INSERT INTO provider_controls (provider, capability, enabled, circuit_state, local_budget_units, reserved_units, consumed_units, version, updated_at)
        VALUES (${provider}, ${CRO03C_SHARED_CONTROL_CAPABILITY[provider]}, ${enabled}, ${resolvedCircuitState}, ${Number(budgetUnits)}, 0, 0, 1, NOW())
        ON CONFLICT (provider) DO UPDATE
          SET enabled=EXCLUDED.enabled, circuit_state=EXCLUDED.circuit_state, local_budget_units=EXCLUDED.local_budget_units,
              version=provider_controls.version+1, updated_at=NOW()
        RETURNING provider, enabled, circuit_state, local_budget_units, reserved_units, consumed_units, version
      `);
      await storage.createAuditLog({
        action: "provider_control_updated", entityType: "provider_control",
        userId: (req.user as any)?.id ?? null,
        details: { provider, enabled, circuitState: resolvedCircuitState, budgetUnits: Number(budgetUnits) },
      });
      res.json({ control: (result as any).rows?.[0] });
    } catch (err: any) { serverError(res, err); }
  });

  // === WORKER INTERVAL CONTROLS (Step 1 — #1444) ===

  // GET /api/admin/settings/worker-intervals
  // Reports the currently-running effective intervals from the live QueueManager
  // instance (populated at startup from QUEUE_CONFIGS and updated by PUT calls).
  app.get("/api/admin/settings/worker-intervals", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { QUEUE_NAMES: QN, QUEUE_CONFIGS: QC, getEffectiveQueueIntervals } = await import("../services/queue-manager");
      const GHL_FLOOR  = 30_000;
      const SLA_FLOOR  = 120_000;

      // Prefer live effective intervals (updated at runtime) → then system_settings
      // overrides → then the value from QUEUE_CONFIGS (the real startup default).
      const live = getEffectiveQueueIntervals();
      const ghlConfig = QC.find(c => c.name === QN.GHL_SYNC);
      const slaConfig = QC.find(c => c.name === QN.SLA_CHECKS);

      const [ghlRaw, slaRaw] = await Promise.all([
        storage.getSystemSetting("ghl_sync_interval_ms"),
        storage.getSystemSetting("sla_check_interval_ms"),
      ]);

      const ghlEffective  = live[QN.GHL_SYNC]  ?? (typeof ghlRaw === "number" ? ghlRaw  : (ghlConfig?.repeatEveryMs  ?? GHL_FLOOR));
      const slaEffective  = live[QN.SLA_CHECKS] ?? (typeof slaRaw === "number" ? slaRaw  : (slaConfig?.repeatEveryMs  ?? SLA_FLOOR));

      res.json({
        ghlSyncIntervalMs:  Math.max(ghlEffective, GHL_FLOOR),
        slaCheckIntervalMs: Math.max(slaEffective, SLA_FLOOR),
        ghlFloorMs:  GHL_FLOOR,
        slaFloorMs:  SLA_FLOOR,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PUT /api/admin/settings/worker-intervals
  // Persists to system_settings AND live-updates the BullMQ repeatable job
  // schedule so the change takes effect on the next queue cycle — no restart needed.
  app.put("/api/admin/settings/worker-intervals", requireRole("admin"), async (req, res) => {
    try {
      const { QUEUE_NAMES: QN, updateQueueIntervalLive } = await import("../services/queue-manager");
      const GHL_FLOOR = 30_000;
      const SLA_FLOOR = 120_000;
      const { ghlSyncIntervalMs, slaCheckIntervalMs } = req.body as Record<string, unknown>;

      const results: Record<string, { updated: boolean; effectiveMs: number }> = {};

      if (ghlSyncIntervalMs !== undefined) {
        const v = Number(ghlSyncIntervalMs);
        if (!isFinite(v) || v < GHL_FLOOR) return res.status(400).json({ message: `ghlSyncIntervalMs must be >= ${GHL_FLOOR}` });
        await storage.setSystemSetting("ghl_sync_interval_ms", v);
        // Live-update the BullMQ repeatable job so this takes effect immediately.
        results.ghlSync = await updateQueueIntervalLive(QN.GHL_SYNC, v);
      }
      if (slaCheckIntervalMs !== undefined) {
        const v = Number(slaCheckIntervalMs);
        if (!isFinite(v) || v < SLA_FLOOR) return res.status(400).json({ message: `slaCheckIntervalMs must be >= ${SLA_FLOOR}` });
        await storage.setSystemSetting("sla_check_interval_ms", v);
        // Live-update the BullMQ repeatable job so this takes effect immediately.
        results.slaChecks = await updateQueueIntervalLive(QN.SLA_CHECKS, v);
      }
      await storage.createAuditLog({
        action: "worker_intervals_updated",
        entityType: "system",
        userId: (req.user as any)?.id ?? null,
        details: { ghlSyncIntervalMs, slaCheckIntervalMs, liveUpdateResults: results },
      });
      res.json({ ok: true, liveUpdateResults: results });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/admin/worker-heartbeats (Step 2 — #1444)
  // Derives queue list and expected intervals from QUEUE_CONFIGS (the real registry).
  // GHL_SYNC is excluded when the legacy setInterval loop has claimed GHL sync duty
  // for this process — that loop does not write a BullMQ heartbeat, so including it
  // would produce a permanently stale/misleading entry.
  app.get("/api/admin/worker-heartbeats", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { QUEUE_CONFIGS: QC, getEffectiveQueueIntervals, isLegacyGhlSyncClaimed, QUEUE_NAMES: QN, getQueueManagerProducers } = await import("../services/queue-manager");
      const live = getEffectiveQueueIntervals();
      const legacyGhl = isLegacyGhlSyncClaimed();
      const now = Date.now();
      const qm = getQueueManagerProducers();

      // Corrective addition (Liberty Bancard enrichment completion,
      // continuation — item 4): heartbeats alone only prove "did the
      // scheduler tick recently" — they say nothing about backlog, retry
      // pressure, or WHY a worker is idle. Add real backlog/retry counts
      // from the live BullMQ queue when available, and surface the
      // canonical pause reason so a paused-but-healthy worker is
      // distinguishable from a genuinely stalled one.
      const { getPauseState } = await import("../services/outbound-pause-authority");
      const pauseState = await getPauseState().catch(() => null);

      // Only include queues that are actively managed by BullMQ in this process.
      const activeConfigs = legacyGhl ? QC.filter(c => c.name !== QN.GHL_SYNC) : QC;

      const entries = await Promise.all(
        activeConfigs.map(async (config) => {
          const raw = await storage.getSystemSetting(`worker_heartbeat_${config.name}`);
          const lastSeenMs = typeof raw === "number" ? raw : null;
          // Use the live effective interval (may include a persisted override) if available.
          const expectedMs = live[config.name] ?? config.repeatEveryMs;
          const stale = lastSeenMs === null || (now - lastSeenMs) > expectedMs * 2;

          let backlog: { waiting: number; active: number; delayed: number; failed: number } | null = null;
          try {
            const queue = qm?.getQueue(config.name);
            if (queue) {
              const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
              backlog = {
                waiting: counts.waiting ?? 0,
                active: counts.active ?? 0,
                delayed: counts.delayed ?? 0,
                failed: counts.failed ?? 0,
              };
            }
          } catch {
            backlog = null; // BullMQ/Redis unreachable — report as unavailable, never fabricate 0s.
          }

          return {
            queueName: config.name,
            lastSeenMs,
            lastSeenAt: lastSeenMs ? new Date(lastSeenMs).toISOString() : null,
            expectedIntervalMs: expectedMs,
            stale,
            backlog,
            backlogAvailable: backlog !== null,
          };
        })
      );
      res.json({
        heartbeats: entries,
        asOf: new Date(now).toISOString(),
        legacyGhlActive: legacyGhl,
        pauseReason: pauseState ? { state: pauseState.state, reason: pauseState.reason, source: pauseState.source } : { state: "unknown", reason: "outbound pause authority unavailable", source: "safe_default" },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === CONTACT SCORING JOB ===

  // Preview endpoint: returns eligible count, estimated batches, sample IDs
  app.post("/api/admin/contacts/score-all/preview", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { previewScoringJob } = await import("../services/contact-scoring-job");
      const mode = req.body?.mode === "rescore" ? "rescore" : "backfill";
      const result = await previewScoringJob(mode);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Start backfill (admin or manager)
  app.post("/api/admin/contacts/score-all", requireRole("admin", "manager"), async (req, res) => {
    try {
      return res.status(503).json({
        message: "Mass scoring is disabled pending durable command ownership.",
        execution: "unavailable",
      });
      const { startScoringJob } = await import("../services/contact-scoring-job");
      const { confirmed, mode, batchSize } = req.body ?? {};

      if (!confirmed) {
        return res.status(400).json({ message: "confirmed: true is required." });
      }

      // Rescore mode requires admin only (not manager) — enforced here explicitly
      if (mode === "rescore") {
        const userRole = (req.user as any)?.role;
        if (userRole !== "admin") {
          return res.status(403).json({ message: "Re-score mode requires admin role." });
        }
        const { confirmationText } = req.body;
        if (confirmationText !== "RE-SCORE ALL CONTACTS") {
          return res.status(400).json({ message: "Typed confirmation 'RE-SCORE ALL CONTACTS' required to rescore all contacts." });
        }
      }

      const { preflightToken } = req.body ?? {};
      await startScoringJob({
        mode: mode === "rescore" ? "rescore" : "backfill",
        batchSize,
        adminUserId: String((req.user as any)?.id ?? ""),
        preflightToken: preflightToken ?? null,
      });
      res.status(202).json({ message: "Scoring job started." });
    } catch (err: any) {
      if (err.message === "A scoring job is already running.") {
        // Return current persisted progress so the client can render state
        try {
          const { getScoringProgress } = await import("../services/contact-scoring-job");
          const current = await getScoringProgress();
          return res.status(409).json({ message: err.message, progress: current });
        } catch {
          return res.status(409).json({ message: err.message });
        }
      }
      serverError(res, err);
    }
  });

  app.get("/api/admin/contacts/score-all/status", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getScoringProgress, isScoringJobRunning } = await import("../services/contact-scoring-job");
      const progress = await getScoringProgress();
      res.json({ ...progress, jobRunning: isScoringJobRunning() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/contacts/score-all/cancel", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isScoringJobRunning, cancelScoringJob } = await import("../services/contact-scoring-job");
      if (!isScoringJobRunning()) {
        return res.status(400).json({ message: "No scoring job is currently running." });
      }
      await cancelScoringJob();
      res.json({ message: "Cancel requested. The job will stop after the current batch." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === BULK ENROLLMENT JOB ===
  app.post("/api/admin/contacts/bulk-enroll/preview", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { previewBulkEnroll } = await import("../services/bulk-enrollment-job");
      const { vertical, minScore, sequenceId, campaignId } = req.body ?? {};
      if (!vertical) return res.status(400).json({ message: "vertical is required." });
      const result = await previewBulkEnroll({
        vertical,
        minScore: Number(minScore) || 70,
        sequenceId: sequenceId ? Number(sequenceId) : undefined,
        campaignId: campaignId ? Number(campaignId) : undefined,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  app.post("/api/admin/contacts/bulk-enroll", requireRole("admin", "manager"), async (req, res) => {
    try {
      if (!(globalThis as { __BT10_DURABLE_LONG_OPERATION_OWNER__?: boolean }).__BT10_DURABLE_LONG_OPERATION_OWNER__) {
        return res.status(503).json({ code: "DURABLE_COMMAND_REQUIRED", message: "Bulk enrollment requires a durable command." });
      }
      const { isBulkEnrollJobRunning, startBulkEnrollJob, previewBulkEnroll } = await import("../services/bulk-enrollment-job");
      const { vertical, minScore, sequenceId, campaignId, confirmed, confirmationText } = req.body ?? {};

      if (!vertical) return res.status(400).json({ message: "vertical is required." });
      if (!confirmed) return res.status(400).json({ message: "confirmed: true is required." });

      if (isBulkEnrollJobRunning()) {
        return res.status(409).json({ message: "A bulk enrollment job is already running." });
      }

      const preview = await previewBulkEnroll({
        vertical,
        minScore: Number(minScore) || 70,
        sequenceId: sequenceId ? Number(sequenceId) : undefined,
        campaignId: campaignId ? Number(campaignId) : undefined,
      });

      if (preview.eligible >= 100 && confirmationText !== "ENROLL") {
        return res.status(400).json({
          message: `Typed confirmation 'ENROLL' required when eligible count is ≥ 100 (found ${preview.eligible}).`,
          eligible: preview.eligible,
          requiresTypedConfirmation: true,
        });
      }

      await startBulkEnrollJob({
        vertical,
        minScore: Number(minScore) || 70,
        sequenceId: sequenceId ? Number(sequenceId) : undefined,
        campaignId: campaignId ? Number(campaignId) : undefined,
      });

      res.status(202).json({ message: "Bulk enrollment job started.", eligible: preview.eligible });
    } catch (err: any) {
      if (err.message === "A bulk enrollment job is already running.") {
        return res.status(409).json({ message: err.message });
      }
      res.status(400).json({ message: err.message });
    }
  });

  app.get("/api/admin/contacts/bulk-enroll/status", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getBulkEnrollProgress, isBulkEnrollJobRunning } = await import("../services/bulk-enrollment-job");
      const progress = await getBulkEnrollProgress();
      res.json({ ...progress, jobRunning: isBulkEnrollJobRunning() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/contacts/bulk-enroll/cancel", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isBulkEnrollJobRunning, cancelBulkEnrollJob } = await import("../services/bulk-enrollment-job");
      if (!isBulkEnrollJobRunning()) {
        return res.status(400).json({ message: "No bulk enrollment job is currently running." });
      }
      await cancelBulkEnrollJob();
      res.json({ message: "Cancel requested. The job will stop after the current contact." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── PIPELINE STAGE HEALTH ─────────────────────────────────────────────────
  app.get("/api/admin/pipeline/stage-health", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { deals: dealsTable, sequenceEnrollments: enrollmentsTable, contacts: contactsTable, followUpSequences: sequencesTable } = await import("@shared/schema");
      const { eq, and, isNull, inArray, or, count: drizzleCount } = await import("drizzle-orm");

      // 1. Total New Lead deals (non-archived)
      const [totalRow] = await db.select({ count: drizzleCount() }).from(dealsTable).where(
        and(eq(dealsTable.pipeline, "sales"), eq(dealsTable.stage, "New Lead"), isNull(dealsTable.archivedAt))
      );
      const totalNewLeadDeals = totalRow?.count ?? 0;

      // 2. Stuck 7+ days (uses updatedAt — documented limitation)
      const staleDealsRaw = await storage.getDealsStuckInStage("New Lead", 7 * 24 * 60);
      const staleDeals = staleDealsRaw.slice(0, 25).map((d: any) => ({
        dealId: d.id,
        contactId: d.contactId,
        vertical: d.vertical ?? null,
        updatedAt: d.updatedAt,
        createdAt: d.createdAt,
      }));

      // 3. Fetch all New Lead deals with their contact data (for enrollment + breakdown queries)
      const allNewLeadDealsWithContacts = await db
        .select({
          dealId: dealsTable.id,
          dealVertical: dealsTable.vertical,
          contactId: dealsTable.contactId,
          autoEnrollmentSuppressedAt: dealsTable.autoEnrollmentSuppressedAt,
          contactEmail: contactsTable.email,
          contactPhone: contactsTable.phone,
          contactDoNotContact: contactsTable.doNotContact,
          contactConsentTier: contactsTable.consentTier,
          contactOptedOutEmail: contactsTable.optedOutEmail,
        })
        .from(dealsTable)
        .leftJoin(contactsTable, eq(dealsTable.contactId, contactsTable.id))
        .where(
          and(eq(dealsTable.pipeline, "sales"), eq(dealsTable.stage, "New Lead"), isNull(dealsTable.archivedAt))
        );

      const contactIds = allNewLeadDealsWithContacts
        .map((d) => d.contactId)
        .filter(Boolean) as number[];

      let enrolledContactIds = new Set<number>();
      if (contactIds.length > 0) {
        // Fetch all enrollments for these contacts, filter covered statuses in JS
        // (avoids any ORM text-column IN() ambiguity)
        const allEnrollmentsForContacts = await db
          .select({ contactId: enrollmentsTable.contactId, status: enrollmentsTable.status })
          .from(enrollmentsTable)
          .where(inArray(enrollmentsTable.contactId, contactIds));
        const COVERED_STATUSES = new Set(["active", "completed"]);
        enrolledContactIds = new Set(
          allEnrollmentsForContacts
            .filter((e) => COVERED_STATUSES.has(e.status ?? ""))
            .map((e) => Number(e.contactId))
        );
      }

      const newLeadNoActiveEnrollment = allNewLeadDealsWithContacts.filter(
        (d) => !d.contactId || !enrolledContactIds.has(d.contactId)
      ).length;

      // 4. Suppressed count (deals with autoEnrollmentSuppressedAt IS NOT NULL, not already DNC)
      const suppressedDeals = allNewLeadDealsWithContacts.filter(
        (d) => d.autoEnrollmentSuppressedAt != null
      );
      const newLeadAutoEnrollmentSuppressed = suppressedDeals.filter((d) => {
        if (!d.contactId) return true;
        const isDnc = d.contactDoNotContact === true || d.contactConsentTier === "do_not_contact";
        return !isDnc;
      }).length;

      // 5. Vertical sequence map + default sequence (for breakdown)
      const { getVerticalSequenceMap, getDefaultSequenceId } = await import("../services/new-lead-enrollment-job");
      const [verticalMap, defaultSeqId] = await Promise.all([
        getVerticalSequenceMap(),
        getDefaultSequenceId(),
      ]);

      // Build a set of all referenced sequence IDs to resolve names in one query
      const allMappedSeqIds = new Set<number>(Object.values(verticalMap).filter(Boolean));
      if (defaultSeqId) allMappedSeqIds.add(defaultSeqId);
      let seqNameMap: Record<number, string> = {};
      if (allMappedSeqIds.size > 0) {
        const seqRows = await db
          .select({ id: sequencesTable.id, name: sequencesTable.name })
          .from(sequencesTable)
          .where(inArray(sequencesTable.id, Array.from(allMappedSeqIds)));
        for (const row of seqRows) seqNameMap[row.id] = row.name;
      }

      // 6. Build breakdownByVertical — group deals by deal.vertical
      const verticalGroups: Map<string | null, typeof allNewLeadDealsWithContacts> = new Map();
      for (const row of allNewLeadDealsWithContacts) {
        const key = row.dealVertical ?? null;
        if (!verticalGroups.has(key)) verticalGroups.set(key, []);
        verticalGroups.get(key)!.push(row);
      }
      // Ensure null/"" vertical always present when there are deals without a vertical
      // (already handled by the loop above — null keys will be included)

      const breakdownByVertical = Array.from(verticalGroups.entries()).map(([vertical, rows]) => {
        const label = vertical ? vertical : "Unknown / Uncategorized";
        const totalDeals = rows.filter((r) => r.contactId != null).length;
        const enrolled = rows.filter((r) => r.contactId != null && enrolledContactIds.has(r.contactId)).length;
        const noActiveEnrollment = totalDeals - enrolled;

        const resolvedSeqId = (vertical && verticalMap[vertical]) ? verticalMap[vertical] : (defaultSeqId ?? null);
        const noSequenceMapped = resolvedSeqId == null ? rows.filter((r) => r.contactId != null).length : 0;

        const noEmail = rows.filter((r) => r.contactId != null && (!r.contactEmail || r.contactEmail.trim() === "")).length;
        const dncBlocked = rows.filter((r) => r.contactId != null && r.contactDoNotContact === true).length;
        const optedOutBlocked = rows.filter((r) => {
          if (!r.contactId) return false;
          const tier = r.contactConsentTier ?? "cold_no_consent";
          return tier === "opted_out" || tier === "do_not_contact" || r.contactOptedOutEmail === true;
        }).length;
        const suppressed = rows.filter((r) => r.contactId != null && r.autoEnrollmentSuppressedAt != null).length;

        const mappedSequenceId = resolvedSeqId ?? null;
        const mappedSequenceName = mappedSequenceId ? (seqNameMap[mappedSequenceId] ?? null) : null;

        let sequenceMappingSource: "explicit" | "default" | "none";
        if (vertical !== null && verticalMap[vertical]) {
          sequenceMappingSource = "explicit";
        } else if (defaultSeqId != null) {
          sequenceMappingSource = "default";
        } else {
          sequenceMappingSource = "none";
        }

        return {
          vertical,
          label,
          totalDeals,
          enrolled,
          noActiveEnrollment,
          noSequenceMapped,
          noEmail,
          dncBlocked,
          optedOutBlocked,
          suppressed,
          mappedSequenceId,
          mappedSequenceName,
          sequenceMappingSource,
        };
      });

      // Sort: noActiveEnrollment desc, then totalDeals desc
      breakdownByVertical.sort((a, b) => {
        if (b.noActiveEnrollment !== a.noActiveEnrollment) return b.noActiveEnrollment - a.noActiveEnrollment;
        return b.totalDeals - a.totalDeals;
      });

      // 7. System settings
      const [lastSweep, lastTick, autoEnroll] = await Promise.all([
        storage.getSystemSetting("stage_progression_last_run"),
        storage.getSystemSetting("sequence_runner_last_tick"),
        storage.getSystemSetting("autoEnrollNewLeadDeals"),
      ]);

      res.json({
        totalNewLeadDeals,
        newLeadNoMovement7d: staleDealsRaw.length,
        newLeadNoActiveEnrollment,
        newLeadAutoEnrollmentSuppressed,
        autoEnrollNewLeadDeals: autoEnroll === true,
        lastStageProgressionSweepAt: (lastSweep as any)?.at ?? null,
        lastSequenceWorkerTickAt: (lastTick as any)?.at ?? null,
        staleness_proxy: "updatedAt",
        staleDeals,
        breakdownByVertical,
        verticalSequenceMap: verticalMap,
        defaultSequenceId: defaultSeqId ?? null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── PIPELINE STAGE HEALTH — VERTICAL DETAIL ─────────────────────────────
  // GET /api/admin/pipeline/stage-health/vertical-detail
  // Returns blocked deal rows for a single vertical with block reason per row.
  // Query params: vertical (string or __unknown__), limit (default 50, max 200), offset (default 0)
  // Block reason precedence: suppressed → DNC → opted_out → no_email →
  //   no_sequence_mapped → sequence_inactive → already_enrolled → contactability_blocked → unknown
  app.get("/api/admin/pipeline/stage-health/vertical-detail", requireRole("admin", "manager"), async (req, res) => {
    try {
      const rawVertical = req.query.vertical as string | undefined;
      const limitRaw = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      const offsetRaw = Math.max(Number(req.query.offset ?? 0) || 0, 0);

      const VALID_BLOCK_REASONS = new Set([
        "suppressed", "DNC", "opted_out", "no_email",
        "no_sequence_mapped", "sequence_inactive", "already_enrolled",
        "contactability_blocked", "unknown",
      ]);
      const rawBlockReason = req.query.blockReason as string | undefined;
      if (rawBlockReason !== undefined && rawBlockReason !== "all" && !VALID_BLOCK_REASONS.has(rawBlockReason)) {
        return res.status(400).json({ message: "Invalid blockReason value" });
      }
      const blockReasonFilter: string | null =
        !rawBlockReason || rawBlockReason === "all" ? null : rawBlockReason;

      // Map __unknown__ or absent → null (unset vertical)
      const vertical: string | null =
        rawVertical === "__unknown__" || rawVertical === undefined || rawVertical === ""
          ? null
          : rawVertical;

      const {
        deals: dealsTable,
        sequenceEnrollments: enrollmentsTable,
        contacts: contactsTable,
        followUpSequences: sequencesTable,
      } = await import("@shared/schema");
      const { eq, and, isNull, inArray, desc } = await import("drizzle-orm");

      // Fetch all New Lead deals for this vertical with contact data
      const baseConditions = [
        eq(dealsTable.pipeline, "sales"),
        eq(dealsTable.stage, "New Lead"),
        isNull(dealsTable.archivedAt),
      ];
      const verticalCondition =
        vertical === null ? isNull(dealsTable.vertical) : eq(dealsTable.vertical, vertical);

      const dealRows = await db
        .select({
          dealId: dealsTable.id,
          dealVertical: dealsTable.vertical,
          contactId: dealsTable.contactId,
          autoEnrollmentSuppressedAt: dealsTable.autoEnrollmentSuppressedAt,
          updatedAt: dealsTable.updatedAt,
          contactFirstName: contactsTable.firstName,
          contactLastName: contactsTable.lastName,
          contactCompanyName: contactsTable.companyName,
          contactEmail: contactsTable.email,
          contactPhone: contactsTable.phone,
          contactDoNotContact: contactsTable.doNotContact,
          contactConsentTier: contactsTable.consentTier,
          contactOptedOutEmail: contactsTable.optedOutEmail,
          contactDoNotAutoContact: contactsTable.doNotAutoContact,
          contactEmailStatus: contactsTable.emailStatus,
          contactLeadScore: contactsTable.leadScore,
        })
        .from(dealsTable)
        .leftJoin(contactsTable, eq(dealsTable.contactId, contactsTable.id))
        .where(and(...baseConditions, verticalCondition))
        // Stable ORDER BY for consistent pagination across "Load more" calls
        .orderBy(desc(dealsTable.updatedAt), desc(dealsTable.id));

      const contactIds = dealRows
        .map((d) => d.contactId)
        .filter(Boolean) as number[];

      // Enrolled = active | completed (same definition as aggregate)
      let enrolledContactIds = new Set<number>();
      // Any enrollment (any status) for already_enrolled check
      const anyEnrollmentContactIds = new Set<number>();

      if (contactIds.length > 0) {
        const allEnrollments = await db
          .select({ contactId: enrollmentsTable.contactId, status: enrollmentsTable.status })
          .from(enrollmentsTable)
          .where(inArray(enrollmentsTable.contactId, contactIds));

        const COVERED_STATUSES = new Set(["active", "completed"]);
        for (const e of allEnrollments) {
          const cid = Number(e.contactId);
          if (COVERED_STATUSES.has(e.status ?? "")) enrolledContactIds.add(cid);
          anyEnrollmentContactIds.add(cid);
        }
      }

      // Vertical sequence map + default (same as aggregate)
      const { getVerticalSequenceMap, getDefaultSequenceId } = await import(
        "../services/new-lead-enrollment-job"
      );
      const [verticalMap, defaultSeqId] = await Promise.all([
        getVerticalSequenceMap(),
        getDefaultSequenceId(),
      ]);

      const resolvedSeqId =
        vertical && verticalMap[vertical] ? verticalMap[vertical] : (defaultSeqId ?? null);

      let resolvedSeqStatus: string | null = null;
      let resolvedSeqName: string | null = null;
      if (resolvedSeqId) {
        const [seqRow] = await db
          .select({ id: sequencesTable.id, name: sequencesTable.name, status: sequencesTable.status })
          .from(sequencesTable)
          .where(eq(sequencesTable.id, resolvedSeqId));
        if (seqRow) {
          resolvedSeqStatus = (seqRow.status as string | null) ?? null;
          resolvedSeqName = seqRow.name ?? null;
        }
      }

      // Block reason labels (stable machine keys)
      const BLOCK_REASON_LABELS: Record<string, string> = {
        suppressed: "Auto-enrollment suppressed",
        DNC: "Do Not Contact (DNC)",
        opted_out: "Opted out of email",
        no_email: "No email address",
        no_sequence_mapped: "No sequence mapped for this vertical",
        sequence_inactive: "Mapped sequence is inactive",
        already_enrolled: "Already enrolled (non-covered status)",
        contactability_blocked: "Blocked by contactability check",
        unknown: "Unknown block reason",
      };

      function getBlockReason(row: (typeof dealRows)[0]): string {
        // Precedence mirrors new-lead-enrollment-job.ts checks (same order):
        //   suppressed → DNC → opted_out → no_email →
        //   no_sequence_mapped → sequence_inactive → already_enrolled →
        //   contactability_blocked (doNotAutoContact or emailStatus non-active) → unknown
        if (row.autoEnrollmentSuppressedAt != null) return "suppressed";
        if (row.contactDoNotContact === true) return "DNC";
        const tier = row.contactConsentTier ?? "cold_no_consent";
        if (
          tier === "opted_out" ||
          tier === "do_not_contact" ||
          row.contactOptedOutEmail === true
        )
          return "opted_out";
        if (!row.contactEmail || row.contactEmail.trim() === "") return "no_email";
        if (resolvedSeqId == null) return "no_sequence_mapped";
        if (resolvedSeqStatus && resolvedSeqStatus !== "active") return "sequence_inactive";
        const cid = row.contactId ? Number(row.contactId) : null;
        if (cid !== null && anyEnrollmentContactIds.has(cid)) return "already_enrolled";
        // Step 3 of evaluateContactability: doNotAutoContact blocks email automation
        if (row.contactDoNotAutoContact === true) return "contactability_blocked";
        // Email status non-active (bounced, complained, etc.) blocks email sends
        if (row.contactEmailStatus && row.contactEmailStatus !== "active") return "contactability_blocked";
        return "unknown";
      }

      // Only blocked deals (not in enrolledContactIds — same semantics as aggregate noActiveEnrollment).
      // Exclude null-contactId deals to match aggregate which uses rows.filter(r => r.contactId != null).
      const blockedDeals = dealRows.filter(
        (d) => d.contactId != null && !enrolledContactIds.has(d.contactId)
      );

      // Step 1: compute block reason for ALL blocked deals before any slicing
      const now = new Date();
      const allWithReasons = blockedDeals.map((d) => ({
        ...d,
        blockReason: getBlockReason(d),
      }));

      // Step 2: apply optional blockReason filter (filter-before-pagination)
      const filteredDeals = blockReasonFilter
        ? allWithReasons.filter((d) => d.blockReason === blockReasonFilter)
        : allWithReasons;

      // Step 3: total reflects filtered count
      const total = filteredDeals.length;

      // Step 4: paginate the filtered set
      const pageRows = filteredDeals.slice(offsetRaw, offsetRaw + limitRaw);

      // Step 5: build response rows (blockReason already computed — no second call needed)
      const rows = pageRows.map((d) => {
        const updatedAt = d.updatedAt ? new Date(d.updatedAt as any) : null;
        const daysInStage = updatedAt
          ? Math.floor((now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        return {
          dealId: d.dealId,
          contactId: d.contactId ?? null,
          contactName: d.contactId
            ? `${d.contactFirstName ?? ""} ${d.contactLastName ?? ""}`.trim() || null
            : null,
          companyName: d.contactCompanyName ?? null,
          email: d.contactEmail ?? null,
          vertical: d.dealVertical ?? null,
          leadScore: d.contactLeadScore ?? null,
          mappedSequenceId: resolvedSeqId ?? null,
          mappedSequenceName: resolvedSeqName ?? null,
          blockReason: d.blockReason,
          blockReasonLabel: BLOCK_REASON_LABELS[d.blockReason] ?? "Unknown block reason",
          daysInStage,
        };
      });

      const label = vertical ? vertical : "Unknown / Uncategorized";

      res.json({
        verticalDetail: {
          vertical,
          label,
          total,
          limit: limitRaw,
          offset: offsetRaw,
          blockReason: rawBlockReason ?? "all",
          rows,
        },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── NEW LEAD ENROLLMENT SETTINGS ──────────────────────────────────────────
  app.post("/api/admin/pipeline/vertical-sequence-map", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { setVerticalSequenceMap, setDefaultSequenceId } = await import("../services/new-lead-enrollment-job");
      const { verticalMap, defaultSequenceId } = req.body ?? {};
      if (verticalMap !== undefined) {
        if (typeof verticalMap !== "object" || Array.isArray(verticalMap)) {
          return res.status(400).json({ message: "verticalMap must be an object." });
        }
        await setVerticalSequenceMap(verticalMap);
      }
      if (defaultSequenceId !== undefined) {
        await setDefaultSequenceId(defaultSequenceId === null ? null : Number(defaultSequenceId));
      }
      res.json({ saved: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/pipeline/auto-enroll-toggle", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { setAutoEnrollEnabled } = await import("../services/new-lead-enrollment-job");
      const { enabled } = req.body ?? {};
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be a boolean." });
      }
      await setAutoEnrollEnabled(enabled);
      res.json({ autoEnrollNewLeadDeals: enabled });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── NEW LEAD ENROLLMENT JOB ───────────────────────────────────────────────
  app.post("/api/admin/pipeline/new-leads/enroll-preview", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { previewNewLeadEnroll } = await import("../services/new-lead-enrollment-job");
      const result = await previewNewLeadEnroll();
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/pipeline/new-leads/enroll", requireRole("admin", "manager"), async (req, res) => {
    try {
      if (!(globalThis as { __BT10_DURABLE_LONG_OPERATION_OWNER__?: boolean }).__BT10_DURABLE_LONG_OPERATION_OWNER__) {
        return res.status(503).json({ code: "DURABLE_COMMAND_REQUIRED", message: "New-lead enrollment requires a durable command." });
      }
      const { isNewLeadEnrollJobRunning, startNewLeadEnroll, previewNewLeadEnroll } =
        await import("../services/new-lead-enrollment-job");
      const { confirmed, confirmationText } = req.body ?? {};

      if (!confirmed) {
        return res.status(400).json({ message: "confirmed: true is required." });
      }
      if (isNewLeadEnrollJobRunning()) {
        return res.status(409).json({ message: "A new-lead enrollment job is already running." });
      }

      const preview = await previewNewLeadEnroll();
      if (preview.eligible >= 100 && confirmationText !== "ENROLL") {
        return res.status(400).json({
          message: `Typed confirmation 'ENROLL' required when eligible count is ≥ 100 (found ${preview.eligible}).`,
          eligible: preview.eligible,
          requiresTypedConfirmation: true,
        });
      }

      await startNewLeadEnroll();
      res.status(202).json({ started: true, eligible: preview.eligible });
    } catch (err: any) {
      if (err.message === "A new-lead enrollment job is already running.") {
        return res.status(409).json({ message: err.message });
      }
      serverError(res, err);
    }
  });

  app.get("/api/admin/pipeline/new-leads/enroll-status", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getNewLeadEnrollProgress, isNewLeadEnrollJobRunning } =
        await import("../services/new-lead-enrollment-job");
      const progress = await getNewLeadEnrollProgress();
      res.json({ ...progress, jobRunning: isNewLeadEnrollJobRunning() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/pipeline/new-leads/enroll-cancel", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isNewLeadEnrollJobRunning, cancelNewLeadEnroll } =
        await import("../services/new-lead-enrollment-job");
      if (!isNewLeadEnrollJobRunning()) {
        return res.status(400).json({ message: "No new-lead enrollment job is currently running." });
      }
      await cancelNewLeadEnroll();
      res.json({ cancelled: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── CAN-SPAM cold-email config health ─────────────────────────────────────
  app.get("/api/admin/cold-email-health", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const mailingAddress = await storage.getSystemSetting("compliance_mailing_address") as string | null | undefined;
      const hasMailingAddress = !!mailingAddress && String(mailingAddress).trim().length > 0;

      const hasUnsubscribeTokenSecret =
        !!(process.env.UNSUBSCRIBE_TOKEN_SECRET || process.env.SESSION_SECRET);

      const appUrl = process.env.APP_URL;
      const hasAppUrl = !!(appUrl && appUrl.trim().length > 0);

      const coldEmailReady = hasMailingAddress && hasUnsubscribeTokenSecret && hasAppUrl;

      res.json({
        hasMailingAddress,
        hasUnsubscribeTokenSecret,
        hasAppUrl,
        coldEmailReady,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Communications Readiness Checklist ────────────────────────────────────
  // Single endpoint summarising every pre-send configuration requirement.
  // Used by the Activation Panel and monitoring to gate outbound sends.
  app.get("/api/admin/comms-readiness", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isGhlConfigured } = await import("../services/ghl");
      const { isSmtpConfigured } = await import("../services/smtp-email");
      const { getGhlCircuitStatus } = await import("../services/ghl-sync");
      const { getAllSenderProfiles } = await import("../services/email-signatures");

      const mailingAddress = await storage.getSystemSetting("compliance_mailing_address") as string | null | undefined;
      const unsubscribeSecret = !!(process.env.UNSUBSCRIBE_TOKEN_SECRET || process.env.SESSION_SECRET);
      const appUrl = process.env.APP_URL;
      const circuit = getGhlCircuitStatus();
      const ghlOk = isGhlConfigured() && !circuit.circuitOpen;
      const smtpOk = isSmtpConfigured();
      const senderProfiles = await getAllSenderProfiles();

      const hasSalesProfile = !!(senderProfiles.sales?.name && senderProfiles.sales?.email);
      const hasSupportProfile = !!(senderProfiles.support?.name && senderProfiles.support?.email);
      const hasOnboardingProfile = !!(senderProfiles.onboarding?.name && senderProfiles.onboarding?.email);
      const hasMailingAddress = !!mailingAddress && String(mailingAddress).trim().length > 0;
      const hasAppUrl = !!(appUrl && appUrl.trim().length > 0);

      const { getPauseState } = await import("../services/outbound-pause-authority");
      const pauseState = await getPauseState();
      const isPaused = pauseState.state !== "unpaused" || pauseState.source === "safe_default";

      const sendChannelReady = ghlOk || smtpOk;
      const coldEmailReady = hasMailingAddress && unsubscribeSecret && hasAppUrl && sendChannelReady;
      const transactionalReady = sendChannelReady && hasSalesProfile && hasOnboardingProfile;
      const overallReady = coldEmailReady && transactionalReady && !isPaused;

      res.json({
        overallReady,
        outboundGlobalPaused: isPaused,
        checks: {
          ghl:               { ok: isGhlConfigured(), label: "GHL configured" },
          ghlCircuit:        { ok: !circuit.circuitOpen, label: "GHL circuit closed", consecutiveFailures: circuit.consecutiveFailures },
          smtp:              { ok: smtpOk, label: "SMTP configured" },
          sendChannel:       { ok: sendChannelReady, label: "At least one send channel ready (GHL or SMTP)" },
          mailingAddress:    { ok: hasMailingAddress, label: "CAN-SPAM mailing address set" },
          unsubscribeSecret: { ok: unsubscribeSecret, label: "Unsubscribe token secret set" },
          appUrl:            { ok: hasAppUrl, label: "APP_URL configured" },
          salesProfile:      { ok: hasSalesProfile, label: "Sales sender profile configured", value: senderProfiles.sales?.email },
          supportProfile:    { ok: hasSupportProfile, label: "Support sender profile configured", value: senderProfiles.support?.email },
          onboardingProfile: { ok: hasOnboardingProfile, label: "Onboarding sender profile configured", value: senderProfiles.onboarding?.email },
          coldEmail:         { ok: coldEmailReady, label: "Cold outreach ready" },
          transactional:     { ok: transactionalReady, label: "Transactional emails ready" },
        },
        senderProfiles,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Sender Profile GET / PUT ──────────────────────────────────────────────
  // Allows admins to view and update the DB-backed sender profiles
  // (sales, support, onboarding) without modifying code.
  app.get("/api/admin/sender-profiles", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getAllSenderProfiles } = await import("../services/email-signatures");
      res.json(await getAllSenderProfiles());
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/admin/sender-profiles/:type", requireRole("admin", "manager"), async (req, res) => {
    try {
      const type = req.params.type as string;
      const validTypes = ["sales", "support", "onboarding"];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ message: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
      }
      const { name, title, phone, email, calendlyLink, refCode } = req.body;
      if (!name || !email) {
        return res.status(400).json({ message: "name and email are required" });
      }
      const { saveSignature, getStoredSignature } = await import("../services/email-signatures");
      const existing = await getStoredSignature(type);
      const updated = { ...existing, name, title: title || existing.title, phone: phone || existing.phone, email, ...(calendlyLink !== undefined ? { calendlyLink } : {}), ...(refCode !== undefined ? { refCode } : {}) };
      await saveSignature(type, updated);
      const user = req.user as any;
      await storage.createAuditLog({ action: "sender_profile_updated", entityType: "system", actorType: "user", actorId: String(user?.id || ""), details: { type, name, email } });
      res.json({ ok: true, type, profile: updated });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Database Backup Management ────────────────────────────────────────────
  app.get("/api/admin/backups", requireRole("admin"), async (_req, res) => {
    try {
      const { listBackups } = await import("../services/db-backup");
      res.json(await listBackups());
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/backups/run", requireRole("admin"), async (_req, res) => {
    try {
      const { runDatabaseBackup } = await import("../services/db-backup");
      const user = _req.user as any;
      const result = await runDatabaseBackup(`manual:${user?.email || "admin"}`);
      if (!result.ok) {
        // runDatabaseBackup already fires a critical alert internally — no duplicate needed here
        console.error("[Admin] Manual backup failed:", result.error);
        return res.status(500).json({ ok: false, error: safeMessage(result.error, "Backup failed") });
      }
      const _pathMod = await import("path");
      res.json({ ok: true, filePath: result.filePath ? _pathMod.basename(result.filePath) : null, sizeBytes: result.sizeBytes, durationMs: result.durationMs });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Queue Hold Ledger (#1532) — admin-only CRUD ───────────────────────────

  /** GET /api/admin/queue-holds — read all active holds + reconciliation state */
  app.get("/api/admin/queue-holds", requireRole("admin"), async (_req, res) => {
    try {
      const { outboundQueueCoordinator } = await import("../services/outbound-queue-coordinator");
      const status = await outboundQueueCoordinator.getStatus();
      // All epoch fields are already decimal strings in the DTO — safe for JSON.stringify.
      res.json({
        ok: true,
        status: status.status,
        ...(status.status === "degraded" ? { errorCode: (status as any).errorCode } : {}),
        desiredLogicalHolds: status.desiredLogicalHolds,
        physicalQueueStates: status.physicalQueueStates,
        ledgerEpoch: status.ledgerEpoch,
        reconciledAt: status.reconciledAt?.toISOString() ?? null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /** GET /api/admin/queue-holds/backlog-preview — per-source risk preview */
  app.get("/api/admin/queue-holds/backlog-preview", requireRole("admin"), async (_req, res) => {
    try {
      const { createBacklogPreviewService } = await import("../services/backlog-preview-service");
      const svc = createBacklogPreviewService(db);
      const preview = await svc.getBacklogPreview();
      res.json(preview);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /** POST /api/admin/queue-holds — add a hold */
  app.post("/api/admin/queue-holds", requireRole("admin"), async (req, res) => {
    try {
      const { z } = await import("zod");
      const schema = z.object({
        logical_job_key: z.string().min(1),
        reason_code: z.enum(["manual_operator", "maintenance", "incident", "automation_kill_switch", "channel_pause"]),
        source_type: z.string().default("operator"),
        source_key: z.string().min(1),
        expires_at: z.string().optional(),
        correlation_id: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      });
      const body = schema.parse(req.body);
      const actor = (req as any).user?.email || "admin";
      const { outboundQueueCoordinator } = await import("../services/outbound-queue-coordinator");
      const holdId = await outboundQueueCoordinator.addHold({
        logicalJobKey: body.logical_job_key,
        reasonCode: body.reason_code,
        sourceType: body.source_type,
        sourceKey: body.source_key,
        actor,
        correlationId: body.correlation_id,
        expiresAt: body.expires_at ? new Date(body.expires_at) : undefined,
        metadata: body.metadata,
      });
      res.json({ ok: true, holdId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /** DELETE /api/admin/queue-holds — clear a hold by (logicalJobKey, reasonCode, sourceKey) */
  app.delete("/api/admin/queue-holds", requireRole("admin"), async (req, res) => {
    try {
      const { z } = await import("zod");
      const schema = z.object({
        logical_job_key: z.string().min(1),
        reason_code: z.string().min(1),
        source_key: z.string().min(1),
        correlation_id: z.string().optional(),
      });
      const body = schema.parse(req.body);
      const actor = (req as any).user?.email || "admin";
      const { outboundQueueCoordinator } = await import("../services/outbound-queue-coordinator");
      const cleared = await outboundQueueCoordinator.clearHold({
        logicalJobKey: body.logical_job_key,
        reasonCode: body.reason_code as any,
        sourceKey: body.source_key,
        actor,
        correlationId: body.correlation_id,
      });
      res.json({ ok: cleared, message: cleared ? "Hold cleared" : "No active hold found for that owner" });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /** POST /api/admin/queue-holds/release-approval — approve staged release */
  app.post("/api/admin/queue-holds/release-approval", requireRole("admin"), async (req, res) => {
    try {
      const { z } = await import("zod");
      const { LOGICAL_JOB_MANIFEST } = await import("../services/logical-job-manifest");
      const validLogicalKeys = LOGICAL_JOB_MANIFEST.map((e: { logicalKey: string }) => e.logicalKey) as [string, ...string[]];

      const schema = z.object({
        logical_job_keys: z.union([
          z.literal("all"),
          z.array(z.enum(validLogicalKeys)),
        ]).optional(),
        correlation_id: z.string().optional(),
      });

      let body: { logical_job_keys?: string[] | "all"; correlation_id?: string };
      try {
        body = schema.parse(req.body ?? {});
      } catch (parseErr: any) {
        const issue = parseErr.errors?.[0];
        const offendingKey = issue?.received ?? issue?.message ?? "unknown";
        return res.status(400).json({
          ok: false,
          error: "Invalid logical_job_key",
          offendingKey,
          validKeys: validLogicalKeys,
        });
      }

      const actor = (req as any).user?.email || "admin";
      const { outboundQueueCoordinator } = await import("../services/outbound-queue-coordinator");
      const result = await outboundQueueCoordinator.approveRelease(
        Array.isArray(body.logical_job_keys) ? body.logical_job_keys : "all",
        actor,
        body.correlation_id,
      );
      res.json({
        ok: true,
        releasedKeys: result.releasedKeys,
        ledgerEpoch: result.newLedgerEpoch.toString(),
        actor,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Queue Metrics ─────────────────────────────────────────────────────────
  app.get("/api/admin/queue-metrics", requireRole("admin"), async (_req, res) => {
    try {
      const { requireQueueManagerReady } = await import("../services/queue-manager");
      let qm;
      try {
        qm = requireQueueManagerReady();
      } catch {
        const { getQueueMode } = await import("../services/queue-manager");
        return res.status(503).json({ status: "not_initialized", queueMode: getQueueMode(), queues: [] });
      }
      res.json(await qm.getTelemetryEvidence());
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Alert Feed ────────────────────────────────────────────────────────────
  app.get("/api/admin/alerts", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { getRecentAlerts } = await import("../services/alert-feed");
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const result = await getRecentAlerts(limit);
      res.status(result.degraded ? 503 : 200).json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/alerts/:id/acknowledge", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { acknowledgeAlert } = await import("../services/alert-feed");
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      const actor = (req.user as any)?.email ?? (req.user as any)?.id ?? "unknown";
      const ok = await acknowledgeAlert(Number(String(req.params.id)), String(actor), reason);
      if (!ok) return res.status(404).json({ message: "Alert not found" });
      res.json({ ok: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Launch Readiness (extended — full operator launch control panel) ─────────
  app.get("/api/admin/launch-readiness", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getCanonicalUrlInfo } = await import("../lib/canonical-url");
      const { isGhlConfigured } = await import("../services/ghl");
      const { isSmtpConfigured, getSmtpStatus } = await import("../services/smtp-email");
      const { requireQueueManagerReady } = await import("../services/queue-manager");
      const { listBackups } = await import("../services/db-backup");
      const { getRecentAlerts } = await import("../services/alert-feed");
      const { pool } = await import("../db");
      const { getGhlCircuitStatus } = await import("../services/ghl-sync");
      const { isGmailOAuthConnected, getGmailOAuthStatus } = await import("../services/gmail-oauth");

      const urlInfo = getCanonicalUrlInfo();
      const ghlOk = isGhlConfigured();
      const smtpStatus = getSmtpStatus();
      const smtpOk = isSmtpConfigured();
      const ghlCircuit = getGhlCircuitStatus();

      // ── Per-operation timeout helper ──────────────────────────────────────────
      // The launch-readiness endpoint must respond within the smoke-role-guards
      // 30-second abort window. Wrap slow async operations with a bounded race
      // so one stalled subsystem cannot block the whole response.
      function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
        return Promise.race([
          promise,
          new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
        ]);
      }

      // ── Queue metrics ─────────────────────────────────────────────────────────
      let queueMetrics: any[] = [];
      let queueMode: "bullmq_redis" | "legacy_interval_partial" | "unavailable" = "unavailable";
      let queueStatus: "ok" | "not_initialized" = "not_initialized";
      try {
        const qm = requireQueueManagerReady();
        const m = await withTimeout(qm.getAllQueueMetrics(), 8_000, null);
        if (m) {
          queueMetrics = m.queues;
          queueMode = m.queueMode;
          queueStatus = "ok";
        }
      } catch {}

      const dlqCount = queueMetrics.reduce((sum, q) => sum + (q.failed || 0), 0);
      const lastQueueFailure = queueMetrics
        .filter((q) => q.lastFailedAt)
        .sort((a, b) => new Date(b.lastFailedAt).getTime() - new Date(a.lastFailedAt).getTime())[0];

      // ── Backups ───────────────────────────────────────────────────────────────
      let backups: any[] = [];
      try { backups = await withTimeout(listBackups(), 8_000, []); } catch {}

      // ── DB health ─────────────────────────────────────────────────────────────
      let dbOk = false;
      let dbMs = 0;
      try {
        const t0 = Date.now();
        await pool.query("SELECT 1");
        dbMs = Date.now() - t0;
        dbOk = true;
      } catch {}

      // ── Alert feed ────────────────────────────────────────────────────────────
      const alertFeed: Awaited<ReturnType<typeof getRecentAlerts>> = await withTimeout(
        getRecentAlerts(20),
        8_000,
        { alerts: [], degraded: true, error: "timed out" },
      );
      const criticalAlerts = alertFeed.alerts.filter((a) => a.severity === "critical" && !a.acknowledged);

      // ── Audit log probes ──────────────────────────────────────────────────────
      const { sql: auditSql } = await import("drizzle-orm");
      async function lastAuditEntry(actions: string[]): Promise<{ createdAt: string | null; details: any }> {
        try {
          const actionList = actions.map(a => `'${a}'`).join(",");
          const rows = await db.execute(auditSql.raw(`
            SELECT created_at, details FROM audit_logs
            WHERE action IN (${actionList})
            ORDER BY created_at DESC LIMIT 1
          `));
          const row = rows.rows[0] as any;
          return { createdAt: row?.created_at?.toISOString?.() ?? row?.created_at ?? null, details: row?.details ?? null };
        } catch { return { createdAt: null, details: null }; }
      }

      const nullAudit = { createdAt: null, details: null };
      const [lastGhlSync, lastTestEmail, lastWebhookEvent, lastSunbizRun, lastClassification, lastBackupSuccess, lastBackupFailed] = await Promise.all([
        withTimeout(lastAuditEntry(["ghl_sync_completed", "GHL_SYNC_TICK_COMPLETE", "ghl_sync_contacts"]), 8_000, nullAudit),
        withTimeout(lastAuditEntry(["integration_readiness_test_email"]), 8_000, nullAudit),
        withTimeout(lastAuditEntry(["webhook_received", "ghl_webhook_received", "inbound_message_processed"]), 8_000, nullAudit),
        withTimeout(lastAuditEntry(["sunbiz_enrichment_completed", "sunbiz_batch_enriched", "sunbiz_enrichment_run"]), 8_000, nullAudit),
        withTimeout(lastAuditEntry(["inbox_classified", "intent_classified", "reply_classified"]), 8_000, nullAudit),
        withTimeout(lastAuditEntry(["db_backup_success"]), 8_000, nullAudit),
        withTimeout(lastAuditEntry(["db_backup_failed"]), 8_000, nullAudit),
      ]);

      // ── Active cohort size ────────────────────────────────────────────────────
      let activeCohortSize = 0;
      try {
        const cohortResult = await withTimeout(
          db.execute(auditSql.raw(`
            SELECT COUNT(*) as c FROM contacts
            WHERE lifecycle_stage IN ('prospect','warm_lead','qualified')
            AND email_status NOT IN ('bounced','invalid','unsubscribed')
            AND do_not_contact = false
            LIMIT 1
          `)),
          8_000,
          null,
        );
        if (cohortResult) {
          activeCohortSize = parseInt(String((cohortResult.rows[0] as any)?.c ?? "0"), 10) || 0;
        }
      } catch {}

      // ── Gmail OAuth status ────────────────────────────────────────────────────
      const gmailConnected = await isGmailOAuthConnected();
      let gmailEmail: string | null = null;
      try {
        const gmailStatus = await getGmailOAuthStatus();
        gmailEmail = gmailStatus?.email ?? null;
      } catch {}

      // ── Outbound settings ─────────────────────────────────────────────────────
      const { outboundSendCounters } = await import("@shared/schema");
      const { eq: eqOp, and: andOp } = await import("drizzle-orm");
      const [
        dailyCapRaw,
        emailChannelPausedRaw, smsChannelPausedRaw, coldEmailChannelPausedRaw,
      ] = await Promise.all([
        storage.getSystemSetting("outboundDailyEmailCap"),
        storage.getSystemSetting("emailChannelPaused"),
        storage.getSystemSetting("smsChannelPaused"),
        storage.getSystemSetting("coldEmailChannelPaused"),
      ]);
      const { getPauseState } = await import("../services/outbound-pause-authority");
      const canonicalPause = await getPauseState();
      const globalPaused = canonicalPause.state !== "unpaused" || canonicalPause.source === "safe_default";
      const globalPausedReason = canonicalPause.reason ?? (
        canonicalPause.source === "safe_default" ? "Canonical pause authority unavailable" : null
      );
      const dailyCap = typeof dailyCapRaw === "number" ? dailyCapRaw : parseInt(String(dailyCapRaw ?? "200"), 10) || 200;
      const emailChannelPaused = emailChannelPausedRaw === true || emailChannelPausedRaw === "true";
      const smsChannelPaused = smsChannelPausedRaw === true || smsChannelPausedRaw === "true";
      const todayStr = new Date().toISOString().slice(0, 10);
      const [capRow] = await db.select({ count: outboundSendCounters.count }).from(outboundSendCounters)
        .where(andOp(eqOp(outboundSendCounters.date, todayStr), eqOp(outboundSendCounters.channel, "email"), eqOp(outboundSendCounters.scope, "cold_outreach")));
      const sendsToday = capRow?.count ?? 0;

      // ── Deliverability settings ───────────────────────────────────────────────
      const [warmupEnabledRaw, warmupStartDateRaw, bounceThresholdRaw, complaintThresholdRaw, unsubThresholdRaw, noProspectEmailRaw, noProspectSmsRaw, testAllowlistRaw] = await Promise.all([
        storage.getSystemSetting("deliveryWarmupEnabled"),
        storage.getSystemSetting("deliveryWarmupStartDate"),
        storage.getSystemSetting("deliveryBounceThresholdPct"),
        storage.getSystemSetting("deliveryComplaintThresholdPct"),
        storage.getSystemSetting("deliveryUnsubscribeThresholdPct"),
        storage.getSystemSetting("deliveryNoProspectSendEmail"),
        storage.getSystemSetting("deliveryNoProspectSendSms"),
        storage.getSystemSetting("deliveryTestEmailAllowlist"),
      ]);
      const warmupEnabled = warmupEnabledRaw === true || warmupEnabledRaw === "true";
      const warmupStartDate = typeof warmupStartDateRaw === "string" ? warmupStartDateRaw : null;
      let warmupDay: number | null = null;
      let warmupCap: number | null = null;
      if (warmupEnabled && warmupStartDate) {
        const daysSince = Math.max(1, Math.floor((Date.now() - new Date(warmupStartDate).getTime()) / 86400000) + 1);
        warmupDay = daysSince;
        if (daysSince >= 30) warmupCap = 250;
        else if (daysSince >= 14) warmupCap = 100;
        else if (daysSince >= 7) warmupCap = 50;
        else warmupCap = 20;
      }
      const bounceThreshold = typeof bounceThresholdRaw === "number" ? bounceThresholdRaw : parseFloat(String(bounceThresholdRaw ?? "5")) || 5;
      const complaintThreshold = typeof complaintThresholdRaw === "number" ? complaintThresholdRaw : parseFloat(String(complaintThresholdRaw ?? "0.1")) || 0.1;
      const unsubThreshold = typeof unsubThresholdRaw === "number" ? unsubThresholdRaw : parseFloat(String(unsubThresholdRaw ?? "5")) || 5;
      const noProspectSendEmail = noProspectEmailRaw === true || noProspectEmailRaw === "true";
      const noProspectSendSms = noProspectSmsRaw === true || noProspectSmsRaw === "true";

      // ── Build legacy gates (keep backward compat) ─────────────────────────────
      const envChecks = {
        APP_URL: { set: !!process.env.APP_URL, value: process.env.APP_URL ? "***set***" : null },
        SLACK_AUDIT_WEBHOOK_URL: { set: !!process.env.SLACK_AUDIT_WEBHOOK_URL },
        SMTP_PASS: { set: smtpOk },
        REDIS_URL: { set: !!process.env.REDIS_URL },
        GHL_LOCATION_ID: { set: !!process.env.GHL_LOCATION_ID },
        GHL_PRIVATE_INTEGRATION_TOKEN: { set: !!process.env.GHL_PRIVATE_INTEGRATION_TOKEN },
        GHL_WEBHOOK_SECRET: { set: !!process.env.GHL_WEBHOOK_SECRET },
        GOOGLE_CLIENT_ID: { set: !!process.env.GOOGLE_CLIENT_ID },
        AI_INTEGRATIONS_OPENAI_API_KEY: { set: !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY },
        A2P_REGISTRATION_ID: { set: !!process.env.A2P_REGISTRATION_ID },
      };

      const gates = [
        { id: "canonical_url", label: "Canonical URL resolved", pass: urlInfo.source !== "static_fallback", detail: `${urlInfo.url} (source: ${urlInfo.source})`, ownerAction: urlInfo.warning },
        { id: "database", label: "PostgreSQL responding", pass: dbOk, detail: dbOk ? `${dbMs}ms` : "Connection failed" },
        { id: "redis", label: "Redis / BullMQ", pass: queueMode === "bullmq_redis", detail: queueMode === "bullmq_redis" ? "Live Redis connected" : `Queue mode: ${queueMode}; configure REDIS_URL` },
        { id: "ghl", label: "GHL integration configured", pass: ghlOk, detail: ghlOk ? "GHL_LOCATION_ID + token present" : "Missing GHL credentials", ownerAction: ghlOk ? undefined : "Set GHL_LOCATION_ID and GHL_PRIVATE_INTEGRATION_TOKEN in Replit Secrets" },
        { id: "ghl_circuit", label: "GHL circuit breaker closed", pass: !ghlCircuit.circuitOpen, detail: ghlCircuit.circuitOpen ? `Circuit open — ${ghlCircuit.consecutiveFailures} consecutive failures` : `Closed (${ghlCircuit.consecutiveFailures}/${ghlCircuit.threshold} failures)` },
        { id: "smtp", label: "SMTP fallback configured", pass: smtpOk, detail: smtpOk ? `host=${smtpStatus.host}` : "SMTP not configured — GHL is primary delivery path", ownerAction: smtpOk ? undefined : "Set SMTP_HOST, SMTP_USER, SMTP_PASS in Replit Secrets (optional but required for transactional email fallback)" },
        { id: "gmail_oauth", label: "Gmail OAuth connected", pass: gmailConnected, detail: gmailConnected ? `Connected: ${gmailEmail ?? "email not retrieved"}` : "OAuth not completed", ownerAction: !gmailConnected ? "Complete Gmail OAuth on Outbound Readiness page" : undefined },
        { id: "queues", label: "All queues registered", pass: queueMetrics.length >= 8, detail: `${queueMetrics.length} queues registered` },
        { id: "dlq_clean", label: "Dead letter queue empty", pass: dlqCount === 0, detail: dlqCount > 0 ? `${dlqCount} failed jobs in DLQ — investigate before launch` : "No failed jobs" },
        { id: "backups", label: "Backup artifact exists", pass: backups.length > 0, detail: backups.length > 0 ? `${backups.length} backup(s) — latest: ${backups[0]?.name}` : "No backups yet — run a manual backup", ownerAction: backups.length === 0 ? "Trigger POST /api/admin/backups/run to create first backup" : undefined },
        { id: "no_critical_alerts", label: "No unacknowledged critical alerts", pass: criticalAlerts.length === 0, detail: criticalAlerts.length > 0 ? `${criticalAlerts.length} critical alert(s) need acknowledgement` : "Clean" },
        { id: "app_url_secret", label: "APP_URL secret set", pass: !!process.env.APP_URL, detail: process.env.APP_URL ? "Set" : "Not set — email links may point to wrong host", ownerAction: !process.env.APP_URL ? "Set APP_URL=https://<your-deployment-domain> in Replit Secrets" : undefined },
        { id: "ai_key", label: "AI / OpenAI key set", pass: !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY, detail: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ? "Set" : "Not set — AI enrichment, intent classification, proposals will fail", ownerAction: !process.env.AI_INTEGRATIONS_OPENAI_API_KEY ? "Set AI_INTEGRATIONS_OPENAI_API_KEY in Replit Secrets" : undefined },
        { id: "sms_a2p", label: "SMS / A2P registration", pass: !!process.env.A2P_REGISTRATION_ID, detail: process.env.A2P_REGISTRATION_ID ? `Attested (${process.env.A2P_REGISTRATION_ID})` : "A2P_REGISTRATION_ID not set — SMS blocked for compliance", ownerAction: !process.env.A2P_REGISTRATION_ID ? "Complete A2P 10DLC registration and attest in Outbound Readiness" : undefined },
        { id: "global_pause", label: "Global outbound pause active (safe start)", pass: globalPaused, detail: globalPaused ? `Paused — ${globalPausedReason || "no reason recorded"}` : "⚠ Outbound is LIVE — all active enrollments will fire" },
      ];

      const p0Gates = gates.filter((g) => !["global_pause", "sms_a2p", "gmail_oauth"].includes(g.id));
      const allPass = p0Gates.every((g) => g.pass);
      const p0Failures = gates.filter((g) => !g.pass);

      // ── Subsystem cards (structured, for new UI) ──────────────────────────────
      const subsystems = [
        {
          id: "website_forms", label: "Website / Public Forms", icon: "Globe",
          status: urlInfo.source !== "static_fallback" ? "pass" : "warn",
          metrics: [
            { key: "Canonical URL", value: urlInfo.url },
            { key: "Source", value: urlInfo.source },
          ],
          detail: urlInfo.warning ?? "Public URL resolved",
        },
        {
          id: "crm_db", label: "CRM Database", icon: "Database",
          status: dbOk ? "pass" : "fail",
          metrics: [
            { key: "PostgreSQL", value: dbOk ? `${dbMs}ms` : "unreachable" },
            { key: "Active cohort", value: activeCohortSize },
          ],
          detail: dbOk ? `Responding in ${dbMs}ms · ${activeCohortSize} contactable prospects` : "Database connection failed",
        },
        {
          id: "redis_bullmq", label: "Redis / BullMQ Queues", icon: "Cpu",
          status: queueMode !== "bullmq_redis" ? "fail" : dlqCount > 0 ? "warn" : "pass",
          metrics: [
            { key: "Queues", value: queueMetrics.length },
            { key: "DLQ failures", value: dlqCount },
            { key: "Last failure", value: lastQueueFailure?.lastFailedAt ?? "None" },
          ],
          detail: queueMode !== "bullmq_redis" ? `Queue mode: ${queueMode}; configure REDIS_URL` : dlqCount > 0 ? `${dlqCount} failed jobs need attention` : "Live Redis · all queues healthy",
        },
        {
          id: "ghl_sync", label: "GHL Sync", icon: "RefreshCw",
          status: ghlCircuit.circuitOpen ? "fail" : ghlOk ? "pass" : "warn",
          metrics: [
            { key: "Circuit", value: ghlCircuit.circuitOpen ? "OPEN" : "closed" },
            { key: "Consecutive failures", value: ghlCircuit.consecutiveFailures },
            { key: "Last sync", value: lastGhlSync.createdAt ?? "Never" },
          ],
          detail: ghlCircuit.circuitOpen ? `Circuit open — ${ghlCircuit.consecutiveFailures} consecutive API failures` : lastGhlSync.createdAt ? `Last synced ${new Date(lastGhlSync.createdAt).toLocaleString()}` : "No sync recorded yet",
        },
        {
          id: "ghl_email", label: "GHL Email Transport", icon: "Mail",
          status: ghlOk ? "pass" : "fail",
          metrics: [
            { key: "GHL configured", value: ghlOk ? "Yes" : "No" },
            { key: "SMTP fallback", value: smtpOk ? `${smtpStatus.host}` : "Not configured" },
          ],
          detail: ghlOk ? `GHL primary · SMTP fallback ${smtpOk ? "ready" : "not configured"}` : "GHL not configured — email delivery blocked",
        },
        {
          id: "gmail_oauth", label: "Gmail OAuth / Inbox", icon: "Inbox",
          status: gmailConnected ? "pass" : process.env.GOOGLE_CLIENT_ID ? "warn" : "fail",
          metrics: [
            { key: "Client ID", value: process.env.GOOGLE_CLIENT_ID ? "Set" : "Missing" },
            { key: "OAuth status", value: gmailConnected ? `Connected: ${gmailEmail}` : "Not connected" },
          ],
          detail: gmailConnected ? `OAuth connected as ${gmailEmail}` : "Gmail OAuth not completed — department email send will fail",
          ownerAction: !gmailConnected ? "Complete Gmail OAuth in Outbound Readiness → Gmail OAuth" : undefined,
        },
        {
          id: "sms_a2p", label: "SMS / A2P / GHL Phone", icon: "Phone",
          status: process.env.A2P_REGISTRATION_ID ? "pass" : "fail",
          metrics: [
            { key: "A2P Registration", value: process.env.A2P_REGISTRATION_ID ? "Attested" : "Missing" },
            { key: "GHL Calendar", value: process.env.GHL_CALENDAR_ID ? "Set" : "Not set" },
          ],
          detail: process.env.A2P_REGISTRATION_ID ? "A2P 10DLC attested — SMS capable" : "A2P_REGISTRATION_ID not set — SMS blocked for compliance",
          ownerAction: !process.env.A2P_REGISTRATION_ID ? "Complete A2P 10DLC registration and set A2P_REGISTRATION_ID" : undefined,
        },
        {
          id: "sunbiz", label: "Sunbiz Lookup", icon: "Search",
          status: lastSunbizRun.createdAt ? "pass" : "warn",
          metrics: [
            { key: "Last enrichment", value: lastSunbizRun.createdAt ?? "Never" },
          ],
          detail: lastSunbizRun.createdAt ? `Last run: ${new Date(lastSunbizRun.createdAt).toLocaleString()}` : "No enrichment runs recorded — run a Sunbiz batch to populate",
        },
        {
          id: "ai_inbox", label: "AI Inbox / Classification", icon: "Brain",
          status: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ? (lastClassification.createdAt ? "pass" : "warn") : "fail",
          metrics: [
            { key: "API key", value: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ? "Set" : "Missing" },
            { key: "Last classification", value: lastClassification.createdAt ?? "None recorded" },
          ],
          detail: !process.env.AI_INTEGRATIONS_OPENAI_API_KEY ? "OpenAI key missing — intent classification and AI enrichment will fail" : lastClassification.createdAt ? `Last classified: ${new Date(lastClassification.createdAt).toLocaleString()}` : "No classification events yet",
          ownerAction: !process.env.AI_INTEGRATIONS_OPENAI_API_KEY ? "Set AI_INTEGRATIONS_OPENAI_API_KEY in Replit Secrets" : undefined,
        },
        {
          id: "webhooks", label: "Webhooks", icon: "Webhook",
          status: process.env.GHL_WEBHOOK_SECRET ? (lastWebhookEvent.createdAt ? "pass" : "warn") : "fail",
          metrics: [
            { key: "Webhook secret", value: process.env.GHL_WEBHOOK_SECRET ? "Set" : "Missing" },
            { key: "Last event", value: lastWebhookEvent.createdAt ?? "None recorded" },
          ],
          detail: !process.env.GHL_WEBHOOK_SECRET ? "GHL_WEBHOOK_SECRET not set — webhook validation will fail" : lastWebhookEvent.createdAt ? `Last event: ${new Date(lastWebhookEvent.createdAt).toLocaleString()}` : "No webhook events recorded yet",
        },
        {
          id: "outbound_pause", label: "Outbound Global Pause", icon: "Shield",
          status: globalPaused ? "pass" : "warn",
          metrics: [
            { key: "State", value: globalPaused ? "PAUSED (safe)" : "LIVE — outbound firing" },
            { key: "Reason", value: globalPausedReason ?? "—" },
            { key: "Email channel", value: emailChannelPaused ? "paused" : "live" },
            { key: "SMS channel", value: smsChannelPaused ? "paused" : "live" },
          ],
          detail: globalPaused ? `Paused — safe for testing. ${globalPausedReason ?? ""}` : "⚠ Global pause is OFF — all active enrollments will send",
        },
        {
          id: "send_caps", label: "Daily Send Caps", icon: "Gauge",
          status: sendsToday >= dailyCap ? "fail" : sendsToday > dailyCap * 0.8 ? "warn" : "pass",
          metrics: [
            { key: "Daily cap", value: warmupCap != null ? `${warmupCap} (warmup override)` : String(dailyCap) },
            { key: "Sends today", value: sendsToday },
            { key: "Remaining", value: Math.max(0, (warmupCap ?? dailyCap) - sendsToday) },
            { key: "Warmup mode", value: warmupEnabled ? `Day ${warmupDay}` : "Off" },
          ],
          detail: warmupEnabled ? `Warmup mode — day ${warmupDay}, cap=${warmupCap}/day (configured: ${dailyCap})` : `${sendsToday}/${dailyCap} sends today`,
        },
        {
          id: "deliverability", label: "Deliverability Controls", icon: "Activity",
          status: noProspectSendEmail ? "pass" : "warn",
          metrics: [
            { key: "Bounce threshold", value: `${bounceThreshold}%` },
            { key: "Complaint threshold", value: `${complaintThreshold}%` },
            { key: "Unsubscribe threshold", value: `${unsubThreshold}%` },
            { key: "No-prospect guard (email)", value: noProspectSendEmail ? "Active" : "⚠ Off" },
            { key: "No-prospect guard (SMS)", value: noProspectSendSms ? "Active" : "Off" },
          ],
          detail: noProspectSendEmail ? "No-prospect guard active — only allowlisted recipients can receive sends" : "⚠ No-prospect-send guard is off — real prospects can receive sends",
        },
        {
          id: "last_test_email", label: "Last Internal Test Email", icon: "TestTube",
          status: lastTestEmail.createdAt ? "pass" : "warn",
          metrics: [
            { key: "Sent at", value: lastTestEmail.createdAt ?? "Never" },
            { key: "To", value: (lastTestEmail.details as any)?.to ?? "—" },
          ],
          detail: lastTestEmail.createdAt ? `Last test: ${new Date(lastTestEmail.createdAt).toLocaleString()} → ${(lastTestEmail.details as any)?.to ?? "unknown"}` : "No test emails sent yet",
        },
        {
          id: "last_webhook_event", label: "Last Webhook Event", icon: "Radio",
          status: lastWebhookEvent.createdAt ? "pass" : "warn",
          metrics: [
            { key: "Event at", value: lastWebhookEvent.createdAt ?? "Never" },
          ],
          detail: lastWebhookEvent.createdAt ? `Last webhook: ${new Date(lastWebhookEvent.createdAt).toLocaleString()}` : "No webhook events yet",
        },
        {
          id: "last_queue_failure", label: "Last Queue Failure", icon: "AlertTriangle",
          status: lastQueueFailure ? "warn" : "pass",
          metrics: [
            { key: "Failed at", value: lastQueueFailure?.lastFailedAt ?? "None" },
            { key: "Queue", value: lastQueueFailure?.name ?? "—" },
            { key: "Error", value: lastQueueFailure?.lastError ?? "—" },
          ],
          detail: lastQueueFailure ? `Last failure: ${lastQueueFailure.name} @ ${lastQueueFailure.lastFailedAt}` : "No queue failures",
        },
        {
          id: "db_backup", label: "DB Backup", icon: "HardDrive",
          status: (() => {
            if (!lastBackupSuccess.createdAt) return "warn";
            // Warn if last successful backup is more than 26 hours ago (missed nightly window)
            const ageMs = Date.now() - new Date(lastBackupSuccess.createdAt).getTime();
            if (ageMs > 26 * 60 * 60 * 1000) return "warn";
            // Fail if the last event was a failure
            if (lastBackupFailed.createdAt && (!lastBackupSuccess.createdAt || new Date(lastBackupFailed.createdAt) > new Date(lastBackupSuccess.createdAt))) return "fail";
            return "pass";
          })(),
          metrics: [
            { key: "Last success", value: lastBackupSuccess.createdAt ? new Date(lastBackupSuccess.createdAt).toLocaleString() : "Never" },
            { key: "Last failure", value: lastBackupFailed.createdAt ? new Date(lastBackupFailed.createdAt).toLocaleString() : "None recorded" },
            { key: "Files on disk", value: backups.length },
            { key: "Latest file", value: backups[0]?.name ?? "—" },
            { key: "Latest size", value: backups[0] ? `${(backups[0].sizeBytes / 1024 / 1024).toFixed(1)} MB` : "—" },
          ],
          detail: (() => {
            if (!lastBackupSuccess.createdAt) return "No successful backup on record — trigger a manual backup from Launch Readiness";
            const ageMs = Date.now() - new Date(lastBackupSuccess.createdAt).getTime();
            const ageHours = Math.round(ageMs / 3600000);
            if (lastBackupFailed.createdAt && new Date(lastBackupFailed.createdAt) > new Date(lastBackupSuccess.createdAt)) {
              return `Last backup FAILED at ${new Date(lastBackupFailed.createdAt).toLocaleString()} — last success was ${ageHours}h ago`;
            }
            return `Last backup: ${new Date(lastBackupSuccess.createdAt).toLocaleString()} (${ageHours}h ago) · ${backups.length} file(s) on disk`;
          })(),
          ownerAction: !lastBackupSuccess.createdAt ? "Trigger POST /api/admin/backups/run to create first backup" : undefined,
        },
      ];

      // ── Operator verdict banner ────────────────────────────────────────────────
      const blockers: string[] = [];
      if (!dbOk) blockers.push("CRM database unreachable");
      if (!ghlOk) blockers.push("GHL integration not configured");
      if (ghlCircuit.circuitOpen) blockers.push(`GHL circuit breaker open (${ghlCircuit.consecutiveFailures} consecutive failures)`);
      if (queueMode !== "bullmq_redis") blockers.push(`BullMQ Redis queue unavailable (mode: ${queueMode})`);
      if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) blockers.push("AI/OpenAI API key missing");
      if (dlqCount > 5) blockers.push(`${dlqCount} dead-letter queue failures need attention`);
      if (criticalAlerts.length > 0) blockers.push(`${criticalAlerts.length} unacknowledged critical alerts`);

      const verdictBanner = [
        {
          label: "Website / CRM ready",
          status: dbOk && urlInfo.source !== "static_fallback" ? "pass" : "fail",
          detail: !dbOk ? "Database unreachable" : urlInfo.source === "static_fallback" ? "Canonical URL fallback" : "OK",
        },
        {
          label: "Controlled email test ready (internal only)",
          status: ghlOk && smtpOk && noProspectSendEmail ? "pass" : "warn",
          detail: !noProspectSendEmail ? "No-prospect guard is off — enable in Deliverability Settings" : !smtpOk ? "SMTP not configured" : "Ready for internal test sends",
        },
        {
          label: "Real outbound ready",
          status: globalPaused ? "blocked" : blockers.length === 0 ? "pass" : "fail",
          detail: globalPaused ? "Blocked — global pause is ON (safe start)" : blockers.length > 0 ? blockers.join("; ") : "All gates passing",
          blockers: globalPaused ? ["Global outbound pause is active — toggle off in Outbound Readiness when ready"] : blockers,
        },
        {
          label: "SMS ready",
          status: process.env.A2P_REGISTRATION_ID && !smsChannelPaused ? "pass" : "blocked",
          detail: !process.env.A2P_REGISTRATION_ID ? "A2P 10DLC registration required" : smsChannelPaused ? "SMS channel paused" : "Ready",
          blockers: !process.env.A2P_REGISTRATION_ID ? ["Complete A2P 10DLC registration and set A2P_REGISTRATION_ID"] : [],
        },
      ];

      res.json({
        // Legacy (backward compat)
        verdict: allPass ? "GO" : "NO-GO",
        timestamp: new Date().toISOString(),
        canonicalUrl: urlInfo,
        gates,
        p0Failures,
        queues: queueMetrics,
        queueStatus,
        backups: backups.slice(0, 5),
        recentAlerts: alertFeed.alerts,
        alertFeedDegraded: alertFeed.degraded,
        envChecks,
        ownerActions: gates.filter((g) => g.ownerAction).map((g) => ({ gate: g.label, action: (g as any).ownerAction })),
        // Extended
        subsystems,
        blockers,
        verdictBanner,
        outboundState: {
          globalPaused,
          globalPausedReason,
          emailChannelPaused,
          smsChannelPaused,
          dailyCap,
          sendsToday,
          remaining: Math.max(0, dailyCap - sendsToday),
        },
        deliverability: {
          warmupEnabled,
          warmupStartDate,
          warmupDay,
          warmupCap,
          bounceThreshold,
          complaintThreshold,
          unsubThreshold,
          noProspectSendEmail,
          noProspectSendSms,
          testAllowlist: typeof testAllowlistRaw === "string" ? testAllowlistRaw.split(",").map((e: string) => e.trim()).filter(Boolean) : [],
        },
        activeCohortSize,
        lastTestEmail,
        lastWebhookEvent,
        lastQueueFailure: lastQueueFailure ? {
          timestamp: lastQueueFailure.lastFailedAt,
          jobType: lastQueueFailure.name,
          error: lastQueueFailure.lastError,
        } : null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Wave A2 — Outbound Preflight Checklist ──────────────────────────────────
  // Standalone endpoint that returns a structured pass/fail for each launch gate.
  // Called from the outbound wizard UI and from the pre-deploy gate.
  app.get("/api/admin/outbound-preflight", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isGhlConfigured } = await import("../services/ghl");
      const { isSmtpConfigured } = await import("../services/smtp-email");
      const { pool: pgPool } = await import("../db");

      interface PreflightCheck {
        id: string;
        label: string;
        status: "pass" | "fail" | "warn" | "blocked";
        detail: string;
      }

      const checks: PreflightCheck[] = [];

      // 1. GHL token valid
      const ghlOk = isGhlConfigured();
      checks.push({
        id: "ghl_token",
        label: "GHL API token configured",
        status: ghlOk ? "pass" : "fail",
        detail: ghlOk ? "GHL_PRIVATE_INTEGRATION_TOKEN present" : "GHL_PRIVATE_INTEGRATION_TOKEN missing or invalid",
      });

      // 2. At least one sequence with status='active'
      const seqResult = await pgPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM follow_up_sequences WHERE status = 'active'`
      );
      const activeSequences = parseInt(seqResult.rows[0]?.count ?? "0", 10);
      checks.push({
        id: "active_sequences",
        label: "At least one active sequence",
        status: activeSequences > 0 ? "pass" : "fail",
        detail: activeSequences > 0
          ? `${activeSequences} active sequence(s) ready`
          : "No sequences set to 'active' — activate at least one before launch",
      });

      // 3. Bounce handler registered (webhook route exists — check system setting)
      const bounceHandlerActive = ghlOk; // webhook is always registered if GHL is configured
      checks.push({
        id: "bounce_handler",
        label: "Email bounce handler registered",
        status: bounceHandlerActive ? "pass" : "warn",
        detail: bounceHandlerActive
          ? "/api/webhooks/ghl/email-bounce route registered and GHL configured"
          : "GHL not configured — bounce handler cannot receive events",
      });

      // 4. Reply-stop handler active
      checks.push({
        id: "reply_stop",
        label: "Reply-STOP enrollment pause active",
        status: ghlOk ? "pass" : "warn",
        detail: ghlOk
          ? "/api/webhooks/ghl/reply-stop route registered — inbound STOP pauses enrollments"
          : "GHL not configured — reply-stop handler cannot receive events",
      });

      // 5. Global outbound pause = false (this is a pre-launch check — it SHOULD be true before launch)
      const { getPauseState } = await import("../services/outbound-pause-authority");
      const canonicalPause = await getPauseState();
      const globalPaused = canonicalPause.state !== "unpaused" || canonicalPause.source === "safe_default";
      checks.push({
        id: "global_pause",
        label: "Global outbound pause state",
        status: globalPaused ? "blocked" : "pass",
        detail: globalPaused
          ? "Outbound is currently PAUSED (safe state) — toggle off when ready to launch"
          : "Outbound is LIVE — ensure this is intentional",
      });

      // 6. At least 1 sending identity configured (SMTP or GHL)
      const smtpOk = isSmtpConfigured();
      const inboxCount = smtpOk || ghlOk;
      checks.push({
        id: "sending_identity",
        label: "Sending identity configured (SMTP or GHL)",
        status: inboxCount ? "pass" : "fail",
        detail: smtpOk && ghlOk
          ? "SMTP + GHL both configured (dual delivery path)"
          : smtpOk
            ? "SMTP configured (direct delivery)"
            : ghlOk
              ? "GHL configured (GHL delivery only — no List-Unsubscribe header on GHL sends)"
              : "Neither SMTP nor GHL configured — cannot send any outbound emails",
      });

      // 7. Daily cap set
      const dailyCapRaw = await storage.getSystemSetting("outboundDailyEmailCap");
      const dailyCap = typeof dailyCapRaw === "number" ? dailyCapRaw : parseInt(String(dailyCapRaw ?? "0"), 10) || 0;
      checks.push({
        id: "daily_cap",
        label: "Daily email cap configured",
        status: dailyCap > 0 ? "pass" : "warn",
        detail: dailyCap > 0
          ? `Daily cap = ${dailyCap} emails`
          : "No daily cap set — recommend setting outboundDailyEmailCap to prevent accidental bulk sends",
      });

      const allPass = checks.every(c => c.status === "pass" || c.status === "warn");
      const hasBlockers = checks.some(c => c.status === "fail" || c.status === "blocked");

      res.json({
        verdict: hasBlockers ? "BLOCKED" : allPass ? "GO" : "NO-GO",
        timestamp: new Date().toISOString(),
        checks,
        summary: {
          total: checks.length,
          pass: checks.filter(c => c.status === "pass").length,
          warn: checks.filter(c => c.status === "warn").length,
          fail: checks.filter(c => c.status === "fail").length,
          blocked: checks.filter(c => c.status === "blocked").length,
        },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Legacy "launch" is intentionally fenced. It cannot unpause, enroll, or
  // dispatch. Existing clients receive a truthful migration response.
  app.post("/api/admin/outbound/cohort-launch", requireRole("admin"), async (_req, res) => {
    return res.status(409).json({
      launched: false,
      prepared: false,
      globalPauseChanged: false,
      code: "CR06_GOVERNED_COMMAND_REQUIRED",
      message: "Use CR-06 preflight, campaign gate, and prepare/hold commands. Preparation ends READY_HELD — SENDING OFF.",
      governedEndpoints: {
        preflight: "/api/admin/cr06/preflight",
        gate: "/api/admin/cr06/gates",
        prepare: "/api/admin/cr06/prepare",
      },
    });
  });

  // ── Cohort Send Metrics (#1396) ─────────────────────────────────────────────
  // Returns sends/hour, bounce rate, reply rate, and opt-out rate from the
  // canonical communication_events table for the monitoring panel.
  app.get("/api/admin/outbound/cohort-metrics", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { pool: pgPool } = await import("../db");
      const r = await pgPool.query(`
        WITH
        s24 AS (
          SELECT COUNT(*) AS cnt FROM communication_events
          WHERE direction = 'outbound' AND created_at > NOW() - INTERVAL '24 hours'
        ),
        s7 AS (
          SELECT COUNT(*) AS cnt FROM communication_events
          WHERE direction = 'outbound' AND created_at > NOW() - INTERVAL '7 days'
        ),
        b7 AS (
          SELECT COUNT(*) AS cnt FROM communication_events
          WHERE direction = 'outbound' AND status = 'bounced'
            AND created_at > NOW() - INTERVAL '7 days'
        ),
        r7 AS (
          SELECT COUNT(*) AS cnt FROM communication_events
          WHERE direction = 'inbound' AND created_at > NOW() - INTERVAL '7 days'
        ),
        o7 AS (
          SELECT COUNT(*) AS cnt FROM communication_events
          WHERE direction = 'inbound'
            AND (status = 'unsubscribed'
              OR (metadata->>'eventType') IN ('opt_out', 'STOP', 'unsubscribe'))
            AND created_at > NOW() - INTERVAL '7 days'
        )
        SELECT
          s24.cnt::int  AS sends_24h,
          s7.cnt::int   AS sends_7d,
          b7.cnt::int   AS bounces_7d,
          r7.cnt::int   AS replies_7d,
          o7.cnt::int   AS optouts_7d
        FROM s24, s7, b7, r7, o7
      `);
      const row = r.rows[0] ?? { sends_24h: 0, sends_7d: 0, bounces_7d: 0, replies_7d: 0, optouts_7d: 0 };
      const s24 = row.sends_24h ?? 0;
      const s7  = row.sends_7d  ?? 0;
      res.json({
        sendsPerHour:   Math.round((s24 / 24) * 10) / 10,
        sends24h:       s24,
        sends7d:        s7,
        bounceRate7d:   s7 > 0 ? Math.round((row.bounces_7d / s7) * 1000) / 10 : 0,
        replyRate7d:    s7 > 0 ? Math.round((row.replies_7d / s7) * 1000) / 10 : 0,
        optOutRate7d:   s7 > 0 ? Math.round((row.optouts_7d / s7) * 1000) / 10 : 0,
        bounces7d:      row.bounces_7d  ?? 0,
        replies7d:      row.replies_7d  ?? 0,
        optouts7d:      row.optouts_7d  ?? 0,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Pending Underwriting Conditions (#1403) ─────────────────────────────────
  // Admin view of all open underwriting conditions across all deals.
  app.get("/api/admin/underwriting/pending-conditions", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { pool: pgPool } = await import("../db");
      const overdueOnly = req.query.overdue === "true";
      const r = await pgPool.query(`
        SELECT
          uc.id,
          uc.deal_id,
          uc.condition_type,
          uc.description,
          uc.status,
          uc.due_date,
          uc.submitted_at,
          uc.approved_at,
          uc.waived_at,
          uc.created_at,
          d.stage        AS deal_stage,
          d.pipeline     AS deal_pipeline,
          c.id           AS contact_id,
          c.first_name,
          c.last_name,
          c.company_name,
          c.email
        FROM underwriting_conditions uc
        JOIN deals d ON d.id = uc.deal_id
        LEFT JOIN contacts c ON c.id = d.contact_id
        WHERE uc.status = 'pending'
          AND uc.approved_at IS NULL
          AND uc.waived_at IS NULL
          ${overdueOnly ? "AND uc.due_date IS NOT NULL AND uc.due_date < NOW()" : ""}
        ORDER BY uc.due_date ASC NULLS LAST
        LIMIT 500
      `);
      res.json({ conditions: r.rows, total: r.rows.length });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Full 25-subsystem Launch Readiness Audit ────────────────────────────────
  app.get("/api/admin/launch-readiness-full", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { runAllLaunchReadinessChecks } = await import("../services/launch-readiness-full");
      const report = await runAllLaunchReadinessChecks();
      res.json(report);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/launch-readiness-full/run", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { runAllLaunchReadinessChecks } = await import("../services/launch-readiness-full");
      const report = await runAllLaunchReadinessChecks();
      res.json(report);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Deliverability Settings (GET/PATCH) ───────────────────────────────────────
  app.get("/api/admin/deliverability-settings", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const [warmupEnabled, warmupStartDate, bounceThreshold, complaintThreshold, unsubThreshold, noProspectEmail, noProspectSms, testAllowlist] = await Promise.all([
        storage.getSystemSetting("deliveryWarmupEnabled"),
        storage.getSystemSetting("deliveryWarmupStartDate"),
        storage.getSystemSetting("deliveryBounceThresholdPct"),
        storage.getSystemSetting("deliveryComplaintThresholdPct"),
        storage.getSystemSetting("deliveryUnsubscribeThresholdPct"),
        storage.getSystemSetting("deliveryNoProspectSendEmail"),
        storage.getSystemSetting("deliveryNoProspectSendSms"),
        storage.getSystemSetting("deliveryTestEmailAllowlist"),
      ]);
      res.json({
        warmupEnabled: warmupEnabled === true || warmupEnabled === "true",
        warmupStartDate: typeof warmupStartDate === "string" ? warmupStartDate : null,
        bounceThresholdPct: typeof bounceThreshold === "number" ? bounceThreshold : parseFloat(String(bounceThreshold ?? "5")) || 5,
        complaintThresholdPct: typeof complaintThreshold === "number" ? complaintThreshold : parseFloat(String(complaintThreshold ?? "0.1")) || 0.1,
        unsubscribeThresholdPct: typeof unsubThreshold === "number" ? unsubThreshold : parseFloat(String(unsubThreshold ?? "5")) || 5,
        noProspectSendEmail: noProspectEmail === true || noProspectEmail === "true",
        noProspectSendSms: noProspectSms === true || noProspectSms === "true",
        testEmailAllowlist: typeof testAllowlist === "string" ? testAllowlist.split(",").map((e: string) => e.trim()).filter(Boolean) : [],
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.patch("/api/admin/deliverability-settings", requireRole("admin"), async (req, res) => {
    try {
      const {
        warmupEnabled, warmupStartDate, bounceThresholdPct, complaintThresholdPct, unsubscribeThresholdPct,
        noProspectSendEmail, noProspectSendSms, testEmailAllowlist,
      } = req.body ?? {};
      const saves: Promise<void>[] = [];
      if (typeof warmupEnabled === "boolean") saves.push(storage.setSystemSetting("deliveryWarmupEnabled", warmupEnabled));
      if (typeof warmupStartDate === "string" || warmupStartDate === null) saves.push(storage.setSystemSetting("deliveryWarmupStartDate", warmupStartDate ?? null));
      if (typeof bounceThresholdPct === "number") saves.push(storage.setSystemSetting("deliveryBounceThresholdPct", bounceThresholdPct));
      if (typeof complaintThresholdPct === "number") saves.push(storage.setSystemSetting("deliveryComplaintThresholdPct", complaintThresholdPct));
      if (typeof unsubscribeThresholdPct === "number") saves.push(storage.setSystemSetting("deliveryUnsubscribeThresholdPct", unsubscribeThresholdPct));
      if (typeof noProspectSendEmail === "boolean") saves.push(storage.setSystemSetting("deliveryNoProspectSendEmail", noProspectSendEmail));
      if (typeof noProspectSendSms === "boolean") saves.push(storage.setSystemSetting("deliveryNoProspectSendSms", noProspectSendSms));
      if (Array.isArray(testEmailAllowlist)) saves.push(storage.setSystemSetting("deliveryTestEmailAllowlist", testEmailAllowlist.join(",")));
      await Promise.all(saves);
      await storage.createAuditLog({
        action: "deliverability_settings_updated",
        entityType: "system",
        entityId: 0,
        actorType: "user",
        actorId: (req.user as any)?.id ?? null,
        details: { actorEmail: (req.user as any)?.email, changes: req.body },
      });
      res.json({ ok: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Integration Readiness — per-secret safe probe endpoints ─────────────────

  // Per-user in-memory rate limit for retest: max 10 per minute
  const retestCounts = new Map<string, { count: number; resetAt: number }>();
  function checkRetestRateLimit(userId: string): boolean {
    const now = Date.now();
    const entry = retestCounts.get(userId);
    if (!entry || now > entry.resetAt) {
      retestCounts.set(userId, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= 10) return false;
    entry.count++;
    return true;
  }

  app.get("/api/admin/integration-readiness", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { runFullValidation } = await import("../services/integration-validator");
      const report = await runFullValidation(false);
      res.json(report);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/integration-readiness/retest", requireRole("admin", "manager"), async (req, res) => {
    try {
      const userId = String((req.user as any)?.id || "unknown");
      if (!checkRetestRateLimit(userId)) {
        return res.status(429).json({ message: "Rate limit: max 10 retests per minute" });
      }
      const category = req.body?.category as string | undefined;
      await storage.createAuditLog({
        action: "integration_readiness_retest",
        entityType: "system",
        actorId: (req.user as any)?.id,
        actorType: "admin",
        details: { category: category || "all" },
      });
      const { runFullValidation } = await import("../services/integration-validator");
      const report = await runFullValidation(true);
      // If category filter requested, still return full report (filtering is UI-side)
      res.json(report);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/integration-readiness/test-email", requireRole("admin"), async (req, res) => {
    try {
      const { to, channel } = req.body as { to?: string; channel?: "smtp" | "ghl" };
      const actor = req.user as any;

      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({ success: false, error: "Invalid or missing 'to' address" });
      }
      // Only allow test sends to @libertybancard.com or explicitly configured SMTP_TEST_RECIPIENT
      const allowedDomains = ["libertybancard.com"];
      const toTestRecipient = process.env.SMTP_TEST_RECIPIENT;
      const toDomain = to.split("@")[1]?.toLowerCase();
      const allowed = allowedDomains.includes(toDomain) || (toTestRecipient && to === toTestRecipient);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: `Test emails can only be sent to @libertybancard.com addresses or the configured SMTP_TEST_RECIPIENT. Received domain: ${toDomain}`,
        });
      }

      await storage.createAuditLog({
        action: "integration_readiness_test_email",
        entityType: "system",
        actorId: actor?.id,
        actorType: "admin",
        details: { to, channel: channel || "smtp", triggeredBy: actor?.email },
      });

      if (channel === "ghl") {
        return res.json({ success: false, error: "GHL test send not implemented — use GHL's built-in test workflow feature" });
      }

      const { sendSmtpEmail, isSmtpConfigured } = await import("../services/smtp-email");
      if (!isSmtpConfigured()) {
        return res.json({ success: false, error: "SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS" });
      }
      const result = await sendSmtpEmail({
        to,
        subject: `Liberty Bancard — Integration Readiness SMTP Test (${new Date().toLocaleString()})`,
        html: `<p>This is a controlled SMTP integration test sent by <strong>${actor?.email || "admin"}</strong> from the Liberty Bancard Integration Readiness panel.</p><p>Sent at: ${new Date().toISOString()}</p><p>If you received this, SMTP is working correctly.</p>`,
        category: "internal_ops",
      });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GHL field bootstrap (POST — creates missing lb_* fields in GHL)
  app.post("/api/admin/ghl/bootstrap-fields", requireRole("admin"), async (req, res) => {
    try {
      const actor = req.user as any;
      await storage.createAuditLog({
        action: "ghl_field_bootstrap",
        entityType: "system",
        actorId: actor?.id,
        actorType: "admin",
        details: { triggeredBy: actor?.email },
      });
      const { bootstrapGhlCustomFieldsAndTags } = await import("../services/sdr/ghl-client");
      const result = await bootstrapGhlCustomFieldsAndTags();
      // Clear the integration readiness cache so next poll shows updated field status
      const { clearValidationCache } = await import("../services/integration-validator");
      clearValidationCache();
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GHL Identity Conflict Queue ─────────────────────────────────────────────
  // Lists contacts whose GHL identity conflicts with another local contact.
  // Staff can review and choose to keep the internal link or the GHL link.

  app.get("/api/admin/ghl/identity-conflicts", requireRole("admin", "manager"), async (req, res) => {
    try {
      const resolution = req.query.resolution as string | undefined;
      const conflicts = await storage.getSyncConflicts(resolution);
      // Enrich each row with contact display names so the UI can show them
      const enriched = await Promise.all(conflicts.map(async (c) => {
        const contact = c.contactId ? await storage.getContact(c.contactId) : undefined;
        const ownerContactId = c.ghlValue ? parseInt(c.ghlValue, 10) : undefined;
        const ownerContact = ownerContactId && !isNaN(ownerContactId)
          ? await storage.getContact(ownerContactId)
          : undefined;
        return {
          ...c,
          contactName: contact ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || contact.email : "Unknown",
          contactEmail: contact?.email ?? "",
          ownerContactName: ownerContact
            ? `${ownerContact.firstName ?? ""} ${ownerContact.lastName ?? ""}`.trim() || ownerContact.email
            : `Contact #${ownerContactId}`,
          ownerContactEmail: ownerContact?.email ?? "",
          ghlId: c.internalValue ?? "",
        };
      }));
      res.json(enriched);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── GHL Shadow Log (Wave B1) — review what GHL would have overwritten ────────

  app.get("/api/admin/ghl/shadow-log", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { ghlShadowLog } = await import("@shared/schema");
      const { desc, isNull, isNotNull } = await import("drizzle-orm");
      const limit = Math.min(parseInt((req.query.limit as string) || "100", 10), 500);
      const unreviewed = req.query.unreviewed === "true";

      const query = db.select().from(ghlShadowLog);
      if (unreviewed) query.where(isNull(ghlShadowLog.reviewedAt));
      const rows = await query.orderBy(desc(ghlShadowLog.createdAt)).limit(limit);

      res.json({
        entries: rows,
        total: rows.length,
        mode: process.env.GHL_CRM_SYNC_MODE || "shadow",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/ghl/shadow-log/:id/review", requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id) as string);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const { ghlShadowLog } = await import("@shared/schema");
      const { eq: eqCheck } = await import("drizzle-orm");
      await db.update(ghlShadowLog).set({
        reviewedAt: new Date(),
        reviewedBy: (req.user as any)?.email || "admin",
      }).where(eqCheck(ghlShadowLog.id, id));
      res.json({ ok: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/ghl/identity-conflicts/:id/resolve", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = parseInt(String(req.params.id) as string, 10);
      const { resolution } = req.body as { resolution: "kept-internal" | "kept-ghl" | "manual" };
      if (!["kept-internal", "kept-ghl", "manual"].includes(resolution)) {
        return res.status(400).json({ message: "resolution must be kept-internal, kept-ghl, or manual" });
      }
      const conflict = await storage.resolveSyncConflict(id, resolution);
      if (!conflict) return res.status(404).json({ message: "Conflict not found" });
      storage.createAuditLog({
        action: "ghl_identity_conflict_resolved",
        entityType: "contact",
        entityId: conflict.contactId ?? undefined,
        details: `GHL identity conflict #${id} resolved as "${resolution}" — GHL ID ${conflict.internalValue}`,
      }).catch(() => {});
      res.json(conflict);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Master Leads — ZeroBounce Email Validation (#1100) ─────────────────────
  // Validates up to 100 master_leads rows whose emailValid is NULL.
  // Admin-only; uses the same verifyEmail() service as the contacts flow.
  app.post("/api/admin/master-leads/validate-emails", requireRole("admin"), async (req, res) => {
    try {
      return res.status(503).json({
        message: "Master-lead email validation is unavailable until records are promoted to canonical contacts with generation-fenced validation intents.",
      });
      const { db } = await import("../db");
      const { masterLeads } = await import("../../shared/schema");
      const { isNull, eq } = await import("drizzle-orm");
      const batch: number = Math.min(Number(req.body?.limit ?? 100), 200);

      const unchecked = await db
        .select({ id: masterLeads.id, email: masterLeads.email })
        .from(masterLeads)
        .where(isNull(masterLeads.emailValid))
        .limit(batch);

      if (!unchecked.length) {
        return res.json({ validated: 0, valid: 0, invalid: 0, message: "All master leads emails already checked" });
      }

      let validated = 0; let valid = 0; let invalid = 0;

      for (const lead of unchecked) {
        if (!lead.email) continue;
        try {
          const result = { status: "unknown" };
          const isValid = result.status === "valid";
          await db.update(masterLeads).set({ emailValid: isValid }).where(eq(masterLeads.id, lead.id));
          validated++; if (isValid) valid++; else invalid++;
        } catch (e: any) {
          console.error(`[MasterLeads ZB] ${lead.email}:`, e.message?.slice(0, 80));
        }
      }

      storage.createAuditLog({
        action: "master_leads_email_validation_batch",
        entityType: "system",
        details: { validated, valid, invalid, batchSize: unchecked.length },
      }).catch(() => {});

      res.json({ validated, valid, invalid, remaining: unchecked.length });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GHL Pipeline Stage Mapping ─────────────────────────────────────────────

  app.get("/api/admin/ghl/pipeline-stages", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { freshGhlPipelinesReadOnly } = await import("../services/ghl-specialized-commands");
      const { pipelineStages } = await import("@shared/schema");
      const [pipelines, localStages] = await Promise.all([
        freshGhlPipelinesReadOnly(),
        db.select({
          id: pipelineStages.id,
          pipeline: pipelineStages.pipeline,
          stageName: pipelineStages.stageName,
        }).from(pipelineStages),
      ]);
      res.json({ pipelines, localStages, matchingPolicy: "explicit_ids_only" });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/admin/ghl/stage-map", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const [legacyMap, semanticMap] = await Promise.all([
        storage.getSystemSetting("ghl_stage_id_map"),
        storage.getSystemSetting("ghl_semantic_stage_id_map"),
      ]);
      res.json({
        version: 2,
        mappings: Array.isArray(semanticMap) ? semanticMap : [],
        legacyStageMap: legacyMap || {},
        legacyDeprecated: true,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/ghl/sync-stages", requireRole("admin"), async (_req, res) => {
    res.status(410).json({
      code: "REMOTE_GHL_STAGE_MUTATION_RETIRED",
      message: "GHL stages are read-only here. Map existing external pipeline and stage IDs instead.",
    });
  });

  const saveGhlSemanticStageMap = async (req: any, res: any) => {
    try {
      const parsed = z.object({
        version: z.literal(2),
        mappings: z.array(z.object({
          localPipelineId: z.string().trim().min(1).max(200),
          localStageId: z.number().int().positive(),
          ghlPipelineId: z.string().trim().min(1).max(200),
          ghlStageId: z.string().trim().min(1).max(200),
        }).strict()).max(500),
      }).strict().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          code: "INVALID_SEMANTIC_STAGE_MAP",
          message: "Expected version 2 with a mappings array containing at most 500 ID-to-ID mappings.",
        });
      }
      const body = parsed.data;
      const { validateGhlSemanticStageMappings } = await import("../services/ghl-specialized-commands");
      await validateGhlSemanticStageMappings(body.mappings);
      await storage.setSystemSetting("ghl_semantic_stage_id_map", body.mappings);
      storage.createAuditLog({
        action: "ghl_semantic_stage_map_updated",
        entityType: "system",
        entityId: 0,
        details: { version: 2, stageMappingCount: body.mappings.length },
      }).catch(() => {});
      res.json({ version: 2, mappings: body.mappings, count: body.mappings.length });
    } catch (err: any) {
      const message = String(err?.message || "");
      if (message.startsWith("LOCAL_STAGE_NOT_FOUND:")) {
        return res.status(400).json({ code: "LOCAL_STAGE_NOT_FOUND", message: "A local pipeline/stage ID pair does not exist." });
      }
      if (message.startsWith("GHL_STAGE_NOT_FOUND:")) {
        return res.status(400).json({ code: "GHL_STAGE_NOT_FOUND", message: "A GHL pipeline/stage ID pair was not present in the fresh provider read." });
      }
      if (message.startsWith("DUPLICATE_LOCAL_STAGE_MAPPING:")) {
        return res.status(400).json({ code: "DUPLICATE_LOCAL_STAGE_MAPPING", message: "A local stage may only appear once in the mapping set." });
      }
      if (message.startsWith("DUPLICATE_GHL_STAGE_MAPPING:")) {
        return res.status(400).json({ code: "DUPLICATE_GHL_STAGE_MAPPING", message: "A GHL stage may only be assigned once in the mapping set." });
      }
      serverError(res, err);
    }
  };

  app.post("/api/admin/ghl/stage-map", requireRole("admin"), saveGhlSemanticStageMap);
  app.patch("/api/admin/ghl/stage-map", requireRole("admin"), saveGhlSemanticStageMap);

  // ── System Health: Incidents + DLQ ─────────────────────────────────────────

  app.get("/api/admin/system-health/incidents", requireRole("admin"), async (_req, res) => {
    try {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // BullMQ dead-letter items
      let dlqItems: any[] = [];
      let queueSummary: any[] = [];
      let dlqStatus: "ok" | "not_initialized" | "degraded" = "not_initialized";
      try {
        const { requireQueueManagerReady } = await import("../services/queue-manager");
        const qm = requireQueueManagerReady();
        const dlqRead = await qm.getDeadLetterItemsWithStatus();
        const rawDlqItems = dlqRead.items;
        dlqItems = rawDlqItems.map((item) => ({
          id: item.id,
          queueName: item.queueName,
          jobName: item.jobName,
          failedReason: "Worker failure recorded; inspect server logs for redacted details.",
          attemptsMade: item.attemptsMade,
          timestamp: item.finishedOn ?? item.timestamp,
        }));
        const metrics = await qm.getAllQueueMetrics();
        queueSummary = (metrics.queues ?? []).map((q: any) => ({
          name: q.name,
          probeStatus: q.probeStatus,
          failed: q.probeStatus === "ok" ? q.failed : null,
          waiting: q.probeStatus === "ok" ? q.waiting : null,
          active: q.probeStatus === "ok" ? q.active : null,
        }));
        dlqStatus = dlqRead.queueStatus.some((source) => source.status !== "sampled") ? "degraded" : "ok";
      } catch (_err) { dlqStatus = "not_initialized"; }

      // GHL sync failures (audit_logs, last 24h)
      const ghlRows = await db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityKey: auditLogs.entityKey,
          details: auditLogs.details,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, "ghl_sync"),
            or(like(auditLogs.action, "%fail%"), like(auditLogs.action, "%error%")),
            gte(auditLogs.createdAt, since24h),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(20);

      res.json({
        dlqItems,
        dlqCount: dlqItems.length,
        dlqStatus,
        dlqResultScope: "sampled_per_queue",
        dlqComplete: false,
        ghlFailures: ghlRows,
        ghlFailureCount: ghlRows.length,
        queueSummary,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Retry a dead-letter job by composite ID (queueName::jobId)
  app.post("/api/admin/system-health/jobs/:compositeId/retry", requireRole("admin"), async (req, res) => {
    try {
      const compositeId = decodeURIComponent(req.params.compositeId as string);
      const { requireQueueManagerReady } = await import("../services/queue-manager");
      const qm = requireQueueManagerReady();
      await qm.retryDeadLetterJob(compositeId);

      auditChange({
        actorType: "user",
        userId: (req.user as any)?.id ?? null,
        action: "manual_job_retry",
        entityType: "queue",
        entityKey: compositeId,
        details: { compositeId, retriedBy: (req.user as any)?.email ?? "admin" },
      }).catch(() => {});

      res.json({ success: true, compositeId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Discard (permanently delete) a single dead-letter job
  app.delete("/api/admin/system-health/jobs/:compositeId", requireRole("admin"), async (req, res) => {
    try {
      const compositeId = decodeURIComponent(req.params.compositeId as string);
      const { requireQueueManagerReady } = await import("../services/queue-manager");
      const qm = requireQueueManagerReady();
      await qm.discardDeadLetterJob(compositeId);

      auditChange({
        actorType: "user",
        userId: (req.user as any)?.id ?? null,
        action: "manual_job_discard",
        entityType: "queue",
        entityKey: compositeId,
        details: { compositeId, discardedBy: (req.user as any)?.email ?? "admin" },
      }).catch(() => {});

      res.json({ success: true, compositeId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Bulk-purge dead-letter jobs (optionally filtered to jobs older than N days)
  // Query param: olderThanDays (number, default 0 = purge all exhausted jobs)
  app.delete("/api/admin/system-health/jobs/dlq/purge", requireRole("admin"), async (req, res) => {
    try {
      const olderThanDays = Math.max(0, parseInt((req.query.olderThanDays as string) ?? "0", 10) || 0);
      const { requireQueueManagerReady } = await import("../services/queue-manager");
      const qm = requireQueueManagerReady();
      const removed = await qm.purgeDeadLetterItems(olderThanDays);

      auditChange({
        actorType: "user",
        userId: (req.user as any)?.id ?? null,
        action: "dlq_bulk_purge",
        entityType: "queue",
        entityKey: "dlq",
        details: { removed, olderThanDays, purgedBy: (req.user as any)?.email ?? "admin" },
      }).catch(() => {});

      res.json({ success: true, removed, olderThanDays });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Live Health Monitor ────────────────────────────────────────────────────
  // GET /api/admin/live-health
  // Returns a structured snapshot of all critical background workers and services.
  // ?refresh=1 forces a fresh check even if a cached result is recent.
  // Cached for up to 10 minutes to avoid hammering services on every poll.
  //
  // Critical checks (gate exit-1 if any fail): db, sequenceWorker, redis, kpiQuery
  // Informational checks (stale is a warning, not a failure): slaWorker, ghlSync, dbBackup, outboundPause

  // ── Pool status diagnostic endpoint (F-10) ──────────────────────────────
  // Returns in-process pool object properties ONLY — no DB call.
  // Safe to call during pool saturation events; never acquires a connection.
  app.get("/api/admin/pool-status", requireRole("admin"), async (_req, res) => {
    const { getBackgroundProfile: _getBgProfile } = await import("../services/background-profile");
    res.json({
      configuredMax: (pool as any).options?.max ?? parseInt(process.env.DB_POOL_MAX ?? "20", 10),
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      backgroundProfile: _getBgProfile(),
      processId: process.pid,
      processIdentity: process.env.PROCESS_IDENTITY ?? null,
      releaseSha: process.env.RELEASE_SHA ?? null,
      observedAt: new Date().toISOString(),
    });
  });

  let _liveHealthCache: { result: any; fetchedAt: number } | null = null;
  const LIVE_HEALTH_CACHE_MS = 10 * 60 * 1000; // 10 minutes

  app.get("/api/admin/live-health", requireRole("admin", "manager"), async (req, res) => {
    try {
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const now = Date.now();

      // Return cached result if fresh (< 10 min) and no refresh requested
      if (!refresh && _liveHealthCache && (now - _liveHealthCache.fetchedAt) < LIVE_HEALTH_CACHE_MS) {
        return res.json({ ..._liveHealthCache.result, cached: true, cacheAgeMs: now - _liveHealthCache.fetchedAt });
      }

      const { pool } = await import("../db");
      const { sql: drizzleSqlRaw } = await import("drizzle-orm");

      const checks: Array<{
        name: string;
        status: "ok" | "error" | "stale" | "warn";
        detail: string;
        durationMs?: number;
        critical: boolean;
      }> = [];

      // 1. DB
      let dbOk = false;
      let dbMs = 0;
      try {
        const t0 = Date.now();
        await pool.query("SELECT 1");
        dbMs = Date.now() - t0;
        dbOk = true;
      } catch {}
      checks.push({ name: "db", status: dbOk ? "ok" : "error", detail: dbOk ? `${dbMs}ms` : "Connection failed", durationMs: dbMs, critical: true });

      // 2. sequenceWorker
      // When LEGACY_OUTREACH_ENABLED is off the BullMQ sequence job is intentionally
      // not ticking — a stale heartbeat is expected, not an error.
      let seqStatus: "ok" | "error" | "stale" = "error";
      let seqDetail = "Never (worker has not run)";
      try {
        const { featureFlags } = await import("../services/feature-flags");
        if (!featureFlags.LEGACY_OUTREACH_ENABLED) {
          seqStatus = "ok";
          seqDetail = "LEGACY_OUTREACH_ENABLED is off — worker intentionally idle";
        } else {
          const hb = await storage.getSystemSetting("sequence_runner_last_tick");
          if (hb?.at) {
            const ageMs = now - new Date(hb.at).getTime();
            const ageMins = Math.round(ageMs / 60000);
            if (ageMs < 15 * 60 * 1000) {
              seqStatus = "ok";
              seqDetail = `last tick: ${ageMins}m ago`;
            } else {
              seqStatus = "stale";
              seqDetail = `last tick: ${ageMins}m ago (stale >15m)`;
            }
          }
        }
      } catch {}
      checks.push({ name: "sequenceWorker", status: seqStatus, detail: seqDetail, critical: true });

      // Names treated as critical for this live-health endpoint's own summary
      // (kept in sync with the `critical: true` flags pushed above/below —
      // sequenceWorker must stay listed here, or a stalled outbound worker
      // would not surface as a critical live-health failure).
      const CRITICAL_NAMES = ["sequenceWorker", "redis"];

      // 3. slaWorker
      let slaStatus: "ok" | "error" | "stale" = "error";
      let slaDetail = "Never (worker has not run)";
      try {
        const slaHb = await storage.getSystemSetting("sla_worker_last_tick");
        if (slaHb?.at) {
          const ageMs = now - new Date(slaHb.at).getTime();
          const ageMins = Math.round(ageMs / 60000);
          if (ageMs < 15 * 60 * 1000) {
            slaStatus = "ok";
            slaDetail = `last tick: ${ageMins}m ago`;
          } else {
            slaStatus = "stale";
            slaDetail = `last tick: ${ageMins}m ago (stale >15m)`;
          }
        }
      } catch {}
      checks.push({ name: "slaWorker", status: slaStatus, detail: slaDetail, critical: false });

      // 4. ghlSync — last sync from audit logs
      let ghlStatus: "ok" | "stale" | "warn" = "warn";
      let ghlDetail = "No sync recorded";
      try {
        // Rewritten as a UNION of single-action subqueries: with a composite
        // (action, created_at DESC) index, a multi-value IN + ORDER BY + LIMIT 1
        // query can make Postgres pick a plan that scans the created_at index
        // backward and filters by action instead — if none of the actions have
        // a recent row, that degenerates into a full-table scan (confirmed via
        // EXPLAIN ANALYZE: 149s on this table). Each subquery here has a single
        // equality on `action`, which reliably drives an index-only scan on the
        // composite index (sub-100ms even with zero matching rows).
        const rows = await db.execute(drizzleSqlRaw.raw(`
          SELECT created_at FROM (
            (SELECT created_at FROM audit_logs WHERE action = 'ghl_sync_completed' ORDER BY created_at DESC LIMIT 1)
            UNION ALL
            (SELECT created_at FROM audit_logs WHERE action = 'GHL_SYNC_TICK_COMPLETE' ORDER BY created_at DESC LIMIT 1)
            UNION ALL
            (SELECT created_at FROM audit_logs WHERE action = 'ghl_sync_contacts' ORDER BY created_at DESC LIMIT 1)
          ) t
          ORDER BY created_at DESC NULLS LAST LIMIT 1
        `));
        const row = rows.rows[0] as any;
        if (row?.created_at) {
          const ageMs = now - new Date(row.created_at).getTime();
          const ageMins = Math.round(ageMs / 60000);
          if (ageMs < 60 * 60 * 1000) {
            ghlStatus = "ok";
            ghlDetail = `last tick: ${ageMins}m ago`;
          } else {
            ghlStatus = "stale";
            ghlDetail = `last tick: ${ageMins}m ago (stale >1h)`;
          }
        }
      } catch {}
      checks.push({ name: "ghlSync", status: ghlStatus, detail: ghlDetail, critical: false });

      // 5. redis
      let redisOk = false;
      let redisMs = 0;
      let redisDetail = "Not connected";
      try {
        const { requireQueueManagerReady } = await import("../services/queue-manager");
        const qm = requireQueueManagerReady();
        const t0 = Date.now();
        if (qm) {
          const conn = (qm as any)._redisConnection;
          if (conn && typeof conn.ping === "function") {
            await conn.ping();
          }
          const m = await qm.getAllQueueMetrics();
          redisMs = Date.now() - t0;
          redisOk = m.queueMode === "bullmq_redis";
          redisDetail = redisOk ? `${redisMs}ms` : `Queue mode: ${m.queueMode}`;
        }
      } catch {}
      checks.push({ name: "redis", status: redisOk ? "ok" : "error", detail: redisDetail, durationMs: redisMs, critical: true });

      // 6. ai — configuration only. Generic health must not call providers.
      const aiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
      checks.push({
        name: "ai",
        status: aiKey ? "ok" : "warn",
        detail: aiKey ? "API key configured (not probed)" : "AI_INTEGRATIONS_OPENAI_API_KEY not set",
        critical: false,
      });

      // 7. dbBackup — persisted backup history only; do not query backup providers.
      let backupStatus: "ok" | "warn" = "warn";
      let backupDetail = "No successful backup recorded";
      try {
        // Same UNION-of-single-action-subqueries fix as the ghlSync check above —
        // avoids the multi-value IN + full-table-scan plan on audit_logs.
        const backupResult = await db.execute(drizzleSqlRaw.raw(`
          SELECT MAX(created_at) AS created_at FROM (
            (SELECT created_at FROM audit_logs WHERE action = 'db_backup_completed' ORDER BY created_at DESC LIMIT 1)
            UNION ALL
            (SELECT created_at FROM audit_logs WHERE action = 'db_backup_success' ORDER BY created_at DESC LIMIT 1)
          ) t
        `));
        const latestBackup = (backupResult.rows[0] as any)?.created_at;
        if (latestBackup) {
          const latestMs = new Date(latestBackup).getTime();
          const ageMs = now - latestMs;
          const ageHours = Math.round(ageMs / 3600000);
          backupStatus = "ok";
          backupDetail = `last backup: ${ageHours}h ago`;
        }
      } catch {}
      checks.push({ name: "dbBackup", status: backupStatus, detail: backupDetail, critical: false });

      // 8. kpiQuery — contact/deal counts
      // Use PostgreSQL's catalog estimates rather than COUNT(*) over the
      // production-sized tables. This endpoint is itself a liveness probe;
      // a full scan here can occupy a pool connection long enough for the
      // probe to time out under normal worker load.
      let kpiOk = false;
      let kpiDetail = "Query failed";
      try {
        const estimateResult = await db.execute(drizzleSqlRaw.raw(`
          SELECT relname, reltuples::bigint AS estimate
          FROM pg_class
          WHERE relname IN ('contacts', 'deals')
        `));
        const estimates = estimateResult.rows as Array<{ relname: string; estimate: string | number }>;
        const contactCount = Number(estimates.find((row) => row.relname === "contacts")?.estimate ?? 0);
        const dealCount = Number(estimates.find((row) => row.relname === "deals")?.estimate ?? 0);
        if (contactCount > 0 && dealCount > 0) {
          kpiOk = true;
          kpiDetail = `contacts≈${contactCount.toLocaleString()}  deals≈${dealCount.toLocaleString()} (approx)`;
        } else {
          // Newly-created tables may not have statistics yet. Confirm that
          // both relations are queryable without scanning them.
          const existenceResult = await db.execute(drizzleSqlRaw.raw(`
            SELECT
              EXISTS (SELECT 1 FROM contacts LIMIT 1) AS contacts,
              EXISTS (SELECT 1 FROM deals LIMIT 1) AS deals
          `));
          const row = existenceResult.rows[0] as { contacts?: boolean; deals?: boolean } | undefined;
          kpiOk = row?.contacts === true && row?.deals === true;
          kpiDetail = kpiOk ? "contacts and deals queryable (statistics pending)" : "contacts or deals has no rows";
        }
      } catch {}
      checks.push({ name: "kpiQuery", status: kpiOk ? "ok" : "error", detail: kpiDetail, critical: true });

      // 9. outboundPause
      let pauseStatus: "ok" | "warn" = "warn";
      let pauseDetail = "Could not read pause state";
      try {
        const { getPauseState } = await import("../services/outbound-pause-authority");
        const pause = await getPauseState();
        pauseStatus = pause.source === "safe_default" ? "warn" : "ok";
        pauseDetail = `state=${pause.state} source=${pause.source} epoch=${pause.epoch.toString()}${pause.reason ? ` reason=${pause.reason}` : ""}`;
      } catch {}
      checks.push({ name: "outboundPause", status: pauseStatus, detail: pauseDetail, critical: false });

      // 10. productionSeedConvergence (Task #1750) — read-only re-verification
      // that every migration-embedded seed/backfill row this deploy requires
      // (CRO-02/03/03A, CR-04, CR-06, inbound-effect orchestration) is
      // actually present, since Replit Publish schema sync never runs a
      // migration's imperative INSERT/UPDATE statements.
      let seedStatus: "ok" | "error" = "error";
      let seedDetail = "Check failed to run";
      try {
        const { verifyProductionSeedConvergence } = await import("../services/production-seed-convergence");
        const report = await verifyProductionSeedConvergence();
        seedStatus = report.ok ? "ok" : "error";
        seedDetail = report.ok
          ? `${report.results.length}/${report.results.length} seed targets converged`
          : report.results.filter(r => r.outcome === "unexpected" || r.outcome === "conflicted" || r.outcome === "blocked")
              .map(r => `${r.id}: ${r.detail}`).join("; ");
      } catch (e: any) {
        seedDetail = e?.message ?? String(e);
      }
      checks.push({ name: "productionSeedConvergence", status: seedStatus, detail: seedDetail, critical: true });

      const criticalChecks = checks.filter(c => c.critical);
      const allCriticalOk = criticalChecks.every(c => c.status === "ok");
      const overallOk = allCriticalOk;

      const result = {
        ok: overallOk,
        fetchedAt: new Date(now).toISOString(),
        checks,
        summary: {
          total: checks.length,
          ok: checks.filter(c => c.status === "ok").length,
          critical: criticalChecks.length,
          criticalOk: criticalChecks.filter(c => c.status === "ok").length,
        },
        releaseSha: process.env.RELEASE_SHA ?? null,
        cached: false,
        cacheAgeMs: 0,
      };

      _liveHealthCache = { result, fetchedAt: now };
      return res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Retry GHL sync for a contact identified by entityKey (email or contact id)
  app.post("/api/admin/ghl-failures/retry", requireRole("admin", "manager"), async (req, res) => {
    try {
      return res.status(503).json({ code: "RECONCILIATION_COMMAND_REQUIRED", message: "GHL retry requires a durable reconciliation command." });
      const { entityKey } = req.body ?? {};
      if (!entityKey) return res.status(400).json({ message: "entityKey is required" });

      const numId = parseInt(entityKey, 10);
      const [contact] = await db
        .select({ id: contacts.id, email: contacts.email, ghlContactId: contacts.ghlContactId })
        .from(contacts)
        .where(
          isNaN(numId)
            ? eq(contacts.email, entityKey)
            : eq(contacts.id, numId),
        )
        .limit(1);

      if (!contact) return res.status(404).json({ message: "Contact not found for entityKey" });

      const result = {
        success: false,
        error: "Direct GHL synchronization is disabled; use a durable contact projection.",
      };

      auditChange({
        actorType: "user",
        userId: (req.user as any)?.id ?? null,
        action: "ghl_sync_manual_retry",
        entityType: "ghl_sync",
        entityId: contact.id,
        entityKey: contact.email ?? String(contact.id),
        details: { triggeredBy: (req.user as any)?.email ?? "admin", result },
      }).catch(() => {});

      res.json({ success: true, contactId: contact.id, result });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === DEPLOYMENT READINESS ===
  app.get("/api/admin/pre-deploy-result", requireRole("admin"), async (req, res) => {
    try {
      const result = await storage.getSystemSetting("pre_deploy_last_result");
      if (!result) return res.json(null);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === AUTOMATION REGISTRY ===

  // GET /api/admin/automations — returns all automation_registry rows (admin only)
  app.get("/api/admin/automations", isDashboardUser, requireRole("admin"), async (_req, res) => {
    try {
      const rows = await db.select().from(automationRegistry).orderBy(automationRegistry.key);
      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PATCH /api/admin/automations/:key — update kill_switch_enabled and/or status (admin only)
  app.patch("/api/admin/automations/:key", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const key = String(req.params.key);
      const updates: Record<string, unknown> = {};

      if (typeof req.body.killSwitchEnabled === "boolean" || typeof req.body.kill_switch_enabled === "boolean") {
        updates.killSwitchEnabled = req.body.killSwitchEnabled ?? req.body.kill_switch_enabled;
      }
      if (typeof req.body.status === "string") {
        updates.status = req.body.status;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No editable fields supplied (killSwitchEnabled, status)" });
      }

      updates.updatedAt = new Date();

      const [updated] = await db
        .update(automationRegistry)
        .set(updates as any)
        .where(eq(automationRegistry.key, key))
        .returning();

      if (!updated) return res.status(404).json({ message: `Automation '${key}' not found in registry` });

      // Invalidate kill-switch cache so next job tick picks up the change immediately.
      const { invalidateAutomationCache } = await import("../services/automation-kill-switch");
      invalidateAutomationCache(key);

      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === LIFECYCLE CONFLICT DIAGNOSTICS ===
  // GET /api/admin/lifecycle-conflicts
  // Read-only: surfaces contacts where lifecycle_state appears inconsistent
  // with domain state (deals, merchant_profiles, etc.)
  app.get("/api/admin/lifecycle-conflicts", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { pool } = await import("../db");

      // 1. Contacts where lifecycle_state = 'PROSPECT' but merchant_profiles.accountStatus = 'active'
      const activeButProspect = await pool.query(`
        SELECT
          c.id AS contact_id,
          c.first_name || ' ' || c.last_name AS contact_name,
          c.lifecycle_state AS current_lifecycle_state,
          'ACTIVE_PROCESSING' AS suggested_state,
          'Has active merchant profile but lifecycle is PROSPECT' AS conflict_reason
        FROM contacts c
        JOIN merchant_profiles mp ON mp.contact_id = c.id
        WHERE c.lifecycle_state = 'PROSPECT'
          AND mp.account_status = 'active'
          AND c.archived_at IS NULL
        LIMIT 50
      `);

      // 2. Contacts where lifecycle_state = 'PROSPECT' but has any non-closed deal
      const hasDealsButProspect = await pool.query(`
        SELECT
          c.id AS contact_id,
          c.first_name || ' ' || c.last_name AS contact_name,
          c.lifecycle_state AS current_lifecycle_state,
          'ENGAGED' AS suggested_state,
          'Has active deal in pipeline but lifecycle is PROSPECT' AS conflict_reason
        FROM contacts c
        WHERE c.lifecycle_state = 'PROSPECT'
          AND c.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM deals d
            WHERE d.contact_id = c.id
              AND d.archived_at IS NULL
              AND d.stage NOT IN ('Closed Lost', 'Nurture / Not Now')
          )
        LIMIT 50
      `);

      const conflicts = [
        ...activeButProspect.rows,
        ...hasDealsButProspect.rows,
      ].slice(0, 100);

      res.json({
        total: conflicts.length,
        conflicts,
        generatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Communication Arbitration — suppression log ───────────────────────────
  // GET /api/admin/arbitration-suppressions
  // Returns recent audit_logs rows where action = 'arbitration_suppressed',
  // joined to contacts for display. Supports optional ?limit=N&days=N query.
  app.get("/api/admin/arbitration-suppressions", requireRole("admin", "manager"), async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? "100")), 500);
      const days  = Math.min(parseInt(String(req.query.days  ?? "7")),   90);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          id:        auditLogs.id,
          contactId: auditLogs.entityId,
          details:   auditLogs.details,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "arbitration_suppressed"),
            gte(auditLogs.createdAt, since),
          )
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit);

      // Attach contact names where available
      const contactIds = [...new Set(rows.map(r => r.contactId).filter(Boolean))] as number[];
      let contactMap: Record<number, { firstName: string; lastName: string; email: string | null }> = {};
      if (contactIds.length > 0) {
        const { contacts: contactsTable } = await import("@shared/schema");
        const { inArray } = await import("drizzle-orm");
        const people = await db
          .select({
            id:        contactsTable.id,
            firstName: contactsTable.firstName,
            lastName:  contactsTable.lastName,
            email:     contactsTable.email,
          })
          .from(contactsTable)
          .where(inArray(contactsTable.id, contactIds));
        for (const p of people) contactMap[p.id] = p;
      }

      const enriched = rows.map(r => ({
        ...r,
        contact: r.contactId != null ? (contactMap[r.contactId] ?? null) : null,
      }));

      res.json({ items: enriched, total: enriched.length, days, since: since.toISOString() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/admin/arbitration-windows — return current suppression window settings
  app.get("/api/admin/arbitration-windows", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const [human, auto, reply] = await Promise.all([
        storage.getSystemSetting("arbitration_human_touch_window_hours").catch(() => null),
        storage.getSystemSetting("arbitration_auto_send_window_minutes").catch(() => null),
        storage.getSystemSetting("arbitration_reply_pending_window_hours").catch(() => null),
      ]);
      res.json({
        humanTouchWindowHours:    human  != null ? Number(human)  : 4,
        autoSendWindowMinutes:    auto   != null ? Number(auto)   : 60,
        replyPendingWindowHours:  reply  != null ? Number(reply)  : 24,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PATCH /api/admin/arbitration-windows — update suppression windows
  app.patch("/api/admin/arbitration-windows", requireRole("admin"), async (req, res) => {
    try {
      const schema = {
        humanTouchWindowHours:   (v: unknown) => typeof v === "number" && v >= 0 && v <= 72,
        autoSendWindowMinutes:   (v: unknown) => typeof v === "number" && v >= 0 && v <= 1440,
        replyPendingWindowHours: (v: unknown) => typeof v === "number" && v >= 0 && v <= 168,
      };
      const keyMap: Record<string, string> = {
        humanTouchWindowHours:   "arbitration_human_touch_window_hours",
        autoSendWindowMinutes:   "arbitration_auto_send_window_minutes",
        replyPendingWindowHours: "arbitration_reply_pending_window_hours",
      };
      const updates: Record<string, string> = {};
      for (const [field, validate] of Object.entries(schema)) {
        if (req.body[field] !== undefined) {
          if (!validate(req.body[field])) {
            return res.status(400).json({ error: `Invalid value for ${field}` });
          }
          updates[keyMap[field]] = String(req.body[field]);
        }
      }
      for (const [key, value] of Object.entries(updates)) {
        await storage.setSystemSetting(key, value);
      }
      // Invalidate the arbitration config cache so changes take effect immediately
      const { invalidateArbitrationConfigCache } = await import("../services/communication-arbitration");
      invalidateArbitrationConfigCache();

      await auditChange({
        action: "arbitration_windows_updated",
        entityType: "system",
        entityId: 0,
        entityKey: "arbitration_windows",
        actorType: "user",
        details: updates,
      });

      res.json({ ok: true, updated: Object.keys(updates) });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GET /api/admin/lead-queue-stats ───────────────────────────────────────
  // Returns pipeline health metrics for the Speed-to-Lead dashboard widget.
  // Fields:
  //   leadsCreatedToday         — contacts created since midnight UTC
  //   medianMinutesToFirstNba   — median(nba.generated_at - contact.created_at) for today's leads
  //   overdueHighScoreCount     — contacts with next_sla_due_at < NOW() and score >= threshold
  //   overdueLeads              — top 25 overdue leads (details for the table)
  //   stalledLeadsCount         — high-score contacts (last 24h) with no NBA row yet
  //   threshold                 — current LEAD_SLA_SCORE_THRESHOLD env value
  //   slaMins                   — current LEAD_SLA_MINUTES env value
  // ─── Data Health Panel (Wave R1) — orphan counts and inconsistencies ─────────

  app.get("/api/admin/data-health", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { pool: pgPool } = await import("../db");

      const [
        orphanedDealsRow,
        orphanedEnrollmentsRow,
        nullLifecycleRow,
        enrollmentsNoNextActionRow,
        contactsEmailInconsistencyRow,
        dealsNoGhlRow,
      ] = await Promise.all([
        // Deals with no contactId (orphaned from any contact)
        pgPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM deals WHERE contact_id IS NULL`
        ),
        // Sequence enrollments whose sequence no longer exists
        pgPool.query<{ count: string }>(
          `SELECT COUNT(se.*)::text AS count
           FROM sequence_enrollments se
           LEFT JOIN follow_up_sequences fs ON fs.id = se.sequence_id
           WHERE se.status IN ('active','paused') AND fs.id IS NULL`
        ),
        // Contacts with NULL lifecycle_state (should always be set)
        pgPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM contacts WHERE lifecycle_state IS NULL AND archived_at IS NULL`
        ),
        // Active enrollments with no next_action_at (will never process)
        pgPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM sequence_enrollments WHERE status = 'active' AND next_action_at IS NULL`
        ),
        // Contacts where email_status='active' but no email (likely unvalidated)
        pgPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM contacts WHERE (email IS NULL OR email = '') AND email_status = 'active' AND archived_at IS NULL`
        ),
        // Active sales/onboarding deals without a GHL opportunity ID (sync gap)
        pgPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM deals
           WHERE ghl_opportunity_id IS NULL AND pipeline IN ('sales','onboarding')
             AND stage NOT IN ('Closed Lost','Declined')
             AND created_at < NOW() - INTERVAL '1 hour'`
        ),
      ]);

      // Sample up to 25 rows for each category for drill-down
      const [
        orphanedDealsRows,
        orphanedEnrollmentsRows,
        nullLifecycleRows,
      ] = await Promise.all([
        pgPool.query<{ id: number; stage: string; created_at: string }>(
          `SELECT id, stage, created_at::text FROM deals WHERE contact_id IS NULL ORDER BY created_at DESC LIMIT 25`
        ),
        pgPool.query<{ id: number; contact_id: number; sequence_id: number; status: string }>(
          `SELECT se.id, se.contact_id, se.sequence_id, se.status
           FROM sequence_enrollments se
           LEFT JOIN follow_up_sequences fs ON fs.id = se.sequence_id
           WHERE se.status IN ('active','paused') AND fs.id IS NULL
           ORDER BY se.created_at DESC LIMIT 25`
        ),
        pgPool.query<{ id: number; email: string; created_at: string }>(
          `SELECT id, COALESCE(email, '(no email)') as email, created_at::text
           FROM contacts WHERE lifecycle_state IS NULL AND archived_at IS NULL
           ORDER BY created_at DESC LIMIT 25`
        ),
      ]);

      res.json({
        generatedAt: new Date().toISOString(),
        summary: {
          orphanedDeals: parseInt(orphanedDealsRow.rows[0]?.count ?? "0", 10),
          orphanedEnrollments: parseInt(orphanedEnrollmentsRow.rows[0]?.count ?? "0", 10),
          contactsNullLifecycle: parseInt(nullLifecycleRow.rows[0]?.count ?? "0", 10),
          activeEnrollmentsNoNextAction: parseInt(enrollmentsNoNextActionRow.rows[0]?.count ?? "0", 10),
          contactsEmailInconsistency: parseInt(contactsEmailInconsistencyRow.rows[0]?.count ?? "0", 10),
          dealsNoGhlOpportunityId: parseInt(dealsNoGhlRow.rows[0]?.count ?? "0", 10),
        },
        samples: {
          orphanedDeals: orphanedDealsRows.rows,
          orphanedEnrollments: orphanedEnrollmentsRows.rows,
          contactsNullLifecycle: nullLifecycleRows.rows,
        },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/data-health/reconcile", requireRole("admin"), async (req, res) => {
    // Trigger reconcile-orphans script asynchronously
    const { execFile } = await import("child_process");
    const child = execFile("npx", ["tsx", "scripts/reconcile-orphans.ts"], {
      env: { ...process.env },
      cwd: process.cwd(),
    });
    const pid = child.pid;
    console.log(`[DataHealth] Reconciliation script started (pid=${pid})`);
    res.json({ started: true, pid, message: "Reconciliation running in background — check audit logs for results" });
  });

  app.get("/api/admin/lead-queue-stats", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { pool: pgPool } = await import("../db");
      const threshold = parseInt(process.env.LEAD_SLA_SCORE_THRESHOLD ?? "40", 10);
      const slaMins = parseInt(process.env.LEAD_SLA_MINUTES ?? "60", 10);

      // Leads created since midnight UTC today
      const todayCountResult = await pgPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM contacts
         WHERE created_at >= CURRENT_DATE
           AND archived_at IS NULL`,
      );
      const leadsCreatedToday = parseInt(todayCountResult.rows[0]?.count ?? "0", 10);

      // Median minutes from contact creation to first NBA generation (today's leads only)
      const medianResult = await pgPool.query<{ median_mins: string | null }>(
        `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (n.generated_at - c.created_at)) / 60
         ) AS median_mins
         FROM contact_nba n
         JOIN contacts c ON c.id = n.contact_id
         WHERE c.created_at >= CURRENT_DATE
           AND c.archived_at IS NULL
           AND n.generated_at IS NOT NULL`,
      );
      const medianMinutesToFirstNba =
        medianResult.rows[0]?.median_mins !== null &&
        medianResult.rows[0]?.median_mins !== undefined
          ? Math.round(parseFloat(medianResult.rows[0].median_mins))
          : null;

      // Overdue high-score leads (next_sla_due_at < NOW())
      const overdueResult = await pgPool.query<{
        id: string;
        first_name: string;
        last_name: string;
        email: string;
        lead_score: string;
        assigned_to: string | null;
        next_sla_due_at: string;
      }>(
        `SELECT id, first_name, last_name, email, lead_score, assigned_to, next_sla_due_at
         FROM contacts
         WHERE next_sla_due_at IS NOT NULL
           AND next_sla_due_at < NOW()
           AND lead_score >= $1
           AND archived_at IS NULL
         ORDER BY next_sla_due_at ASC
         LIMIT 25`,
        [threshold],
      );
      const overdueHighScoreCount = overdueResult.rows.length;
      const overdueLeads = overdueResult.rows.map((r) => ({
        contactId: parseInt(r.id, 10),
        name: [r.first_name, r.last_name].filter(Boolean).join(" "),
        email: r.email,
        leadScore: parseInt(r.lead_score, 10),
        assignedTo: r.assigned_to,
        slaDueAt: r.next_sla_due_at,
        minutesOverdue: Math.round(
          (Date.now() - new Date(r.next_sla_due_at).getTime()) / 60000,
        ),
      }));

      // Stalled: high-score leads created in last 24h with no NBA row
      const stalledResult = await pgPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM contacts c
         LEFT JOIN contact_nba n ON n.contact_id = c.id
         WHERE c.created_at >= NOW() - INTERVAL '24 hours'
           AND c.lead_score >= $1
           AND c.archived_at IS NULL
           AND n.id IS NULL`,
        [threshold],
      );
      const stalledLeadsCount = parseInt(stalledResult.rows[0]?.count ?? "0", 10);

      res.json({
        leadsCreatedToday,
        medianMinutesToFirstNba,
        overdueHighScoreCount,
        overdueLeads,
        stalledLeadsCount,
        threshold,
        slaMins,
        asOf: new Date().toISOString(),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ============================================================
  // MID / TID REGISTRY  (#1404)
  // ============================================================

  /** List all MIDs — supports ?status= and ?contactId= filters */
  app.get("/api/admin/mids", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { status, contactId } = req.query as Record<string, string | undefined>;
      let query = db
        .select({
          id:            merchantMids.id,
          mid:           merchantMids.mid,
          tids:          merchantMids.tids,
          processorName: merchantMids.processorName,
          status:        merchantMids.status,
          monthlyVolumeCap: merchantMids.monthlyVolumeCap,
          assignedAt:    merchantMids.assignedAt,
          activatedAt:   merchantMids.activatedAt,
          suspendedAt:   merchantMids.suspendedAt,
          closedAt:      merchantMids.closedAt,
          suspensionReason: merchantMids.suspensionReason,
          notes:         merchantMids.notes,
          contactId:     merchantMids.contactId,
          dealId:        merchantMids.dealId,
          firstName:     contacts.firstName,
          lastName:      contacts.lastName,
          businessName:  contacts.companyName,
          createdAt:     merchantMids.createdAt,
          updatedAt:     merchantMids.updatedAt,
        })
        .from(merchantMids)
        .leftJoin(contacts, eq(contacts.id, merchantMids.contactId));

      const conditions: ReturnType<typeof eq>[] = [];
      if (status) conditions.push(eq(merchantMids.status, status));
      if (contactId) conditions.push(eq(merchantMids.contactId, parseInt(contactId, 10)));

      const rows = conditions.length > 0
        ? await query.where(conditions.length === 1 ? conditions[0] : and(...conditions)).orderBy(desc(merchantMids.assignedAt))
        : await query.orderBy(desc(merchantMids.assignedAt));

      // REV-05A: List endpoint returns masked MIDs only; write an access receipt
      // for each row returned so every full-MID read is durably audited.
      const userId = String((req.user as any)?.id ?? "");
      const { maskMid: _maskMidList } = await import("../utils/mask-mid");
      const maskedRows = rows.map((row) => {
        const { mid: _rawMid, ...rowWithoutMid } = row;
        return {
          ...rowWithoutMid,
          midMasked: _maskMidList(row.mid),
          hasMid: !!row.mid,
        };
      });
      // Write receipts after masking (use raw row.id, contactId).
      await Promise.all(rows.map((row) =>
        writeMidAccessReceipt({ midId: row.id, contactId: row.contactId ?? 0, userId, endpoint: req.path, purpose: "admin_mid_list" })
      ));

      res.json(maskedRows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /** Create a new MID assignment */
  app.post("/api/admin/mids", requireRole("admin", "manager"), async (req, res) => {
    try {
      const parsed = insertMerchantMidSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid MID data", errors: parsed.error.errors });
      }
      const row = await createMerchantMid({
        ...parsed.data, actorId: String((req.user as any)?.id ?? ""), actorType: "user",
      });
      // REV-05A: Mask MID in create response; full MID only via dedicated receipted endpoint.
      const userId = String((req.user as any)?.id ?? "");
      await writeMidAccessReceipt({ midId: row.id, contactId: row.contactId ?? 0, userId, endpoint: req.path, purpose: "admin_mid_create" });
      const { mid: _rawMid2, ...rowWithoutMid2 } = row;
      const { maskMid: _maskMidCreate2 } = await import("../utils/mask-mid");
      res.status(201).json({
        ...rowWithoutMid2,
        midMasked: _maskMidCreate2(row.mid),
        hasMid: !!row.mid,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /** Update a MID (status, notes, activatedAt, etc.) */
  app.patch("/api/admin/mids/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = parseInt(String(String(req.params.id)), 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid MID id" });

      const allowedFields = insertMerchantMidSchema.partial();
      const parsed = allowedFields.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid update data", errors: parsed.error.errors });
      }

      const row = await updateMerchantMid({
        id, ...parsed.data, actorId: String((req.user as any)?.id ?? ""), actorType: "user",
      });
      // REV-05A: Mask MID in update response.
      const userId = String((req.user as any)?.id ?? "");
      await writeMidAccessReceipt({ midId: row.id, contactId: row.contactId ?? 0, userId, endpoint: req.path, purpose: "admin_mid_update" });
      const { mid: _rawMid3, ...rowWithoutMid3 } = row;
      const { maskMid: _maskMidUpdate3 } = await import("../utils/mask-mid");
      res.json({
        ...rowWithoutMid3,
        midMasked: _maskMidUpdate3(row.mid),
        hasMid: !!row.mid,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /** List MIDs pending activation (assigned but no activatedAt) — for the activation monitor dashboard */
  app.get("/api/admin/mids/unactivated", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { findUnactivatedMids } = await import("../services/merchant-activation-monitor");
      const { maskMid: _maskMidUnactivated } = await import("../utils/mask-mid");
      const items = await findUnactivatedMids();
      // REV-05A: Mask raw MID in unactivated list response.
      const maskedItems = items.map((i: any) => ({
        ...i,
        mid: _maskMidUnactivated(i.mid),
        midMasked: _maskMidUnactivated(i.mid),
        hasMid: !!i.mid,
      }));
      res.json(maskedItems);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/admin/rep-activity/inactive
  // #418 — Reps with no activity in the last 7 days (or ?days=N).
  app.get("/api/admin/rep-activity/inactive", requireRole("admin", "manager"), async (req, res) => {
    try {
      const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || "7"), 10)));
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const result = await pool.query<{ actor_id: string }>(
        `SELECT DISTINCT actor_id FROM audit_logs
         WHERE actor_type = 'user'
           AND action IN ('call_logged', 'email_sent', 'sequence_email_sent', 'contact_created', 'deal_created', 'sms_sent')
           AND created_at >= $1`,
        [cutoff.toISOString()]
      );

      const activeActorIds = new Set(result.rows.map(r => String(r.actor_id)));
      const agentList = await storage.getAgents().catch(() => []);
      const inactiveReps = agentList
        .filter(a => a.role === "agent" && !activeActorIds.has(String(a.id)))
        .map(a => ({ agentId: a.id, name: `${a.firstName} ${a.lastName}`.trim(), email: a.email }));

      res.json({ days, cutoff: cutoff.toISOString(), inactiveReps });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/admin/rep-activity/today
  // #380 — Per-rep activity count for today (calls logged, emails sent, contacts created).
  app.get("/api/admin/rep-activity/today", requireRole("admin", "manager"), async (req, res) => {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const result = await pool.query<{ actor_id: string; action: string; cnt: string }>(
        `SELECT actor_id, action, COUNT(*) AS cnt
         FROM audit_logs
         WHERE actor_type = 'user'
           AND action IN ('call_logged', 'email_sent', 'sequence_email_sent', 'contact_created', 'deal_created', 'sms_sent')
           AND created_at >= $1
         GROUP BY actor_id, action`,
        [todayStart.toISOString()]
      );

      // Aggregate by actorId
      const byActor: Record<string, Record<string, number>> = {};
      for (const row of result.rows) {
        if (!row.actor_id) continue;
        if (!byActor[row.actor_id]) byActor[row.actor_id] = {};
        byActor[row.actor_id][row.action] = Number(row.cnt);
      }

      // Look up agent names
      const agentList = await storage.getAgents().catch(() => []);
      const agentMap = new Map(agentList.map(a => [String(a.id), `${a.firstName} ${a.lastName}`.trim()]));

      const summary = Object.entries(byActor).map(([actorId, actions]) => ({
        actorId,
        name: agentMap.get(actorId) || `User ${actorId}`,
        callsLogged: (actions.call_logged || 0),
        emailsSent: (actions.email_sent || 0) + (actions.sequence_email_sent || 0),
        smsSent: (actions.sms_sent || 0),
        contactsCreated: (actions.contact_created || 0),
        dealsCreated: (actions.deal_created || 0),
        total: Object.values(actions).reduce((s, v) => s + v, 0),
      })).sort((a, b) => b.total - a.total);

      res.json({ date: todayStart.toISOString(), reps: summary });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /**
   * POST /api/admin/purge-test-contacts
   * BT-06: DISABLED (410 Gone). Heuristic-based destructive cleanup violates
   * the commercial classification kill lines. Use the classification authority
   * and reconciliation endpoints instead.
   */
  app.post("/api/admin/purge-test-contacts", requireRole("admin"), async (req, res) => {
    return res.status(410).json({
      error: "Gone",
      message:
        "POST /api/admin/purge-test-contacts has been permanently disabled (BT-06). " +
        "Heuristic-based destructive cleanup is a kill-line violation: commercial class " +
        "cannot be inferred from email prefixes, names, or tags. " +
        "Use the commercial classification authority to mark test records and the " +
        "reconciliation endpoints to view and export non-production data.",
    });
  });

  // ── BT-06 Commercial classification workflow ────────────────────────────
  // Managers may preview evidence; only admins may approve or execute a class
  // transition. These routes intentionally expose no raw evidence to agents or
  // public callers.
  const commercialClassSchema = z.enum(["production", "test", "demo", "synthetic", "unknown"]);
  const commercialSubjectSchema = z.enum(["contact", "deal", "prospect", "company", "business"]);
  const evidenceSchema = z.record(z.string(), z.unknown()).default({});
  const commercialEvidenceRefSchema = z.object({
    kind: z.enum(["classification_event", "contact_source_event", "import_row_disposition",
      "identity_observation", "merge_operation", "merge_redirect", "business_link_decision",
      "legacy_company_mapping_decision", "relationship_review"]),
    id: z.union([z.string().uuid(), z.number().int().positive()]),
  });

  // Automatic matches are candidates; only this reviewed admin workflow writes
  // graph truth and its compatibility projection.
  app.post(
    "/api/admin/commercial-links/decisions",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      try {
        const parsed = z.object({
          contactId: z.number().int().positive(),
          businessId: z.number().int().positive().nullable().optional(),
          decision: z.enum(["verified", "missing", "conflicted", "legacy_unknown", "rejected"]),
          decisionKey: z.string().min(8).max(200),
          evidenceSourceEventId: z.number().int().positive().nullable().optional(),
          expectedRevision: z.number().int().nonnegative().optional(),
        }).safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ message: "Invalid link decision", errors: parsed.error.errors });
        const { decideContactBusinessLink } = await import("../services/commercial-link-authority");
        const row = await decideContactBusinessLink({
          ...parsed.data,
          reviewerId: String((req.user as any)?.id ?? ""),
        });
        res.status(201).json(row);
      } catch (err) {
        const { CommercialRevisionConflict } = await import("../services/commercial-link-authority");
        if (err instanceof CommercialRevisionConflict) return res.status(409).json({ message: err.message, code: err.code });
        serverError(res, err);
      }
    },
  );

  // Indexed contact/business reconciliation is proposal-only. Every mutation is
  // admin-only and CSRF is enforced by the global csrfProtection middleware.
  app.get(
    "/api/admin/contact-business-reconciliation/preview",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      try {
        const limit = Number(req.query.limit ?? 25);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return res.status(400).json({ message: "limit must be an integer between 1 and 100" });
        }
        const { previewContactBusinessReconciliation } = await import("../services/contact-business-reconciliation");
        const preview = await previewContactBusinessReconciliation(limit);
        await auditChange({
          userId: String((req.user as any)?.id ?? ""),
          action: "contact_business_reconciliation_previewed",
          entityType: "contact_business_reconciliation",
          entityKey: "indexed_contact_business_suggestions_v1",
          details: {
            sampleLimit: preview.sampleLimit,
            sampledContacts: preview.sampledContacts,
            sampleSuggestions: preview.sampleSuggestions,
            sampleAmbiguousContacts: preview.sampleAmbiguousContacts,
            paidProviderCalls: 0,
          },
        });
        res.json(preview);
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.post(
    "/api/admin/contact-business-reconciliation/start",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      const parsed = z.object({ batchSize: z.number().int().min(1).max(100).default(50) }).strict().safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ message: "Invalid reconciliation start request", errors: parsed.error.errors });
      try {
        const { startContactBusinessReconciliation } = await import("../services/contact-business-reconciliation");
        const state = await startContactBusinessReconciliation({
          ...parsed.data,
          actorId: String((req.user as any)?.id ?? ""),
        });
        res.status(202).json(state);
      } catch (err: any) {
        if (err?.message === "CONTACT_BUSINESS_RECONCILIATION_ALREADY_RUNNING"
            || err?.message === "CONTACT_BUSINESS_RECONCILIATION_RESUME_REQUIRED") {
          return res.status(409).json({ message: err.message, code: err.message });
        }
        serverError(res, err);
      }
    },
  );

  app.post(
    "/api/admin/contact-business-reconciliation/pause",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      try {
        const { pauseContactBusinessReconciliation } = await import("../services/contact-business-reconciliation");
        const state = await pauseContactBusinessReconciliation(String((req.user as any)?.id ?? ""));
        res.json(state);
      } catch (err: any) {
        if (err?.message === "CONTACT_BUSINESS_RECONCILIATION_NOT_FOUND") return res.status(404).json({ message: err.message });
        if (err?.message === "CONTACT_BUSINESS_RECONCILIATION_ALREADY_RUNNING") return res.status(409).json({ message: err.message, code: err.message });
        serverError(res, err);
      }
    },
  );

  app.post(
    "/api/admin/contact-business-reconciliation/resume",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      try {
        const { resumeContactBusinessReconciliation } = await import("../services/contact-business-reconciliation");
        const state = await resumeContactBusinessReconciliation(String((req.user as any)?.id ?? ""));
        res.status(202).json(state);
      } catch (err: any) {
        if (err?.message === "CONTACT_BUSINESS_RECONCILIATION_NOT_FOUND") return res.status(404).json({ message: err.message });
        if (err?.message === "CONTACT_BUSINESS_RECONCILIATION_ALREADY_RUNNING"
            || err?.message === "CONTACT_BUSINESS_RECONCILIATION_ALREADY_COMPLETED") {
          return res.status(409).json({ message: err.message, code: err.message });
        }
        serverError(res, err);
      }
    },
  );

  app.get(
    "/api/admin/contact-business-reconciliation/progress",
    isDashboardUser,
    requireRole("admin"),
    async (_req, res) => {
      try {
        const { getContactBusinessReconciliationProgress } = await import("../services/contact-business-reconciliation");
        res.json(await getContactBusinessReconciliationProgress());
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.get(
    "/api/admin/contact-business-suggestions",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      try {
        const afterId = req.query.afterId === undefined ? undefined : String(req.query.afterId);
        const afterCreatedAt = req.query.afterCreatedAt === undefined ? undefined : String(req.query.afterCreatedAt);
        if (afterId && !z.string().uuid().safeParse(afterId).success) {
          return res.status(400).json({ message: "afterId must be a candidate UUID" });
        }
        if (Boolean(afterId) !== Boolean(afterCreatedAt)
            || (afterCreatedAt && !Number.isFinite(Date.parse(afterCreatedAt)))) {
          return res.status(400).json({ message: "afterCreatedAt and afterId must be supplied together as a keyset cursor" });
        }
        const limit = Number(req.query.limit ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return res.status(400).json({ message: "limit must be an integer between 1 and 100" });
        }
        const { listContactBusinessSuggestions } = await import("../services/contact-business-reconciliation");
        const contactId = req.query.contactId === undefined ? undefined : Number(req.query.contactId);
        if (contactId !== undefined && (!Number.isSafeInteger(contactId) || contactId < 1)) {
          return res.status(400).json({ message: "contactId must be a positive integer" });
        }
        res.json(await listContactBusinessSuggestions({ afterCreatedAt, afterId, limit, contactId }));
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.post(
    "/api/admin/contact-business-suggestions/review-batch",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      const parsed = z.object({
        decisions: z.array(z.object({
          candidateId: z.string().uuid(),
          contactId: z.number().int().positive(),
          businessId: z.number().int().positive(),
          decision: z.enum(["verified", "missing", "conflicted", "legacy_unknown", "rejected"]),
          decisionKey: z.string().min(8).max(200),
          evidenceSourceEventId: z.number().int().positive().nullable().optional(),
          expectedRevision: z.number().int().nonnegative(),
        }).strict()).min(1).max(50),
      }).strict().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid bulk review request", errors: parsed.error.errors });
      const reviewerId = String((req.user as any)?.id ?? "");
      try {
        const { assertCurrentContactBusinessSuggestion } = await import("../services/contact-business-reconciliation");
        const { decideContactBusinessLink, CommercialRevisionConflict } = await import("../services/commercial-link-authority");
        const outcomes: Array<Record<string, unknown>> = [];
        for (const item of parsed.data.decisions) {
          if (!await assertCurrentContactBusinessSuggestion(item)) {
            outcomes.push({ candidateId: item.candidateId, status: "rejected", code: "CONTACT_BUSINESS_CANDIDATE_NOT_CURRENT" });
            continue;
          }
          try {
            const decision = await decideContactBusinessLink({
              contactId: item.contactId,
              // The candidate is not authority. Only an explicit verified
              // choice sends its business to the canonical decision writer.
              businessId: item.decision === "verified" ? item.businessId : null,
              decision: item.decision,
              decisionKey: item.decisionKey,
              reviewerId,
              evidenceSourceEventId: item.evidenceSourceEventId,
              expectedRevision: item.expectedRevision,
              authorityCheck: item.decision === "verified" ? async (tx: any) => {
                const result = await tx.execute(sql`
                  SELECT (
                    candidate.id IS NOT NULL
                    AND
                    contact.archived_at IS NULL
                    AND contact.record_class NOT IN ('test', 'demo', 'synthetic')
                    AND COALESCE(contact.existing_merchant_customer, false) = false
                    AND COALESCE(contact.do_not_contact, false) = false
                    AND COALESCE(contact.opted_out_email, false) = false
                    AND COALESCE(contact.opt_out_status, 'active') <> 'opted_out'
                    AND COALESCE(contact.unsubscribe_status, 'active') <> 'unsubscribed'
                    AND COALESCE(contact.bounce_status, 'none') <> 'hard'
                    AND COALESCE(contact.complaint_status, 'none') <> 'reported'
                    AND contact.suppression_reason IS NULL
                    AND business.record_class NOT IN ('test', 'demo', 'synthetic')
                    AND COALESCE(business.do_not_visit, false) = false
                  ) AS safe
                  FROM contacts contact
                  JOIN businesses business ON business.id = ${item.businessId}
                  LEFT JOIN contact_business_link_candidates candidate
                    ON candidate.id = ${item.candidateId}::uuid
                   AND candidate.contact_id = ${item.contactId}
                   AND candidate.business_id = ${item.businessId}
                   AND NOT EXISTS (
                     SELECT 1
                       FROM contact_business_link_candidates successor
                      WHERE successor.supersedes_candidate_id = candidate.id
                   )
                  WHERE contact.id = ${item.contactId}
                `);
                // decideContactBusinessLink invokes this fence again after it has
                // acquired the contact/business graph membership locks. Candidate
                // writers use the same locks, so currentness cannot change between
                // this in-transaction check and the canonical decision write.
                return Boolean((result as any).rows?.[0]?.safe);
              } : undefined,
            });
            await auditChange({
              userId: reviewerId,
              action: "contact_business_candidate_reviewed",
              entityType: "contact_business_link_candidate",
              entityKey: item.candidateId,
              details: {
                contactId: item.contactId,
                businessId: item.businessId,
                decision: item.decision,
                decisionId: decision.id,
                revision: decision.revision,
                evidenceSourceEventId: item.evidenceSourceEventId ?? null,
              },
            });
            outcomes.push({ candidateId: item.candidateId, status: "applied", decision });
          } catch (error: any) {
            const code = error instanceof CommercialRevisionConflict
              ? error.code
              : String(error?.message ?? "CONTACT_BUSINESS_REVIEW_FAILED").slice(0, 120);
            outcomes.push({ candidateId: item.candidateId, status: "rejected", code });
          }
        }
        await auditChange({
          userId: reviewerId,
          action: "contact_business_candidate_bulk_review",
          entityType: "contact_business_link_candidate_batch",
          details: {
            requested: parsed.data.decisions.length,
            applied: outcomes.filter(item => item.status === "applied").length,
            rejected: outcomes.filter(item => item.status === "rejected").length,
          },
        });
        res.status(207).json({
          outcomes,
          applied: outcomes.filter(item => item.status === "applied").length,
          rejected: outcomes.filter(item => item.status === "rejected").length,
        });
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.get(
    "/api/admin/commercial-classification/counts",
    isDashboardUser,
    requireRole("admin", "manager"),
    async (_req, res) => {
      try {
        const { getContactClassCounts } = await import("../services/commercial-classification-authority");
        res.json({ counts: await getContactClassCounts() });
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.get(
    "/api/admin/commercial-classification/reconciliation/:aggregateType/:aggregateKey",
    isDashboardUser,
    requireRole("admin", "manager"),
    async (req, res) => {
      try {
        const { getReconciliationReport } = await import("../services/commercial-classification-authority");
        const report = await getReconciliationReport(
          String(req.params.aggregateType),
          String(req.params.aggregateKey),
        );
        if (!report) return res.status(404).json({ message: "No reconciliation lineage found." });
        res.json(report);
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.post(
    "/api/admin/commercial-classification/preview",
    isDashboardUser,
    requireRole("admin", "manager"),
    async (req, res) => {
      const parsed = z.object({
        idempotencyKey: z.string().uuid(),
        subjectType: commercialSubjectSchema,
        subjectId: z.number().int().positive(),
        targetClass: commercialClassSchema,
        evidenceFields: evidenceSchema,
        evidenceRefs: z.array(commercialEvidenceRefSchema).min(1).max(32),
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid classification preview", issues: parsed.error.flatten() });

      try {
        const { createPreviewCommand } = await import("../services/commercial-classification-authority");
        const actorId = String((req.user as any)?.id ?? "");
        const result = await createPreviewCommand({ ...parsed.data, requestedBy: actorId });
        res.status(result.status === "created" ? 201 : 200).json(result);
      } catch (err: any) {
        res.status(400).json({ message: err.message ?? "Unable to create classification preview." });
      }
    },
  );

  app.post(
    "/api/admin/commercial-classification/:commandId/approve",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      const parsed = z.object({ versionLock: z.number().int().nonnegative() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "versionLock must be a non-negative integer." });

      try {
        const { approveCommand } = await import("../services/commercial-classification-authority");
        const result = await approveCommand({
          commandId: String(req.params.commandId),
          approvedBy: String((req.user as any)?.id ?? ""),
          versionLock: parsed.data.versionLock,
        });
        if (result.conflict) return res.status(409).json({ message: "Command is stale or no longer awaiting approval." });
        res.json(result);
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  app.post(
    "/api/admin/commercial-classification/:commandId/execute",
    isDashboardUser,
    requireRole("admin"),
    async (req, res) => {
      try {
        const { executeApprovedCommand } = await import("../services/commercial-classification-authority");
        const result = await executeApprovedCommand(String(req.params.commandId), String((req.user as any)?.id ?? ""));
        if (!result.executed) return res.status(409).json(result);
        res.json(result);
      } catch (err) {
        serverError(res, err);
      }
    },
  );

  // BT-06: original purge implementation is intentionally unreachable and will
  // be removed in the next cleanup pass. The public handler above is the only
  // registered route and always returns 410.
  if (false) { void (async () => {
    const req = undefined as any;
    const res = undefined as any;
    const client = await pool.connect();
    try {
      // ── Identify targets (before transaction so we can bail early) ────────────
      const TEST_COND = `
        email ILIKE '%@test.invalid'
        OR email ILIKE '%@test.internal'
        OR email ILIKE '%@libertybancard.test'
        OR email ILIKE '%@example.test'
        OR email ILIKE 'wh-test-%'
        OR email ILIKE 'ghl-deal-test-%'
        OR email ILIKE 'qa-release-%'
        OR email ILIKE 'qa-appt-%'
        OR email ILIKE 'no-op-%'
        OR email ILIKE 'test-ca-%'
        OR first_name ILIKE 'WebhookTest%'
        OR first_name ILIKE 'testnle%'
        OR first_name ILIKE 'StmtTest%'
        OR first_name ILIKE 'StatementTest%'
        OR first_name ILIKE 'GoLive-Test%'
        OR (first_name = 'StmtTest' AND last_name = 'QAUser')
        OR (first_name = 'Test' AND last_name = 'Lead')
        OR (first_name = 'Test' AND last_name = 'Update')
        OR company_name ILIKE 'Test Co%'
        OR first_name ILIKE 'Golive Test%'
        OR first_name ILIKE 'Getstarted%'
        OR first_name ILIKE 'Stmttest%'
      `;

      const beforeResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM contacts WHERE ${TEST_COND}`
      );
      const beforeCount = Number(beforeResult.rows[0]?.count ?? 0);

      if (beforeCount === 0) {
        client.release();
        return res.json({ deleted: 0, message: "No test contacts found." });
      }

      // Materialise IDs once so we avoid re-evaluating correlated sub-queries mid-transaction
      const contactIdRows = await client.query<{ id: number }>(
        `SELECT id FROM contacts WHERE ${TEST_COND}`
      );
      const contactIds = contactIdRows.rows.map(r => r.id);
      // Build safe IN-list literals (all values are integer PKs from our own query)
      const cList = contactIds.join(",");
      const cIn = `(${cList})`;

      const dealIdRows = await client.query<{ id: number }>(
        `SELECT id FROM deals WHERE contact_id = ANY($1::int[])`,
        [contactIds]
      );
      const dealIds = dealIdRows.rows.map(r => r.id);
      // Use (0) when empty so IN-clause syntax stays valid
      const dIn = dealIds.length > 0 ? `(${dealIds.join(",")})` : "(0)";

      // ── Single transaction — any error rolls back everything ──────────────────
      await client.query("BEGIN");

      // Step 1: Grand-children of deals that have no ON DELETE CASCADE
      //         underwriting_conditions → underwriting_decisions (cascade would handle it, but
      //         uw_decisions itself has no cascade from deals so we must clear it explicitly)
      await client.query(`DELETE FROM underwriting_conditions WHERE deal_id IN ${dIn}`);

      // Step 2: ticket_comments → tickets (ticket_comments.ticket_id has no ON DELETE CASCADE)
      await client.query(
        `DELETE FROM ticket_comments
         WHERE ticket_id IN (SELECT id FROM tickets WHERE contact_id IN ${cIn})`
      );

      // Step 3: Deal children with no ON DELETE (would block deal delete)
      await client.query(`DELETE FROM merchant_onboarding_stages WHERE deal_id IN ${dIn}`);
      await client.query(`DELETE FROM equipment_shipments    WHERE deal_id IN ${dIn}`);

      // Step 3b: Null out nullable deal FKs that have no ON DELETE (would block deal delete)
      await client.query(`UPDATE residual_import_rows SET matched_deal_id = NULL WHERE matched_deal_id IN ${dIn}`);
      await client.query(`UPDATE merchant_referrals    SET referred_deal_id = NULL WHERE referred_deal_id IN ${dIn}`);

      // Step 4: Remaining deal-level children (many cascade, but explicit is safer in a txn)
      const dealChildTables = [
        "statement_proposals", "statement_requests", "co_branded_proposals",
        "equipment_orders", "ghl_activity_log", "calendar_events", "call_logs",
        "chargebacks", "email_logs", "health_alerts", "merchant_applications",
        "merchant_profiles", "merchant_residuals", "mid_daily_stats", "nps_responses",
        "onboarding_checklist_items", "onboarding_steps", "rate_review_requests",
        "referrals", "residual_import_rows", "review_requests", "rfis",
        "sequence_enrollments", "tasks", "testimonial_submissions",
        "underwriting_decisions", "agent_merchants", "deal_competitors",
        "communication_events", "save_cases",
      ];
      for (const tbl of dealChildTables) {
        await client.query(`DELETE FROM ${tbl} WHERE deal_id IN ${dIn}`);
      }

      // Step 5a: document_access_log.document_id has no ON DELETE — delete before documents
      await client.query(
        `DELETE FROM document_access_log
         WHERE document_id IN (SELECT id FROM documents WHERE deal_id IN ${dIn})`
      );
      // Also cover documents that will be deleted via contact_id below
      await client.query(
        `DELETE FROM document_access_log
         WHERE document_id IN (SELECT id FROM documents WHERE contact_id IN ${cIn})`
      );

      // Step 5b: Null out nullable deal FK on documents (don't delete documents themselves)
      await client.query(`UPDATE documents SET deal_id = NULL WHERE deal_id IN ${dIn}`);

      // Step 6: Delete the deals
      await client.query(`DELETE FROM deals WHERE id IN ${dIn}`);

      // Step 6b: Null out nullable contact FKs that have no ON DELETE
      await client.query(`UPDATE prospects SET conversion_contact_id = NULL WHERE conversion_contact_id IN ${cIn}`);

      // Step 7: Break circular FKs on contacts before removing children
      await client.query(`UPDATE contacts SET primary_source_event_id = NULL WHERE id IN ${cIn}`);
      await client.query(`UPDATE contacts SET parent_contact_id      = NULL WHERE parent_contact_id IN ${cIn}`);

      // Step 8: Contact-level children (ordered to respect remaining FK chains)
      const contactChildPairs: [string, string][] = [
        ["ghl_activity_log",            "contact_id"],
        ["outbound_messages",           "contact_id"],
        ["outbound_send_log",           "contact_id"],
        ["email_logs",                  "contact_id"],
        ["call_logs",                   "contact_id"],
        ["calendar_events",             "contact_id"],
        ["inbox_items",                 "contact_id"],
        ["live_chats",                  "contact_id"],
        ["consent_audit_logs",          "contact_id"],
        ["contact_ai_cache",            "contact_id"],
        ["contact_source_events",       "contact_id"],
        ["contact_lead_scoring_jobs",   "contact_id"],
        ["enrichment_runs",             "contact_id"],
        ["sdr_lead_state",              "contact_id"],
        ["sdr_lead_events",             "contact_id"],
        ["sdr_channel_attempts",        "contact_id"],
        ["sdr_compliance_state",        "contact_id"],
        ["sync_conflicts",              "contact_id"],
        ["health_alerts",               "contact_id"],
        ["lead_sources",                "contact_id"],
        ["analytics_events",            "contact_id"],
        ["contact_companies",           "contact_id"],
        ["nps_responses",               "contact_id"],
        ["testimonial_submissions",     "contact_id"],
        ["review_requests",             "contact_id"],
        ["rate_review_requests",        "contact_id"],
        ["rfis",                        "contact_id"],
        ["chargebacks",                 "contact_id"],
        ["equipment_orders",            "contact_id"],
        ["equipment_shipments",         "contact_id"],
        ["promotional_enrollment_jobs", "contact_id"],
        ["merchant_health_scores",      "contact_id"],
        ["merchant_residuals",          "contact_id"],
        ["merchant_applications",       "contact_id"],
        ["merchant_profiles",           "contact_id"],
        ["merchant_referrals",          "referred_contact_id"],
        ["co_branded_proposals",        "contact_id"],
        ["referrals",                   "contact_id"],
        ["ma_events",                   "counterparty_contact_id"],
        ["prospects",                   "contact_id"],
        ["documents",                   "contact_id"],
        ["statement_proposals",         "contact_id"],
        ["statement_requests",          "contact_id"],
        ["statement_reviews",           "contact_id"],
        ["sequence_enrollments",        "contact_id"],
        ["tasks",                       "contact_id"],
        ["tickets",                     "contact_id"],
        ["communication_events",        "contact_id"],
        ["save_cases",                  "contact_id"],
        ["ai_decision_log",             "contact_id"],
      ];
      for (const [tbl, col] of contactChildPairs) {
        await client.query(`DELETE FROM ${tbl} WHERE ${col} IN ${cIn}`);
      }

      // Step 9: Delete the contacts
      const deleteResult = await client.query<{ id: number }>(
        `DELETE FROM contacts WHERE id IN ${cIn} RETURNING id`
      );
      const deleted = deleteResult.rowCount ?? deleteResult.rows.length;

      await client.query("COMMIT");
      client.release();

      // Audit log (fire-and-forget, outside the now-committed transaction)
      auditChange({
        actorType: "user",
        userId: (req.user as any)?.id ?? null,
        action: "admin_purge_test_contacts",
        entityType: "contacts",
        entityKey: "bulk",
        before: { count: beforeCount },
        after: { deleted },
      }).catch((e: Error) => console.error("[PurgeTest] Audit log failed:", e.message));

      // Legacy route body intentionally unreachable.
    } catch {
      client.release();
    }
  })(); }

  // === SERPER USAGE LOG BREAKDOWN (Task #2003) ===
  // Aggregates serper_call_log by day and by call site so admins can see
  // where credits went and the success rate, unlike serper_control's single
  // aggregate counter for the current billing window.
  app.get("/api/admin/serper/usage-log", isDashboardUser, requireRole('admin'), async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "10"), 10) || 10));

      const byDay = (await pool.query(
        `SELECT date_trunc('day', created_at) AS day,
                count(*) FILTER (WHERE outcome = 'success') AS successes,
                count(*) FILTER (WHERE outcome = 'provider_error') AS provider_errors,
                count(*) FILTER (WHERE outcome = 'blocked') AS blocked,
                count(*) AS total
           FROM serper_call_log
          WHERE created_at >= now() - ($1 || ' days')::interval
          GROUP BY 1
          ORDER BY 1 DESC`,
        [days],
      )).rows;

      const byCallSite = (await pool.query(
        `SELECT call_site,
                count(*) FILTER (WHERE outcome = 'success') AS successes,
                count(*) FILTER (WHERE outcome = 'provider_error') AS provider_errors,
                count(*) FILTER (WHERE outcome = 'blocked') AS blocked,
                count(*) AS total
           FROM serper_call_log
          WHERE created_at >= now() - ($1 || ' days')::interval
          GROUP BY 1
          ORDER BY total DESC`,
        [days],
      )).rows;

      const byBlockReason = (await pool.query(
        `SELECT block_reason, count(*) AS total
           FROM serper_call_log
          WHERE created_at >= now() - ($1 || ' days')::interval AND outcome = 'blocked'
          GROUP BY 1
          ORDER BY total DESC`,
        [days],
      )).rows;

      res.json({ days, byDay, byCallSite, byBlockReason });
    } catch (err: any) {
      if (/relation "serper_call_log" does not exist/i.test(err?.message ?? "")) {
        return res.status(404).json({ message: "serper_call_log table missing — run migrations", byDay: [], byCallSite: [], byBlockReason: [] });
      }
      serverError(res, err);
    }
  });

  // === SERPER GATEWAY CONTROL (#1600) ===
  app.get("/api/admin/serper/control", isDashboardUser, requireRole('admin'), async (_req, res) => {
    try {
      const { serperGateway } = await import("../services/serper-gateway");
      const control = await serperGateway.getControl();
      if (!control) return res.status(404).json({ message: "serper_control row missing — run migrations" });
      res.json({ control, policyVersion: control.policy_version });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Corrective addition (Liberty Bancard enrichment completion, continuation
  // — item 1): every other paid provider (zerobounce, outscraper, openai,
  // apollo) has a dedicated enable/pause PUT route via
  // /api/admin/provider-controls/:provider; Serper had none — its only
  // toggle was the blanket ladder-wide emergency stop. Adds parity using the
  // gateway's own atomic setEnabled(), which already mirrors into
  // provider_controls in the same transaction (Gate 2 reconciliation).
  app.put("/api/admin/serper/control", isDashboardUser, requireRole('admin'), async (req, res) => {
    try {
      const { enabled } = req.body as { enabled?: unknown };
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }
      const { serperGateway } = await import("../services/serper-gateway");
      const correlationId = `admin-toggle:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const row = await serperGateway.setEnabled(enabled, {
        actorId: (req.user as any)?.id ?? null,
        reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "admin_toggle",
        correlationId,
      });
      await storage.createAuditLog({
        action: "provider_control_updated", entityType: "provider_control",
        userId: (req.user as any)?.id ?? null,
        details: { provider: "serper", enabled, correlationId },
      });
      res.json({ control: row });
    } catch (err: any) {
      if (/serper_control row missing/i.test(err?.message ?? "")) {
        return res.status(404).json({ message: err.message });
      }
      serverError(res, err);
    }
  });

  // Corrective addition (SFP enrichment repair, continuation): the SFP paid
  // pipeline's readiness gate (getSfpProviderReadiness) checks
  // provider_controls.local_budget_units, but the ONLY writer that ever
  // raises it is the bounded SFP "arm pilot" route (a few units at a time).
  // serper_control.local_budget — the real gateway ceiling that actually
  // gates every live Serper call — can be raised independently (e.g. by an
  // earlier ops action) and drift far ahead of the stale
  // provider_controls mirror, leaving the SFP pipeline reporting
  // provider_budget_exhausted against a gateway that has ample real
  // headroom. This route resyncs the mirror to the authoritative gateway
  // ceiling. Never lowers it (GREATEST), matching the same
  // never-shrink-the-real-ceiling contract as the SFP arm-pilot route.
  app.post("/api/admin/serper/resync-budget-mirror", isDashboardUser, requireRole('admin'), async (req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        const gateway = ((await tx.execute(sql`
          SELECT local_budget FROM serper_control WHERE id = 1 FOR UPDATE
        `)) as any).rows?.[0];
        if (!gateway) throw new Error("serper_control row missing — run migrations");
        const control = ((await tx.execute(sql`
          SELECT local_budget_units FROM provider_controls WHERE provider='serper' FOR UPDATE
        `)) as any).rows?.[0];
        const before = control?.local_budget_units ?? null;
        const updated = ((await tx.execute(sql`
          INSERT INTO provider_controls (provider, capability, enabled, circuit_state, local_budget_units)
          VALUES ('serper', 'business_identity_discovery', TRUE, 'closed', ${Number(gateway.local_budget)})
          ON CONFLICT (provider) DO UPDATE
            SET local_budget_units = GREATEST(COALESCE(provider_controls.local_budget_units, 0), ${Number(gateway.local_budget)}),
                version = provider_controls.version + 1, updated_at = NOW()
          RETURNING provider, enabled, circuit_state, local_budget_units, reserved_units, consumed_units, version
        `)) as any).rows?.[0];
        return { before, after: updated };
      });
      await storage.createAuditLog({
        action: "provider_control_updated", entityType: "provider_control",
        userId: (req.user as any)?.id ?? null,
        details: {
          provider: "serper", operation: "resync_budget_mirror_to_gateway_ceiling",
          localBudgetUnitsBefore: result.before, localBudgetUnitsAfter: result.after.local_budget_units,
        },
      });
      res.json({ control: result.after, localBudgetUnitsBefore: result.before });
    } catch (err: any) {
      if (/serper_control row missing/i.test(err?.message ?? "")) {
        return res.status(404).json({ message: err.message });
      }
      serverError(res, err);
    }
  });

  // Unlabeled-discovery request allowance: the per-request credit maximum the operator attests, the
  // per-run request limit and optional daily limits. Without a fully valid enabled value the scope
  // stays closed. The route validates with the same parser the runtime uses, so an accepted value is
  // exactly what the scope will enforce.
  app.get("/api/admin/serper/unlabeled-discovery-gate", isDashboardUser, requireRole('admin'), async (_req, res) => {
    try {
      const { readUnlabeledDiscoveryGate, readUnlabeledDiscoveryLedgerUsage } = await import("../services/cro03/sfp-serper-allowance");
      res.json({ gate: await readUnlabeledDiscoveryGate(), ledgerLast24h: await readUnlabeledDiscoveryLedgerUsage() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/admin/serper/unlabeled-discovery-gate", isDashboardUser, requireRole('admin'), async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      if (!reason) return res.status(400).json({ message: "reason is required" });
      const { parseUnlabeledDiscoveryGate, UNLABELED_DISCOVERY_SETTING_KEY } = await import("../services/cro03/sfp-serper-allowance");
      let value: Record<string, unknown>;
      if (body.enabled === false) {
        value = { enabled: false };
      } else {
        value = { enabled: true, perRunRequests: body.perRunRequests, maxCreditsPerRequest: body.maxCreditsPerRequest };
        if (body.dailyRequests !== undefined && body.dailyRequests !== null) value.dailyRequests = body.dailyRequests;
        if (body.dailyCredits !== undefined && body.dailyCredits !== null) value.dailyCredits = body.dailyCredits;
        if (!parseUnlabeledDiscoveryGate(value).enabled) {
          return res.status(400).json({
            message: "perRunRequests and maxCreditsPerRequest must be positive integers; a daily limit, when given, must be a positive integer and dailyCredits must be at least maxCreditsPerRequest",
          });
        }
      }
      const before = ((await db.execute(sql`SELECT value FROM system_settings WHERE key=${UNLABELED_DISCOVERY_SETTING_KEY}`)) as any).rows?.[0]?.value ?? null;
      await db.execute(sql`INSERT INTO system_settings (key,value,updated_at) VALUES (${UNLABELED_DISCOVERY_SETTING_KEY},${JSON.stringify(value)}::jsonb,NOW())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`);
      await storage.createAuditLog({
        action: "serper_unlabeled_discovery_gate_updated", entityType: "system_setting",
        userId: (req.user as any)?.id ?? null,
        details: { before, after: value, reason },
      });
      res.json({ gate: parseUnlabeledDiscoveryGate(value), stored: value });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/admin/serper/recovery", isDashboardUser, requireRole('admin'), async (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) return res.status(400).json({ message: "reason is required" });

      const actorId = (req.user as any)?.id ?? null;
      const correlationId = `serper-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const { serperGateway } = await import("../services/serper-gateway");

      const before = await serperGateway.getControl();
      if (!before) return res.status(404).json({ message: "serper_control row missing — run migrations" });

      // Audit first — the recovery attempt itself must be traceable.
      await auditChange({
        actorType: "user",
        userId: actorId,
        action: "serper_manual_recovery",
        entityType: "serper_control",
        entityKey: "1",
        before: { state: before.state, reasonCode: before.reason_code },
        details: { reason, correlationId },
      });

      // Atomically transition to half_open + clear the probe claim.
      await serperGateway.transitionToHalfOpenForRecovery();

      // Fire one bounded diagnostic probe. On failure the gateway's half-open
      // handling reopens the circuit automatically.
      const probe = await serperGateway.executeSearch("/search", { q: "test" }, "admin_recovery_probe");

      const committed = await serperGateway.getControl();
      res.json({
        control: committed,
        policyVersion: committed?.policy_version ?? null,
        probe: {
          ok: probe.ok,
          blocked: probe.blocked,
          blockReason: probe.blockReason ?? null,
          status: probe.status ?? null,
          error: probe.error ?? null,
        },
        correlationId,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === SERPER GATEWAY ADMIN CONTROLS (#1609 / #1601) ===

  app.patch("/api/admin/serper/enabled", isDashboardUser, requireRole('admin'), async (req, res) => {
    try {
      if (typeof req.body?.enabled !== "boolean") {
        return res.status(400).json({ message: "enabled (boolean) is required" });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) return res.status(400).json({ message: "reason is required" });

      const enabled = req.body.enabled as boolean;
      const actorId = (req.user as any)?.id ?? null;
      const correlationId = `serper-enabled-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const { serperGateway } = await import("../services/serper-gateway");

      const control = await serperGateway.setEnabled(enabled, { actorId, reason, correlationId });
      res.json({ control, correlationId });
    } catch (err: any) {
      if (/serper_control row missing/i.test(err?.message ?? "")) {
        return res.status(404).json({ message: "serper_control row missing — run migrations" });
      }
      serverError(res, err);
    }
  });

  app.post("/api/admin/serper/reset-window", isDashboardUser, requireRole('admin'), async (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) return res.status(400).json({ message: "reason is required" });
      const expectedRaw = req.body?.expectedWindowStartedAt;
      const expected = typeof expectedRaw === "string" ? new Date(expectedRaw) : null;
      if (!expected || isNaN(expected.getTime())) {
        return res.status(400).json({ message: "expectedWindowStartedAt (ISO timestamp) is required" });
      }

      const actorId = (req.user as any)?.id ?? null;
      const correlationId = `serper-reset-window-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const { serperGateway } = await import("../services/serper-gateway");

      const control = await serperGateway.resetWindow(expected, { actorId, reason, correlationId });
      if (!control) {
        return res.status(409).json({ message: "Window reset rejected — windowStartedAt has changed. Refresh and retry." });
      }
      res.json({ control, correlationId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GHL INVALID-CONTACT SURFACE (#1609 / #1605) ===

  app.get("/api/admin/ghl/invalid-contacts", isDashboardUser, requireRole('admin'), async (req, res) => {
    try {
      const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
      const offsetRaw = parseInt(String(req.query.offset ?? "0"), 10);
      const limit = Math.min(Math.max(isNaN(limitRaw) ? 100 : limitRaw, 1), 500);
      const offset = Math.max(isNaN(offsetRaw) ? 0 : offsetRaw, 0);
      const status = ["unresolved", "resolved", "all"].includes(String(req.query.status ?? ""))
        ? String(req.query.status)
        : "unresolved";

      const { listInvalidGhlContacts } = await import("../services/ghl-invalid-contacts");
      const result = await listInvalidGhlContacts({ status: status as any, limit, offset });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === SERPER ZERO-YIELD COOLDOWN: manual requeue (#1599) ===
  app.post("/api/admin/sdr/merchants/:id/requeue-serper", isDashboardUser, requireRole('admin', 'manager'), async (req, res) => {
    try {
      const merchantId = Number(String(req.params.id));
      if (!Number.isInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ message: "Invalid merchant id" });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) return res.status(400).json({ message: "reason is required" });

      const actorId = (req.user as any)?.id ?? null;
      const correlationId = `serper-requeue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const { requeueSerperForMerchant } = await import("../services/sdr/serper-enrichment");
      const result = await requeueSerperForMerchant(merchantId);
      if (!result.ok) {
        if (result.reason === "merchant_not_found") {
          return res.status(404).json({ message: "Merchant not found" });
        }
        // Global Serper authority gate is disabled/open — refuse to requeue.
        return res.status(409).json({
          message: `Serper authority gate blocks requeue (${result.reason}). Enable/recover the gateway first.`,
          reason: result.reason,
        });
      }

      await auditChange({
        actorType: "user",
        userId: actorId,
        action: "serper_manual_requeue",
        entityType: "sdr_merchant",
        entityKey: String(merchantId),
        details: { reason, correlationId, merchantId, timestamp: new Date().toISOString() },
      });

      res.json({ success: true, merchantId, correlationId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── Enrichment Activation Status ───────────────────────────────────────────
  // Returns the live state of all 9 enrichment subsystems so the Enrichment
  // Activation Panel can show operators exactly what is and isn't running.
  app.get("/api/admin/enrichment/activation-status", requireRole("admin"), async (_req, res) => {
    try {
      const { featureFlags } = await import("../services/feature-flags");
      const { db } = await import("../db");
      const { sql } = await import("drizzle-orm");

      // 1. Sunbiz enrichment flag (env-only)
      const sunbizEnrichmentEnabled = featureFlags.SUNBIZ_ENRICHMENT_ENABLED;
      // 2. Orchestrator flag
      const orchestratorEnabled = featureFlags.ORCHESTRATOR_ENABLED;
      // 3. Legacy outreach (sequences / outbound)
      const legacyOutreachEnabled = featureFlags.LEGACY_OUTREACH_ENABLED;
      // 4. CRO-03 provider transport — reads runtime env, consistent with assertCro03cAuthorityBeforeIo gate
      const cro03TransportEnabled = process.env.CRO03_PROVIDER_TRANSPORT_ENABLED === "true";

      // Shared defensive timeout so no single query can stall the entire response.
      function withActivationTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
        return Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), 8_000))]);
      }

      // 5. Serper gateway status
      let serperGatewayEnabled = false;
      let serperGatewayStatus = "unknown";
      try {
        const sgRow = (await withActivationTimeout(db.execute(sql`
          SELECT enabled, state FROM serper_control ORDER BY id DESC LIMIT 1
        `), null))?.rows[0] as any;
        if (sgRow) {
          serperGatewayEnabled = Boolean(sgRow.enabled);
          serperGatewayStatus = sgRow.state ?? "unknown";
        }
      } catch { /* no serper_control table yet */ }

      // 6. ZeroBounce status
      const zbConfigured = Boolean(process.env.ZEROBOUNCE_API_KEY || process.env.ZEROBOUNCE_APi_KEY);

      // 7. Vertical resolver wiring — check by counting sunbiz-auto contacts with a non-null vertical
      let verticalWired = false;
      try {
        const vr = (await withActivationTimeout(db.execute(sql`
          SELECT COUNT(*) AS c FROM contacts WHERE 'sunbiz-auto' = ANY(tags) AND vertical IS NOT NULL LIMIT 1
        `), null))?.rows[0] as any;
        verticalWired = Number(vr?.c ?? 0) > 0;
      } catch { /* ignore */ }

      // 8. Auto-convert — counts sunbiz prospects promoted in last 7 days
      let autoConvertActive = false;
      let recentlyPromoted = 0;
      try {
        const ac = (await withActivationTimeout(db.execute(sql`
          SELECT COUNT(*) AS c FROM audit_logs
          WHERE action = 'prospect_auto_promoted'
            AND created_at >= NOW() - INTERVAL '7 days'
        `), null))?.rows[0] as any;
        recentlyPromoted = Number(ac?.c ?? 0);
        autoConvertActive = recentlyPromoted > 0;
      } catch { /* ignore */ }

      // 9. Classification — counts sunbiz-auto contacts that reached 'production'
      let classificationActive = false;
      let productionClassifiedCount = 0;
      try {
        const cc = (await withActivationTimeout(db.execute(sql`
          SELECT COUNT(*) AS c FROM contacts
          WHERE 'sunbiz-auto' = ANY(tags) AND record_class = 'production'
        `), null))?.rows[0] as any;
        productionClassifiedCount = Number(cc?.c ?? 0);
        classificationActive = productionClassifiedCount > 0;
      } catch { /* ignore */ }

      // 10. Existing-contact backlog enrichment (task #1943) — active only when
      // Serper is configured AND the gateway's own kill switch is on, since
      // that is the actual gate the recurring queue-manager tick checks.
      let contactBacklogRemaining = 0;
      let contactBacklogActive = false;
      try {
        const { getEnrichmentBacklogCount } = await import("../services/enrichment");
        contactBacklogRemaining = await withActivationTimeout(getEnrichmentBacklogCount(), 0);
        // "Active" requires the gateway to be enabled AND its circuit not open —
        // an open circuit blocks every provider call, so reporting active from
        // enabled alone would mislead admins into thinking the backlog is draining.
        contactBacklogActive = Boolean(process.env.SERPER_API_KEY) && serperGatewayEnabled && serperGatewayStatus !== "open";
      } catch { /* ignore */ }

      // 11. Canary — check if a canary run has completed recently
      let canaryCompleted = false;
      let lastCanaryAt: string | null = null;
      try {
        const cr = (await withActivationTimeout(db.execute(sql`
          SELECT created_at FROM audit_logs
          WHERE action = 'sunbiz_enrichment_canary_completed'
          ORDER BY created_at DESC LIMIT 1
        `), null))?.rows[0] as any;
        if (cr?.created_at) {
          canaryCompleted = true;
          lastCanaryAt = cr.created_at instanceof Date
            ? cr.created_at.toISOString()
            : String(cr.created_at);
        }
      } catch { /* ignore */ }

      res.json({
        subsystems: [
          {
            key: "sunbiz_enrichment_enabled",
            label: "SUNBIZ_ENRICHMENT_ENABLED",
            status: sunbizEnrichmentEnabled ? "active" : "inactive",
            detail: sunbizEnrichmentEnabled
              ? "Flag is ON — Sunbiz auto-convert will run each enrichment tick"
              : "Flag is OFF — set SUNBIZ_ENRICHMENT_ENABLED=true to activate",
          },
          {
            key: "orchestrator_enabled",
            label: "ORCHESTRATOR_ENABLED",
            status: orchestratorEnabled ? "active" : "inactive",
            detail: orchestratorEnabled
              ? "Orchestrator is running"
              : "Orchestrator is off — set ORCHESTRATOR_ENABLED=true via wizard",
          },
          {
            key: "legacy_outreach_enabled",
            label: "LEGACY_OUTREACH_ENABLED",
            status: legacyOutreachEnabled ? "active" : "inactive",
            detail: legacyOutreachEnabled
              ? "Outreach engine is on"
              : "Outreach engine is off (Sunbiz auto-convert is now independent of this flag)",
          },
          {
            key: "cro03_transport",
            label: "CRO-03 Provider Transport",
            status: cro03TransportEnabled ? "active" : "inactive",
            detail: cro03TransportEnabled
              ? "Live transport enabled — Serper/Apollo/Outscraper calls are live"
              : "Transport disabled — all non-ZeroBounce providers return disabled outcome",
          },
          {
            key: "serper_gateway",
            label: "Serper Gateway",
            status: serperGatewayEnabled ? "active" : "inactive",
            detail: `Gateway status: ${serperGatewayStatus}`,
          },
          {
            key: "zerobounce",
            label: "ZeroBounce",
            status: zbConfigured ? "active" : "inactive",
            detail: zbConfigured
              ? "API key configured — ZeroBounce validation runs independently of transport gate"
              : "No ZeroBounce API key — email validation will be skipped",
          },
          {
            key: "vertical_resolver",
            label: "Canonical Vertical Resolver",
            status: verticalWired ? "active" : "pending",
            detail: verticalWired
              ? "Sunbiz contacts have vertical data — resolver is wired"
              : "No sunbiz-auto contacts with vertical yet — resolver wiring unverified",
          },
          {
            key: "auto_convert",
            label: "Sunbiz Auto-Convert",
            status: autoConvertActive ? "active" : "pending",
            detail: `${recentlyPromoted} prospects promoted in the last 7 days`,
          },
          {
            key: "classification",
            label: "Production Classification",
            status: classificationActive ? "active" : "pending",
            detail: `${productionClassifiedCount} sunbiz-auto contacts classified as production`,
          },
          {
            key: "contact_backlog_enrichment",
            label: "Existing-Contact Backlog Enrichment",
            status: contactBacklogActive ? "active" : "inactive",
            detail: contactBacklogActive
              ? `Recurring tick is live — ${contactBacklogRemaining} contacts still missing email/phone/website`
              : `Recurring tick is idle (Serper key missing, gateway disabled, or circuit ${serperGatewayStatus}) — ${contactBacklogRemaining} contacts waiting`,
          },
        ],
        canary: {
          completed: canaryCompleted,
          lastCompletedAt: lastCanaryAt,
        },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── Enrichment Canary ───────────────────────────────────────────────────────
  // Selects exactly 20 enriched Sunbiz entities by ID, then runs each one
  // through the explicit bounded pipeline (convert → promote → AWAIT classify).
  // The canary does NOT invoke the generic cron which has its own caps;
  // instead it processes only the selected candidates and awaits classification
  // before reporting — giving a reliable pass/fail signal.
  app.post("/api/admin/enrichment/canary", requireRole("admin"), async (_req, res) => {
    try {
      const { db } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const { storage } = await import("../storage");
      const { featureFlags } = await import("../services/feature-flags");

      if (!featureFlags.SUNBIZ_ENRICHMENT_ENABLED) {
        return res.status(409).json({
          code: "SUNBIZ_ENRICHMENT_DISABLED",
          message: "SUNBIZ_ENRICHMENT_ENABLED must be true to run the canary. Set the env var and restart.",
        });
      }

      const CANARY_SIZE = 20;

      // Select a wider pool than CANARY_SIZE to account for quality-gate filtering
      // that only happens after entity→prospect conversion (qualificationScore is on the
      // prospect, not the entity). The selection matches the requirements that CAN be
      // verified from the entity table: hot OR warm, both email AND phone, company name.
      // Warm entities still need qualificationScore A/B on the prospect to promote —
      // that check happens inside runSunbizCanaryForEntityIds after conversion.
      const POOL_SIZE = CANARY_SIZE * 5; // 100 — wide enough to yield ≥20 qualifying
      const candidateRows = (await db.execute(sql`
        SELECT id, entity_name
        FROM sunbiz_entities
        WHERE enrichment_status = 'enriched'
          AND entity_name IS NOT NULL
          AND (email IS NOT NULL OR owner_email IS NOT NULL)
          AND (phone IS NOT NULL OR owner_phone IS NOT NULL)
          AND (score = 'hot' OR score = 'warm')
        ORDER BY score DESC, updated_at DESC
        LIMIT ${POOL_SIZE}
      `)).rows as Array<{ id: number | string; entity_name: string | null }>;

      if (candidateRows.length === 0) {
        return res.status(409).json({
          code: "NO_CANARY_CANDIDATES",
          message: "No enriched hot/warm Sunbiz entities with both email and phone available. Run enrichment first.",
        });
      }

      const entityIds = candidateRows.map(r => Number(r.id));

      // Run the bounded pipeline. The helper stops after exactly CANARY_SIZE
      // verified-successful promotions (production-classified + canonical vertical set),
      // so side effects are bounded regardless of pool size.
      const { runSunbizCanaryForEntityIds } = await import("../services/sunbiz-cron");
      const { results, verifiedSuccessCount } = await runSunbizCanaryForEntityIds(entityIds, CANARY_SIZE);

      const promoted = results.filter(r => r.outcome === "promoted").length;
      const classificationFailed = results.filter(r => r.outcome === "classification_failed").length;
      // Strict: count only newly-promoted contacts with recordClass=production AND canonical vertical
      const productionClassified = results.filter(
        r => r.outcome === "promoted" && r.recordClass === "production" && r.vertical
      ).length;
      const withVertical = results.filter(r => r.vertical).length;

      // Enforce the 20-record gate based on verified-successful records (strict definition)
      if (verifiedSuccessCount < CANARY_SIZE) {
        return res.status(409).json({
          code: "INSUFFICIENT_VERIFIED_RECORDS",
          message: `Canary requires ${CANARY_SIZE} newly-promoted contacts with record_class=production and canonical vertical; only ${verifiedSuccessCount} passed from the ${entityIds.length}-entity pool. Build up the hot/warm A/B pool and retry.`,
          evaluated: entityIds.length,
          verifiedSuccessCount,
          required: CANARY_SIZE,
          results,
        });
      }

      await storage.createAuditLog({
        action: "sunbiz_enrichment_canary_completed",
        entityType: "system",
        actorType: "system",
        details: {
          candidateCount: entityIds.length,
          promoted,
          productionClassified,
          classificationFailed,
          verifiedSuccessCount,
          withVertical,
          canaryResults: results.map(r => ({
            entityId: r.entityId,
            outcome: r.outcome,
            recordClass: r.recordClass,
            vertical: r.vertical,
          })),
        },
      });

      const recommendation = classificationFailed > 0
        ? `${classificationFailed}/${promoted} contacts failed classification. Check classification authority logs before enabling CRO-03 transport.`
        : `Canary passed — ${verifiedSuccessCount}/${CANARY_SIZE} contacts are production-classified with canonical vertical. Safe to proceed to Phase 3 after review.`;

      res.json({
        candidateCount: entityIds.length,
        promoted,
        productionClassified,
        classificationFailed,
        verifiedSuccessCount,
        withVertical,
        results,
        recommendation,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── MI-09: Outbound pause state (read-only) ──────────────────────────────
  // Canonical pause state for the ceremony script and any read-only consumer
  // that needs the current pause epoch without writing to the pause ledger.
  app.get("/api/admin/pause-state", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getPauseState } = await import("../services/outbound-pause-authority");
      const state = await getPauseState();
      res.json({
        paused: state.state !== "unpaused",
        state:  state.state,
        epoch:  Number(state.epoch),
        reason: state.reason,
        committedAt: state.committedAt,
        source: state.source,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // 2026-09-13: the CRO-08A certification-receipt routes (POST and GET
  // .../typed-confirmation) were removed at the operator's request — schedule
  // activation now only requires the MI-09 pilot ladder plus the existing $50
  // aggregate spend cap. See server/services/cro08a/schedule-authority.ts.

  // GET /api/admin/cro08a/schedule-definitions — list schedule definitions.
  app.get("/api/admin/cro08a/schedule-definitions", requireRole("admin"), async (_req, res) => {
    try {
      const { db } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const rows = (r: any) => r?.rows ?? r ?? [];
      res.json(rows(await db.execute(sql`
        SELECT id, logical_key, definition_version, active, purpose, cadence_cron, window_seconds,
               batch_size, concurrency_limit, budgets, activated_by, activation_reason,
               activation_expires_at, certification_receipt_id, created_at, updated_at
        FROM cro08a_schedule_definitions ORDER BY logical_key, definition_version DESC
      `)));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // POST /api/admin/cro08a/schedule-definitions — create immutable definition.
  app.post("/api/admin/cro08a/schedule-definitions", requireRole("admin"), async (req, res) => {
    try {
      const { createCro08aScheduleDefinition } = await import("../services/cro08a/schedule-authority");
      const result = await createCro08aScheduleDefinition({ ...req.body, createdBy: (req as any).user?.email ?? "admin" });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // POST /api/admin/cro08a/schedule-definitions/:id/activate — activate (requires pilot ladder + spend cap only; no certification receipt).
  app.post("/api/admin/cro08a/schedule-definitions/:id/activate", requireRole("admin"), async (req, res) => {
    try {
      const { activateCro08aScheduleDefinition } = await import("../services/cro08a/schedule-authority");
      const result = await activateCro08aScheduleDefinition({
        definitionId: String(req.params.id),
        activatedBy: (req as any).user?.email ?? "admin",
        reason: req.body?.reason ?? "operator-activation",
        expiresAt: req.body?.expiresAt ? new Date(req.body.expiresAt) : undefined,
      });
      res.json(result);
    } catch (err: any) {
      if (String(err?.message).startsWith("CRO08A_CERTIFICATION_DENIED:")) {
        return res.status(403).json({ error: err.message });
      }
      serverError(res, err);
    }
  });

  // POST /api/admin/cro08a/schedule-definitions/:id/deactivate — deactivate via authority.
  app.post("/api/admin/cro08a/schedule-definitions/:id/deactivate", requireRole("admin"), async (req, res) => {
    try {
      const { deactivateCro08aScheduleDefinition } = await import("../services/cro08a/schedule-authority");
      await deactivateCro08aScheduleDefinition(String(req.params.id));
      res.json({ deactivated: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

}
