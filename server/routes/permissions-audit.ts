import type { Express, Request, Response } from "express";
import { requireRole, isDashboardUser } from "../replit_integrations/auth";
import { storage } from "../storage";
import { db } from "../db";
import { users, tickets } from "@shared/schema";
import { desc, count, notInArray } from "drizzle-orm";
import { readPipelineAnalytics } from "../services/revenue-read-authority";
import { serverError } from "../utils/server-error";
import { extractRouteInventory } from "../services/express-route-provenance";

export function registerPermissionsAuditRoutes(app: Express) {
  // Admin "permissions audit" — registration-bound inventory of every /api route with full mount
  // path, all methods and ordered inherited guard provenance. Inventory only: it never enforces.
  // An empty extraction is reported as unavailable (503), never as a successful empty census.
  app.get("/api/admin/route-permissions", requireRole("admin"), (_req: Request, res: Response) => {
    try {
      const inventory = extractRouteInventory(app);
      const routes = inventory.routes.filter((r) => r.path.startsWith("/api/"));
      if (inventory.status !== "ok" || routes.length === 0) {
        return res.status(503).json({
          status: "unavailable",
          message: inventory.reason ?? "No /api routes could be extracted from the registered application",
          unsupported: inventory.unsupported,
        });
      }
      res.json({
        status: "ok",
        routes,
        summary: {
          ...inventory.summary,
          total: routes.length,
          public: routes.filter((r) => r.access === "public").length,
          authenticated: routes.filter((r) => r.access === "authenticated").length,
          role: routes.filter((r) => r.access === "role").length,
          unknown: routes.filter((r) => r.access === "unknown").length,
        },
        unsupported: inventory.unsupported,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  // === Missing list endpoints surfaced by the API surface audit ===

  // Lightweight rep list for contact assignment dropdowns — dashboard users only.
  // Restricted to roles that represent internal reps (admin, manager, agent).
  // Merchant/portal accounts are excluded.
  app.get("/api/users/reps", isDashboardUser, async (_req, res) => {
    try {
      const { inArray: inArrayFn } = await import("drizzle-orm");
      const reps = await db.select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
      }).from(users)
        .where(inArrayFn(users.role, ["admin", "manager", "agent"]))
        .orderBy(users.firstName, users.lastName);
      res.json(reps);
    } catch (err) {
      serverError(res, err);
    }
  });

  // Admin user list (alias of /api/admin/users for callers using /api/users).
  app.get("/api/users", requireRole("admin"), async (_req, res) => {
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
        createdAt: users.createdAt,
      }).from(users).orderBy(desc(users.createdAt));
      res.json(allUsers);
    } catch (err) {
      serverError(res, err);
    }
  });

  // Paginated merchant index (admin or manager).
  app.get("/api/merchants", requireRole("admin", "manager"), async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const profiles = await storage.getMerchantProfiles();
      const total = profiles.length;
      const page = profiles.slice(offset, offset + limit);
      res.json({ data: page, total, limit, offset });
    } catch (err) {
      serverError(res, err);
    }
  });

  // Dashboard KPI stats. Every number is a whole-population count, and each field names its own population:
  //   deals and contacts: production, non-archived records (agents: owned or unassigned deals; contacts assigned to them, unassigned, or linked to their deals), open sales stages from OPEN_SALES_LEAD_STAGES;
  //   tickets: every ticket whose status is not Resolved or Closed. This is the same definition as /api/kpi/summary
  //   support.openTickets; tickets carry no archive or record-class predicate and are not role-scoped there either, so this
  //   route does not invent a second policy. The response states that rather than labelling the whole payload production.
  // The previous implementation counted the first 500 rows of each table and labelled them totals.
  app.get("/api/dashboard/stats", requireRole("admin", "manager", "agent"), async (req, res) => {
    try {
      const user = req.user as { email?: string | null; role?: string } | undefined;
      const [pipeline, contactsR, openTickets] = await Promise.all([
        readPipelineAnalytics(req.user as any),
        storage.getContacts({ limit: 1, recordClass: "production", ...(user?.role === "agent" ? { ownerEmail: user.email ?? "" } : {}) }),
        db.select({ n: count() }).from(tickets).where(notInArray(tickets.status, ["Resolved", "Closed"])),
      ]);
      const sales = pipeline.data.sales;
      res.json({
        deals: { total: sales.total + pipeline.data.onboarding.total, activeSales: sales.active, closedWon30d: sales.wonLast30Days },
        contacts: { total: contactsR.total },
        tickets: { open: openTickets[0]?.n ?? 0 },
        populations: {
          deals: { key: "production_non_archived_whole_population", label: "Production, non-archived deals (agents: deals they own or that are unassigned); active sales = open sales stages" },
          contacts: { key: "production_non_archived_whole_population", label: "Production, non-archived contacts (agents: contacts assigned to them, unassigned, or linked to a deal they own)" },
          tickets: { key: "all_open_tickets_not_role_scoped", label: "All tickets with a status other than Resolved or Closed; no archive, record-class or owner filter (same as /api/kpi/summary)" },
        },
        asOf: pipeline.metadata.asOf,
      });
    } catch (err) {
      serverError(res, err);
    }
  });
}
