import { serverError } from "../utils/server-error";
import type { Express } from "express";
import { effectiveBusinessVerticalSql } from "@shared/effective-vertical";
import { resolveContactTargetVertical } from "@shared/contact-vertical-taxonomy";
import { db } from "../db";
import { eq, inArray, sql } from "drizzle-orm";
import { storage } from "../storage";
import { requireRole } from "../replit_integrations/auth";
import OpenAI from "openai";
import { featureFlags } from "../services/feature-flags";
import { listInboundRequests } from "../services/inbound-request-authority";
import { businessLacksDbprLineageSql } from "../services/dbpr";
import { deriveCanonicalBusinessSafeNextAction } from "../services/canonical-business-safe-next-action";
import { buildCanonicalBusinessEmailDisplay } from "../services/canonical-business-email-display";
import { sanitizeAuditPayload } from "../services/audit-sanitizer";
import { backgroundJobs, inboundRequestEffects, sdrMerchants } from "@shared/schema";
import { registerSfpReadyHeldOperatorRoutes } from "./sfp-ready-held-operator";
import { registerSfpStagedProjectionReconciliationRoutes } from "./sfp-staged-projection-reconciliation";

/**
 * Truthful worker/queue health for the SFP campaign-staging telemetry
 * panel (Task #2001 corrective patch). Reports the ACTUAL BullMQ
 * repeatable-job registration and next-run estimate rather than assuming
 * the recurring tick is scheduled just because the program flags are on —
 * a queue-manager outage or a never-registered repeatable job must show up
 * here, not be silently indistinguishable from "healthy but idle".
 */
async function getSfpCampaignStagingWorkerHealth(lastCompletedRun: { completed_at?: string | Date | null } | null): Promise<{
  queueManagerReady: boolean;
  repeatableJobRegistered: boolean;
  nextRunEstimateAt: string | null;
  intervalMs: number | null;
}> {
  const INTERVAL_MS = 15 * 60 * 1000;
  try {
    const { getQueueManagerProducers, QUEUE_NAMES } = await import("../services/queue-manager");
    const qm = getQueueManagerProducers();
    if (!qm) {
      return { queueManagerReady: false, repeatableJobRegistered: false, nextRunEstimateAt: null, intervalMs: INTERVAL_MS };
    }
    const queue = qm.getQueue(QUEUE_NAMES.SFP_CAMPAIGN_STAGING);
    if (!queue) {
      return { queueManagerReady: true, repeatableJobRegistered: false, nextRunEstimateAt: null, intervalMs: INTERVAL_MS };
    }
    const repeatables = await queue.getRepeatableJobs();
    const registered = repeatables.length > 0;
    // BullMQ exposes each repeatable job's next scheduled fire time in ms.
    const nextMs = registered ? Math.min(...repeatables.map((r: any) => Number(r.next ?? Infinity))) : null;
    return {
      queueManagerReady: true,
      repeatableJobRegistered: registered,
      nextRunEstimateAt: nextMs && Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : null,
      intervalMs: INTERVAL_MS,
    };
  } catch (err: any) {
    return { queueManagerReady: false, repeatableJobRegistered: false, nextRunEstimateAt: null, intervalMs: INTERVAL_MS };
  }
}

const rows = (r: any): any[] => r?.rows ?? r ?? [];

function parseSelectedContactIds(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => String(entry).split(",")).map((entry) => Number(entry.trim()));
}

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

// ── In-process health cache (300 s TTL) with single-flight guard ──────────────
let _healthCache: { data: any; ts: number } | null = null;
let _healthInflight: Promise<any> | null = null;
// Incremented each time the cache is invalidated.  A completed computation
// only publishes its result if its captured generation still matches, so an
// orphaned promise (started before a manual reset) cannot overwrite newer
// data or accidentally clear a newer in-flight promise.
let _healthGeneration = 0;
const HEALTH_CACHE_TTL_MS = 300_000;
// Test-mode hook: set HEALTH_CACHE_TEST_MODE=1 to collapse the TTL to 0 and
// inject a __dbRoundTrips counter into the response body.
const HEALTH_CACHE_TEST_MODE = process.env.HEALTH_CACHE_TEST_MODE === "1";
let _healthTestRoundTrips = 0;

// ── In-memory counter: legacy route hits since last startup ───────────────────
let _legacyRouteAttemptsSinceStartup = 0;

/** Called by the deprecated POST /api/sunbiz/re-enrich-all route in prospects.ts */
export function incrementLegacyEnrichAttemptCounter(): void {
  _legacyRouteAttemptsSinceStartup++;
}

