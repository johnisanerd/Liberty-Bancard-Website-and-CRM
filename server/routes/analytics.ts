import { storedAmountNumericRawSql } from "../utils/amount-sql";
import type { Express } from "express";
import { readTaskMetrics, taskReadPredicate } from "../services/task-read-authority";
import { isAuthenticated, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { pool } from "../db";
import { contacts, toolClickEvents, OPEN_SALES_LEAD_STAGES } from "@shared/schema";
import { isGhlConfigured, sendGhlInternalNotification } from "../services/ghl";
import { buildWeeklyDigest } from "../services/digest-service";
import { db } from "../db";
import { agents, deals, leaderboardSettings, agentMerchants } from "@shared/schema";
import { eq, and, gte, lte, desc, sql, count, inArray, isNull } from "drizzle-orm";
import { publicLeadRateLimit } from "../middleware/public-rate-limit";
import { serverError } from "../utils/server-error";
import { readPipelineAnalytics, contactReadPredicate, dealReadPredicate } from "../services/revenue-read-authority";
// CRO-02 population observation runs as a scheduled BullMQ job (CRO02_OBSERVATION queue,
// every 2h in prod) and is NOT triggered from HTTP requests. Doing it per-request was
// the primary cause of db:pool_pressure: up to 2 000 per-subject graph-resolution queries
// at concurrency=8 ran on every analytics page load.

export function registerAnalyticsRoutes(app: Express, readOptions?: {
  leaderboardQuery?:(source:"callLogs"|"creatorEvents",query:string)=>Promise<{rows:any[]}>;
}) {

  // === SALES TOOL CLICK TRACKING ===
  app.post("/api/analytics/tool-click", publicLeadRateLimit, async (req, res) => {
    try {
      const { toolId, toolTitle, source, sessionId } = req.body;
      if (!toolId) return res.status(400).json({ message: "toolId is required" });
      const userId = (req.user as any)?.id?.toString() ?? null;
      await db.insert(toolClickEvents).values({
        toolId,
        toolTitle: toolTitle ?? null,
        source: source ?? "sales-tools-hub",
        userId,
        sessionId: sessionId ?? null,
      });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // === AGENT RESIDUAL TIER CONFIG ===
  // Served from the server so rates can be updated without redeploying the frontend.
  app.get("/api/agent-tiers", async (_req, res) => {
    res.json([
      { label: "Starter",  minAccounts: 1,  maxAccounts: 4,  residualBps: 25, bonusLabel: null },
      { label: "Silver",   minAccounts: 5,  maxAccounts: 14, residualBps: 35, bonusLabel: "Priority support" },
      { label: "Gold",     minAccounts: 15, maxAccounts: 29, residualBps: 45, bonusLabel: "Marketing materials" },
      { label: "Platinum", minAccounts: 30, maxAccounts: 59, residualBps: 55, bonusLabel: "Co-branded collateral + bonus" },
      { label: "Elite",    minAccounts: 60, maxAccounts: null, residualBps: 70, bonusLabel: "Dedicated account manager" },
    ]);
  });

  app.get("/api/analytics/tool-clicks", isDashboardUser, async (req, res) => {
    try {
      const rows = await db
        .select({
          toolId: toolClickEvents.toolId,
          toolTitle: toolClickEvents.toolTitle,
          clicks: count(toolClickEvents.id),
        })
        .from(toolClickEvents)
        .groupBy(toolClickEvents.toolId, toolClickEvents.toolTitle)
        .orderBy(desc(count(toolClickEvents.id)));
      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Upload attribution by utm_content — shows which agent-shared tool links drove statement uploads
  app.get("/api/analytics/tool-upload-attribution", isDashboardUser, async (req, res) => {
    try {
      const rows = await db
        .select({
          utmContent: contacts.utmContent,
          uploads: count(contacts.id),
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.utmSource, "agent"),
            eq(contacts.recordClass, "production"),
            sql`${contacts.utmContent} IS NOT NULL`
          )
        )
        .groupBy(contacts.utmContent)
        .orderBy(desc(count(contacts.id)));
      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === KPI DASHBOARD ===
  // Consolidated from 19 parallel pool.query() calls → 5 batched queries.
  // Each old query held a pool connection for 50-300 ms; 19 simultaneous connections
  // on a 40-connection pool left nothing for other concurrent dashboard requests.
  app.get("/api/kpi/summary", isDashboardUser, async (req, res) => {
    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000);
      const actor = req.user as any;
      const dealValues: unknown[] = [thirtyDaysAgo, sevenDaysAgo];
      const dealPredicate = dealReadPredicate(actor, {}, dealValues);
      const contactValues: unknown[] = [thirtyDaysAgo, sevenDaysAgo, now];
      const contactPredicate = contactReadPredicate(actor, { limit: 1, offset: 0, recordClass: "production" }, contactValues);
      const repValues: unknown[] = [];
      const repPredicate = dealReadPredicate(actor, {}, repValues);

      // Query 1 — all deal aggregates in one scan (was 7 separate queries)
      const [dealsAggRow, contactsAggRow, ticketsAggRow, tasksAggRow, topRepsRow] =
        await Promise.all([
          pool.query<{
            stage: string; pipeline: string; cnt: string;
            closed_won_30d: string; closed_lost_30d: string;
            new_leads_30d: string; new_leads_7d: string;
            total_volume: string; total_residual: string;
            total_profit: string; deal_count: string;
          }>(`
            SELECT
              stage,
              pipeline,
              COUNT(*)::text                                                                  AS cnt,
              COUNT(*) FILTER (WHERE pipeline='sales' AND stage='Closed Won'
                AND closed_at >= $1)::text                                                   AS closed_won_30d,
              COUNT(*) FILTER (WHERE pipeline='sales' AND stage='Closed Lost'
                AND closed_at >= $1)::text                                                   AS closed_lost_30d,
              COUNT(*) FILTER (WHERE pipeline='sales' AND created_at >= $1)::text            AS new_leads_30d,
              COUNT(*) FILTER (WHERE pipeline='sales' AND created_at >= $2)::text            AS new_leads_7d,
              COALESCE(SUM(${storedAmountNumericRawSql("total_volume")}),0)::text                  AS total_volume,
              COALESCE(SUM(0),0)::text                                                        AS total_residual,
              COALESCE(SUM(${storedAmountNumericRawSql("estimated_gross_profit_monthly")}),0)::text AS total_profit,
              COUNT(*)::text                                                                  AS deal_count
            FROM deals d
            WHERE ${dealPredicate}
            GROUP BY stage, pipeline
          `, dealValues),

          // Query 2 — all contact aggregates (was 6 separate queries)
          pool.query<{
            total: string; new_30d: string; new_7d: string;
            blocked: string; churn_risk: string; no_outreach_24h: string;
          }>(`
            SELECT
              COUNT(*)::text                                                                          AS total,
              COUNT(*) FILTER (WHERE created_at >= $1)::text                                         AS new_30d,
              COUNT(*) FILTER (WHERE created_at >= $2)::text                                         AS new_7d,
              COUNT(*) FILTER (WHERE do_not_contact = true
                OR email_status IN ('bounced','invalid','opted_out','unsafe'))::text                 AS blocked,
              COUNT(*) FILTER (WHERE churn_risk_tier IN ('High','Critical'))::text                   AS churn_risk,
              COUNT(*) FILTER (WHERE created_at >= $3::timestamptz - INTERVAL '24 hours'
                AND last_contacted_at IS NULL)::text                                                 AS no_outreach_24h
            FROM contacts c
            WHERE ${contactPredicate}
          `, contactValues),

          // Query 3 — ticket aggregates (was 3 separate queries)
          pool.query<{
            open: string; breached: string; avg_hours: string | null;
          }>(`
            SELECT
              COUNT(*) FILTER (WHERE t.status NOT IN ('Resolved','Closed'))::text            AS open,
              COUNT(*) FILTER (WHERE t.sla_deadline < $1 AND t.resolved_at IS NULL
                AND t.status NOT IN ('Resolved','Closed'))::text                             AS breached,
              CASE WHEN COUNT(*) FILTER (WHERE t.status IN ('Resolved','Closed')
                                              AND resolved_at IS NOT NULL
                                              AND resolved_at >= $2) > 0
                THEN ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600)
                  FILTER (WHERE t.status IN ('Resolved','Closed')
                    AND t.resolved_at IS NOT NULL AND t.resolved_at >= $2
                    AND (c.id IS NULL
                      OR (c.email NOT LIKE '%@example.com'
                        AND c.email NOT LIKE '%@test.com'
                        AND c.email NOT LIKE '%@mailinator.com')))::numeric, 1)::text
                ELSE NULL
              END                                                                            AS avg_hours
            FROM tickets t
            LEFT JOIN contacts c ON c.id = t.contact_id
          `, [now, thirtyDaysAgo]),

          // Query 4 — task aggregates (was 2 separate queries)
          // Only count tasks linked to production contacts (or unlinked tasks).
          // Excludes test/demo/synthetic-linked tasks so the dashboard count
          // matches what real operators need to action.
          readTaskMetrics({ actor: req.user as any, asOf: now, timezone: "UTC" }),

          // Query 5 — top 5 reps by open deal count
          pool.query<{ owner: string; cnt: string }>(`
            SELECT owner, COUNT(*)::text AS cnt
            FROM deals d
            WHERE ${repPredicate}
              AND owner IS NOT NULL
              AND stage NOT IN ('Closed Won','Closed Lost')
            GROUP BY owner
            ORDER BY COUNT(*) DESC
            LIMIT 5
          `, repValues),
        ]);

      // ── Deals ──────────────────────────────────────────────────────────────
      const stagesCount: Record<string, number> = {};
      let totalActiveSales = 0;
      let closedWon30d = 0, closedLost30d = 0, recentDealsCount = 0, newLeads7d = 0;
      let totalVolume = 0, totalResidual = 0, totalProfit = 0, dealCount = 0;
      const onboardingStages: Record<string, number> = {};

      for (const row of dealsAggRow.rows) {
        const cnt = parseInt(row.cnt, 10) || 0;
        stagesCount[row.stage] = (stagesCount[row.stage] ?? 0) + cnt;
        // Same open-stage definition as Outreach Command and the conversion deal authority (OPEN_SALES_LEAD_STAGES).
        // Legacy or unrecognized sales stages are counted in stagesBreakdown but never as "open".
        if (row.pipeline === "sales" && (OPEN_SALES_LEAD_STAGES as readonly string[]).includes(row.stage)) {
          totalActiveSales += cnt;
        }
        if (row.pipeline === "onboarding") {
          onboardingStages[row.stage] = (onboardingStages[row.stage] ?? 0) + cnt;
        }
        closedWon30d   += parseInt(row.closed_won_30d  ?? "0", 10);
        closedLost30d  += parseInt(row.closed_lost_30d ?? "0", 10);
        recentDealsCount += parseInt(row.new_leads_30d ?? "0", 10);
        newLeads7d     += parseInt(row.new_leads_7d    ?? "0", 10);
        totalVolume   += parseFloat(row.total_volume  ?? "0");
        totalResidual += parseFloat(row.total_residual ?? "0");
        totalProfit   += parseFloat(row.total_profit  ?? "0");
        dealCount     += cnt;
      }

      const liveStages = new Set(["Live (First Batch)", "Active (7 Days)", "Active (30 Days)"]);
      const onboardingActive = Object.entries(onboardingStages)
        .filter(([stage]) => stage !== "Active (30 Days)")
        .reduce((s, [, cnt]) => s + cnt, 0);
      const onboardingLive = Object.entries(onboardingStages)
        .filter(([stage]) => liveStages.has(stage))
        .reduce((s, [, cnt]) => s + cnt, 0);

      // ── Contacts ───────────────────────────────────────────────────────────
      const ca = contactsAggRow.rows[0];
      const totalEstProfit = totalProfit;

      const ta = tasksAggRow.rows[0];
      const tick = ticketsAggRow.rows[0];

      res.json({
        pipeline: {
          totalActive: totalActiveSales,
          // Scope of totalActive: every owner for admin/manager; owned-or-unassigned deals for other roles.
          // Outreach Command's openSalesProduction counts the same deals for ALL owners regardless of role.
          totalActiveScope: actor?.role === "admin" || actor?.role === "manager" ? "all_owners" : "owned_or_unassigned",
          closedWon30d,
          closedLost30d,
          conversionRate: recentDealsCount > 0 ? Math.round((closedWon30d / recentDealsCount) * 100) : 0,
          stagesBreakdown: stagesCount,
          newLeads7d,
        },
        onboarding: {
          active: onboardingActive,
          live: onboardingLive,
        },
        support: {
          openTickets:        parseInt(tick?.open     ?? "0", 10),
          breachedSla:        parseInt(tick?.breached ?? "0", 10),
          avgResolutionHours: tick?.avg_hours != null ? parseFloat(tick.avg_hours) : null,
        },
        tasks: {
          pending: Number(ta?.pending),
          overdue: Number(ta?.overdue),
          meta: tasksAggRow.meta,
        },
        contacts: {
          meta: { contractVersion: 1, population: "visible_non_archived_production_contacts",
            asOf: now.toISOString(), timezone: "UTC", snapshot: "separate_statements" },
          total:        parseInt(ca?.total          ?? "0", 10),
          new30d:       parseInt(ca?.new_30d        ?? "0", 10),
          new7d:        parseInt(ca?.new_7d         ?? "0", 10),
          blocked:      parseInt(ca?.blocked        ?? "0", 10),
          churnRisk:    parseInt(ca?.churn_risk     ?? "0", 10),
          noOutreach24h:parseInt(ca?.no_outreach_24h?? "0", 10),
        },
        topRepsByPipeline: topRepsRow.rows.map(r => ({ owner: r.owner, openDeals: parseInt(r.cnt, 10) })),
        revenue: {
          totalEstVolume:   totalVolume,
          totalEstResidual: totalResidual,
          totalEstProfit,
          avgDealProfit: dealCount > 0 ? Math.round(totalEstProfit / dealCount) : 0,
        },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === KPI COMPARATIVE ===
  app.get("/api/kpi/comparative", isDashboardUser, async (req, res) => {
    try {
      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

      const [dealsRows, contactsRows, wonRows, ticketsRows] = await Promise.all([
        pool.query<{ period: string; cnt: string }>(`
          SELECT
            CASE WHEN created_at >= $1 THEN 'current' ELSE 'previous' END AS period,
            COUNT(*)::text AS cnt
          FROM deals
          WHERE archived_at IS NULL AND record_class = 'production' AND created_at >= $2 AND created_at <= $3
          GROUP BY period
        `, [thisMonthStart, lastMonthStart, now]),
        pool.query<{ period: string; cnt: string }>(`
          SELECT
            CASE WHEN created_at >= $1 THEN 'current' ELSE 'previous' END AS period,
            COUNT(*)::text AS cnt
          FROM contacts
          WHERE archived_at IS NULL AND record_class = 'production' AND created_at >= $2 AND created_at <= $3
          GROUP BY period
        `, [thisMonthStart, lastMonthStart, now]),
        pool.query<{ period: string; cnt: string }>(`
          SELECT
            CASE WHEN updated_at >= $1 THEN 'current' ELSE 'previous' END AS period,
            COUNT(*)::text AS cnt
          FROM deals
          WHERE archived_at IS NULL AND record_class = 'production' AND stage = 'Closed Won'
            AND updated_at >= $2 AND updated_at <= $3
          GROUP BY period
        `, [thisMonthStart, lastMonthStart, now]),
        pool.query<{ period: string; cnt: string }>(`
          SELECT
            CASE WHEN created_at >= $1 THEN 'current' ELSE 'previous' END AS period,
            COUNT(*)::text AS cnt
          FROM tickets
          WHERE created_at >= $2 AND created_at <= $3
          GROUP BY period
        `, [thisMonthStart, lastMonthStart, now]),
      ]);

      const tally = (rows: { period: string; cnt: string }[]) => {
        let current = 0, previous = 0;
        for (const r of rows) {
          if (r.period === "current") current = parseInt(r.cnt, 10);
          else previous = parseInt(r.cnt, 10);
        }
        return { current, previous };
      };

      const calcChange = (current: number, previous: number) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return Math.round(((current - previous) / previous) * 100);
      };

      const deals = tally(dealsRows.rows);
      const contacts = tally(contactsRows.rows);
      const won = tally(wonRows.rows);
      const tickets = tally(ticketsRows.rows);

      res.json({
        newDeals: { ...deals, change: calcChange(deals.current, deals.previous) },
        newContacts: { ...contacts, change: calcChange(contacts.current, contacts.previous) },
        closedWon: { ...won, change: calcChange(won.current, won.previous) },
        tickets: { ...tickets, change: calcChange(tickets.current, tickets.previous) },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === ANALYTICS / REPORTING ===
  // Reporting management aggregates intentionally exclude agent sessions.
  app.get("/api/analytics/pipeline", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { data } = await readPipelineAnalytics(req.user as any);
      res.json(data);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/analytics/support", requireRole("admin", "manager"), async (req, res) => {
    try {
      const now = new Date();
      const [summaryRows, categoryRows, priorityRows] = await Promise.all([
        pool.query<{ total: string; open: string; resolved: string; breaches: string; avg_resolution_hours: string | null }>(`
          SELECT
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE COALESCE(status, 'New Ticket') NOT IN ('Resolved', 'Closed'))::text AS open,
            COUNT(*) FILTER (WHERE status IN ('Resolved', 'Closed'))::text AS resolved,
            COUNT(*) FILTER (WHERE sla_deadline < $1 AND COALESCE(status, 'New Ticket') NOT IN ('Resolved', 'Closed'))::text AS breaches,
            ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)
              FILTER (WHERE resolved_at IS NOT NULL AND created_at IS NOT NULL))::text AS avg_resolution_hours
          FROM tickets
        `, [now]),
        pool.query<{ category: string; count: string }>(`
          SELECT COALESCE(category, 'Other') AS category, COUNT(*)::text AS count
          FROM tickets GROUP BY COALESCE(category, 'Other')
        `),
        pool.query<{ priority: string; count: string }>(`
          SELECT COALESCE(priority, 'Normal') AS priority, COUNT(*)::text AS count
          FROM tickets GROUP BY COALESCE(priority, 'Normal')
        `),
      ]);
      // The resolution average intentionally covers resolved tickets only; the
      // remaining aggregates and breakdowns cover the complete tickets table.
      const summary = summaryRows.rows[0];
      const categoryBreakdown = Object.fromEntries(categoryRows.rows.map(row => [row.category, parseInt(row.count, 10)]));
      const priorityBreakdown = Object.fromEntries(priorityRows.rows.map(row => [row.priority, parseInt(row.count, 10)]));

      res.json({
        total: parseInt(summary?.total ?? "0", 10),
        open: parseInt(summary?.open ?? "0", 10),
        resolved: parseInt(summary?.resolved ?? "0", 10),
        slaBreaches: parseInt(summary?.breaches ?? "0", 10),
        avgResolutionHours: summary?.avg_resolution_hours == null ? null : parseFloat(summary.avg_resolution_hours),
        categoryBreakdown,
        priorityBreakdown,
        meta: { exact: true, asOf: now.toISOString(), scope: "all tickets" },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/analytics/tasks", requireRole("admin", "manager"), async (req, res) => {
    try {
      const now = new Date();
      const [summaryRows, priorityRows] = await Promise.all([
        readTaskMetrics({ actor: req.user as any, asOf: now, timezone: "UTC" }),
        db.execute(sql`
          SELECT COALESCE(priority, 'normal') AS priority, COUNT(*)::text AS count
          FROM tasks WHERE ${taskReadPredicate({ actor: req.user as any, asOf: now, timezone: "UTC" })}
          GROUP BY COALESCE(priority, 'normal')
        `),
      ]);
      const summary = summaryRows.rows[0];
      const priorityBreakdown = Object.fromEntries(priorityRows.rows.map((row: any) => [row.priority, Number(row.count)]));

      res.json({
        total: Number(summary?.total),
        pending: Number(summary?.pending),
        inProgress: Number(summary?.in_progress),
        completed: Number(summary?.completed),
        overdue: Number(summary?.overdue),
        priorityBreakdown,
        meta: summaryRows.meta,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/analytics/lead-sources", isDashboardUser, async (req, res) => {
    // Replaced storage.getContacts({limit:500}) + in-memory filter with direct SQL
    // aggregates to avoid loading full contact rows and to stay within one connection.
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const [contactRows, dealRows] = await Promise.all([
        pool.query<{ source: string; leads: string }>(`
          SELECT
            COALESCE(NULLIF(utm_source,''), NULLIF(lead_source,''), 'direct') AS source,
            COUNT(*)::text AS leads
          FROM contacts
          WHERE archived_at IS NULL AND record_class = 'production'
            AND created_at >= $1
          GROUP BY source
        `, [thirtyDaysAgo]),
        pool.query<{ source: string; deals: string; won: string }>(`
          SELECT
            COALESCE(
              NULLIF(REGEXP_REPLACE(COALESCE(lead_source,''), '^utm:', ''), ''),
              'direct'
            ) AS source,
            COUNT(*)::text AS deals,
            COUNT(*) FILTER (WHERE stage = 'Closed Won')::text AS won
          FROM deals
          WHERE archived_at IS NULL AND record_class = 'production'
            AND pipeline = 'sales' AND created_at >= $1
          GROUP BY source
        `, [thirtyDaysAgo]),
      ]);

      const sourceMap: Record<string, { leads: number; deals: number; won: number }> = {};
      for (const row of contactRows.rows) {
        sourceMap[row.source] = { leads: parseInt(row.leads, 10), deals: 0, won: 0 };
      }
      for (const row of dealRows.rows) {
        if (!sourceMap[row.source]) sourceMap[row.source] = { leads: 0, deals: 0, won: 0 };
        sourceMap[row.source].deals += parseInt(row.deals, 10);
        sourceMap[row.source].won   += parseInt(row.won,   10);
      }

      const sources = Object.entries(sourceMap)
        .map(([source, data]) => ({
          source,
          leads: data.leads,
          deals: data.deals,
          won: data.won,
          conversionRate: data.leads > 0 ? Math.round((data.won / data.leads) * 100) : 0,
        }))
        .sort((a, b) => b.leads - a.leads)
        .slice(0, 10);

      res.json({ sources });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GROWTH KPI — weekly channel breakdown ===
  app.get("/api/analytics/growth-kpi", isDashboardUser, async (req, res) => {
    const role = (req.user as any)?.role;
    if (!["admin", "manager"].includes(role)) {
      return res.status(403).json({ message: "Admin/Manager only" });
    }
    try {
      const displayWeeksParam = parseInt((req.query.weeks as string) || "12", 10);
      const displayWeeks = Math.min(Math.max(displayWeeksParam, 1), 24);

      // We must fetch enough history for:
      //   1. Two full displayWeeks periods (current + previous) for period comparison
      //   2. Always at least 8 weeks for sparklines
      //   3. Always at least 2 weeks for WoW on the arc cards
      const SPARKLINE_WEEKS = 8;
      const fetchWeeks = Math.max(displayWeeks * 2, SPARKLINE_WEEKS, 2);

      const now = new Date();

      // Monday-anchored ISO week start
      const getWeekStart = (date: Date): Date => {
        const d = new Date(date);
        const day = d.getDay();
        d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
        d.setHours(0, 0, 0, 0);
        return d;
      };

      const currentWeekStart = getWeekStart(now);

      // Build week-start array for fetchWeeks (oldest → newest)
      const weekStarts: Date[] = [];
      for (let i = fetchWeeks - 1; i >= 0; i--) {
        const ws = new Date(currentWeekStart);
        ws.setDate(ws.getDate() - i * 7);
        weekStarts.push(ws);
      }

      const windowStart = weekStarts[0];

      const CHANNELS = ["linkedin", "reddit", "partner", "gbp", "affiliate", "newsletter", "haro", "youtube", "direct", "other"];

      // Normalise utm_source / lead_source to a canonical channel name
      const normalizeSource = (src: string | null | undefined): string => {
        if (!src) return "direct";
        const s = src.toLowerCase().trim().replace(/^utm:/, "");
        if (s.includes("linkedin")) return "linkedin";
        if (s.includes("reddit")) return "reddit";
        if (s.includes("partner") || s.includes("referral") || s.includes("iso")) return "partner";
        if (s.includes("gbp") || s.includes("google business") || s.includes("google_business")) return "gbp";
        if (s.includes("affiliate")) return "affiliate";
        if (s.includes("newsletter") || s.includes("email")) return "newsletter";
        if (s.includes("haro")) return "haro";
        if (s.includes("youtube") || s.includes("video")) return "youtube";
        if (s === "direct" || s === "" || s === "none") return "direct";
        return "other";
      };

      // ── Raw-SQL: contacts by week bucket (windowed) ────────────────────────
      const [contactRows, dealRows, allTimeContactRows] = await Promise.all([
        pool.query<{ week_start: Date; utm_source: string | null; lead_source: string | null; count: string }>(`
          SELECT
            date_trunc('week', created_at) AS week_start,
            utm_source,
            lead_source,
            COUNT(*)::text AS count
          FROM contacts
          WHERE archived_at IS NULL AND record_class = 'production'
            AND created_at >= $1
          GROUP BY week_start, utm_source, lead_source
          ORDER BY week_start
        `, [windowStart]),

        // All-time deals/won by lead_source for conversion rate denominator
        pool.query<{ lead_source: string | null; stage: string; count: string }>(`
          SELECT lead_source, stage, COUNT(*)::text AS count
          FROM deals
          WHERE archived_at IS NULL AND record_class = 'production' AND pipeline = 'sales'
          GROUP BY lead_source, stage
        `),

        // All-time contacts by channel (same scope as all-time deals, for consistent conv rate)
        pool.query<{ utm_source: string | null; lead_source: string | null; count: string }>(`
          SELECT utm_source, lead_source, COUNT(*)::text AS count
          FROM contacts
          WHERE archived_at IS NULL AND record_class = 'production'
          GROUP BY utm_source, lead_source
        `),
      ]);

      // ── Build weeklyByChannel: [fetchWeeks] arrays ────────────────────────
      const weeklyByChannel: Record<string, number[]> = {};
      CHANNELS.forEach(ch => { weeklyByChannel[ch] = new Array(fetchWeeks).fill(0); });

      contactRows.rows.forEach(row => {
        const ch = normalizeSource(row.utm_source || row.lead_source);
        const canonCh = CHANNELS.includes(ch) ? ch : "other";
        const rowWeek = new Date(row.week_start);
        for (let i = 0; i < weekStarts.length; i++) {
          if (rowWeek.getTime() === weekStarts[i].getTime()) {
            weeklyByChannel[canonCh][i] += parseInt(row.count, 10);
            break;
          }
        }
      });

      // ── All-time leads/deals/won by channel (consistent scope for conv rate) ──
      const allTimeLeads: Record<string, number> = {};
      CHANNELS.forEach(ch => { allTimeLeads[ch] = 0; });
      allTimeContactRows.rows.forEach(row => {
        const ch = normalizeSource(row.utm_source || row.lead_source);
        const canonCh = CHANNELS.includes(ch) ? ch : "other";
        allTimeLeads[canonCh] += parseInt(row.count, 10);
      });

      const dealsByChannel: Record<string, { deals: number; won: number }> = {};
      CHANNELS.forEach(ch => { dealsByChannel[ch] = { deals: 0, won: 0 }; });
      dealRows.rows.forEach(row => {
        const ch = normalizeSource(row.lead_source);
        const canonCh = CHANNELS.includes(ch) ? ch : "other";
        const n = parseInt(row.count, 10);
        dealsByChannel[canonCh].deals += n;
        if (row.stage === "Closed Won") dealsByChannel[canonCh].won += n;
      });

      // ── Key indices ────────────────────────────────────────────────────────
      // Current display period: last displayWeeks weeks
      // Previous display period: the displayWeeks weeks before that
      const currentPeriodStart = fetchWeeks - displayWeeks;   // inclusive
      const prevPeriodStart    = fetchWeeks - displayWeeks * 2; // inclusive (always >= 0 because fetchWeeks >= displayWeeks*2)
      const prevPeriodEnd      = currentPeriodStart;            // exclusive

      // Arc / WoW cards always show current vs previous single week
      const currentWeekIdx = fetchWeeks - 1;
      const prevWeekIdx    = fetchWeeks - 2; // always >= 0 (fetchWeeks >= 2)

      let thisWeekTotal = 0;
      let prevWeekTotal = 0;
      CHANNELS.forEach(ch => {
        thisWeekTotal += weeklyByChannel[ch][currentWeekIdx] || 0;
        prevWeekTotal += weeklyByChannel[ch][prevWeekIdx]    || 0;
      });

      const weekOverWeekChange = prevWeekTotal > 0
        ? Math.round(((thisWeekTotal - prevWeekTotal) / prevWeekTotal) * 100)
        : (thisWeekTotal > 0 ? 100 : 0);

      // ── Sparkline: always last SPARKLINE_WEEKS weeks (min 8), independent of toggle ──
      const sparklineStart = Math.max(fetchWeeks - SPARKLINE_WEEKS, 0);

      const channels = CHANNELS.map(ch => {
        const full = weeklyByChannel[ch];

        // Period-aggregated counts for the table columns (change with toggle)
        const periodCount = full.slice(currentPeriodStart).reduce((s, n) => s + n, 0);
        const prevPeriodCount = full.slice(prevPeriodStart, prevPeriodEnd).reduce((s, n) => s + n, 0);

        // Sparkline always last 8 weeks
        const sparkline = weekStarts.slice(sparklineStart).map((ws, i) => ({
          week:  ws.toISOString().split("T")[0],
          count: full[sparklineStart + i] || 0,
        }));

        // Conversion rate: lead → deal (all-time deals / all-time contacts, consistent scope)
        const atLeads = allTimeLeads[ch] || 0;
        const { deals, won } = dealsByChannel[ch];
        const conversionRate = atLeads > 0 ? Math.round((deals / atLeads) * 100) : 0;

        return {
          channel: ch,
          // period data for table (changes with time range toggle)
          periodCount,
          prevPeriodCount,
          // always-current-week for backward compat with arc cards
          thisWeek: full[currentWeekIdx] || 0,
          lastWeek: full[prevWeekIdx]    || 0,
          conversionRate,
          sparkline,
          won,
        };
      });

      const weekLabels = weekStarts.slice(currentPeriodStart).map(ws => ws.toISOString().split("T")[0]);

      res.json({
        thisWeekTotal,
        prevWeekTotal,
        weekOverWeekChange,
        target: 1000,
        displayWeeks,
        channels,
        weekLabels,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/analytics/daily-leads", isDashboardUser, async (req, res) => {
    // Replaced storage.getContacts/getDeals({limit:500}) + in-memory filter with
    // two direct SQL date-bucket aggregates using one connection each.
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [contactRows, dealRows] = await Promise.all([
        pool.query<{ day: string; cnt: string }>(`
          SELECT DATE(created_at AT TIME ZONE 'UTC') AS day, COUNT(*)::text AS cnt
          FROM contacts
          WHERE archived_at IS NULL AND record_class = 'production'
            AND created_at >= $1
          GROUP BY day ORDER BY day
        `, [sevenDaysAgo]),
        pool.query<{ day: string; cnt: string }>(`
          SELECT DATE(created_at AT TIME ZONE 'UTC') AS day, COUNT(*)::text AS cnt
          FROM deals
          WHERE archived_at IS NULL AND record_class = 'production'
            AND pipeline = 'sales' AND created_at >= $1
          GROUP BY day ORDER BY day
        `, [sevenDaysAgo]),
      ]);

      const dailyData: Record<string, { leads: number; deals: number }> = {};
      const now = new Date();
      for (let i = 0; i < 7; i++) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        dailyData[d.toISOString().split("T")[0]] = { leads: 0, deals: 0 };
      }
      for (const row of contactRows.rows) {
        const key = String(row.day).split("T")[0];
        if (dailyData[key]) dailyData[key].leads = parseInt(row.cnt, 10);
      }
      for (const row of dealRows.rows) {
        const key = String(row.day).split("T")[0];
        if (dailyData[key]) dailyData[key].deals = parseInt(row.cnt, 10);
      }

      const today = now.toISOString().split("T")[0];
      const todayLeads = dailyData[today]?.leads || 0;
      const todayDeals = dailyData[today]?.deals || 0;
      const trend = Object.entries(dailyData)
        .map(([date, data]) => ({ date, ...data }))
        .sort((a, b) => a.date.localeCompare(b.date));

      res.json({ todayLeads, todayDeals, trend });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/analytics/weekly-digest", isDashboardUser, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    try {
      const { html, summary } = await buildWeeklyDigest();
      const adminEmail = process.env.ADMIN_DIGEST_EMAIL;
      if (adminEmail && isGhlConfigured()) {
        try {
          await sendGhlInternalNotification({ email: adminEmail, subject: `Weekly KPI Digest — ${summary.period} — Liberty Bancard`, body: html });
          res.json({ ...summary, emailSent: true, emailRecipient: adminEmail });
          return;
        } catch (emailErr) {
          console.error("Weekly digest email error:", emailErr);
          res.json({ ...summary, emailSent: false, emailError: String(emailErr) });
          return;
        }
      }
      res.json({ ...summary, emailSent: false, emailError: !adminEmail ? "No admin email configured" : "GHL not configured" });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === FORECASTING ===
  app.get("/api/forecasting/summary", isDashboardUser, async (req, res) => {
    try {
      const { data: deals } = await storage.getDeals({ limit: 500, recordClass: "production" });
      const activeDeals = deals.filter(d => d.pipeline === "sales" && d.stage !== "Closed Lost");

      const stageWeights: Record<string, number> = {
        "New Lead": 0.1, "Statement Received": 0.25, "Review In Progress": 0.4,
        "Call Booked": 0.5, "Proposal Sent": 0.6, "Negotiation / Follow-Up": 0.75,
        "Verbal Commit": 0.9, "Closed Won": 1.0, "Closed Lost": 0
      };

      let totalPipeline = 0;
      let weightedForecast = 0;
      const stageBreakdown: Record<string, { count: number; volume: number; profit: number; weight: number }> = {};

      activeDeals.forEach(d => {
        const profit = parseFloat(d.estimatedGrossProfitMonthly || "0");
        const volume = parseFloat(d.totalVolume || "0");
        const weight = stageWeights[d.stage] || 0.1;

        totalPipeline += profit;
        weightedForecast += profit * weight;

        if (!stageBreakdown[d.stage]) {
          stageBreakdown[d.stage] = { count: 0, volume: 0, profit: 0, weight: weight * 100 };
        }
        stageBreakdown[d.stage].count++;
        stageBreakdown[d.stage].volume += volume;
        stageBreakdown[d.stage].profit += profit;
      });

      const now = new Date();
      const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const nextMonthEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);

      const thisMonth = activeDeals.filter(d => d.nextFollowUp && new Date(d.nextFollowUp) <= thisMonthEnd)
        .reduce((sum, d) => sum + parseFloat(d.estimatedGrossProfitMonthly || "0") * (stageWeights[d.stage] || 0.1), 0);
      const nextMonth = activeDeals.filter(d => d.nextFollowUp && new Date(d.nextFollowUp) > thisMonthEnd && new Date(d.nextFollowUp) <= nextMonthEnd)
        .reduce((sum, d) => sum + parseFloat(d.estimatedGrossProfitMonthly || "0") * (stageWeights[d.stage] || 0.1), 0);

      res.json({ totalPipeline, weightedForecast, thisMonthForecast: thisMonth, nextMonthForecast: nextMonth, stageBreakdown });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === PIPELINE STATS (contacts by tier, deals by stage, outreach stats) ===
  app.get("/api/kpi/pipeline-stats", isDashboardUser, async (req, res) => {
    try {
      // Single contacts scan: tier buckets + scored/unscored + awaiting outreach in one pass.
      // Single deals scan: stage counts (sales pipeline) + total (all pipelines) + pipeline value.
      // Two sequential queries, two pool connections total (was 7 separate pool.query() calls).
      const contactsRow = await pool.query<{
        hot: string; warm: string; cold: string; unqualified: string;
        scored: string; unscored: string; awaiting_outreach: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE lead_score >= 70)                                                                                        AS hot,
          COUNT(*) FILTER (WHERE lead_score >= 45 AND lead_score < 70)                                                                    AS warm,
          COUNT(*) FILTER (WHERE lead_score >= 20 AND lead_score < 45)                                                                    AS cold,
          COUNT(*) FILTER (WHERE COALESCE(lead_score, 0) < 20)                                                                           AS unqualified,
          COUNT(*) FILTER (WHERE last_scored_at IS NOT NULL)                                                                              AS scored,
          COUNT(*) FILTER (WHERE last_scored_at IS NULL)                                                                                  AS unscored,
          COUNT(*) FILTER (WHERE lead_score >= 45 AND last_contacted_at IS NULL
                                 AND (do_not_contact IS NULL OR do_not_contact = false))                                                   AS awaiting_outreach
        FROM contacts
        WHERE archived_at IS NULL AND record_class = 'production'
      `);

      const dealsRows = await pool.query<{
        stage: string; sales_cnt: string; total_value: string;
      }>(`
        SELECT
          stage,
          COUNT(*) FILTER (WHERE pipeline = 'sales')                                                                                      AS sales_cnt,
          COALESCE(SUM(
            CASE WHEN pipeline = 'sales'
                      AND stage NOT IN ('Closed Won', 'Closed Lost')
                      AND estimated_gross_profit_monthly IS NOT NULL
                      AND REGEXP_REPLACE(estimated_gross_profit_monthly, '[^0-9.]', '', 'g') != ''
            THEN CAST(REGEXP_REPLACE(estimated_gross_profit_monthly, '[^0-9.]', '', 'g') AS DECIMAL)
            ELSE 0 END
          ), 0)                                                                                                                           AS total_value
        FROM deals
        WHERE archived_at IS NULL AND record_class = 'production'
        GROUP BY stage
      `);

      const c = contactsRow.rows[0];
      const contactsByTier: Record<string, number> = {
        hot:        parseInt(c.hot, 10)        || 0,
        warm:       parseInt(c.warm, 10)       || 0,
        cold:       parseInt(c.cold, 10)       || 0,
        unqualified:parseInt(c.unqualified, 10)|| 0,
      };

      const dealsByStage: Record<string, number> = {};
      let totalDeals = 0;
      let pipelineValue = 0;
      for (const row of dealsRows.rows) {
        const cnt = parseInt(row.sales_cnt, 10) || 0;
        if (cnt > 0) dealsByStage[row.stage] = cnt;
        totalDeals += cnt;
        pipelineValue += parseFloat(row.total_value) || 0;
      }

      res.json({
        contactsByTier,
        dealsByStage,
        scored:          parseInt(c.scored, 10)           || 0,
        unscored:        parseInt(c.unscored, 10)         || 0,
        totalDeals,
        awaitingOutreach:parseInt(c.awaiting_outreach, 10)|| 0,
        pipelineValue,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === LEADERBOARD ===
  app.get("/api/leaderboard", isDashboardUser, async (req, res) => {
    try {
      const { period = "month" } = req.query as { period?: string };
      if(!["week","month","quarter","all"].includes(period))return res.status(400).json({message:"Invalid leaderboard period"});
      const now = new Date();

      // Compute time windows for current and previous period
      let currentStart: Date;
      let prevStart: Date;
      let prevEnd: Date;

      if (period === "week") {
        currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        prevStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        prevEnd = currentStart;
      } else if (period === "quarter") {
        const qMonth = Math.floor(now.getMonth() / 3) * 3;
        currentStart = new Date(now.getFullYear(), qMonth, 1);
        prevStart = new Date(now.getFullYear(), qMonth - 3, 1);
        prevEnd = currentStart;
      } else if (period === "all") {
        currentStart = new Date(0);
        prevStart = new Date(0);
        prevEnd = new Date(0);
      } else {
        // month
        currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
        prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        prevEnd = currentStart;
      }

      const [allAgents, dealsResult, callLogsResult, contactCreateResult] = await Promise.all([
        storage.getAgents(),
        storage.getDeals({ limit: 10000, recordClass: "production" }),
        // Stored calls lack a canonical actor; read source availability without
        // assigning calls using caller names, mutable owners or adjacent audits.
        (readOptions?.leaderboardQuery?.("callLogs",`SELECT COUNT(*)::text AS record_count FROM call_logs`)
          ??pool.query(`SELECT COUNT(*)::text AS record_count FROM call_logs`)).catch(()=>({rows:null})),
        // #910 — contact_created audit events carry the immutable creator (actor_id = users.id, matched via agent.userId)
        (readOptions?.leaderboardQuery?.("creatorEvents",`SELECT actor_id, created_at FROM audit_logs WHERE action = 'contact_created' AND actor_type = 'user' AND actor_id IS NOT NULL`)
          ??pool.query(`SELECT actor_id, created_at FROM audit_logs WHERE action = 'contact_created' AND actor_type = 'user' AND actor_id IS NOT NULL`)).catch(()=>({rows:null})),
      ]);

      const allDeals = dealsResult.data;
      const activeAgents=allAgents.filter(a=>a.status==="active");
      const aliasOwners=new Map<string,Set<number>>();
      for(const agent of activeAgents)for(const alias of [`${agent.firstName} ${agent.lastName}`,agent.email]){
        const key=alias?.trim().toLowerCase();
        if(key){const owners=aliasOwners.get(key)??new Set<number>();owners.add(agent.id);aliasOwners.set(key,owners);}
      }
      const ambiguousAliasCount=[...aliasOwners.values()].filter(owners=>owners.size>1).length;
      const read = {
        source:"active agent roster / existing production deal reader / call-record availability / immutable creator events",
        asOf:now.toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
        currentStart:currentStart.toISOString(),currentEnd:now.toISOString(),
        previousStart:prevStart.toISOString(),previousEnd:prevEnd.toISOString(),
        consistency:"independent_reads_not_atomic_snapshot",
        completeness:dealsResult.total===allDeals.length?"complete_returned_deal_population":"incomplete_deal_population",
        loadedDealCount:allDeals.length,totalDealCount:dealsResult.total,
        revenueMeasure:"stored_closed_won_processing_volume_not_revenue_or_native_receipts",
        attribution:"existing_legacy_owner_aliases_and_immutable_creator_user_ids",
        attributionCompleteness:ambiguousAliasCount?"ambiguous_legacy_aliases":"unique_legacy_aliases",
        ambiguousAliasCount,
        sources:{callLogs:callLogsResult.rows?"loaded":"failed",creatorEvents:contactCreateResult.rows?"loaded":"failed"},
        callAttribution:"unavailable_no_canonical_call_actor",
      };

      const currentUser = req.user as any;
      const currentUserId = currentUser?.id;

      // Fetch leaderboard settings
      const [settingsRow] = await db.select().from(leaderboardSettings).limit(1);
      const settings = settingsRow || {
        showDeals: true,
        showRevenue: true,
        showProposals: true,
        showCallsMade: true,
        showResponseRate: false,
        visibleToAgents: true,
        monthlyDealGoal: 10,
        monthlyRevenueGoal: "50000",
      };

      const role = currentUser?.role;
      if (role === "agent" && !settings.visibleToAgents) {
        return res.json({ entries: [], period, settings,read,visibility:"disabled_by_configuration" });
      }

      const isCurrent = (date: Date | string | null | undefined) => {
        if (!date) return false;
        const d = new Date(date);
        return d >= currentStart && d <= now;
      };

      const isPrev = (date: Date | string | null | undefined) => {
        if (!date || period === "all") return false;
        const d = new Date(date);
        return d >= prevStart && d < prevEnd;
      };

      const parseMoney = (v: string | null | undefined) => {
        if (!v?.trim()) return null;
        const raw=v.trim().replace(/^\$/, "").replace(/,/g,"");
        if(!/^\d+(\.\d+)?$/.test(raw))return null;
        const n=Number(raw);
        return Number.isFinite(n)?n:null;
      };
      const recordedVolume=(records:typeof allDeals)=>{
        const amounts=records.map(d=>parseMoney(d.totalVolume));
        return amounts.length && amounts.every((n):n is number=>n!==null)
          ? amounts.reduce((sum,n)=>sum+n,0) : null;
      };

      const entries = allAgents
        .filter(a => a.status === "active")
        .map(agent => {
          // Current period deals
          const agentDeals = allDeals.filter(d => {
            const owner = d.owner?.toLowerCase();
            const agentName = `${agent.firstName} ${agent.lastName}`.toLowerCase();
            return owner === agentName || owner === agent.email?.toLowerCase();
          });

          const currentDeals = agentDeals.filter(d => d.stage === "Closed Won" && isCurrent(d.closedAt || d.updatedAt));
          const prevDeals = agentDeals.filter(d => d.stage === "Closed Won" && isPrev(d.closedAt || d.updatedAt));
          // #530 — Close rate: won / (won + lost) in the period
          const currentLostDeals = agentDeals.filter(d => d.stage === "Closed Lost" && isCurrent(d.closedAt || d.updatedAt));
          const prevLostDeals = agentDeals.filter(d => d.stage === "Closed Lost" && isPrev(d.closedAt || d.updatedAt));

          const currentProposals = agentDeals.filter(d => isCurrent(d.proposalEmailSentAt));
          const prevProposals = agentDeals.filter(d => isPrev(d.proposalEmailSentAt));

          const currentRevenue = recordedVolume(currentDeals);
          const prevRevenue = recordedVolume(prevDeals);

          // Call logs (best effort)
          const currentCalls = null;
          const prevCalls = null;

          // Contacts created — sourced from immutable contact_created audit events (actor_id = users.id matched via agent.userId)
          const agentContactEvents = agent.userId
            ? contactCreateResult.rows?.filter((r: any) => String(r.actor_id) === String(agent.userId))
            : null;
          const currentContactsCreated = agentContactEvents?.filter((r: any) => isCurrent(r.created_at)).length ?? null;
          const prevContactsCreated = agentContactEvents?.filter((r: any) => isPrev(r.created_at)).length ?? null;

          const isCurrentUser = !!(currentUserId && agent.userId === currentUserId);

          // Response Rate = proposals sent / total deals touched in the period (as %)
          // "Touched" = deal exists in the period (created or updated)
          const currentTouched = agentDeals.filter(d => isCurrent(d.createdAt || d.updatedAt));
          const prevTouched = agentDeals.filter(d => isPrev(d.createdAt || d.updatedAt));
          const currentResponseRate = currentTouched.length > 0
            ? Math.round((currentProposals.length / currentTouched.length) * 100)
            : null;
          const prevResponseRate = prevTouched.length > 0
            ? Math.round((prevProposals.length / prevTouched.length) * 100)
            : null;

          const currentAttempted = currentDeals.length + currentLostDeals.length;
          const prevAttempted = prevDeals.length + prevLostDeals.length;
          const currentCloseRate = currentAttempted > 0 ? Math.round((currentDeals.length / currentAttempted) * 100) : null;
          const prevCloseRate = prevAttempted > 0 ? Math.round((prevDeals.length / prevAttempted) * 100) : null;

          return {
            agentId: agent.id,
            name: `${agent.firstName} ${agent.lastName}`,
            initials: `${agent.firstName[0]}${agent.lastName[0]}`.toUpperCase(),
            rank: 0,
            dealsClosed: currentDeals.length,
            revenueManaged: currentRevenue,
            proposalsSent: currentProposals.length,
            callsMade: currentCalls,
            responseRate: currentResponseRate,
            closeRate: currentCloseRate,  // #530
            contactsCreated: currentContactsCreated, // #910
            prevDealsClosed: prevDeals.length,
            prevRevenueManaged: prevRevenue,
            prevProposalsSent: prevProposals.length,
            prevCallsMade: prevCalls,
            prevResponseRate,
            prevCloseRate, // #530
            prevContactsCreated: prevContactsCreated, // #910
            isCurrentUser,
          };
        });

      // Sort by deals for default rank
      entries.sort((a, b) => b.dealsClosed - a.dealsClosed);
      entries.forEach((e, i) => { e.rank = i + 1; });

      res.json({ entries, period, settings,read,visibility:"visible" });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === LEADERBOARD SETTINGS ===
  app.get("/api/leaderboard/settings", isDashboardUser, async (req, res) => {
    try {
      const [row] = await db.select().from(leaderboardSettings).limit(1);
      res.json(row || {
        showDeals: true, showRevenue: true, showProposals: true, showCallsMade: true,
        showResponseRate: false, visibleToAgents: true, monthlyDealGoal: 10, monthlyRevenueGoal: "50000",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/leaderboard/settings", isDashboardUser, async (req, res) => {
    const role = (req.user as any)?.role;
    if (role !== "admin" && role !== "manager") return res.status(403).json({ message: "Admin/Manager only" });
    try {
      const updates = req.body;
      const [existing] = await db.select().from(leaderboardSettings).limit(1);
      if (existing) {
        const [updated] = await db.update(leaderboardSettings)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(leaderboardSettings.id, existing.id))
          .returning();
        res.json(updated);
      } else {
        const [created] = await db.insert(leaderboardSettings).values(updates).returning();
        res.json(created);
      }
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── Wave 8: Conversion Analytics Endpoints ───────────────────────────────

  app.get("/api/analytics/conversion-funnel", isDashboardUser, async (req, res) => {
    try {
      const { analyticsEvents } = await import("@shared/schema");
      const { gte, count: drizzleCount } = await import("drizzle-orm");
      const days = parseInt(String(req.query.days || "30"), 10);
      const since = new Date(Date.now() - days * 86400000);

      const [rows, totalLeadsRow, totalDealsRow] = await Promise.all([
        db
          .select({
            eventName: analyticsEvents.eventName,
            cnt: drizzleCount(analyticsEvents.id),
          })
          .from(analyticsEvents)
          .where(gte(analyticsEvents.occurredAt, since))
          .groupBy(analyticsEvents.eventName),
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM contacts WHERE archived_at IS NULL AND record_class = 'production' AND created_at >= $1`,
          [since]
        ),
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM deals WHERE archived_at IS NULL AND record_class = 'production' AND pipeline = 'sales' AND created_at >= $1`,
          [since]
        ),
      ]);

      const byEvent: Record<string, number> = {};
      for (const r of rows) {
        byEvent[r.eventName] = Number(r.cnt);
      }

      const funnel = [
        { stage: "Phone CTA Clicks",      eventName: "phone_cta_click",             count: byEvent["phone_cta_click"] ?? 0 },
        { stage: "Booking CTA Clicks",    eventName: "booking_cta_click",           count: byEvent["booking_cta_click"] ?? 0 },
        { stage: "Forms Submitted",       eventName: "form_submitted",              count: byEvent["form_submitted"] ?? 0 },
        { stage: "Deals Created",         eventName: "deal_created",                count: byEvent["deal_created"] ?? 0 },
        { stage: "Appointments Booked",   eventName: "appointment_booked",          count: byEvent["appointment_booked"] ?? 0 },
        { stage: "Calls Booked",          eventName: "call_booked",                 count: byEvent["call_booked"] ?? 0 },
        { stage: "Statements Received",   eventName: "statement_received",          count: byEvent["statement_received"] ?? 0 },
        { stage: "Proposals Generated",   eventName: "proposal_generated",          count: byEvent["proposal_generated"] ?? 0 },
        { stage: "Proposals Sent",        eventName: "proposal_sent",               count: byEvent["proposal_sent"] ?? 0 },
        { stage: "Closed Won",            eventName: "closed_won",                  count: byEvent["closed_won"] ?? 0 },
      ];

      res.json({
        funnel,
        byEvent,
        days,
        totalLeads: parseInt(totalLeadsRow.rows[0]?.cnt ?? "0", 10),
        totalDeals: parseInt(totalDealsRow.rows[0]?.cnt ?? "0", 10),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/analytics/utm-attribution", isDashboardUser, async (req, res) => {
    try {
      const { analyticsEvents } = await import("@shared/schema");
      const { gte, count } = await import("drizzle-orm");
      const days = parseInt(String(req.query.days || "30"), 10);
      const since = new Date(Date.now() - days * 86400000);

      const rows = await db
        .select({
          utmSource: analyticsEvents.utmSource,
          utmMedium: analyticsEvents.utmMedium,
          utmCampaign: analyticsEvents.utmCampaign,
          cnt: count(analyticsEvents.id),
        })
        .from(analyticsEvents)
        .where(gte(analyticsEvents.occurredAt, since))
        .groupBy(analyticsEvents.utmSource, analyticsEvents.utmMedium, analyticsEvents.utmCampaign)
        .limit(100);

      res.json({ rows, days });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/analytics/form-events", isDashboardUser, async (req, res) => {
    try {
      const { analyticsEvents } = await import("@shared/schema");
      const { gte, count } = await import("drizzle-orm");
      const days = parseInt(String(req.query.days || "30"), 10);
      const since = new Date(Date.now() - days * 86400000);

      const rows = await db
        .select({
          formId: analyticsEvents.formId,
          eventName: analyticsEvents.eventName,
          cnt: count(analyticsEvents.id),
        })
        .from(analyticsEvents)
        .where(gte(analyticsEvents.occurredAt, since))
        .groupBy(analyticsEvents.formId, analyticsEvents.eventName)
        .limit(200);

      res.json({ rows, days });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/analytics/conversion-events", isDashboardUser, async (req, res) => {
    try {
      const { analyticsEvents } = await import("@shared/schema");
      const { gte, desc } = await import("drizzle-orm");
      const days = parseInt(String(req.query.days || "7"), 10);
      const since = new Date(Date.now() - days * 86400000);
      const limit = Math.min(parseInt(String(req.query.limit || "200"), 10), 500);
      const eventName = req.query.event ? String(req.query.event) : undefined;

      const query = db
        .select()
        .from(analyticsEvents)
        .where(gte(analyticsEvents.occurredAt, since))
        .orderBy(desc(analyticsEvents.occurredAt))
        .limit(limit);

      const rows = await query;
      const filtered = eventName ? rows.filter(r => r.eventName === eventName) : rows;

      res.json({ events: filtered, days });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/analytics/channel-block-summary", isDashboardUser, async (req, res) => {
    try {
      const { analyticsEvents } = await import("@shared/schema");
      const { gte, count, inArray } = await import("drizzle-orm");
      const days = parseInt(String(req.query.days || "30"), 10);
      const since = new Date(Date.now() - days * 86400000);

      const rows = await db
        .select({
          channel: analyticsEvents.channel,
          blockReason: analyticsEvents.blockReason,
          cnt: count(analyticsEvents.id),
        })
        .from(analyticsEvents)
        .where(gte(analyticsEvents.occurredAt, since))
        .groupBy(analyticsEvents.channel, analyticsEvents.blockReason)
        .limit(100);

      res.json({ rows, days });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/analytics/record-event", isDashboardUser, async (req, res) => {
    try {
      const { recordAnalyticsEvent } = await import("../services/analytics-events");
      const { ALL_CANONICAL_EVENTS } = await import("@shared/analytics-events");
      const { eventName, ...rest } = req.body;
      if (!eventName || !ALL_CANONICAL_EVENTS.has(eventName)) {
        return res.status(400).json({ message: "Invalid or missing eventName" });
      }
      await recordAnalyticsEvent({ eventName, ...rest });
      res.json({ ok: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Public endpoint — no auth required (called from public pages and authenticated CRM pages alike)
  app.post("/api/analytics/phone-call-click", publicLeadRateLimit, async (req, res) => {
    try {
      const { recordAnalyticsEvent } = await import("../services/analytics-events");
      const { contactId, dealId, sourcePage, sessionId, visitorId } = req.body;
      await recordAnalyticsEvent({
        eventName: "phone_call_click",
        contactId: typeof contactId === "number" ? contactId : undefined,
        dealId: typeof dealId === "number" ? dealId : undefined,
        pagePath: typeof sourcePage === "string" ? sourcePage : undefined,
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        visitorId: typeof visitorId === "string" ? visitorId : undefined,
        occurredAt: new Date(),
      });
      res.json({ ok: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/analytics/noop", (_req, res) => {
    res.status(204).end();
  });

  app.get("/api/public/booking-confirmed", async (req, res) => {
    try {
      const bookingTrackingId = String(req.query.btk || "");
      if (!bookingTrackingId || bookingTrackingId.length < 5) {
        return res.status(204).end();
      }
      const { recordAnalyticsEvent } = await import("../services/analytics-events");
      await recordAnalyticsEvent({
        eventName: "appointment_booked",
        bookingTrackingId,
        pagePath: "/booking-confirmation",
        metadata: { source: "booking_bridge", btk: bookingTrackingId },
      });
      res.redirect(302, "/thanks-call");
    } catch {
      res.redirect(302, "/thanks-call");
    }
  });

  // ── Newsletter article signup attribution ────────────────────────────────
  app.get("/api/analytics/newsletter-article-signups", isAuthenticated, isDashboardUser, async (_req, res) => {
    try {
      const rows = await pool.query<{ article_slug: string; signup_count: string; last_signup_at: string }>(`
        SELECT
          cse.metadata->>'source_article' AS article_slug,
          COUNT(*)::text                  AS signup_count,
          MAX(cse.created_at)::text       AS last_signup_at
        FROM contact_source_events cse
        WHERE cse.source_type = 'newsletter_signup'
          AND cse.metadata->>'source_article' IS NOT NULL
          AND cse.metadata->>'source_article' <> ''
        GROUP BY cse.metadata->>'source_article'
        ORDER BY signup_count DESC, last_signup_at DESC
        LIMIT 50
      `);
      res.json(
        rows.rows.map((r) => ({
          articleSlug: r.article_slug,
          signupCount: parseInt(r.signup_count, 10),
          lastSignupAt: r.last_signup_at,
        }))
      );
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/analytics/weekly-outreach
  // #596 — Count outreach actions taken this week from audit_logs
  app.get("/api/analytics/weekly-outreach", isDashboardUser, async (req, res) => {
    try {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
      weekStart.setHours(0, 0, 0, 0);
      const result = await pool.query<{ action: string; cnt: string }>(`
        SELECT action, COUNT(*)::text AS cnt
        FROM audit_logs
        WHERE action IN ('call_logged', 'email_sent', 'sequence_email_sent', 'sms_sent', 'contact_created')
          AND created_at >= $1
        GROUP BY action
      `, [weekStart.toISOString()]);
      const counts: Record<string, number> = {};
      let total = 0;
      for (const row of result.rows) {
        counts[row.action] = Number(row.cnt);
        total += Number(row.cnt);
      }
      res.json({ weekStart: weekStart.toISOString(), total, counts });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/analytics/deals-closing-this-month
  // #598 — Deals with expected close / go-live date this month.
  // For agents: scoped to their portfolio via agent_merchants (same ownership model as /api/my-day).
  // For admins/managers: returns the full org-wide list.
  app.get("/api/analytics/deals-closing-this-month", isDashboardUser, async (req, res) => {
    try {
      const currentUser = req.user as any;
      const role = currentUser?.role as string | undefined;
      const isAgent = role === "agent";

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      if (isAgent) {
        // Resolve the agent record for the authenticated user
        const agentRows = await db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.userId, String(currentUser.id)))
          .limit(1);
        const agentRecord = agentRows[0] ?? null;

        if (!agentRecord) {
          return res.json({ count: 0, deals: [] });
        }

        // Get deal IDs linked to this agent via agent_merchants (same as /api/my-day)
        const amRows = await db
          .select({ dealId: agentMerchants.dealId })
          .from(agentMerchants)
          .where(eq(agentMerchants.agentId, agentRecord.id));

        const agentDealIds = amRows
          .map(r => r.dealId)
          .filter((id): id is number => typeof id === "number" && !isNaN(id));

        if (agentDealIds.length === 0) {
          return res.json({ count: 0, deals: [] });
        }

        // Count deals closing this month within the agent's portfolio
        const agentDeals = await db
          .select({ id: deals.id })
          .from(deals)
          .where(
            and(
              isNull(deals.archivedAt),
              inArray(deals.id, agentDealIds),
              gte(deals.expectedGoLiveDate, monthStart),
              lte(deals.expectedGoLiveDate, monthEnd),
              sql`${deals.stage} NOT IN ('Closed Won', 'Closed Lost')`
            )
          );
        return res.json({ count: agentDeals.length, deals: [] });
      }

      // Admins / managers: return full org-wide list
      const fullResult = await pool.query<{ id: string; stage: string; expected_go_live_date: string | null }>(`
        SELECT id, stage, expected_go_live_date
        FROM deals
        WHERE archived_at IS NULL AND record_class = 'production'
          AND stage NOT IN ('Closed Won', 'Closed Lost')
          AND (expected_go_live_date BETWEEN $1 AND $2)
        ORDER BY expected_go_live_date ASC
        LIMIT 20
      `, [monthStart.toISOString(), monthEnd.toISOString()]);
      res.json({ count: fullResult.rows.length, deals: fullResult.rows.map(r => ({ id: Number(r.id), stage: r.stage, expectedGoLiveDate: r.expected_go_live_date })) });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GET /api/analytics/lifecycle-distribution
  // #533 — Count of contacts per lifecycle_state (excluding archived)
  app.get("/api/analytics/lifecycle-distribution", isDashboardUser, async (req, res) => {
    let client: import("pg").PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '2500ms'");
      const result = await client.query<{ lifecycle_state: string | null; cnt: string }>(`
        SELECT lifecycle_state, COUNT(*)::text AS cnt
        FROM contacts
        WHERE archived_at IS NULL AND record_class = 'production'
        GROUP BY lifecycle_state
        ORDER BY COUNT(*) DESC, lifecycle_state NULLS LAST
      `);
      const distribution: Record<string, number> = {};
      let total = 0;
      for (const row of result.rows) {
        const key = row.lifecycle_state ?? "unknown";
        const count = Number(row.cnt);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error("lifecycle_count_out_of_range");
        }
        distribution[key] = count;
        total += count;
      }
      await client.query("COMMIT");
      res.json({ distribution, total, available: true, sampledAt: new Date().toISOString() });
    } catch (err: any) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.error("[Analytics] lifecycle distribution unavailable:", err?.message);
      res.status(503).json({
        distribution: null,
        total: null,
        available: false,
        sampledAt: new Date().toISOString(),
        error: "lifecycle_distribution_unavailable",
      });
    } finally {
      client?.release();
    }
  });

}
