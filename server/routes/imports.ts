import type { Express } from "express";
import { isAuthenticated, isAdmin, isAffiliate, isDashboardUser, requireRole } from "../replit_integrations/auth";
import rateLimit from "express-rate-limit";
import { storage } from "../storage";
import { logAiCall } from "../services/ai-audit-logger";
import { db, pool } from "../db";
import { z } from "zod";
import { authStorage } from "../replit_integrations/auth/storage";
import { contacts, users } from "@shared/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { INDUSTRY_SLUGS, LOCATION_CITIES, LOCATION_VERTICALS, STATIC_BLOG_SLUGS } from "@shared/blog-slugs";
import { getSerperUsage, isSerperConfigured } from "../services/serper";
import { calculateQuizBonusFn, calculateRevenuePotentialFn, calculateSwitchabilityFn, calculateUnderwritingConfidenceFn, scoreContact } from "../services/lead-scoring";
import { importCordataEnrichment, importFullCorevt, isWorkerRunning, startDailyOutreachInBackground, stopDailyOutreachWorker } from "../services/daily-outreach";
import { getGhlSyncStatus } from "../services/ghl-sync";
import { runBulkFastClassification } from "../services/sunbiz-enrichment";
import { ingestBusiness } from "../services/sdr/dedupe";
import { syncFormSubmissionToGhl } from "../services/ghl-form-sync";
import { updateContactLocalFirst, createContactLocalFirst, writeContact } from "../services/contact-writer";
import { importExecutions, contactSourceEvents, importRowDispositions } from "@shared/schema";
import { classifyCsvSourceFormat, computeFileHash } from "../services/import-normalizer";
import {
  claimCsvExecution,
  completeImportExecution,
  getImportLedgerSummary,
  heartbeatImportExecution,
  failCsvImportProjection,
  type ImportExecutionClaim,
  recordImportRowDisposition,
} from "../services/import-execution";
import { parse } from "csv-parse/sync";
import { readTabularImportWithCoordinates, type ImportSourceCoordinate } from "../services/tabular-import-reader";
import { sanitizeAuditPayload } from "../services/audit-sanitizer";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import { uploadLarge, normalizePhoneForImport, classifyVerticalForImport } from "./helpers";
import { uploadTabularLarge } from "../lib/tabular-upload";
import { recordPewcDecision } from "../services/consent-evidence";
import { syncAffiliateSignupToGhl } from "../services/ghl-form-sync";
import { sanitizeFirstName } from "../services/contact-name-utils";
import { publicLeadRateLimit } from "../middleware/public-rate-limit";
import { serverError, logOperationalDiagnostic } from "../utils/server-error";
import { claimPublicInbound } from "../services/public-inbound-intake";
import { completePartnerApplicationLocal } from "../services/partner-application-intake";
import { registerPersistedCsvProcessor, processPersistedCsvImport } from "../services/csv-import-processor";
import { processCanonicalImportRecoveryTick } from "../services/canonical-import-recovery-worker";
import { canonicalRecoverableImportAccountingSql } from "../services/canonical-import-recovery-contract";
import { recordContactBusinessLinkCandidate } from "../services/commercial-link-authority";
import { importDispositionCompatibility } from "@shared/import-disposition-summary";
import { claimInboundRequest, orchestrateInboundRequest, setInboundRequestLifecycle } from "../services/inbound-request-authority";