export function registerLeadOpsRoutes(app: Express) {
  registerSfpReadyHeldOperatorRoutes(app);
  registerSfpStagedProjectionReconciliationRoutes(app);
  app.get("/api/lead-ops/inbound-requests", requireRole("admin", "manager"), async (req, res) => {
    try {
      const rows = await listInboundRequests({
        limit: Number(req.query.limit) || 50,
        offset: Number(req.query.offset) || 0,
        sourceClass: typeof req.query.sourceClass === "string" ? req.query.sourceClass : undefined,
        lifecycleState: typeof req.query.lifecycleState === "string" ? req.query.lifecycleState : undefined,
      });
      const requestIds = rows.map((row) => row.id);
      const effects = requestIds.length
        ? await db.select({
          effectKey: inboundRequestEffects.effectKey,
          effectType: inboundRequestEffects.effectType,
          state: inboundRequestEffects.state,
          required: inboundRequestEffects.required,
          externalSideEffect: inboundRequestEffects.externalSideEffect,
          terminalReason: inboundRequestEffects.terminalReason,
          requestId: inboundRequestEffects.requestId,
        }).from(inboundRequestEffects).where(inArray(inboundRequestEffects.requestId, requestIds))
        : [];
      const effectsByRequest = new Map<string, typeof effects>();
      for (const effect of effects) {
        const requestEffects = effectsByRequest.get(effect.requestId) || [];
        requestEffects.push(effect);
        effectsByRequest.set(effect.requestId, requestEffects);
      }
      res.json(rows.map((row) => ({
        requestReceipt: row.id,
        sourceClass: row.sourceClass,
        sourceCategory: row.sourceCategory,
        sourceType: row.sourceType,
        lifecycleState: row.lifecycleState,
        assignmentStatus: row.assignmentStatus,
        assignedTo: row.assignedTo,
        slaDueAt: row.slaDueAt,
        contactId: row.contactId,
        dealId: row.dealId,
        ticketId: row.ticketId,
        createdAt: row.createdAt,
        terminalReason: row.terminalReason,
        effects: effectsByRequest.get(row.id) || [],
      })));
    } catch (error) {
      console.error("[LeadOps] inbound request list failed:", error instanceof Error ? error.message : "unknown");
      res.status(500).json({ error: "Failed to load inbound requests" });
    }
  });

  // ── GET /api/lead-ops/stats ────────────────────────────────────────────────
  // Aggregate stats for the entire sunbiz entity lead pool.
  app.get("/api/lead-ops/stats", requireRole("admin", "manager"), async (req, res) => {
    const sampledAt = new Date().toISOString();
    let stats: Record<string, unknown> | null = null;
    let verticals: any[] | null = null;
    let statsError: string | null = null;
    let verticalsError: string | null = null;
    const asSafeCount = (value: unknown): number => {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("aggregate_count_out_of_range");
      return count;
    };
    try {
      stats = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        const result = await tx.execute(sql`
          SELECT
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE enrichment_status = 'enriched')::bigint AS processing_completed,
            COUNT(*) FILTER (WHERE enrichment_status = 'pending')::bigint AS pending_processing,
            COUNT(*) FILTER (WHERE enrichment_status = 'processing')::bigint AS processing,
            COUNT(*) FILTER (WHERE enrichment_status = 'failed')::bigint AS failed,
            COUNT(*) FILTER (WHERE score = 'hot')::bigint AS hot,
            COUNT(*) FILTER (WHERE score = 'warm')::bigint AS warm,
            COUNT(*) FILTER (WHERE score = 'cold')::bigint AS cold,
            COUNT(*) FILTER (
              WHERE NULLIF(BTRIM(email), '') IS NOT NULL
                 OR NULLIF(BTRIM(owner_email), '') IS NOT NULL
            )::bigint AS current_email_inventory,
            COUNT(*) FILTER (
              WHERE NULLIF(BTRIM(phone), '') IS NOT NULL
                 OR NULLIF(BTRIM(owner_phone), '') IS NOT NULL
            )::bigint AS current_phone_inventory,
            COUNT(*) FILTER (
              WHERE (NULLIF(BTRIM(email), '') IS NOT NULL OR NULLIF(BTRIM(owner_email), '') IS NOT NULL)
                AND (NULLIF(BTRIM(phone), '') IS NOT NULL OR NULLIF(BTRIM(owner_phone), '') IS NOT NULL)
            )::bigint AS contactable,
            COUNT(*) FILTER (WHERE NULLIF(BTRIM(owner_name), '') IS NOT NULL)::bigint AS has_owner_name
          FROM sunbiz_entities
        `);
        const record = rows(result)[0];
        if (!record) return null;
        return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, asSafeCount(value)]));
      });
    } catch (err: any) {
      statsError = String(err?.code ?? "aggregate_unavailable");
      console.error("[LeadOps] stats aggregate unavailable:", err?.message);
    }
    try {
      verticals = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        const result = await tx.execute(sql`
          SELECT vertical, COUNT(*)::bigint AS count,
                 COUNT(*) FILTER (WHERE score = 'hot')::bigint AS hot_count
          FROM sunbiz_entities
          WHERE vertical IS NOT NULL
          GROUP BY vertical
          ORDER BY COUNT(*) DESC
          LIMIT 25
        `);
        return rows(result).map((row: any) => ({
          vertical: row.vertical,
          count: asSafeCount(row.count),
          hot_count: asSafeCount(row.hot_count),
        }));
      });
    } catch (err: any) {
      verticalsError = String(err?.code ?? "aggregate_unavailable");
      console.error("[LeadOps] vertical stats unavailable:", err?.message);
    }
    res.json({
      ...(stats ?? {
        total: null, processing_completed: null, pending_processing: null, processing: null,
        failed: null, hot: null, warm: null, cold: null, current_email_inventory: null,
        current_phone_inventory: null, contactable: null, has_owner_name: null,
      }),
      statsAvailable: stats !== null,
      statsUnavailableReason: statsError,
      verticals,
      verticalsAvailable: verticals !== null,
      verticalsUnavailableReason: verticalsError,
      sampledAt,
      scope: "exact_full_corpus_if_available",
    });
  });

  // ── GET /api/lead-ops/entities ─────────────────────────────────────────────
  // Paginated, filterable list of sunbiz entities for the Lead Ops table.
  app.get("/api/lead-ops/entities", requireRole("admin", "manager"), async (req, res) => {
    try {
      const page   = Math.max(0, parseInt(String(req.query.page  || "0")));
      const limit  = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "100"))));
      const offset = page * limit;
      const status      = req.query.status as string | undefined;
      const score       = req.query.score as string | undefined;
      const vertical    = req.query.vertical as string | undefined;
      const contactable = req.query.contactable === "true";
      const noContact   = req.query.noContact === "true";
      const search      = req.query.search as string | undefined;
      const tagFilter   = req.query.tag as string | undefined;

      // Build WHERE clause dynamically using Drizzle sql tag (safe parameterization)
      let whereClause = sql`WHERE 1=1`;
      if (status)    whereClause = sql`${whereClause} AND enrichment_status = ${status}`;
      if (score)     whereClause = sql`${whereClause} AND score = ${score}`;
      if (vertical) {
        const vterm = `%${vertical}%`;
        whereClause = sql`${whereClause} AND vertical ILIKE ${vterm}`;
      }
      if (contactable) {
        whereClause = sql`${whereClause} AND (email IS NOT NULL OR owner_email IS NOT NULL OR phone IS NOT NULL OR owner_phone IS NOT NULL)`;
      }
      if (noContact) {
        whereClause = sql`${whereClause} AND email IS NULL AND owner_email IS NULL AND phone IS NULL AND owner_phone IS NULL`;
      }
      if (search) {
        const sterm = `%${search}%`;
        whereClause = sql`${whereClause} AND (entity_name ILIKE ${sterm} OR owner_name ILIKE ${sterm} OR owner_email ILIKE ${sterm} OR email ILIKE ${sterm})`;
      }
      // Quiz-lead tag filter: matches entities linked from the free-analysis quiz funnel
      // (tagged by server/routes/imports.ts and server/services/daily-outreach.ts).
      if (tagFilter === "quiz_lead") {
        whereClause = sql`${whereClause} AND tags && ARRAY['quiz_lead_linked','lead_free_analysis','src_quiz']::text[]`;
      }

      const countResult = await db.execute(
        sql`SELECT COUNT(*)::int AS total FROM sunbiz_entities ${whereClause}`
      );
      const total = ((countResult as any).rows ?? countResult)[0]?.total ?? 0;

      const rowsResult = await db.execute(sql`
        SELECT id, entity_name, principal_city, principal_state, vertical, score,
               enrichment_status, enriched_at, owner_name, owner_email, owner_phone,
               email, phone, website, prospect_id, ai_summary, tags, created_at, updated_at
        FROM sunbiz_entities
        ${whereClause}
        ORDER BY
          CASE score WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END,
          enriched_at DESC NULLS LAST,
          created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      res.json({ data: (rowsResult as any).rows ?? rowsResult, total, page, limit });
    } catch (err: any) {
      console.error("[LeadOps] entities error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to load entities" });
    }
  });

  // ── POST /api/lead-ops/bulk-enrich ─────────────────────────────────────────
  // Reset enrichment_status to 'pending' for selected or filtered entities.
  // The existing enrichment worker picks them up automatically on its next tick.
  app.post("/api/lead-ops/bulk-enrich", requireRole("admin", "manager"), async (req, res) => {
    return res.status(503).json({
      code: "CRO03_STAGING_CONVERSION_REQUIRED",
      message: "Lead staging enrichment requires canonical intake conversion.",
    });
    /*
    try {
      const { entityIds, all, filter } = req.body as {
        entityIds?: number[];
        all?: boolean;
        filter?: {
          status?: string;
          score?: string;
          vertical?: string;
          noContact?: boolean;
        };
      };

      if (!all && (!entityIds || entityIds.length === 0)) {
        return res.status(400).json({ error: "Provide entityIds or all=true" });
      }

      let queued = 0;

      if (all) {
        let whereClause = sql`WHERE enrichment_status != 'processing'`;
        if (filter?.status) whereClause = sql`${whereClause} AND enrichment_status = ${filter.status}`;
        if (filter?.score)  whereClause = sql`${whereClause} AND score = ${filter.score}`;
        if (filter?.vertical) {
          const vt = `%${filter.vertical}%`;
          whereClause = sql`${whereClause} AND vertical ILIKE ${vt}`;
        }
        if (filter?.noContact) {
          whereClause = sql`${whereClause} AND email IS NULL AND owner_email IS NULL AND phone IS NULL AND owner_phone IS NULL`;
        }

        const result = await db.execute(sql`
          UPDATE sunbiz_entities
          SET enrichment_status = 'pending', updated_at = NOW()
          ${whereClause}
          RETURNING id
        `);
        queued = ((result as any).rows ?? result).length;
      } else {
        const ids = (entityIds as number[]).slice(0, 50000);
        if (ids.length === 0) return res.status(400).json({ error: "No valid entity IDs" });

        // Build an IN list safely using Drizzle
        const idList = ids.join(",");
        const result = await db.execute(sql.raw(
          `UPDATE sunbiz_entities
           SET enrichment_status = 'pending', updated_at = NOW()
           WHERE id = ANY(ARRAY[${idList}]::int[])
             AND enrichment_status != 'processing'
           RETURNING id`
        ));
        queued = ((result as any).rows ?? result).length;
      }

      await storage.createAuditLog({
        action: "lead_ops_bulk_enrich",
        entityType: "system",
        entityId: 0,
        details: { queued, all: !!all, filter: filter || null },
      });

      res.json({
        queued,
        message: `${queued.toLocaleString()} leads queued for enrichment. The pipeline runs every 10 minutes — check back shortly.`,
      });
    } catch (err: any) {
      console.error("[LeadOps] bulk-enrich error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to queue enrichment" });
    }
    */
  });

  // ── POST /api/lead-ops/ai-segment ─────────────────────────────────────────
  // Use OpenAI to analyze the lead pool and return segmentation insights.
  app.post("/api/lead-ops/ai-segment", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { sampleSize = 150 } = req.body as { sampleSize?: number };

      const [poolResult, verticalResult, sampleResult] = await Promise.all([
        db.execute(sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE enrichment_status = 'enriched')::int AS enriched,
            COUNT(*) FILTER (WHERE score = 'hot')::int AS hot,
            COUNT(*) FILTER (WHERE score = 'warm')::int AS warm,
            COUNT(*) FILTER (WHERE score = 'cold')::int AS cold,
            COUNT(*) FILTER (WHERE email IS NOT NULL OR owner_email IS NOT NULL)::int AS has_email,
            COUNT(*) FILTER (WHERE phone IS NOT NULL OR owner_phone IS NOT NULL)::int AS has_phone,
            COUNT(*) FILTER (WHERE enrichment_status = 'pending')::int AS pending
          FROM sunbiz_entities
        `),
        db.execute(sql`
          SELECT vertical, COUNT(*)::int AS count,
                 COUNT(*) FILTER (WHERE score = 'hot')::int AS hot_count,
                 COUNT(*) FILTER (WHERE email IS NOT NULL OR owner_email IS NOT NULL)::int AS with_email
          FROM sunbiz_entities
          WHERE vertical IS NOT NULL AND enrichment_status = 'enriched'
          GROUP BY vertical ORDER BY count DESC LIMIT 15
        `),
        db.execute(sql`
          SELECT entity_name, principal_city, vertical, score,
                 CASE WHEN email IS NOT NULL OR owner_email IS NOT NULL THEN 'yes' ELSE 'no' END AS has_email,
                 CASE WHEN phone IS NOT NULL OR owner_phone IS NOT NULL THEN 'yes' ELSE 'no' END AS has_phone,
                 owner_name, ai_summary
          FROM sunbiz_entities
          WHERE enrichment_status = 'enriched'
          ORDER BY CASE score WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 ELSE 3 END, RANDOM()
          LIMIT ${Math.min(sampleSize, 200)}
        `),
      ]);

      const pool     = ((poolResult     as any).rows ?? poolResult    )[0] || {};
      const verts    =  (verticalResult as any).rows ?? verticalResult;
      const sample   =  (sampleResult   as any).rows ?? sampleResult;

      if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
        return res.json({
          diagnostic_only: true,
          disclaimer: "This is a narrative analysis of a sample — it does not modify records or qualify candidates.",
          summary: "AI analysis requires OPENAI_API_KEY to be configured.",
          segments: [], recommendations: [], outreachPriority: [], pool, verticals: verts,
        });
      }

      const openai = getOpenAI();
      const vertSummary = verts.map((v: any) =>
        `${v.vertical}: ${v.count} leads (${v.hot_count} hot, ${v.with_email} have email)`
      ).join("\n");

      const sampleSnippet = sample.slice(0, 25).map((l: any) =>
        `${l.entity_name} | ${l.principal_city}, FL | ${l.vertical || "unknown"} | ${l.score || "unscored"} | email:${l.has_email} | phone:${l.has_phone}`
      ).join("\n");

      const prompt = `You are a senior payment processing sales strategist for Liberty Bancard ISO CRM. Analyze this Florida business lead pool and produce a prioritized action plan.

LEAD POOL STATS:
- Total leads: ${pool.total?.toLocaleString()} | Enriched: ${pool.enriched} | Pending enrichment: ${pool.pending}
- Hot: ${pool.hot} | Warm: ${pool.warm} | Cold: ${pool.cold}
- Have email: ${pool.has_email} | Have phone: ${pool.has_phone}

VERTICAL BREAKDOWN (enriched leads):
${vertSummary}

SAMPLE LEADS (${sample.length} shown):
${sampleSnippet}

Your task: produce a JSON object with these exact keys:
{
  "summary": "2-3 sentence executive summary of this lead pool's quality and best opportunity",
  "segments": [
    { "name": "Segment label", "vertical": "...", "score": "hot|warm|cold", "estimatedCount": N,
      "channel": "email|phone|sms", "angle": "One-sentence pitch angle for this segment",
      "priority": 1 }
  ],
  "recommendations": ["Specific action the team should take TODAY", "..."],
  "outreachPriority": [
    { "vertical": "...", "estimatedCloseRate": "X%", "whyNow": "brief reason" }
  ],
  "quickWins": ["Short actionable items that take <30 min to execute"]
}
Return maximum 5 segments, 4 recommendations, 4 outreach priorities, 3 quick wins.`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 1800,
        response_format: { type: "json_object" },
      });

      const text = completion.choices[0]?.message?.content || "{}";
      let parsed: any = {};
      try { parsed = JSON.parse(text); } catch {}

      res.json({
        diagnostic_only: true,
        disclaimer: "This is a narrative analysis of a sample — it does not modify records or qualify candidates.",
        summary:          parsed.summary          || "Analysis complete.",
        segments:         parsed.segments          || [],
        recommendations:  parsed.recommendations   || [],
        outreachPriority: parsed.outreachPriority  || [],
        quickWins:        parsed.quickWins          || [],
        pool,
        verticals: verts,
      });
    } catch (err: any) {
      console.error("[LeadOps] ai-segment error:", err?.message);
      res.status(500).json({
        diagnostic_only: true,
        disclaimer: "This is a narrative analysis of a sample — it does not modify records or qualify candidates.",
        error: err?.message || "AI analysis failed",
      });
    }
  });

  // ── POST /api/lead-ops/run-writeback ───────────────────────────────────────
  app.post("/api/lead-ops/run-writeback", requireRole("admin"), async (_req, res) => {
    return res.status(503).json({
      code: "CRO03A_GOVERNED_HANDOFF_REQUIRED",
      message: "Legacy enrichment writeback is retired. CRO-03A may only publish an effect-denied CRO-03B handoff.",
    });
  });

  // ── GET /api/lead-ops/config ───────────────────────────────────────────────
  // Exposes non-secret boolean flags about the server configuration.
  app.get("/api/lead-ops/config", requireRole("admin", "manager"), (_req, res) => {
    res.json({
      serperConfigured: !!process.env.SERPER_API_KEY,
      openaiConfigured: !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    });
  });

  // ── Governed Sunbiz bootstrap (manual, bounded, never scheduled) ─────────
  app.get("/api/lead-ops/sunbiz-bootstrap/preview", requireRole("admin"), async (req, res) => {
    try {
      const { previewSunbizBootstrap, sunbizBootstrapConfirmationPhrase, issueSunbizBootstrapPreviewToken } = await import("../services/sunbiz-bootstrap");
      const limit = Math.min(25, Math.max(1, Math.floor(Number(req.query.limit) || 25)));
      // filingNumberLike is an optional admin-side narrowing filter (e.g. to
      // inspect/rerun a specific filing number or prefix) — selectSunbizBootstrapCandidates
      // already routes it through a sargable filing_number range scan rather
      // than a full hot/warm table scan, so exposing it here doesn't
      // reintroduce a perf regression.
      const filingNumberLike = typeof req.query.filingNumberLike === "string" ? req.query.filingNumberLike : undefined;
      const preview = await previewSunbizBootstrap(limit, { filingNumberLike });
      // The confirmation phrase is derived from the actual candidateCount
      // (never the requested limit). It's also minted into a short-lived,
      // single-use previewToken that /run validates against directly — so a
      // claim landing between this preview and the run call (another admin's
      // batch, or this module's own stale-claim recovery) can never silently
      // invalidate the exact phrase this response just displayed. The token
      // also carries the exact filing_number set behind candidateCount (and
      // the same filingNumberLike filter), so /run can reject execution
      // outright if that set drifts before the batch actually runs, rather
      // than silently running a different set.
      const confirmationPhrase = sunbizBootstrapConfirmationPhrase(preview.candidateCount);
      const previewToken = issueSunbizBootstrapPreviewToken(
        confirmationPhrase,
        limit,
        preview.candidates.map((c) => c.filingNumber),
        filingNumberLike,
      );
      res.json({ limit, confirmationPhrase, previewToken, ...preview });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to preview Sunbiz bootstrap" });
    }
  });

  app.get("/api/lead-ops/sunbiz-bootstrap/status", requireRole("admin"), async (_req, res) => {
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        return tx.execute(sql`
          SELECT
            COUNT(*)::bigint AS total_claims,
            COUNT(*) FILTER (WHERE status = 'claimed')::bigint AS claimed,
            COUNT(*) FILTER (WHERE status = 'created')::bigint AS created,
            COUNT(*) FILTER (WHERE status = 'matched_existing')::bigint AS matched_existing,
            COUNT(*) FILTER (WHERE status = 'deferred_collision')::bigint AS deferred,
            COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
            MAX(completed_at) AS last_completed_at
          FROM sunbiz_bootstrap_claims
        `);
      });
      const claimCounts = rows(result)[0] ?? {};
      const normalizedClaimCounts = { ...claimCounts };
      for (const key of ["total_claims", "claimed", "created", "matched_existing", "deferred", "failed"]) {
        const count = Number((claimCounts as any)[key]);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("bootstrap_count_out_of_range");
        (normalizedClaimCounts as any)[key] = count;
      }
      let nextCandidateId: number | null = null;
      let candidateLookupAvailable = true;
      let candidateLookupError: string | null = null;
      try {
        const { selectSunbizBootstrapCandidateWindow } = await import("../services/sunbiz-bootstrap");
        const window = await selectSunbizBootstrapCandidateWindow(1, { geography: "any" });
        nextCandidateId = window.candidates[0]?.id ?? null;
      } catch (err: any) {
        candidateLookupAvailable = false;
        candidateLookupError = String(err?.code ?? "candidate_lookup_unavailable");
      }
      res.json({
        ...normalizedClaimCounts,
        cursor: nextCandidateId,
        cursorAvailable: candidateLookupAvailable,
        cursorUnavailableReason: candidateLookupError,
        cursorMeaning: "first currently eligible bootstrap candidate; null with cursorAvailable=true means none currently eligible",
        recovery: "Failed claims remain durable and can be inspected; successful claims are idempotently excluded from retries.",
      });
    } catch (err: any) {
      res.status(503).json({
        error: "bootstrap_status_unavailable",
        available: false,
        reasonCode: String(err?.code ?? "status_query_failed"),
      });
    }
  });

  // ── One-time correction: repair businesses the bootstrap created with the
  // ── wrong record_class before the create.recordClass fix was published.
  // ── Read-only preview first; the guarded run below requires a typed
  // ── confirmation phrase bound to a short-lived, single-use preview token,
  // ── mirroring the /sunbiz-bootstrap preview+run pattern above.
  app.get("/api/lead-ops/sunbiz-bootstrap/record-class-repair/preview", requireRole("admin"), async (_req, res) => {
    try {
      const {
        previewSunbizRecordClassRepair,
        sunbizRecordClassRepairConfirmationPhrase,
        issueSunbizRecordClassRepairToken,
      } = await import("../services/sunbiz-bootstrap");
      const preview = await previewSunbizRecordClassRepair();
      const confirmationPhrase = sunbizRecordClassRepairConfirmationPhrase(preview.cohortCount);
      const previewToken = issueSunbizRecordClassRepairToken(
        confirmationPhrase,
        preview.rows.map((r) => r.id),
      );
      res.json({ confirmationPhrase, previewToken, ...preview });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to preview Sunbiz record_class repair" });
    }
  });

  app.post("/api/lead-ops/sunbiz-bootstrap/record-class-repair/run", requireRole("admin"), async (req, res) => {
    try {
      const confirmation = String(req.body?.confirmation ?? "");
      const previewToken = String(req.body?.previewToken ?? "");
      const {
        peekSunbizRecordClassRepairToken,
        consumeSunbizRecordClassRepairToken,
        runSunbizRecordClassRepair,
      } = await import("../services/sunbiz-bootstrap");

      const tokenRecord = previewToken ? peekSunbizRecordClassRepairToken(previewToken) : null;
      if (!tokenRecord) {
        return res.status(400).json({
          error: "preview_token_required",
          reason: "Call GET .../record-class-repair/preview first and submit its previewToken with this request; it is single-use and expires after 5 minutes.",
        });
      }
      if (confirmation !== tokenRecord.confirmationPhrase) {
        return res.status(400).json({
          error: "typed_confirmation_required",
          reason: `Type exactly '${tokenRecord.confirmationPhrase}' to run this repair.`,
        });
      }
      if (tokenRecord.businessIds.length === 0) {
        return res.status(409).json({
          error: "no_candidates",
          reason: "No businesses currently qualify for this repair.",
        });
      }
      consumeSunbizRecordClassRepairToken(previewToken);
      const result = await runSunbizRecordClassRepair(tokenRecord.businessIds);
      await storage.createAuditLog({
        action: "sunbiz_record_class_repair",
        entityType: "system",
        entityId: 0,
        details: result,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Sunbiz record_class repair failed; rerun is safe" });
    }
  });

  // ── Task #2002 completion: resumable full-backlog backfill status/controls.
  // Distinct from the bounded /sunbiz-bootstrap/preview+run pair above — this
  // surface reports the corpus-level cursor and drives the recurring worker
  // (server/services/sunbiz-full-backfill.ts), which is disabled by default
  // (run status starts 'idle') until an admin explicitly resumes it.
  app.get("/api/lead-ops/sunbiz-bootstrap/backfill-status", requireRole("admin"), async (_req, res) => {
    try {
      const { getSunbizFullBackfillStatus } = await import("../services/sunbiz-full-backfill");
      res.json(await getSunbizFullBackfillStatus());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to read backfill status" });
    }
  });

  app.post("/api/lead-ops/sunbiz-bootstrap/backfill/resume", requireRole("admin"), async (req, res) => {
    try {
      const { resumeSunbizFullBackfill, getSunbizFullBackfillStatus, WorkerCapabilityInactiveError } = await import("../services/sunbiz-full-backfill");
      try {
        await resumeSunbizFullBackfill();
      } catch (err: any) {
        if (err instanceof WorkerCapabilityInactiveError) {
          await storage.createAuditLog({
            action: "sunbiz_full_backfill_resume_rejected",
            entityType: "system",
            entityId: 0,
            details: { adminUserId: (req as any).user?.id ?? null, reasonCode: err.reasonCode, capability: err.capability },
          });
          return res.status(409).json({
            error: err.message,
            reasonCode: err.reasonCode,
            workerCapability: err.capability,
          });
        }
        throw err;
      }
      await storage.createAuditLog({
        action: "sunbiz_full_backfill_resumed",
        entityType: "system",
        entityId: 0,
        details: { adminUserId: (req as any).user?.id ?? null },
      });
      res.json(await getSunbizFullBackfillStatus());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to resume backfill" });
    }
  });

  app.post("/api/lead-ops/sunbiz-bootstrap/backfill/pause", requireRole("admin"), async (req, res) => {
    try {
      const { pauseSunbizFullBackfill, getSunbizFullBackfillStatus } = await import("../services/sunbiz-full-backfill");
      await pauseSunbizFullBackfill();
      await storage.createAuditLog({
        action: "sunbiz_full_backfill_paused",
        entityType: "system",
        entityId: 0,
        details: { adminUserId: (req as any).user?.id ?? null },
      });
      res.json(await getSunbizFullBackfillStatus());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to pause backfill" });
    }
  });

  app.post("/api/lead-ops/sunbiz-bootstrap/run", requireRole("admin"), async (req, res) => {
    try {
      const limit = Math.min(25, Math.max(1, Math.floor(Number(req.body?.limit) || 25)));
      const confirmation = String(req.body?.confirmation ?? "");
      const previewToken = String(req.body?.previewToken ?? "");
      const { runSunbizBootstrapBatch, peekSunbizBootstrapPreviewToken, consumeSunbizBootstrapPreviewToken, SunbizBootstrapSnapshotDriftError } = await import("../services/sunbiz-bootstrap");

      // Validation is bound to the token minted by /preview, NOT to a freshly
      // recomputed candidateCount. A recompute here would reintroduce the
      // exact race the token exists to close: candidates can change between
      // preview and run (another admin's batch, or this module's own
      // stale-claim recovery), which would otherwise reject the very phrase
      // the caller was just shown.
      //
      // Validation PEEKS the token first (does not delete it) so a typo'd
      // confirmation doesn't burn a still-valid preview — the caller can
      // correct the phrase and resubmit with the same token. The token is
      // only consumed (single-use) once limit + confirmation both check out,
      // immediately before executing the batch.
      const tokenRecord = previewToken ? peekSunbizBootstrapPreviewToken(previewToken) : null;
      if (!tokenRecord) {
        return res.status(400).json({
          error: "preview_token_required",
          reason: "Call GET .../sunbiz-bootstrap/preview first and submit its previewToken with this request; it is single-use and expires after 5 minutes.",
        });
      }
      if (tokenRecord.limit !== limit) {
        return res.status(400).json({
          error: "preview_token_limit_mismatch",
          reason: "The previewToken was minted for a different limit than this request. Re-preview with the desired limit.",
        });
      }
      if (confirmation !== tokenRecord.confirmationPhrase) {
        return res.status(400).json({
          error: "typed_confirmation_required",
          reason: `Type exactly '${tokenRecord.confirmationPhrase}' to run this bounded batch.`,
        });
      }
      if (tokenRecord.candidateFilingNumbers.length === 0) {
        return res.status(409).json({
          error: "no_candidates",
          reason: "No unclaimed hot/warm Sunbiz candidates were eligible when this preview was taken.",
        });
      }
      // Consume (single-use) only now that validation passed, immediately
      // before the batch runs — prevents this same token being replayed for
      // a second, separate run.
      consumeSunbizBootstrapPreviewToken(previewToken);
      let outcomes: Awaited<ReturnType<typeof runSunbizBootstrapBatch>>;
      try {
        // Passing the token's candidateFilingNumbers makes runSunbizBootstrapBatch
        // verify its fresh selection is IDENTICAL to what the admin previewed
        // before it claims or writes anything — not just that the count still
        // matches. A claim landing between preview and this call (another
        // admin's batch, or this module's own stale-claim recovery) throws
        // SunbizBootstrapSnapshotDriftError instead of silently executing a
        // different set of entities than the reviewed/confirmed one.
        outcomes = await runSunbizBootstrapBatch(limit, { filingNumberLike: tokenRecord.filingNumberLike }, tokenRecord.candidateFilingNumbers);
      } catch (err) {
        if (err instanceof SunbizBootstrapSnapshotDriftError) {
          return res.status(409).json({
            error: err.code,
            reason: "The eligible candidate set changed since this preview was taken (another run or claim recovery altered it). Re-preview and confirm again.",
          });
        }
        throw err;
      }
      await storage.createAuditLog({
        action: "sunbiz_bootstrap_admin_batch",
        entityType: "system",
        entityId: 0,
        details: {
          limit,
          candidateCount: tokenRecord.candidateFilingNumbers.length,
          outcomes,
        },
      });
      res.json({ limit, candidateCount: tokenRecord.candidateFilingNumbers.length, outcomes });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Sunbiz bootstrap failed; rerun is safe" });
    }
  });

  app.get("/api/lead-ops/enrichment-program-health", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getFreeEnrichmentLaneStatus } = await import("../services/free-enrichment-lane");
      res.json(await getFreeEnrichmentLaneStatus());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to load free-enrichment lane status" });
    }
  });

  // ── GET /api/lead-ops/health ───────────────────────────────────────────────
  // Pipeline health stats — enrichment throughput, queue depth, success rate,
  // plus worker-authority truth fields (intake path, enrichment_progress
  // status, free-enrichment pending jobs, last scheduled enrichment timestamp).
  // Cached for 300 s with a single-flight guard: concurrent cache-miss callers
  // all await the same in-flight Promise instead of launching separate DB scans.

  async function runHealthComputation(): Promise<any> {
    // Wrap the heavy sunbiz_entities aggregate in a 30-second statement timeout
    // so a runaway scan degrades to stale data rather than holding a pool
    // connection indefinitely.
    const [enrichResult, freeEnrichResult, canonicalFreeEnrichResult, paidQueueResult, jobRow, progressRaw, staleThresholdResult] = await Promise.all([
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '30000'`);
        return tx.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE enriched_at >= NOW() - INTERVAL '24 hours')::int          AS enriched_today,
            COUNT(*) FILTER (
              WHERE enriched_at >= NOW() - INTERVAL '24 hours'
                AND (email IS NOT NULL OR owner_email IS NOT NULL)
            )::int                                                                             AS emails_today,
            COUNT(*) FILTER (
              WHERE enriched_at >= NOW() - INTERVAL '24 hours'
                AND (phone IS NOT NULL OR owner_phone IS NOT NULL)
            )::int                                                                             AS phones_today,
            COUNT(*) FILTER (WHERE enrichment_status = 'pending')::int                        AS queue_depth,
            COUNT(*) FILTER (WHERE enrichment_status = 'enriched')::int                       AS total_enriched,
            COUNT(*) FILTER (WHERE enrichment_status = 'failed')::int                         AS total_failed,
            MAX(enriched_at)                                                                   AS last_enriched_at
          FROM sunbiz_entities
        `);
      }).catch(() => null),
      // Match runFreeContactEnrichmentTick()'s exact eligibility predicate:
      // (domain IS NOT NULL OR website IS NOT NULL) AND status='pending'
      // AND doNotContactFlag IS NOT TRUE
      // AND no sdr_merchant_contacts row with email already present.
      db.select({ count: sql<number>`COUNT(*)::int` })
        .from(sdrMerchants)
        .where(sql`
          (${sdrMerchants.domain} IS NOT NULL OR ${sdrMerchants.website} IS NOT NULL)
          AND ${sdrMerchants.ownerEnrichmentStatus} = 'pending'
          AND ${sdrMerchants.doNotContactFlag} IS NOT TRUE
          AND NOT EXISTS (
            SELECT 1 FROM sdr_merchant_contacts mc
            WHERE mc.merchant_id = ${sdrMerchants.id} AND mc.email IS NOT NULL
          )
        `).catch(() => null),
      // MI-04: Canonical businesses free enrichment queue depth.
      // Predicate must exactly match runCanonicalBusinessEnrichmentTick() so the UI
      // tile reflects the true backlog (null + retryable-failed + stale-enriched,
      // canonical-only). Also includes record_class guard and attempt count cap.
      //
      // Task #1906: rewritten as a UNION ALL of three per-branch counts (summed)
      // instead of a single OR predicate, so each branch is served by its own
      // partial index (migrations 0250 + 0264) rather than a full table scan.
      db.execute(sql`
        SELECT COALESCE(SUM(cnt), 0)::int AS count FROM (
          SELECT COUNT(*) AS cnt FROM businesses
          WHERE website_domain IS NOT NULL
            AND record_class = 'canonical'
            AND free_enrichment_status IS NULL

          UNION ALL

          SELECT COUNT(*) AS cnt FROM businesses
          WHERE website_domain IS NOT NULL
            AND record_class = 'canonical'
            AND free_enrichment_status = 'failed'
            AND free_enrichment_attempt_count < 3

          UNION ALL

          SELECT COUNT(*) AS cnt FROM businesses
          WHERE website_domain IS NOT NULL
            AND record_class = 'canonical'
            AND free_enrichment_status = 'enriched'
            AND free_enrichment_completed_at < NOW() - INTERVAL '90 days'
        ) branches
      `).catch(() => null),
      // Paid CRO-03C work is represented by reserved/pending/running stage
      // operations.  This is deliberately separate from the canonical free
      // enrichment predicate above.
      db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM cro03c_stage_operations
        WHERE state IN ('reserved', 'pending', 'running')
      `).catch(() => null),
      db.select({ lastFinishedAt: backgroundJobs.lastFinishedAt })
        .from(backgroundJobs)
        .where(eq(backgroundJobs.jobName, "enrichment-queue-processor"))
        .limit(1).catch(() => []),
      storage.getSystemSetting("enrichment_progress").catch(() => null),
      db.execute(sql`SELECT value FROM system_settings WHERE key = 'enrichment_worker_stale_threshold_ms' LIMIT 1`).catch(() => null),
    ]);

    // ── Stale-alert threshold ─────────────────────────────────────────────────
    // Read from system_settings; default 10 minutes. Configurable so operators
    // can tighten or loosen without a code deploy.
    const DEFAULT_ALERT_STALE_MS = 10 * 60 * 1000; // 10 minutes
    const staleThresholdRows = staleThresholdResult
      ? ((staleThresholdResult as any).rows ?? staleThresholdResult)
      : [];
    const staleThresholdRaw = staleThresholdRows[0]?.value;
    const workerStalenessThresholdMs = staleThresholdRaw
      ? Math.max(60_000, Number(staleThresholdRaw))
      : DEFAULT_ALERT_STALE_MS;

    const enrichRows = enrichResult ? ((enrichResult as any).rows ?? enrichResult) : [];
    const row = enrichRows[0] || {};
    const throughputAvailable = !!enrichResult;
    const metric = (value: number | string | null, available = true, error?: string) => ({
      value, available, stale: false, ...(error ? { error } : {}),
    });
    const successRate = (Number(row.total_enriched ?? 0) + Number(row.total_failed ?? 0)) > 0
      ? Math.round((Number(row.total_enriched ?? 0) / (Number(row.total_enriched ?? 0) + Number(row.total_failed ?? 0))) * 100)
      : 0;

    const lastEnrichedAt = row.last_enriched_at ? new Date(row.last_enriched_at) : null;
    const minutesSinceLastJob = lastEnrichedAt
      ? Math.floor((Date.now() - lastEnrichedAt.getTime()) / 60000)
      : null;
    const workerActive = minutesSinceLastJob !== null && minutesSinceLastJob < 15;

    const freeEnrichPending = Number(freeEnrichResult?.[0]?.count ?? 0);
    // Per-metric availability: .catch(() => null) means null = query failed.
    // Must NOT coerce null to 0 — that makes a failed query look like a healthy zero backlog.
    const canonicalFreeQueueAvailable = canonicalFreeEnrichResult !== null;
    const canonicalFreeEnrichmentQueueDepth = canonicalFreeQueueAvailable
      ? Number(((canonicalFreeEnrichResult as any)?.rows ?? canonicalFreeEnrichResult)?.[0]?.count ?? 0)
      : null;
    const paidQueueAvailable = paidQueueResult !== null;
    const paidQueueDepth = paidQueueAvailable
      ? Number(((paidQueueResult as any)?.rows ?? paidQueueResult)?.[0]?.count ?? 0)
      : null;
    const lastJobRow = jobRow[0];

    const progressObj = (progressRaw as any) || {};
    const enrichmentProgressStatus: string =
      progressObj.status === "running" ? "running"
      : progressObj.status === "interrupted" ? "interrupted"
      : progressObj.status === "failed" ? "failed"
      : "idle";

    // Use the same featureFlags getters that runEnrichmentTick() and runDailyOutreachCycle()
    // check — backed by dbFallbackBool() and accounting for wizard/DB overrides.
    const sunbizEnrichmentEnabled = featureFlags.SUNBIZ_ENRICHMENT_ENABLED;
    const legacyOutreachEnabled   = featureFlags.LEGACY_OUTREACH_ENABLED;

    // Truthfully report which intake path(s) are active.
    // runDailyOutreachCycle (LEGACY_OUTREACH_ENABLED gate) calls reEnrichAllSunbizEntities()
    // unconditionally in Phase A, so when that path is live BOTH intake paths are active.
    const intakeAuthority: "scheduled-sunbiz-pipeline" | "legacy-outreach-cycle" | "both" | "none" =
      sunbizEnrichmentEnabled && legacyOutreachEnabled ? "both"
      : sunbizEnrichmentEnabled ? "scheduled-sunbiz-pipeline"
      : legacyOutreachEnabled   ? "legacy-outreach-cycle"
      : "none";

    // Use sunbiz_entities.MAX(enriched_at) as the definitive "last Sunbiz enrichment ran"
    // timestamp — this reflects actual completion of the Sunbiz enrichment steps, not the
    // job-registry heartbeat which fires before those steps execute in runEnrichmentTick().
    const lastScheduledEnrichmentAtDerived = lastEnrichedAt?.toISOString() ?? null;

    // ── MI-02: sourceRegistryAdapters (additive) ─────────────────────────
    let sourceRegistryAdapters: Array<{
      adapterKey: string;
      lastImportStatus: string | null;
      lastCompletedAt: string | null;
      recordCount: number;
    }> = [];
    let sourceRegistryCounts: any = {
      canonicalBusinesses: { value: 0, available: false, stale: false, error: "query_failed" },
      sourceLinks: { value: 0, available: false, stale: false, error: "query_failed" },
      adapters: { value: 0, available: false, stale: false, error: "query_failed" },
    };
    try {
      const [regResult, countResult] = await Promise.all([db.execute(sql`
        SELECT
          a.adapter_key,
          COUNT(DISTINCT ss.id)::int                AS record_count,
          MAX(r.completed_at)                       AS last_completed_at,
          (SELECT r2.status FROM source_import_runs r2
           WHERE r2.adapter_key = a.adapter_key
           ORDER BY r2.created_at DESC LIMIT 1)     AS last_import_status
        FROM source_registry_adapters a
        LEFT JOIN source_import_runs r ON r.adapter_key = a.adapter_key AND r.status = 'completed'
        LEFT JOIN cro03_source_subjects ss ON ss.source_system = a.adapter_key AND ss.tombstoned_at IS NULL
        GROUP BY a.adapter_key
        ORDER BY a.adapter_key
      `), db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM businesses WHERE record_class = 'canonical') AS canonical_businesses,
          (SELECT COUNT(*)::int FROM canonical_source_links) AS source_links,
          (SELECT COUNT(*)::int FROM source_registry_adapters) AS adapters
      `)]);
      sourceRegistryAdapters = ((regResult as any).rows ?? regResult).map((row: any) => ({
        adapterKey: row.adapter_key,
        lastImportStatus: row.last_import_status ?? null,
        lastCompletedAt: row.last_completed_at ? new Date(row.last_completed_at).toISOString() : null,
        recordCount: Number(row.record_count ?? 0),
      }));
      const counts = ((countResult as any).rows ?? countResult)[0] ?? {};
      sourceRegistryCounts = {
        canonicalBusinesses: { value: Number(counts.canonical_businesses ?? 0), available: true, stale: false },
        sourceLinks: { value: Number(counts.source_links ?? 0), available: true, stale: false },
        adapters: { value: Number(counts.adapters ?? 0), available: true, stale: false },
      };
    } catch {
      // sourceRegistryAdapters table may not exist in older schemas — degrade gracefully
      sourceRegistryAdapters = [];
      sourceRegistryCounts = {
        canonicalBusinesses: { value: 0, available: false, stale: false, error: "query_failed" },
        sourceLinks: { value: 0, available: false, stale: false, error: "query_failed" },
        adapters: { value: 0, available: false, stale: false, error: "query_failed" },
      };
    }

    // ── MI-05: CRO-03C provider spend aggregates (last 24 h) ─────────────
    // Source: cro03c_stage_operations (settled_units, settled_amount_micros).
    // cro03_provider_ledger is legacy and intentionally NOT queried here.
    let apolloDailySpend = metric(null, false, "query_failed");
    let outscraperDailySpend = metric(null, false, "query_failed");
    let serperDailySpend = metric(null, false, "query_failed");
    try {
      const spendResult = await db.execute(sql`
        SELECT
          provider,
          COALESCE(SUM(settled_amount_micros), 0)::bigint AS total_micros
        FROM cro03c_stage_operations
        WHERE completed_at >= NOW() - INTERVAL '24 hours'
          AND state = 'completed'
        GROUP BY provider
      `);
      const spendRows: any[] = (spendResult as any).rows ?? spendResult ?? [];
      // After a successful aggregate query, all three metrics are available even if
      // zero rows match (= no spend today, not a query failure).
      // Initialize to available-zero, then overwrite with actual values.
      apolloDailySpend     = metric(0);
      outscraperDailySpend = metric(0);
      serperDailySpend     = metric(0);
      for (const r of spendRows) {
        const micros = Number(r.total_micros ?? 0);
        if (r.provider === "apollo")     apolloDailySpend     = metric(micros);
        if (r.provider === "outscraper") outscraperDailySpend = metric(micros);
        if (r.provider === "serper")     serperDailySpend     = metric(micros);
      }
    } catch (err: any) {
      // cro03c_stage_operations may not have a settled_at column in all
      // environments — degrade gracefully.
      const error = String(err?.message ?? "query_failed");
      apolloDailySpend = metric(null, false, error);
      outscraperDailySpend = metric(null, false, error);
      serperDailySpend = metric(null, false, error);
    }

    // ── MI-08: Per-named-worker heartbeat status ──────────────────────────
    // Each named worker is queried from background_jobs.
    // Returns per-metric { value, available, stale, staleSince? } objects.
    // Job names MUST match JOB_NAMES constants in server/services/job-registry.ts.
    // master-lead-stager uses BullMQ only (no acquireJobLock), so it is not in
    // background_jobs. It is surfaced via audit_logs last-action instead.
    const NAMED_WORKERS = [
      { key: "enrichment",       jobName: "enrichment-queue-processor" },
      { key: "ghlSync",          jobName: "ghl-sync" },
      { key: "sequenceWorker",   jobName: "sequence-worker" },
      { key: "slaWorker",        jobName: "sla-worker" },
    ] as const;
    // MI-09: CRO-08A workers tracked via BullMQ queue depth (not background_jobs)
    // because they are BullMQ-only workers (no acquireJobLock heartbeats).
    // We verify queue registration and last completed job via BullMQ metadata.

    const now2 = Date.now();
    const STALE_WORKER_MS = 30 * 60 * 1000; // 30 minutes
    let workerHeartbeats: Record<string, { available: boolean; stale: boolean; staleSince?: string; lastFinishedAt?: string | null; status?: string | null; consecutiveFailures?: number | null; minutesSince?: number | null; error?: string }> = {};
    try {
      // No .catch() here — query failures must surface as query_failed, not not_registered.
      const wRows = await db.execute(sql`
        SELECT job_name, status, last_finished_at, consecutive_failures
        FROM background_jobs
        WHERE job_name = ANY(ARRAY[${sql.raw(NAMED_WORKERS.map(w => `'${w.jobName}'`).join(","))}])
      `);
      const wData: any[] = (wRows as any)?.rows ?? wRows ?? [];
      const wMap: Record<string, any> = {};
      for (const r of wData) wMap[r.job_name] = r;

      for (const w of NAMED_WORKERS) {
        const r = wMap[w.jobName];
        if (!r) {
          workerHeartbeats[w.key] = { available: false, stale: false, error: "not_registered" };
          continue;
        }
        const lastAt = r.last_finished_at ? new Date(r.last_finished_at) : null;
        const msAgo = lastAt ? now2 - lastAt.getTime() : null;
        const stale = msAgo !== null ? msAgo > STALE_WORKER_MS : true;
        // A worker whose last run failed must be shown as failed/degraded, not green Active.
        // consecutive_failures > 0 or status = 'failed' indicates a degraded worker.
        const consecutiveFailures = Number(r.consecutive_failures ?? 0);
        workerHeartbeats[w.key] = {
          available: true,
          stale,
          ...(stale ? { staleSince: lastAt?.toISOString() ?? new Date(now2).toISOString() } : {}),
          lastFinishedAt: lastAt?.toISOString() ?? null,
          status: r.status ?? null,
          consecutiveFailures,
          minutesSince: msAgo !== null ? Math.floor(msAgo / 60000) : null,
        };
      }

      // ── master-lead-stager: BullMQ-only worker, not registered in background_jobs.
      // BullMQ worker liveness cannot be reliably derived from audit_logs: an idle
      // but healthy stager emits no audit events and would appear stale after 30 min.
      // Failed BullMQ jobs also do not surface consecutive_failures here.
      // Mark explicitly as not monitorable via this mechanism.
      workerHeartbeats.stager = {
        available: false,
        stale: false,
        error: "bullmq_only",
      };
      // MI-09: CRO-08A workers are BullMQ-only (no background_jobs heartbeats).
      // Verify their presence by checking for recent completed BullMQ jobs
      // from audit_logs (cro08a-scheduler and cro08a-processor write audit entries).
      // Mark both as bullmq_only with queue-verified=true when queue is initialized.
      workerHeartbeats.cro08aScheduler = {
        available: false,
        stale: false,
        error: "bullmq_only",
      };
      workerHeartbeats.cro08aProcessor = {
        available: false,
        stale: false,
        error: "bullmq_only",
      };
    } catch {
      // Worker heartbeat query failed — mark all unavailable
      for (const w of NAMED_WORKERS) {
        workerHeartbeats[w.key] = { available: false, stale: false, error: "query_failed" };
      }
      workerHeartbeats.stager = { available: false, stale: false, error: "query_failed" };
      workerHeartbeats.cro08aScheduler = { available: false, stale: false, error: "query_failed" };
      workerHeartbeats.cro08aProcessor = { available: false, stale: false, error: "query_failed" };
    }

    // ── Enrichment-worker stale alert ─────────────────────────────────────────
    // Authoritative boolean derived server-side using exact ms comparison so the
    // client never has to deal with rounding. Only the enrichment worker is in
    // scope: other workers have independent cadences and must not trigger this
    // alert even if their last heartbeat is older than the threshold.
    const enrichmentHb = workerHeartbeats.enrichment;
    let enrichmentWorkerStaleAlert = false;
    if (enrichmentHb?.available && !enrichmentHb.error) {
      const enrichLastAt = enrichmentHb.lastFinishedAt ? new Date(enrichmentHb.lastFinishedAt) : null;
      const enrichMsAgo = enrichLastAt !== null ? now2 - enrichLastAt.getTime() : null;
      // null msAgo means no heartbeat ever recorded → treat as stale
      enrichmentWorkerStaleAlert = enrichMsAgo === null || enrichMsAgo > workerStalenessThresholdMs;
    }

    // ── MI-08: Pipeline counts from /api/master-leads/pipeline-stats ────
    // These are fetched in-process for the health endpoint.
    // Pipeline counts mirror the authoritative /api/master-leads/pipeline-stats
    // predicates (server/routes/imports.ts:2776-2813):
    //  - staged/promoted: master_leads WHERE pipeline_origin='cro03_pipeline'
    //  - suppressed/duplicate: master_lead_staging_receipts by disposition
    //  - readyToPromote: JOIN businesses on email_discovery_status='provider_valid'
    //    AND NOT EXISTS open canonical_conflict_evidence
    // master_leads does NOT have open_conflict_count or email_discovery_status columns.
    let pipelineCounts: { value: { staged: number; readyToPromote: number; promoted: number; suppressed: number; duplicates: number } | null; available: boolean; stale: boolean; error?: string } = { value: null, available: false, stale: false };
    try {
      const [stagedResult, suppressedResult, duplicateResult, promotedResult, readyResult] = await Promise.all([
        db.execute(sql`SELECT COUNT(*)::int AS cnt FROM master_leads WHERE pipeline_origin='cro03_pipeline' AND status='staged'`),
        db.execute(sql`SELECT COUNT(*)::int AS cnt FROM master_lead_staging_receipts WHERE disposition='suppressed'`),
        db.execute(sql`SELECT COUNT(*)::int AS cnt FROM master_lead_staging_receipts WHERE disposition='duplicate'`),
        db.execute(sql`SELECT COUNT(*)::int AS cnt FROM master_leads WHERE pipeline_origin='cro03_pipeline' AND status='promoted'`),
        db.execute(sql`
          SELECT COUNT(*)::int AS cnt
          FROM master_leads ml
          JOIN businesses b ON b.id = ml.canonical_business_id
          WHERE ml.pipeline_origin = 'cro03_pipeline'
            AND ml.status = 'staged'
            AND b.email_discovery_status = 'provider_valid'
            AND NOT EXISTS (
              SELECT 1 FROM canonical_conflict_evidence cce
              WHERE (cce.business_id_a = ml.canonical_business_id OR cce.business_id_b = ml.canonical_business_id)
                AND cce.status = 'open'
            )
        `),
      ]);
      const cnt = (r: any) => Number(((r as any).rows ?? r)[0]?.cnt ?? 0);
      pipelineCounts = {
        available: true, stale: false,
        value: {
          staged:         cnt(stagedResult),
          readyToPromote: cnt(readyResult),
          promoted:       cnt(promotedResult),
          suppressed:     cnt(suppressedResult),
          duplicates:     cnt(duplicateResult),
        },
      };
    } catch (err: any) {
      // A failed DB query must never be collapsed to zero. Return available:false
      // with an error indicator so the UI can distinguish a real zero from a failure.
      pipelineCounts = { value: null, available: false, stale: false, error: String(err?.message ?? "query_failed") };
    }

    // ── Correction #7: stuck-processing count + scheduler status ─────────────
    // Correction #3 removed the competing 4-hour fence producer. Expose the
    // canonical scheduler state (FREE_ENRICHMENT_LANE BullMQ queue) alongside
    // a count of businesses currently stuck in 'processing' so admins can see
    // the reaper is keeping the queue healthy.
    let businessStuckProcessingCount: { value: number | null; available: boolean; error?: string } = { value: null, available: false };
    let candidateFunnel: { staged: number; validationAdmitted: number; suppressed: number; stalled: number } | null = null;
    let candidateFunnelAvailable = false;
    try {
      const [stuckResult, funnelResult] = await Promise.all([
        db.execute(sql`
          SELECT COUNT(*)::int AS cnt FROM businesses
          WHERE free_enrichment_status = 'processing'
        `),
        db.execute(sql`
          SELECT disposition, COUNT(*)::int AS cnt
          FROM free_discovery_candidates
          GROUP BY disposition
        `),
      ]);
      businessStuckProcessingCount = {
        value: Number(((stuckResult as any).rows ?? stuckResult)[0]?.cnt ?? 0),
        available: true,
      };
      const funnelRows: any[] = (funnelResult as any).rows ?? funnelResult ?? [];
      const funnelByDisp: Record<string, number> = {};
      for (const r of funnelRows) funnelByDisp[r.disposition] = Number(r.cnt ?? 0);
      candidateFunnel = {
        staged:            funnelByDisp["staged"]             ?? 0,
        validationAdmitted: funnelByDisp["validation_admitted"] ?? 0,
        suppressed:        funnelByDisp["suppressed"]          ?? 0,
        stalled:           funnelByDisp["stalled"]             ?? 0,
      };
      candidateFunnelAvailable = true;
    } catch {
      businessStuckProcessingCount = { value: null, available: false, error: "query_failed" };
    }

    // Canonical scheduler info: after Correction #3, FREE_ENRICHMENT_LANE is the
    // only producer. Reflect the flag state so UI can show "single producer active"
    // vs "scheduler disabled" without guessing from queue depth alone.
    const freeEnrichmentSchedulerStatus = {
      singleProducer: "FREE_ENRICHMENT_LANE",
      legacyFenceRemoved: true,
      schedulerEnabled: !!(featureFlags as any).FREE_ENRICHMENT_ENABLED,
    };

    return {
      enrichedToday:        metric(Number(row.enriched_today ?? 0), throughputAvailable, throughputAvailable ? undefined : "query_failed"),
      emailsToday:          metric(Number(row.emails_today ?? 0), throughputAvailable, throughputAvailable ? undefined : "query_failed"),
      phonesToday:          metric(Number(row.phones_today ?? 0), throughputAvailable, throughputAvailable ? undefined : "query_failed"),
      queueDepth:           metric(Number(row.queue_depth ?? 0), throughputAvailable, throughputAvailable ? undefined : "query_failed"),
      totalEnriched:        metric(Number(row.total_enriched ?? 0), throughputAvailable, throughputAvailable ? undefined : "query_failed"),
      totalFailed:          metric(Number(row.total_failed ?? 0), throughputAvailable, throughputAvailable ? undefined : "query_failed"),
      successRate:          metric(successRate, throughputAvailable, throughputAvailable ? undefined : "query_failed"),
      lastEnrichedAt:       lastEnrichedAt?.toISOString() ?? null,
      minutesSinceLastJob:  minutesSinceLastJob,
      workerActive,
      // ── Worker-authority truth fields ───────────────────────────────────
      intakeAuthority,
      enrichmentProgressStatus,
      sunbizEnrichmentEnabled,
      freeEnrichmentPendingJobs:        freeEnrichPending,
      lastScheduledEnrichmentAt:        lastScheduledEnrichmentAtDerived,
      // ── MI-04: Canonical free enrichment queue depth ────────────────────
      canonicalFreeEnrichmentQueueDepth,
      // ── MI-02: Source registry adapters (additive) ─────────────────────
      sourceRegistryAdapters,
      sourceRegistryCounts,
      // ── MI-05: Provider spend (last 24 h, from cro03c_stage_operations) ─
      apolloDailySpend,
      outscraperDailySpend,
      serperDailySpend,
      // ── MI-08: Per-named-worker heartbeats (per-metric availability) ────
      workerStalenessThresholdMs,
      enrichmentWorkerStaleAlert,
      workerHeartbeats,
      // ── MI-09: CRO-08A scheduler/processor worker heartbeats ────────────
      cro08aSchedulerHeartbeat: workerHeartbeats.cro08aScheduler,
      cro08aProcessorHeartbeat: workerHeartbeats.cro08aProcessor,
      // ── MI-08: Pipeline counts (from master_leads) ──────────────────────
      pipelineCounts,
      // ── MI-08: Free enrichment queue split ──────────────────────────────
      // Queue depths wrapped with availability metadata so UI can distinguish
      // a real zero from an unavailable/failed query (fail-closed behavior).
      freeEnrichQueueDepth: {
        free: canonicalFreeQueueAvailable
          ? { value: canonicalFreeEnrichmentQueueDepth, available: true }
          : { value: null, available: false, error: "query_failed" },
        paid: paidQueueAvailable
          ? { value: paidQueueDepth, available: true }
          : { value: null, available: false, error: "query_failed" },
      },
      // ── Correction #7: scheduler status + stuck processing count ────────
      freeEnrichmentSchedulerStatus,
      businessStuckProcessingCount,
      candidateFunnel: candidateFunnelAvailable ? candidateFunnel : null,
    };
  }

  /**
   * Coalescing cache refresh: concurrent misses all await the **same** in-flight
   * Promise.  Both the creator and any joiners go through the same stale-fallback
   * try/catch, so every caller gets stale data (with isStale:true) when the
   * computation fails and a previous cache entry exists.
   *
   * Generation tracking prevents a stale/orphaned computation (e.g. one that was
   * started before a manual cache invalidation) from overwriting a newer result or
   * clearing a newer _healthInflight value.
   */
  async function getOrRefreshHealth(): Promise<{ data: any; isStale: boolean }> {
    const now = Date.now();
    const ttl = HEALTH_CACHE_TEST_MODE ? 0 : HEALTH_CACHE_TTL_MS;
    if (_healthCache && now - _healthCache.ts < ttl) {
      return { data: _healthCache.data, isStale: false };
    }

    if (!_healthInflight) {
      // First caller after a cache miss — own this generation and start computation.
      const gen = ++_healthGeneration;
      _healthInflight = runHealthComputation()
        .then((data) => {
          if (HEALTH_CACHE_TEST_MODE) _healthTestRoundTrips++;
          // Only publish if our generation is still current (not superseded by reset).
          if (_healthGeneration === gen) {
            _healthCache = { data, ts: Date.now() };
          }
          return data;
        })
        .finally(() => {
          // Only clear the shared pointer if it is still ours.
          if (_healthGeneration === gen) {
            _healthInflight = null;
          }
        });
      // Note: rejection is intentionally left unhandled on the promise itself so
      // that all awaiting callers (below) receive the rejection and can apply the
      // stale-fallback logic uniformly.
    }

    // Every caller — creator and all joiners — awaits here with the same error
    // handling so stale-data fallback is applied to every concurrent request.
    try {
      const data = await _healthInflight!;
      return { data, isStale: false };
    } catch (err) {
      if (_healthCache) {
        console.error("[LeadOps] health refresh failed — serving stale cache:", (err as Error)?.message);
        return { data: _healthCache.data, isStale: true };
      }
      throw err;
    }
  }

  app.get("/api/lead-ops/health", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { data, isStale } = await getOrRefreshHealth();
      // Always inject the live in-memory counter (not cached — resets on restart).
      res.json({
        ...data,
        legacyRouteAttemptsSinceStartup: _legacyRouteAttemptsSinceStartup,
        ...(isStale ? { isStale: true } : {}),
        ...(HEALTH_CACHE_TEST_MODE ? { __dbRoundTrips: _healthTestRoundTrips } : {}),
      });
    } catch (err: any) {
      console.error("[LeadOps] health error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to load health stats" });
    }
  });

  // ── POST /api/lead-ops/reset-stuck-jobs ────────────────────────────────────
  // Resets sunbiz_entities rows that are stuck in 'processing' status for more
  // than 30 minutes — these are entities the enrichment worker started but never
  // finished (e.g. after a worker crash or restart). Resetting them to 'pending'
  // lets the worker pick them up on its next tick.
  //
  // NOTE: This intentionally does NOT touch the BullMQ enrichment queue because
  // that queue is shared with other critical job types (statement-blueprint,
  // free-contact-enrichment, contact_lead_scoring, etc.) that are unrelated to
  // the Sunbiz enrichment pipeline and must not be removed.
  app.post("/api/lead-ops/reset-stuck-jobs", requireRole("admin"), async (_req, res) => {
    try {
      const result = await db.execute(sql`
        UPDATE sunbiz_entities
        SET enrichment_status = 'pending', updated_at = NOW()
        WHERE enrichment_status = 'processing'
          AND updated_at < NOW() - INTERVAL '30 minutes'
        RETURNING id
      `);
      const cleared = ((result as any).rows ?? result).length;

      await storage.createAuditLog({
        action: "lead_ops_reset_stuck_jobs",
        entityType: "system",
        entityId: 0,
        details: { cleared, method: "db_processing_reset" },
      });

      // Bust the health cache so the next poll reflects updated counts.
      // Incrementing _healthGeneration orphans any in-flight computation: its
      // .then() and .finally() callbacks will see a generation mismatch and
      // will neither overwrite _healthCache nor clear _healthInflight.
      _healthCache = null;
      _healthGeneration++;
      _healthInflight = null;

      res.json({
        cleared,
        message: cleared > 0
          ? `Reset ${cleared} stuck enrichment job(s) from "processing" back to "pending". The enrichment worker will pick them up on its next tick.`
          : "No stuck jobs found — no entities have been in \"processing\" state for more than 30 minutes.",
      });
    } catch (err: any) {
      console.error("[LeadOps] reset-stuck-jobs error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to reset stuck jobs" });
    }
  });

  // ── GET /api/lead-ops/businesses/:businessId ──────────────────────────────
  // MI-04 + MI-08: Returns a single businesses row, processor_signals, and
  // MI-08 evidence chain (source links, source observations, qualification
  // decisions, field claim, master_lead staging state).
  // Role: admin + manager (existing). MI-08 adds role-based field redaction:
  // agent role must not receive unmasked email or phone (agent cannot reach
  // this route — requireRole blocks them — but the redaction is documented
  // here for future agent-safe view tasks).
  // NOTE: Do NOT reuse the Sunbiz /entities endpoint — businesses and sunbiz_entities
  // are separate tables with different schemas.
  app.get("/api/lead-ops/businesses/:businessId", requireRole("admin", "manager"), async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ error: "Invalid businessId" });
    try {
      const [bizResult, signalsResult] = await Promise.all([
        db.execute(sql`
          SELECT id, canonical_name, normalized_name, website_domain, main_phone, main_email,
                 city, state, vertical, status, street_address, latitude, longitude,
                 free_enrichment_status, free_enrichment_attempt_count,
                 free_enrichment_last_attempt_at, free_enrichment_completed_at,
                 free_enrichment_last_error_code, free_enrichment_evidence,
                 email_discovery_status, email_validation_updated_at,
                 email_selected_candidate_hash, email_outreach_catch_all_approved_at,
                 email_outreach_approved_by, record_class, created_at, updated_at
          FROM businesses WHERE id = ${businessId}
        `),
        db.execute(sql`
          SELECT id, signal_type, vendor_name, detection_method, confidence_score, evidence, detected_at
          FROM processor_signals WHERE business_id = ${businessId}
          ORDER BY detected_at DESC
        `).catch(() => null),
      ]);
      const biz = ((bizResult as any).rows ?? bizResult)[0];
      if (!biz) return res.status(404).json({ error: "Business not found" });
      const signals = ((signalsResult as any)?.rows ?? signalsResult) ?? [];

      // MI-06: derive isStale boolean from email_validation_updated_at.
      // Kill line: do NOT mutate email_discovery_status during GET handler.
      const STALE_DAYS = 180;
      const emailValidationUpdatedAt = biz.email_validation_updated_at ? new Date(biz.email_validation_updated_at) : null;
      const isStale = emailValidationUpdatedAt
        ? (Date.now() - emailValidationUpdatedAt.getTime()) > STALE_DAYS * 24 * 3600 * 1000 &&
          biz.email_discovery_status === "provider_valid"
        : false;

      // MI-06: load winner selection and pending intent for this business (if any).
      // MI-08: load evidence chain in parallel.
      const [winnerResult, intentResult, sourceLinksResult, qualDecisionResult, fieldClaimResult, masterLeadResult, sourceObservationsResult, existingContactResult, emailCandidatesResult] = await Promise.all([
        db.execute(sql`
          SELECT ws.id, ws.source, ws.subject_type, ws.confidence, ws.state,
                 ws.normalized_value_hash, ce.masked_value
            FROM cro03c_email_winner_selections ws
            LEFT JOIN cro03c_candidate_evidence ce ON ce.id = ws.candidate_evidence_id
           WHERE ws.business_id = ${businessId} AND ws.state = 'selected'
           ORDER BY ws.created_at DESC LIMIT 1
        `).catch(() => null),
        db.execute(sql`
          SELECT id, state, approval_required, apollo_match_confidence, disposition,
                 attempt_count, created_at
            FROM business_validation_intents
           WHERE business_id = ${businessId}
             AND state NOT IN ('superseded','revoked','completed','failed')
           ORDER BY created_at DESC LIMIT 1
        `).catch(() => null),
        // MI-08: source provenance chain
        db.execute(sql`
          SELECT csl.id, csl.source_system, csl.source_type, csl.stable_key,
                 csl.registry_id, csl.first_seen_at, csl.last_confirmed_at,
                 -- latest import run for this adapter
                 (SELECT sir.status FROM source_import_runs sir
                  WHERE sir.adapter_key = csl.source_system
                  ORDER BY sir.created_at DESC LIMIT 1) AS last_import_status,
                 (SELECT sir.completed_at FROM source_import_runs sir
                  WHERE sir.adapter_key = csl.source_system AND sir.status = 'completed'
                  ORDER BY sir.completed_at DESC LIMIT 1) AS last_import_completed_at,
                 -- adapter metadata
                 (SELECT sra.source_name FROM source_registry_adapters sra
                  WHERE sra.adapter_key = csl.source_system LIMIT 1) AS adapter_source_name,
                 (SELECT sra.source_type FROM source_registry_adapters sra
                  WHERE sra.adapter_key = csl.source_system LIMIT 1) AS adapter_source_type
          FROM canonical_source_links csl
          WHERE csl.business_id = ${businessId}
          ORDER BY csl.last_confirmed_at DESC
          LIMIT 10
        `).catch(() => null),
        // MI-08: latest qualification decision via cro03a_handoffs + cro03a_qualification_decisions.
        // Correlate on BOTH source_type AND stable_key from canonical_source_links to ensure
        // we return the decision for THIS business, not another business on the same source system.
        db.execute(sql`
          SELECT qd.id, qd.disposition, qd.score, qd.reason_codes, qd.fit_components,
                 qd.missing_field_classes, qd.created_at,
                 h.source_type, h.source_system, h.source_key
          FROM canonical_source_links csl
          JOIN cro03a_handoffs h
            ON h.source_system = csl.source_system
           AND h.source_type   = csl.source_type
           AND h.source_key    = csl.stable_key
          JOIN cro03a_qualification_decisions qd ON qd.id = h.decision_id
          WHERE csl.business_id = ${businessId}
          ORDER BY qd.created_at DESC LIMIT 1
        `).catch(() => null),
        // MI-08: active field claim for this business
        db.execute(sql`
          SELECT frs.id, frs.status, frs.claimed_at, frs.claimed_by_user_id,
                 u.email AS claimed_by_email
          FROM field_route_stops frs
          LEFT JOIN users u ON u.id = frs.claimed_by_user_id
          WHERE frs.business_id = ${businessId} AND frs.status = 'claimed'
          ORDER BY frs.claimed_at DESC LIMIT 1
        `).catch(() => null),
        // MI-08: master_lead staging state for this business.
        // NOTE: master_leads does NOT have open_conflict_count or email_discovery_status.
        // Actual columns: id, status, fit_tier, quality_score, email_type, email_valid,
        // suppression_reason, promoted_at, created_at, pipeline_origin, canonical_business_id.
        db.execute(sql`
          SELECT id, status, fit_tier, quality_score, email_type, email_valid,
                  suppression_reason, promoted_at, created_at, county_fips
          FROM master_leads
          WHERE canonical_business_id = ${businessId}
            AND pipeline_origin = 'cro03_pipeline'
          ORDER BY created_at DESC LIMIT 1
        `).catch(() => null),
        // MI-08: source observations/occurrences — operating status evidence.
        // Joins canonical_source_links → cro03_source_subjects → cro03_source_observations.
        // cro03_source_observations.payload is encrypted (payloadHash only, not decrypted here).
        db.execute(sql`
          SELECT obs.id, obs.observed_at, obs.observed_by_actor_type,
                 obs.provenance, obs.payload_hash,
                 occ.source_observed_at, occ.timestamp_provenance, occ.source_event_key,
                 ss.source_system, ss.subject_type, ss.subject_key
          FROM canonical_source_links csl
          JOIN cro03_source_subjects ss
            ON ss.source_system = csl.source_system
           AND ss.subject_type  = csl.source_type
           AND ss.subject_key   = csl.stable_key
          JOIN cro03_source_observations obs ON obs.source_subject_id = ss.id
          JOIN cro03_source_occurrences  occ ON occ.source_observation_id = obs.id
          WHERE csl.business_id = ${businessId}
          ORDER BY occ.source_observed_at DESC
          LIMIT 5
        `).catch(() => null),
        // Existing contact/customer check. Contacts stores the canonical phone
        // in its legacy phone column, so normalize digits at comparison time;
        // website is similarly normalized to a hostname before comparing.
        db.execute(sql`
          SELECT c.id, c.email_status, c.phone, c.lifecycle_state
          FROM contacts c
          CROSS JOIN businesses b
          WHERE b.id = ${businessId}
            AND (
              (b.email_selected_candidate_hash IS NOT NULL
                AND c.email_token_hash = b.email_selected_candidate_hash)
              OR (
                b.main_phone IS NOT NULL
                AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')
                    = regexp_replace(b.main_phone, '[^0-9]', '', 'g')
              )
              OR (
                b.website_domain IS NOT NULL
                AND regexp_replace(
                  regexp_replace(lower(COALESCE(c.website, '')), '^https?://(www\\.)?', ''),
                  '/.*$', ''
                ) = lower(b.website_domain)
              )
            )
          LIMIT 1
        `).catch(() => null),
        db.execute(sql`
          SELECT COUNT(*)::int AS candidate_count,
                 (SELECT fdc.masked_value
                    FROM free_discovery_candidates fdc
                   WHERE fdc.business_id = ${businessId}
                     AND fdc.field = 'email'
                     AND fdc.subject_type = 'business'
                     AND fdc.disposition = 'staged'
                   ORDER BY fdc.created_at DESC
                   LIMIT 1) AS masked_candidate_email_preview
            FROM free_discovery_candidates fdc
           WHERE fdc.business_id = ${businessId}
             AND fdc.field = 'email'
             AND fdc.subject_type = 'business'
             AND fdc.disposition = 'staged'
        `),
      ]);

      const winnerSelection = winnerResult ? (((winnerResult as any).rows ?? winnerResult)[0] ?? null) : null;
      const pendingIntent = intentResult ? (((intentResult as any).rows ?? intentResult)[0] ?? null) : null;
      const emailCandidates = (((emailCandidatesResult as any).rows ?? emailCandidatesResult)[0] ?? null);
      const sourceLinks = (sourceLinksResult as any)?.rows ?? sourceLinksResult ?? [];
      const qualDecision = qualDecisionResult ? (((qualDecisionResult as any).rows ?? qualDecisionResult)[0] ?? null) : null;
      const fieldClaim = fieldClaimResult ? (((fieldClaimResult as any).rows ?? fieldClaimResult)[0] ?? null) : null;
      const masterLead = masterLeadResult ? (((masterLeadResult as any).rows ?? masterLeadResult)[0] ?? null) : null;
      // sourceObservations: operating-status evidence from cro03_source_observations/occurrences.
      // Raw payload is NOT returned (encrypted in DB); only provenance metadata is exposed.
      const sourceObservations: any[] = (sourceObservationsResult as any)?.rows ?? sourceObservationsResult ?? [];
      // Track query success/failure separately from "no match found".
      // null existingContactResult means the query threw (catch → null);
      // a successful query with no rows returns an empty array → existingContact = null.
      const contactMatchAvailable = existingContactResult !== null;
      const existingContact = contactMatchAvailable
        ? (((existingContactResult as any).rows ?? existingContactResult)[0] ?? null)
        : null;

      // MI-08: count open conflicts from canonical_conflict_evidence (the authoritative source).
      // Used in safeNextAction derivation and returned on masterLead for the UI.
      // MUST NOT fail open: a query failure must be represented as unknown, not zero.
      let openConflictCount = 0;
      let conflictEvidenceAvailable = false;
      try {
        const conflictResult = await db.execute(sql`
          SELECT COUNT(*)::int AS cnt
          FROM canonical_conflict_evidence
          WHERE (business_id_a = ${businessId} OR business_id_b = ${businessId})
            AND status = 'open'
        `);
        openConflictCount = Number(((conflictResult as any).rows ?? conflictResult)[0]?.cnt ?? 0);
        conflictEvidenceAvailable = true;
      } catch {
        // Query failed — treat as unknown (not promotable) to avoid fail-open.
        conflictEvidenceAvailable = false;
      }

      // MI-08: role-based field redaction.
      // agent role must not receive unmasked email or phone. admin/manager receive full data.
      // (requireRole currently blocks agents entirely, but redaction is applied defensively.)
      const userRole = (req as any).user?.role ?? "agent";
      const canSeeContactDetails = userRole === "admin" || userRole === "manager";
      const redactedBiz = {
        ...biz,
        main_email: canSeeContactDetails ? biz.main_email : null,
        main_phone: canSeeContactDetails ? biz.main_phone : null,
      };

      const safeNextAction = deriveCanonicalBusinessSafeNextAction({
        masterLeadStatus: masterLead?.status,
        emailDiscoveryStatus: biz.email_discovery_status,
        mainEmail: biz.main_email,
        freeEnrichmentStatus: biz.free_enrichment_status,
        catchAllOutreachApprovedAt: biz.email_outreach_catch_all_approved_at,
        openConflictCount,
        conflictEvidenceAvailable,
        contactMatchAvailable,
        hasExistingContact: Boolean(existingContact),
      });
      const emailEvidenceDisplay = buildCanonicalBusinessEmailDisplay({
        emailDiscoveryStatus: biz.email_discovery_status,
        candidateCount: emailCandidates?.candidate_count,
        maskedCandidateEmailPreview: emailCandidates?.masked_candidate_email_preview,
        selectedWinner: winnerSelection,
        validationIntent: pendingIntent,
      });
      const displayWinnerSelection = winnerSelection
        ? { ...winnerSelection, masked_value: emailEvidenceDisplay.selectedWinner?.maskedValue ?? null }
        : null;

      res.json({
        business: redactedBiz,
        processorSignals: signals,
        emailDiscoveryStatus: biz.email_discovery_status ?? null,
        emailValidationUpdatedAt: biz.email_validation_updated_at ?? null,
        isStale,
        winnerSelection: displayWinnerSelection,
        pendingIntent,
        emailEvidenceDisplay,
        // ── MI-08: evidence chain ────────────────────────────────────────────
        sourceLinks,
        qualificationDecision: qualDecision,
        fieldClaim: fieldClaim ? {
          status: fieldClaim.status,
          claimedAt: fieldClaim.claimed_at,
          claimedByUserId: fieldClaim.claimed_by_user_id,
          // agent email redacted from this endpoint since it's admin/manager only
          claimedByEmail: canSeeContactDetails ? fieldClaim.claimed_by_email : null,
        } : null,
        masterLead: masterLead ? { ...masterLead, openConflictCount } : null,
         contactMatchAvailable,
         existingContactMatch: existingContact ? {
           id: existingContact.id,
           emailStatus: existingContact.email_status ?? null,
           lifecycleState: existingContact.lifecycle_state ?? null,
         } : null,
         conflictCount: openConflictCount,
         conflictEvidenceAvailable,
        safeNextAction,
        // operating-status evidence from cro03_source_observations/occurrences
        // (provenance metadata only — raw payload not exposed)
        sourceObservations,
      });
    } catch (err: any) {
      console.error("[LeadOps] businesses/:id error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to load business" });
    }
  });

  // ── POST /api/lead-ops/businesses/:businessId/enrich-free ─────────────────
  // MI-04: Manually enqueue a single free enrichment job for a canonical business.
  // Returns 202. Must use /businesses/:businessId — NOT /entities/:id.
  app.post("/api/lead-ops/businesses/:businessId/enrich-free", requireRole("admin", "manager"), async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ error: "Invalid businessId" });
    try {
      // Validate the business is canonical before enqueueing
      const bizCheck = await db.execute(sql`
        SELECT id, record_class FROM businesses WHERE id = ${businessId}
      `);
      const biz = ((bizCheck as any).rows ?? bizCheck)[0];
      if (!biz) return res.status(404).json({ error: "Business not found" });
      if (biz.record_class !== "canonical") {
        return res.status(422).json({
          error: `Business #${businessId} has record_class='${biz.record_class}'; only canonical businesses are eligible for free enrichment`
        });
      }

      const { requireQueueManagerReady, QUEUE_NAMES } = await import("../services/queue-manager");
      const qm = requireQueueManagerReady();
      const enrichmentQueue = qm.getQueue(QUEUE_NAMES.ENRICHMENT);
      if (!enrichmentQueue) return res.status(503).json({ error: "Enrichment queue not available" });

      await enrichmentQueue.add(
        "free-contact-enrichment",
        { businessId },
        {
          jobId: `free-business-enrichment-manual-${businessId}-${Date.now()}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 100 },
        }
      );
      res.status(202).json({ queued: true, businessId });
    } catch (err: any) {
      console.error("[LeadOps] enrich-free error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to enqueue enrichment" });
    }
  });

  // ── MI-06: POST /api/lead-ops/businesses/:businessId/trigger-winner-selection ──
  // Manually triggers winner selection for a specific business (admin only).
  // Required for Phase 2 rollout.
  app.post("/api/lead-ops/businesses/:businessId/trigger-winner-selection", requireRole("admin"), async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ error: "Invalid businessId" });
    const { generationId } = req.body ?? {};
    if (!generationId || typeof generationId !== "string") {
      return res.status(400).json({ error: "generationId (string) is required" });
    }
    try {
      const { selectEmailWinner } = await import("../services/cro03/candidate-selector");
      const result = await selectEmailWinner(businessId, generationId);
      res.json(result);
    } catch (err: any) {
      console.error("[LeadOps] trigger-winner-selection error:", err?.message);
      res.status(500).json({ error: err?.message || "Winner selection failed" });
    }
  });

  // ── MI-06: POST /api/lead-ops/businesses/:businessId/approve-catch-all ───────
  // Approve a catch-all result for outreach use. Does NOT change email_discovery_status.
  // Only writes email_outreach_catch_all_approved_at and email_outreach_approved_by.
  app.post("/api/lead-ops/businesses/:businessId/approve-catch-all", requireRole("admin"), async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ error: "Invalid businessId" });
    try {
      const bizCheck = await db.execute(sql`
        SELECT id, email_discovery_status, email_selected_candidate_hash
          FROM businesses WHERE id = ${businessId}
      `);
      const biz = ((bizCheck as any).rows ?? bizCheck)[0];
      if (!biz) return res.status(404).json({ error: "Business not found" });
      if (biz.email_discovery_status !== "provider_catch_all") {
        return res.status(422).json({
          error: `Catch-all approval is only valid when email_discovery_status='provider_catch_all'. Current status: '${biz.email_discovery_status}'`,
        });
      }
      // CAS: bind approval to the current winning candidate hash.
      // Prevents stale approvals from authorizing future, different candidates.
      const selectedHash = biz.email_selected_candidate_hash;
      if (!selectedHash) {
        return res.status(422).json({ error: "No selected candidate hash — winner selection not yet complete." });
      }
      const actor = (req as any).user?.id ?? (req as any).user?.email ?? "admin";
      // Decrypt the winner candidate email so we can write main_email.
      // SDR consumers (compliance-engine, voice-orchestrator, sdr.ts) gate on
      // mainEmail IS NOT NULL — without this write, catch-all approval has no
      // outreach effect regardless of the approval metadata.
      const winnerEvidence = ((await db.execute(sql`
        SELECT ce.envelope_ciphertext, ce.envelope_nonce, ce.envelope_tag,
               ce.envelope_key_version, ce.field
          FROM cro03c_email_winner_selections ws
          JOIN cro03c_candidate_evidence ce ON ce.id = ws.candidate_evidence_id
         WHERE ws.business_id = ${businessId}
           AND ws.state = 'selected'
           AND ws.normalized_value_hash = ${String(selectedHash)}
         LIMIT 1
      `)) as any)?.rows?.[0];
      if (!winnerEvidence) {
        return res.status(422).json({ error: "Winner candidate evidence not found for the current selected hash." });
      }

      let decryptedEmail: string;
      try {
        const { unseal } = await import("../services/cro03/candidate-evidence-service");
        decryptedEmail = unseal(String(winnerEvidence.field), {
          ciphertext: String(winnerEvidence.envelope_ciphertext),
          nonce: String(winnerEvidence.envelope_nonce),
          tag: String(winnerEvidence.envelope_tag),
          keyVersion: Number(winnerEvidence.envelope_key_version),
        });
      } catch {
        return res.status(500).json({ error: "Failed to decrypt winner email for approval." });
      }

      const updated = ((await db.execute(sql`
        UPDATE businesses
           SET email_outreach_catch_all_approved_at = NOW(),
               email_outreach_approved_by = ${String(actor)},
               email_outreach_approved_candidate_hash = ${String(selectedHash)},
               main_email = ${decryptedEmail},
               updated_at = NOW()
         WHERE id = ${businessId}
           AND email_discovery_status = 'provider_catch_all'
           AND email_selected_candidate_hash = ${String(selectedHash)}
         RETURNING id
      `)) as any)?.rows ?? [];
      if (updated.length === 0) {
        return res.status(409).json({
          error: "Approval CAS failed — email_discovery_status or selected candidate hash changed concurrently.",
        });
      }
      res.json({
        success: true,
        message: "Catch-all approved for outreach. main_email written from winner candidate. email_discovery_status unchanged.",
        emailDiscoveryStatus: biz.email_discovery_status,
        approvedCandidateHash: selectedHash,
      });
    } catch (err: any) {
      console.error("[LeadOps] approve-catch-all error:", err?.message);
      res.status(500).json({ error: err?.message || "Approval failed" });
    }
  });

  // ── MI-06: POST /api/lead-ops/businesses/:businessId/approve-medium-confidence-validation ──
  // Approve a medium-confidence intent for ZeroBounce validation.
  // Sets approval_required=FALSE so the intent can be claimed.
  // SEPARATE from catch-all approval — different route, different modal, different action.
  app.post("/api/lead-ops/businesses/:businessId/approve-medium-confidence-validation", requireRole("admin"), async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ error: "Invalid businessId" });
    const { intentId } = req.body ?? {};
    if (!intentId || typeof intentId !== "string") {
      return res.status(400).json({ error: "intentId (string) is required" });
    }
    try {
      const intentCheck = await db.execute(sql`
        SELECT id, state, approval_required, apollo_match_confidence
          FROM business_validation_intents
         WHERE id = ${intentId}::uuid AND business_id = ${businessId}
      `);
      const intent = ((intentCheck as any).rows ?? intentCheck)[0];
      if (!intent) return res.status(404).json({ error: "Intent not found for this business" });
      if (intent.state !== "pending" || !intent.approval_required) {
        return res.status(422).json({
          error: `Intent must be in state='pending' with approval_required=TRUE. State: '${intent.state}', approval_required: ${intent.approval_required}`,
        });
      }
      await db.execute(sql`
        UPDATE business_validation_intents
           SET approval_required = FALSE, updated_at = NOW()
         WHERE id = ${intentId}::uuid
           AND business_id = ${businessId}
           AND state = 'pending'
           AND approval_required = TRUE
      `);
      res.json({
        success: true,
        message: "Medium-confidence intent approved for ZeroBounce validation.",
        intentId,
        note: "The intent is now eligible for claim. This does NOT approve for outreach — ZeroBounce must confirm validity first.",
      });
    } catch (err: any) {
      console.error("[LeadOps] approve-medium-confidence-validation error:", err?.message);
      res.status(500).json({ error: err?.message || "Approval failed" });
    }
  });

  // ── GET /api/lead-ops/businesses ─────────────────────────────────────────
  // MI-08: Paginated canonical businesses list for the Businesses tab.
  // Supports search, vertical filter, email_discovery_status filter, fit-tier
  // (from master_leads). Role: admin, manager.
  app.get("/api/lead-ops/businesses", requireRole("admin", "manager"), async (req, res) => {
    const limit  = Math.min(Number(req.query.limit)  || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const vertical = typeof req.query.vertical === "string" ? req.query.vertical : "";
    const emailStatus = typeof req.query.emailStatus === "string" ? req.query.emailStatus : "";

    try {
      const rows = await db.execute(sql`
        SELECT
          b.id,
          b.canonical_name,
          b.website_domain,
          b.city,
          b.state,
          ${sql.raw(effectiveBusinessVerticalSql("b"))} AS vertical,
          b.vertical AS raw_vertical,
          b.record_class,
          b.free_enrichment_status,
          b.email_discovery_status,
          b.email_outreach_catch_all_approved_at,
          b.email_validation_updated_at,
          b.latitude,
          b.longitude,
          b.street_address,
           -- County is carried by the CRO-03 pipeline master lead row.
           (SELECT ml.county_fips FROM master_leads ml
            WHERE ml.canonical_business_id = b.id
            ORDER BY ml.created_at DESC LIMIT 1)              AS county_fips,
          b.main_phone,
          b.created_at,
          -- Latest master_lead fit_tier for this business
          (SELECT ml.fit_tier FROM master_leads ml
           WHERE ml.canonical_business_id = b.id
           ORDER BY ml.created_at DESC LIMIT 1)              AS fit_tier,
          (SELECT ml.status FROM master_leads ml
            WHERE ml.canonical_business_id = b.id AND ml.pipeline_origin = 'cro03_pipeline'
            ORDER BY ml.created_at DESC LIMIT 1)              AS latest_master_lead_status,
          -- Active field claim
          (SELECT frs.status FROM field_route_stops frs
           WHERE frs.business_id = b.id AND frs.status = 'claimed'
            ORDER BY frs.claimed_at DESC LIMIT 1)              AS field_claim_status,
           (SELECT frs.claimed_at FROM field_route_stops frs
            WHERE frs.business_id = b.id AND frs.status = 'claimed'
            ORDER BY frs.claimed_at DESC LIMIT 1)              AS field_claimed_at,
           (SELECT u.email
            FROM field_route_stops frs
            LEFT JOIN users u ON u.id = frs.claimed_by_user_id
            WHERE frs.business_id = b.id AND frs.status = 'claimed'
            ORDER BY frs.claimed_at DESC LIMIT 1)              AS field_claimed_by_email,
          COUNT(*) OVER()::int                               AS total_count
        FROM businesses b
        WHERE b.record_class = 'canonical'
          AND (${search === ""} OR b.canonical_name ILIKE ${'%' + search + '%'} OR b.website_domain ILIKE ${'%' + search + '%'})
          AND (${vertical === ""} OR ${sql.raw(effectiveBusinessVerticalSql("b"))} = ${resolveContactTargetVertical(vertical) ?? vertical})
          AND (${emailStatus === ""} OR b.email_discovery_status = ${emailStatus})
        ORDER BY b.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const data = (rows as any).rows ?? rows;
      const total = Number(data[0]?.total_count ?? 0);
      const emailEvidenceByBusiness = new Map<number, any>();
      if (data.length > 0) {
        const { CLASSIFIER_VERSION } = await import("../services/cro03/sfp-vertical-classifier");
        const ids = sql.join(data.map((row: any) => sql`${row.id}`), sql`, `);
        const emailEvidenceRows = await db.execute(sql`
          WITH displayed_businesses AS (
            SELECT unnest(ARRAY[${ids}]::int[]) AS business_id
          )
          SELECT displayed.business_id,
                 COALESCE(candidates.candidate_count, 0)::int AS candidate_count,
                 candidates.masked_candidate_email_preview,
                 winner.state AS winner_state,
                 winner.masked_value AS winner_masked_value,
                 winner.source AS winner_source,
                 winner.confidence AS winner_confidence,
                 intent.state AS intent_state,
                 intent.approval_required AS intent_approval_required,
                 intent.disposition AS intent_disposition,
                 intent.attempt_count AS intent_attempt_count,
                 classification.snapshot AS sfp_classification
            FROM displayed_businesses displayed
            LEFT JOIN LATERAL (
              SELECT COUNT(*)::int AS candidate_count,
                     (array_agg(fdc.masked_value ORDER BY fdc.created_at DESC))[1]
                       AS masked_candidate_email_preview
                FROM free_discovery_candidates fdc
               WHERE fdc.business_id = displayed.business_id
                 AND fdc.field = 'email'
                 AND fdc.subject_type = 'business'
                 AND fdc.disposition = 'staged'
            ) candidates ON true
            LEFT JOIN LATERAL (
              SELECT ws.state, ce.masked_value, ws.source, ws.confidence
                FROM cro03c_email_winner_selections ws
                LEFT JOIN cro03c_candidate_evidence ce ON ce.id = ws.candidate_evidence_id
               WHERE ws.business_id = displayed.business_id AND ws.state = 'selected'
               ORDER BY ws.created_at DESC LIMIT 1
            ) winner ON true
            LEFT JOIN LATERAL (
              SELECT vi.state, vi.approval_required, vi.disposition, vi.attempt_count
                FROM business_validation_intents vi
               WHERE vi.business_id = displayed.business_id
                 AND vi.state NOT IN ('superseded','revoked','completed','failed')
               ORDER BY vi.created_at DESC LIMIT 1
            ) intent ON true
            LEFT JOIN LATERAL (
              SELECT jsonb_build_object(
                'outcome',ce.outcome,'vertical',ce.resolved_vertical_id,
                'confidence',ce.confidence,'admissionTier',ce.admission_tier,
                'state',ce.terminal_state,'reasons',ce.reason_codes
              ) AS snapshot
                FROM sfp_classification_evidence ce
                JOIN sfp_programs cp ON cp.is_active=TRUE AND cp.taxonomy_version=2
                 AND ce.policy_version=cp.policy_version AND ce.taxonomy_version=cp.taxonomy_version
               WHERE ce.business_id=displayed.business_id AND ce.classifier_version=${CLASSIFIER_VERSION}
               ORDER BY ce.created_at DESC,ce.id DESC LIMIT 1
            ) classification ON true
        `);
        const evidenceRows = (emailEvidenceRows as any).rows ?? emailEvidenceRows;
        for (const evidence of evidenceRows) emailEvidenceByBusiness.set(Number(evidence.business_id), evidence);
      }
      const businesses = data.map((r: any) => {
        const { total_count, ...rest } = r;
        rest.safeNextAction = deriveCanonicalBusinessSafeNextAction({
          masterLeadStatus: rest.latest_master_lead_status,
          emailDiscoveryStatus: rest.email_discovery_status,
          mainEmail: rest.main_email,
          freeEnrichmentStatus: rest.free_enrichment_status,
          catchAllOutreachApprovedAt: rest.email_outreach_catch_all_approved_at,
          // The list does not load authoritative conflict/contact evidence.
          // Keep staged records explicitly non-promotable until detail checks.
          conflictEvidenceAvailable: false,
          contactMatchAvailable: false,
        });
        const emailEvidence = emailEvidenceByBusiness.get(Number(rest.id));
        rest.sfpClassification = emailEvidence?.sfp_classification ?? null;
        rest.emailEvidenceDisplay = buildCanonicalBusinessEmailDisplay({
          emailDiscoveryStatus: rest.email_discovery_status,
          candidateCount: emailEvidence?.candidate_count,
          maskedCandidateEmailPreview: emailEvidence?.masked_candidate_email_preview,
          selectedWinner: emailEvidence?.winner_state ? {
            state: emailEvidence.winner_state,
            masked_value: emailEvidence.winner_masked_value,
            source: emailEvidence.winner_source,
            confidence: emailEvidence.winner_confidence,
          } : null,
          validationIntent: emailEvidence?.intent_state ? {
            state: emailEvidence.intent_state,
            approval_required: emailEvidence.intent_approval_required,
            disposition: emailEvidence.intent_disposition,
            attempt_count: emailEvidence.intent_attempt_count,
          } : null,
        });
        delete rest.latest_master_lead_status;
        delete rest.email_outreach_catch_all_approved_at;
        if ("field_claim_status" in rest) {
          rest.fieldClaim = rest.field_claim_status
            ? {
                status: rest.field_claim_status,
                claimedByEmail: rest.field_claimed_by_email ?? null,
                claimedAt: rest.field_claimed_at ?? null,
              }
            : null;
          delete rest.field_claim_status;
          delete rest.field_claimed_by_email;
          delete rest.field_claimed_at;
        }
        return rest;
      });
      res.json({ businesses, total, limit, offset });
    } catch (err: any) {
      console.error("[LeadOps] /businesses list error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to load businesses" });
    }
  });

  // ── GET /api/lead-ops/business-verticals ────────────────────────────────────
  // Returns distinct verticals with counts from canonical businesses table.
  // Used by the Businesses tab vertical selector; must NOT query sunbiz_entities
  // (which is the legacy table and may have different vertical classification).
  app.get("/api/lead-ops/business-verticals", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT ${sql.raw(effectiveBusinessVerticalSql("b"))} AS vertical, COUNT(*)::int AS count
        FROM businesses b
        WHERE ${sql.raw(effectiveBusinessVerticalSql("b"))} IS NOT NULL
          AND b.record_class = 'canonical'
        GROUP BY ${sql.raw(effectiveBusinessVerticalSql("b"))}
        ORDER BY count DESC
        LIMIT 50
      `);
      const rows = (result as any).rows ?? result;
      res.json({ verticals: rows.map((r: any) => ({ vertical: r.vertical, count: Number(r.count) })) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Failed to load verticals" });
    }
  });

  // ── GET /api/lead-ops/budget-preview ────────────────────────────────────────
  // Pricing comes only from the current operator-reviewed database snapshot.
  app.get("/api/lead-ops/budget-preview", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { getCurrentPricingSchedule } = await import("../services/mi09-pilot-authority");
      const current = await getCurrentPricingSchedule();
      const schedules = current.priceSchedules as Record<string, any>;
      const prices = Object.entries(schedules).map(([provider, value]: [string, any]) => ({
        provider,
        version: Number(value?.version ?? 0),
        unitType: value?.unitType ?? null,
        currency: value?.currency ?? null,
        amountMicros: typeof value?.amountMicros === "number" ? value.amountMicros : null,
        billingSemantics: value?.billingSemantics ?? null,
      }));
      const validPrices = prices.filter((p) => p.amountMicros !== null);
      return res.json(validPrices.length > 0
        ? { available: true, prices: validPrices, source: current.source, snapshotId: current.snapshotId, capturedBy: current.capturedBy, capturedAt: current.capturedAt, expiresAt: current.expiresAt }
        : { available: false, error: "CRO03_PRICING_SCHEDULE_INVALID" });
    } catch (err: any) {
      return res.status(503).json({ available: false, error: err?.message ?? "pricing_schedule_unavailable" });
    }
  });

  // ── GET /api/lead-ops/businesses/:id/routing-preview ──────────────────────
  // MI-08: Returns the ordered provider plan for a business by calling
  // selectCro03Route(). Read-only — does NOT trigger any provider call.
  // Responds within 500ms (no remote calls involved).
  app.get("/api/lead-ops/businesses/:businessId/routing-preview", requireRole("admin", "manager"), async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ error: "Invalid businessId" });
    try {
      const bizResult = await db.execute(sql`
        SELECT id, canonical_name, website_domain, main_phone, main_email,
               email_discovery_status, free_enrichment_status, vertical
        FROM businesses WHERE id = ${businessId}
      `);
      const biz = ((bizResult as any).rows ?? bizResult)[0];
      if (!biz) return res.status(404).json({ error: "Business not found" });

      const { selectCro03Route } = await import("../services/cro03/routing-policy");

      const hasWebsite = !!biz.website_domain;
      const hasPhone   = !!biz.main_phone;
      const hasEmail   = !!biz.main_email;
      const needsBusinessDiscovery  = !hasWebsite && !hasPhone;
      const needsContactEnrichment  = hasWebsite && !hasEmail;
      const needsEmailValidation    = hasEmail && biz.email_discovery_status !== "provider_valid";

      const routePlan = selectCro03Route({
        hasWebsite, hasPhone, hasEmail,
        needsBusinessDiscovery,
        needsContactEnrichment,
        needsEmailValidation,
      });
      let pricing: { available: boolean; prices?: Array<Record<string, unknown>>; source?: string; snapshotId?: string; capturedBy?: string; capturedAt?: string; expiresAt?: string } = { available: false };
      try {
        const { getCurrentPricingSchedule } = await import("../services/mi09-pilot-authority");
        const current = await getCurrentPricingSchedule();
        const schedules = current.priceSchedules as Record<string, any>;
        if (schedules && typeof schedules === "object" && !Array.isArray(schedules)) {
          const prices = Object.entries(schedules)
            .map(([provider, value]: [string, any]) => ({
              provider,
              version: Number(value?.version ?? 0),
              unitType: value?.unitType ?? null,
              currency: value?.currency ?? null,
              amountMicros: typeof value?.amountMicros === "number" ? value.amountMicros : null,
              billingSemantics: value?.billingSemantics ?? null,
            }))
            .filter((price) => price.amountMicros !== null);
          if (prices.length) pricing = { available: true, prices, source: current.source, snapshotId: current.snapshotId, capturedBy: current.capturedBy, capturedAt: current.capturedAt, expiresAt: current.expiresAt };
        }
      } catch (err: any) {
        pricing = { available: false, source: err?.message ?? "pricing_schedule_unavailable" };
      }

      res.json({
        businessId,
        businessName: biz.canonical_name,
        routingInput: { hasWebsite, hasPhone, hasEmail, needsBusinessDiscovery, needsContactEnrichment, needsEmailValidation },
        routePlan: {
          policyVersion: routePlan.policyVersion,
          providers: routePlan.providers,
          stopReasons: routePlan.stopReasons,
          recipes: routePlan.recipes.map(r => ({
            provider: r.provider,
            operation: r.operation,
            requiresPaidEligibility: r.requiresPaidEligibility,
          })),
        },
        pricing,
      });
    } catch (err: any) {
      console.error("[LeadOps] routing-preview error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to compute routing preview" });
    }
  });

  // ── GET /api/lead-ops/canonical-summary ──────────────────────────────────
  // MI-03: On-demand diagnostic endpoint for canonical pipeline health.
  // Returns canonicalBusinessesCount and openConflictEvidenceCount without
  // blocking the 60-second health cache on large table scans.
  app.get("/api/lead-ops/canonical-summary", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const [businessResult, conflictResult] = await Promise.all([
        db.execute(sql`SELECT COUNT(*)::int AS count FROM businesses WHERE id > 0`),
        db.execute(sql`SELECT COUNT(*)::int AS count FROM canonical_conflict_evidence WHERE status='open'`).catch(() => null),
      ]);
      const canonicalBusinessesCount = Number(((businessResult as any).rows ?? businessResult)[0]?.count ?? 0);
      const openConflictEvidenceCount = conflictResult
        ? Number(((conflictResult as any).rows ?? conflictResult)[0]?.count ?? 0)
        : null;
      res.json({ canonicalBusinessesCount, openConflictEvidenceCount });
    } catch (err: any) {
      console.error("[LeadOps] canonical-summary error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to load canonical summary" });
    }
  });

  // ── GET /api/lead-ops/export-enriched ─────────────────────────────────────
  // Streams a CSV of all enriched sunbiz entities for offline analysis.
  // Columns: entity_id, company_name, vertical, score, has_email, has_phone, enriched_at, city, state
  // Capped at 50 000 rows.
  app.get("/api/lead-ops/export-enriched", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT
          id             AS entity_id,
          entity_name    AS company_name,
          vertical,
          score,
          CASE WHEN email IS NOT NULL OR owner_email IS NOT NULL THEN 'yes' ELSE 'no' END AS has_email,
          CASE WHEN phone IS NOT NULL OR owner_phone IS NOT NULL THEN 'yes' ELSE 'no' END AS has_phone,
          enriched_at,
          principal_city  AS city,
          principal_state AS state
        FROM sunbiz_entities
        WHERE enrichment_status = 'enriched'
        ORDER BY enriched_at DESC NULLS LAST
        LIMIT 50000
      `);

      const data = (rows as any).rows ?? rows;

      // Sanitize a CSV cell value:
      // 1. Prefix formula-leading chars (=, +, -, @, tab, CR) with an apostrophe so
      //    spreadsheet apps (Excel, Google Sheets) treat the cell as literal text.
      // 2. Quote values that contain commas, double-quotes, or newlines.
      const escape = (v: any) => {
        if (v === null || v === undefined) return "";
        let s = String(v);
        // Strip any leading/trailing whitespace to avoid hidden prefix attacks
        s = s.trim();
        // Neutralize spreadsheet formula injection
        if (s.length > 0 && (s[0] === "=" || s[0] === "+" || s[0] === "-" || s[0] === "@" || s[0] === "\t" || s[0] === "\r")) {
          s = `'${s}`;
        }
        if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const cols = ["entity_id", "company_name", "vertical", "score", "has_email", "has_phone", "enriched_at", "city", "state"];
      const header = cols.join(",");
      const lines = (data as any[]).map(r => cols.map(c => escape(r[c])).join(","));
      const csv = [header, ...lines].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="enriched-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (err: any) {
      console.error("[LeadOps] export-enriched error:", err?.message);
      res.status(500).json({ error: err?.message || "Export failed" });
    }
  });

  // ── POST /api/lead-ops/clear-sla-tasks ────────────────────────────────────
  // Bulk-resolve stuck SLA tasks for leads that have no email or phone.
  // ── MI-09: Pilot Lifecycle API ─────────────────────────────────────────────
  // All pilot state mutations require admin role + CSRF (CSRF is enforced by the
  // global CSRF middleware; idempotency keys are enforced by the service layer).

  app.get("/api/lead-ops/pilot/definitions", requireRole("admin"), async (_req, res) => {
    try {
      const { getPilotDefinitions } = await import("../services/mi09-pilot-authority");
      res.json(await getPilotDefinitions());
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get("/api/lead-ops/pilot/runs", requireRole("admin"), async (_req, res) => {
    try {
      const { listPilotRuns } = await import("../services/mi09-pilot-authority");
      res.json(await listPilotRuns());
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get("/api/lead-ops/pilot/runs/:runId", requireRole("admin"), async (req, res) => {
    try {
      const { getPilotRun, getPilotCohortMembers, getPilotCheckpoints, getPilotEffectLinks, getPilotReconciliationReports } = await import("../services/mi09-pilot-authority");
      const run = await getPilotRun(String(req.params.runId));
      if (!run) return res.status(404).json({ error: "not_found" });
      const [members, checkpoints, effectLinks, reports] = await Promise.all([
        getPilotCohortMembers(String(req.params.runId)),
        getPilotCheckpoints(String(req.params.runId)),
        getPilotEffectLinks(String(req.params.runId)),
        getPilotReconciliationReports(String(req.params.runId)),
      ]);
      res.json({ run, members, checkpoints, effectLinks, reports });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // MI-09/MI-07: one server-owned staging inventory for the Lead Ops staging
  // tab. Counts are deliberately sourced from intents/receipts/master_leads,
  // not client-side approximations.
  app.get("/api/lead-ops/staging-counts", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM master_lead_staging_intents WHERE status IN ('pending','processing')) AS pending,
          (SELECT COUNT(*)::int FROM master_leads WHERE pipeline_origin = 'cro03_pipeline' AND status = 'staged') AS staged,
          (SELECT COUNT(*)::int FROM master_lead_staging_receipts WHERE disposition = 'duplicate') AS duplicate,
          (SELECT COUNT(*)::int FROM master_lead_staging_receipts WHERE disposition = 'suppressed') AS suppressed,
          (SELECT COUNT(*)::int FROM master_lead_staging_receipts WHERE disposition = 'failed') AS failed,
          (SELECT COUNT(*)::int FROM master_leads WHERE pipeline_origin = 'cro03_pipeline' AND status = 'promoted') AS promoted
      `);
      const row = ((result as any).rows ?? result)[0] ?? {};
      res.json(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)])));
    } catch (err: any) {
      res.status(503).json({ error: err?.message ?? "staging_counts_unavailable" });
    }
  });

  // Current operator-reviewed database pricing schedule used by both the
  // provider-selector UI and the server-side pilot gate. signed-pricing.json
  // is historical/dev-seed-only and is never consulted at runtime.
  app.get("/api/lead-ops/pilot/pricing-schedule", requireRole("admin"), async (_req, res) => {
    try {
      const { getCurrentPricingSchedule } = await import("../services/mi09-pilot-authority");
      res.json(await getCurrentPricingSchedule());
    } catch (err: any) {
      res.status(503).json({ error: err?.message ?? "pricing_schedule_unavailable" });
    }
  });

  app.get("/api/lead-ops/pilot/preflight", requireRole("admin"), async (_req, res) => {
    try {
      const { runPreflightChecklist } = await import("../services/mi09-pilot-authority");
      res.json(await runPreflightChecklist());
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // #corrective-build item 10 — final operator-gated activation step. This
  // route ONLY reports readiness and (on PUT) records an auditable
  // authorization decision. It never reads/writes BACKGROUND_JOB_PROFILE,
  // never starts a worker, and never mutates outreach/GHL/discovery/Sunbiz/
  // DBPR schedules. Real activation still requires the operator to change
  // the BACKGROUND_JOB_PROFILE secret themselves, in their own session.
  app.get("/api/lead-ops/pilot/activation-readiness", requireRole("admin"), async (_req, res) => {
    try {
      const { getActivationReadiness, getSelectiveActivationAuthorization, MI09_PILOT_ACTIVATION_SCOPE, MI09_RECURRENCE_ACTIVATION_SCOPE } = await import("../services/mi09-pilot-authority");
      const [readiness, authorization] = await Promise.all([getActivationReadiness(), getSelectiveActivationAuthorization()]);
      // Corrective item 8: a pilot authorization must never imply recurrence.
      // `scope` (and `pilotScope`) is the bounded profile this authorization
      // actually covers; `recurrenceScope` is surfaced separately, clearly
      // labeled, for operators who are deliberately turning on ongoing
      // recurring enrichment on top of — not instead of — a completed pilot.
      res.json({
        readiness,
        authorization,
        scope: MI09_PILOT_ACTIVATION_SCOPE,
        pilotScope: MI09_PILOT_ACTIVATION_SCOPE,
        recurrenceScope: MI09_RECURRENCE_ACTIVATION_SCOPE,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.put("/api/lead-ops/pilot/activation-readiness", requireRole("admin"), async (req, res) => {
    try {
      const { typedConfirmation } = req.body as { typedConfirmation?: unknown };
      const { authorizeSelectiveActivation } = await import("../services/mi09-pilot-authority");
      const authorizedBy = (req.user as any)?.email || (req.user as any)?.id || "unknown";
      const authorization = await authorizeSelectiveActivation({ authorizedBy, typedConfirmation: String(typedConfirmation ?? "") });
      res.json({ authorization });
    } catch (err: any) {
      res.status(400).json({ error: err?.message });
    }
  });

  // #corrective-build item 9 — one consolidated telemetry snapshot the Lead
  // Ops panel renders: pool authority, eligible/exclusion counts,
  // business/master-lead counts, ZeroBounce outcomes, spend by provider,
  // worker profile, provider controls/circuits, required-secret PRESENCE
  // (never values), and the exact deployed RELEASE_SHA.
  app.get("/api/lead-ops/pilot/status-overview", requireRole("admin"), async (_req, res) => {
    try {
      const { getPoolAuthorityDecision, getAggregatePilotSpend } = await import("../services/mi09-pilot-authority");
      const { getBackgroundProfile } = await import("../services/background-profile");
      const { getPaidProviderControls } = await import("../services/paid-provider-control");
      const { getPauseState } = await import("../services/outbound-pause-authority");

      const [poolAuthority, spend, outboundPauseState] = await Promise.all([
        getPoolAuthorityDecision(),
        getAggregatePilotSpend(),
        getPauseState(),
      ]);
      const paidProviderControls = await getPaidProviderControls();

      // Corrective item 9: `canonical_non_dbpr_businesses` previously used a
      // JOIN + single-row `source_system !~* 'dbpr'` filter, which counts a
      // business as "non-DBPR" as long as ANY of its linked source rows is
      // non-DBPR — a business with BOTH a DBPR link and a non-DBPR link was
      // wrongly included. The eligibility authority (businessLacksDbprLineageSql)
      // excludes a business if it has ANY DBPR-family lineage at all ("full-family"
      // exclusion). This telemetry must use the identical predicate so the
      // operator-facing count matches what the cohort/eligibility authority
      // actually admits — not a narrower, more permissive approximation.
      const eligibleCounts = rows(await db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM businesses WHERE record_class = 'canonical') AS canonical_businesses,
          (SELECT COUNT(*)::int FROM businesses b
             WHERE b.record_class = 'canonical' AND ${businessLacksDbprLineageSql(sql`b.id`)}) AS canonical_non_dbpr_businesses,
          (SELECT COUNT(*)::int FROM businesses WHERE record_class != 'canonical') AS excluded_businesses,
          (SELECT COUNT(*)::int FROM businesses WHERE free_enrichment_status = 'enriched') AS free_enrichment_complete,
          (SELECT COUNT(*)::int FROM master_leads) AS master_leads_count
      `))[0] ?? {};

      const zbOutcomes = rows(await db.execute(sql`
        SELECT email_status, COUNT(*)::int AS cnt FROM contacts
        WHERE email_status IS NOT NULL GROUP BY email_status ORDER BY cnt DESC LIMIT 10
      `));

      // Crosswalk-only exclusion visibility (Liberty Bancard enrichment
      // hardening): contacts whose only identity-crosswalk candidate
      // evidence is AMBIGUOUS_MATCH or INSUFFICIENT_EVIDENCE — i.e. no
      // deterministic/explicit fact-based link exists — must be counted and
      // reasoned about in this funnel, not silently absent from it. These
      // contacts are never deleted: classifyEvidence()
      // (identity-crosswalk-runner.ts) always persists a disposition row
      // and Gen-1 promotion stays fail-closed for them
      // (daily-outreach.ts) — they remain in review/excluded state.
      // Scoped to the most recent completed run per contact candidate so a
      // stale/superseded run doesn't double count or contradict a later one.
      const crosswalkOnlyExcluded = rows(await db.execute(sql`
        WITH latest_candidate AS (
          SELECT DISTINCT ON (cic.candidate_id)
            cic.candidate_id AS contact_id,
            cic.evidence_class,
            cis.disposition
          FROM contact_identity_candidates cic
          JOIN contact_identity_subjects cis ON cis.id = cic.subject_id
          JOIN contact_identity_reconciliation_runs r ON r.id = cic.run_id
          WHERE cic.candidate_type = 'contact' AND r.status = 'completed'
          ORDER BY cic.candidate_id, r.created_at DESC
        )
        SELECT
          COUNT(*) FILTER (WHERE evidence_class IN ('AMBIGUOUS_MATCH', 'INSUFFICIENT_EVIDENCE'))::int AS crosswalk_only_excluded_count,
          COUNT(*) FILTER (WHERE evidence_class = 'AMBIGUOUS_MATCH')::int AS ambiguous_match_count,
          COUNT(*) FILTER (WHERE evidence_class = 'INSUFFICIENT_EVIDENCE')::int AS insufficient_evidence_count
        FROM latest_candidate
      `))[0] ?? { crosswalk_only_excluded_count: 0, ambiguous_match_count: 0, insufficient_evidence_count: 0 };

      // Gate 3 — Enrichment Control Center funnel. Real counts per stage
      // (source → canonical → contacts → domain → free/paid → discovered →
      // ZB → policy-eligible → ready_held → suppressed/quarantined), each
      // using the exact predicate already authoritative elsewhere in this
      // codebase (see inline comments). A stage whose real denominator is
      // structurally unavailable is reported as null with an "unavailable"
      // reason string, never a fabricated 0 — per truthful-state-signal
      // policy for provider/pipeline telemetry.
      const funnelSnapshotAt = new Date().toISOString();
      let funnel: Record<string, unknown> | null = null;
      let funnelUnavailableReason: string | null = null;
      try {
        funnel = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
          const result = await tx.execute(sql`
        WITH raw_count AS MATERIALIZED (
          SELECT COUNT(*)::bigint AS n FROM sunbiz_entities
        ),
        eligible_sample AS MATERIALIZED (
          SELECT 1 FROM sunbiz_entities se
          WHERE se.filing_number IS NOT NULL AND se.entity_name IS NOT NULL
            AND se.score IN ('hot', 'warm')
            AND (se.website IS NOT NULL OR se.phone IS NOT NULL
                 OR (se.principal_city IS NOT NULL AND se.principal_state IS NOT NULL))
            AND NOT EXISTS (
              SELECT 1 FROM sunbiz_bootstrap_claims c WHERE c.filing_number = se.filing_number
                AND NOT ((c.status = 'failed' AND c.retry_count < 5)
                  OR (c.status = 'claimed' AND c.claimed_at < now() - interval '15 minutes'))
            )
          ORDER BY se.id LIMIT 5001
        )
        SELECT
          (SELECT n FROM raw_count) AS sunbiz_source_rows,
          (SELECT n FROM raw_count) AS sunbiz_raw_rows,
          (SELECT COUNT(*)::bigint FROM eligible_sample) AS sunbiz_bootstrap_eligible_sample,
          ((SELECT COUNT(*) FROM eligible_sample) = 5001) AS sunbiz_bootstrap_eligible_is_floor,
          (SELECT COUNT(*)::bigint FROM sunbiz_bootstrap_claims) AS sunbiz_bootstrap_claim_rows,
          (SELECT COUNT(*)::bigint FROM sunbiz_bootstrap_ledger_events) AS sunbiz_bootstrap_scanned,
          (SELECT COUNT(*)::bigint FROM sunbiz_bootstrap_ledger_events WHERE outcome = 'created') AS sunbiz_bootstrap_created,
          (SELECT COUNT(*)::bigint FROM sunbiz_bootstrap_ledger_events WHERE outcome = 'matched_existing') AS sunbiz_bootstrap_matched,
          (SELECT COUNT(*)::bigint FROM sunbiz_bootstrap_ledger_events WHERE outcome IN ('deferred_collision', 'identity_review')) AS sunbiz_bootstrap_deferred,
          (SELECT COUNT(*)::int FROM businesses WHERE record_class = 'canonical') AS canonical_businesses,
          (SELECT COUNT(*)::int FROM contacts c JOIN businesses b ON b.id = c.business_id) AS contacts_linked_to_business,
          (SELECT COUNT(*)::int FROM businesses WHERE record_class = 'canonical' AND (website_domain IS NULL OR trim(website_domain) = '')) AS canonical_missing_domain,
          (SELECT COUNT(*)::int FROM businesses WHERE free_enrichment_status = 'enriched') AS free_enrichment_complete,
          (SELECT COUNT(*)::int FROM businesses WHERE website_domain IS NOT NULL AND free_enrichment_status IS NULL) AS free_enrichment_queued,
          (SELECT COUNT(*)::int FROM sfp_paid_candidate_evidence) AS paid_discovered_evidence_rows,
          (SELECT COUNT(*)::int FROM sfp_outreach_eligibility WHERE status = 'validated_outreach_eligible') AS policy_eligible,
          (SELECT COUNT(*)::int FROM sfp_outreach_eligibility WHERE status = 'validated_suppressed') AS policy_suppressed,
          (SELECT COUNT(*)::int FROM sfp_outreach_eligibility WHERE status = 'validated_policy_ineligible') AS policy_ineligible,
          (SELECT COUNT(*)::int FROM sfp_outreach_eligibility WHERE status IN ('validation_pending', 'discovery_required')) AS policy_pending,
          (SELECT COUNT(*)::int FROM sfp_outreach_eligibility WHERE status = 'catch_all_review') AS policy_catch_all_review,
          (SELECT COUNT(*)::int FROM sfp_ready_held_enrollments) AS ready_held_enrollments,
          (SELECT COUNT(*)::int FROM sfp_identity_quarantines) AS identity_quarantined,
          (SELECT COUNT(*)::int FROM contacts WHERE do_not_contact = true OR email_status IN ('bounced', 'invalid', 'opted_out', 'unsafe')) AS contacts_suppressed
          `);
          const record = rows(result)[0];
          if (!record) return null;
          const normalized = { ...record };
          for (const key of [
            "sunbiz_source_rows", "sunbiz_raw_rows", "sunbiz_bootstrap_eligible_sample",
            "sunbiz_bootstrap_claim_rows", "sunbiz_bootstrap_scanned", "sunbiz_bootstrap_created",
            "sunbiz_bootstrap_matched", "sunbiz_bootstrap_deferred",
          ]) {
            const count = Number((record as any)[key]);
            if (!Number.isSafeInteger(count) || count < 0) throw new Error("funnel_count_out_of_range");
            (normalized as any)[key] = count;
          }
          return normalized;
        });
      } catch (err: any) {
        funnelUnavailableReason = String(err?.code ?? "funnel_unavailable");
        console.error("[LeadOps] status funnel unavailable:", err?.message);
      }

      let sourcePool: Record<string, any> | null = null;
      let throughput24h: Record<string, any> | null = null;
      let paidEvidenceByProvider24h: any[] | null = null;
      let validationBySourceStatus24h: any[] | null = null;
      let v2VerticalFunnel24h: any[] | null = null;
      let telemetryUnavailableReason: string | null = null;
      try {
      const readTelemetryRows = async (query: any) => db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        return rows(await tx.execute(query));
      });
      sourcePool = (await readTelemetryRows(sql`
        SELECT
          (SELECT COUNT(*)::int FROM contacts) AS contacts_total,
          (SELECT COUNT(*)::int FROM contacts WHERE archived_at IS NULL AND NULLIF(BTRIM(email),'') IS NOT NULL) AS active_contacts_with_email,
          (SELECT COUNT(DISTINCT c.id)::int
             FROM contacts c
             JOIN businesses b ON b.id=c.business_id AND b.record_class='canonical'
             JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.business_id=b.id
              AND d.decision='verified' AND d.superseded_at IS NULL
            WHERE c.archived_at IS NULL AND NULLIF(BTRIM(c.email),'') IS NOT NULL) AS verified_canonical_linked_contacts_with_email,
          (SELECT COUNT(DISTINCT c.id)::int
             FROM contacts c
             JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.business_id IS NOT NULL
              AND d.decision='verified' AND d.superseded_at IS NULL
             JOIN businesses b ON b.id=d.business_id AND b.record_class='canonical'
             JOIN sfp_cohort_members cm ON cm.business_id=b.id
             JOIN sfp_cohort_runs cr ON cr.id=cm.cohort_run_id AND cr.cohort_state='frozen'
             JOIN sfp_programs sp ON sp.id=cr.program_id AND sp.is_active=TRUE AND sp.taxonomy_version=2
            WHERE c.id=d.contact_id AND c.business_id=b.id AND c.archived_at IS NULL
              AND NULLIF(BTRIM(c.email),'') IS NOT NULL
              AND cr.voided_at IS NULL AND cr.superseded_at IS NULL) AS v2_sfp_cohort_linked_contacts_with_email
      `))[0] ?? {};

      // Count actual business/record movement over the last rolling 24 hours.
      // Provider operations are attempts, paid evidence rows are returned
      // facts, eligibility rows are validation/policy decisions, and staging
      // intents are usable ready_held outputs. These are separate measures;
      // no queue tick is counted as a lead.
      throughput24h = (await readTelemetryRows(sql`
        SELECT
          (SELECT COUNT(*)::int FROM provider_operations
            WHERE purpose LIKE 'sfp_%' AND created_at >= NOW()-INTERVAL '24 hours') AS provider_attempts,
          (SELECT COUNT(*)::int FROM provider_operations
            WHERE purpose LIKE 'sfp_%' AND state='completed' AND created_at >= NOW()-INTERVAL '24 hours') AS provider_completed_operations,
          (SELECT COUNT(DISTINCT target_fingerprint)::int FROM provider_operations
            WHERE purpose LIKE 'sfp_%' AND created_at >= NOW()-INTERVAL '24 hours') AS distinct_provider_targets,
          (SELECT COUNT(*)::int FROM sfp_paid_candidate_evidence
            WHERE created_at >= NOW()-INTERVAL '24 hours') AS paid_evidence_rows,
          (SELECT COUNT(DISTINCT business_id)::int FROM sfp_paid_candidate_evidence
            WHERE created_at >= NOW()-INTERVAL '24 hours') AS businesses_with_paid_evidence,
          (SELECT COUNT(*)::int FROM sfp_outreach_eligibility
            WHERE created_at >= NOW()-INTERVAL '24 hours') AS validation_decisions,
          (SELECT COUNT(*)::int FROM sfp_outreach_eligibility
            WHERE created_at >= NOW()-INTERVAL '24 hours' AND status='validated_outreach_eligible') AS validation_eligible,
          (SELECT COUNT(*)::int FROM sfp_outreach_eligibility
            WHERE created_at >= NOW()-INTERVAL '24 hours' AND source_kind='contact') AS contact_source_decisions,
          (SELECT COUNT(*)::int FROM sfp_campaign_staging_intents
            WHERE state='ready_held' AND ready_held_at >= NOW()-INTERVAL '24 hours') AS ready_held_created,
          (SELECT COUNT(*)::int FROM sfp_campaign_staging_intents
            WHERE state='ready_held' AND source_kind='contact' AND ready_held_at >= NOW()-INTERVAL '24 hours') AS contact_source_ready_held,
          (SELECT COUNT(*)::int FROM sfp_ready_held_enrollments
            WHERE created_at >= NOW()-INTERVAL '24 hours') AS paused_enrollment_bridges
      `))[0] ?? {};
      paidEvidenceByProvider24h = (await readTelemetryRows(sql`
        SELECT provider,field,COUNT(*)::int AS evidence_rows,COUNT(DISTINCT business_id)::int AS businesses
          FROM sfp_paid_candidate_evidence
         WHERE created_at >= NOW()-INTERVAL '24 hours'
         GROUP BY provider,field ORDER BY provider,field
      `));
      validationBySourceStatus24h = (await readTelemetryRows(sql`
        SELECT COALESCE(source_kind,'legacy_or_unknown') AS source_kind,status,COUNT(*)::int AS rows,
               COUNT(DISTINCT business_id)::int AS businesses
          FROM sfp_outreach_eligibility
         WHERE created_at >= NOW()-INTERVAL '24 hours'
         GROUP BY COALESCE(source_kind,'legacy_or_unknown'),status
         ORDER BY source_kind,status
      `));
      v2VerticalFunnel24h = (await readTelemetryRows(sql`
        WITH active_v2_program AS (
          SELECT id, vertical_ids FROM sfp_programs WHERE is_active=TRUE AND taxonomy_version=2
        ),
        verticals AS (
          SELECT DISTINCT v.vertical
            FROM active_v2_program p
            CROSS JOIN LATERAL UNNEST(p.vertical_ids) AS v(vertical)
          UNION SELECT '__unclassified__'::text
        ),
        v2_businesses AS (
          SELECT DISTINCT b.id AS business_id,
                 CASE WHEN cm.classifier_matched_target=ANY(p.vertical_ids) THEN cm.classifier_matched_target
                      WHEN cm.vertical=ANY(p.vertical_ids) THEN cm.vertical
                      ELSE '__unclassified__' END AS vertical
            FROM businesses b
            JOIN sfp_cohort_members cm ON cm.business_id=b.id
            JOIN sfp_cohort_runs cr ON cr.id=cm.cohort_run_id AND cr.cohort_state='frozen'
            JOIN active_v2_program p ON p.id=cr.program_id
           WHERE b.record_class='canonical' AND cr.voided_at IS NULL AND cr.superseded_at IS NULL
        ),
        population AS (
          SELECT vertical,COUNT(DISTINCT business_id)::int AS frozen_businesses
            FROM v2_businesses GROUP BY vertical
        ),
        contacts AS (
          SELECT v.vertical,COUNT(DISTINCT c.id)::int AS verified_contact_candidates
            FROM v2_businesses v
            JOIN businesses b ON b.id=v.business_id AND b.record_class='canonical'
            JOIN contacts c ON c.business_id=b.id
            JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.business_id=b.id
             AND d.decision='verified' AND d.superseded_at IS NULL
           WHERE c.archived_at IS NULL AND NULLIF(BTRIM(c.email),'') IS NOT NULL
             AND COALESCE(c.do_not_contact,FALSE)=FALSE AND COALESCE(c.do_not_auto_contact,FALSE)=FALSE
             AND COALESCE(c.opted_out_email,FALSE)=FALSE AND c.opt_out_status IS DISTINCT FROM 'opted_out'
             AND c.unsubscribe_status IS DISTINCT FROM 'unsubscribed' AND c.complaint_status IS DISTINCT FROM 'reported'
             AND c.bounce_status IS DISTINCT FROM 'hard' AND c.email_status IS DISTINCT FROM 'bounced'
             AND c.email_status IS DISTINCT FROM 'invalid' AND c.email_status IS DISTINCT FROM 'opted_out'
             AND c.suppression_reason IS NULL
             AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q WHERE q.business_id=b.id AND q.cleared_at IS NULL)
           GROUP BY v.vertical
        ),
        free_email_candidates AS (
          SELECT v.vertical,COUNT(DISTINCT f.id)::int AS candidates,COUNT(DISTINCT f.business_id)::int AS businesses
            FROM v2_businesses v
            JOIN free_discovery_candidates f ON f.business_id=v.business_id AND f.field='email'
             AND f.disposition IN ('staged','validation_admitted')
            LEFT JOIN sfp_identity_quarantines q ON q.business_id=v.business_id AND q.cleared_at IS NULL
           WHERE q.business_id IS NULL
           GROUP BY v.vertical
        ),
        paid_email_candidates AS (
          SELECT v.vertical,COUNT(DISTINCT e.id)::int AS candidates,COUNT(DISTINCT e.business_id)::int AS businesses
            FROM v2_businesses v
            JOIN sfp_paid_candidate_evidence e ON e.business_id=v.business_id AND e.field='email'
             AND e.disposition IN ('staged','accepted')
            LEFT JOIN sfp_identity_quarantines q ON q.business_id=v.business_id AND q.cleared_at IS NULL
            LEFT JOIN sfp_discredited_paid_evidence d ON d.evidence_id=e.id
           WHERE q.business_id IS NULL AND d.evidence_id IS NULL
           GROUP BY v.vertical
        ),
        validation_24h AS (
          SELECT v.vertical,COUNT(e.id)::int AS decisions,
                 COUNT(e.id) FILTER (WHERE e.status='validated_outreach_eligible')::int AS eligible,
                 COUNT(e.id) FILTER (WHERE e.status IN ('invalid','validated_suppressed','validated_policy_ineligible','validated_review_required','catch_all_review'))::int AS held_or_rejected
            FROM v2_businesses v
            JOIN sfp_outreach_eligibility e ON e.business_id=v.business_id
           WHERE e.created_at >= NOW()-INTERVAL '24 hours'
           GROUP BY v.vertical
        ),
        ready_held_24h AS (
          SELECT v.vertical,COUNT(DISTINCT i.id)::int AS created
            FROM sfp_campaign_staging_intents i
            JOIN sfp_cohort_runs cr ON cr.id=i.cohort_run_id AND cr.cohort_state='frozen'
            JOIN active_v2_program p ON p.id=cr.program_id
            JOIN businesses b ON b.id=i.business_id AND b.record_class='canonical'
             JOIN v2_businesses v ON v.business_id=i.business_id
           WHERE i.state='ready_held' AND i.package_key LIKE 'sfp.%.v2'
             AND i.ready_held_at >= NOW()-INTERVAL '24 hours'
             AND cr.voided_at IS NULL AND cr.superseded_at IS NULL
           GROUP BY v.vertical
        )
        SELECT v.vertical,
               COALESCE(p.frozen_businesses,0)::int AS frozen_businesses,
               COALESCE(c.verified_contact_candidates,0)::int AS verified_contact_candidates,
               COALESCE(f.candidates,0)::int AS free_email_candidates,
               COALESCE(f.businesses,0)::int AS businesses_with_free_email_candidate,
               COALESCE(pe.candidates,0)::int AS paid_email_candidates,
               COALESCE(pe.businesses,0)::int AS businesses_with_paid_email_candidate,
               COALESCE(val.decisions,0)::int AS validation_decisions_24h,
               COALESCE(val.eligible,0)::int AS validation_eligible_24h,
               COALESCE(val.held_or_rejected,0)::int AS validation_held_or_rejected_24h,
               COALESCE(rh.created,0)::int AS ready_held_created_24h
          FROM verticals v
          LEFT JOIN population p ON p.vertical=v.vertical
          LEFT JOIN contacts c ON c.vertical=v.vertical
          LEFT JOIN free_email_candidates f ON f.vertical=v.vertical
          LEFT JOIN paid_email_candidates pe ON pe.vertical=v.vertical
          LEFT JOIN validation_24h val ON val.vertical=v.vertical
          LEFT JOIN ready_held_24h rh ON rh.vertical=v.vertical
         ORDER BY v.vertical
      `));
      } catch (err: any) {
        telemetryUnavailableReason = String(err?.code ?? "telemetry_unavailable");
        sourcePool = null;
        throughput24h = null;
        paidEvidenceByProvider24h = null;
        validationBySourceStatus24h = null;
        v2VerticalFunnel24h = null;
        console.error("[LeadOps] SFP throughput telemetry unavailable:", err?.message);
      }

      res.json({
        poolAuthority,
        releaseSha: process.env.RELEASE_SHA ?? "unknown",
        backgroundJobProfile: getBackgroundProfile(),
        // Corrective fix (Liberty Bancard enrichment completion, continuation):
        // this field previously derived its value from getBackgroundProfile()
        // === "off", which only reflects whether the background *job scheduler*
        // profile is disabled — it said nothing about the canonical outbound
        // send authority (OutboundPauseAuthority / outbound_pause_control),
        // which is what actually gates every outbound send site in this
        // codebase (see outbound-pause-authority.md memory). A background
        // profile of e.g. "selective" reported outboundEnrichmentPaused=false
        // even while the canonical authority was paused — a false "not
        // paused" signal. This field now reports the real authority state;
        // backgroundJobProfile remains separately visible above for the
        // scheduler dimension, which is a distinct concern.
        outboundEnrichmentPaused: outboundPauseState.state !== "unpaused",
        outboundPauseAuthority: {
          state: outboundPauseState.state,
          reason: outboundPauseState.reason,
          source: outboundPauseState.source,
          epoch: outboundPauseState.epoch?.toString?.() ?? String(outboundPauseState.epoch),
        },
        eligibleCounts,
        zbOutcomes,
        funnel: funnel
          ? { snapshotAt: funnelSnapshotAt, available: true, ...funnel }
          : { snapshotAt: funnelSnapshotAt, available: false, unavailableReason: funnelUnavailableReason },
        sourcePool,
        throughput24h: throughput24h
          ? { windowStartedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), ...throughput24h }
          : null,
        paidEvidenceByProvider24h,
        validationBySourceStatus24h,
        v2VerticalFunnel24h,
        enrichmentTelemetry: {
          available: !!sourcePool && !!throughput24h,
          unavailableReason: telemetryUnavailableReason,
        },
        crosswalkOnlyExcluded: crosswalkOnlyExcluded ?? { crosswalk_only_excluded_count: 0, ambiguous_match_count: 0, insufficient_evidence_count: 0 },
        spendByProvider: spend.byProvider,
        providerControls: paidProviderControls.providers,
        zeroBounceSafety: paidProviderControls.zeroBounce,
        paidInFlightCount: paidProviderControls.inFlightCount,
        paidInFlightOperations: paidProviderControls.inFlightOperations,
        // ── Serper gateway state telemetry ──────────────────────────────────
        // Exposes the live legacy gateway control and rolling-window counts
        // alongside provider_controls; all selected fields exist in the
        // current schema (do not infer freshness from this query).
        // Enrichment Control Center can show correct enabled/closed status without
        // relying on env-var guessing. This is read-only; actual Serper calls
        // still go through SerperGateway.executeSearch().
        serperTelemetry: await (async () => {
          try {
            const serperRow = ((await db.execute(sql`
              SELECT enabled, state, window_calls, window_successes, window_failures,
                     lifetime_calls, lifetime_successes, lifetime_failures, yield_websites, yield_emails, yield_phones,
                     window_started_at, window_ends_at, updated_at
              FROM serper_control WHERE id = 1 LIMIT 1
            `)) as any).rows?.[0] ?? null;
            if (!serperRow) return { configured: false, reason: "no_control_row" };
            return {
              configured: !!process.env.SERPER_API_KEY,
              enabled: Boolean(serperRow.enabled),
              circuitState: serperRow.state ?? "unknown",
              windowCalls: Number(serperRow.window_calls ?? 0),
              windowSuccesses: Number(serperRow.window_successes ?? 0),
              windowFailures: Number(serperRow.window_failures ?? 0),
              lifetimeCalls: Number(serperRow.lifetime_calls ?? 0),
              lifetimeSuccesses: Number(serperRow.lifetime_successes ?? 0),
              lifetimeFailures: Number(serperRow.lifetime_failures ?? 0),
              yieldWebsites: Number(serperRow.yield_websites ?? 0),
              yieldEmails: Number(serperRow.yield_emails ?? 0),
              yieldPhones: Number(serperRow.yield_phones ?? 0),
              windowStartedAt: serperRow.window_started_at ?? null,
              windowEndsAt: serperRow.window_ends_at ?? null,
              updatedAt: serperRow.updated_at ?? null,
            };
          } catch {
            return { configured: false, reason: "query_failed" };
          }
        })(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // #corrective-build item 5 — owner-only pool authority decision, settable
  // from the app instead of requiring direct SQL.
  app.get("/api/lead-ops/pilot/pool-authority", requireRole("admin"), async (_req, res) => {
    try {
      const { getPoolAuthorityDecision } = await import("../services/mi09-pilot-authority");
      res.json({ decision: await getPoolAuthorityDecision() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.put("/api/lead-ops/pilot/pool-authority", requireRole("admin"), async (req, res) => {
    try {
      const { pool } = req.body as { pool?: unknown };
      if (pool !== "master_leads" && pool !== "prospects") {
        return res.status(400).json({ error: "pool must be 'master_leads' or 'prospects'" });
      }
      const { setPoolAuthorityDecision } = await import("../services/mi09-pilot-authority");
      const decidedBy = (req.user as any)?.email || (req.user as any)?.id || "unknown";
      const decision = await setPoolAuthorityDecision({ pool, decidedBy });
      res.json({ decision });
    } catch (err: any) {
      res.status(400).json({ error: err?.message });
    }
  });

  app.post("/api/lead-ops/pilot/runs/:runId/transition", requireRole("admin"), async (req, res) => {
    try {
      const { transitionPilotRunState, evaluateStopConditions, getPilotRun, getPilotDefinitions, assertPaidBudgetAuthorized } = await import("../services/mi09-pilot-authority");
      const { toState, stopReason, advancedBy } = req.body as { toState: string; stopReason?: string; advancedBy?: string };
      if (!toState) return res.status(400).json({ error: "toState required" });

      // Starting a run whose definition allows paid providers requires explicit
      // operator approval. Provider limits and circuit state remain independent.
      if (toState === "running") {
        const run = await getPilotRun(String(req.params.runId));
        if (!run) return res.status(404).json({ error: "PILOT_RUN_NOT_FOUND" });
        const defs = await getPilotDefinitions();
        const def = defs.find((d: any) => String(d.id) === String(run.pilot_definition_id));
        const paidAllowed = def?.paid_providers_allowed
          ? (typeof def.paid_providers_allowed === "string" ? JSON.parse(def.paid_providers_allowed) : def.paid_providers_allowed)
          : {};
        const anyPaidAllowed = Object.values(paidAllowed).some((v) => v === true);
        if (anyPaidAllowed) {
          await assertPaidBudgetAuthorized();
        }
      }

      // Always evaluate stop conditions before running/completing.
      const stopCheck = await evaluateStopConditions(String(req.params.runId));
      if (!stopCheck.passed && toState === "running") {
        return res.status(409).json({ error: "stop_conditions_failed", detail: stopCheck });
      }
      await transitionPilotRunState(String(req.params.runId), toState as any, { stopReason, advancedBy });
      res.json({ ok: true, stopConditionsChecked: stopCheck });
    } catch (err: any) {
      const status = err?.message?.includes("MI09_PAID_BUDGET_NOT_AUTHORIZED") ? 403
        : err?.message?.includes("PILOT_EVIDENCE") ? 409
        : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  app.post("/api/lead-ops/pilot/runs/:runId/advance", requireRole("admin"), async (req, res) => {
    try {
      const { issuePilotAdvancementReceipt, evaluateStopConditions } = await import("../services/mi09-pilot-authority");
      const { fromLevel, toLevel, pricingArtifactId, idempotencyKey } = req.body as {
        fromLevel: number; toLevel: number;
        pricingArtifactId?: string; idempotencyKey: string;
      };
      if (!idempotencyKey) return res.status(400).json({ error: "idempotencyKey required" });

      // approvedBy is derived from the authenticated session, not caller-supplied.
      // This binds the advancement receipt to the verified session identity.
      const actorUser = (req as any).user as { email?: string; id?: unknown } | undefined;
      const approvedBy = actorUser?.email ?? String(actorUser?.id ?? "unknown-admin");

      // Validate legal level progression: only 1→2 and 2→3 are allowed.
      const parsedFrom = Number(fromLevel);
      const parsedTo   = Number(toLevel);
      if (!([1, 2, 3] as number[]).includes(parsedFrom) || !([1, 2, 3] as number[]).includes(parsedTo)) {
        return res.status(400).json({ error: "fromLevel and toLevel must each be 1, 2, or 3" });
      }
      if (parsedTo !== parsedFrom + 1) {
        return res.status(400).json({
          error: `Illegal level advancement: ${parsedFrom}→${parsedTo}. Only sequential advancement (1→2, 2→3) is permitted.`,
        });
      }

      const stopConditions = await evaluateStopConditions(String(req.params.runId));
      const receipt = await issuePilotAdvancementReceipt({
        pilotRunId: String(req.params.runId),
        fromLevel: parsedFrom,
        toLevel: parsedTo,
        approvedBy,
        pricingArtifactId,
        stopConditionsChecked: stopConditions.details,
        stopConditionsPassed: stopConditions.passed,
        idempotencyKey,
      });
      res.json(receipt);
    } catch (err: any) {
      res.status(err?.message?.includes("PILOT_EVIDENCE") ? 409 : 500).json({ error: err?.message });
    }
  });

  app.get("/api/lead-ops/pilot/pricing-artifacts", requireRole("admin"), async (_req, res) => {
    try {
      const { getPricingArtifacts } = await import("../services/mi09-pilot-authority");
      res.json(await getPricingArtifacts());
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.get("/api/lead-ops/pilot/census/:definitionId", requireRole("admin"), async (req, res) => {
    try {
      const { checkCohortCensus, getPilotDefinitions } = await import("../services/mi09-pilot-authority");
      const defs = await getPilotDefinitions();
      const def = defs.find((d: any) => String(d.id) === String(req.params.definitionId));
      if (!def) return res.status(404).json({ error: "definition_not_found" });
      const result = await checkCohortCensus({
        pilotDefinitionId: String(req.params.definitionId),
        countyFipsFilter: Array.isArray(def.county_scope) ? def.county_scope : [],
        verticalFilter: Array.isArray(def.vertical_scope) ? def.vertical_scope : [],
        sourceAdapterFilter: Array.isArray(def.source_adapter_filter) ? def.source_adapter_filter : [],
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── MI-09: Pilot Lifecycle Mutations ──────────────────────────────────────
  // All write routes require admin role. CSRF is handled by the global
  // middleware. Idempotency keys are enforced at the service layer.

  // POST /api/lead-ops/pilot/pricing-artifacts — capture operator pricing
  app.post("/api/lead-ops/pilot/pricing-artifacts", requireRole("admin"), async (req, res) => {
    try {
      const { createPricingArtifact } = await import("../services/mi09-pilot-authority");
      const result = await createPricingArtifact({ ...req.body, capturedBy: (req as any).user?.email ?? "admin" });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/definitions — create immutable pilot definition
  app.post("/api/lead-ops/pilot/definitions", requireRole("admin"), async (req, res) => {
    try {
      const { createPilotDefinition } = await import("../services/mi09-pilot-authority");
      const createdBy = (req as any).user?.email ?? String((req as any).user?.id ?? "unknown-admin");
      const result = await createPilotDefinition({ ...req.body, createdBy });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/runs — create a new pilot run in 'draft' state
  app.post("/api/lead-ops/pilot/runs", requireRole("admin"), async (req, res) => {
    try {
      const { createPilotRun } = await import("../services/mi09-pilot-authority");
      const result = await createPilotRun({ ...req.body, advancedBy: (req as any).user?.email ?? "admin" });
      res.json(result);
    } catch (err: any) {
      res.status(err?.message?.includes("BLOCKED") ? 409 : 500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/runs/:runId/select-cohort — deterministic, server-side
  // cohort selection. The operator UI calls this instead of assembling a member
  // list by hand: it selects from the definition's own certified scope, applies
  // fixed exclusions (DBPR lineage, test/demo data, already-linked identities,
  // suppressed records, open conflicts), and freezes the result. Idempotent.
  app.post("/api/lead-ops/pilot/runs/:runId/select-cohort", requireRole("admin"), async (req, res) => {
    try {
      const { selectDeterministicPilotCohort } = await import("../services/mi09-pilot-authority");
      const result = await selectDeterministicPilotCohort(String(req.params.runId));
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("INSUFFICIENT") ? 409
        : err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("MISSING_SOURCE_ADAPTER") ? 400
        : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/pilot/budget-summary — ladder-wide aggregate paid spend
  // (settled + in-flight reserved) across ALL pilot runs and providers, vs the
  // single $50 cap. This is a separate, additional guardrail from each pilot
  // definition's own per-run stopConditionThresholds.spendCapMicros.
  app.get("/api/lead-ops/pilot/budget-summary", requireRole("admin"), async (_req, res) => {
    try {
      const { getAggregatePilotSpend, getPaidBudgetAuthorization } = await import("../services/mi09-pilot-authority");
      const [summary, authorization] = await Promise.all([getAggregatePilotSpend(), getPaidBudgetAuthorization()]);
      res.json({ summary, authorization });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Read-only approval state without exposing legacy budget metadata.
  app.get("/api/lead-ops/pilot/paid-provider-approval", requireRole("admin"), async (_req, res) => {
    try {
      const { getPaidBudgetAuthorization } = await import("../services/mi09-pilot-authority");
      const current = await getPaidBudgetAuthorization() as any;
      if (!current) return res.json({ authorization: null });
      const { capMicros: _legacyCapMicros, ...approval } = current;
      res.json({ authorization: approval });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/paid-provider-approval — separately revocable
  // paid-provider approval. The old URL below remains a compatible alias.
  const approvePaidProviders = async (req: any, res: any) => {
    try {
      const { authorizePaidBudget, MI09_PAID_BUDGET_TYPED_CONFIRMATION } = await import("../services/mi09-pilot-authority");
      const typedConfirmation = String(req.body?.typedConfirmation ?? "");
      if (typedConfirmation !== "AUTHORIZE PAID PILOT" && typedConfirmation !== MI09_PAID_BUDGET_TYPED_CONFIRMATION) {
        return res.status(400).json({ error: "PAID_PROVIDER_APPROVAL_DENIED:typed_confirmation_mismatch — type exactly: AUTHORIZE PAID PILOT" });
      }
      const authorizedBy = (req as any).user?.email ?? String((req as any).user?.id ?? "unknown-admin");
      const result = await authorizePaidBudget({ authorizedBy, typedConfirmation: MI09_PAID_BUDGET_TYPED_CONFIRMATION });
      await storage.createAuditLog({
        action: "mi09_pilot_paid_provider_approved",
        entityType: "system",
        entityId: 0,
        details: { authorizedBy },
      });
      const { capMicros: _legacyCapMicros, ...approval } = result;
      res.json(approval);
    } catch (err: any) {
      res.status(err?.message?.includes("DENIED") ? 403 : 500).json({ error: err?.message });
    }
  };
  app.post("/api/lead-ops/pilot/paid-provider-approval", requireRole("admin"), approvePaidProviders);
  app.post("/api/lead-ops/pilot/authorize-paid-budget", requireRole("admin"), approvePaidProviders);

  // GET /api/lead-ops/recurrence/budget-summary — corrective item 8: the
  // recurring-execution aggregate paid spend cap and typed authorization,
  // tracked independently from the pilot's own $50 aggregate/authorization.
  app.get("/api/lead-ops/recurrence/budget-summary", requireRole("admin"), async (_req, res) => {
    try {
      const { getAggregateRecurringPaidSpend, getRecurringPaidBudgetAuthorization } = await import("../services/cro08a/schedule-authority");
      const [summary, authorization] = await Promise.all([getAggregateRecurringPaidSpend(), getRecurringPaidBudgetAuthorization()]);
      res.json({ summary, authorization });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/recurrence/authorize-paid-budget — corrective item 8:
  // one-time typed confirmation before any CRO-08A recurring schedule naming
  // a paid provider in its budgets may activate. Distinct from the pilot's
  // "AUTHORIZE $50 PAID PILOT" confirmation — a completed pilot ladder never
  // implicitly authorizes recurring paid spend.
  app.post("/api/lead-ops/recurrence/authorize-paid-budget", requireRole("admin"), async (req, res) => {
    try {
      const { authorizeRecurringPaidBudget, CRO08A_RECURRING_BUDGET_TYPED_CONFIRMATION } = await import("../services/cro08a/schedule-authority");
      const typedConfirmation = String(req.body?.typedConfirmation ?? "");
      if (typedConfirmation !== CRO08A_RECURRING_BUDGET_TYPED_CONFIRMATION) {
        return res.status(400).json({ error: `CRO08A_RECURRING_PAID_AUTHORIZATION_DENIED:typed_confirmation_mismatch — must type exactly: ${CRO08A_RECURRING_BUDGET_TYPED_CONFIRMATION}` });
      }
      const authorizedBy = (req as any).user?.email ?? String((req as any).user?.id ?? "unknown-admin");
      const result = await authorizeRecurringPaidBudget({ authorizedBy, typedConfirmation });
      await storage.createAuditLog({
        action: "cro08a_recurring_paid_budget_authorized",
        entityType: "system",
        entityId: 0,
        details: { authorizedBy, capMicros: result.capMicros },
      });
      res.json(result);
    } catch (err: any) {
      res.status(err?.message?.includes("DENIED") ? 403 : 500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/emergency-stop-paid — real paid-provider stop.
  // It disables every paid control row (including the legacy Serper singleton),
  // turns off automatic ZeroBounce and recurring CRO08A execution, and returns
  // already-dispatched operations that still require reconciliation.
  app.post("/api/lead-ops/pilot/emergency-stop-paid", requireRole("admin"), async (req, res) => {
    try {
      const { revokePaidBudgetAuthorization } = await import("../services/mi09-pilot-authority");
      const { emergencyStopPaidProviders } = await import("../services/paid-provider-control");
      const revokedBy = (req as any).user?.email ?? String((req as any).user?.id ?? "unknown-admin");
      const reason = String(req.body?.reason ?? "operator_emergency_stop");

      await revokePaidBudgetAuthorization({ revokedBy, reason });
      const result = await emergencyStopPaidProviders({ stoppedBy: revokedBy, reason });
      res.json({
        ok: true,
        budgetAuthorizationRevoked: true,
        providersDisabled: result.providersDisabled,
        deactivatedSchedules: result.schedulesDeactivated,
        inFlightCount: result.inFlightCount,
        inFlightOperations: result.inFlightOperations,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/runs/:runId/freeze-cohort — freeze pilot cohort (idempotent)
  // Body: { members: Array<{canonicalBusinessId, sourceAdapterKey, countyFips, vertical?}> }
  app.post("/api/lead-ops/pilot/runs/:runId/freeze-cohort", requireRole("admin"), async (req, res) => {
    try {
      const { freezePilotCohort } = await import("../services/mi09-pilot-authority");
      const members = req.body?.members;
      if (!Array.isArray(members) || members.length === 0) {
        return res.status(400).json({ error: "members array is required and must be non-empty" });
      }
      const result = await freezePilotCohort({
        pilotRunId: String(req.params.runId),
        members: members as Array<{ canonicalBusinessId: string; sourceAdapterKey: string; countyFips: string; vertical?: string }>,
      });
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("INSUFFICIENT") ? 409 : err?.message?.includes("BLOCKED") ? 409 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // NOTE: There is intentionally no manual checkpoint endpoint.
  // Checkpoints are ONLY advanced by the verified executor (execute-phase) to
  // prevent checkpoint-only state manipulation that could satisfy the certification
  // gate without evidence that actual enrichment work ran.
  // (Removed: POST /api/lead-ops/pilot/runs/:runId/checkpoints)

  // POST /api/lead-ops/pilot/runs/:runId/effect-links — record a pilot effect link.
  // SECURITY: this route only accepts entity_type values that correspond to entities the
  // caller can verify exist. The caller must supply an entity_id that actually exists in
  // the referenced table; the service layer validates FK existence before writing.
  // 'cro03c_command' and 'generation' entities are only accepted via executePilotCohortPhase()
  // (the verified executor) — not via this open-form endpoint. Attempting to record those
  // types here is rejected to prevent fabricated execution evidence from satisfying the
  // certification gate.
  app.post("/api/lead-ops/pilot/runs/:runId/effect-links", requireRole("admin"), async (req, res) => {
    try {
      const entityType = String(req.body?.entityType ?? req.body?.entity_type ?? "");
      // Block execution-evidence entity types on this manual endpoint.
      // These can only be written by the verified pilot executor (executePilotCohortPhase).
      if (entityType === "cro03c_command" || entityType === "generation") {
        return res.status(403).json({
          error: `EFFECT_LINK_FORBIDDEN:entity_type=${entityType} — execution-evidence types may ` +
            `only be written by the verified pilot cohort executor, not via manual link registration`,
        });
      }
      const { recordPilotEffectLink } = await import("../services/mi09-pilot-authority");
      await recordPilotEffectLink({ pilotRunId: String(req.params.runId), ...req.body });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/runs/:runId/stop-conditions — evaluate stop conditions
  app.get("/api/lead-ops/pilot/runs/:runId/stop-conditions", requireRole("admin"), async (req, res) => {
    try {
      const { evaluateStopConditions } = await import("../services/mi09-pilot-authority");
      res.json(await evaluateStopConditions(String(req.params.runId)));
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/runs/:runId/execute-phase — run one checkpoint page of the pilot cohort executor.
  // Consumes mi09_pilot_cohort_members for the given run and records mi09_pilot_effect_links.
  // Resumable: reads last checkpoint and picks up where it left off.
  // Must be called repeatedly (one page at a time) until {complete:true} is returned.
  app.post("/api/lead-ops/pilot/runs/:runId/execute-phase", requireRole("admin"), async (req, res) => {
    try {
      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
      if (!idempotencyKey) {
        return res.status(400).json({ error: "Idempotency-Key header is required" });
      }
      const { executePilotCohortPhase, assertPaidBudgetAuthorized, getPilotRun, getPilotDefinitions } = await import("../services/mi09-pilot-authority");

      // Paid-provider gate: retain explicit operator approval, without an
      // aggregate-spend authorization or cap check.
      const run = await getPilotRun(String(req.params.runId));
      if (!run) return res.status(404).json({ error: "PILOT_RUN_NOT_FOUND" });
      const defs = await getPilotDefinitions();
      const def = defs.find((d: any) => String(d.id) === String(run.pilot_definition_id));
      const paidAllowed = def?.paid_providers_allowed
        ? (typeof def.paid_providers_allowed === "string" ? JSON.parse(def.paid_providers_allowed) : def.paid_providers_allowed)
        : {};
      const anyPaidAllowed = Object.values(paidAllowed).some((v) => v === true);
      if (anyPaidAllowed) {
        await assertPaidBudgetAuthorized();
      }

      const result = await executePilotCohortPhase({
        pilotRunId: String(req.params.runId),
        phase: String(req.body?.phase ?? "enrichment") as any,
        batchSize: req.body?.batchSize ? Number(req.body.batchSize) : 50,
      });
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("MI09_PAID_BUDGET_NOT_AUTHORIZED") ? 403 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/reconciliation-reports — generate and save the
  // complete report from durable server data. The client supplies only run id.
  app.post("/api/lead-ops/pilot/reconciliation-reports", requireRole("admin"), async (req, res) => {
    try {
      const pilotRunId = String(req.body?.pilotRunId ?? "");
      if (!pilotRunId) return res.status(400).json({ error: "pilotRunId required" });
      const { buildPilotReconciliationReport, savePilotReconciliationReport } = await import("../services/mi09-pilot-authority");
      const reportData = await buildPilotReconciliationReport(pilotRunId);
      const saved = await savePilotReconciliationReport({ pilotRunId, reportData });
      res.json({ ...saved, pilotRunId, reportData });
    } catch (err: any) {
      const status = err?.message?.includes("PILOT_RUN_NOT_FOUND") ? 404 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  app.post("/api/lead-ops/clear-sla-tasks", requireRole("admin", "manager"), async (req, res) => {
    try {
      const result = await db.execute(sql`
        UPDATE tasks t
        SET status = 'resolved', updated_at = NOW()
        FROM deals d
        JOIN contacts c ON d.contact_id = c.id
        WHERE t.deal_id = d.id
          AND t.status = 'pending'
          AND t.title ILIKE 'SLA%'
          AND (c.email IS NULL OR c.email = '')
          AND (c.phone IS NULL OR c.phone = '')
        RETURNING t.id
      `);
      const cleared = ((result as any).rows ?? result).length;

      await storage.createAuditLog({
        action: "lead_ops_clear_sla_tasks",
        entityType: "system",
        entityId: 0,
        details: { cleared, reason: "no_contact_method" },
      });

      res.json({ cleared, message: `Cleared ${cleared} stuck SLA tasks for contactless leads.` });
    } catch (err: any) {
      console.error("[LeadOps] clear-sla-tasks error:", err?.message);
      res.status(500).json({ error: err?.message || "Failed to clear tasks" });
    }
  });

  // ── GET/PUT /api/lead-ops/sfp/settings/validation-promotion-override ───────
  // Admin-auditable override for FREE_DISCOVERY_VALIDATION_PROMOTION_ENABLED,
  // which was previously only settable by editing the env var and
  // redeploying. `override:true` opens the gate even when the env var is
  // unset/false; `override:false` closes it even when the env var is
  // "true" (fail-closed always wins); `override:null` clears the override
  // and defers entirely to the env var (prior behavior).
  app.get("/api/lead-ops/sfp/settings/validation-promotion-override", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isSfpValidationPromotionEnabled } = await import("../services/cro03/south-florida-prospecting");
      const override = await storage.getSystemSetting("sfp_validation_promotion_override_enabled");
      res.json({
        override: override === true || override === "true" ? true : override === false || override === "false" ? false : null,
        envVarEnabled: process.env.FREE_DISCOVERY_VALIDATION_PROMOTION_ENABLED === "true",
        effective: await isSfpValidationPromotionEnabled(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });
  app.put("/api/lead-ops/sfp/settings/validation-promotion-override", requireRole("admin"), async (req, res) => {
    try {
      const raw = req.body?.override;
      if (raw !== true && raw !== false && raw !== null) {
        return res.status(400).json({ error: "override must be true, false, or null" });
      }
      const { setSfpValidationPromotionOverride } = await import("../services/cro03/south-florida-prospecting");
      const result = await setSfpValidationPromotionOverride({ value: raw, actorId: String((req.user as any)?.id ?? "system") });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Staged-email materialization ────────────────────────────────────────────
  // Turns staged first-party emails for mapped-vertical, non-DBPR businesses
  // into contacts. No provider spend, no sends, no enrollment.
  app.get("/api/lead-ops/staged-email-materialization/preview", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { previewStagedEmailMaterialization } = await import("../services/free-discovery/staged-email-materialization");
      res.json(await previewStagedEmailMaterialization());
    } catch (error: any) {
      console.error("[StagedEmailMaterialization] preview failed:", error?.cause?.message ?? error?.message);
      serverError(res, error);
    }
  });
  app.post("/api/lead-ops/staged-email-materialization/run", requireRole("admin"), async (req, res) => {
    const limit = req.body?.limit === undefined ? 100 : Number(req.body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: "limit must be an integer between 1 and 500" });
    }
    try {
      const { runStagedEmailMaterialization } = await import("../services/free-discovery/staged-email-materialization");
      res.json(await runStagedEmailMaterialization({ limit, actorId: String((req.user as any)?.id ?? "system") }));
    } catch (error: any) {
      console.error("[StagedEmailMaterialization] run failed:", error?.cause?.message ?? error?.message);
      serverError(res, error);
    }
  });

  // ── GET /api/lead-ops/candidates/promotion-state ────────────────────────────
  app.post("/api/lead-ops/candidates/routine-promotion", requireRole("admin"), async (req, res) => {
    const limit = req.body?.limit === undefined ? 25 : Number(req.body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({ error: "limit must be an integer between 1 and 50" });
    }
    try {
      const { promoteRoutineSfpValidationCandidates } = await import("../services/free-discovery/evidence-service");
      res.json(await promoteRoutineSfpValidationCandidates(limit));
    } catch (error: any) {
      console.error("[Routine SFP] promotion batch failed:", error?.cause?.message ?? error?.message);
      serverError(res, error);
    }
  });
  // Exposes the runtime gate for FREE_DISCOVERY_VALIDATION_PROMOTION_ENABLED so
  // the UI can display correct status without having admins guess from env vars.
  app.get("/api/lead-ops/candidates/promotion-state", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isSfpValidationPromotionEnabled } = await import("../services/cro03/south-florida-prospecting");
      const enabled = await isSfpValidationPromotionEnabled();
      const { getSfpDeploymentOwnerReadiness, getSfpProviderReadiness } = await import("../services/cro03/sfp-provider-operations");
      const runtimeOwner = await getSfpDeploymentOwnerReadiness();
      const provider = await getSfpProviderReadiness("zerobounce");
      const stagedCount = ((await db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM free_discovery_candidates WHERE disposition = 'staged'
      `)) as any).rows?.[0]?.cnt ?? 0;
      const validationAdmittedCount = ((await db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM free_discovery_candidates WHERE disposition = 'validation_admitted'
      `)) as any).rows?.[0]?.cnt ?? 0;
      const scopedStaged = Number(((await db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM free_discovery_candidates f
        WHERE f.disposition='staged' AND f.field='email' AND EXISTS (
          SELECT 1 FROM sfp_cohort_members m JOIN sfp_cohort_runs r ON r.id=m.cohort_run_id
          JOIN sfp_programs p ON p.id=r.program_id AND p.is_active=TRUE
          WHERE m.business_id=f.business_id AND r.cohort_state='frozen'
            AND r.voided_at IS NULL AND r.superseded_at IS NULL)
      `)) as any).rows?.[0]?.cnt ?? 0);
      const gateOpen = enabled && runtimeOwner.ready && provider.ready && scopedStaged > 0;
      let note: string;
      if (!enabled) {
        note = "Promotion configuration is disabled (effective environment/override setting).";
      } else if (!runtimeOwner.ready) {
        note = `Promotion gate is CLOSED — durable routine-SFP deployment ownership is not ready (${runtimeOwner.reason}).`;
      } else if (!provider.ready) {
        note = `Routine SFP validation provider is held: ${provider.reason}.`;
      } else if (scopedStaged === 0) {
        note = "No staged email candidates belong to a current frozen active-program SFP cohort. Global staged inventory is not admitted work.";
      } else {
        note = "Promotion gate is OPEN. Candidates still need identity, provider, validation and policy checks; an open gate is not proof of output.";
      }
      res.json({
        lane: "routine_sfp",
        consumer: "sfp-continuous-validation",
        promotionEnabled: enabled,
        runtimeOwnerReady: runtimeOwner.ready,
        runtimeOwnerReason: runtimeOwner.reason,
        gateOpen,
        staged: Number(stagedCount),
        scopedStaged,
        unscopedStaged: Math.max(0, Number(stagedCount) - scopedStaged),
        providerReady: provider.ready,
        providerReason: provider.reason,
        validationAdmitted: Number(validationAdmittedCount),
        note,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Level 1 ROI cohort routes ───────────────────────────────────────────────

  // POST /api/lead-ops/pilot/definitions/ensure-level1 — convergently creates the
  // canonical Level 1 pilot definition (South FL FIPS + five verticals, no paid
  // providers, max 25 businesses).
  app.post("/api/lead-ops/pilot/definitions/ensure-level1", requireRole("admin"), async (req, res) => {
    try {
      const { ensureLevel1PilotDefinition } = await import("../services/cro03/level1-roi-cohort");
      const result = await ensureLevel1PilotDefinition({
        createdBy: `admin:${(req as any).user?.id ?? "system"}`,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/runs/:runId/select-roi-cohort — Level 1 ROI-ranked
  // cohort selection + freeze. Uses selectRoiCohort() (businesses + business_locations
  // directly) so it succeeds when master_leads = 0. Idempotent.
  app.post("/api/lead-ops/pilot/runs/:runId/select-roi-cohort", requireRole("admin"), async (req, res) => {
    try {
      const { selectAndFreezeLevel1RoiCohort } = await import("../services/cro03/level1-roi-cohort");
      const result = await selectAndFreezeLevel1RoiCohort(String(req.params.runId));
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("CENSUS_INSUFFICIENT") ? 409
        : err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("NOT_LEVEL_1") ? 400
        : err?.message?.includes("FREEZE_BLOCKED") ? 409
        : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/pilot/runs/:runId/free-evidence-report — Level 1 free-evidence
  // summary per frozen cohort business. Shows candidate counts, best masked values,
  // geography / vertical distribution. Never triggers any paid provider call.
  app.get("/api/lead-ops/pilot/runs/:runId/free-evidence-report", requireRole("admin"), async (req, res) => {
    try {
      const { getLevel1FreeEvidenceReport } = await import("../services/cro03/level1-roi-cohort");
      const report = await getLevel1FreeEvidenceReport(String(req.params.runId));
      res.json(report);
    } catch (err: any) {
      res.status(err?.message?.includes("NOT_FOUND") ? 404 : 500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/pilot/runs/:runId/validation-preview — preview bounded
  // ZeroBounce validation for the frozen cohort. Shows exact count, cost, worst-case,
  // remaining budget, and gate status. Read-only; no provider call.
  app.get("/api/lead-ops/pilot/runs/:runId/validation-preview", requireRole("admin"), async (req, res) => {
    try {
      const { previewCohortValidation } = await import("../services/cro03/cohort-validation");
      const preview = await previewCohortValidation(String(req.params.runId));
      res.json(preview);
    } catch (err: any) {
      res.status(err?.message?.includes("NOT_FOUND") ? 404 : 500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/pilot/runs/:runId/validate-cohort — operator-authorized
  // bounded ZeroBounce validation. Max 25 addresses. Only provider_valid results
  // create master_leads rows. Idempotent by idempotencyKey.
  // Body: { idempotencyKey: string, maxValidations?: number }
  app.post("/api/lead-ops/pilot/runs/:runId/validate-cohort", requireRole("admin"), async (req, res) => {
    try {
      const { executeBoundedValidation } = await import("../services/cro03/cohort-validation");
      const idempotencyKey = String(req.body?.idempotencyKey ?? "");
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return res.status(400).json({ error: "idempotencyKey is required (max 200 chars)" });
      }
      const result = await executeBoundedValidation(String(req.params.runId), {
        idempotencyKey,
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
        maxValidations: req.body?.maxValidations,
      });
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("BLOCKED") ? 422
        : err?.message?.includes("NOT_FROZEN") ? 409
        : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SOUTH FLORIDA PROSPECTING — independent program routes
  // Works when master_leads = 0, no MI-09 pilot, no CRO-03A handoffs.
  // ════════════════════════════════════════════════════════════════════════════

  // GET /api/lead-ops/sfp/program — read-only lookup. Never creates or
  // converges the program row; use POST .../program/ensure for that.
  app.get("/api/lead-ops/sfp/program", requireRole("admin"), async (_req, res) => {
    try {
      const { getProgramReadOnly } = await import("../services/cro03/south-florida-prospecting");
      const program = await getProgramReadOnly();
      if (!program) return res.status(404).json({ error: "SFP_PROGRAM_NOT_CONFIGURED" });
      res.json(program);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/program/ensure — idempotent program creation
  app.post("/api/lead-ops/sfp/program/ensure", requireRole("admin"), async (req, res) => {
    try {
      const { ensureProgram } = await import("../services/cro03/south-florida-prospecting");
      const program = await ensureProgram({
        createdBy: `admin:${(req as any).user?.id ?? "system"}`,
        maxCohortSize: req.body?.maxCohortSize,
      });
      res.json(program);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/program/activation — explicit operator switch.
  // Credentials and background profiles never implicitly activate this program.
  app.post("/api/lead-ops/sfp/program/activation", requireRole("admin"), async (req, res) => {
    try {
      if (typeof req.body?.active !== "boolean") {
        return res.status(400).json({ error: "active must be a boolean" });
      }
      const { setProgramActivation } = await import("../services/cro03/south-florida-prospecting");
      const program = await setProgramActivation({
        active: req.body.active,
        recurringEnabled: req.body.recurringEnabled === true,
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
      });
      res.json(program);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/program/migrate-v2 — explicit, audited, one-time
  // move of the South Florida program from the legacy v1 target-vertical
  // taxonomy to v2 (Automotive, Healthcare, Beauty/Spa,
  // Construction/Trades/Home Services, Fitness/Recreation). No-ops
  // (migrated:false) if already on v2. Returns before/after program state
  // and a before/after funnel snapshot so the caller has evidence of the
  // effect without needing a separate script or DB access.
  app.post("/api/lead-ops/sfp/program/migrate-v2", requireRole("admin"), async (req, res) => {
    try {
      const { getProgramReadOnly, previewFunnel, migrateProgramToTargetVerticalsV2 } = await import("../services/cro03/south-florida-prospecting");
      const before = await getProgramReadOnly();
      if (!before) return res.status(404).json({ error: "SFP_PROGRAM_NOT_CONFIGURED" });
      const beforeFunnel = await previewFunnel({ maxPreview: 25 });
      const migration = await migrateProgramToTargetVerticalsV2({
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
      });
      const afterFunnel = await previewFunnel({ maxPreview: 25 });
      res.json({
        migrated: migration.migrated,
        reason: migration.reason ?? null,
        before: { program: before, funnel: beforeFunnel.funnel },
        after: { program: migration.program, funnel: afterFunnel.funnel },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/funnel — read-only funnel preview with truthful counts.
  // Optional selectedContactIds creates a fresh, read-only scoped preview;
  // it does not alter an existing frozen cohort or bypass selector admission.
  app.get("/api/lead-ops/sfp/funnel", requireRole("admin"), async (req, res) => {
    try {
      const { previewFunnel } = await import("../services/cro03/south-florida-prospecting");
      let maxPreview = 25;
      if (req.query.maxPreview !== undefined) {
        maxPreview = Number(req.query.maxPreview);
        if (!Number.isInteger(maxPreview) || maxPreview < 1 || maxPreview > 100) {
          return res.status(400).json({ error: "maxPreview must be an integer between 1 and 100" });
        }
      }
      const preview = await previewFunnel({
        maxPreview,
        selectedContactIds: parseSelectedContactIds(req.query.selectedContactIds),
      });
      res.json(preview);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const status = message.includes("SELECTED_CONTACT_IDS_INVALID") ? 400
        : message.includes("SELECTED_CONTACT") ? 422 : 500;
      res.status(status).json({ error: message });
    }
  });

  // POST /api/lead-ops/sfp/serper/single-probe — bounded, governed, single-call
  // Serper verification probe (task: SFP South Florida enrichment Stage 2).
  // Hard-caps the SHARED serper_control billing window to at most one more
  // atomic budget claim before making the call, so this endpoint can never
  // let a concurrent recurring backlog tick (or another caller) consume more
  // than the one call this request itself accounts for. Targets exactly one
  // eligible v2-cohort business (from the live funnel preview, excluding
  // anything already resolved) so the call proves real signal, not a no-op.
  // Never mutates program config or freezes a cohort.
  app.post("/api/lead-ops/sfp/serper/single-probe", requireRole("admin"), async (req, res) => {
    try {
      const { db } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const { getProgramReadOnly, previewFunnel } = await import("../services/cro03/south-florida-prospecting");
      const { serperGateway } = await import("../services/serper-gateway");
      const { serperAuthorityPermits } = await import("../services/sdr/serper-enrichment");

      const program = await getProgramReadOnly();
      if (!program) return res.status(404).json({ error: "SFP_PROGRAM_NOT_CONFIGURED" });

      const authority = await serperAuthorityPermits(serperGateway);
      if (!authority.permitted) {
        return res.status(422).json({ error: "SERPER_AUTHORITY_BLOCKED", reason: authority.reason });
      }

      const businessId = Number(req.body?.businessId);
      if (!Number.isInteger(businessId) || businessId <= 0) {
        return res.status(400).json({ error: "businessId (integer) is required — pick one from GET /api/lead-ops/sfp/funnel topCandidates" });
      }
      const preview = await previewFunnel({ maxPreview: 25 });
      const candidate = preview.topCandidates.find((c) => c.businessId === businessId);
      if (!candidate) {
        return res.status(404).json({ error: "BUSINESS_NOT_IN_CURRENT_ELIGIBLE_V2_COHORT", businessId });
      }
      const bizRow = (await db.execute(sql`
        SELECT id, canonical_name, city, state FROM businesses WHERE id = ${businessId} LIMIT 1
      `)).rows?.[0] as any;
      if (!bizRow) return res.status(404).json({ error: "BUSINESS_NOT_FOUND" });

      // Do NOT mutate the shared serper_control.local_budget ceiling here.
      // A read-then-restore of that column races any concurrent operator
      // change or the recurring existing-contact backlog tick — whichever
      // writer runs last silently clobbers the other's value. Exclusivity
      // for "exactly one call" instead comes from a dedicated, uniquely
      // keyed provider_operations reservation: the INSERT below can only
      // ever succeed once per idempotencyKey (unique index), so a second
      // concurrent invocation of this route for the same business+run is
      // rejected before it reaches the gateway, while the gateway's own
      // atomic window_calls claim (unchanged, unrestricted) still protects
      // the shared budget from being exceeded by this call.
      const controlBefore = await serperGateway.getControl();
      if (!controlBefore) return res.status(500).json({ error: "SERPER_CONTROL_MISSING" });

      const probeIdempotencyKey = `sfp_stage2_single_probe:${businessId}`;
      const claim = (await db.execute(sql`
        INSERT INTO provider_operations
          (provider, operation_type, purpose, idempotency_key, actor_type, actor_id, target_fingerprint,
           state, requested_units, reserved_units, billing_state, attempt_count, claim_token, lease_expires_at, started_at)
        VALUES ('serper', 'sfp_stage2_single_probe', 'sfp_stage2_verification', ${probeIdempotencyKey}, 'user',
                ${`admin:${(req as any).user?.id ?? "system"}`}, ${`business:${businessId}`},
                'running', 1, 1, 'reserved', 1, gen_random_uuid(), NOW() + INTERVAL '5 minutes', NOW())
        ON CONFLICT (provider, idempotency_key) DO NOTHING
        RETURNING id
      `).catch(() => ({ rows: [] } as any))).rows?.[0];
      if (!claim) {
        return res.status(409).json({ error: "SFP_STAGE2_PROBE_ALREADY_CLAIMED", businessId, hint: "This business already has a single-probe reservation in flight or completed; pick a different businessId or inspect the existing provider_operations row." });
      }

      const CALLER = "sfp_stage2_single_probe";
      const response = await serperGateway.executeSearch(
        "/search",
        { q: `${bizRow.canonical_name} ${bizRow.city ?? ""} ${bizRow.state ?? ""}`.trim() },
        CALLER,
      );

      const controlAfter = await serperGateway.getControl();
      // The call is only a real, successful probe when the gateway actually
      // reached Serper and did not block/error — settle the reservation
      // accordingly instead of always marking it 'completed'/'settled', or a
      // blocked/failed attempt would be indistinguishable from a real one in
      // provider_operations and would permanently occupy this business's
      // idempotency key with a false-success row.
      const succeeded = response.ok === true && response.blocked !== true;
      await db.execute(sql`
        UPDATE provider_operations
           SET state = ${succeeded ? "completed" : "failed"},
               billing_state = ${succeeded ? "settled" : "released"},
               failure_code = ${succeeded ? null : `blocked=${String(response.blocked)},status=${String((response as any).status ?? "unknown")}`},
               updated_at = NOW()
         WHERE provider = 'serper' AND idempotency_key = ${probeIdempotencyKey}
      `);

      await db.execute(sql`
        INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
        VALUES ('sfp_stage2_serper_single_probe', 'business', ${String(businessId)}, 'user',
                ${`admin:${(req as any).user?.id ?? "system"}`},
                ${JSON.stringify(sanitizeAuditPayload({
                  businessId, succeeded, blocked: response.blocked, ok: response.ok, status: (response as any).status ?? null,
                  windowCallsBefore: controlBefore.window_calls, windowCallsAfter: controlAfter?.window_calls ?? null,
                }))}::jsonb)
      `);

      res.json({
        businessId,
        succeeded,
        blocked: response.blocked,
        ok: response.ok,
        status: (response as any).status ?? null,
        hasResult: !!(response as any).data,
        windowCallsBefore: controlBefore.window_calls,
        windowCallsAfter: controlAfter?.window_calls ?? null,
        providerBalance: controlAfter?.provider_balance ?? null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs — list cohort runs
  app.get("/api/lead-ops/sfp/runs", requireRole("admin"), async (_req, res) => {
    try {
      const { listCohortRuns } = await import("../services/cro03/south-florida-prospecting");
      const runs = await listCohortRuns();
      res.json({ runs });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/runs/freeze — freeze a deterministic cohort (idempotent).
  // Optional selectedContactIds requires a fresh matching previewSnapshotHash
  // and creates a new immutable run; it never edits or injects into old runs.
  app.post("/api/lead-ops/sfp/runs/freeze", requireRole("admin"), async (req, res) => {
    try {
      const { freezeCohort } = await import("../services/cro03/south-florida-prospecting");
      const idempotencyKey = String(req.body?.idempotencyKey ?? "");
      if (!idempotencyKey) {
        return res.status(400).json({ error: "idempotencyKey is required" });
      }
      const requestedCohortSize = req.body?.maxCohortSize == null ? 25 : Number(req.body.maxCohortSize);
      if (!Number.isInteger(requestedCohortSize) || requestedCohortSize < 1 || requestedCohortSize > 100) {
        return res.status(400).json({ error: "maxCohortSize must be an integer between 1 and 100" });
      }
      const result = await freezeCohort({
        idempotencyKey,
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
        maxCohortSize: requestedCohortSize,
        releaseSha: process.env.RELEASE_SHA ?? "",
        selectedContactIds: parseSelectedContactIds(req.body?.selectedContactIds),
        previewSnapshotHash: req.body?.previewSnapshotHash == null
          ? undefined : String(req.body.previewSnapshotHash),
      });
      res.json(result);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const status = message.includes("SELECTED_CONTACT_IDS_INVALID") ||
          message.includes("PREVIEW_SNAPSHOT_HASH_REQUIRED") ? 400
        : message.includes("SCOPE_PREVIEW_STALE") ||
          message.includes("SFP_IDEMPOTENCY_KEY_PAYLOAD_MISMATCH") ||
          message.includes("SFP_COHORT_RUN_PREVIOUSLY_FAILED") ||
          message.includes("SFP_COHORT_RUN_TERMINAL_LIFECYCLE") ||
          message.includes("COHORT_CENSUS_INSUFFICIENT") ? 409
        : message.includes("SELECTED_CONTACT") ? 422 : 500;
      res.status(status).json({ error: message });
    }
  });

  // POST /api/lead-ops/sfp/program/initialize-from-legacy — explicit, audited,
  // one-time consumption of the legacy cro03c_roi_pilot_verticals setting.
  // Only fires when no SFP program configuration exists yet.
  app.post("/api/lead-ops/sfp/program/initialize-from-legacy", requireRole("admin"), async (req, res) => {
    try {
      const { initializeProgramFromLegacyConfig } = await import("../services/cro03/south-florida-prospecting");
      const result = await initializeProgramFromLegacyConfig({
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/runs/:runId/void — append-only void of a frozen
  // cohort run. Never rewrites or deletes the frozen manifest/members/decisions.
  app.post("/api/lead-ops/sfp/runs/:runId/void", requireRole("admin"), async (req, res) => {
    try {
      const reason = String(req.body?.reason ?? "").trim();
      if (!reason) return res.status(400).json({ error: "reason is required" });
      const { voidCohortRun } = await import("../services/cro03/south-florida-prospecting");
      const run = await voidCohortRun({
        cohortRunId: String(req.params.runId),
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
        reason,
      });
      res.json(run);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("REJECTED") ? 409 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/runs/:runId/supersede — append-only supersede of a
  // frozen cohort run by a newly frozen replacement run.
  app.post("/api/lead-ops/sfp/runs/:runId/supersede", requireRole("admin"), async (req, res) => {
    try {
      const supersededByRunId = String(req.body?.supersededByRunId ?? "").trim();
      if (!supersededByRunId) return res.status(400).json({ error: "supersededByRunId is required" });
      const { supersedeCohortRun } = await import("../services/cro03/south-florida-prospecting");
      const run = await supersedeCohortRun({
        cohortRunId: String(req.params.runId),
        supersededByRunId,
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
      });
      res.json(run);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("REJECTED") ? 409 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId — get a single cohort run
  app.get("/api/lead-ops/sfp/runs/:runId", requireRole("admin"), async (req, res) => {
    try {
      const { getCohortRun } = await import("../services/cro03/south-florida-prospecting");
      const run = await getCohortRun(String(req.params.runId));
      if (!run) return res.status(404).json({ error: "SFP cohort run not found" });
      res.json(run);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId/reconciliation — terminal decision-ledger
  // reconciliation (sum of all dispositions vs. total scanned canonical
  // businesses), kept visually and structurally separate from downstream
  // stage-progress metrics.
  app.get("/api/lead-ops/sfp/runs/:runId/reconciliation", requireRole("admin"), async (req, res) => {
    try {
      const { getCohortRunReconciliation } = await import("../services/cro03/south-florida-prospecting");
      const report = await getCohortRunReconciliation(String(req.params.runId));
      res.json(report);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/provider-results — per-call results log for the
  // paid SFP providers (Serper/Outscraper/Apollo candidate discovery +
  // OpenAI classification), not just spend totals. Never returns decrypted
  // contact values — envelopeCiphertext/Nonce/Tag are intentionally
  // excluded; maskedValue (already redacted at write time) is the most a
  // dashboard viewer ever sees for a discovered email/contact.
  app.get("/api/lead-ops/sfp/provider-results", requireRole("admin", "manager"), async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const provider = typeof req.query.provider === "string" && req.query.provider.trim() ? req.query.provider.trim() : null;
      const validationOutcome = req.query.validationOutcome ?? "all";
      if (!["all", "valid", "invalid", "review"].includes(String(validationOutcome))) {
        return res.status(400).json({ error: "validationOutcome must be all, valid, invalid or review" });
      }
      const classificationOutcome = req.query.classificationOutcome ?? "all";
      if (!["all", "target", "non_target", "review_required"].includes(String(classificationOutcome))) {
        return res.status(400).json({ error: "classificationOutcome must be all, target, non_target or review_required" });
      }

      const candidateRows = (await db.execute(sql`
        SELECT e.id, e.provider, e.field, e.subject_type, e.disposition, e.confidence,
               e.masked_value, e.person_name_evidence, e.person_title_evidence,
               e.created_at, b.id AS business_id, b.canonical_name AS business_name,
               po.unit_price_micros,po.settled_cost_micros,po.billing_state
          FROM sfp_paid_candidate_evidence e
          JOIN businesses b ON b.id = e.business_id
          LEFT JOIN LATERAL (
            SELECT i.provider_operation_id
              FROM sfp_stage_items i
             WHERE i.paid_candidate_evidence_id=e.id AND i.provider_operation_id IS NOT NULL
             ORDER BY i.updated_at DESC LIMIT 1
          ) si ON TRUE
          LEFT JOIN provider_operations po ON po.id=si.provider_operation_id
         WHERE (${provider}::text IS NULL OR e.provider = ${provider}::text)
         ORDER BY e.created_at DESC
         LIMIT ${limit}
      `) as any).rows ?? [];

      const classificationRows = (await db.execute(sql`
        SELECT e.id, e.outcome, e.confidence, e.resolved_vertical_id, e.admission_tier,
               e.reason_codes, e.terminal_state, e.model_version, e.prompt_version,
               e.taxonomy_version, e.classifier_version, e.cost_micros, e.created_at,
               b.id AS business_id, b.canonical_name AS business_name
          FROM sfp_classification_evidence e
          JOIN businesses b ON b.id = e.business_id
         WHERE (${provider}::text IS NULL OR ${provider}::text = 'openai')
           AND (${classificationOutcome}::text='all' OR e.outcome=${classificationOutcome}::text)
         ORDER BY e.created_at DESC
         LIMIT ${limit}
      `) as any).rows ?? [];

      const validationRows = (await db.execute(sql`
        SELECT e.id,e.business_id,b.canonical_name AS business_name,e.source_kind,e.discovery_source,
               e.status,e.zb_outcome,e.masked_email,e.validation_at,e.reused_from_operation_id,
               e.validation_operation_id,po.unit_price_micros,po.settled_cost_micros,po.billing_state
          FROM sfp_outreach_eligibility e
          JOIN businesses b ON b.id=e.business_id
          LEFT JOIN provider_operations po ON po.id=e.validation_operation_id
         WHERE (${provider}::text IS NULL OR ${provider}::text = 'zerobounce')
           AND e.zb_outcome IS NOT NULL
           AND (${validationOutcome}::text='all'
             OR (${validationOutcome}::text='valid' AND e.zb_outcome='valid')
             OR (${validationOutcome}::text='invalid' AND e.zb_outcome IN ('invalid','do_not_mail'))
             OR (${validationOutcome}::text='review' AND e.status IN ('validated_review_required','catch_all_review')))
         ORDER BY e.validation_at DESC NULLS LAST,e.created_at DESC,e.id DESC
         LIMIT ${limit}
      `) as any).rows ?? [];

      const validationSummary = (await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE zb_outcome IS NOT NULL)::int AS result_rows,
               COUNT(DISTINCT normalized_value_hash) FILTER (WHERE zb_outcome='valid')::int AS distinct_valid_emails,
               COUNT(DISTINCT normalized_value_hash) FILTER (WHERE status='validated_outreach_eligible' AND zb_outcome='valid')::int AS distinct_policy_eligible_emails,
               COUNT(*) FILTER (WHERE status='discovery_required')::int AS discovery_backlog_rows,
               COUNT(DISTINCT business_id) FILTER (WHERE status='discovery_required')::int AS discovery_backlog_businesses
          FROM sfp_outreach_eligibility
      `) as any).rows?.[0] ?? null;
      res.json({ candidateResults: candidateRows, classificationResults: classificationRows, validationResults: validationRows, validationSummary });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId/free-evidence — free-evidence report
  app.get("/api/lead-ops/sfp/runs/:runId/free-evidence", requireRole("admin"), async (req, res) => {
    try {
      const { getFreeEvidenceReport } = await import("../services/cro03/south-florida-prospecting");
      const report = await getFreeEvidenceReport(String(req.params.runId));
      res.json(report);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("NOT_FROZEN") ? 409 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/runs/:runId/free-discovery — execute the real
  // bounded free-only crawler for this frozen cohort.
  app.post("/api/lead-ops/sfp/runs/:runId/free-discovery", requireRole("admin"), async (req, res) => {
    try {
      const idempotencyKey = String(req.body?.idempotencyKey ?? "");
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return res.status(400).json({ error: "idempotencyKey is required (max 200 chars)" });
      }
      const maxBusinesses = req.body?.maxBusinesses == null ? 100 : Number(req.body.maxBusinesses);
      if (!Number.isInteger(maxBusinesses) || maxBusinesses < 1 || maxBusinesses > 500) {
        return res.status(400).json({ error: "maxBusinesses must be an integer between 1 and 500" });
      }
      const { runSfpFreeDiscovery } = await import("../services/cro03/south-florida-prospecting");
      const result = await runSfpFreeDiscovery({
        cohortRunId: String(req.params.runId),
        idempotencyKey,
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
        maxBusinesses,
      });
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("NOT_FROZEN") || err?.message?.includes("INACTIVE") ? 409
        : err?.message?.includes("LANE_BUSY") ? 423 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // Approve Serper for a frozen SFP cohort. This enables the provider without
  // changing its configured limit, usage counters, or circuit state.
  app.post("/api/lead-ops/sfp/runs/:runId/serper/arm-pilot", requireRole("admin"), async (req, res) => {
    try {
      const maxBusinesses = Number(req.body?.maxBusinesses);
      if (!Number.isInteger(maxBusinesses) || maxBusinesses < 1 || maxBusinesses > 10) {
        return res.status(400).json({ error: "maxBusinesses must be an integer from 1 to 10" });
      }
      const reason = String(req.body?.reason ?? "").trim();
      if (reason.length < 8 || reason.length > 200) {
        return res.status(400).json({ error: "An operator reason (8-200 characters) is required" });
      }
      const { assertSfpRuntimeAuthority } = await import("../services/cro03/sfp-provider-operations");
      const cohortRunId = String(req.params.runId);
      await assertSfpRuntimeAuthority(cohortRunId);
      if (process.env.CRO03_PROVIDER_TRANSPORT_ENABLED !== "true" || !process.env.SERPER_API_KEY) {
        return res.status(422).json({ error: "SFP_SERPER_TRANSPORT_OR_CREDENTIAL_UNAVAILABLE" });
      }
      const result = await db.transaction(async (tx) => {
        const gateway = rows(await tx.execute(sql`
          SELECT enabled,state FROM serper_control WHERE id=1 FOR UPDATE
        `))[0];
        if (!gateway?.enabled || gateway.state !== "closed") {
          throw new Error("SFP_SERPER_GATEWAY_NOT_READY");
        }
        const control = rows(await tx.execute(sql`
          SELECT enabled,circuit_state,version
            FROM provider_controls WHERE provider='serper' FOR UPDATE
        `))[0];
        if (!control || control.circuit_state !== "closed") throw new Error("SFP_SERPER_CONTROL_NOT_READY");
        const updated = rows(await tx.execute(sql`
          UPDATE provider_controls SET enabled=TRUE,version=version+1,updated_at=NOW()
           WHERE provider='serper' RETURNING provider,enabled,circuit_state,version
        `))[0];
        await tx.execute(sql`
          INSERT INTO audit_logs (user_id,action,entity_type,entity_key,details,after_state,actor_type,actor_id)
          VALUES (${String((req.user as any)?.id ?? "system")},'sfp_serper_provider_approved','provider_control','serper',
                  ${JSON.stringify(sanitizeAuditPayload({ cohortRunId, maxBusinesses, reason }))}::jsonb,
                  ${JSON.stringify(sanitizeAuditPayload(updated))}::jsonb,'user',${String((req.user as any)?.id ?? "system")})
        `);
        return updated;
      });
      res.json({ control: result, maxBusinesses, approved: true });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      res.status(/NOT_READY|NO_LIVE_RUNTIME_AUTHORITY/.test(message) ? 409 : 500).json({ error: message });
    }
  });

  // Legacy-compatible approval route for Outscraper or Apollo. The former
  // maxUsdMicros field is ignored; approval only enables the provider and
  // does not change its configured limit, counters, or circuit state.
  app.post("/api/lead-ops/sfp/provider-controls/:provider/arm-budget", requireRole("admin"), async (req, res) => {
    try {
      const provider = String(req.params.provider);
      if (provider !== "outscraper" && provider !== "apollo") {
        return res.status(400).json({ error: "Only outscraper and apollo are supported by this endpoint" });
      }
      const reason = String(req.body?.reason ?? "").trim();
      if (reason.length < 8 || reason.length > 200) {
        return res.status(400).json({ error: "An operator reason (8-200 characters) is required" });
      }
      const result = await db.transaction(async (tx) => {
        const control = rows(await tx.execute(sql`
          SELECT enabled,circuit_state,version
            FROM provider_controls WHERE provider=${provider} FOR UPDATE
        `))[0];
        if (!control) throw new Error("SFP_PROVIDER_CONTROL_NOT_FOUND");
        const updated = rows(await tx.execute(sql`
          UPDATE provider_controls SET enabled=TRUE,version=version+1,updated_at=NOW()
           WHERE provider=${provider} RETURNING provider,enabled,circuit_state,version
        `))[0];
        await tx.execute(sql`
          INSERT INTO audit_logs (user_id,action,entity_type,entity_key,details,after_state,actor_type,actor_id)
          VALUES (${String((req.user as any)?.id ?? "system")},'sfp_paid_provider_approved','provider_control',${provider},
                  ${JSON.stringify(sanitizeAuditPayload({ reason }))}::jsonb,
                  ${JSON.stringify(sanitizeAuditPayload(updated))}::jsonb,'user',${String((req.user as any)?.id ?? "system")})
        `);
        return updated;
      });
      res.json({ control: result, approved: true });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      res.status(/NOT_FOUND/.test(message) ? 404 : 500).json({ error: message });
    }
  });

  app.get("/api/lead-ops/sfp/runs/:runId/paid-waterfall-preview", requireRole("admin"), async (req, res) => {
    try {
      const { previewSfpPaidWaterfall } = await import("../services/cro03/sfp-paid-waterfall");
      res.json(await previewSfpPaidWaterfall(String(req.params.runId)));
    } catch (err: any) {
      res.status(err?.message?.includes("NOT_FOUND") ? 404 : 409).json({ error: err?.message });
    }
  });

  app.post("/api/lead-ops/sfp/runs/:runId/paid-waterfall/serper", requireRole("admin"), async (req, res) => {
    try {
      const idempotencyKey=String(req.body?.idempotencyKey ?? "");
      if(!idempotencyKey || idempotencyKey.length>200) return res.status(400).json({error:"idempotencyKey is required (max 200 chars)"});
      const maxBusinesses=req.body?.maxBusinesses == null ? 10 : Number(req.body.maxBusinesses);
      if(!Number.isInteger(maxBusinesses) || maxBusinesses<1 || maxBusinesses>25) return res.status(400).json({error:"maxBusinesses must be an integer between 1 and 25"});
      const { executeSfpSerperDiscovery } = await import("../services/cro03/sfp-paid-waterfall");
      const { buildSfpCohortCostPreview } = await import("../services/cro03/sfp-cost-preview");
      const preview = await buildSfpCohortCostPreview(String(req.params.runId));
      res.json(await executeSfpSerperDiscovery({
        cohortRunId:String(req.params.runId),idempotencyKey,
        actorId:`admin:${(req as any).user?.id ?? "system"}`,maxBusinesses,
        previewSnapshotHash: String(req.body?.previewSnapshotHash ?? preview.snapshotHash),
      }));
    } catch(err:any){
      const status=err?.message?.includes("BLOCKED") ? 422 : err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("PREVIEW") || err?.message?.includes("STALE") || err?.message?.includes("MISMATCH") ? 409 : 500;
      res.status(status).json({error:err?.message});
    }
  });

  // The recurring free-only Phase A cursor is inert until explicitly started.
  // These controls never enable providers, outreach, or the separate held
  // staging worker; status remains readable while the queue is not selected.
  app.get("/api/lead-ops/sfp/programs/:programId/free-classification-continuation", requireRole("admin"), async (req, res) => {
    try {
      const { getSfpFreeClassificationContinuation } = await import("../services/cro03/sfp-free-classification-continuation");
      res.json({ continuation: await getSfpFreeClassificationContinuation(String(req.params.programId)) });
    } catch (err: any) { res.status(500).json({ error: err?.message }); }
  });
  app.post("/api/lead-ops/sfp/programs/:programId/free-classification-continuation/start", requireRole("admin"), async (req, res) => {
    try {
      const { startSfpFreeClassificationContinuation } = await import("../services/cro03/sfp-free-classification-continuation");
      res.json({ continuation: await startSfpFreeClassificationContinuation(String(req.params.programId)) });
    } catch (err: any) {
      res.status(err?.message?.includes("REQUIRES") || err?.message?.includes("ACTIVE") || err?.message?.includes("CHANGED") ? 409 : 500)
        .json({ error: err?.message });
    }
  });
  app.post("/api/lead-ops/sfp/programs/:programId/free-classification-continuation/pause", requireRole("admin"), async (req, res) => {
    try {
      const { pauseSfpFreeClassificationContinuation } = await import("../services/cro03/sfp-free-classification-continuation");
      res.json({ continuation: await pauseSfpFreeClassificationContinuation(String(req.params.programId)) });
    } catch (err: any) { res.status(500).json({ error: err?.message }); }
  });

  // POST /api/lead-ops/sfp/classification/run — Phase A pre-cohort classification bridge (bounded, manual)
  app.get("/api/lead-ops/sfp/programs/:programId/classification-preview", requireRole("admin"), async (req, res) => {
    try {
      const { previewPreCohortClassification } = await import("../services/cro03/sfp-classification-bridge");
      res.json(await previewPreCohortClassification(String(req.params.programId), { maxBusinesses: 25 }));
    } catch (err: any) {
      res.status(err?.message?.includes("NOT_FOUND") ? 404 : 500).json({ error: err?.message });
    }
  });

  // Body: { programId, idempotencyKey, maxBusinesses?, targetIds, policyVersion, allowGovernedSerperDomainDiscovery?, businessIdFilter? }
  app.post("/api/lead-ops/sfp/classification/run", requireRole("admin"), async (req, res) => {
    try {
      const idempotencyKey = String(req.body?.idempotencyKey ?? "");
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return res.status(400).json({ error: "idempotencyKey is required (max 200 chars)" });
      }
      const programId = String(req.body?.programId ?? "");
      if (!programId) return res.status(400).json({ error: "programId is required" });
      const targetIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds.map(String) : [];
      if (targetIds.length === 0) return res.status(400).json({ error: "targetIds must be a non-empty array" });
      const policyVersion = Number(req.body?.policyVersion);
      if (!Number.isInteger(policyVersion) || policyVersion < 1) {
        return res.status(400).json({ error: "policyVersion must be a positive integer" });
      }
      const maxBusinesses = req.body?.maxBusinesses == null ? 25 : Number(req.body.maxBusinesses);
      if (!Number.isInteger(maxBusinesses) || maxBusinesses < 1 || maxBusinesses > 100) {
        return res.status(400).json({ error: "maxBusinesses must be an integer between 1 and 100" });
      }
      const businessIdFilter = Array.isArray(req.body?.businessIdFilter)
        ? req.body.businessIdFilter.map(Number).filter((n: number) => Number.isInteger(n))
        : undefined;
      const { runPreCohortClassificationBridge } = await import("../services/cro03/sfp-classification-bridge");
      const previewSnapshotHash = String(req.body?.previewSnapshotHash ?? "");
      if (!previewSnapshotHash) return res.status(400).json({ error: "previewSnapshotHash is required" });
      const result = await runPreCohortClassificationBridge({
        programId, idempotencyKey, actorId: `admin:${(req as any).user?.id ?? "system"}`,
        maxBusinesses, targetIds, policyVersion,
        allowGovernedSerperDomainDiscovery: req.body?.allowGovernedSerperDomainDiscovery === true,
        businessIdFilter,
        previewSnapshotHash,
      });
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("INVALID_CONFIG") ? 400
        : err?.message?.includes("PREVIOUSLY_FAILED") || err?.message?.includes("MISMATCH") ? 409 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/classification/snapshot/freeze — bounded frozen-snapshot
  // execution, phase 1: pin an exact business-id set + decision-relevant facts.
  // Body: { programId, businessIds (1-25), targetIds, policyVersion, taxonomyVersion, maxUnits?, ttlMinutes? }
  app.post("/api/lead-ops/sfp/classification/snapshot/freeze", requireRole("admin"), async (req, res) => {
    try {
      const programId = String(req.body?.programId ?? "");
      if (!programId) return res.status(400).json({ error: "programId is required" });
      const businessIds = Array.isArray(req.body?.businessIds)
        ? req.body.businessIds.map(Number).filter((n: number) => Number.isInteger(n)) : [];
      if (businessIds.length === 0 || businessIds.length > 25) {
        return res.status(400).json({ error: "businessIds must be a non-empty array of at most 25 integers" });
      }
      const targetIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds.map(String) : [];
      if (targetIds.length === 0) return res.status(400).json({ error: "targetIds must be a non-empty array" });
      const policyVersion = Number(req.body?.policyVersion);
      if (!Number.isInteger(policyVersion) || policyVersion < 1) {
        return res.status(400).json({ error: "policyVersion must be a positive integer" });
      }
      // A missing taxonomy version previously defaulted to v1. The v2
      // candidate preview could then freeze and classify a roofing business
      // as a v1 non-target. Pin the current program contract at the server.
      const requestedTaxonomyVersion = Number(req.body?.taxonomyVersion);
      if (requestedTaxonomyVersion !== 1 && requestedTaxonomyVersion !== 2) {
        return res.status(400).json({ error: "taxonomyVersion must be 1 or 2" });
      }
      const configured = rows(await db.execute(sql`
        SELECT taxonomy_version, policy_version, vertical_ids
          FROM sfp_programs WHERE id=${programId}::uuid LIMIT 1
      `))[0];
      if (!configured) return res.status(404).json({ error: "SFP_PROGRAM_NOT_FOUND" });
      const configuredTargets: string[] = Array.isArray(configured.vertical_ids)
        ? configured.vertical_ids.map(String) : JSON.parse(String(configured.vertical_ids));
      if (requestedTaxonomyVersion !== Number(configured.taxonomy_version)
          || policyVersion !== Number(configured.policy_version)
          || JSON.stringify([...targetIds].sort()) !== JSON.stringify([...configuredTargets].sort())) {
        return res.status(409).json({ error: "SFP_SNAPSHOT_PROGRAM_CONFIG_CHANGED" });
      }
      const taxonomyVersion = requestedTaxonomyVersion;
      const maxUnits = req.body?.maxUnits == null ? 4000 : Number(req.body.maxUnits);
      // freeOnly is the server-enforced gate: when true, the frozen
      // snapshot's allowed_provider is pinned to 'none', which
      // runFrozenClassificationSnapshot() turns into freeOnly:true on the
      // bridge call -- ZERO provider calls at run time regardless of any
      // other input. There is no client-supplied flag at run time that can
      // override this; it is set once, here, at freeze time.
      const allowedProvider: "openai_classification" | "none" = req.body?.freeOnly === true ? "none" : "openai_classification";
      const { freezeClassificationSnapshot } = await import("../services/cro03/sfp-classification-bridge");
      const result = await freezeClassificationSnapshot({
        programId, actorId: `admin:${(req as any).user?.id ?? "system"}`, businessIds, targetIds, policyVersion,
        taxonomyVersion, allowedProvider, maxUnits,
        ttlMinutes: req.body?.ttlMinutes == null ? undefined : Number(req.body.ttlMinutes),
      });
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("INVALID_BUSINESS_COUNT") ? 400 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/programs/:programId/high-confidence-candidates —
  // read-only, provider-free preview of deterministic high-confidence South
  // Florida businesses still awaiting classification, prioritized by
  // confidence. Optional `businessIds` query param (comma-separated) scopes
  // to an explicit operator-chosen set (e.g. a single confirmed business)
  // instead of scanning the whole pool.
  app.get("/api/lead-ops/sfp/programs/:programId/high-confidence-candidates", requireRole("admin"), async (req, res) => {
    try {
      const businessIdFilter = typeof req.query.businessIds === "string" && req.query.businessIds.length > 0
        ? req.query.businessIds.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
        : undefined;
      const limit = req.query.limit == null ? undefined : Number(req.query.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 250)) {
        return res.status(400).json({ error: "limit must be an integer between 1 and 250" });
      }
      if (req.query.businessIds !== undefined && (!businessIdFilter?.length
          || businessIdFilter.length > 500 || businessIdFilter.some((id) => !Number.isSafeInteger(id) || id < 1))) {
        return res.status(400).json({ error: "businessIds must contain 1–500 positive business IDs" });
      }
      const { previewHighConfidenceClassificationCandidates } = await import("../services/cro03/sfp-classification-bridge");
      res.json(await previewHighConfidenceClassificationCandidates(String(req.params.programId), { businessIdFilter, limit }));
    } catch (err: any) {
      const notFound = err?.message === "SFP_PROGRAM_NOT_FOUND";
      console.error("[LeadOps] high-confidence preview failed", {
        code: err?.cause?.code ?? err?.code ?? "SFP_CANDIDATE_PREVIEW_FAILED",
        cause: err?.cause?.message?.slice(0, 300),
      });
      res.status(notFound ? 404 : 500).json({
        error: notFound ? "SFP_PROGRAM_NOT_FOUND" : "SFP_CANDIDATE_PREVIEW_FAILED",
        message: notFound ? "Program not found." : "Could not load candidates. The server recorded diagnostic details; no classification or provider call was run.",
      });
    }
  });

  // POST /api/lead-ops/sfp/classification/snapshot/:snapshotId/run — bounded
  // frozen-snapshot execution, phase 2: one-time claim + per-business recheck
  // + classification against exactly the surviving frozen businesses.
  app.post("/api/lead-ops/sfp/classification/snapshot/:snapshotId/run", requireRole("admin"), async (req, res) => {
    try {
      const { runFrozenClassificationSnapshot } = await import("../services/cro03/sfp-classification-bridge");
      const result = await runFrozenClassificationSnapshot({
        snapshotId: String(req.params.snapshotId), actorId: `admin:${(req as any).user?.id ?? "system"}`,
      });
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("EXPIRED") || err?.message?.includes("ALREADY_CLAIMED") ? 409 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/classification/evidence/non-attempts — diagnostic
  // read of evidence rows recorded terminal_state='completed' even when the
  // OpenAI escalation was never actually attempted (transport disabled,
  // credential missing, or the paid-budget authorization gate not yet
  // granted), reason_codes carrying OPENAI_UNAVAILABLE/
  // OPENAI_ESCALATION_NOT_CONFIGURED. sfp_classification_evidence is
  // insert-only -- a DB trigger rejects any UPDATE/DELETE on it -- so these
  // historical rows can never be repaired in place; there is no mutating
  // counterpart to this route. The cache lookup in
  // runFrozenClassificationSnapshot() already excludes rows matching this
  // exact shape from being treated as a valid cache hit, so a later run for
  // the same business/evidence_hash retries for real and inserts a fresh,
  // correctly-terminal-stated row -- this endpoint exists only to see how
  // many legacy rows still carry the stale shape.
  app.get("/api/lead-ops/sfp/classification/evidence/non-attempts", requireRole("admin"), async (req, res) => {
    try {
      const found = rows(await db.execute(sql`
        SELECT id, business_id FROM sfp_classification_evidence
         WHERE terminal_state='completed'
           AND (reason_codes @> '["OPENAI_UNAVAILABLE"]'::jsonb
                OR reason_codes @> '["OPENAI_ESCALATION_NOT_CONFIGURED"]'::jsonb)
      `));
      res.json({ count: found.length, businessIds: found.map((r: any) => Number(r.business_id)) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/classification/provider-operations/clear-failed —
  // one-time remediation for a confirmed code bug (fixed): a shared OpenAI
  // transport helper hardcoded server-side output re-validation to the
  // CRO03C {category,confidence,summary} shape regardless of the schema a
  // caller actually requested, so every SFP {outcome,confidence,reasonCodes}
  // completion -- even a real, correctly-shaped one -- was rejected as
  // invalid_output and settled the reservation as 'failed'. Because the
  // reservation idempotency key is deterministic (businessId + sha256(prompt)),
  // those stale 'failed' rows permanently block any retry with the same
  // input, even after the validator bug is fixed in code. Several tables
  // reference provider_operations.id with onDelete:'restrict', so a DELETE
  // is unsafe here even for a row with no known referencing children -- we
  // UPDATE instead: append a '#superseded:<timestamp>' suffix to the stored
  // idempotency_key of the stale failed row so it no longer collides with a
  // fresh reservation attempt using the original key, and stamp failure_code
  // for traceability. The row itself is preserved intact for audit. No
  // refund/ledger change is needed: a 'failed' reservation already released
  // its hold back to provider_controls at settlement time, and no cost was
  // ever settled. Scoped to explicit businessIds, provider='openai', purpose
  // ='sfp_precohort_vertical_classification', state='failed' only.
  app.post("/api/lead-ops/sfp/classification/provider-operations/clear-failed", requireRole("admin"), async (req, res) => {
    try {
      const businessIds = Array.isArray(req.body?.businessIds)
        ? req.body.businessIds.map(Number).filter((n: number) => Number.isInteger(n)) : [];
      if (businessIds.length === 0 || businessIds.length > 25) {
        return res.status(400).json({ error: "businessIds must be a non-empty array of at most 25 integers" });
      }
      const fingerprints = businessIds.map((id: number) => `business:${id}`);
      const updated = rows(await db.execute(sql`
        UPDATE provider_operations
           SET idempotency_key = idempotency_key || '#superseded:' || extract(epoch from now())::text,
               failure_code = coalesce(failure_code, '') || ' [cleared_for_retry_after_validator_fix]',
               updated_at = now()
         WHERE provider='openai' AND purpose='sfp_precohort_vertical_classification'
           AND state='failed' AND billing_state='released'
           AND target_fingerprint = ANY(ARRAY[${sql.join(fingerprints.map((f: string) => sql`${f}`), sql`,`)}]::text[])
        RETURNING id, target_fingerprint
      `));
      res.json({ clearedCount: updated.length, targetFingerprints: updated.map((r: any) => r.target_fingerprint) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/lead-ops/sfp/runs/:runId/paid-waterfall/person-identity — Apollo/Outscraper waterfall (bounded, manual)
  // Body: { idempotencyKey, maxBusinesses? }
  app.post("/api/lead-ops/sfp/runs/:runId/paid-waterfall/person-identity", requireRole("admin"), async (req, res) => {
    try {
      const idempotencyKey = String(req.body?.idempotencyKey ?? "");
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return res.status(400).json({ error: "idempotencyKey is required (max 200 chars)" });
      }
      const maxBusinesses = req.body?.maxBusinesses == null ? 10 : Number(req.body.maxBusinesses);
      if (!Number.isInteger(maxBusinesses) || maxBusinesses < 1 || maxBusinesses > 25) {
        return res.status(400).json({ error: "maxBusinesses must be an integer between 1 and 25" });
      }
      const { executeSfpPaidPersonAndIdentityDiscovery } = await import("../services/cro03/sfp-paid-waterfall");
      const { buildSfpCohortCostPreview } = await import("../services/cro03/sfp-cost-preview");
      const preview = await buildSfpCohortCostPreview(String(req.params.runId));
      const result = await executeSfpPaidPersonAndIdentityDiscovery({
        cohortRunId: String(req.params.runId), idempotencyKey,
        actorId: `admin:${(req as any).user?.id ?? "system"}`, maxBusinesses,
        previewSnapshotHash: String(req.body?.previewSnapshotHash ?? preview.snapshotHash),
      });
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.includes("BLOCKED") ? 422 : err?.message?.includes("NOT_FOUND") ? 404
        : err?.message?.includes("PREVIEW") || err?.message?.includes("STALE") || err?.message?.includes("MISMATCH") ? 409 : 500;
      res.status(status).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId/candidates — unified free+paid candidate read contract (Task #2000 consumer)
  app.get("/api/lead-ops/sfp/runs/:runId/candidates", requireRole("admin"), async (req, res) => {
    try {
      const memberResult: any = await db.execute(sql`
        SELECT business_id FROM sfp_cohort_members WHERE cohort_run_id=${String(req.params.runId)}::uuid
      `);
      const memberRows: any[] = (memberResult as any).rows ?? memberResult;
      const businessIds = memberRows.map((m: any) => Number(m.business_id));
      const { getUnifiedSfpCandidates } = await import("../services/cro03/sfp-paid-evidence-writer");
      res.json({ businessCount: businessIds.length, candidates: await getUnifiedSfpCandidates(businessIds) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId/cost-preview — billing-semantic cost preview across all four providers
  app.get("/api/lead-ops/sfp/runs/:runId/cost-preview", requireRole("admin"), async (req, res) => {
    try {
      const { buildSfpCohortCostPreview } = await import("../services/cro03/sfp-cost-preview");
      res.json(await buildSfpCohortCostPreview(String(req.params.runId)));
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId/gap-vector/:businessId — typed, subject-aware evidence gap vector for one business
  // Returns the full C6 five-dimension vector (geography, target vertical,
  // official domain, business contact channel, named decision-maker), not
  // just contact-link reuse — reuse is one input among several, not the
  // whole gap vector.
  app.get("/api/lead-ops/sfp/runs/:runId/gap-vector/:businessId", requireRole("admin"), async (req, res) => {
    try {
      const runId = String(req.params.runId);
      const businessId = Number(req.params.businessId);
      if (!Number.isInteger(businessId)) return res.status(400).json({ error: "businessId must be an integer" });
      const { db } = await import("../db");
      const { sql } = await import("drizzle-orm");
      const {
        computeContactLinkReuse, computeSfpGapVector, stopConditionsMet,
      } = await import("../services/cro03/sfp-contact-gap-vector");
      const { getLatestAdmissibleClassificationEvidence } = await import("../services/cro03/sfp-classification-bridge");

      const decisionRow = (
        (await db.execute(sql`
          SELECT d.suppression_subjects, d.suppression_business_wide_rule_applied, d.classifier_outcome
            FROM sfp_cohort_decisions d
           WHERE d.cohort_run_id=${runId}::uuid AND d.business_id=${businessId}
           LIMIT 1
        `)) as any
      ).rows?.[0] ?? null;
      if (!decisionRow) {
        return res.status(404).json({ error: "SFP_COHORT_DECISION_NOT_FOUND: no decision row for this run/business" });
      }
      const businessRow = (
        (await db.execute(sql`SELECT website_domain FROM businesses WHERE id=${businessId} LIMIT 1`)) as any
      ).rows?.[0] ?? null;
      const officialDomainKnown = Boolean(businessRow?.website_domain);

      const admissible = await getLatestAdmissibleClassificationEvidence(businessId, 1).catch(() => null);
      const targetVerticalResolved = admissible
        ? admissible.outcome === "target"
        : decisionRow.classifier_outcome === "resolved_high" || decisionRow.classifier_outcome === "resolved_medium";

      const freeCandidateRow = (
        (await db.execute(sql`
          SELECT 1 FROM free_discovery_candidates
           WHERE business_id=${businessId} AND disposition IN ('staged','validation_admitted') LIMIT 1
        `)) as any
      ).rows?.[0] ?? null;

      const reuse = await computeContactLinkReuse([businessId]);
      const linkReuse = reuse.get(businessId) ?? {
        hasVerifiedContact: false, hasVerifiedNamedDecisionMaker: false, verifiedLinks: [], skipReason: null,
      };

      const subjectSuppressionsRaw: any[] = Array.isArray(decisionRow.suppression_subjects)
        ? decisionRow.suppression_subjects
        : (typeof decisionRow.suppression_subjects === "string" && decisionRow.suppression_subjects.length > 0
          ? JSON.parse(decisionRow.suppression_subjects) : []);
      const subjectSuppressions = subjectSuppressionsRaw.map((s: any) => ({
        subjectHash: String(s.subjectHash ?? ""), authority: String(s.authority ?? ""),
        reasonCode: String(s.reasonCode ?? ""), channel: String(s.channel ?? "all"),
        scope: (s.scope === "email" || s.scope === "contact" ? s.scope : "contact") as "contact" | "email" | "business",
      }));

      const vector = await computeSfpGapVector({
        businessId, targetVerticalResolved, officialDomainKnown,
        hasFreeDiscoveryContactCandidate: Boolean(freeCandidateRow),
        verifiedLinkReuse: {
          hasVerifiedContact: linkReuse.hasVerifiedContact,
          hasVerifiedNamedDecisionMaker: linkReuse.hasVerifiedNamedDecisionMaker,
        },
        subjectSuppressions,
        businessWideSuppressionApplied: Boolean(decisionRow.suppression_business_wide_rule_applied),
        apolloSkipReason: linkReuse.skipReason,
        outscraperSkipReason: officialDomainKnown ? "official_domain_already_known" : null,
      });
      res.json({ ...vector, ...stopConditionsMet(vector), reuse: linkReuse });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId/validation-preview — ZeroBounce preview (read-only)
  app.get("/api/lead-ops/sfp/runs/:runId/validation-preview", requireRole("admin"), async (req, res) => {
    try {
      const { previewSfpValidation } = await import("../services/cro03/sfp-validation");
      const preview = await previewSfpValidation(String(req.params.runId), {
        selectedContactIds: parseSelectedContactIds(req.query.selectedContactIds),
      });
      res.json(preview);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const status = message.includes("SELECTED_CONTACT_IDS_INVALID") ? 400
        : message.includes("SELECTED_CONTACT_SCOPE") || message.includes("NOT_COHORT_MEMBER") ||
            message.includes("FROZEN_LINK_DRIFT") ? 409
        : message.includes("SELECTED_CONTACT") ? 422
        : message.includes("NOT_FOUND") ? 404
        : message.includes("NOT_FROZEN") ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  // POST /api/lead-ops/sfp/runs/:runId/validate — execute bounded validation
  // Body: { idempotencyKey: string, maxValidations?: number }
  app.post("/api/lead-ops/sfp/runs/:runId/validate", requireRole("admin"), async (req, res) => {
    try {
      const { executeSfpValidation } = await import("../services/cro03/sfp-validation");
      const idempotencyKey = String(req.body?.idempotencyKey ?? "");
      if (!idempotencyKey) {
        return res.status(400).json({ error: "idempotencyKey is required" });
      }
      const snapshotHash = String(req.body?.snapshotHash ?? "");
      if (!snapshotHash) {
        return res.status(400).json({ error: "snapshotHash is required — call the validation-preview endpoint first and pass its snapshotHash" });
      }
      const maxValidations = req.body?.maxValidations == null ? 25 : Number(req.body.maxValidations);
      if (!Number.isInteger(maxValidations) || maxValidations < 1 || maxValidations > 25) {
        return res.status(400).json({ error: "maxValidations must be an integer between 1 and 25" });
      }
      const result = await executeSfpValidation(String(req.params.runId), {
        idempotencyKey,
        snapshotHash,
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
        maxValidations,
        selectedContactIds: parseSelectedContactIds(req.body?.selectedContactIds),
      });
      res.json(result);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const status = message.includes("SELECTED_CONTACT_IDS_INVALID") ? 400
        : message.includes("SNAPSHOT_MISMATCH") || message.includes("IDEMPOTENCY_CONFLICT") ||
            message.includes("SELECTED_CONTACT_SCOPE") || message.includes("NOT_COHORT_MEMBER") ||
            message.includes("FROZEN_LINK_DRIFT") ? 409
        : message.includes("BLOCKED") || message.includes("SELECTED_CONTACT") ? 422
        : message.includes("NOT_FOUND") ? 404
        : message.includes("NOT_FROZEN") ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId/prospects — validated outreach prospects with filters
  app.get("/api/lead-ops/sfp/runs/:runId/prospects", requireRole("admin"), async (req, res) => {
    try {
      const { getValidatedProspects } = await import("../services/cro03/south-florida-prospecting");
      const result = await getValidatedProspects({
        cohortRunId: String(req.params.runId),
        filters: {
          county: req.query.county ? String(req.query.county) : undefined,
          vertical: req.query.vertical ? String(req.query.vertical) : undefined,
          namedContact: req.query.namedContact === "true" ? true : req.query.namedContact === "false" ? false : undefined,
          roleInbox: req.query.roleInbox === "true" ? true : undefined,
          status: req.query.status as any,
          outreachEligible: req.query.outreachEligible === "true",
          reviewRequired: req.query.reviewRequired === "true",
        },
        limit: req.query.limit ? Number(req.query.limit) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/runs/:runId/campaign-staging-preview — preview campaign staging
  app.get("/api/lead-ops/sfp/runs/:runId/campaign-staging-preview", requireRole("admin"), async (req, res) => {
    try {
      const { previewCampaignStaging } = await import("../services/cro03/south-florida-prospecting");
      const preview = await previewCampaignStaging(String(req.params.runId));
      res.json(preview);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // Named person addresses that received a real, fresh ZeroBounce-valid
  // receipt remain policy-held until an independent admin records this
  // separate eligibility decision. This is not held-intent review or send
  // authorization; staging remains ready_held only.
  app.get("/api/lead-ops/sfp/named-email-eligibility-reviews", requireRole("admin"), async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const result = rows(await db.execute(sql`
        SELECT e.id AS eligibility_id, e.cohort_run_id, e.business_id, b.canonical_name AS business_name,
               e.source_kind, e.contact_id, e.masked_email, e.status, e.decision_reason,
               review_contact.email AS contact_email, review_contact.first_name AS contact_first_name,
               review_contact.last_name AS contact_last_name, b.website_domain AS business_website,
               e.zb_outcome, e.validation_at, e.validation_expires_at,
               e.validation_operation_id, e.reused_from_operation_id, e.updated_at::text AS updated_at,
               e.contact_business_link_decision_id, e.contact_business_link_revision,
               e.policy_document_id, e.policy_document_hash,
               latest.id AS latest_review_id, latest.decision AS latest_review_decision,
               latest.reviewer_id AS latest_reviewer_id, latest.reason AS latest_reason,
               latest.created_at AS latest_reviewed_at
          FROM sfp_outreach_eligibility e
          JOIN businesses b ON b.id=e.business_id
          LEFT JOIN contacts review_contact ON review_contact.id=e.contact_id AND e.source_kind='contact'
          JOIN sfp_outreach_policy_control pc ON pc.singleton=TRUE
          JOIN sfp_outreach_policy_documents p ON p.id=pc.active_policy_id
          LEFT JOIN LATERAL (
            SELECT r.id, r.decision, r.reviewer_id, r.reason, r.created_at
              FROM sfp_named_email_eligibility_reviews r
             WHERE r.eligibility_id=e.id AND r.expected_updated_at=e.updated_at
               AND r.policy_document_id=p.id AND r.policy_document_hash=p.document_hash
             ORDER BY r.created_at DESC,r.id DESC LIMIT 1
          ) latest ON TRUE
         WHERE e.status='validated_review_required' AND e.named_contact=TRUE
           AND e.zb_outcome='valid'
           AND e.suppression_status='not_suppressed'
           AND p.role_inbox_policy->>'named_or_unclassified_requires_review' <> 'false'
           AND e.validation_expires_at > NOW()
           AND e.policy_document_id=p.id AND e.policy_document_hash=p.document_hash
           AND e.updated_at > NOW() - INTERVAL '90 days'
           AND NOT EXISTS (
             SELECT 1 FROM sfp_named_email_eligibility_reviews prior
              WHERE prior.eligibility_id=e.id AND prior.expected_updated_at=e.updated_at
                AND prior.policy_document_id=p.id AND prior.policy_document_hash=p.document_hash
           )
           AND EXISTS (
             SELECT 1 FROM provider_observations po
              WHERE po.operation_id=COALESCE(e.validation_operation_id,e.reused_from_operation_id)
                AND po.subject_type='business' AND po.subject_id=e.business_id
                AND po.provider='zerobounce' AND po.outcome='valid'
           )
           AND (e.source_kind <> 'contact' OR EXISTS (
             SELECT 1 FROM contacts c
             JOIN contact_business_link_decisions d ON d.contact_id=c.id
              WHERE c.id=e.contact_id AND c.business_id=e.business_id AND c.archived_at IS NULL
                AND d.id=e.contact_business_link_decision_id AND d.revision=e.contact_business_link_revision
                AND d.business_id=e.business_id AND d.decision='verified' AND d.superseded_at IS NULL
                AND (
                  (e.normalized_value_hash_version=0 AND c.email_token_hash=e.normalized_value_hash)
                  OR (e.normalized_value_hash_version=1 AND c.email IS NOT NULL
                    AND encode(sha256(
                      convert_to('email','UTF8') || decode('00','hex') ||
                      convert_to(lower(btrim(c.email)),'UTF8')
                    ),'hex')=e.normalized_value_hash)
                )
           ))
           AND NOT EXISTS (
             SELECT 1 FROM sfp_outreach_eligibility newer
              WHERE newer.business_id=e.business_id
                AND newer.normalized_value_hash=e.normalized_value_hash
                AND newer.normalized_value_hash_version IS NOT DISTINCT FROM e.normalized_value_hash_version
                AND newer.contact_id IS NOT DISTINCT FROM e.contact_id
                AND newer.policy_document_hash IS NOT DISTINCT FROM e.policy_document_hash
                AND (newer.updated_at,newer.created_at,newer.id)>(e.updated_at,e.created_at,e.id)
           )
         ORDER BY e.validation_at DESC, e.id
         LIMIT ${limit} OFFSET ${offset}
      `));
      res.json({ reviews: result, limit, offset });
    } catch (err: any) {
      res.status(503).json({ error: "SFP_NAMED_EMAIL_REVIEW_LIST_UNAVAILABLE", reason: String(err?.code ?? "query_failed") });
    }
  });

  app.post("/api/lead-ops/sfp/named-email-eligibility-reviews/:eligibilityId", requireRole("admin"), async (req, res) => {
    const id = String(req.params.eligibilityId);
    const decision = req.body?.decision;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
    const expectedUpdatedAt = typeof req.body?.expectedUpdatedAt === "string" ? req.body.expectedUpdatedAt : "";
    if (!["approved", "rejected"].includes(decision) || reason.length < 8 || reason.length > 2000 ||
        !idempotencyKey || idempotencyKey.length > 200 || !expectedUpdatedAt) {
      return res.status(400).json({ error: "decision, reason (8-2000 chars), idempotencyKey, and expectedUpdatedAt are required" });
    }
    const reviewerId = `admin:${(req as any).user?.id ?? ""}`;
    if (reviewerId === "admin:") return res.status(401).json({ error: "Authenticated reviewer identity required" });
    try {
      const { getActiveSfpOutreachPolicy, isCanonicallySuppressed } = await import("../services/cro03/sfp-outreach-policy");
      const policy = await getActiveSfpOutreachPolicy({ bypassCache: true });
      const review = await db.transaction(async (tx) => {
        const replay = rows(await tx.execute(sql`
          SELECT r.*, r.expected_updated_at = ${expectedUpdatedAt}::timestamptz AS expected_updated_at_matches
            FROM sfp_named_email_eligibility_reviews r
           WHERE r.idempotency_key=${idempotencyKey} LIMIT 1
        `))[0];
        if (replay) {
          if (String(replay.eligibility_id) !== id || replay.reviewer_id !== reviewerId ||
              replay.decision !== decision || replay.reason !== reason ||
              replay.expected_updated_at_matches !== true) {
            throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { status: 409 });
          }
          return replay;
        }
        const lockedPolicy = rows(await tx.execute(sql`
          SELECT d.id,d.document_hash
            FROM sfp_outreach_policy_control pc
            JOIN sfp_outreach_policy_documents d ON d.id=pc.active_policy_id
           WHERE pc.singleton=TRUE
           FOR UPDATE OF pc,d
        `))[0];
        if (!lockedPolicy || String(lockedPolicy.id) !== String(policy.id)
            || String(lockedPolicy.document_hash) !== String(policy.documentHash)) {
          throw Object.assign(new Error("OUTREACH_POLICY_CHANGED"), { status: 409 });
        }
        const current = rows(await tx.execute(sql`
          SELECT e.*,
                 e.updated_at = ${expectedUpdatedAt}::timestamptz AS expected_updated_at_matches,
                 p.id AS active_policy_id, p.document_hash AS active_policy_hash,
                 p.role_inbox_policy->>'named_or_unclassified_requires_review' AS named_requires_review,
                 COALESCE(e.validation_operation_id,e.reused_from_operation_id) AS receipt_operation_id,
                 op.actor_id AS validation_actor_id, c.email AS source_contact_email,
                 c.email_token_hash AS source_contact_token_hash,
                 link.id AS current_link_id, link.revision AS current_link_revision,
                 link.email_token_hash AS current_link_token_hash
            FROM sfp_outreach_eligibility e
            JOIN businesses b ON b.id=e.business_id
            JOIN sfp_outreach_policy_control pc ON pc.singleton=TRUE
            JOIN sfp_outreach_policy_documents p ON p.id=pc.active_policy_id
            LEFT JOIN provider_operations op ON op.id=COALESCE(e.validation_operation_id,e.reused_from_operation_id)
            LEFT JOIN contacts c ON c.id=e.contact_id
            LEFT JOIN LATERAL (
              SELECT d.id,d.revision,c2.email_token_hash
                FROM contact_business_link_decisions d JOIN contacts c2 ON c2.id=d.contact_id
               WHERE d.contact_id=e.contact_id AND d.business_id=e.business_id
                 AND d.decision='verified' AND d.superseded_at IS NULL
                 AND c2.business_id=e.business_id AND c2.archived_at IS NULL
               ORDER BY d.revision DESC LIMIT 1
            ) link ON e.source_kind='contact'
           WHERE e.id=${id}::uuid FOR UPDATE OF e
        `))[0];
        if (!current) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
        const replayAfterLock = rows(await tx.execute(sql`
          SELECT r.*, r.expected_updated_at = ${expectedUpdatedAt}::timestamptz AS expected_updated_at_matches
            FROM sfp_named_email_eligibility_reviews r
           WHERE r.idempotency_key=${idempotencyKey} LIMIT 1
        `))[0];
        if (replayAfterLock) {
          if (String(replayAfterLock.eligibility_id) !== id || replayAfterLock.reviewer_id !== reviewerId ||
              replayAfterLock.decision !== decision || replayAfterLock.reason !== reason ||
              replayAfterLock.expected_updated_at_matches !== true) {
            throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { status: 409 });
          }
          return replayAfterLock;
        }
        if (current.status !== "validated_review_required" || current.named_contact !== true ||
            current.zb_outcome !== "valid" ||
            current.suppression_status !== "not_suppressed" ||
            current.named_requires_review === "false" ||
            String(current.active_policy_id) !== String(policy.id) ||
            current.active_policy_hash !== policy.documentHash ||
            current.expected_updated_at_matches !== true ||
            !current.validation_expires_at || new Date(String(current.validation_expires_at)).getTime() <= Date.now() ||
            !current.receipt_operation_id) {
          throw Object.assign(new Error("ELIGIBILITY_OR_POLICY_CAS_FAILED"), { status: 409 });
        }
        if (!["free", "paid", "contact"].includes(String(current.source_kind)) ||
            !current.normalized_value_hash || ![0, 1].includes(Number(current.normalized_value_hash_version)) ||
            (current.source_kind === "free" && !current.candidate_id) ||
            (current.source_kind === "paid" && !current.paid_candidate_evidence_id) ||
            (current.source_kind === "contact" && !current.contact_id)) {
          throw Object.assign(new Error("TYPED_SOURCE_OR_EMAIL_PIN_REQUIRED"), { status: 409 });
        }
        if (!current.validation_actor_id || String(current.validation_actor_id) === reviewerId) {
          throw Object.assign(new Error("REVIEWER_MUST_BE_INDEPENDENT"), { status: 409 });
        }
        if (await isCanonicallySuppressed([String(current.normalized_value_hash)], tx)) {
          throw Object.assign(new Error("EMAIL_SUPPRESSED"), { status: 409 });
        }
        const receipt = rows(await tx.execute(sql`
          SELECT 1 FROM provider_observations
           WHERE operation_id=${current.receipt_operation_id}::uuid
             AND subject_type='business' AND subject_id=${current.business_id}
             AND provider='zerobounce' AND outcome='valid' LIMIT 1
        `))[0];
        if (!receipt) throw Object.assign(new Error("VALID_ZEROBOUNCE_RECEIPT_REQUIRED"), { status: 409 });
        if (current.source_kind === "contact") {
          const normalized = current.normalized_value_hash_version === 0
            ? current.source_contact_token_hash
            : current.source_contact_email
              ? (await import("node:crypto")).createHash("sha256").update(`email\u0000${String(current.source_contact_email).trim().toLowerCase()}`).digest("hex")
              : null;
          if (!current.contact_id || !current.current_link_id ||
              String(current.current_link_id) !== String(current.contact_business_link_decision_id) ||
              Number(current.current_link_revision) !== Number(current.contact_business_link_revision) ||
              String(current.current_link_token_hash ?? "") !== String(current.source_contact_token_hash ?? "") ||
              normalized !== String(current.normalized_value_hash ?? "")) {
            throw Object.assign(new Error("CONTACT_IDENTITY_OR_LINK_STALE"), { status: 409 });
          }
          if (current.source_contact_token_hash &&
              await isCanonicallySuppressed([String(current.source_contact_token_hash)], tx)) {
            throw Object.assign(new Error("EMAIL_SUPPRESSED"), { status: 409 });
          }
        }
        const inserted = rows(await tx.execute(sql`
          INSERT INTO sfp_named_email_eligibility_reviews
            (eligibility_id,decision,reviewer_id,reason,idempotency_key,expected_updated_at,
             policy_document_id,policy_document_hash,validation_operation_id,source_kind,source_reference_id,
             contact_business_link_decision_id,contact_business_link_revision,normalized_value_hash,
             normalized_value_hash_version,validation_expires_at)
          SELECT e.id,${decision},${reviewerId},${reason},${idempotencyKey},e.updated_at,
             ${policy.id}::uuid,${policy.documentHash},${current.receipt_operation_id}::uuid,${current.source_kind},
             CASE ${current.source_kind} WHEN 'free' THEN ${current.candidate_id}::text
                  WHEN 'paid' THEN ${current.paid_candidate_evidence_id}::text ELSE ${current.contact_id}::text END,
             ${current.contact_business_link_decision_id}::uuid,${current.contact_business_link_revision}::int,
             ${current.normalized_value_hash},${current.normalized_value_hash_version}::int,${current.validation_expires_at}::timestamptz
            FROM sfp_outreach_eligibility e
           WHERE e.id=${id}::uuid AND e.updated_at=${expectedUpdatedAt}::timestamptz
          RETURNING id,eligibility_id,decision,reviewer_id,reason,created_at
        `))[0];
        if (!inserted) throw Object.assign(new Error("ELIGIBILITY_OR_POLICY_CAS_FAILED"), { status: 409 });
        return inserted;
      });
      await storage.createAuditLog({
        action: "sfp_named_email_eligibility_reviewed",
        entityType: "sfp_outreach_eligibility",
        entityId: 0,
        userId: (req.user as any)?.id ?? null,
        details: { decision, reason, idempotencyKey, reviewId: review.id },
      });
      res.json({ review });
    } catch (err: any) {
      const status = Number(err?.status) || (err?.code === "23505" || String(err?.message).includes("IDEMPOTENCY") ? 409 : 500);
      res.status(status).json({ error: String(err?.message ?? "review_failed") });
    }
  });

  // Snapshot-bound campaign staging preview; selection is always explicit.
  app.post("/api/lead-ops/sfp/campaign-staging-v2/preview", requireRole("admin"), async (req, res) => {
    try {
      const { previewStagingV2, SfpStagingV2Error } = await import("../services/cro03/sfp-campaign-staging-v2");
      const result = await previewStagingV2({
        cohortRunId: String(req.body?.cohortRunId ?? ""),
        eligibilityIds: Array.isArray(req.body?.eligibilityIds) ? req.body.eligibilityIds.map(String) : [],
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
      });
      res.json(result);
    } catch (err: any) {
      if (err instanceof (await import("../services/cro03/sfp-campaign-staging-v2")).SfpStagingV2Error) {
        return res.status(err.httpStatus).json({ code: err.code, message: err.message });
      }
      res.status(400).json({ code: "SFP_STAGING_PREVIEW_ERROR", message: "Unable to create staging preview" });
    }
  });

  // Execute only the exact selection and snapshot returned by preview.
  app.post("/api/lead-ops/sfp/campaign-staging-v2/execute", requireRole("admin"), async (req, res) => {
    try {
      const { executeStagingV2, SfpStagingV2Error } = await import("../services/cro03/sfp-campaign-staging-v2");
      const result = await executeStagingV2({
        cohortRunId: String(req.body?.cohortRunId ?? ""),
        eligibilityIds: Array.isArray(req.body?.eligibilityIds) ? req.body.eligibilityIds.map(String) : [],
        commandKey: String(req.body?.commandKey ?? ""),
        snapshotHash: String(req.body?.snapshotHash ?? ""),
        actorId: `admin:${(req as any).user?.id ?? "system"}`,
        // PM-12: the operator/UI must echo back the exact payloadHash the
        // preview reported, proving the confirmation is against that
        // preview's row-level detail, not just a stale ID list.
        confirmPayloadHash: String(req.body?.confirmPayloadHash ?? ""),
      });
      res.json(result);
    } catch (err: any) {
      if (err instanceof (await import("../services/cro03/sfp-campaign-staging-v2")).SfpStagingV2Error) {
        return res.status(err.httpStatus).json({ code: err.code, message: err.message });
      }
      const status = [400, 409, 422].includes(Number(err?.httpStatus ?? err?.status)) ? Number(err.httpStatus ?? err.status) : 400;
      res.status(status).json({ code: "SFP_STAGING_EXECUTION_ERROR", message: "Unable to execute staging command" });
    }
  });

  // Read-only configuration convergence preview; admin only.
  app.get("/api/lead-ops/sfp/campaign-packages/preview", requireRole("admin"), async (_req, res) => {
    try {
      const { previewPackageConvergence } = await import("../services/cro03/sfp-campaign-packages");
      res.json(await previewPackageConvergence());
    } catch (err: any) {
      res.status(400).json({ code: "SFP_PACKAGE_PREVIEW_ERROR", message: err?.message ?? "Unable to preview package mappings" });
    }
  });

  app.post("/api/lead-ops/sfp/campaign-packages/apply", requireRole("admin"), async (req, res) => {
    try {
      const { applyPackageConvergence } = await import("../services/cro03/sfp-campaign-packages");
      res.json(await applyPackageConvergence({ actorId: `admin:${(req as any).user?.id ?? "system"}` }));
    } catch (err: any) {
      res.status(400).json({ code: "SFP_PACKAGE_APPLY_ERROR", message: err?.message ?? "Unable to apply package mappings" });
    }
  });

  app.get("/api/lead-ops/sfp/campaign-packages/verify", requireRole("admin"), async (_req, res) => {
    try {
      const { verifyPackageConvergence } = await import("../services/cro03/sfp-campaign-packages");
      res.json(await verifyPackageConvergence());
    } catch (err: any) {
      res.status(400).json({ code: "SFP_PACKAGE_VERIFY_ERROR", message: err?.message ?? "Unable to verify package mappings" });
    }
  });

  // South Florida v2 taxonomy packages (Automotive, Healthcare, Beauty/Spa,
  // Construction/Trades/Home Services, Fitness/Recreation). Always creates
  // brand-new placeholder draft campaigns/paused sequences -- never narrows
  // or reuses a v1/legacy campaign. See sfp-campaign-packages.ts for why.
  app.get("/api/lead-ops/sfp/campaign-packages-v2/preview", requireRole("admin"), async (_req, res) => {
    try {
      const { previewPackageConvergenceV2 } = await import("../services/cro03/sfp-campaign-packages");
      res.json(await previewPackageConvergenceV2());
    } catch (err: any) {
      res.status(400).json({ code: "SFP_PACKAGE_V2_PREVIEW_ERROR", message: err?.message ?? "Unable to preview v2 package mappings" });
    }
  });

  app.post("/api/lead-ops/sfp/campaign-packages-v2/apply", requireRole("admin"), async (req, res) => {
    try {
      const { applyPackageConvergenceV2 } = await import("../services/cro03/sfp-campaign-packages");
      res.json(await applyPackageConvergenceV2({ actorId: `admin:${(req as any).user?.id ?? "system"}` }));
    } catch (err: any) {
      res.status(400).json({ code: "SFP_PACKAGE_V2_APPLY_ERROR", message: err?.message ?? "Unable to apply v2 package mappings" });
    }
  });

  app.get("/api/lead-ops/sfp/campaign-packages-v2/verify", requireRole("admin"), async (_req, res) => {
    try {
      const { verifyPackageConvergenceV2 } = await import("../services/cro03/sfp-campaign-packages");
      res.json(await verifyPackageConvergenceV2());
    } catch (err: any) {
      res.status(400).json({ code: "SFP_PACKAGE_V2_VERIFY_ERROR", message: err?.message ?? "Unable to verify v2 package mappings" });
    }
  });

  // The ready_held -> paused-enrollment bridge (Defect: staging intents have
  // no contact_id, but sequence_enrollments requires one). Resolves a
  // contact identity-safely and creates a PAUSED enrollment only -- never
  // dispatches, sends, or unpauses. Idempotent per staging intent.
  //
  // Contact creation, source/audit evidence, paused enrollment and bridge
  // ledger now share a single transaction. A failed later insert cannot
  // strand a contact; no unpause/send path is invoked by this route.
  app.post("/api/lead-ops/sfp/staging-intents/:intentId/bridge-to-paused-enrollment", requireRole("admin"), async (req, res) => {
    try {
      const { bridgeReadyHeldIntentAsOperator } = await import("../services/cro03/sfp-ready-held-consumer");
      const result = await bridgeReadyHeldIntentAsOperator(
        String(req.params.intentId), `admin:${(req as any).user?.id ?? "system"}`,
      );
      res.json(result);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      const status = message.includes("NOT_FOUND") ? 404
        : message.includes("NOT_READY_HELD") || message.includes("CONFLICT") || message.includes("NOT_PAUSED") || message.includes("BLOCKED") ? 409
        : 500;
      res.status(status).json({ code: "SFP_READY_HELD_BRIDGE_ERROR", message });
    }
  });

  // ── Held-record review controls (Liberty Bancard enrichment completion,
  // continuation — item 5). These endpoints let an admin record a
  // review decision (approve/reject) against a ready_held enrollment row.
  // They are review-metadata-only: they NEVER touch sequence_enrollments
  // status, NEVER stage or enable a campaign, NEVER call GHL, and NEVER
  // send. The enrollment stays exactly as bridgeReadyHeldIntentToPausedEnrollment
  // left it (status='paused') regardless of the review decision recorded
  // here. Any future activation flow is a separate, explicitly-authorized
  // step outside the scope of this review surface.
  app.get("/api/lead-ops/sfp/ready-held-enrollments", requireRole("admin"), async (req, res) => {
    try {
      const statusFilter = typeof req.query.reviewStatus === "string" ? req.query.reviewStatus : null;
      const rowsResult = rows(await db.execute(sql`
        SELECT
          rhe.id, rhe.staging_intent_id, rhe.contact_id, rhe.sequence_enrollment_id,
          rhe.contact_resolution, rhe.actor_id, rhe.created_at,
          rhe.review_status, rhe.reviewed_by, rhe.reviewed_at, rhe.review_note,
          se.status AS enrollment_status, se.sequence_id,
          c.email AS contact_email, c.first_name, c.last_name, c.business_id
        FROM sfp_ready_held_enrollments rhe
        JOIN sequence_enrollments se ON se.id = rhe.sequence_enrollment_id
        JOIN contacts c ON c.id = rhe.contact_id
        WHERE ${statusFilter ? sql`rhe.review_status = ${statusFilter}` : sql`TRUE`}
        ORDER BY rhe.created_at DESC
        LIMIT 200
      `));
      res.json({ enrollments: rowsResult });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.post("/api/lead-ops/sfp/ready-held-enrollments/:id/review", requireRole("admin"), async (req, res) => {
    try {
      const id = String(req.params.id);
      const decision = String(req.body?.decision ?? "");
      const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 2000) : null;
      if (decision !== "approved" && decision !== "rejected") {
        return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
      }
      const actorId = `admin:${(req as any).user?.id ?? "system"}`;

      // Guard: the underlying enrollment must still be paused. If some other
      // process ever changed it, refuse the review write rather than silently
      // recording a decision against a row that no longer reflects reality.
      const current = rows(await db.execute(sql`
        SELECT rhe.review_status, se.status AS enrollment_status
        FROM sfp_ready_held_enrollments rhe
        JOIN sequence_enrollments se ON se.id = rhe.sequence_enrollment_id
        WHERE rhe.id = ${id}::uuid
        LIMIT 1
      `))[0];
      if (!current) return res.status(404).json({ error: "NOT_FOUND" });
      if (current.enrollment_status !== "paused") {
        return res.status(409).json({
          error: "ENROLLMENT_NOT_PAUSED",
          message: `Refusing to record a review decision: enrollment status is '${current.enrollment_status}', expected 'paused'.`,
        });
      }

      const updated = rows(await db.execute(sql`
        UPDATE sfp_ready_held_enrollments
        SET review_status = ${decision}, reviewed_by = ${actorId}, reviewed_at = NOW(), review_note = ${note}
        WHERE id = ${id}::uuid
        RETURNING id, review_status, reviewed_by, reviewed_at, review_note
      `))[0];

      await storage.createAuditLog({
        action: "sfp_ready_held_enrollment_reviewed",
        entityType: "sfp_ready_held_enrollment",
        userId: (req.user as any)?.id ?? null,
        details: { id, decision, note, previousReviewStatus: current.review_status },
      });

      res.json({ enrollment: updated });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/lead-ops/sfp/campaign-staging/telemetry — real read-only surface
  // for the isolated recurring campaign-staging worker (Defect 15). Never
  // starts or influences the worker; purely reports its current state.
  app.get("/api/lead-ops/sfp/campaign-staging/telemetry", requireRole("admin"), async (_req, res) => {
    try {
      const { getBackgroundProfile, getSelectiveGroups } = await import("../services/background-profile");
      const profile = getBackgroundProfile();
      const selectiveGroups = profile === "selective" ? getSelectiveGroups() : [];
      const capabilityActive = profile === "full" || (profile === "selective" && selectiveGroups.includes("sfp-campaign-staging"));

      const programRows = rows(await db.execute(sql`
        SELECT p.id, p.name, p.is_active, p.recurring_enabled,
               COALESCE((p.schedule_config->>'campaignStaging')::int, 0) AS campaign_staging_batch
          FROM sfp_programs p
         WHERE p.name = 'south-florida-v1'
         LIMIT 1
      `));
      const program = programRows[0] ?? null;
      const scheduleEnabled = !!program && program.is_active === true && program.recurring_enabled === true
        && Number(program.campaign_staging_batch) >= 1;

      const runRows = rows(await db.execute(sql`
        SELECT id, state, selected_count, processed_count, succeeded_count, failed_count,
               skipped_count, terminal_reason, claim_token, lease_expires_at,
               created_at, started_at, completed_at, last_heartbeat_at
          FROM sfp_stage_runs
         WHERE stage = 'campaign_staging'
         ORDER BY created_at DESC
         LIMIT 10
      `));
      const lastRun = runRows[0] ?? null;
      const lastCompletedRun = runRows.find((r: any) => r.state === "completed" || r.state === "failed") ?? null;
      const runningRun = runRows.find((r: any) => r.state === "running") ?? null;
      // Corrective-patch fix (issue 3): mirror the cancel route's exact
      // acceptance predicate — pending/authorized/stalled, OR a 'running'
      // run whose lease has already expired (no worker actively holds it).
      // An actively-leased running run must never be reported as
      // cancellable; the UI's "Cancel run" button relies on this to decide
      // whether to render at all.
      const cancellableRun = runRows.find((r: any) =>
        ["pending", "authorized", "stalled"].includes(String(r.state)) ||
        (r.state === "running" && r.lease_expires_at && new Date(String(r.lease_expires_at)).getTime() < Date.now())
      ) ?? null;

      const backlogRow = rows(await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE e.status = 'validated_outreach_eligible' AND e.staging_intent_id IS NULL)::int AS backlog_eligible,
          COUNT(*) FILTER (WHERE e.status = 'validated_outreach_eligible' AND e.staging_intent_id IS NULL
            AND (e.validation_expires_at IS NULL OR e.validation_expires_at > NOW()))::int AS backlog_fresh
          FROM sfp_outreach_eligibility e
      `))[0];

      const itemStats = rows(await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE i.state = 'retry')::int AS retrying,
          COUNT(*) FILTER (WHERE i.state = 'dead_letter')::int AS dead_letter,
          COUNT(*) FILTER (WHERE i.state = 'claimed' AND i.lease_expires_at < NOW())::int AS stale_leases,
          COUNT(*) FILTER (WHERE i.state = 'completed' AND i.completed_at > NOW() - INTERVAL '24 hours')::int AS completed_24h,
          COUNT(*) FILTER (WHERE i.state = 'dead_letter' AND i.completed_at > NOW() - INTERVAL '24 hours')::int AS dead_letter_24h
          FROM sfp_stage_items i
          JOIN sfp_stage_runs r ON r.id = i.stage_run_id
         WHERE r.stage = 'campaign_staging'
      `))[0];

      const deadLetterSample = rows(await db.execute(sql`
        SELECT i.id, i.business_id, i.outcome_code, i.attempt_count, i.completed_at
          FROM sfp_stage_items i
          JOIN sfp_stage_runs r ON r.id = i.stage_run_id
         WHERE r.stage = 'campaign_staging' AND i.state = 'dead_letter'
         ORDER BY i.completed_at DESC NULLS LAST
         LIMIT 10
      `));

      const readyHeldConsumerStats = rows(await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE state='pending')::int AS pending,
          COUNT(*) FILTER (WHERE state='claimed' AND lease_expires_at>NOW())::int AS claimed,
          COUNT(*) FILTER (WHERE state='claimed' AND (lease_expires_at IS NULL OR lease_expires_at<=NOW()))::int AS stale_claims,
          COUNT(*) FILTER (WHERE state='retry')::int AS retrying,
          COUNT(*) FILTER (WHERE state='held')::int AS held,
          COUNT(*) FILTER (WHERE state='completed')::int AS completed,
          COUNT(*) FILTER (WHERE state='dead_letter')::int AS dead_letter,
          MAX(updated_at) AS last_progress_at,
          COUNT(*) FILTER (WHERE state='completed' AND completed_at>NOW()-INTERVAL '24 hours')::int AS completed_24h
        FROM sfp_ready_held_consumer_items
      `))[0] ?? {};
      const readyHeldUnqueued = rows(await db.execute(sql`
        SELECT COUNT(*)::int AS count
          FROM sfp_campaign_staging_intents i
          JOIN sfp_cohort_runs c ON c.id=i.cohort_run_id
          JOIN sfp_programs p ON p.id=c.program_id
         WHERE p.name='south-florida-v1'
           AND c.cohort_state='frozen' AND c.voided_at IS NULL AND c.superseded_at IS NULL
           AND i.state='ready_held'
           AND NOT EXISTS (
             SELECT 1 FROM sfp_ready_held_consumer_items q WHERE q.staging_intent_id=i.id
           )
      `))[0];
      const readyHeldConsumerHolds = rows(await db.execute(sql`
        SELECT q.id, q.staging_intent_id, q.state, q.attempt_count, q.outcome_code, q.updated_at,
               i.business_id, i.package_key
          FROM sfp_ready_held_consumer_items q
          JOIN sfp_campaign_staging_intents i ON i.id=q.staging_intent_id
         WHERE q.state IN ('held','dead_letter')
         ORDER BY q.updated_at DESC, q.id
         LIMIT 10
      `));
      const [{ verifyPackageConvergenceV2 }, { getPauseState }] = await Promise.all([
        import("../services/cro03/sfp-campaign-packages"),
        import("../services/outbound-pause-authority"),
      ]);
      const [packageReadiness, outboundPause] = await Promise.all([
        verifyPackageConvergenceV2(),
        getPauseState(),
      ]);

      res.json({
        capability: {
          profile,
          selectiveGroups,
          active: capabilityActive,
        },
        program: program ? {
          name: String(program.name),
          isActive: program.is_active === true,
          recurringEnabled: program.recurring_enabled === true,
          campaignStagingBatchSize: Number(program.campaign_staging_batch),
        } : null,
        effectiveEnablement: capabilityActive && scheduleEnabled,
        outbound: {
          globalState: outboundPause.state,
          globalPaused: outboundPause.state === "paused",
          pauseEpoch: outboundPause.epoch.toString(),
          stateSource: outboundPause.source,
        },
        packageControls: packageReadiness,
        lastRun: lastRun ? {
          id: String(lastRun.id), state: String(lastRun.state),
          selected: Number(lastRun.selected_count), processed: Number(lastRun.processed_count),
          succeeded: Number(lastRun.succeeded_count), failed: Number(lastRun.failed_count),
          terminalReason: lastRun.terminal_reason ?? null,
          createdAt: lastRun.created_at, startedAt: lastRun.started_at, completedAt: lastRun.completed_at,
        } : null,
        lastCompletedRun: lastCompletedRun ? {
          id: String(lastCompletedRun.id), state: String(lastCompletedRun.state), completedAt: lastCompletedRun.completed_at,
        } : null,
        currentlyRunning: runningRun ? {
          id: String(runningRun.id), leaseExpiresAt: runningRun.lease_expires_at, lastHeartbeatAt: runningRun.last_heartbeat_at,
        } : null,
        cancellableRun: cancellableRun ? {
          id: String(cancellableRun.id), state: String(cancellableRun.state), leaseExpiresAt: cancellableRun.lease_expires_at,
        } : null,
        backlog: {
          eligibleAwaitingStaging: Number(backlogRow?.backlog_eligible ?? 0),
          freshAwaitingStaging: Number(backlogRow?.backlog_fresh ?? 0),
          meaning: "Eligibility readiness count; not a per-tick or hourly throughput promise.",
          configuredBatchSize: program ? Number(program.campaign_staging_batch) : 0,
        },
        readyHeldConsumer: {
          unqueuedReadyHeld: Number(readyHeldUnqueued?.count ?? 0),
          pending: Number(readyHeldConsumerStats.pending ?? 0),
          claimed: Number(readyHeldConsumerStats.claimed ?? 0),
          staleClaims: Number(readyHeldConsumerStats.stale_claims ?? 0),
          retrying: Number(readyHeldConsumerStats.retrying ?? 0),
          held: Number(readyHeldConsumerStats.held ?? 0),
          completed: Number(readyHeldConsumerStats.completed ?? 0),
          deadLettered: Number(readyHeldConsumerStats.dead_letter ?? 0),
          completedLast24h: Number(readyHeldConsumerStats.completed_24h ?? 0),
          lastProgressAt: readyHeldConsumerStats.last_progress_at ?? null,
          batchLimit: 25,
          scheduleActive: capabilityActive && scheduleEnabled,
          heldSample: readyHeldConsumerHolds.map((item: any) => ({
            id: String(item.id),
            stagingIntentId: String(item.staging_intent_id),
            businessId: Number(item.business_id),
            packageKey: item.package_key ?? null,
            state: String(item.state),
            attemptCount: Number(item.attempt_count),
            reason: item.outcome_code ?? null,
            updatedAt: item.updated_at,
          })),
        },
        throughput: {
          completedLast24h: Number(itemStats?.completed_24h ?? 0),
          deadLetteredLast24h: Number(itemStats?.dead_letter_24h ?? 0),
        },
        retries: {
          currentlyRetrying: Number(itemStats?.retrying ?? 0),
          staleLeases: Number(itemStats?.stale_leases ?? 0),
        },
        deadLetters: {
          total: Number(itemStats?.dead_letter ?? 0),
          sample: deadLetterSample.map((row: any) => ({
            id: String(row.id), businessId: Number(row.business_id), outcomeCode: row.outcome_code,
            attemptCount: Number(row.attempt_count), completedAt: row.completed_at,
          })),
        },
        cost: { reportedCostMicros: 0, note: "not_applicable_staging_only" },
        workerHealth: await getSfpCampaignStagingWorkerHealth(lastCompletedRun as any),
        capturedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(400).json({ code: "SFP_CAMPAIGN_STAGING_TELEMETRY_ERROR", message: err?.message ?? "Unable to load campaign-staging worker telemetry" });
    }
  });

  // PM-13 correction: governed operator controls for the campaign-staging
  // stage. Previously there was no way to act on the telemetry above — an
  // operator could SEE a dead-lettered item or a stalled run but not do
  // anything about it. These routes are the only mutation surface for the
  // stage ledger besides the worker/executeStagingV2() themselves, and each
  // one only ever moves a row through the same state machine the worker
  // uses (retry/cancelled), never bypasses it.

  // Requeue a single dead-lettered item for one more attempt. Deliberately
  // scoped to ONE item at a time (no bulk "retry all") so an operator must
  // look at each dead letter's outcome_code before deciding to retry it.
  app.post("/api/lead-ops/sfp/campaign-staging/items/:itemId/retry", requireRole("admin"), async (req, res) => {
    try {
      const itemId = String(req.params.itemId);
      const updated = rows(await db.execute(sql`
        UPDATE sfp_stage_items
           SET state = 'retry', next_attempt_at = NOW(), completed_at = NULL,
               outcome_code = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = ${itemId}::uuid AND state = 'dead_letter'
        RETURNING id, stage_run_id
      `))[0];
      if (!updated) {
        return res.status(409).json({ code: "SFP_STAGE_ITEM_NOT_DEAD_LETTER", message: "item not found or not in dead_letter state" });
      }
      // Re-open the owning run so the recurring worker picks the item back
      // up on its next tick; a run left 'failed'/'completed' never gets
      // scanned again.
      await db.execute(sql`
        UPDATE sfp_stage_runs SET state = 'pending', terminal_reason = NULL, completed_at = NULL, updated_at = NOW()
         WHERE id = ${String(updated.stage_run_id)}::uuid AND state IN ('failed', 'completed')
      `);
      const { reconcileStageRunCounters } = await import("../services/cro03/sfp-stage-ledger");
      await reconcileStageRunCounters(String(updated.stage_run_id));
      res.json({ itemId, requeued: true, stageRunId: String(updated.stage_run_id) });
    } catch (err: any) {
      res.status(400).json({ code: "SFP_STAGE_ITEM_RETRY_ERROR", message: err?.message ?? "Unable to retry item" });
    }
  });

  // Cancel a stuck/no-longer-wanted run outright. Only pending/authorized/
  // stalled runs, or a running run whose lease has already expired
  // (meaning no worker is actively holding it), can be cancelled — an
  // actively-leased running run must be left alone to finish or expire on
  // its own rather than racing the worker.
  app.post("/api/lead-ops/sfp/campaign-staging/runs/:runId/cancel", requireRole("admin"), async (req, res) => {
    try {
      const runId = String(req.params.runId);
      const updated = rows(await db.execute(sql`
        UPDATE sfp_stage_runs
           SET state = 'cancelled', terminal_reason = 'operator_cancelled', completed_at = NOW(),
               lease_expires_at = NULL, claim_token = NULL, updated_at = NOW()
         WHERE id = ${runId}::uuid
           AND (state IN ('pending', 'authorized', 'stalled')
                OR (state = 'running' AND lease_expires_at < NOW()))
        RETURNING id
      `))[0];
      if (!updated) {
        return res.status(409).json({ code: "SFP_STAGE_RUN_NOT_CANCELLABLE", message: "run not found, or is actively leased/already terminal" });
      }
      res.json({ runId, cancelled: true });
    } catch (err: any) {
      res.status(400).json({ code: "SFP_STAGE_RUN_CANCEL_ERROR", message: err?.message ?? "Unable to cancel run" });
    }
  });

  // POST /api/lead-ops/sfp/runs/:runId/stage-for-campaign — RETIRED (PM-11,
  // Task #2001 post-merge audit). This endpoint used to call legacy
  // `stageForCampaign()`, which writes an older staging representation that
  // bypasses the package-pinned v2 state machine entirely — no preview/
  // commandKey/snapshotHash contract, no package-version pin, no policy
  // document hash, none of the mutable safety-gate or plaintext-confinement
  // guarantees `campaign-staging-v2` provides. Once any provider is turned
  // on, that bypass could send outreach that never went through the
  // corrected authority. Rather than adapting it into a v2 shim (which would
  // still need every v2 guarantee re-implemented behind a different route
  // and just adds a second code path to keep in sync), the mutation is
  // retired outright: callers must use the v2 preview/execute contract at
  // POST /api/lead-ops/sfp/campaign-staging-v2/preview and .../execute.
  app.post("/api/lead-ops/sfp/runs/:runId/stage-for-campaign", requireRole("admin"), async (_req, res) => {
    res.status(410).json({
      error: "This endpoint has been retired. Use the package-pinned v2 staging contract instead.",
      code: "SFP_LEGACY_STAGING_RETIRED",
      replacement: {
        preview: "POST /api/lead-ops/sfp/campaign-staging-v2/preview",
        execute: "POST /api/lead-ops/sfp/campaign-staging-v2/execute",
      },
    });
  });

  // ── POST /api/lead-ops/candidates/backfill-promotion ───────────────────────
  // Bounded backfill: advances staged candidates to validation_admitted.
  // NOW REQUIRES a pilotRunId to bind promotion to a frozen cohort (max 25).
  // Global unbounded promotion is blocked — must specify a frozen cohort.
  app.post("/api/lead-ops/candidates/backfill-promotion", requireRole("admin"), async (req, res) => {
    try {
      const { promoteCandidateForValidation } = await import("../services/free-discovery/evidence-service");

      // Cohort binding is required — prevents global promotion of all staged candidates.
      const pilotRunId = req.body?.pilotRunId ? String(req.body.pilotRunId) : null;
      if (!pilotRunId) {
        return res.status(400).json({
          error: "pilotRunId is required. Provide a frozen cohort run ID to scope promotion to at most 25 candidates. Global unbounded promotion is disabled.",
          documentation: "POST /api/lead-ops/pilot/runs/:runId/validate-cohort is the correct endpoint for cohort-bound validation.",
        });
      }

      // Verify the pilot run exists and has a frozen cohort.
      const { getPilotRun } = await import("../services/mi09-pilot-authority");
      const run = await getPilotRun(pilotRunId);
      if (!run) return res.status(404).json({ error: "Pilot run not found" });
      if (!run.cohort_frozen_hash) {
        return res.status(409).json({ error: "Pilot run cohort is not frozen. Freeze the cohort first." });
      }

      const limit = Math.min(Number(req.body?.limit ?? 25), 25);
      if (Number.isNaN(limit) || limit < 1) {
        return res.status(400).json({ error: "limit must be an integer between 1 and 25" });
      }

      // Bind this administrative batch to the concrete deployment owner once;
      // each paid provider reservation still claims its own token/epoch job lease.
      let runtimeOwnerReason: string | null = null;
      try {
        const { claimSfpRuntimeDeploymentOwner } = await import("../services/cro03/sfp-provider-operations");
        await claimSfpRuntimeDeploymentOwner();
      } catch (ownerErr: any) {
        runtimeOwnerReason = String(ownerErr?.message ?? ownerErr);
        console.error("[BackfillPromotion] Routine-SFP owner claim failed:", runtimeOwnerReason);
      }
      if (runtimeOwnerReason) {
        return res.status(422).json({
          examined: 0, promoted: 0, skipped: 0, failed: 0,
          preflight: "FAILED",
          preflightReason: "RUNTIME_OWNER_BLOCKED",
          message: `Durable routine-SFP owner claim failed: ${runtimeOwnerReason}. No candidates were processed.`,
        });
      }

      // Fetch a bounded batch from this frozen pilot cohort only. Requiring a
      // pilotRunId while selecting global candidates would violate the cohort
      // boundary the operator approved.
      const stagedRows = ((await db.execute(sql`
        SELECT fdc.id
        FROM free_discovery_candidates fdc
        JOIN mi09_pilot_cohort_members pcm
          ON pcm.canonical_business_id = fdc.business_id
         AND pcm.pilot_run_id = ${pilotRunId}::uuid
        WHERE fdc.disposition = 'staged'
        ORDER BY fdc.created_at ASC
        LIMIT ${limit}
      `)) as any).rows ?? [];

      const results = { promoted: 0, skipped: 0, failed: 0, errors: [] as string[] };
      for (const row of stagedRows) {
        try {
          const outcome = await promoteCandidateForValidation(String(row.id));
          if (outcome.status === "PROMOTED") {
            results.promoted++;
          } else {
            results.skipped++;
            if (outcome.reason && !["CANDIDATE_NOT_FOUND", "CANDIDATE_DISPOSITION_INELIGIBLE"].includes(outcome.reason)) {
              results.errors.push(`${row.id}: skipped(${outcome.reason})`);
            }
          }
        } catch (promErr: any) {
          results.failed++;
          results.errors.push(`${row.id}: ${String(promErr?.message ?? promErr).slice(0, 100)}`);
        }
      }

      await storage.createAuditLog({
        action: "lead_ops_backfill_promotion",
        entityType: "system",
        entityId: 0,
        details: { limit, examined: stagedRows.length, ...results },
      }).catch(() => {});

      res.json({ examined: stagedRows.length, ...results });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });
}
