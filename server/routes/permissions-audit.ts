import type { Express, Request, Response } from "express";
import { requireRole, isDashboardUser } from "../replit_integrations/auth";
import { storage } from "../storage";
import { db } from "../db";
import { users } from "@shared/schema";
import { desc } from "drizzle-orm";
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

  // Generic dashboard KPI stats — thin alias of /api/kpi/summary computation
  // so the dashboard can hit a single, predictable endpoint.
  app.get("/api/dashboard/stats", requireRole("admin", "manager", "agent"), async (_req, res) => {
    try {
      const [dealsR, ticketsR, contactsR] = await Promise.all([
        storage.getDeals({ limit: 500 }),
        storage.getTickets({ limit: 500 }),
        storage.getContacts({ limit: 500 }),
      ]);
      const deals = dealsR.data;
      const tickets = ticketsR.data;
      const contacts = contactsR.data;
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const salesDeals = deals.filter((d) => d.pipeline === "sales");
      const closedWon = salesDeals.filter(
        (d) => d.stage === "Closed Won" && d.closedAt && new Date(d.closedAt) >= thirtyDaysAgo
      );
      const openTickets = tickets.filter((t) => t.status !== "Resolved" && t.status !== "Closed");
      res.json({
        deals: {
          total: deals.length,
          activeSales: salesDeals.filter((d) => d.stage !== "Closed Won" && d.stage !== "Closed Lost").length,
          closedWon30d: closedWon.length,
        },
        contacts: { total: contacts.length },
        tickets: { open: openTickets.length },
      });
    } catch (err) {
      serverError(res, err);
    }
  });
}
