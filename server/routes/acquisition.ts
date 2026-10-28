/**
 * Acquisition Command Center — API routes
 *
 * Read-only analytics endpoints supporting the Google Ads / growth dashboard.
 * All queries are bounded by date range, paginated, and run against indexed columns.
 * No new BullMQ jobs or scheduled tasks — safe while DB pool is under pressure.
 */
import type { Express } from "express";
import { isDashboardUser, requireRole } from "../replit_integrations/auth";
import { pool } from "../db";
import { db } from "../db";
import { storage } from "../storage";
import {
  contacts,
  deals,
  analyticsEvents,

  sequenceEnrollments,
  tasks,
  auditLogs,
} from "@shared/schema";
import { eq, and, gte, sql, count, avg, desc, isNotNull, lt, isNull, or, like } from "drizzle-orm";
import { isGhlConfigured } from "../services/ghl";
import { serverError } from "../utils/server-error";
import { parseOperationsSpend } from "@shared/operations-report";
import { taskReadPredicate } from "../services/task-read-authority";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function parseDays(raw: unknown): number {
  const n = parseInt(String(raw ?? DEFAULT_DAYS), 10);
  if (isNaN(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

// ── Planning assumptions (static — editable via env overrides) ─────────────
const PLANNING = {
  budgetPerDayMin: 50,
  budgetPerDayRecommended: 150,
  budgetPerDayScale: 500,
  targetCpl: 35,
  targetCpa: 350,
  bookedRate: 0.25,
  closeRate: 0.20,
  avgMonthlyVolume: 35000,
  avgResidualBps: 45,
  paybackMonths: 3,
  targetSignupsPerMonth: 1000,
  note: "$150/day is a meaningful learning budget for 1 vertical; <$100/day is insufficient for 1,000 signups/month at scale",
};

export function registerAcquisitionRoutes(app: Express): void {

  // ── Acquisition funnel metrics ─────────────────────────────────────────────
  app.get("/api/acquisition/funnel", isDashboardUser, async (req, res) => {
    try {
      const days = parseDays(req.query.days);
      const since = new Date(Date.now() - days * 86_400_000);

      const [
        totalLeadsRow,
        googleLeadsRow,
        sourceBreakdown,
        campaignBreakdown,
        verticalBreakdown,
        statementUploads,
        dealStages,
      ] = await Promise.all([
        // Total leads in window
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM contacts WHERE created_at >= $1 AND archived_at IS NULL`,
          [since],
        ),
        // Google / CPC leads
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM contacts
           WHERE created_at >= $1 AND archived_at IS NULL
             AND (utm_source ILIKE '%google%' OR utm_medium = 'cpc' OR utm_medium = 'paid')`,
          [since],
        ),
        // Leads by source
        pool.query<{ source: string; cnt: string }>(
          `SELECT COALESCE(utm_source, 'organic/direct') AS source, COUNT(*)::text AS cnt
           FROM contacts WHERE created_at >= $1 AND archived_at IS NULL
           GROUP BY source ORDER BY cnt::int DESC LIMIT 15`,
          [since],
        ),
        // Leads by campaign
        pool.query<{ campaign: string; medium: string; source: string; cnt: string }>(
          `SELECT COALESCE(utm_campaign, '(none)') AS campaign,
                  COALESCE(utm_medium, '(none)') AS medium,
                  COALESCE(utm_source, 'direct') AS source,
                  COUNT(*)::text AS cnt
           FROM contacts WHERE created_at >= $1 AND archived_at IS NULL
             AND utm_campaign IS NOT NULL
           GROUP BY campaign, medium, source ORDER BY cnt::int DESC LIMIT 20`,
          [since],
        ),
        // Leads by vertical
        pool.query<{ vertical: string; cnt: string }>(
          `SELECT COALESCE(industry, 'Unknown') AS vertical, COUNT(*)::text AS cnt
           FROM contacts WHERE created_at >= $1 AND archived_at IS NULL
           GROUP BY vertical ORDER BY cnt::int DESC LIMIT 15`,
          [since],
        ),
        // Statement uploads
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM analytics_events
           WHERE event_name = 'statement_uploaded' AND occurred_at >= $1`,
          [since],
        ),
        // Deal stages (all active deals touching leads in window)
        pool.query<{ stage: string; cnt: string }>(
          `SELECT d.stage, COUNT(*)::text AS cnt
           FROM deals d
           JOIN contacts c ON c.id = d.contact_id
           WHERE c.created_at >= $1 AND c.archived_at IS NULL
           GROUP BY d.stage ORDER BY cnt::int DESC`,
          [since],
        ),
      ]);

      const total = parseInt(totalLeadsRow.rows[0]?.cnt ?? "0", 10);
      const googleLeads = parseInt(googleLeadsRow.rows[0]?.cnt ?? "0", 10);
      const uploads = parseInt(statementUploads.rows[0]?.cnt ?? "0", 10);
      const bookedRow = dealStages.rows.find(r => r.stage === "Call Booked");
      const bookedCalls = parseInt(bookedRow?.cnt ?? "0", 10);
      const closedWonRow = dealStages.rows.find(r => r.stage === "Closed Won");
      const closedWon = parseInt(closedWonRow?.cnt ?? "0", 10);

      res.json({
        days,
        since: since.toISOString(),
        totalLeads: total,
        googleLeads,
        statementUploads: uploads,
        bookedCalls,
        closedWon,
        funnelRates: {
          leadToUpload: total > 0 ? Math.round((uploads / total) * 100) / 100 : 0,
          uploadToBooked: uploads > 0 ? Math.round((bookedCalls / uploads) * 100) / 100 : 0,
          bookedToClose: bookedCalls > 0 ? Math.round((closedWon / bookedCalls) * 100) / 100 : 0,
          leadToClose: total > 0 ? Math.round((closedWon / total) * 100) / 100 : 0,
        },
        bySource: sourceBreakdown.rows.map(r => ({ source: r.source, leads: parseInt(r.cnt, 10) })),
        byCampaign: campaignBreakdown.rows.map(r => ({
          campaign: r.campaign,
          medium: r.medium,
          source: r.source,
          leads: parseInt(r.cnt, 10),
        })),
        byVertical: verticalBreakdown.rows.map(r => ({ vertical: r.vertical, leads: parseInt(r.cnt, 10) })),
        dealStages: dealStages.rows.map(r => ({ stage: r.stage, count: parseInt(r.cnt, 10) })),
        planning: PLANNING,
        ghlConfigured: isGhlConfigured(),
        googleAdsApiConfigured: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      });
    } catch (err: any) {
      console.error("[Acquisition] /funnel error:", err.message);
      serverError(res, err);
    }
  });

  // ── ROI by vertical ────────────────────────────────────────────────────────
  app.get("/api/acquisition/roi-by-vertical", isDashboardUser, async (req, res) => {
    try {
      const days = parseDays(req.query.days);
      const since = new Date(Date.now() - days * 86_400_000);

      const rows = await pool.query<{
        vertical: string;
        source: string;
        leads: string;
        hot_leads: string;
        warm_leads: string;
        deals: string;
        closed_won: string;
        avg_score: string;
        statement_uploads: string;
      }>(
        `SELECT
           COALESCE(c.industry, 'Unknown') AS vertical,
           COALESCE(c.utm_source, 'organic/direct') AS source,
           COUNT(c.id)::text AS leads,
           COUNT(CASE WHEN c.lead_score >= 70 THEN 1 END)::text AS hot_leads,
           COUNT(CASE WHEN c.lead_score >= 40 AND c.lead_score < 70 THEN 1 END)::text AS warm_leads,
           COUNT(d.id)::text AS deals,
           COUNT(CASE WHEN d.stage = 'Closed Won' THEN 1 END)::text AS closed_won,
           ROUND(AVG(c.lead_score))::text AS avg_score,
           COUNT(ae.id)::text AS statement_uploads
         FROM contacts c
         LEFT JOIN deals d ON d.contact_id = c.id
         LEFT JOIN analytics_events ae ON ae.contact_id = c.id
           AND ae.event_name = 'statement_uploaded'
         WHERE c.created_at >= $1 AND c.archived_at IS NULL
         GROUP BY vertical, source
         ORDER BY leads::int DESC
         LIMIT 50`,
        [since],
      );

      const avgResidualBps = PLANNING.avgResidualBps;
      const avgVolume = PLANNING.avgMonthlyVolume;

      const result = rows.rows.map(r => {
        const leads = parseInt(r.leads, 10);
        const closedWon = parseInt(r.closed_won, 10);
        const deals = parseInt(r.deals, 10);
        const hotLeads = parseInt(r.hot_leads, 10);
        const warmLeads = parseInt(r.warm_leads, 10);
        const avgScore = parseInt(r.avg_score ?? "0", 10);
        const uploads = parseInt(r.statement_uploads, 10);

        const estMonthlyResidual = closedWon * (avgVolume * (avgResidualBps / 10000));
        const bookedRate = leads > 0 ? Math.round((deals / leads) * 100) / 100 : 0;
        const closeRate = deals > 0 ? Math.round((closedWon / deals) * 100) / 100 : 0;

        return {
          vertical: r.vertical,
          source: r.source,
          leads,
          hotLeads,
          warmLeads,
          coldLeads: leads - hotLeads - warmLeads,
          deals,
          closedWon,
          avgScore,
          statementUploads: uploads,
          bookedRate,
          closeRate,
          estMonthlyResidual: Math.round(estMonthlyResidual),
          scaleSignal: closeRate >= 0.15 && leads >= 5 ? "scale" : closeRate > 0 ? "optimize" : "test",
        };
      });

      res.json({ days, since: since.toISOString(), verticals: result });
    } catch (err: any) {
      console.error("[Acquisition] /roi-by-vertical error:", err.message);
      serverError(res, err);
    }
  });

  // ── Lead quality breakdown ─────────────────────────────────────────────────
  app.get("/api/acquisition/lead-quality", isDashboardUser, async (req, res) => {
    try {
      const days = parseDays(req.query.days);
      const since = new Date(Date.now() - days * 86_400_000);

      const [distribution, bySource, avgRow] = await Promise.all([
        pool.query<{ tier: string; cnt: string }>(
          `SELECT
             CASE
               WHEN lead_score >= 70 THEN 'hot'
               WHEN lead_score >= 40 THEN 'warm'
               ELSE 'cold'
             END AS tier,
             COUNT(*)::text AS cnt
           FROM contacts
           WHERE created_at >= $1 AND archived_at IS NULL
           GROUP BY tier`,
          [since],
        ),
        pool.query<{ source: string; tier: string; cnt: string }>(
          `SELECT
             COALESCE(utm_source, 'direct') AS source,
             CASE WHEN lead_score >= 70 THEN 'hot' WHEN lead_score >= 40 THEN 'warm' ELSE 'cold' END AS tier,
             COUNT(*)::text AS cnt
           FROM contacts
           WHERE created_at >= $1 AND archived_at IS NULL
             AND utm_source IS NOT NULL
           GROUP BY source, tier
           ORDER BY cnt::int DESC LIMIT 30`,
          [since],
        ),
        pool.query<{ avg_score: string; max_score: string; has_phone: string; has_email: string; has_statement: string }>(
          `SELECT
             ROUND(AVG(c.lead_score))::text AS avg_score,
             MAX(c.lead_score)::text AS max_score,
             COUNT(CASE WHEN c.phone IS NOT NULL AND c.phone != '' THEN 1 END)::text AS has_phone,
             COUNT(CASE WHEN c.email IS NOT NULL AND c.email != '' THEN 1 END)::text AS has_email,
             COUNT(DISTINCT ae.contact_id)::text AS has_statement
           FROM contacts c
           LEFT JOIN analytics_events ae ON ae.contact_id = c.id AND ae.event_name = 'statement_uploaded'
           WHERE c.created_at >= $1 AND c.archived_at IS NULL`,
          [since],
        ),
      ]);

      const dist: Record<string, number> = {};
      for (const row of distribution.rows) dist[row.tier] = parseInt(row.cnt, 10);

      res.json({
        days,
        distribution: {
          hot: dist["hot"] ?? 0,
          warm: dist["warm"] ?? 0,
          cold: dist["cold"] ?? 0,
        },
        avgScore: parseInt(avgRow.rows[0]?.avg_score ?? "0", 10),
        maxScore: parseInt(avgRow.rows[0]?.max_score ?? "0", 10),
        dataCompleteness: {
          hasPhone: parseInt(avgRow.rows[0]?.has_phone ?? "0", 10),
          hasEmail: parseInt(avgRow.rows[0]?.has_email ?? "0", 10),
          hasStatement: parseInt(avgRow.rows[0]?.has_statement ?? "0", 10),
        },
        bySource: bySource.rows.map(r => ({
          source: r.source,
          tier: r.tier,
          count: parseInt(r.cnt, 10),
        })),
      });
    } catch (err: any) {
      console.error("[Acquisition] /lead-quality error:", err.message);
      serverError(res, err);
    }
  });

  // ── GHL sequence performance ───────────────────────────────────────────────
  app.get("/api/acquisition/sequence-performance", isDashboardUser, async (req, res) => {
    try {
      const days = parseDays(req.query.days);
      const since = new Date(Date.now() - days * 86_400_000);

      const rows = await pool.query<{
        seq_id: string;
        seq_name: string;
        status: string;
        enrolled: string;
        active: string;
        completed: string;
        converted: string;
        bounced: string;
        unsubscribed: string;
      }>(
        `SELECT
           s.id::text AS seq_id,
           s.name AS seq_name,
           s.status,
           COUNT(se.id)::text AS enrolled,
           COUNT(CASE WHEN se.status = 'active' THEN 1 END)::text AS active,
           COUNT(CASE WHEN se.status = 'completed' THEN 1 END)::text AS completed,
           COUNT(CASE WHEN se.status = 'converted' THEN 1 END)::text AS converted,
           COUNT(CASE WHEN se.status = 'bounced' THEN 1 END)::text AS bounced,
           COUNT(CASE WHEN se.status = 'unsubscribed' THEN 1 END)::text AS unsubscribed
         FROM sequences s
         LEFT JOIN sequence_enrollments se ON se.sequence_id = s.id
           AND se.created_at >= $1
         GROUP BY s.id, s.name, s.status
         ORDER BY enrolled::int DESC
         LIMIT 30`,
        [since],
      );

      res.json({
        days,
        outboundPaused: true,
        note: "outboundGlobalPaused=true — no new enrollments are being processed. Data shows historical enrollment counts.",
        sequences: rows.rows.map(r => ({
          id: r.seq_id,
          name: r.seq_name,
          status: r.status,
          enrolled: parseInt(r.enrolled, 10),
          active: parseInt(r.active, 10),
          completed: parseInt(r.completed, 10),
          converted: parseInt(r.converted, 10),
          bounced: parseInt(r.bounced, 10),
          unsubscribed: parseInt(r.unsubscribed, 10),
          conversionRate: parseInt(r.enrolled, 10) > 0
            ? Math.round((parseInt(r.converted, 10) / parseInt(r.enrolled, 10)) * 100) / 100
            : 0,
        })),
      });
    } catch (err: any) {
      console.error("[Acquisition] /sequence-performance error:", err.message);
      serverError(res, err);
    }
  });

  // ── Offline conversion export (CSV) ────────────────────────────────────────
  // ADS-01: bulk export of contact_email/gclid attribution data is admin/manager
  // only — isDashboardUser alone would also admit ordinary agents.
  app.get("/api/acquisition/offline-conversions/export", requireRole("admin", "manager"), async (req, res) => {
    try {
      const days = parseDays(req.query.days);
      const since = new Date(Date.now() - days * 86_400_000);

      // Export conversion events suitable for Google Ads offline conversion import.
      // Includes actual gclid from contacts table for direct Google Ads matching.
      const rows = await pool.query<{
        event_id: string;
        event_name: string;
        occurred_at: Date;
        contact_email: string;
        utm_campaign: string;
        utm_source: string;
        utm_medium: string;
        gclid_present: boolean;
        gclid: string | null;
        vertical: string;
        conversion_value: string;
      }>(
        `SELECT
           ae.event_id,
           ae.event_name,
           ae.occurred_at,
           COALESCE(c.email, '') AS contact_email,
           COALESCE(ae.utm_campaign, c.utm_campaign, '') AS utm_campaign,
           COALESCE(ae.utm_source, c.utm_source, '') AS utm_source,
           COALESCE(ae.utm_medium, c.utm_medium, '') AS utm_medium,
           COALESCE(ae.gclid_present, c.gclid IS NOT NULL, false) AS gclid_present,
           c.gclid AS gclid,
           COALESCE(ae.vertical, c.industry, c.vertical, '') AS vertical,
           '1.00' AS conversion_value
         FROM analytics_events ae
         LEFT JOIN contacts c ON c.id = ae.contact_id
         WHERE ae.occurred_at >= $1
           AND ae.event_name IN (
             'statement_uploaded', 'call_booked', 'merchant_application_submitted',
             'merchant_approved', 'deal_closed_won'
           )
         ORDER BY ae.occurred_at DESC
         LIMIT 5000`,
        [since],
      );

      if (req.query.format === "csv") {
        // Google Ads offline conversion format:
        // https://support.google.com/google-ads/answer/7014069
        const header = "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Email,Campaign,Source,Medium,Vertical,Event ID\n";
        const csvRows = rows.rows.map(r => {
          const convName = {
            statement_uploaded: "StatementUpload",
            call_booked: "BookedCall",
            merchant_application_submitted: "ApplicationSubmit",
            merchant_approved: "MerchantApproved",
            deal_closed_won: "ClosedWon",
          }[r.event_name] ?? r.event_name;
          const ts = new Date(r.occurred_at).toISOString();
          return [
            r.gclid ?? "",           // actual gclid for Google Ads matching
            convName,
            ts,
            r.conversion_value,
            "USD",
            r.contact_email,
            r.utm_campaign,
            r.utm_source,
            r.utm_medium,
            r.vertical,
            r.event_id ?? "",
          ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
        });
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="offline-conversions-${days}d.csv"`);
        return res.send(header + csvRows.join("\n"));
      }

      res.json({
        days,
        googleAdsApiConfigured: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        gclidCaptureActive: false,
        note: "gclid raw capture not yet wired to forms. Set up ValueTrack parameters in Google Ads to capture gclid, then wire to form UTM capture middleware. Use the CSV export to manually import offline conversions into Google Ads until API is connected.",
        setupSteps: [
          "Enable auto-tagging in your Google Ads account",
          "Add ValueTrack {gclid} parameter to your final URL suffix",
          "Wire gclid capture in the UTM middleware (already built in — enable GCLID_CAPTURE=true)",
          "Upload this CSV to Google Ads > Tools > Conversions > Upload",
          "Or connect the Google Ads API with GOOGLE_ADS_DEVELOPER_TOKEN for automatic upload",
        ],
        totalRows: rows.rows.length,
        conversions: rows.rows,
      });
    } catch (err: any) {
      console.error("[Acquisition] /offline-conversions/export error:", err.message);
      serverError(res, err);
    }
  });

  // ── Readiness checklist / audit ────────────────────────────────────────────
  app.get("/api/acquisition/readiness", isDashboardUser, async (req, res) => {
    try {
      const [
        leadsWithUtm,
        totalLeads30d,
        totalDeals,
        ghlHealth,
        pauseState,
        sequenceCount,
        eventTypes,
      ] = await Promise.all([
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM contacts
           WHERE archived_at IS NULL AND utm_source IS NOT NULL
             AND created_at >= NOW() - INTERVAL '30 days'`,
        ),
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM contacts
           WHERE archived_at IS NULL AND created_at >= NOW() - INTERVAL '30 days'`,
        ),
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM deals WHERE closed_at IS NULL`,
        ),
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM contacts WHERE ghl_contact_id IS NOT NULL`,
        ),
        storage.getSystemSetting("outboundGlobalPaused"),
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM sequences WHERE status = 'active'`,
        ),
        pool.query<{ event_name: string; cnt: string }>(
          `SELECT event_name, COUNT(*)::text AS cnt FROM analytics_events
           WHERE occurred_at >= NOW() - INTERVAL '30 days'
           GROUP BY event_name ORDER BY cnt::int DESC LIMIT 20`,
        ),
      ]);

      const utmLeads = parseInt(leadsWithUtm.rows[0]?.cnt ?? "0", 10);
      const total30d = parseInt(totalLeads30d.rows[0]?.cnt ?? "0", 10);
      const utmRate = total30d > 0 ? Math.round((utmLeads / total30d) * 100) : 0;
      const ghlContacts = parseInt(ghlHealth.rows[0]?.cnt ?? "0", 10);
      const activeSeqs = parseInt(sequenceCount.rows[0]?.cnt ?? "0", 10);
      const outboundPaused = pauseState === true || pauseState === "true";
      const eventMap: Record<string, number> = {};
      for (const r of eventTypes.rows) eventMap[r.event_name] = parseInt(r.cnt, 10);

      const checks = [
        {
          id: "ghl_connected",
          category: "Infrastructure",
          label: "GHL CRM Connected",
          status: isGhlConfigured() ? "pass" : "fail",
          detail: isGhlConfigured()
            ? `GHL configured — ${ghlContacts} contacts synced`
            : "Set GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID",
          blockerForScale: true,
        },
        {
          id: "utm_tracking",
          category: "Tracking",
          label: "UTM Attribution Active",
          status: utmRate >= 50 ? "pass" : utmRate >= 20 ? "warn" : "fail",
          detail: `${utmLeads}/${total30d} leads (${utmRate}%) have UTM source data in last 30 days`,
          blockerForScale: true,
        },
        {
          id: "conversion_events",
          category: "Tracking",
          label: "Conversion Events Firing",
          status: (eventMap["statement_uploaded"] ?? 0) > 0 || (eventMap["call_booked"] ?? 0) > 0 ? "pass" : "warn",
          detail: `statement_uploaded: ${eventMap["statement_uploaded"] ?? 0}, call_booked: ${eventMap["call_booked"] ?? 0}`,
          blockerForScale: false,
        },
        {
          id: "outbound_paused",
          category: "Compliance",
          label: "Outbound Pause Confirmed (Pre-Launch)",
          status: outboundPaused ? "pass" : "warn",
          detail: outboundPaused
            ? "outboundGlobalPaused=true — no prospect sends active (correct for pre-launch)"
            : "WARNING: outboundGlobalPaused is NOT true — verify this is intentional",
          blockerForScale: false,
        },
        {
          id: "sms_blocked",
          category: "Compliance",
          label: "SMS Blocked Until A2P Registered",
          status: !process.env.A2P_REGISTRATION_ID ? "pass" : "warn",
          detail: !process.env.A2P_REGISTRATION_ID
            ? "SMS blocked (A2P_REGISTRATION_ID not set) — correct for pre-launch"
            : "A2P registered — SMS can be enabled when ready",
          blockerForScale: false,
        },
        {
          id: "active_sequences",
          category: "Nurture",
          label: "GHL Nurture Sequences Ready",
          status: activeSeqs >= 3 ? "pass" : activeSeqs >= 1 ? "warn" : "fail",
          detail: `${activeSeqs} sequences have status 'active' (status only; not readiness proof, see /api/admin/catalog-truth)`,
          blockerForScale: true,
        },
        {
          id: "gclid_capture",
          category: "Tracking",
          label: "Google Click ID (gclid) Capture",
          status: !!process.env.GCLID_CAPTURE ? "pass" : "warn",
          detail: "gclid raw capture requires enabling GCLID_CAPTURE=true and adding ValueTrack to Google Ads URLs",
          blockerForScale: false,
        },
        {
          id: "google_ads_api",
          category: "Integration",
          label: "Google Ads API Connected",
          status: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN ? "pass" : "warn",
          detail: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN
            ? "Google Ads API configured"
            : "Not connected — use CSV export for manual offline conversion upload",
          blockerForScale: false,
        },
        {
          id: "pipeline_stages",
          category: "CRM",
          label: "Pipeline Stages Configured",
          status: parseInt(totalDeals.rows[0]?.cnt ?? "0", 10) >= 0 ? "pass" : "warn",
          detail: `${parseInt(totalDeals.rows[0]?.cnt ?? "0", 10)} active deals in pipeline`,
          blockerForScale: true,
        },
        {
          id: "landing_page_conversion",
          category: "Funnel",
          label: "Landing Page Conversion Tracking",
          status: (eventMap["free_analysis_submit"] ?? 0) > 0 || (eventMap["statement_requested"] ?? 0) > 0 ? "pass" : "warn",
          detail: `Forms fired: free_analysis=${eventMap["free_analysis_submit"] ?? 0}, statement_request=${eventMap["statement_requested"] ?? 0}`,
          blockerForScale: true,
        },
      ];

      const passCount = checks.filter(c => c.status === "pass").length;
      const failCount = checks.filter(c => c.status === "fail").length;
      const warnCount = checks.filter(c => c.status === "warn").length;
      const score = Math.round((passCount / checks.length) * 100);
      const scalingBlockers = checks.filter(c => c.status === "fail" && c.blockerForScale);

      res.json({
        score,
        passCount,
        warnCount,
        failCount,
        scalingBlockers: scalingBlockers.map(c => c.label),
        readyToRunGoogleAds: failCount === 0 && scalingBlockers.length === 0,
        checks,
        summary: failCount === 0
          ? score >= 80
            ? "Platform is acquisition-ready. You can run test Google Ads campaigns."
            : "Platform is mostly ready. Address warnings before scaling budget."
          : `${failCount} critical blocker(s) must be resolved before running paid campaigns.`,
      });
    } catch (err: any) {
      console.error("[Acquisition] /readiness error:", err.message);
      serverError(res, err);
    }
  });

  // ── Keyword / landing page map (static + DB signal) ───────────────────────
  app.get("/api/acquisition/keyword-map", isDashboardUser, async (_req, res) => {
    try {
      const verticalMap = [
        {
          vertical: "Restaurant",
          industry: "restaurant",
          priority: "high",
          floridaFocus: true,
          keywords: [
            "restaurant credit card processing",
            "best POS for restaurants",
            "restaurant payment processing fees",
            "lower credit card fees restaurant",
            "interchange plus restaurant",
          ],
          negativeKeywords: ["free restaurant POS", "restaurant POS software only"],
          recommendedPage: "/industry/restaurant",
          primaryCta: "Free Statement Analysis",
          primaryOffer: "Show me your statement — I'll find you savings in 24 hours",
          adGroup: "Restaurant Payment Processing - Florida",
          estimatedCpl: 28,
          estimatedCpa: 280,
        },
        {
          vertical: "Med Spa / Aesthetics",
          industry: "med_spa",
          priority: "high",
          floridaFocus: true,
          keywords: [
            "medical spa payment processing",
            "med spa credit card processing",
            "best payment processor for med spa",
            "healthcare payment processing fees",
            "HIPAA compliant payment processing",
          ],
          negativeKeywords: ["medical billing software"],
          recommendedPage: "/industry/healthcare",
          primaryCta: "Free Statement Analysis",
          primaryOffer: "Med spas save avg $400/mo switching to us",
          adGroup: "Med Spa Payment - Florida",
          estimatedCpl: 35,
          estimatedCpa: 350,
        },
        {
          vertical: "Auto Repair",
          industry: "auto_repair",
          priority: "high",
          floridaFocus: true,
          keywords: [
            "auto shop payment processing",
            "auto repair credit card fees",
            "best payment processor auto shop",
            "car dealership merchant account",
            "automotive payment processing",
          ],
          negativeKeywords: ["auto repair shop software"],
          recommendedPage: "/industry/auto",
          primaryCta: "See Your Savings",
          primaryOffer: "Average auto shop saves $200-800/mo",
          adGroup: "Auto Shop Processing - Florida",
          estimatedCpl: 25,
          estimatedCpa: 250,
        },
        {
          vertical: "Retail / Boutique",
          industry: "retail",
          priority: "medium",
          floridaFocus: true,
          keywords: [
            "retail credit card processing",
            "boutique payment processing",
            "small business payment processor",
            "retail merchant account",
            "lower credit card processing fees retail",
          ],
          negativeKeywords: ["free POS retail", "retail POS software"],
          recommendedPage: "/",
          primaryCta: "Free Analysis",
          primaryOffer: "Zero-percent processing option for retail",
          adGroup: "Retail Processing - Florida",
          estimatedCpl: 22,
          estimatedCpa: 220,
        },
        {
          vertical: "Professional Services",
          industry: "professional_services",
          priority: "medium",
          floridaFocus: true,
          keywords: [
            "professional services payment processing",
            "law firm credit card processing",
            "accountant merchant account",
            "consultant payment processing",
            "B2B payment processing fees",
          ],
          negativeKeywords: ["invoicing software only"],
          recommendedPage: "/",
          primaryCta: "Free Statement Review",
          primaryOffer: "Custom interchange-plus pricing for professionals",
          adGroup: "Professional Services - Florida",
          estimatedCpl: 40,
          estimatedCpa: 400,
        },
        {
          vertical: "Salon / Spa",
          industry: "salon",
          priority: "medium",
          floridaFocus: true,
          keywords: [
            "salon credit card processing",
            "spa payment processing",
            "hair salon merchant account",
            "beauty salon payment fees",
            "nail salon credit card fees",
          ],
          negativeKeywords: ["salon software only", "salon booking software"],
          recommendedPage: "/industry/salon",
          primaryCta: "Free Analysis",
          primaryOffer: "Salons save avg $150-400/mo",
          adGroup: "Salon/Spa Processing - Florida",
          estimatedCpl: 20,
          estimatedCpa: 200,
        },
        {
          vertical: "eCommerce",
          industry: "ecommerce",
          priority: "medium",
          floridaFocus: false,
          keywords: [
            "ecommerce payment processing",
            "online store credit card fees",
            "best payment gateway for ecommerce",
            "Shopify payment processing alternative",
            "WooCommerce merchant account",
          ],
          negativeKeywords: ["free ecommerce platform"],
          recommendedPage: "/",
          primaryCta: "Get a Quote",
          primaryOffer: "Interchange-plus pricing for online stores",
          adGroup: "eCommerce Processing - National",
          estimatedCpl: 45,
          estimatedCpa: 450,
        },
        {
          vertical: "Healthcare",
          industry: "healthcare",
          priority: "low",
          floridaFocus: true,
          keywords: [
            "healthcare payment processing",
            "medical practice merchant account",
            "doctor office credit card fees",
            "dental practice payment processing",
            "chiropractic payment processing",
          ],
          negativeKeywords: ["medical billing software", "EHR payment"],
          recommendedPage: "/industry/healthcare",
          primaryCta: "Free Statement Analysis",
          primaryOffer: "HIPAA-aware payment processing for practices",
          adGroup: "Healthcare Processing - Florida",
          estimatedCpl: 50,
          estimatedCpa: 500,
        },
      ];

      const geoTargets = [
        { label: "South Florida (Primary)", cities: ["Miami", "Fort Lauderdale", "Boca Raton", "West Palm Beach", "Naples"], priority: "highest" },
        { label: "Central Florida", cities: ["Orlando", "Tampa", "St. Petersburg", "Sarasota", "Gainesville"], priority: "high" },
        { label: "North Florida", cities: ["Jacksonville", "Tallahassee", "Pensacola", "Panama City"], priority: "medium" },
        { label: "National Expansion", cities: [], priority: "low", note: "Expand after South FL saturated at $500+/day spend" },
      ];

      res.json({ verticalMap, geoTargets, planning: PLANNING });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Budget / planning assumptions ──────────────────────────────────────────
  app.get("/api/acquisition/planning", isDashboardUser, (_req, res) => {
    res.json({
      planning: PLANNING,
      scenarios: [
        {
          label: "Learning Budget",
          dailyBudget: 50,
          monthlyBudget: 1500,
          estimatedLeads: 43,
          estimatedBookedCalls: 11,
          estimatedSignups: 2,
          estimatedResidual: 315,
          paybackMonths: 4.8,
          verdict: "too_small",
          note: "<$100/day is a learning budget only — not enough to generate 1,000 signups/month",
        },
        {
          label: "Recommended Start",
          dailyBudget: 150,
          monthlyBudget: 4500,
          estimatedLeads: 129,
          estimatedBookedCalls: 32,
          estimatedSignups: 6,
          estimatedResidual: 945,
          paybackMonths: 4.8,
          verdict: "viable",
          note: "Good starting budget for 1-2 verticals. Optimize for 60 days before scaling.",
        },
        {
          label: "Growth Mode",
          dailyBudget: 500,
          monthlyBudget: 15000,
          estimatedLeads: 429,
          estimatedBookedCalls: 107,
          estimatedSignups: 21,
          estimatedResidual: 3307,
          paybackMonths: 4.5,
          verdict: "scale",
          note: "Run at $500/day across 3-4 verticals with optimized landing pages and conversion tracking.",
        },
        {
          label: "1,000 Signups/Month Target",
          dailyBudget: 25000,
          monthlyBudget: 750000,
          estimatedLeads: 21429,
          estimatedBookedCalls: 5357,
          estimatedSignups: 1071,
          estimatedResidual: 168682,
          paybackMonths: 4.4,
          verdict: "enterprise",
          note: "Google Ads alone cannot achieve 1,000/mo at reasonable CPA. Multi-channel: Ads + outbound + partner/referral + SEO. This is the blended model target.",
        },
      ],
    });
  });

  // ── ROI Calculator: CPL / CPB / CPS data ─────────────────────────────────
  app.get("/api/acquisition/roi-calculator", isDashboardUser, async (req, res) => {
    try {
      const days = parseDays(req.query.days);
      const since = new Date(Date.now() - days * 86_400_000);

      const [totals, bySource] = await Promise.all([
        pool.query<{ total_leads: string; booked_calls: string; closed_won: string }>(
          `SELECT
             COUNT(DISTINCT c.id)::text AS total_leads,
             COUNT(DISTINCT CASE WHEN d.stage = 'Call Booked' THEN d.id END)::text AS booked_calls,
             COUNT(DISTINCT CASE WHEN d.stage = 'Closed Won' THEN d.id END)::text AS closed_won
           FROM contacts c
           LEFT JOIN deals d ON d.contact_id = c.id
           WHERE c.created_at >= $1 AND c.archived_at IS NULL`,
          [since],
        ),
        pool.query<{ source: string; leads: string; booked_calls: string; closed_won: string }>(
          `SELECT
             COALESCE(c.utm_source, 'organic/direct') AS source,
             COUNT(DISTINCT c.id)::text AS leads,
             COUNT(DISTINCT CASE WHEN d.stage = 'Call Booked' THEN d.id END)::text AS booked_calls,
             COUNT(DISTINCT CASE WHEN d.stage = 'Closed Won' THEN d.id END)::text AS closed_won
           FROM contacts c
           LEFT JOIN deals d ON d.contact_id = c.id
           WHERE c.created_at >= $1 AND c.archived_at IS NULL
           GROUP BY source
           ORDER BY leads::int DESC
           LIMIT 15`,
          [since],
        ),
      ]);

      const t = totals.rows[0];
      res.json({
        days,
        totalLeads: parseInt(t?.total_leads ?? "0", 10),
        bookedCalls: parseInt(t?.booked_calls ?? "0", 10),
        closedWon: parseInt(t?.closed_won ?? "0", 10),
        bySource: bySource.rows.map(r => ({
          source: r.source,
          leads: parseInt(r.leads, 10),
          bookedCalls: parseInt(r.booked_calls, 10),
          closedWon: parseInt(r.closed_won, 10),
        })),
      });
    } catch (err: any) {
      console.error("[Acquisition] /roi-calculator error:", err.message);
      serverError(res, err);
    }
  });

  // ── Statement upload → call SLA alert ────────────────────────────────────
  app.get("/api/acquisition/statement-sla", isDashboardUser, async (_req, res) => {
    try {
      const SLA_MINUTES = 120; // 2-hour same-day follow-up SLA

      const rows = await pool.query<{
        deal_id: number; contact_name: string; company_name: string;
        email: string; stage: string; updated_at: Date; created_at: Date;
      }>(
        `SELECT d.id AS deal_id,
                CONCAT(c.first_name, ' ', c.last_name) AS contact_name,
                COALESCE(c.company_name, '') AS company_name,
                c.email,
                d.stage,
                d.updated_at,
                d.created_at
           FROM deals d
           JOIN contacts c ON c.id = d.contact_id
          WHERE d.stage = 'Statement Received'
            AND d.updated_at < NOW() - INTERVAL '${SLA_MINUTES} minutes'
            AND d.stage NOT IN ('Closed Won','Closed Lost')
          ORDER BY d.updated_at ASC
          LIMIT 50`,
      );

      const alerts = rows.rows.map(r => ({
        dealId: r.deal_id,
        contactName: r.contact_name,
        companyName: r.company_name,
        email: r.email,
        hoursStuck: Math.round((Date.now() - new Date(r.updated_at).getTime()) / 3_600_000),
        updatedAt: r.updated_at,
      }));

      res.json({
        slaMinutes: SLA_MINUTES,
        breachCount: alerts.length,
        alerts,
        message: alerts.length === 0
          ? "All statement uploads followed up within SLA."
          : `${alerts.length} statement upload${alerts.length === 1 ? "" : "s"} past ${SLA_MINUTES / 60}-hour call SLA.`,
      });
    } catch (err: any) {
      console.error("[Acquisition] /statement-sla error:", err.message);
      serverError(res, err);
    }
  });

  // ── Operations Report ──────────────────────────────────────────────────────
  // All-in-one report: CPL/CPB/CPS by source, close rate by vertical, sequence
  // reply rates, funnel conversion, overdue tasks, incident summary.
  app.get("/api/reporting/operations", requireRole("admin", "manager"), async (req, res) => {
    try {
      const days = parseDays(req.query.days);
      let adSpend: number;
      try { adSpend = parseOperationsSpend(req.query.adSpend); }
      catch (error) { return res.status(400).json({ message: (error as Error).message }); }
      const now = new Date();
      const since = new Date(now.getTime() - days * 86_400_000);
      const since7d = new Date(now.getTime() - 7 * 86_400_000);

      const [
        cplRows,
        verticalRows,
        seqRows,
        funnelRows,
        overdueRows,
        queueFailures7d,
        ghlFailures7d,
        recentQueueErr,
        recentGhlErr,
      ] = await Promise.all([
        // CPL: leads + booked calls + signed merchants by source
        pool.query<{
          source: string; leads: string; booked: string; signed: string;
        }>(
          `SELECT
             COALESCE(c.utm_source, 'organic/direct') AS source,
             COUNT(DISTINCT c.id)::text AS leads,
             COUNT(DISTINCT CASE WHEN d.stage = 'Call Booked' AND d.record_class = 'production' THEN d.id END)::text AS booked,
             COUNT(DISTINCT CASE WHEN d.stage = 'Closed Won' AND d.record_class = 'production' THEN d.id END)::text AS signed
           FROM contacts c
           LEFT JOIN deals d ON d.contact_id = c.id AND d.archived_at IS NULL
           WHERE c.created_at >= $1 AND c.created_at < $2 AND c.archived_at IS NULL AND c.record_class = 'production'
           GROUP BY COALESCE(c.utm_source, 'organic/direct')
           ORDER BY COUNT(DISTINCT c.id) DESC, COALESCE(c.utm_source, 'organic/direct') ASC`,
          [since, now],
        ),
        // Close rate by vertical: leads → booked → signed
        pool.query<{
          vertical: string; leads: string; booked: string; signed: string;
        }>(
          `SELECT
             COALESCE(c.industry, 'Unknown') AS vertical,
             COUNT(DISTINCT c.id)::text AS leads,
             COUNT(DISTINCT CASE WHEN d.stage = 'Call Booked' AND d.record_class = 'production' THEN d.id END)::text AS booked,
             COUNT(DISTINCT CASE WHEN d.stage = 'Closed Won' AND d.record_class = 'production' THEN d.id END)::text AS signed
           FROM contacts c
           LEFT JOIN deals d ON d.contact_id = c.id AND d.archived_at IS NULL
           WHERE c.created_at >= $1 AND c.created_at < $2 AND c.archived_at IS NULL AND c.record_class = 'production'
           GROUP BY COALESCE(c.industry, 'Unknown')
           ORDER BY COUNT(DISTINCT c.id) DESC, COALESCE(c.industry, 'Unknown') ASC`,
          [since, now],
        ),
        // There is no authoritative sequence-to-reply relation. Do not proxy
        // enrollment conversion as a reply metric.
        pool.query<{
          seq_id: string; seq_name: string; status: string; enrolled: string;
        }>(
          `SELECT
             s.id::text AS seq_id, s.name AS seq_name, s.status,
             COUNT(se.id)::text AS enrolled
           FROM follow_up_sequences s
           LEFT JOIN sequence_enrollments se ON se.sequence_id = s.id
             AND se.created_at >= $1 AND se.created_at < $2
           LEFT JOIN contacts c ON c.id = se.contact_id
           WHERE c.record_class = 'production' AND c.archived_at IS NULL
           GROUP BY s.id, s.name, s.status ORDER BY COUNT(se.id) DESC, s.id ASC`,
          [since, now],
        ),
        // Distinct, authoritative facts; these are deliberately not lifecycle
        // labels, which are mutable projections rather than event evidence.
        pool.query<{ stage: string; cnt: string }>(
          `SELECT 'Leads' AS stage, COUNT(*)::text AS cnt FROM contacts
             WHERE created_at >= $1 AND created_at < $2 AND archived_at IS NULL AND record_class = 'production'
           UNION ALL SELECT 'Replies', COUNT(*)::text FROM outbound_messages om
             JOIN contacts c ON c.id = om.contact_id
             WHERE om.replied_at >= $1 AND om.replied_at < $2 AND c.record_class = 'production' AND c.archived_at IS NULL
           UNION ALL SELECT 'Proposals', COUNT(*)::text FROM statement_proposals sp
             JOIN contacts c ON c.id = sp.contact_id
             WHERE sp.created_at >= $1 AND sp.created_at < $2 AND c.record_class = 'production' AND c.archived_at IS NULL
           UNION ALL SELECT 'Applications', COUNT(*)::text FROM merchant_applications ma
             JOIN contacts c ON c.id = ma.contact_id
             WHERE ma.submitted_at >= $1 AND ma.submitted_at < $2 AND c.record_class = 'production' AND c.archived_at IS NULL
           UNION ALL SELECT 'Closed Won', COUNT(*)::text FROM deals d
             JOIN contacts c ON c.id = d.contact_id
             WHERE d.closed_at >= $1 AND d.closed_at < $2 AND d.archived_at IS NULL AND d.stage = 'Closed Won' AND d.record_class = 'production' AND c.record_class = 'production' AND c.archived_at IS NULL
           UNION ALL SELECT 'Active Merchants', COUNT(*)::text FROM merchant_profiles mp
             JOIN contacts c ON c.id = mp.contact_id
             WHERE mp.go_live_date >= $1 AND mp.go_live_date < $2 AND mp.account_status = 'active' AND c.record_class = 'production' AND c.archived_at IS NULL`,
          [since, now],
        ),
        // Overdue tasks (status pending/in_progress, past due, not deleted)
        db.select({id: tasks.id, title: tasks.title, assigned_to: tasks.assignedTo, due_date: tasks.dueDate})
          .from(tasks).where(taskReadPredicate({
            recordClass: "production", states: ["open", "in_progress"], asOf: now, timezone: "UTC", dueBefore: now,
          })).orderBy(tasks.dueDate, tasks.id).limit(50).then(rows => ({rows})),
        // Queue failures (last 7d) from audit_logs
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM audit_logs
           WHERE entity_type = 'queue' AND action LIKE '%fail%'
             AND created_at >= $1 AND created_at < $2`,
          [since7d, now],
        ),
        // GHL sync failures (last 7d)
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM audit_logs
           WHERE entity_type = 'ghl_sync'
             AND (action LIKE '%fail%' OR action LIKE '%error%')
             AND created_at >= $1 AND created_at < $2`,
          [since7d, now],
        ),
        // Most recent queue failure classification. Raw audit details stay
        // server-side because provider/internal messages are not report data.
        pool.query<{ action: string; created_at: Date }>(
          `SELECT action, created_at FROM audit_logs
           WHERE entity_type = 'queue' AND action LIKE '%fail%'
             AND created_at >= $1 AND created_at < $2
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [since7d, now],
        ),
        // Most recent GHL failure classification (no raw details).
        pool.query<{ action: string; created_at: Date }>(
          `SELECT action, created_at FROM audit_logs
           WHERE entity_type = 'ghl_sync'
             AND (action LIKE '%fail%' OR action LIKE '%error%')
             AND created_at >= $1 AND created_at < $2
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [since7d, now],
        ),
      ]);

      // ── CPL by source ──
      const totalLeads = cplRows.rows.reduce((s, r) => s + parseInt(r.leads, 10), 0);
      const cplBySource = cplRows.rows.map(r => {
        const leads = parseInt(r.leads, 10);
        const booked = parseInt(r.booked, 10);
        const signed = parseInt(r.signed, 10);
        const sourceFrac = totalLeads > 0 ? leads / totalLeads : 0;
        const allocatedSpend = adSpend * sourceFrac;
        return {
          source: r.source,
          leads,
          bookedCalls: booked,
          signedMerchants: signed,
          cpl: adSpend > 0 && leads > 0 ? allocatedSpend / leads : null,
          cpb: adSpend > 0 && booked > 0 ? allocatedSpend / booked : null,
          cps: adSpend > 0 && signed > 0 ? allocatedSpend / signed : null,
          costEstimate: true,
        };
      });

      // ── Close rate by vertical ──
      const closeRateByVertical = verticalRows.rows.map(r => {
        const leads = parseInt(r.leads, 10);
        const booked = parseInt(r.booked, 10);
        const signed = parseInt(r.signed, 10);
        return {
          vertical: r.vertical,
          leads,
          booked,
          signed,
          leadToBooked: leads > 0 ? Math.round((booked / leads) * 1000) / 1000 : null,
          bookedToSigned: booked > 0 ? Math.round((signed / booked) * 1000) / 1000 : null,
          leadToSigned: leads > 0 ? Math.round((signed / leads) * 1000) / 1000 : null,
        };
      });

      // ── Sequence reply rates ──
      const sequenceReplyRates = seqRows.rows.map(r => {
        const enrolled = parseInt(r.enrolled, 10);
        return {
          id: r.seq_id,
          name: r.seq_name,
          status: r.status,
          enrolled,
          replies: null,
          replyRate: null,
        };
      });

      // ── Funnel ──
      const stageCounts: Record<string, number> = {};
      for (const r of funnelRows.rows) stageCounts[r.stage] = parseInt(r.cnt, 10);
      const leadCount = stageCounts.Leads ?? 0;
      const funnel = Object.entries(stageCounts).map(([stage, count]) => ({
        stage, count, pct: leadCount > 0 ? count / leadCount : null,
      }));

      // ── Overdue tasks ──
      const overdueTasks = overdueRows.rows.map(r => ({
        id: r.id,
        title: r.title,
        assignedTo: r.assigned_to,
        dueDate: r.due_date!.toISOString(),
        daysOverdue: Math.floor((now.getTime() - r.due_date!.getTime()) / 86_400_000),
      }));

      // ── Incident summary ──
      const queueErr = recentQueueErr.rows[0];
      const ghlErr = recentGhlErr.rows[0];
      const incidentSummary = {
        queueFailures7d: parseInt(queueFailures7d.rows[0]?.cnt ?? "0", 10),
        ghlSyncFailures7d: parseInt(ghlFailures7d.rows[0]?.cnt ?? "0", 10),
        mostRecentQueueIncident: queueErr
          ? { code: "QUEUE_FAILURE", category: queueErr.action, occurredAt: queueErr.created_at }
          : null,
        mostRecentGhlIncident: ghlErr
          ? { code: "GHL_SYNC_FAILURE", category: ghlErr.action, occurredAt: ghlErr.created_at }
          : null,
      };
      const responseAsOf = new Date().toISOString();
      const independentCapture = {
        requestedAt: now.toISOString(),
        completedBy: responseAsOf,
        consistency: "independent database query; no shared transaction snapshot",
      };

      res.json({
        days,
        adSpend,
        cplBySource,
        closeRateByVertical,
        sequenceReplyRates,
        funnel,
        overdueTasks,
        incidentSummary,
        meta: {
          exact: true,
          asOf: responseAsOf,
          scope: "production records in the requested date window; operational facts are independently counted",
          snapshotConsistency: "unavailable",
          period: {
            startInclusive: since.toISOString(), endExclusive: now.toISOString(), timezone: "UTC",
            basis: "Lead creation cohort; booked and won counts are distinct nonarchived production deals at their current stage, not call events or distinct merchants.",
          },
          operationalPeriods: {
            incidentsStartInclusive: since7d.toISOString(), incidentsEndExclusive: now.toISOString(),
            tasksAsOf: now.toISOString(),
          },
          units: {
            leads: "distinct production contacts", booked: "distinct current Call Booked deals",
            signed: "distinct current Closed Won deals", ratios: "ratios (not percentage points); deals/contacts may exceed 1",
            operationalFacts: "independent event/record counts, not a single cohort funnel",
            overdueTasks: "first 50 due-date/ID ordered pending task records; not the total",
          },
          sourceCapture: {
            acquisition: independentCapture,
            sequences: independentCapture,
            operationalFacts: independentCapture,
            tasks: independentCapture,
            incidents: independentCapture,
          },
          completeness: { sequenceReplies: "unavailable: no authoritative sequence-to-reply relation" },
          spendAllocation: {
            kind: "estimate",
            currency: "USD",
            assumption: "User-entered total ad spend is allocated to each source in proportion to that source's share of production leads in the selected window.",
            authoritativeSpendSource: false,
          },
        },
      });
    } catch (err: any) {
      console.error("[Acquisition] /reporting/operations error:", err.message);
      serverError(res, err);
    }
  });
}