export function registerImportsRoutes(app: Express) {
  app.get("/api/import-executions/:executionId/ledger", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const executionId = String(req.params.executionId);
    const rows = await db.select({
      sourceRowNumber: importRowDispositions.sourceRowNumber,
      disposition: importRowDispositions.disposition,
      reasonCode: importRowDispositions.reasonCode,
      contactId: importRowDispositions.contactId,
      createdAt: importRowDispositions.createdAt,
    }).from(importRowDispositions)
      .where(eq(importRowDispositions.executionId, executionId))
      .limit(limit)
      .offset(offset);
    const [total] = await db.select({ count: sql<number>`count(*)` }).from(importRowDispositions)
      .where(eq(importRowDispositions.executionId, executionId));
    // Diagnostics are intentionally omitted for managers: only stable reason
    // codes and non-PII row references leave this boundary.
    res.json({ rows, limit, offset, total: Number(total?.count ?? 0) });
  });

  // === FULL COREVT IMPORT ===
  app.post("/api/sunbiz/import-corevt-full", isAuthenticated, async (req, res) => {
    if (!(globalThis as { __BT10_DURABLE_LONG_OPERATION_OWNER__?: boolean }).__BT10_DURABLE_LONG_OPERATION_OWNER__) {
      return res.status(503).json({ code: "DURABLE_COMMAND_REQUIRED", message: "Corevt import requires a durable command." });
    }
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    const maxRecords = Number(req.body.maxRecords) || Infinity;
    const onlyActive = req.body.onlyActive !== false;
    res.json({ message: `Full corevt import started (max: ${maxRecords === Infinity ? 'unlimited' : maxRecords}, active only: ${onlyActive})`, started: true });
    importFullCorevt({ maxRecords, onlyActive }).catch(err => console.error("[Import API] Error:", err));
  });

  app.get("/api/sunbiz/import-progress", isAuthenticated, async (req, res) => {
    const progress = await storage.getSystemSetting("corevt_import_progress");
    const cordataProgress = await storage.getSystemSetting("cordata_import_progress");
    const entityCount = await storage.getSunbizEntityCount();
    res.json({ progress: progress || { status: "idle" }, cordataProgress: cordataProgress || { status: "idle" }, totalInDb: entityCount });
  });

  app.post("/api/sunbiz/import-cordata", isAuthenticated, async (req, res) => {
    if (!(globalThis as { __BT10_DURABLE_LONG_OPERATION_OWNER__?: boolean }).__BT10_DURABLE_LONG_OPERATION_OWNER__) {
      return res.status(503).json({ code: "DURABLE_COMMAND_REQUIRED", message: "Cordata import requires a durable command." });
    }
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    const maxRecords = req.body.maxRecords ? parseInt(req.body.maxRecords) : Infinity;
    const download = req.body.download !== false;
    res.json({ message: `Cordata import started (download: ${download}, max: ${maxRecords === Infinity ? 'unlimited' : maxRecords})`, started: true });
    importCordataEnrichment({ maxRecords, download }).catch(err => console.error("[Cordata Import API] Error:", err));
  });

  app.get("/api/sunbiz/cordata-progress", isAuthenticated, async (req, res) => {
    const progress = await storage.getSystemSetting("cordata_import_progress");
    res.json({ progress: progress || { status: "idle" } });
  });

  app.post("/api/sunbiz/fast-classify", isAuthenticated, async (req, res) => {
    if (!(globalThis as { __BT10_DURABLE_LONG_OPERATION_OWNER__?: boolean }).__BT10_DURABLE_LONG_OPERATION_OWNER__) {
      return res.status(503).json({ code: "DURABLE_COMMAND_REQUIRED", message: "Bulk classification requires a durable command." });
    }
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    const { acquireJobLock, releaseJobLock } = await import("../services/job-registry");
    const lease = await acquireJobLock("sunbiz-fast-classification");
    if (lease.status === "held") return res.status(409).json({ message: "Bulk classification is already running.", started: false, execution: "held" });
    if (lease.status === "unavailable") return res.status(503).json({ message: "Classification registry is unavailable.", started: false, execution: "unavailable" });
    res.status(202).json({ message: "Bulk fast classification accepted.", started: true, execution: "accepted" });
    runBulkFastClassification({ lockToken: lease.lockToken })
      .catch(err => console.error("[FastClassify API] Error:", err));
  });

  app.get("/api/sunbiz/classify-progress", isAuthenticated, async (req, res) => {
    const progress = await storage.getSystemSetting("bulk_classify_progress");
    res.json({ progress: progress || { status: "idle" } });
  });


  // === DAILY OUTREACH AUTOMATION ===
  app.post("/api/outreach/run-daily", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    try {
      const execution = await startDailyOutreachInBackground();
      if (execution === "held") {
        return res.status(409).json({ message: "Daily outreach is already running.", started: false, execution: "held" });
      }
      if (execution === "unavailable") {
        return res.status(503).json({ message: "Daily outreach registry is unavailable.", started: false, execution: "unavailable" });
      }
      return res.status(202).json({ message: "Daily outreach cycle accepted.", started: true, execution });
    } catch (err) {
      console.error("[Daily Outreach API] Error:", err);
      return res.status(500).json({ message: "Daily outreach cycle failed.", started: false });
    }
  });

  app.post("/api/outreach/start-worker", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    return res.status(503).json({
      code: "LEGACY_WORKER_DISABLED",
      message: "The legacy interval worker is disabled. Configure REDIS_URL and use the BullMQ queue manager.",
    });
  });

  app.post("/api/outreach/stop-worker", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    stopDailyOutreachWorker();
    res.json({ message: "Outreach worker stopped", stopped: true });
  });

  // Aggregate counts are not actor-scoped. Dashboard roles only; merchants and partners are denied before any query.
  app.get("/api/outreach/status", isAuthenticated, requireRole("admin", "manager", "agent"), async (req, res) => {
    let commEventsUnavailable = false;
    const [entityStats, verticalBreakdown, prospectStats, contactStats, dealStats, ghlStatus, importProgress, cordataProgress, enrichmentProgress, lastOutreachRun, workerStatus, sourceBreakdown, commEventRows] = await Promise.all([
      storage.getSunbizAggregateStats(),
      storage.getSunbizVerticalBreakdown(),
      storage.getProspectAggregateStats(),
      storage.getContactAggregateStats(),
      storage.getDealAggregateStats(),
      getGhlSyncStatus(),
      storage.getSystemSetting("corevt_import_progress"),
      storage.getSystemSetting("cordata_import_progress"),
      storage.getSystemSetting("enrichment_progress"),
      storage.getSystemSetting("daily_outreach_last_run"),
      storage.getSystemSetting("outreach_worker_status"),
      storage.getContactSourceBreakdown(),
      // Per-source communication event breakdown (#1444 step 6)
      pool.query<{ source: string; channel: string; cnt: string }>(`
        SELECT
          COALESCE(sent_by, 'automation') AS source,
          channel,
          COUNT(*)::text                  AS cnt
        FROM communication_events
        WHERE direction = 'outbound'
          AND created_at >= NOW() - INTERVAL '90 days'
        GROUP BY COALESCE(sent_by, 'automation'), channel
        ORDER BY source, channel
      `).catch((error) => {
        // A failed query is unavailable, never zero events.
        console.error("[outreach/status] communication event breakdown failed:", error?.code ?? "", error?.message ?? error);
        commEventsUnavailable = true;
        return { rows: [] as Array<{ source: string; channel: string; cnt: string }> };
      }),
    ]);

    const campaigns = await storage.getCampaigns();
    const activeCampaigns = campaigns.filter(c => c.status === "active").length;

    const serperUsage = await getSerperUsage();

    // Aggregate commEventRows into per-source breakdown
    const commEventMap: Record<string, { emailCount: number; smsCount: number; callCount: number; total: number }> = {};
    for (const row of commEventRows.rows) {
      const src = row.source;
      const cnt = parseInt(row.cnt, 10);
      if (!commEventMap[src]) commEventMap[src] = { emailCount: 0, smsCount: 0, callCount: 0, total: 0 };
      if (row.channel === "email") commEventMap[src].emailCount += cnt;
      else if (row.channel === "sms") commEventMap[src].smsCount += cnt;
      else if (row.channel === "call") commEventMap[src].callCount += cnt;
      commEventMap[src].total += cnt;
    }
    const commEventSourceBreakdown = Object.entries(commEventMap)
      .map(([source, counts]) => ({ source, ...counts }))
      .sort((a, b) => b.total - a.total);

    res.json({
      entities: entityStats,
      prospects: prospectStats,
      contacts: contactStats,
      // States the exact population behind contacts.* so no client has to guess: archived rows are excluded; record class and owner are not filtered.
      contactsScope: { key: "all_unarchived_contacts_all_record_classes_all_owners", label: "All unarchived contacts (all record classes, all owners)" },
      deals: dealStats,
      activeCampaigns,
      verticalBreakdown,
      sourceBreakdown,
      commEventSourceBreakdown,
      commEventsUnavailable,
      asOf: new Date().toISOString(),
      ghlSync: ghlStatus,
      importProgress: importProgress || { status: "idle" },
      cordataProgress: cordataProgress || { status: "idle" },
      enrichmentProgress: enrichmentProgress || { status: "idle" },
      lastOutreachRun,
      workerRunning: isWorkerRunning(),
      workerStatus,
      openAiConfigured: !!process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      serper: {
        configured: isSerperConfigured(),
        usage: serperUsage,
      },
    });
  });

  app.get("/api/blog/generated", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    const status = req.query.status as string | undefined;
    const posts = await storage.getGeneratedBlogPosts(status);
    res.json(posts);
  });

  app.get("/api/blog/generated/published", async (_req, res) => {
    const posts = await storage.getGeneratedBlogPosts("published");
    res.json(posts);
  });

  app.post("/api/blog/generate", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    try {
      const { keywords, category, autoSchedule } = req.body;
      if (!keywords || !Array.isArray(keywords) || keywords.length === 0 || keywords.length > 10) {
        return res.status(400).json({ error: "Keywords array required (1-10 items)" });
      }
      const validCategories = ["Education", "Cost Savings", "Industry", "Programs", "Getting Started", "Technology", "Compliance", "Security"];
      const validCategory = validCategories.includes(category) ? category : "Education";

      const { OpenAI } = await import("openai");
      const openai = new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });

      const prompt = `Generate an SEO-optimized blog post for a payment processing company called Liberty Bancard. The post should target these keywords: ${keywords.map((k: string) => k.slice(0, 100)).join(", ")}. Category: ${validCategory}.

The company provides transparent, interchange-plus payment processing for small businesses. They offer free statement reviews, wholesale pricing, next-day funding, and cash discount programs.

Return a JSON object with this exact structure:
{
  "slug": "url-friendly-slug-from-title",
  "title": "SEO-Optimized Title (50-60 chars ideal)",
  "excerpt": "Compelling 1-2 sentence summary for blog listing page",
  "category": "${validCategory}",
  "author": "Liberty Bancard Team",
  "readTime": "X min read",
  "publishDate": "${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}",
  "publishedISO": "${new Date().toISOString()}",
  "modifiedISO": "${new Date().toISOString()}",
  "keywords": "comma, separated, target, keywords",
  "metaDescription": "Meta description under 160 characters",
  "content": [
    { "type": "paragraph", "text": "Opening paragraph..." },
    { "type": "heading", "level": 2, "text": "Section Title" },
    { "type": "paragraph", "text": "Section content..." },
    { "type": "list", "items": ["Point 1", "Point 2", "Point 3"] },
    { "type": "cta", "text": "CTA message", "ctaText": "Button Text", "ctaHref": "/upload-statement" }
  ],
  "faqs": [
    { "question": "Relevant FAQ question?", "answer": "Detailed answer..." },
    { "question": "Another FAQ?", "answer": "Answer..." },
    { "question": "Third FAQ?", "answer": "Answer..." }
  ]
}

Guidelines:
- Write 1000-1500 words of substantive, expert content
- Include 4-6 H2 headings
- Include at least one bulleted list
- End with a CTA pointing to /upload-statement
- Include 3-5 FAQ entries relevant to the article topic
- Be factual, specific, and avoid making unsubstantiated claims
- Use industry-specific data and examples
- Include disclaimers where appropriate
- Do NOT use markdown formatting in text fields
- Return ONLY valid JSON, no markdown code fences`;

      const importGenMessages = [{ role: "user" as const, content: prompt }];
      const { completion } = await logAiCall(
        { triggerType: "content-generation", actorType: (req as any).user?.role || "agent", actorId: (req as any).user?.id?.toString(), rawPrompt: JSON.stringify(importGenMessages) },
        () => openai.chat.completions.create({
          model: "gpt-5",
          messages: importGenMessages,
          response_format: { type: "json_object" },
        })
      );

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        return res.status(500).json({ error: "No response from AI" });
      }

      const postData = JSON.parse(content);

      if (!postData.slug || typeof postData.slug !== 'string' || !postData.title || typeof postData.title !== 'string' || !postData.content || !Array.isArray(postData.content) || postData.content.length === 0) {
        return res.status(500).json({ error: "AI returned invalid blog post structure" });
      }

      const slugRegex = /^[a-z0-9-]+$/;
      if (!slugRegex.test(postData.slug) || postData.slug.length > 200) {
        postData.slug = postData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 200);
      }

      for (const section of postData.content) {
        if (!section || typeof section !== 'object' || !['paragraph', 'heading', 'list', 'cta', 'quote'].includes(section.type)) {
          return res.status(500).json({ error: "AI returned invalid content section" });
        }
        if (section.ctaHref && typeof section.ctaHref === 'string' && !section.ctaHref.startsWith('/')) {
          section.ctaHref = '/upload-statement';
        }
      }

      if (postData.faqs && Array.isArray(postData.faqs)) {
        postData.faqs = postData.faqs.filter((f: { question?: unknown; answer?: unknown }) => f && typeof f.question === 'string' && typeof f.answer === 'string').slice(0, 10);
      } else {
        postData.faqs = null;
      }

      let scheduledAt: Date | undefined;
      let status = "draft";
      if (autoSchedule) {
        const scheduled = await storage.getScheduledBlogPosts();
        const lastScheduled = scheduled.length > 0 ? new Date(scheduled[scheduled.length - 1].scheduledAt!) : new Date();
        const nextDate = new Date(lastScheduled);
        nextDate.setDate(nextDate.getDate() + (Math.random() < 0.5 ? 3 : 4));
        nextDate.setHours(9, 0, 0, 0);
        scheduledAt = nextDate;
        status = "scheduled";
      }

      const saved = await storage.createGeneratedBlogPost({
        slug: postData.slug,
        title: postData.title,
        excerpt: postData.excerpt || "",
        category: postData.category || validCategory,
        author: postData.author || "Liberty Bancard Team",
        readTime: postData.readTime || "5 min read",
        publishDate: postData.publishDate || new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
        publishedISO: postData.publishedISO || new Date().toISOString(),
        modifiedISO: postData.modifiedISO || new Date().toISOString(),
        keywords: postData.keywords || keywords.join(", "),
        metaDescription: postData.metaDescription || postData.excerpt || "",
        content: postData.content,
        faqs: postData.faqs || null,
        status,
        scheduledAt: scheduledAt || null,
        createdBy: (req.user as any)?.id || null,
      });

      res.json(saved);
    } catch (err: any) {
      console.error("Blog generation error:", err);
      serverError(res, err);
    }
  });

  app.patch("/api/blog/generated/:id/publish", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid post ID" });
    const post = await storage.publishBlogPost(id);
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json(post);
  });

  app.patch("/api/blog/generated/:id/schedule", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid post ID" });
    const { scheduledAt } = req.body;
    if (!scheduledAt || typeof scheduledAt !== 'string') return res.status(400).json({ error: "scheduledAt ISO string required" });
    const date = new Date(scheduledAt);
    if (isNaN(date.getTime()) || date <= new Date()) return res.status(400).json({ error: "scheduledAt must be a valid future date" });
    const post = await storage.updateGeneratedBlogPost(id, {
      status: "scheduled",
      scheduledAt: date,
    });
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json(post);
  });

  app.delete("/api/blog/generated/:id", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid post ID" });
    await storage.deleteGeneratedBlogPost(id);
    res.json({ success: true });
  });

  app.get("/sitemap.xml", async (_req, res) => {
    const baseUrl = "https://libertybancard.com";
    const today = new Date().toISOString().split("T")[0];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    xml += `  <sitemap><loc>${baseUrl}/sitemap-core.xml</loc><lastmod>${today}</lastmod></sitemap>\n`;
    xml += `  <sitemap><loc>${baseUrl}/sitemap-blog.xml</loc><lastmod>${today}</lastmod></sitemap>\n`;
    xml += `  <sitemap><loc>${baseUrl}/sitemap-locations.xml</loc><lastmod>${today}</lastmod></sitemap>\n`;
    xml += `  <sitemap><loc>${baseUrl}/sitemap-compare.xml</loc><lastmod>${today}</lastmod></sitemap>\n`;
    xml += `  <sitemap><loc>${baseUrl}/sitemap-glossary.xml</loc><lastmod>${today}</lastmod></sitemap>\n`;
    xml += `</sitemapindex>`;

    res.set("Content-Type", "application/xml");
    res.send(xml);
  });

  app.get("/sitemap-core.xml", async (_req, res) => {
    const baseUrl = "https://libertybancard.com";
    const today = new Date().toISOString().split("T")[0];

    const publicPages: Array<{ url: string; priority: string; changefreq: string }> = [
      { url: "/", priority: "1.0", changefreq: "weekly" },
      { url: "/get-started", priority: "0.9", changefreq: "monthly" },
      { url: "/upload-statement", priority: "0.9", changefreq: "monthly" },
      { url: "/free-analysis", priority: "0.9", changefreq: "monthly" },
      { url: "/free-analysis-guaranteed", priority: "0.9", changefreq: "monthly" },
      { url: "/0-percent-processing", priority: "0.9", changefreq: "monthly" },
      { url: "/beat-square-stripe", priority: "0.8", changefreq: "monthly" },
      { url: "/free-smart-terminal", priority: "0.9", changefreq: "monthly" },
      { url: "/about-contact", priority: "0.7", changefreq: "monthly" },
      { url: "/estimate", priority: "0.8", changefreq: "monthly" },
      { url: "/support", priority: "0.6", changefreq: "monthly" },
      { url: "/merchant-application", priority: "0.8", changefreq: "monthly" },
      { url: "/savings-calculator", priority: "0.8", changefreq: "monthly" },
      { url: "/compare-rates", priority: "0.8", changefreq: "monthly" },
      { url: "/blog", priority: "0.8", changefreq: "weekly" },
      { url: "/faq", priority: "0.9", changefreq: "monthly" },
      { url: "/affiliate", priority: "0.7", changefreq: "monthly" },
      { url: "/why-liberty-bancard", priority: "0.8", changefreq: "monthly" },
      { url: "/shop", priority: "0.8", changefreq: "monthly" },
      { url: "/case-studies", priority: "0.8", changefreq: "monthly" },
      { url: "/testimonials", priority: "0.8", changefreq: "monthly" },
      { url: "/testimonials/submit", priority: "0.5", changefreq: "monthly" },
      { url: "/integrations", priority: "0.8", changefreq: "monthly" },
      ...INDUSTRY_SLUGS.map(slug => ({ url: `/industries/${slug}`, priority: "0.8", changefreq: "monthly" })),
      { url: "/privacy-policy", priority: "0.3", changefreq: "yearly" },
      { url: "/terms", priority: "0.3", changefreq: "yearly" },
      { url: "/cookie-policy", priority: "0.3", changefreq: "yearly" },
      { url: "/advertising-disclosure", priority: "0.2", changefreq: "yearly" },
      { url: "/accessibility", priority: "0.3", changefreq: "yearly" },
      { url: "/sms-terms", priority: "0.2", changefreq: "yearly" },
      { url: "/esign-consent", priority: "0.2", changefreq: "yearly" },
      { url: "/surcharging-disclosure", priority: "0.3", changefreq: "yearly" },
      { url: "/merchant-policies", priority: "0.2", changefreq: "yearly" },
      { url: "/regulatory-notices", priority: "0.2", changefreq: "yearly" },
      { url: "/security-compliance", priority: "0.3", changefreq: "yearly" },
      { url: "/do-not-sell", priority: "0.2", changefreq: "yearly" },
      { url: "/data-processing-agreement", priority: "0.2", changefreq: "yearly" },
      { url: "/responsible-ai", priority: "0.2", changefreq: "yearly" },
      { url: "/testimonials-disclosure", priority: "0.2", changefreq: "yearly" },
      { url: "/law-enforcement", priority: "0.2", changefreq: "yearly" },
      { url: "/dispute-resolution", priority: "0.2", changefreq: "yearly" },
      { url: "/data-retention", priority: "0.2", changefreq: "yearly" },
      { url: "/tcpa-consent", priority: "0.2", changefreq: "yearly" },
      { url: "/refund-policy", priority: "0.3", changefreq: "yearly" },
      { url: "/california-privacy", priority: "0.3", changefreq: "yearly" },
      { url: "/ada-compliance", priority: "0.3", changefreq: "yearly" },
      { url: "/help", priority: "0.7", changefreq: "monthly" },
    ];

    const helpArticles: { category: string; slugs: string[] }[] = [
      { category: "getting-started", slugs: ["setting-up-your-merchant-account", "running-your-first-transaction", "connecting-your-pos-system", "understanding-your-pricing", "next-day-funding-setup"] },
      { category: "billing-statements", slugs: ["reading-your-monthly-statement", "understanding-processing-fees", "disputing-a-charge-on-your-statement", "managing-chargebacks", "understanding-refunds-and-credits"] },
      { category: "technical-support", slugs: ["terminal-troubleshooting", "gateway-setup-configuration", "resolving-batch-settlement-issues", "wifi-and-network-connectivity", "contactless-and-nfc-troubleshooting"] },
      { category: "account-management", slugs: ["updating-business-information", "adding-users-and-permissions", "changing-your-processing-settings", "adding-a-new-location", "closing-or-pausing-your-account"] },
      { category: "compliance-security", slugs: ["pci-compliance-basics", "protecting-customer-data", "fraud-prevention-tips", "handling-a-data-breach", "understanding-emv-and-liability-shift"] },
      { category: "general-faq", slugs: ["what-is-payment-processing", "how-long-does-approval-take", "what-are-interchange-fees", "do-i-need-a-contract", "what-is-a-merchant-id", "can-i-accept-amex", "what-is-a-cash-discount-program", "how-to-read-your-rate", "what-is-next-day-funding", "how-to-switch-processors", "what-is-pci-compliance"] },
    ];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    for (const page of publicPages) {
      xml += `  <url>\n`;
      xml += `    <loc>${baseUrl}${page.url}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
      xml += `    <priority>${page.priority}</priority>\n`;
      xml += `  </url>\n`;
    }

    for (const group of helpArticles) {
      xml += `  <url>\n`;
      xml += `    <loc>${baseUrl}/help/${group.category}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>monthly</changefreq>\n`;
      xml += `    <priority>0.6</priority>\n`;
      xml += `  </url>\n`;
      for (const slug of group.slugs) {
        xml += `  <url>\n`;
        xml += `    <loc>${baseUrl}/help/${group.category}/${slug}</loc>\n`;
        xml += `    <lastmod>${today}</lastmod>\n`;
        xml += `    <changefreq>monthly</changefreq>\n`;
        xml += `    <priority>0.5</priority>\n`;
        xml += `  </url>\n`;
      }
    }

    xml += `</urlset>`;
    res.set("Content-Type", "application/xml");
    res.send(xml);
  });

  // /sitemap-blog.xml is registered in server/routes/ssr-routes.ts (canonical).

  app.post("/api/affiliate/signup", publicLeadRateLimit, async (req, res) => {
    if (req.query.probe === "1") return res.json({ probe: true, endpoint: "/api/affiliate/signup" });
    try {
      const { firstName, lastName, email, phone, companyName, website, howHeard, password } = req.body;
      if (!firstName || typeof firstName !== "string" || firstName.length > 100) {
        return res.status(400).json({ message: "Valid first name is required." });
      }
      if (!email || typeof email !== "string" || !email.includes("@") || email.length > 200) {
        return res.status(400).json({ message: "Valid email is required." });
      }
      if (!phone || typeof phone !== "string" || phone.length > 30) {
        return res.status(400).json({ message: "Valid phone number is required." });
      }
      if (!password || typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters." });
      }
      // Claim the occurrence before any write (password excluded from the fingerprint input). The affiliate signup
      // shares the partner-application source contract; the applicant does not need a provider contact id for any receipt.
      const { password: _omitPassword, ...claimPayload } = req.body;
      const inbound = await claimPublicInbound(req, res, ["website_form", "partner_application"], claimPayload, {
        onReplay: async (request) => (await import("../services/partner-application-intake")).resumePartnerApplication(request, "affiliate"),
      });
      if (!inbound) return;
      const failSignup = async (status: number, body: Record<string, unknown>) => {
        await setInboundRequestLifecycle(inbound.id, "failed", `HTTP_${status}`).catch(() => undefined);
        return res.status(status).json(body);
      };
      const existing = await storage.getPartnerByEmail(email.toLowerCase());
      if (existing) {
        return failSignup(409, { message: "An affiliate account with this email already exists." });
      }
      const existingUser = await authStorage.getUserByEmail(email.toLowerCase());
      if (existingUser) {
        return failSignup(409, { message: "An account with this email already exists." });
      }
      let code = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        code = (firstName.slice(0, 3) + (lastName?.slice(0, 3) || "") + Math.random().toString(36).slice(2, 6)).toLowerCase().replace(/[^a-z0-9]/g, "");
        const dup = await storage.getPartnerByCode(code);
        if (!dup) break;
      }
      const passwordHash = await bcrypt.hash(password, 12);
      // Account row, login credential and the occurrence binding commit in one transaction, so a crash can never leave
      // an account without its credential or an occurrence that cannot find its account.
      const { createPartnerAccount, PARTNER_EMAIL_IN_USE } = await import("../services/partner-account");
      let partner;
      try {
        partner = await createPartnerAccount({
          companyName: (companyName || `${firstName} ${lastName || ""}`.trim()).slice(0, 200),
          contactName: `${firstName} ${lastName || ""}`.trim().slice(0, 200),
          email: email.toLowerCase().slice(0, 200),
          phone: phone.slice(0, 30),
          passwordHash,
          partnerType: "affiliate",
          affiliateCode: code,
          status: "active",
          commissionPercent: 10,
          website: website ? String(website).slice(0, 500) : null,
          howHeard: howHeard ? String(howHeard).slice(0, 500) : null,
        }, { role: "affiliate", inboundRequestId: inbound.id });
      } catch (accountErr: any) {
        if (accountErr?.message === PARTNER_EMAIL_IN_USE) return failSignup(409, { message: "An account with this email already exists." });
        throw accountErr;
      }
      const user = await authStorage.getUserByEmail(email.toLowerCase());
      if (!user) throw new Error("AFFILIATE_CREDENTIAL_MISSING_AFTER_COMMIT");
      // Contact (partner source contract), review notification with owner/due time and request orchestration run
      // through one repeatable routine. A failure is recorded on the occurrence (review_required) and resumed on replay;
      // it is no longer swallowed. The contact writer records durable provider work, so no immediate GHL id is needed.
      const completed = await completePartnerApplicationLocal(inbound, partner as any, "affiliate");
      const affiliateContact = completed.localContactId ? await storage.getContact(completed.localContactId) : null;

      if (affiliateContact) {
        // Supplemental referral-code form sync is best-effort; the durable projection from the contact writer is the
        // authoritative handoff. Provider completion belongs to the GHL companion work.
        syncFormSubmissionToGhl({
          contactId: affiliateContact.id,
          leadSource: "affiliate",
          formData: {
            lb_referral_code: partner.affiliateCode || "",
          },
        }).catch(err => logOperationalDiagnostic("affiliate_signup_sync", err, "form_sync_failed", { partnerId: partner.id }));
        // The welcome is durable work written with the account (see partner_approval_deliveries): it waits for the provider
        // contact id and is executed by the delivery worker, so nothing here depends on this request staying alive.
      }
      syncAffiliateSignupToGhl({
        firstName,
        lastName: lastName || "",
        email,
        phone,
        companyName: companyName || undefined,
        affiliateCode: partner.affiliateCode || code,
      }).catch(err => logOperationalDiagnostic("affiliate_signup_sync", err, "affiliate_sync_failed", { partnerId: partner.id }));

      req.logIn(user, (loginErr) => {
        if (loginErr) {
          return res.status(201).json({
            message: "Welcome to the Liberty Bancard Affiliate Program!",
            affiliateCode: partner.affiliateCode,
            receipt: { accountCreated: true, contactRecorded: completed.contactRecorded, requestReceipt: inbound.id },
          });
        }
        return res.status(201).json({
          message: "Welcome to the Liberty Bancard Affiliate Program!",
          affiliateCode: partner.affiliateCode,
          receipt: { accountCreated: true, contactRecorded: completed.contactRecorded, requestReceipt: inbound.id },
        });
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  const affiliateLoginRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { message: "Too many login attempts, please try again later." } });
  app.post("/api/affiliate/login", affiliateLoginRateLimit, async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required." });
      }
      const partner = await storage.getPartnerByEmail(email.toLowerCase());
      if (!partner || !partner.passwordHash) {
        return res.status(401).json({ message: "Invalid email or password." });
      }
      const valid = await bcrypt.compare(password, partner.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Invalid email or password." });
      }
      if (partner.status !== "active") {
        return res.status(403).json({ message: "Your affiliate account is not active." });
      }
      let user = await authStorage.getUserByEmail(email.toLowerCase());
      if (!user) {
        const nameParts = (partner.contactName || "").split(" ");
        user = await authStorage.upsertUser({
          email: email.toLowerCase(),
          firstName: nameParts[0] || "Affiliate",
          lastName: nameParts.slice(1).join(" ") || "",
          passwordHash: partner.passwordHash,
          role: "affiliate",
          authProvider: "local",
        });
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) {
          return res.status(500).json({ message: "Login failed." });
        }
        return res.json({
          affiliateCode: partner.affiliateCode,
          name: partner.contactName,
          email: partner.email,
        });
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/affiliate/session", isAffiliate, async (req, res) => {
    try {
      const user = req.user as any;
      const partner = await storage.getPartnerByEmail(user.email);
      if (!partner) {
        return res.status(404).json({ message: "Affiliate account not found." });
      }
      return res.json({
        affiliateCode: partner.affiliateCode,
        name: partner.contactName,
        email: partner.email,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/affiliate/logout", (req, res) => {
    req.logout(() => {
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.json({ message: "Logged out" });
      });
    });
  });

  app.get("/api/affiliate/stats/:code", isAffiliate, async (req, res) => {
    try {
      const user = req.user as any;
      const partner = await storage.getPartnerByCode(req.params.code as string);
      if (!partner) return res.status(404).json({ message: "Affiliate not found." });
      if (user.role !== "admin" && partner.email !== user.email) {
        return res.status(403).json({ message: "Access denied." });
      }
      const referralsList = await storage.getReferralsByPartner(partner.id);
      const pending = referralsList.filter(r => r.status === "pending" || r.status === "contacted").length;
      const qualified = referralsList.filter(r => r.status === "qualified").length;
      const converted = referralsList.filter(r => r.status === "converted" || r.status === "paid").length;
      const totalEarnings = referralsList.filter(r => r.status === "paid").reduce((sum, r) => sum + parseFloat(r.incentiveAmount || "0"), 0);
      const pendingEarnings = referralsList.filter(r => r.status === "converted").reduce((sum, r) => sum + parseFloat(r.incentiveAmount || "0"), 0);
      res.json({
        affiliate: {
          name: partner.contactName,
          code: partner.affiliateCode,
          commissionPercent: partner.commissionPercent,
          status: partner.status,
          joinedAt: partner.createdAt,
        },
        stats: {
          totalClicks: partner.totalClicks || 0,
          totalReferrals: referralsList.length,
          pending,
          qualified,
          converted,
          conversionRate: referralsList.length > 0 ? Math.round((converted / referralsList.length) * 100) : 0,
          totalEarnings: totalEarnings.toFixed(2),
          pendingEarnings: pendingEarnings.toFixed(2),
        },
        recentReferrals: referralsList.slice(0, 20).map(r => ({
          id: r.id,
          status: r.status,
          date: r.createdAt,
        })),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/affiliate/public/:code", async (req, res) => {
    try {
      const partner = await storage.getPartnerByCode(req.params.code);
      if (!partner || partner.status !== "active") {
        return res.status(404).json({ message: "Affiliate not found" });
      }
      res.json({
        name: partner.contactName,
        company: partner.companyName || undefined,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/affiliate/track-click", publicLeadRateLimit, async (req, res) => {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ message: "Code required" });
      const partner = await storage.getPartnerByCode(code);
      if (!partner) return res.status(404).json({ message: "Invalid affiliate code" });
      await storage.updatePartner(partner.id, { totalClicks: (partner.totalClicks || 0) + 1 } as any);
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/public/free-analysis", publicLeadRateLimit, async (req, res) => {
    if (req.query.probe === "1") return res.json({ probe: true, endpoint: "/api/public/free-analysis" });
    let claimedRequestId: string | null = null;
    let mutationStarted = false;
    try {
      const {
        businessType, industry, monthlyVolume, currentProcessor,
        painPoint, painPoints: painPointsArr,
        firstName, lastName, email, phone, companyName,
        consentSms, consentEmail, pewcConsent: pewcConsentRaw, referralCode, promoCode,
        utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
      } = req.body;

      if (!firstName || !email) {
        return res.status(400).json({ message: "First name and email are required." });
      }
      const idempotencyKey = req.header("Idempotency-Key");
      if (!idempotencyKey) {
        return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required" });
      }
      const inboundClaim = await claimInboundRequest({
        idempotencyKey,
        sourceCategory: "website_form",
        sourceType: "free_analysis",
        callerScope: `public:${req.ip || "unknown"}`,
        actorType: "public",
        payload: req.body || {},
      });
      if (inboundClaim.outcome === "conflict") {
        return res.status(409).json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency-Key was used with different content" });
      }
      if (inboundClaim.outcome === "scope_mismatch") {
        return res.status(404).json({ message: "Request not found" });
      }
      if (inboundClaim.outcome === "replay") {
        return res.status(200).json({
          requestReceipt: inboundClaim.request.id,
          status: inboundClaim.request.lifecycleState,
        });
      }
      const submissionId = inboundClaim.request.id;
      claimedRequestId = submissionId;

      const sanitizedPromo = promoCode
        ? promoCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 20)
        : undefined;

      const resolvedPainPoints: string[] = Array.isArray(painPointsArr) ? painPointsArr
        : painPoint ? (typeof painPoint === "string" ? painPoint.split(",").map((s: string) => s.trim()) : [painPoint])
        : [];

      const industryMap: Record<string, string> = {
        "restaurant": "Restaurant", "retail": "Retail",
        "healthcare": "Medical/Dental/Medspa", "medical": "Medical/Dental/Medspa",
        "automotive": "Automotive", "home-services": "Home Services", "home_services": "Home Services",
        "ecommerce": "E-commerce", "e-commerce": "E-commerce", "other": "Other",
      };
      const normalizedIndustry = industryMap[(industry || "other").toLowerCase().replace(/[^a-z-]/g, "")] || industry || "Other";

      const volumeRanges: Record<string, number> = {
        "under-5k": 2500, "5k-15k": 10000, "15k-50k": 32500,
        "50k-150k": 100000, "150k-plus": 200000,
        "Under $5,000": 2500, "$5,000 - $10,000": 7500,
        "$5,000 - $15,000": 10000, "$10,001 - $25,000": 17500,
        "$15,000 - $50,000": 32500, "$25,001 - $50,000": 37500,
        "$50,000 - $150,000": 100000, "$50,001+": 75000,
        "$150,000+": 200000, "Not sure": 15000,
      };
      const volumeNum = volumeRanges[monthlyVolume] || parseFloat((monthlyVolume || "0").replace(/[^0-9.]/g, "")) || 15000;
      let estimatedSavings = 0;
      let recommendedProgram = "Wholesale";
      let recommendedTerminal = "Clover Flex 3";

      const processorRates: Record<string, number> = {
        "square": 2.6, "stripe": 2.9, "toast": 2.49, "clover": 2.6,
        "clover_go": 2.6, "bank-processor": 2.5, "bank_processor": 2.5,
        "paypal": 2.7, "shopify": 2.6, "other": 2.5, "none": 3.0,
      };
      const processorKey = (currentProcessor || "other").toLowerCase().replace(/[^a-z_-]/g, "");
      const currentRate = processorRates[processorKey] || processorRates[processorKey.replace(/-/g, "_")] || 2.5;
      const ourRate = 1.59;
      const rateDiff = (currentRate - ourRate) / 100;
      estimatedSavings = Math.round(volumeNum * rateDiff * 12);

      if (volumeNum > 10000) {
        recommendedProgram = "0% Processing (Dual Pricing)";
        estimatedSavings = Math.round(volumeNum * (currentRate / 100) * 12);
      } else if (volumeNum > 5000) {
        recommendedProgram = "Wholesale Interchange+";
      }

      const terminalMap: Record<string, string> = {
        "Restaurant": "Clover Station Duo", "Retail": "Clover Mini 3",
        "Home Services": "SwipeSimple B250", "Automotive": "PAX A920",
        "Medical/Dental/Medspa": "Dejavoo QD4", "E-commerce": "Clover Flex 3",
      };
      recommendedTerminal = terminalMap[normalizedIndustry] || "Clover Flex 3";

      const industryTag = `vertical_${(normalizedIndustry || "unknown").toLowerCase().replace(/[^a-z]/g, "_")}`;
      const tags = ["src_quiz", "lead_free_analysis", industryTag];
      if (sanitizedPromo) tags.push(`promo_${sanitizedPromo.toLowerCase()}`);
      if (utmSource) tags.push(`utm_src_${utmSource}`);
      if (utmMedium) tags.push(`utm_med_${utmMedium}`);
      if (utmCampaign) tags.push(`utm_camp_${utmCampaign}`);

      let contact: Awaited<ReturnType<typeof createContactLocalFirst>> | Awaited<ReturnType<typeof storage.getContactByEmail>> & { _ghlSyncPending?: boolean };
      try {
        mutationStarted = true;
        contact = await createContactLocalFirst({
          firstName,
          lastName: lastName || "",
          email,
          phone: phone || "",
          companyName: companyName || undefined,
          vertical: normalizedIndustry || undefined,
          monthlyVolume: monthlyVolume || undefined,
          currentProvider: currentProcessor || undefined,
          primaryOfferPath: recommendedProgram,
          utmSource: utmSource || undefined,
          utmMedium: utmMedium || undefined,
          utmCampaign: utmCampaign || undefined,
          utmContent: utmContent || undefined,
          utmTerm: utmTerm || undefined,
          landingPage: "/free-analysis",
          promoCode: sanitizedPromo,
          painPoints: resolvedPainPoints.length > 0 ? resolvedPainPoints : undefined,
          estimatedResidual: estimatedSavings ? String(estimatedSavings) : undefined,
          status: "New",
          tags,
        });
      } catch (createErr: any) {
        if (createErr?.code === "23505" && (createErr?.constraint?.includes("email") || createErr?.message?.includes("contacts_email_unique_idx"))) {
          const existing = await storage.getContactByEmail(email);
          if (!existing) throw createErr;
          contact = existing;
        } else {
          throw createErr;
        }
      }

      const pewcConsent = pewcConsentRaw === true;
      for (const [channel, value] of [["email", consentEmail], ["sms", consentSms]] as const) {
        if (value !== true) continue;
        const { applyConsentCommand } = await import("../services/consent-authority");
        await applyConsentCommand({
          subject: { type: "contact", id: contact.id },
          kind: "opt_in",
          channel,
          purpose: "outreach",
          eventNamespace: "public_form",
          eventKey: `free_analysis:${submissionId}:${channel}`,
          source: "free_analysis_quiz",
          ipAddress: req.ip || req.socket.remoteAddress || "unknown",
          userAgent: req.headers["user-agent"] || "unknown",
          evidence: { submissionId, formType: "free_analysis" },
        });
      }
      if (pewcConsent) {
        await recordPewcDecision({
          contactId: contact.id,
          checked: true,
          source: "free_analysis_quiz",
          ipAddress: req.ip || req.socket.remoteAddress || "unknown",
          userAgent: req.headers["user-agent"] || "unknown",
          eventKey: `free_analysis:${submissionId}`,
          details: { formType: "free_analysis", submissionId },
        });
      }

      const quizNotes = [
        `Quiz Results:`,
        `Business Type: ${businessType || "N/A"}`,
        `Industry: ${normalizedIndustry || "N/A"}`,
        `Monthly Volume: ${monthlyVolume || "N/A"}`,
        `Current Processor: ${currentProcessor || "N/A"}`,
        `Pain Points: ${resolvedPainPoints.length > 0 ? resolvedPainPoints.join(", ") : "N/A"}`,
        `Estimated Annual Savings: $${estimatedSavings.toLocaleString()}`,
        `Recommended Program: ${recommendedProgram}`,
        `Recommended Terminal: ${recommendedTerminal}`,
        sanitizedPromo ? `Promo Code: ${sanitizedPromo}` : null,
      ].filter(Boolean).join("\n");

      const deal = await storage.createDeal({
        contactId: contact.id,
        pipeline: "sales",
        stage: "New Lead",
        offerPath: recommendedProgram,
        notes: quizNotes,
        leadSource: "free_analysis_quiz",
        promoCode: sanitizedPromo,
        terminalRecommendation: recommendedTerminal,
        recommendedProgram,
        totalVolume: monthlyVolume || undefined,
      });

      await storage.createNotification({
        channel: "#sales",
        title: "New Quiz Lead",
        message: `New quiz lead: ${firstName} ${lastName || ""} from ${normalizedIndustry || "Unknown"}, est. savings $${estimatedSavings.toLocaleString()}${sanitizedPromo ? ` (promo: ${sanitizedPromo})` : ""}`,
        type: "alert",
        metadata: {
          contactId: contact.id,
          dealId: deal.id,
          industry,
          estimatedSavings,
          monthlyVolume,
        },
      });

      const searchName = companyName || `${firstName} ${lastName || ""}`;
      const matches = await storage.searchSunbizEntitiesByNameCity(searchName);
      if (matches.length > 0) {
        const match = matches[0];
        const enrichUpdates: Record<string, any> = {};
        if (match.vertical && !contact.vertical) enrichUpdates.vertical = match.vertical;
        if (match.ownerName) enrichUpdates.notes = `${contact.notes || ""}\nSunbiz Match: ${match.entityName} (Filing: ${match.filingNumber || "N/A"})`.trim();
        const existingTags = contact.tags || [];
        enrichUpdates.tags = [...existingTags, "sunbiz_matched"];
        if (match.aiSummary) {
          enrichUpdates.notes = `${enrichUpdates.notes || contact.notes || ""}\nSunbiz AI: ${match.aiSummary}`.trim();
        }
        await updateContactLocalFirst(contact.id, enrichUpdates);
        await storage.updateSunbizEntity(match.id, {
          tags: [...(match.tags || []), "quiz_lead_linked"],
          notes: `${match.notes || ""}\nLinked to quiz contact #${contact.id} (${firstName} ${lastName || ""})`.trim(),
        });
      }

      await storage.createReviewQueueItem({
        sourceType: "quiz",
        sourceId: contact.id,
        status: "pending",
        checklistState: {},
        metadata: {
          contactName: `${firstName} ${lastName || ""}`.trim(),
          firstName,
          lastName: lastName || "",
          email,
          phone: phone || "",
          companyName: companyName || undefined,
          industry: normalizedIndustry,
          vertical: normalizedIndustry,
          monthlyVolume,
          currentProcessor,
          painPoints: resolvedPainPoints,
          recommendedProgram,
          estimatedSavings,
          source: "free_analysis",
          utmSource: utmSource || undefined,
          utmCampaign: utmCampaign || undefined,
          contactId: contact.id,
          dealId: deal.id,
        },
      });

      const request = await orchestrateInboundRequest({
        requestId: inboundClaim.request.id,
        contactId: contact.id,
        dealId: deal.id,
      });
      res.status(201).json({ requestReceipt: request.id, status: request.lifecycleState });
    } catch (err: any) {
      console.error("Free analysis submission error:", err);
      if (claimedRequestId) {
        await setInboundRequestLifecycle(
          claimedRequestId,
          mutationStarted ? "review_required" : "failed",
          mutationStarted ? "FREE_ANALYSIS_PARTIAL_MUTATION" : "FREE_ANALYSIS_PROCESSING_FAILED",
        );
      }
      res.status(500).json({ code: "FREE_ANALYSIS_SUBMISSION_FAILED", message: "Unable to process submission." });
    }
  });

  app.post("/api/affiliate/referral", publicLeadRateLimit, async (req, res) => {
    let claimedRequestId: string | null = null;
    let mutationStarted = false;
    try {
      const { affiliateCode, name, email, phone, company, source } = req.body;
      if (!affiliateCode || !name || !email) {
        return res.status(400).json({ message: "Affiliate code, name, and email are required." });
      }
      const partner = await storage.getPartnerByCode(affiliateCode);
      if (!partner) return res.status(404).json({ message: "Invalid affiliate code." });
      const idempotencyKey = req.header("Idempotency-Key");
      if (!idempotencyKey) {
        return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required for a partner referral" });
      }
      const inboundClaim = await claimInboundRequest({
        idempotencyKey,
        occurrenceKey: `partner-referral:${partner.id}:${idempotencyKey}`,
        sourceCategory: "partner_referral",
        sourceType: "partner_form",
        callerScope: `partner:${partner.id}`,
        actorType: "partner",
        actorId: String(partner.id),
        payload: { name, email, phone: phone || null, company: company || null, source: source || null },
      });
      if (inboundClaim.outcome === "conflict") {
        return res.status(409).json({ code: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency-Key was used with a different referral" });
      }
      if (inboundClaim.outcome === "scope_mismatch") {
        return res.status(403).json({ code: "IDEMPOTENCY_KEY_SCOPE_MISMATCH", message: "Idempotency-Key belongs to another partner" });
      }
      if (inboundClaim.outcome === "replay") {
        return res.status(200).json({ requestReceipt: inboundClaim.request.id, status: inboundClaim.request.lifecycleState });
      }
      claimedRequestId = inboundClaim.request.id;
      const nameParts = String(name).trim().split(/\s+/);
      mutationStarted = true;
      const contact = await writeContact({
        mode: "local_only",
        mutation: {
          firstName: nameParts[0] || "Referral",
          lastName: nameParts.slice(1).join(" "),
          email: String(email).trim().toLowerCase(),
          phone: phone || "",
          companyName: company || undefined,
          status: "New",
          leadSource: "Partner Referral",
        },
        provenance: {
          sourceCategory: "partner_referral",
          sourceType: "partner_form",
          eventKey: `partner-referral:${inboundClaim.request.id}`,
          actorType: "partner",
          actorId: String(partner.id),
        },
        actor: { actorType: "partner", actorId: String(partner.id) },
      });
      await storage.createReferral({
        partnerId: partner.id,
        contactId: contact.id,
        referredName: name,
        referredEmail: email,
        referredPhone: phone || null,
        referredCompany: company || null,
        status: "pending",
        incentiveType: "commission",
        notes: source ? `Source: ${source}` : null,
      });
      await storage.updatePartner(partner.id, { totalReferrals: (partner.totalReferrals || 0) + 1 } as any);
      const request = await orchestrateInboundRequest({ requestId: inboundClaim.request.id, contactId: contact.id });
      res.status(201).json({ requestReceipt: request.id, status: request.lifecycleState });
    } catch (err: any) {
      console.error("Affiliate referral submission error:", err);
      if (claimedRequestId) {
        await setInboundRequestLifecycle(
          claimedRequestId,
          mutationStarted ? "review_required" : "failed",
          mutationStarted ? "AFFILIATE_REFERRAL_PARTIAL_MUTATION" : "AFFILIATE_REFERRAL_PROCESSING_FAILED",
        );
      }
      res.status(500).json({ code: "AFFILIATE_REFERRAL_SUBMISSION_FAILED", message: "Unable to process referral." });
    }
  });


  // === MASS SCORING ===
  app.post("/api/contacts/mass-score", requireRole("admin", "manager"), async (req, res) => {
    const batchSize = 500;
    let totalScored = 0;
    const tierCounts = { hot: 0, warm: 0, cold: 0, unqualified: 0 };

    try {
      const countResult = await pool.query(
        `SELECT COUNT(*) as cnt FROM contacts WHERE archived_at IS NULL AND (last_scored_at IS NULL OR last_scored_at < NOW() - INTERVAL '24 hours')`
      );
      const totalContacts = parseInt(countResult.rows[0].cnt, 10);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const sendProgress = (data: any) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      sendProgress({ type: "start", totalContacts });

      let lastId = 0;
      while (true) {
        const batchResult = await pool.query(
          `SELECT id FROM contacts WHERE archived_at IS NULL AND (last_scored_at IS NULL OR last_scored_at < NOW() - INTERVAL '24 hours') AND id > $1 ORDER BY id LIMIT $2`,
          [lastId, batchSize]
        );

        if (batchResult.rows.length === 0) break;

        for (const row of batchResult.rows) {
          lastId = row.id;
          try {
            const contact = await storage.getContact(row.id);
            if (!contact) continue;

            const contactDeals = await storage.getDealsByContact(row.id);
            const primaryDeal = contactDeals[0] || null;

            const revPotential = calculateRevenuePotentialFn(contact, primaryDeal);
            const switchability = calculateSwitchabilityFn(contact);
            const uwConfidence = calculateUnderwritingConfidenceFn(contact, primaryDeal);
            const quizBonus = calculateQuizBonusFn(contact);

            const engagementScore = 5;

            const total = revPotential.score + switchability.score + uwConfidence.score + engagementScore + quizBonus.score;
            const tier = total >= 70 ? "hot" : total >= 45 ? "warm" : total >= 20 ? "cold" : "unqualified";
            tierCounts[tier]++;

            await updateContactLocalFirst(row.id, {
              leadScore: total,
              revPotentialScore: revPotential.score,
              switchabilityScore: switchability.score,
              uwConfidenceScore: uwConfidence.score,
              engagementScore: engagementScore,
              scoreBreakdown: {
                revPotential: { score: revPotential.score, max: 30, factors: revPotential.factors },
                switchability: { score: switchability.score, max: 25, factors: switchability.factors },
                uwConfidence: { score: uwConfidence.score, max: 25, factors: uwConfidence.factors },
                engagement: { score: engagementScore, max: 20, factors: { default: 5 } },
                quizBonus: { score: quizBonus.score, max: 20, factors: quizBonus.factors },
                total,
                tier,
              },
              lastScoredAt: new Date(),
            });

            totalScored++;
          } catch (err) {
            console.error(`Mass scoring failed for contact ${row.id}:`, err);
          }
        }

        sendProgress({ type: "progress", scored: totalScored, total: totalContacts, tierCounts });
      }

      sendProgress({ type: "complete", totalScored, tierCounts });
      res.end();
    } catch (err: any) {
      console.error("Mass scoring error:", err);
      if (!res.headersSent) {
        serverError(res, err);
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        res.end();
      }
    }
  });


  // === MASS DEAL CREATION ===
  app.post("/api/contacts/mass-create-deals", requireRole("admin", "manager"), async (req, res) => {
    const batchSize = 500;
    let dealsCreated = 0;
    let skipped = 0;

    try {
      const countResult = await pool.query(
        `SELECT COUNT(*) as cnt FROM contacts c WHERE c.archived_at IS NULL AND c.lead_score >= 45 AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = c.id)`
      );
      const totalEligible = parseInt(countResult.rows[0].cnt, 10);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const sendProgress = (data: any) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      sendProgress({ type: "start", totalEligible });

      let lastId = 0;
      while (true) {
        const batchResult = await pool.query(
          `SELECT c.id, c.lead_score, c.vertical, c.monthly_volume, c.lead_source, c.first_name, c.last_name, c.company_name
           FROM contacts c
           WHERE c.archived_at IS NULL AND c.lead_score >= 45
             AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = c.id)
             AND c.id > $1
           ORDER BY c.id
           LIMIT $2`,
          [lastId, batchSize]
        );

        if (batchResult.rows.length === 0) break;

        for (const row of batchResult.rows) {
          lastId = row.id;
          try {
            const score = row.lead_score || 0;
            const isHot = score >= 70;
            const stage = isHot ? "New Lead" : "Nurture / Not Now";
            const merchantTier = isHot ? "Strategic" : score >= 50 ? "Growth" : "Starter";

            await storage.createDeal({
              contactId: row.id,
              pipeline: "sales",
              stage,
              priorityScore: score,
              merchantTier,
              leadSource: row.lead_source || "imported",
              totalVolume: row.monthly_volume || null,
              notes: `Auto-created from mass scoring. Contact: ${row.first_name} ${row.last_name}${row.company_name ? ` (${row.company_name})` : ""}. Score: ${score}, Tier: ${isHot ? "hot" : "warm"}.`,
            });
            dealsCreated++;
          } catch (err) {
            console.error(`Deal creation failed for contact ${row.id}:`, err);
            skipped++;
          }
        }

        sendProgress({ type: "progress", created: dealsCreated, skipped, total: totalEligible });
      }

      sendProgress({ type: "complete", dealsCreated, skipped });
      res.end();
    } catch (err: any) {
      console.error("Mass deal creation error:", err);
      if (!res.headersSent) {
        serverError(res, err);
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
        res.end();
      }
    }
  });


  // BT-07: automatic and bulk contact merges are permanently disabled.
  app.post("/api/contacts/deduplicate", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    await storage.createAuditLog({
      action: "legacy_contact_deduplicate_blocked",
      entityType: "contact_merge",
      actorType: "user",
      actorId: (req.user as any)?.id ?? null,
      details: { reason: "LEGACY_CONTACT_MERGE_DISABLED" },
    }).catch(() => {});
    return res.status(410).json({
      code: "LEGACY_CONTACT_MERGE_DISABLED",
      message: "Automatic deduplication is disabled. Use an explicitly reviewed admin merge operation.",
    });
  });


  // === CSV IMPORT PIPELINE ===
  app.get("/api/csv-imports", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    const imports = await storage.getCsvImports();
    const executionIds = imports.flatMap(imp => imp.executionId ? [imp.executionId] : []);
    const executionStates = executionIds.length ? await db.select({
      id: importExecutions.id,
      status: importExecutions.status,
      leaseExpiresAt: importExecutions.leaseExpiresAt,
    }).from(importExecutions).where(inArray(importExecutions.id, executionIds)) : [];
    const liveExecutions = new Set(executionStates.filter(execution =>
      execution.status === "running" && execution.leaseExpiresAt &&
      execution.leaseExpiresAt.getTime() > Date.now()).map(execution => execution.id));

    // Auto-mark any import that has been stuck in "processing" for longer than
    // the configurable threshold with no progress heartbeat as "interrupted".
    // Threshold is read from STALE_IMPORT_THRESHOLD_MINUTES (default: 30).
    // This is fire-and-forget for the DB write but we mutate in-memory first
    // so the response reflects the updated status immediately.
    const thresholdMin = parseInt(process.env.STALE_IMPORT_THRESHOLD_MINUTES || "30", 10) || 30;
    const STALE_THRESHOLD_MS = thresholdMin * 60 * 1000;
    const now = Date.now();
    const staleUpdates: Promise<any>[] = [];
    for (const imp of imports) {
      // A resumed native processor can be healthy before its next projection
      // checkpoint. Render its actual live lease; never mark it interrupted
      // solely because an older projection timestamp is stale.
      if (imp.executionId && liveExecutions.has(imp.executionId) && imp.status !== "failed") {
        imp.status = "processing";
        continue;
      }
      if (imp.status !== "processing") continue;
      const progressAt = imp.lastProgressAt ? new Date(imp.lastProgressAt).getTime() : null;
      const createdAt = imp.createdAt ? new Date(imp.createdAt).getTime() : now;
      const lastActivity = progressAt ?? createdAt;
      if (now - lastActivity > STALE_THRESHOLD_MS) {
        imp.status = "interrupted"; // mutate in-memory before sending response
        staleUpdates.push(
          storage.updateCsvImport(imp.id, {
            status: "interrupted",
            staleReason: `No progress detected for >${thresholdMin} minutes (last heartbeat: ${
              imp.lastProgressAt ? new Date(imp.lastProgressAt).toISOString() : "none"
            })`,
          }).catch((e: any) => {
            console.warn(`[CSV Import] Failed to auto-mark import ${imp.id} as interrupted:`, e?.message);
          })
        );
      }
    }
    if (staleUpdates.length > 0) {
      Promise.all(staleUpdates).catch(() => {});
    }

    // For execution-backed imports, the immutable row ledger is the only
    // reconciliation authority. Legacy records retain their compatibility
    // projections because they predate the execution ledger.
    const withDurableOutcomes = await Promise.all(imports.map(async (imp) => {
      if (!imp.executionId) return imp;
      const ledger = await getImportLedgerSummary(imp.executionId);
      const outcomes = importDispositionCompatibility(ledger.counts);
      return {
        ...imp,
        ...outcomes,
        newRecords: outcomes.created,
        updatedRecords: outcomes.updated,
        duplicatesSkipped: outcomes.matched_noop,
        invalidRows: outcomes.rejected,
        skippedRows: outcomes.deferred,
        errorsCount: outcomes.failed,
        processedRows: outcomes.total,
        dispositionCounts: outcomes.counts,
        recovery: ledger.recovery,
      };
    }));
    res.json(withDurableOutcomes);
  });

  // Bounded replay uses the existing retained worker and its normal native
  // claims, never item resets or a second import execution. CSRF is global.
  app.post("/api/import-executions/:executionId/replay-retained",
    isDashboardUser, requireRole("admin"), async (req,res) => {
    const parsed=z.object({
      executionId:z.string().uuid(),
      sourceRowNumbers:z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(250)
        .refine(values=>new Set(values).size===values.length,"Duplicate source rows"),
    }).safeParse({executionId:req.params.executionId,sourceRowNumbers:req.body?.sourceRowNumbers});
    if(!parsed.success)return res.status(400).json({code:"CANONICAL_IMPORT_REPLAY_INVALID_SCOPE"});
    const {executionId,sourceRowNumbers}=parsed.data;
    try {
      const execution=(await db.execute(sql`SELECT id,status,total_rows FROM import_executions
        WHERE id=${executionId}::uuid`) as any).rows[0];
      if(!execution)return res.status(404).json({code:"IMPORT_EXECUTION_NOT_FOUND"});
      if(execution.status!=="completed" || sourceRowNumbers.some(row=>row>Number(execution.total_rows)))
        return res.status(409).json({code:"CANONICAL_IMPORT_REPLAY_SCOPE_NOT_RECOVERABLE"});
      // The shared recoverability predicate reads the retained item and its
      // original observation, so scope the same tables the worker selects from.
      const scoped=(await db.execute(sql`SELECT DISTINCT accounting.source_row_number
        FROM import_row_dispositions accounting
        JOIN cro03_enrichment_batches batch ON batch.purpose='staging_review'
          AND batch.idempotency_key='csv-source:'||accounting.execution_id::text||':'||accounting.source_row_number::text
        JOIN cro03_enrichment_items item ON item.batch_id=batch.id
        JOIN cro03_batch_memberships member ON member.id=item.membership_id
        JOIN cro03_source_observations observation ON observation.id=member.source_observation_id
        WHERE accounting.execution_id=${executionId}::uuid
          AND accounting.source_row_number IN (${sql.join(sourceRowNumbers.map(row=>sql`${row}`),sql`,`)})
          AND ${canonicalRecoverableImportAccountingSql()}
          AND observation.payload->>'sourceFormat' IN ('google_maps_outscraper','apollo_lead_list')`) as any).rows;
      if(scoped.length!==sourceRowNumbers.length)
        return res.status(409).json({code:"CANONICAL_IMPORT_REPLAY_SCOPE_NOT_RECOVERABLE"});
      await db.execute(sql`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
        VALUES('canonical_import_replay_requested','import_execution',${executionId},
          ${JSON.stringify({sourceRowNumbers,selectionOnly:true})}::jsonb,
          'user',${String((req.user as any).id)})`);
      const result=await processCanonicalImportRecoveryTick({
        maxItems:sourceRowNumbers.length,replay:{executionId,sourceRowNumbers}});
      // Attempted is not acceptance. Callers still reconcile physical evidence,
      // holds and unchanged accounting; remaining rows can be busy/ineligible.
      return res.json(result);
    }catch(error){serverError(res,error);}
  });

  // Admin: manually mark a processing import as interrupted (e.g. if stale
  // threshold hasn't been reached but the import is clearly stuck).
  // Gate to admin only — this is a lifecycle state mutation.
  app.post("/api/csv-imports/:id/mark-interrupted", isAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const record = await storage.getCsvImport(id);
      if (!record) return res.status(404).json({ message: "Import record not found" });
      if (!["processing", "interrupted"].includes(record.status ?? "")) {
        return res.status(400).json({
          message: `Import is in status "${record.status}" — only processing imports can be marked interrupted`,
        });
      }
      const updated = await storage.updateCsvImport(id, {
        status: "interrupted",
        staleReason: `Manually marked interrupted by admin at ${new Date().toISOString()}`,
      });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/csv-imports/stats", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const imports = await storage.getCsvImports();
      const durableOutcomes = await Promise.all(imports.map(async (imp) => imp.executionId
        ? importDispositionCompatibility((await getImportLedgerSummary(imp.executionId)).counts)
        : importDispositionCompatibility({
          created: imp.newRecords,
          matched_noop: imp.duplicatesSkipped,
          updated: imp.updatedRecords,
          rejected: imp.invalidRows,
          deferred: imp.skippedRows,
          failed: imp.errorsCount,
        })));
      const totalImports = imports.length;
      const totalRowsProcessed = durableOutcomes.reduce((sum, i) => sum + i.total, 0);
      const totalRecordsImported = durableOutcomes.reduce((sum, i) => sum + i.created, 0);
      const totalDuplicatesSkipped = durableOutcomes.reduce((sum, i) => sum + i.matched_noop, 0);
      // "Already Exists" is a DB-level conflict caught by onConflictDoNothing() —
      // distinct from app-level pre-check duplicates, but both mean "this
      // contact already exists". Surface both separately (for audit) AND
      // combined (for the headline reconciliation story) so no row is ever
      // invisible in the top-level stats.
      const totalSkippedRows = durableOutcomes.reduce((sum, i) => sum + i.deferred, 0);
      const totalAlreadyExists = totalDuplicatesSkipped + totalSkippedRows;
      const totalUpdatedRows = durableOutcomes.reduce((sum, i) => sum + i.updated, 0);
      const totalInvalidRows = durableOutcomes.reduce((sum, i) => sum + i.rejected, 0);
      const totalErrors = durableOutcomes.reduce((sum, i) => sum + i.failed, 0);
      const totalDealsCreated = imports.reduce((sum, i) => sum + (i.dealsCreated || 0), 0);
      const totalHot = imports.reduce((sum, i) => sum + (i.hotLeads || 0), 0);
      const totalWarm = imports.reduce((sum, i) => sum + (i.warmLeads || 0), 0);

      const allVerticals: Record<string, number> = {};
      for (const imp of imports) {
        const breakdown = imp.verticalBreakdown as Record<string, number> | null;
        if (breakdown) {
          for (const [v, count] of Object.entries(breakdown)) {
            allVerticals[v] = (allVerticals[v] || 0) + count;
          }
        }
      }

      res.json({
        totalImports,
        totalRowsProcessed,
        totalRecordsImported,
        totalDuplicatesSkipped,
        totalSkippedRows,
        totalAlreadyExists,
        totalUpdatedRows,
        totalInvalidRows,
        totalErrors,
        totalDealsCreated,
        totalHot,
        totalWarm,
        verticalBreakdown: allVerticals,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/affiliate/leaderboard", isAffiliate, async (_req, res) => {
    try {
      const leaders = await storage.getAffiliateLeaderboard();
      res.json(leaders.map((p, idx) => ({
        rank: idx + 1,
        name: p.contactName || p.companyName,
        referrals: p.totalReferrals || 0,
        conversions: p.totalConversions || 0,
        earnings: p.totalPayouts || "0",
      })));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/affiliate/commission-report/:code", isAffiliate, async (req, res) => {
    try {
      const user = req.user as any;
      const partner = await storage.getPartnerByCode(req.params.code as string);
      if (!partner) return res.status(404).json({ message: "Affiliate not found." });
      if (user.role !== "admin" && partner.email !== user.email) {
        return res.status(403).json({ message: "Access denied." });
      }
      const allReferrals = await storage.getReferralsByPartner(partner.id);
      const tiers = await storage.getCommissionTiers();
      const converted = allReferrals.filter(r => r.status === "converted" || r.status === "paid");

      function getCommissionForReferralCount(count: number): string {
        if (tiers.length === 0) return "100";
        for (const tier of tiers) {
          if (count >= tier.minReferrals && (tier.maxReferrals === null || count <= tier.maxReferrals)) {
            return tier.commissionAmount;
          }
        }
        return tiers[tiers.length - 1]?.commissionAmount || "100";
      }

      const monthlyBreakdown: Record<string, any[]> = {};
      let grandTotal = 0;
      for (const ref of converted) {
        const date = ref.createdAt ? new Date(ref.createdAt) : new Date();
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        if (!monthlyBreakdown[monthKey]) monthlyBreakdown[monthKey] = [];
        const commAmt = ref.commissionAmount || ref.incentiveAmount || getCommissionForReferralCount(converted.length);
        const amtNum = parseFloat(commAmt) || 0;
        grandTotal += amtNum;
        monthlyBreakdown[monthKey].push({
          referralId: ref.id,
          merchantName: ref.referredCompany || ref.referredName || "Unknown",
          signupDate: ref.createdAt,
          status: ref.status,
          commissionAmount: commAmt,
        });
      }

      const report = Object.entries(monthlyBreakdown)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, entries]) => ({
          month,
          entries,
          total: entries.reduce((sum: number, e: any) => sum + parseFloat(e.commissionAmount || "0"), 0).toFixed(2),
        }));

      res.json({
        affiliate: { name: partner.contactName, code: partner.affiliateCode },
        tiers,
        currentTierReferrals: converted.length,
        currentCommissionRate: getCommissionForReferralCount(converted.length),
        report,
        totalEarnings: grandTotal.toFixed(2),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // /api/commission-tiers GET/POST/DELETE/PUT are registered in server/routes/partners.ts (canonical, role-guarded).

  app.get("/api/csv-imports/:id", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    const record = await storage.getCsvImport(Number(req.params.id));
    if (!record) return res.status(404).json({ message: "Not found" });
    if (!record.executionId) return res.json(record);
    const ledger = await getImportLedgerSummary(record.executionId);
    const outcomes = importDispositionCompatibility(ledger.counts);
    res.json({
      ...record,
      ...outcomes,
      newRecords: outcomes.created,
      updatedRecords: outcomes.updated,
      duplicatesSkipped: outcomes.matched_noop,
      invalidRows: outcomes.rejected,
      skippedRows: outcomes.deferred,
      errorsCount: outcomes.failed,
      processedRows: outcomes.total,
      dispositionCounts: outcomes.counts,
      recovery: ledger.recovery,
    });
  });

  app.post("/api/leads/import-csv", isDashboardUser, requireRole("admin", "manager"), uploadTabularLarge.single("file"), async (req, res) => {
    let requestClaim: ImportExecutionClaim | undefined;
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const filePath = req.file.path;
      const fileName = req.file.originalname || "upload.csv";
      let sourceBytes: Buffer;
      let records: Record<string, string>[];
      let sourceCoordinates: ImportSourceCoordinate[];
      try {
        sourceBytes = fs.readFileSync(filePath);
        const parsed = await readTabularImportWithCoordinates(sourceBytes, fileName);
        records = parsed.rows;
        sourceCoordinates = parsed.coordinates;
      } catch (err: any) {
        return res.status(400).json({ message: `Could not read uploaded file: ${err.message}` });
      } finally {
        try { fs.unlinkSync(filePath); } catch {}
      }

      if (records.length === 0) {
        return res.status(400).json({ message: "Import file is empty or could not be parsed" });
      }

      const sourceFormat = classifyCsvSourceFormat(Object.keys(records[0]));

      // Permanent execution identity is claimed before a UI projection is
      // created. A repeated or concurrent request never gets a second worker.
       const csvHash = computeFileHash(sourceBytes);
      const principal = req.user as any;
      const executionClaim = await claimCsvExecution({
        fileHash: csvHash,
        totalRows: records.length,
        actorType: "user",
        actorId: String(principal?.id ?? ""),
        // Keep recovery-only presentation metadata alongside the persisted
        // original records. The execution identity remains the content hash.
        metadata: { sourceFormat, fileName, sourceCoordinates },
        sourcePayload: records,
      });
      requestClaim = executionClaim;
      if (!executionClaim.claimed) {
        if (executionClaim.execution.status === "running") {
          return res.status(409).json({
            status: "in_progress",
            executionId: executionClaim.execution.id,
            retryable: true,
          });
        }
        const summary = await getImportLedgerSummary(executionClaim.execution.id);
        const outcomes = importDispositionCompatibility(summary.counts);
        return res.status(200).json({
          replayed: true,
          execution: executionClaim.execution,
          import: { totalRows: executionClaim.execution.totalRows ?? records.length, status: executionClaim.execution.status },
          ...outcomes,
        });
      }
      const importRecord = await storage.createCsvImport({
        executionId: executionClaim.execution.id,
        fileName,
        sourceFormat,
        totalRows: records.length,
        importSource: sourceFormat,
        status: "processing",
        importedBy: principal?.email || String(principal?.id ?? "system"),
      });

      const processCsvImport = async (args: {
        records: Array<Record<string, string>>;
        executionClaim: typeof executionClaim;
        importRecord: typeof importRecord;
        sourceFormat: string;
        actor: { actorType: string; actorId: string; userId?: string };
        filename: string;
      }) => {
      const { records, executionClaim, importRecord, sourceFormat, actor, filename: fileName } = args;
      // The permanent execution already pins the original CSV/XLSX upload bytes.
      const csvSourceType = sourceFormat === "google_maps_outscraper" ? "outscraper"
        : sourceFormat === "apollo_lead_list" ? "apollo"
        : "csv_contact";
      const importExecution = executionClaim.execution;
      const isProviderExport = sourceFormat === "google_maps_outscraper" || sourceFormat === "apollo_lead_list";

      // Native provider materialization owns its identity/consent reads. These
      // full-population caches belong only to the generic mapper below, whose
      // path provider rows never enter. Avoid retaining three unused CRM scans
      // for the entire lifetime of each concurrent provider upload.
      const existingEmails = isProviderExport ? [] : await db.select({ email: sql<string>`LOWER(TRIM(email))` }).from(contacts).where(and(ne(contacts.email, ""), sql`email IS NOT NULL`));
      const existingPhones = isProviderExport ? [] : await db.select({ phone: contacts.phone }).from(contacts).where(and(ne(contacts.phone, ""), sql`phone IS NOT NULL`));
      const existingCompanies = isProviderExport ? [] : await db.select({ name: sql<string>`LOWER(TRIM(company_name))` }).from(contacts).where(and(sql`company_name IS NOT NULL`, ne(contacts.companyName, "")));

      const emailSet = new Set<string>();
      for (const row of existingEmails) { if (row.email) emailSet.add(row.email); }
      const phoneSet = new Set<string>();
      for (const row of existingPhones) {
        const norm = normalizePhoneForImport(row.phone || "");
        if (norm && norm.length >= 10) phoneSet.add(norm);
      }
      const companySet = new Set<string>();
      for (const row of existingCompanies) { if (row.name) companySet.add(row.name); }

      const { getImportColumnMap } = await import("../services/provider-import-columns");
      const columnMap = getImportColumnMap(sourceFormat);

      // For known-provider formats (google_maps_outscraper, apollo_lead_list)
      // the system sourceFormat IS the canonical lead_source enum value.
      // The CSV may contain a native `source` column with provenance metadata
      // (URLs, scraper strings, etc.) which must never overwrite lead_source on
      // known-provider imports. Force it here so the per-row mapper cannot win.
      const forcedLeadSource = sourceFormat !== "custom" ? sourceFormat : null;

      // ── Monotonic consent merge helpers ─────────────────────────────────────
      // These values can never be "downgraded" by a CSV import — restrictive
      // state always beats contactable state.
      const RESTRICTIVE_EMAIL_STATUSES = new Set(["unsubscribed", "opted_out"]);
      const RESTRICTIVE_CONSENT_TIERS = new Set(["opted_out", "do_not_contact"]);

      function existingContactIsRestrictive(c: {
        emailStatus: string; consentTier: string;
        optedOutEmail: boolean | null; doNotContact: boolean | null;
      }): boolean {
        return RESTRICTIVE_EMAIL_STATUSES.has(c.emailStatus) ||
          RESTRICTIVE_CONSENT_TIERS.has(c.consentTier) ||
          c.optedOutEmail === true ||
          c.doNotContact === true;
      }

      function csvMappedHasRestrictiveConsent(mapped: Record<string, string>): boolean {
        const emailStatus = (mapped.emailStatus || "").toLowerCase();
        const consentTier = (mapped.consentTier || "").toLowerCase();
        const optedOutEmail = (mapped.optedOutEmail || "").toLowerCase();
        const doNotContact = (mapped.doNotContact || "").toLowerCase();
        return RESTRICTIVE_EMAIL_STATUSES.has(emailStatus) ||
          RESTRICTIVE_CONSENT_TIERS.has(consentTier) ||
          optedOutEmail === "true" || optedOutEmail === "1" || optedOutEmail === "yes" ||
          doNotContact === "true" || doNotContact === "1" || doNotContact === "yes";
      }

      // Pre-fetch consent data for emails in this CSV that already exist in DB.
      // This allows O(1) consent lookups in the per-row loop without extra queries.
      type ConsentSnapshot = {
        id: number; emailStatus: string; consentTier: string;
        optedOutEmail: boolean | null; doNotContact: boolean | null; doNotAutoContact: boolean;
      };
      const consentByEmail = new Map<string, ConsentSnapshot>();
      {
        const csvEmailsForConsentLookup: string[] = [];
        for (const rec of records) {
          const emailVal = (rec.email || rec.Email || "").toLowerCase().trim();
          if (emailVal && emailSet.has(emailVal)) csvEmailsForConsentLookup.push(emailVal);
        }
        if (csvEmailsForConsentLookup.length > 0) {
          const consentRows = await pool.query<{
            id: number; email: string; email_status: string; consent_tier: string;
            opted_out_email: boolean | null; do_not_contact: boolean | null; do_not_auto_contact: boolean;
          }>(
            `SELECT id, LOWER(TRIM(email)) AS email, email_status, consent_tier,
                    opted_out_email, do_not_contact, do_not_auto_contact
             FROM contacts
             WHERE LOWER(TRIM(email)) = ANY($1::text[])`,
            [csvEmailsForConsentLookup]
          );
          for (const row of consentRows.rows) {
            if (row.email) {
              consentByEmail.set(row.email, {
                id: row.id,
                emailStatus: row.email_status ?? "active",
                consentTier: row.consent_tier ?? "cold_no_consent",
                optedOutEmail: row.opted_out_email,
                doNotContact: row.do_not_contact,
                doNotAutoContact: row.do_not_auto_contact ?? false,
              });
            }
          }
        }
      }

      let inserted = 0;
      let duplicatesSkipped = 0;
      let updated = 0;
      let optOutPreserved = 0;
      let optOutApplied = 0;
      let invalidRows = 0;
      let errors = 0;
      let deferredToStaging = 0;
      const verticalCounts: Record<string, number> = {};
      let hotLeads = 0;
      let warmLeads = 0;
      let coldLeads = 0;
      let dealsCreated = 0;
      const insertedContactIds: number[] = [];

      const batchSize = 100;
      const contactInserts: any[] = [];
      for (const [rowIndex, record] of records.entries()) {
        // Provider rows perform native transactions during this first loop,
        // unlike the fast generic mapping pass. Renew per row, as the existing
        // request-free provider recovery does, rather than losing a five-minute
        // lease before a slow 100-row batch finishes.
        if ((isProviderExport || rowIndex % batchSize === 0) && !await heartbeatImportExecution(importExecution.id, executionClaim.claimToken!)) {
          throw new Error(`IMPORT_EXECUTION_LEASE_LOST:${importExecution.id}`);
        }
        // Logical CSV rows are one-based and allocated before validation. The
        // ledger never stores raw input; this fingerprint permits replay-safe
        // accounting without retaining PII.
        const sourceRowNumber = rowIndex + 1;
        const rowFingerprint = computeFileHash(Buffer.from(JSON.stringify(record)));
        const mapped: Record<string, string> = {};
        for (const [csvCol, value] of Object.entries(record)) {
          const normCol = csvCol.toLowerCase().trim().replace(/\s+/g, "_");
          const original = csvCol.toLowerCase().trim();
          const field = Object.hasOwn(columnMap, normCol) ? columnMap[normCol]
            : Object.hasOwn(columnMap, original) ? columnMap[original] : undefined;
          if (field && value) mapped[field] = value.trim();
        }
        if (isProviderExport) {
          const { materializeCanonicalProviderImportRow } = await import("../services/canonical-provider-import");
          const transition=await materializeCanonicalProviderImportRow({
            executionId: importExecution.id, sourceRowNumber, sourceFormat,
            claimToken:executionClaim.claimToken!,
            actorId: actor.actorId, rawRow: record,
            sourceCoordinate: (executionClaim.execution.metadata as any)?.sourceCoordinates?.[sourceRowNumber - 1],
            fileName: (executionClaim.execution.metadata as any)?.fileName,
          });
          if (transition.disposition==="created") inserted++;
          else if (transition.disposition==="matched_noop") duplicatesSkipped++;
          else if (transition.disposition==="deferred") deferredToStaging++;
          insertedContactIds.push(...transition.contactIds);
          continue;
        }

        let companyName = mapped.companyName || "";
        let firstName = sanitizeFirstName(mapped.firstName || "");
        let lastName = mapped.lastName || "";
        const email = (mapped.email || "").toLowerCase().trim();
        let phone = normalizePhoneForImport(mapped.phone || "");
        const website = mapped.website || "";

        // Google Maps Outscraper: use the business name as the display name when
        // no personal name was provided — but only if the business name is NOT itself
        // a URL (some data sources put the website in both fields).
        if (sourceFormat === "google_maps_outscraper" && companyName && !firstName) {
          const candidateName = sanitizeFirstName(companyName);
          if (candidateName) firstName = candidateName;
        }

        if (!companyName && !email && !phone) {
          invalidRows++;
          await recordImportRowDisposition({ executionId: importExecution.id, claimToken: executionClaim.claimToken!, sourceRowNumber, rowFingerprint, disposition: "rejected", reasonCode: "NO_USABLE_IDENTITY" });
          continue;
        }
        if (!firstName && !companyName) {
          invalidRows++;
          await recordImportRowDisposition({ executionId: importExecution.id, claimToken: executionClaim.claimToken!, sourceRowNumber, rowFingerprint, disposition: "rejected", reasonCode: "NO_DISPLAY_NAME" });
          continue;
        }

        let isDuplicate = false;
        let emailMatchedContact: ConsentSnapshot | undefined;
        if (email && emailSet.has(email)) {
          isDuplicate = true;
          emailMatchedContact = consentByEmail.get(email);
        } else if (phone && phone.length >= 10 && phoneSet.has(phone)) {
          isDuplicate = true;
        } else if (companyName && companySet.has(companyName.toLowerCase())) {
          isDuplicate = true;
        }

        if (isDuplicate) {
          // ── Monotonic consent merge for email-matched duplicates ────────────
          // If we have a consent snapshot for this contact (email match), check
          // whether the existing contact is already restricted OR whether the CSV
          // row is trying to apply a new restriction.  For phone/company-only
          // matches we don't have a quick consent lookup; fall through to skip.
          if (emailMatchedContact) {
            const existingRestricted = existingContactIsRestrictive(emailMatchedContact);
            const csvRestricts = csvMappedHasRestrictiveConsent(mapped);

            if (existingRestricted) {
              // Preserve: existing opt-out must not be downgraded by this CSV row.
              // The suppression helper back-pressures any pending New Lead deals.
              optOutPreserved++;
              updated++;
              const { suppressNewLeadAutoEnrollmentForContact } = await import("../services/new-lead-enrollment-job");
              suppressNewLeadAutoEnrollmentForContact(emailMatchedContact.id, "csv_import_existing_opt_out_preserved").catch(() => {});
              await recordImportRowDisposition({ executionId: importExecution.id, claimToken: executionClaim.claimToken!, sourceRowNumber, rowFingerprint, disposition: "updated", reasonCode: "EXISTING_RESTRICTIVE_CONSENT", contactId: emailMatchedContact.id });
            } else if (csvRestricts) {
              // Apply: CSV is asserting a new opt-out/DNC for a previously
              // contactable contact.  Write only the restrictive consent fields.
              optOutApplied++;
              updated++;
              const csvEmailStatus = (mapped.emailStatus || "").toLowerCase();
              const csvConsentTier = (mapped.consentTier || "").toLowerCase();
              const csvOptedOutEmail = (mapped.optedOutEmail || "").toLowerCase();
              const csvDoNotContact = (mapped.doNotContact || "").toLowerCase();
              const { applyConsentCommand } = await import("../services/consent-authority");
              const global = csvDoNotContact === "true" || csvDoNotContact === "1" || csvDoNotContact === "yes" || RESTRICTIVE_CONSENT_TIERS.has(csvConsentTier);
              await applyConsentCommand({
                subject: { type: "contact", id: emailMatchedContact.id },
                kind: global ? "global_dnc" : "opt_out",
                ...(global ? {} : { channel: "email" as const }),
                purpose: "outreach",
                eventNamespace: "csv_import",
                // Import execution plus row is one immutable occurrence. The
                // same source values in a later import are a new withdrawal.
                eventKey: `execution:${importExecution.id}:row:${rowIndex}:restrict`,
                source: "csv_import",
                evidence: { csvEmailStatus, csvConsentTier, csvOptedOutEmail, csvDoNotContact },
              });
              const { suppressNewLeadAutoEnrollmentForContact } = await import("../services/new-lead-enrollment-job");
              suppressNewLeadAutoEnrollmentForContact(emailMatchedContact.id, "csv_import_opt_out").catch(() => {});
              await recordImportRowDisposition({ executionId: importExecution.id, claimToken: executionClaim.claimToken!, sourceRowNumber, rowFingerprint, disposition: "updated", reasonCode: "RESTRICTIVE_CONSENT_APPLIED", contactId: emailMatchedContact.id });
            } else {
              duplicatesSkipped++;
              await recordImportRowDisposition({ executionId: importExecution.id, claimToken: executionClaim.claimToken!, sourceRowNumber, rowFingerprint, disposition: "matched_noop", reasonCode: "EXACT_ELIGIBLE_IDENTITY_MATCH", contactId: emailMatchedContact.id });
            }
          } else {
            duplicatesSkipped++;
            await recordImportRowDisposition({ executionId: importExecution.id, claimToken: executionClaim.claimToken!, sourceRowNumber, rowFingerprint, disposition: "matched_noop", reasonCode: "EXACT_ELIGIBLE_IDENTITY_MATCH" });
          }
          continue;
        }

        if (email) emailSet.add(email);
        if (phone && phone.length >= 10) phoneSet.add(phone);
        if (companyName) companySet.add(companyName.toLowerCase());

        const industry = mapped.industry || mapped.vertical || "";
        const keywords = mapped.keywords || mapped.keyword || "";
        const vertical = classifyVerticalForImport(industry, "", companyName, keywords);

        verticalCounts[vertical] = (verticalCounts[vertical] || 0) + 1;

        const ratingStr = mapped.rating || "";
        const reviewCount = mapped.reviewCount || "";
        const noteParts = [];
        if (ratingStr) noteParts.push(`Rating: ${ratingStr}`);
        if (reviewCount) noteParts.push(`Reviews: ${reviewCount}`);
        if (mapped.notes) noteParts.push(mapped.notes);

        const tags = ["csv-import", sourceFormat.replace(/_/g, "-")];
        if (mapped.tags) tags.push(...mapped.tags.split(",").map(t => t.trim()).filter(Boolean));

        const rating = parseFloat(ratingStr) || 0;
        const reviews = parseInt(reviewCount) || 0;
        const description = `${mapped.notes || ""} ${mapped.keywords || mapped.keyword || ""} ${companyName}`.toLowerCase();

        if (sourceFormat === "google_maps_outscraper") {
          if (vertical === "Auto" || /auto|repair|mechanic|tire|collision|body shop|transmission|brake/i.test(description)) {
            if (rating >= 4.3) tags.push("quality-high-rating");
            if (reviews >= 20) tags.push("quality-reviews-20+");
            if (/independent|owner/i.test(description)) tags.push("quality-independent");
            if (/service menu|oil change|brake|transmission|engine|diagnostic/i.test(description)) tags.push("quality-service-menu");
            if (/multiple|multi.?bay|2 location|3 location/i.test(description)) tags.push("quality-multi-bay");
            if (/financing|fleet/i.test(description)) tags.push("quality-financing-fleet");
            if (rating >= 4.3 && reviews >= 20) tags.push("priority-outreach");
          }

          if (vertical === "Salon/Spa" || /med.?spa|medspa|aesthetic|botox|filler|laser|body.?contour/i.test(description)) {
            if (/membership|package|monthly/i.test(description)) tags.push("quality-memberships");
            if (/book|booking|appointment|schedule/i.test(description)) tags.push("quality-online-booking");
            if (/instagram|ig\b|@/i.test(description)) tags.push("quality-instagram-active");
            if (reviews >= 50) tags.push("quality-reviews-50+");
            if (/multiple provider|staff|team|np\b|pa\b|physician/i.test(description)) tags.push("quality-multi-provider");
            if (/botox|filler|laser|weight.?loss|body.?sculpt|coolsculpt/i.test(description)) tags.push("quality-aesthetic-services");
            if (reviews >= 50 && /membership|package/i.test(description)) tags.push("priority-outreach");
          }

          if (vertical === "Healthcare" || /dental|dentist|chiro|optom|podiatr|dermat|urgent care|pt\b|physical therapy|behavioral/i.test(description)) {
            if (/private|independent|solo|owner/i.test(description)) tags.push("quality-private-practice");
            if (/multiple provider|staff|team|associate|partner/i.test(description)) tags.push("quality-multi-provider");
            if (/text.?to.?pay|online pay|patient portal|digital/i.test(description)) tags.push("quality-text-to-pay");
            if (reviews >= 30) tags.push("quality-reviews-30+");
            if (/payment plan|financing|care.?credit/i.test(description)) tags.push("quality-payment-plans");
            if (/private.?pay|cash.?pay|self.?pay|cosmetic|elective/i.test(description)) tags.push("quality-private-pay");
            if (reviews >= 30 && /private|independent/i.test(description)) tags.push("priority-outreach");
          }
        }

        contactInserts.push({
          __sourceRowNumber: sourceRowNumber,
          __rowFingerprint: rowFingerprint,
          // This is deliberately a snapshot of source-row values, not the
          // contact mutation (which contains defaults and derived fields).
          __cro03EvidenceValues: {
            ...(companyName ? { business_name: companyName } : {}),
            ...(website ? { website } : {}),
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            ...(mapped.address ? { address: mapped.address } : {}),
            ...(mapped.city ? { city: mapped.city } : {}),
            ...(mapped.state ? { state: mapped.state } : {}),
            ...(mapped.title ? { owner_title: mapped.title } : {}),
          },
          firstName: firstName || "",   // already sanitized; blank is better than a URL
          lastName: lastName || "",
          // contacts.email is NOT NULL with a unique index (per non-archived
          // row). Persisting "" for every row lacking a real email would
          // collide on that unique index after the first such row, causing
          // onConflictDoNothing() to silently skip every subsequent valid
          // no-email row. Generate a synthetic, guaranteed-unique
          // placeholder instead so valid rows without an email can still be
          // imported. This placeholder is never added to `emailSet` (that
          // only happens when the CSV-parsed `email` is truthy), so it has
          // no effect on app-level email dedupe.
          // Stable per execution/row so an interrupted retry cannot create a
          // second no-email contact. It is excluded from identity matching and
          // provider projection by the canonical command.
          email: email || `no-email-${importExecution.id}-${sourceRowNumber}@no-email.libertybancard.internal`,
          phone: phone || "",
          companyName: companyName || "",
          title: mapped.title || (sourceFormat === "google_maps_outscraper" ? "Owner" : null),
          address: mapped.address || null,
          city: mapped.city || null,
          state: mapped.state || null,
          website: website || null,
          linkedinUrl: mapped.linkedinUrl || null,
          facebookUrl: mapped.facebookUrl || null,
          industry: industry || null,
          vertical: vertical || null,
          leadSource: forcedLeadSource || mapped.leadSource || sourceFormat,
          employeeCount: mapped.employeeCount ? parseInt(mapped.employeeCount) || null : null,
          annualRevenue: mapped.annualRevenue || null,
          tags,
          notes: noteParts.join("; ") || null,
          status: "New",
          monthlyVolume: mapped.monthlyVolume || null,
          currentProvider: mapped.currentProvider || null,
          // Provenance — stamped here so every bulk-inserted contact has intake origin set
          sourceCategory: "csv_import",
          primarySourceCategory: "csv_import",
          primarySourceType: csvSourceType,
          // importBatchId links every contact to its import_executions record so
          // admins can query "all contacts from batch X" without joining tables.
          importBatchId: importExecution.id,
        });
      }

      let skippedRows = 0;

      // Write an initial progress snapshot after pre-processing so that even
      // all-duplicate / all-invalid imports (where contactInserts is empty and
      // the batch loop never runs) still leave a non-null processedRows value.
      const preFilteredRows = invalidRows + duplicatesSkipped;
      if (preFilteredRows > 0 && contactInserts.length === 0) {
        try {
          await storage.updateCsvImport(importRecord.id, {
            processedRows: preFilteredRows,
            newRecords: 0,
            duplicatesSkipped,
            invalidRows,
            skippedRows: 0,
            errorsCount: 0,
            lastProgressAt: new Date(),
            status: "processing",
          });
          if (!await heartbeatImportExecution(importExecution.id, executionClaim.claimToken!)) {
            throw new Error("CSV import processor lease lost");
          }
        } catch (e: any) {
          console.warn(`[CSV Import] Pre-filter progress write failed for import ${importRecord.id}:`, e?.message || e);
        }
      }

      for (let i = 0; i < contactInserts.length; i += batchSize) {
        const batch = contactInserts.slice(i, i + batchSize);
        try {
          const result: any[] = [];
          for (const source of batch) {
            const { __sourceRowNumber, __rowFingerprint, __cro03EvidenceValues, ...mutation } = source;
            const contact = await writeContact({
              mode: "local_only",
              mutation,
              provenance: {
                sourceCategory: "csv_import",
                sourceType: csvSourceType,
                eventKey: `import:${importExecution.id}:row:${__sourceRowNumber}`,
                importExecutionId: importExecution.id,
                importClaimToken: executionClaim.claimToken!,
                sourceRowNumber: __sourceRowNumber,
                rowFingerprint: __rowFingerprint,
                actorType: actor.actorType,
                actorId: actor.actorId,
              },
              actor: {
                actorType: actor.actorType,
                actorId: actor.actorId,
                userId: actor.userId ?? actor.actorId,
              },
              rowDisposition: {
                createdReasonCode: "LOCAL_CONTACT_CREATED",
                matchedReasonCode: "EXACT_ELIGIBLE_IDENTITY_MATCH",
              },
            });
            result.push({ ...contact, _cro03EvidenceValues: __cro03EvidenceValues, _rowFingerprint: __rowFingerprint });
          }
          inserted += result.filter((row) => row._intakeOutcome === "created").length;
          // writeContact either returns a durable disposition or throws; ledger
          // summaries, not a batch-length subtraction, are reconciliation truth.
          for (const r of result.filter((row) => row._intakeOutcome === "created")) {
            insertedContactIds.push(r.id);
            const { auditChange } = await import("../services/audit-change");
            auditChange({ actorType: "system", action: "contact_created", entityType: "contact", entityId: r.id, before: null, after: r as unknown as Record<string, unknown> }).catch(() => {});
          }
          for (const _row of result) {
            // CSV rows are acquisition evidence, never an inbound occurrence.
            // A later explicit request must enter through its own adapter and
            // claim its own request key; import does not score/create a deal,
            // claim an inbound request, or infer consent.
            coldLeads++;
          }
        } catch (batchErr: any) {
          // Do not fall back to a raw insert. The execution remains recoverable
          // because the lease expires and row dispositions are immutable.
          throw batchErr;
        }

        // Persist running totals after every batch so a crash mid-import
        // leaves a visible partial-progress record rather than all-zeros.
        // This is awaited so the heartbeat is durably written before the
        // next batch starts — a crash after a batch commit but before this
        // write completes would leave at most one batch unaccounted for.
        const batchProcessedRows = inserted + updated + duplicatesSkipped + invalidRows + skippedRows + errors;
        try {
          await storage.updateCsvImport(importRecord.id, {
            processedRows: batchProcessedRows,
            newRecords: inserted,
            updatedRecords: updated,
            duplicatesSkipped,
            invalidRows,
            skippedRows,
            errorsCount: errors,
            optOutPreserved,
            optOutApplied,
            lastProgressAt: new Date(),
            status: "processing",
          });
        } catch (progressErr: any) {
          console.warn(`[CSV Import] Per-batch progress write failed for import ${importRecord.id}:`, progressErr?.message || progressErr);
        }
        if (!await heartbeatImportExecution(importExecution.id, executionClaim.claimToken!)) {
          throw new Error("CSV import processor lease lost");
        }
      }

      const ledgerCompletion = await completeImportExecution({
        executionId: importExecution.id,
        claimToken: executionClaim.claimToken!,
        expectedRows: records.length,
      });
      if (!ledgerCompletion.completed) {
        throw new Error(`CSV ledger reconciliation failed: ${ledgerCompletion.total}/${records.length} terminal rows`);
      }
      const durableOutcomes = importDispositionCompatibility(ledgerCompletion.counts);

      if (insertedContactIds.length > 0) {
        const { inArray } = await import("drizzle-orm");
        const newContacts = await db.select().from(contacts)
          .where(inArray(contacts.id, insertedContactIds));
        for (const rc of newContacts) {
          if (!rc.companyName) continue;
          try {
            const bizResult = await ingestBusiness({
              name: rc.companyName,
              website: rc.website,
              phone: rc.phone,
              email: rc.email,
              address: rc.address,
              city: rc.city,
              state: rc.state,
              vertical: rc.vertical,
              industryPrimary: rc.industry,
              facebookUrl: rc.facebookUrl,
              sourceType: sourceFormat,
              sourceLabel: `csv_import_${importRecord.id}`,
              importBatchId: `csv_${importRecord.id}`,
              contactId: rc.id,
            });
            await recordContactBusinessLinkCandidate({
              contactId: rc.id, businessId: bizResult.businessId,
              source: "csv_import", sourceVersion: sourceFormat,
              candidateKey: `csv:${importRecord.id}:${rc.id}:${bizResult.businessId}`, confidence: 70,
            });
            const { auditChange } = await import("../services/audit-change");
            auditChange({ actorType: "system", action: "contact_business_link_candidate_recorded", entityType: "contact", entityId: rc.id, before: null, after: { candidateBusinessId: bizResult.businessId } }).catch(() => {});
          } catch (bizErr) {
            console.warn(`[CSV Import] Business ingest failed for ${rc.companyName}:`, bizErr);
          }
        }
      }

      await storage.updateCsvImport(importRecord.id, {
        newRecords: durableOutcomes.created,
        duplicatesSkipped: durableOutcomes.matched_noop,
        updatedRecords: durableOutcomes.updated,
        invalidRows: durableOutcomes.rejected,
        skippedRows: durableOutcomes.deferred,
        errorsCount: durableOutcomes.failed,
        processedRows: durableOutcomes.total,
        lastProgressAt: new Date(),
        verticalBreakdown: verticalCounts,
        status: "completed",
        completedAt: new Date(),
        dealsCreated,
        hotLeads,
        warmLeads,
        coldLeads,
        optOutPreserved,
        optOutApplied,
      });

      const updatedImport = await storage.getCsvImport(importRecord.id);

      // Audit trail: record that a CSV import completed so admins can trace data ingestion events
      await storage.createAuditLog({
        action: "csv_import_completed",
        entityType: "csv_import",
        entityId: importRecord.id,
        actorType: actor.actorType,
        actorId: actor.actorId,
        details: {
          filename: importRecord.fileName,
          ...durableOutcomes,
          totalRows: records.length,
        },
      } as any).catch((e: any) => console.error("[CSV Import] audit log failed:", e.message));

      return {
        import: updatedImport,
        ...durableOutcomes,
        dealsCreated,
        verticalBreakdown: verticalCounts,
        sourceFormat,
        optOutPreserved,
        optOutApplied,
        deferredToStaging,
      };
      };
      registerPersistedCsvProcessor(processCsvImport);
      const processingArgs = {
        records,
        executionClaim,
        importRecord,
        sourceFormat,
        actor: {
          actorType: "user" as const,
          actorId: String(principal?.id ?? ""),
          userId: String(principal?.id ?? ""),
        },
        filename: fileName,
      };
      if (sourceFormat === "google_maps_outscraper" || sourceFormat === "apollo_lead_list") {
        // The originals and permanent claim are already committed. Keep the
        // same request-free processor/restart recovery; do not hold an HTTP
        // gateway open for native row processing or report it as completed.
        void processPersistedCsvImport(processingArgs).catch(async (err: any) => {
          console.error("CSV import processing error:", err);
          try {
            await failCsvImportProjection(executionClaim);
          } catch (cleanupError) {
            console.error("CSV import execution-specific cleanup failed:", cleanupError);
            if (err && typeof err === "object") Object.defineProperty(err, "cleanupError", {value:cleanupError});
          }
        });
        return res.status(202).json({
          status: "processing",
          executionId: executionClaim.execution.id,
          fileHash: csvHash,
          import: importRecord,
          sourceFormat,
          totalRows: records.length,
        });
      }
      const response = await processPersistedCsvImport(processingArgs);
      res.status(201).json(response);
    } catch (err: any) {
      console.error("CSV import error:", err);
      try {
        if (requestClaim) await failCsvImportProjection(requestClaim);
      } catch (cleanupError) {
        console.error("CSV import execution-specific cleanup failed:", cleanupError);
        if (err && typeof err==="object") Object.defineProperty(err,"cleanupError",{value:cleanupError});
      }
      serverError(res, err);
    }
  });

  // ============================================================
  // MASTER LEAD DATABASE — staged import pipeline (Task 1052)
  // ============================================================

  // Attempt to read a Google Sheet via Sheets API (proxy through google-drive connector).
  // Returns rows if successful; returns { apiError } if access fails.
  app.post("/api/master-leads/try-sheets-api", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const { sheetId, tabName = "CRM Staging" } = req.body;
    if (!sheetId || typeof sheetId !== "string") {
      return res.status(400).json({ message: "sheetId is required" });
    }
    try {
      const { fetchSheetViaApi } = await import("../services/master-lead-import");
      const { rows, headers } = await fetchSheetViaApi(sheetId, tabName);
      res.json({ success: true, rowCount: rows.length, headers, preview: rows.slice(0, 3) });
    } catch (err: any) {
      console.warn("[MasterLeadImport] Sheets API attempt failed:", err.message);
      res.json({
        success: false,
        apiError: err.message || "Unknown error accessing Google Sheets API",
      });
    }
  });

  // Trigger full import from Google Sheets API (async, fires in background)
  app.post("/api/master-leads/import-from-sheet", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const { sheetId, sheetName, tabName = "CRM Staging" } = req.body;
    if (!sheetId) return res.status(400).json({ message: "sheetId required" });
    try {
      const { fetchSheetViaApi, processMasterLeadBatch } = await import("../services/master-lead-import");
      const { masterLeadBatches } = await import("@shared/schema");
      const batchName = sheetName || `Liberty Bancard Priority Domain Enrichment - ${new Date().toISOString().slice(0, 10)}`;
      const [batch] = await db.insert(masterLeadBatches).values({
        batchName,
        sheetId,
        sheetName: batchName,
        tabName,
        sourceMethod: "sheets_api",
        status: "processing",
        importedBy: String((req.user as any)?.id ?? "admin"),
      }).returning();
      res.json({ batchId: batch.id, message: "Import started", batchName });
      // Fire-and-forget background import
      (async () => {
        try {
          const { rows } = await fetchSheetViaApi(sheetId, tabName);
          await processMasterLeadBatch(batch.id, rows, { sheetId, sheetName: batchName, tabName });
        } catch (err: any) {
          console.error("[MasterLeadImport] Sheet import failed:", err.message);
          const { eq } = await import("drizzle-orm");
          const { masterLeadBatches: mlb } = await import("@shared/schema");
          await db.update(mlb).set({ status: "failed", errorMessage: err.message }).where(eq(mlb.id, batch.id));
        }
      })().catch(console.error);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Import from uploaded CSV (fallback path when Sheets API is unavailable)
  app.post("/api/master-leads/import-csv", isAuthenticated, uploadLarge.single("file"), async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const filePath = req.file.path;
    const fileName = req.file.originalname || "upload.csv";
    if (path.extname(fileName).toLowerCase() !== ".csv") {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(400).json({ message: "Only CSV files are supported." });
    }
    let csvContent: string;
    try {
      csvContent = fs.readFileSync(filePath, "utf-8");
    } catch (err: any) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(400).json({ message: `Could not read uploaded file: ${err.message}` });
    } finally {
      try { fs.unlinkSync(filePath); } catch {}
    }

    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
    }) as Record<string, string>[];

    if (records.length === 0) {
      return res.status(400).json({ message: "File is empty or could not be parsed" });
    }

    try {
      const { processMasterLeadBatch } = await import("../services/master-lead-import");
      const { masterLeadBatches } = await import("@shared/schema");
      const sheetName = (req.body.sheetName as string) || "Liberty Bancard Priority Domain Enrichment - 2026-07-20";
      const tabName = (req.body.tabName as string) || "CRM Staging";
      const [batch] = await db.insert(masterLeadBatches).values({
        batchName: fileName,
        sheetName,
        tabName,
        sourceMethod: "csv_upload",
        status: "processing",
        totalRows: records.length,
        importedBy: String((req.user as any)?.id ?? "admin"),
      }).returning();

      res.json({ batchId: batch.id, message: "Import started", totalRows: records.length });

      // Fire-and-forget
      (async () => {
        try {
          await processMasterLeadBatch(batch.id, records, {
            sheetName,
            tabName,
          });
        } catch (err: any) {
          console.error("[MasterLeadImport] CSV import failed:", err.message);
          const { eq } = await import("drizzle-orm");
          const { masterLeadBatches: mlb } = await import("@shared/schema");
          await db.update(mlb).set({ status: "failed", errorMessage: err.message }).where(eq(mlb.id, batch.id));
        }
      })().catch(console.error);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // List all master lead batches
  app.get("/api/master-leads/batches", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const { masterLeadBatches } = await import("@shared/schema");
      const { desc } = await import("drizzle-orm");
      const batches = await db.select().from(masterLeadBatches).orderBy(desc(masterLeadBatches.createdAt)).limit(50);
      res.json(batches);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Get a single batch status + counts
  app.get("/api/master-leads/batches/:id", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const { masterLeadBatches } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [batch] = await db.select().from(masterLeadBatches).where(eq(masterLeadBatches.id, req.params.id as any));
      if (!batch) return res.status(404).json({ message: "Batch not found" });
      res.json(batch);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // List staged leads for a batch
  app.get("/api/master-leads/batches/:id/leads", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const { masterLeads } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const status = (req.query.status as string) || "staged";
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Number(req.query.offset) || 0;
      const rows = await db.select().from(masterLeads)
        .where(and(eq(masterLeads.importBatchId, req.params.id as any), eq(masterLeads.status, status as any)))
        .limit(limit).offset(offset);
      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── Master Lead Database admin endpoints ─────────────────────────────────

  // Aggregate stats: counts by status, source breakdown, fit-tier breakdown, vertical breakdown
  app.get("/api/master-leads/stats", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const [byStatus, bySource, byFitTier, byVertical, totalRow] = await Promise.all([
        db.execute(sql`SELECT status, COUNT(*)::int AS count FROM master_leads GROUP BY status ORDER BY count DESC`),
        db.execute(sql`SELECT source, COUNT(*)::int AS count FROM master_leads WHERE source IS NOT NULL GROUP BY source ORDER BY count DESC LIMIT 20`),
        db.execute(sql`SELECT fit_tier, COUNT(*)::int AS count FROM master_leads WHERE fit_tier IS NOT NULL GROUP BY fit_tier ORDER BY count DESC`),
        db.execute(sql`SELECT vertical, COUNT(*)::int AS count FROM master_leads WHERE vertical IS NOT NULL GROUP BY vertical ORDER BY count DESC LIMIT 20`),
        db.execute(sql`SELECT COUNT(*)::int AS total FROM master_leads`),
      ]);
      const suppressionRows = await db.execute(sql`
        SELECT suppression_reason, COUNT(*)::int AS count
        FROM master_leads
        WHERE status = 'suppressed' AND suppression_reason IS NOT NULL
        GROUP BY suppression_reason ORDER BY count DESC
      `);
      res.json({
        total: (totalRow.rows[0] as any)?.total ?? 0,
        byStatus: byStatus.rows,
        bySource: bySource.rows,
        byFitTier: byFitTier.rows,
        byVertical: byVertical.rows,
        suppressionReport: suppressionRows.rows,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Filterable lead list for the admin Master Lead Database page
  app.get("/api/master-leads/leads", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const { masterLeads } = await import("@shared/schema");
      const { eq, and, ilike, desc } = await import("drizzle-orm");
      const status = req.query.status as string | undefined;
      const vertical = req.query.vertical as string | undefined;
      const fitTier = req.query.fitTier as string | undefined;
      const source = req.query.source as string | undefined;
      const batchId = req.query.batchId as string | undefined;
      const search = req.query.search as string | undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;

      // Build a single raw-SQL WHERE clause so the same predicate applies to
      // both the rows query and the count query (avoids mismatch on search).
      let whereClause = sql`TRUE`;
      if (status)   whereClause = sql`${whereClause} AND status = ${status}`;
      if (vertical) whereClause = sql`${whereClause} AND vertical = ${vertical}`;
      if (fitTier)  whereClause = sql`${whereClause} AND fit_tier = ${fitTier}`;
      if (source)   whereClause = sql`${whereClause} AND source = ${source}`;
      if (batchId)  whereClause = sql`${whereClause} AND import_batch_id = ${batchId}::uuid`;
      if (search) {
        const p = `%${search}%`;
        whereClause = sql`${whereClause} AND (
          company ILIKE ${p} OR email ILIKE ${p}
          OR domain ILIKE ${p} OR contact_name ILIKE ${p}
        )`;
      }

      const [rowsResult, countResult] = await Promise.all([
        db.execute(sql`
          SELECT
            id, import_batch_id AS "importBatchId", status,
            company, normalized_company AS "normalizedCompany",
            domain, email, email_type AS "emailType",
            phone, normalized_phone AS "normalizedPhone",
            contact_name AS "contactName", contact_title AS "contactTitle",
            vertical, quality_score AS "qualityScore",
            fit_tier AS "fitTier", outreach_readiness AS "outreachReadiness",
            readiness_reason AS "readinessReason",
            source, source_path AS "sourcePath",
            source_modified_date AS "sourceModifiedDate",
            address, city, state, website,
            email_valid AS "emailValid", phone_valid AS "phoneValid",
            sms_eligible AS "smsEligible",
            sheet_id AS "sheetId", sheet_name AS "sheetName",
            tab_name AS "tabName", row_number AS "rowNumber",
            canonical_lead_id AS "canonicalLeadId",
            duplicate_of_id AS "duplicateOfId",
            suppression_reason AS "suppressionReason",
            promoted_at AS "promotedAt", promoted_by AS "promotedBy",
            notes, imported_at AS "importedAt", created_at AS "createdAt"
          FROM master_leads
          WHERE ${whereClause}
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `),
        db.execute(sql`SELECT COUNT(*)::int AS total FROM master_leads WHERE ${whereClause}`),
      ]);
      res.json({ rows: rowsResult.rows, total: (countResult.rows[0] as any)?.total ?? 0, limit, offset });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // CSV export of master leads with the same filter params as /api/master-leads/leads (#1079)
  app.get("/api/master-leads/leads/export", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const status = req.query.status as string | undefined;
      const vertical = req.query.vertical as string | undefined;
      const fitTier = req.query.fitTier as string | undefined;
      const source = req.query.source as string | undefined;
      const batchId = req.query.batchId as string | undefined;
      const search = req.query.search as string | undefined;

      let whereClause = sql`TRUE`;
      if (status)   whereClause = sql`${whereClause} AND status = ${status}`;
      if (vertical) whereClause = sql`${whereClause} AND vertical = ${vertical}`;
      if (fitTier)  whereClause = sql`${whereClause} AND fit_tier = ${fitTier}`;
      if (source)   whereClause = sql`${whereClause} AND source = ${source}`;
      if (batchId)  whereClause = sql`${whereClause} AND import_batch_id = ${batchId}::uuid`;
      if (search) {
        const p = `%${search}%`;
        whereClause = sql`${whereClause} AND (
          company ILIKE ${p} OR email ILIKE ${p}
          OR domain ILIKE ${p} OR contact_name ILIKE ${p}
        )`;
      }

      const result = await db.execute(sql`
        SELECT
          id, status, company, domain, email, email_type,
          phone, contact_name, contact_title,
          vertical, quality_score, fit_tier, outreach_readiness,
          readiness_reason, source, source_path,
          address, city, state, website,
          email_valid, phone_valid, sms_eligible,
          suppression_reason, promoted_at, promoted_by,
          notes, imported_at, created_at
        FROM master_leads
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT 10000
      `);

      const rows = result.rows as Record<string, unknown>[];
      if (rows.length === 0) {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="master-leads-export.csv"`);
        return res.send("id,status,company,domain,email,email_type,phone,contact_name,contact_title,vertical,quality_score,fit_tier,outreach_readiness,source,address,city,state,website,email_valid,phone_valid,sms_eligible,suppression_reason,promoted_at,notes,imported_at\n");
      }

      const headers = Object.keys(rows[0]);
      const escape = (v: unknown): string => {
        if (v == null) return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csvLines = [
        headers.join(","),
        ...rows.map(row => headers.map(h => escape(row[h])).join(",")),
      ];

      const ts = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="master-leads-${status ?? "all"}-${ts}.csv"`);
      await storage.createAuditLog({ action: "master_leads_csv_exported", entityType: "master_lead", entityId: 0, userId: (req.user as any)?.id ?? null, details: { rowCount: rows.length, filters: { status, vertical, fitTier, source } } });
      res.send(csvLines.join("\n"));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // SMS-blocked status: check whether GHL_PHONE_NUMBER_ID and A2P_REGISTRATION_ID are configured
  app.get("/api/master-leads/sms-status", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const ghlPhoneSet = !!(process.env.GHL_PHONE_NUMBER_ID && process.env.GHL_PHONE_NUMBER_ID.trim());
    const a2pSet = !!(process.env.A2P_REGISTRATION_ID && process.env.A2P_REGISTRATION_ID.trim());
    res.json({
      smsEligible: ghlPhoneSet && a2pSet,
      ghlPhoneNumberIdSet: ghlPhoneSet,
      a2pRegistrationIdSet: a2pSet,
      blockedReason: !ghlPhoneSet && !a2pSet
        ? "GHL_PHONE_NUMBER_ID and A2P_REGISTRATION_ID are not set"
        : !ghlPhoneSet
          ? "GHL_PHONE_NUMBER_ID is not set"
          : !a2pSet
            ? "A2P_REGISTRATION_ID is not set"
            : null,
    });
  });

  // Promote a lead from ready_for_internal_test → ready_for_controlled_cohort
  // Requires explicit admin confirmation — never automatic.
  app.post("/api/master-leads/leads/:id/promote", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const { confirmed } = req.body;
    if (!confirmed) return res.status(400).json({ message: "confirmed: true is required" });
    try {
      const { masterLeads, masterLeadBatches, auditLogs } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [lead] = await db.select().from(masterLeads).where(eq(masterLeads.id, req.params.id as any));
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (lead.status !== "ready_for_internal_test") {
        return res.status(409).json({
          message: `Lead is '${lead.status}' — only leads in ready_for_internal_test can be promoted`,
        });
      }
      const now = new Date();
      const actorId = String((req.user as any)?.id ?? "admin");
      await db.update(masterLeads)
        .set({ status: "ready_for_controlled_cohort", promotedAt: now, promotedBy: actorId })
        .where(eq(masterLeads.id, req.params.id as any));
      // Increment batch promoted_count
      if (lead.importBatchId) {
        await db.execute(sql`
          UPDATE master_lead_batches SET promoted_count = COALESCE(promoted_count, 0) + 1
          WHERE id = ${lead.importBatchId}
        `);
      }
      // Audit log
      await db.execute(sql`
        INSERT INTO audit_logs (user_id, action, entity_type, entity_key, actor_type, actor_id, details)
        VALUES (
          ${actorId}, 'master_lead_promoted', 'master_lead', ${lead.id}, 'user', ${actorId},
          ${JSON.stringify((await import("../services/audit-sanitizer")).sanitizeAuditPayload({ leadId: lead.id, company: lead.company, email: lead.email, domain: lead.domain, fromStatus: "ready_for_internal_test", toStatus: "ready_for_controlled_cohort", batchId: lead.importBatchId }))}::jsonb
        )
      `);
      res.json({ success: true, leadId: lead.id, status: "ready_for_controlled_cohort" });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Bulk promote: promote all ready_for_internal_test leads in a batch
  app.post("/api/master-leads/batches/:id/promote-all", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const { confirmed } = req.body;
    if (!confirmed) return res.status(400).json({ message: "confirmed: true is required" });
    try {
      const now = new Date();
      const actorId = String((req.user as any)?.id ?? "admin");
      const result = await db.execute(sql`
        UPDATE master_leads
        SET status = 'ready_for_controlled_cohort', promoted_at = ${now}, promoted_by = ${actorId}
        WHERE import_batch_id = ${req.params.id}
          AND status = 'ready_for_internal_test'
        RETURNING id
      `);
      const count = result.rows.length;
      if (count > 0) {
        await db.execute(sql`
          UPDATE master_lead_batches SET promoted_count = COALESCE(promoted_count, 0) + ${count}
          WHERE id = ${req.params.id}
        `);
        await db.execute(sql`
          INSERT INTO audit_logs (user_id, action, entity_type, entity_key, actor_type, actor_id, details)
          VALUES (
            ${actorId}, 'master_leads_bulk_promoted', 'master_lead_batch', ${req.params.id},
            'user', ${actorId},
            ${JSON.stringify((await import("../services/audit-sanitizer")).sanitizeAuditPayload({ batchId: req.params.id, promotedCount: count }))}::jsonb
          )
        `);
      }
      res.json({ success: true, promotedCount: count });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Trigger backfill: copy existing imported contacts into master_leads
  app.post("/api/master-leads/backfill", isAuthenticated, async (req, res) => {
    if (!(globalThis as { __BT10_DURABLE_LONG_OPERATION_OWNER__?: boolean }).__BT10_DURABLE_LONG_OPERATION_OWNER__) {
      return res.status(503).json({ code: "DURABLE_COMMAND_REQUIRED", message: "Master-lead backfill requires a durable command." });
    }
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    res.json({ message: "Backfill started in background", started: true });
    setImmediate(async () => {
      try {
        const { runMasterLeadBackfill } = await import("../services/master-lead-backfill");
        await runMasterLeadBackfill();
      } catch (err: any) {
        console.error("[MasterLeadBackfill] Error:", err.message);
      }
    });
  });

  // Backfill progress
  app.get("/api/master-leads/backfill-progress", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    const progress = await storage.getSystemSetting("master_lead_backfill_progress");
    res.json(progress || { status: "idle" });
  });

  // =========================================================
  // MI-07: PIPELINE PROMOTION ROUTES
  // =========================================================

  // Pipeline stats: counts derived from staging receipts
  app.get("/api/master-leads/pipeline-stats", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const [stagedResult, suppressedResult, duplicateResult, promotedResult] = await Promise.all([
        // staged = currently staged (not yet promoted/suppressed)
        db.execute(sql`SELECT COUNT(*)::int AS cnt FROM master_leads WHERE pipeline_origin='cro03_pipeline' AND status='staged'`),
        db.execute(sql`SELECT COUNT(*)::int AS cnt FROM master_lead_staging_receipts WHERE disposition='suppressed'`),
        db.execute(sql`SELECT COUNT(*)::int AS cnt FROM master_lead_staging_receipts WHERE disposition='duplicate'`),
        db.execute(sql`SELECT COUNT(*)::int AS cnt FROM master_leads WHERE pipeline_origin='cro03_pipeline' AND status='promoted'`),
      ]);
      // readyToPromote = staged rows that pass the core promotion preconditions:
      // - businesses.email_discovery_status = 'provider_valid'
      // - no open canonical_conflict_evidence row for the business
      // This is a best-effort server-side count; per-row enforcement remains in the promote endpoint.
      const readyResult = await db.execute(sql`
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
      `);
      const staged = Number((stagedResult.rows[0] as any)?.cnt ?? 0);
      res.json({
        staged,
        readyToPromote: Number((readyResult.rows[0] as any)?.cnt ?? 0),
        suppressed: Number((suppressedResult.rows[0] as any)?.cnt ?? 0),
        duplicates: Number((duplicateResult.rows[0] as any)?.cnt ?? 0),
        promoted: Number((promotedResult.rows[0] as any)?.cnt ?? 0),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // List pipeline-staged leads (for Pipeline Review tab)
  app.get("/api/master-leads/pipeline", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { status = "staged", generationId, fitTier, county, page = "0", limit = "50" } = req.query as Record<string, string>;
      const offset = Number(page) * Number(limit);

      let whereClause = sql`ml.pipeline_origin = 'cro03_pipeline'`;
      if (status) whereClause = sql`${whereClause} AND ml.status = ${status}`;
      if (generationId) whereClause = sql`${whereClause} AND ml.cro03_generation_id = ${generationId}::uuid`;
      if (fitTier) whereClause = sql`${whereClause} AND ml.fit_tier = ${fitTier}`;
      if (county) whereClause = sql`${whereClause} AND ml.county_fips = ${county}`;

      const leadsResult = await db.execute(sql`
        SELECT
          ml.id, ml.status, ml.company, ml.normalized_company, ml.domain,
          ml.masked_email, ml.email_type, ml.phone, ml.contact_name, ml.contact_title,
          ml.vertical, ml.county_fips, ml.quality_score, ml.fit_tier,
          ml.outreach_readiness, ml.readiness_reason,
          ml.canonical_business_id, ml.cro03_generation_id::text,
          ml.promoted_at, ml.promoted_by, ml.suppressed_at, ml.created_at,
          (
            SELECT COUNT(*)::int FROM canonical_conflict_evidence cce
            WHERE (cce.business_id_a = ml.canonical_business_id OR cce.business_id_b = ml.canonical_business_id)
              AND cce.status = 'open'
          ) AS open_conflict_count
        FROM master_leads ml
        WHERE ${whereClause}
        ORDER BY ml.created_at DESC
        LIMIT ${Number(limit)} OFFSET ${offset}
      `);

      const countResult = await db.execute(sql`
        SELECT COUNT(*)::int AS total FROM master_leads ml WHERE ${whereClause}
      `);

      // Map snake_case SQL columns to camelCase for the UI contract
      const leads = (leadsResult.rows as any[]).map((r) => ({
        id: r.id,
        status: r.status,
        company: r.company,
        normalizedCompany: r.normalized_company,
        domain: r.domain,
        maskedEmail: r.masked_email,
        emailType: r.email_type,
        phone: r.phone,
        contactName: r.contact_name,
        contactTitle: r.contact_title,
        vertical: r.vertical,
        countyFips: r.county_fips,
        qualityScore: r.quality_score != null ? Number(r.quality_score) : null,
        fitTier: r.fit_tier,
        outreachReadiness: r.outreach_readiness,
        readinessReason: r.readiness_reason,
        canonicalBusinessId: r.canonical_business_id != null ? Number(r.canonical_business_id) : null,
        cro03GenerationId: r.cro03_generation_id,
        promotedAt: r.promoted_at,
        promotedBy: r.promoted_by,
        suppressedAt: r.suppressed_at,
        createdAt: r.created_at,
        openConflictCount: Number(r.open_conflict_count ?? 0),
      }));

      res.json({
        leads,
        total: Number((countResult.rows[0] as any)?.total ?? 0),
        page: Number(page),
        limit: Number(limit),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Promotion preview for a single lead (no writes)
  app.get("/api/master-leads/pipeline/:id/promotion-check", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { checkPromotionPreconditions } = await import("../services/master-leads/pipeline-promotion");
      const masterLeadId = String(req.params.id);
      const check = await checkPromotionPreconditions(masterLeadId);
      res.json({
        masterLeadId,
        eligible: check.blocker === null,
        blocker: check.blocker,
        message: (check as any).message ?? null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Promote a single pipeline lead to a contact
  app.post("/api/master-leads/pipeline/:id/promote", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { promoteMasterLead, checkPromotionPreconditions } = await import("../services/master-leads/pipeline-promotion");
      const masterLeadId = String(req.params.id);

      // Pre-check for clear fast-fail on obviously invalid rows, but allow
      // ALREADY_PROMOTED to pass through so promoteMasterLead() can return
      // the idempotent success result (with original contactId) on committed retries.
      const check = await checkPromotionPreconditions(masterLeadId);
      if (check.blocker && check.blocker !== "ALREADY_PROMOTED") {
        return res.status(422).json({ code: check.blocker, message: (check as any).message });
      }

      const promotedBy = String((req.user as any)?.id ?? "admin");
      const result = await promoteMasterLead({ masterLeadId, promotedBy });

      if (!result.success) {
        return res.status(422).json({ code: result.code, message: result.message });
      }

      res.json({
        success: true,
        contactId: result.contactId,
        masterLeadId: result.masterLeadId,
        alreadyPromoted: result.alreadyPromoted ?? false,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Suppress a pipeline lead
  app.post("/api/master-leads/pipeline/:id/suppress", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { reason = "admin_suppressed" } = req.body;
      const masterLeadId = String(req.params.id);
      const actorId = String((req.user as any)?.id ?? "admin");

      // Atomic: verify pipeline_origin, then conditionally transition status in one transaction.
      // Using FOR UPDATE + conditional UPDATE prevents a concurrent promotion from being overwritten.
      await db.transaction(async (tx) => {
        // Lock the row first
        const lockResult = (await tx.execute(sql`
          SELECT id, status, pipeline_origin
          FROM master_leads
          WHERE id = ${masterLeadId}::uuid
          FOR UPDATE
          LIMIT 1
        `)).rows as any[];

        if (lockResult.length === 0) {
          throw Object.assign(new Error("Not found"), { statusCode: 404 });
        }
        const lead = lockResult[0];
        if (lead.pipeline_origin !== "cro03_pipeline") {
          throw Object.assign(new Error("Not a pipeline row"), { statusCode: 400 });
        }
        if (lead.status !== "staged") {
          throw Object.assign(
            new Error(`Cannot suppress a lead in status '${lead.status}'`),
            { statusCode: 422 },
          );
        }

        // Conditional UPDATE — only transitions if status is still 'staged'
        await tx.execute(sql`
          UPDATE master_leads
             SET status = 'suppressed', suppression_reason = ${reason}, suppressed_at = NOW(), updated_at = NOW()
           WHERE id = ${masterLeadId}::uuid
             AND status = 'staged'
        `);

        await tx.execute(sql`
          INSERT INTO audit_logs (user_id, action, entity_type, entity_key, details, actor_type, actor_id)
          VALUES (${actorId}, 'master_lead_pipeline_suppressed', 'master_lead', ${masterLeadId},
                  ${JSON.stringify(sanitizeAuditPayload({ reason }))}::jsonb, 'user', ${actorId})
        `);
      });

      res.json({ success: true });
    } catch (err: any) {
      const statusCode = (err as any).statusCode;
      if (statusCode === 404) return res.status(404).json({ message: "Not found" });
      if (statusCode === 400) return res.status(400).json({ message: err.message });
      if (statusCode === 422) return res.status(422).json({ message: err.message });
      serverError(res, err);
    }
  });

  // Bulk promote preview for a generation
  app.get("/api/master-leads/generations/:id/promotion-preview", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { previewGenerationPromotion } = await import("../services/master-leads/pipeline-promotion");
      const preview = await previewGenerationPromotion(String(req.params.id));
      res.json(preview);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Bulk promote eligible rows for a generation
  app.post("/api/master-leads/generations/:id/promote", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { promoteGenerationEligible } = await import("../services/master-leads/pipeline-promotion");
      const promotedBy = String((req.user as any)?.id ?? "admin");
      const result = await promoteGenerationEligible(String(req.params.id), promotedBy);
      res.json({
        success: true,
        promotedCount: result.promoted.length,
        blockedCount: result.blocked.length,
        promoted: result.promoted,
        blocked: result.blocked,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Generation batch reconciliation stats
  app.get("/api/master-leads/generations/:id/stats", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const generationId = String(req.params.id);
      const batchResult = (await db.execute(sql`
        SELECT total_submitted, staged_count, duplicate_count, suppressed_count, failed_count, reconciled_at
        FROM master_lead_generation_batches
        WHERE cro03_generation_id = ${generationId}::uuid
        LIMIT 1
      `)).rows as any[];

      if (batchResult.length === 0) {
        // Compute on the fly from receipts
        const receiptResult = (await db.execute(sql`
          SELECT
            COUNT(*)::int                                                  AS total_submitted,
            COUNT(*) FILTER (WHERE disposition='staged')::int             AS staged_count,
            COUNT(*) FILTER (WHERE disposition='duplicate')::int          AS duplicate_count,
            COUNT(*) FILTER (WHERE disposition='suppressed')::int         AS suppressed_count,
            COUNT(*) FILTER (WHERE disposition='failed')::int             AS failed_count
          FROM master_lead_staging_receipts
          WHERE cro03_generation_id = ${generationId}::uuid
        `)).rows[0] as any;

        return res.json({
          cro03GenerationId: generationId,
          totalSubmitted: Number(receiptResult?.total_submitted ?? 0),
          stagedCount: Number(receiptResult?.staged_count ?? 0),
          duplicateCount: Number(receiptResult?.duplicate_count ?? 0),
          suppressedCount: Number(receiptResult?.suppressed_count ?? 0),
          failedCount: Number(receiptResult?.failed_count ?? 0),
          reconciledAt: null,
        });
      }

      const r = batchResult[0];
      res.json({
        cro03GenerationId: generationId,
        totalSubmitted: Number(r.total_submitted),
        stagedCount: Number(r.staged_count),
        duplicateCount: Number(r.duplicate_count),
        suppressedCount: Number(r.suppressed_count),
        failedCount: Number(r.failed_count),
        reconciledAt: r.reconciled_at,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

}
