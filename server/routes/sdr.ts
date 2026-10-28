import type { Express, Request as ExpressRequest } from "express";
import { isAuthenticated, isAdmin, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { db, pool } from "../db";
import { z } from "zod";
import { contacts, consentAuditLogs, insertBusinessAliasSchema, insertBusinessLocationSchema, insertBusinessSchema, insertLeadSourceSchema, sdrLeadState, sdrChannelAttempts, sdrLeadEvents, sdrMerchants } from "@shared/schema";
import { eq, sql, desc, and } from "drizzle-orm";
import { getSerperUsage, isSerperConfigured } from "../services/serper";
import { scoreLeadFull } from "../services/sdr/scoring";
import { bridgeContactsToSdr, getDailyLimits, getSdrDashboardStats, isOrchestratorRunning, startOrchestrator, stopOrchestrator, sweepLeads, pauseAll, resumeAll, isGloballyPaused, getGlobalPauseReason, getLastSweepTime, getLastSweepErrors, trackWebhookFailure, getWebhookFailureCount } from "../services/sdr/orchestrator";
import { getEnrollmentStatus, getWorkflowMappings, getInboxSmartListTags } from "../services/ghl-workflow-enrollment";
import { buildGhlVoicePayload, getAllVoiceScripts, getVoiceScript, personalizeVoiceScript, resolveVoiceScriptForLead } from "../services/sdr/voice-orchestrator";
import { bridgeContactsToBusinesses, getDedupeStats, ingestBusiness } from "../services/sdr/dedupe";
import { getAllFlags, featureFlags } from "../services/feature-flags";
import { validateWebhookSignature, getSdrGhlConfig, isSdrGhlConfigured, fetchCalendars } from "../services/sdr/ghl-client";
import { handleContactUpdated, handleMessageReceived, handleCallOutcome, handleAppointmentBooked, handleAppointmentCanceled, handleOptOut, handleEmailBounce } from "../services/sdr/webhook-handlers";
import { handleAppointmentShowed } from "../services/sdr/scheduling";
import { ghlWebhookReceiptMiddleware } from "../services/ghl-webhook-receipts";
import { acceptGhlAppointmentTransition, configuredAppointmentCalendarIds, type AppointmentEventKind } from "../services/ghl-appointment-events";
import { runReceiptStep, runReceiptTxStep } from "../services/ghl-webhook-effects";
import { handleConversationCreated, handleChatMessage, handleSmsThread, handleEmailThread, handleChatBooking } from "../services/sdr/chat-handlers";
import { parse } from "csv-parse/sync";
import { createContactLocalFirst } from "../services/contact-writer";
import { serverError, safeMessage } from "../utils/server-error";
import { requireGhlRouteMutationAllowed } from "./ghl-mutation-pause";
import { applyConsentCommand } from "../services/consent-authority";
import { authorizeBusinessAccess } from "../services/crm-object-access";
import { updateOrganizationDescriptive } from "../services/organization-service";
import { claimVerifiedProviderEvent, linkInboundRequest, orchestrateInboundRequest } from "../services/inbound-request-authority";
import { certificationHttpReadinessFields } from "../lib/certification-http-contract";
import { readSfpPublishBuildIdentity } from "../../shared/sfp-publish-build-identity";

// ── Build identity — frozen at process start, never derived at request time ──
// RELEASE_SHA must be a 40-hex string injected by the deployment pipeline via
// the RELEASE_SHA environment variable (set to `git rev-parse HEAD` at deploy
// time). If absent or malformed the endpoint signals "release-unverified".
const _SHA_PATTERN = /^[0-9a-f]{40}$/i;
const _RELEASE_SHA_RAW = process.env.RELEASE_SHA ?? "";
const _RELEASE_SHA_VALID = _SHA_PATTERN.test(_RELEASE_SHA_RAW);
const BUILD_SHA: string = _RELEASE_SHA_VALID ? _RELEASE_SHA_RAW : "unset";
const BUILD_AT: string = new Date().toISOString();
const BUILD_ENV: string = process.env.NODE_ENV ?? "unknown";
const PUBLISH_BUILD = readSfpPublishBuildIdentity({
  releaseSha: _RELEASE_SHA_RAW,
  publishArtifactSha: process.env.SFP_PUBLISH_ARTIFACT_SHA,
  publishBuildId: process.env.SFP_PUBLISH_BUILD_ID,
});

if (PUBLISH_BUILD) {
  // Nonsecret artifact identity in publisher-controlled logs for independent
  // release verification; this log does not select or authorize the build.
  console.log("[SFP Publish Artifact Loaded]", JSON.stringify(PUBLISH_BUILD));
}

if (!_RELEASE_SHA_VALID) {
  console.warn(
    "[Health] RELEASE_SHA is missing or malformed — health endpoints will report status='release-unverified'. " +
    "Set RELEASE_SHA to `git rev-parse HEAD` in the deployment environment."
  );
}

export function registerSdrRoutes(app: Express) {
  /**
   * Provider sync/contact-updated events are projections and deliberately do
   * not enter inbound authority. Callers use this only after signature
   * verification for an explicit merchant event with a provider-issued ID.
   */
  const claimExplicitGhlOccurrence = async (
    sourceType: "inbound_message" | "inbound_call" | "appointment_booked" | "chat_message" | "chat_booking",
    payload: Record<string, unknown>,
    eventId: unknown,
  ) => {
    if (typeof eventId !== "string" || !eventId.trim()) {
      throw new Error("VERIFIED_PROVIDER_EVENT_ID_REQUIRED");
    }
    const claim = await claimVerifiedProviderEvent({ sourceType, eventId, payload });
    if (claim.outcome === "conflict" || claim.outcome === "scope_mismatch") {
      throw new Error("VERIFIED_PROVIDER_EVENT_CLAIM_CONFLICT");
    }
    return claim.request;
  };

  const linkExplicitGhlOccurrence = async (requestId: string, payload: Record<string, unknown>) => {
    const ghlContactId = typeof payload.contactId === "string" ? payload.contactId : undefined;
    if (!ghlContactId) return;
    const [contact] = await db.select({ id: contacts.id }).from(contacts)
      .where(eq(contacts.ghlContactId, ghlContactId)).limit(1);
    await linkInboundRequest(requestId, { contactId: contact?.id ?? null });
    await orchestrateInboundRequest({ requestId, contactId: contact?.id ?? null });
  };

  // === HEALTH ENDPOINTS ===
  // Public minimal health check — intentionally reveals nothing about internals.
  // Build identity fields (sha, builtAt, env) are frozen at process start.
  app.get("/health", (_req, res) => {
    return res.status(200).json({
      status: _RELEASE_SHA_VALID ? "ok" : "release-unverified",
      sha: BUILD_SHA,
      builtAt: BUILD_AT,
      env: BUILD_ENV,
      publishBuildId: PUBLISH_BUILD?.buildId ?? null,
    });
  });

  // Public minimal API health check — no internals exposed.
  // Build identity fields (sha, builtAt, env) are frozen at process start.
  app.get("/api/health", (_req, res) => {
    res.json({
      status: _RELEASE_SHA_VALID ? "ok" : "release-unverified",
      sha: BUILD_SHA,
      builtAt: BUILD_AT,
      env: BUILD_ENV,
      publishBuildId: PUBLISH_BUILD?.buildId ?? null,
      // C-03 (#1626): lets pre-deploy test scripts (test-forms.ts,
      // test-call-follow-ups.ts) confirm the GHL fail-fast fake transport is
      // actually installed on the server they're hitting before running any
      // test that could otherwise create real GHL contacts.
      ghlTransportFailFast: process.env.GHL_TRANSPORT_FAILFAST === "true",
      ...certificationHttpReadinessFields(process.env),
    });
  });

  // Verbose health check — dashboard users only
  app.get("/api/admin/health", isDashboardUser, async (_req, res) => {
    const uptime = process.uptime();
    let dbOk = false;
    let sessionOk = false;
    let sessionCount: number | null = null;
    let redisOk = false;
    try {
      const result = await pool.query("SELECT 1 AS check");
      dbOk = result.rows.length > 0;
    } catch {}
    try {
      const sessResult = await pool.query("SELECT COUNT(*) AS cnt FROM sessions");
      sessionOk = sessResult.rows.length > 0;
      sessionCount = sessResult.rows[0] ? parseInt(sessResult.rows[0].cnt, 10) : null;
    } catch {}
    try {
      const { requireQueueManagerReady } = await import("../services/queue-manager");
      const qm = requireQueueManagerReady();
      if (qm) {
        const conn = (qm as any)._redisConnection;
        if (conn && typeof conn.ping === "function") await conn.ping();
        redisOk = true;
      }
    } catch {}

    const { isGhlConfigured } = await import("../services/ghl");
    const { getGhlCircuitStatus } = await import("../services/ghl-sync");
    const circuit = getGhlCircuitStatus();
    const { isSmtpConfigured } = await import("../services/smtp-email");

    const smtpOk = isSmtpConfigured();
    const ghlConfigured = isGhlConfigured();
    const circuitOpen = circuit.circuitOpen;

    // REV-05A: Include processor readiness state in health output.
    let processorReadiness: Record<string, string> = {};
    try {
      const { getProcessorHealthState } = await import("../services/processors/registry");
      processorReadiness = { payarc: await getProcessorHealthState("payarc") };
    } catch { /* non-critical */ }

    const degraded: string[] = [];
    if (!redisOk) degraded.push("redis");
    if (!smtpOk) degraded.push("smtp");
    const allOk = dbOk && sessionOk && !circuitOpen;

    res.status(allOk ? 200 : 503).json({
      ok: allOk,
      degraded,
      uptime: Math.floor(uptime),
      db: dbOk ? "connected" : "error",
      session: sessionOk ? "connected" : "error",
      sessionCount,
      redis: redisOk ? "connected" : "unavailable",
      ghl: ghlConfigured ? (circuitOpen ? "circuit_open" : "configured") : "missing",
      ghlCircuit: {
        open: circuitOpen,
        consecutiveFailures: circuit.consecutiveFailures,
        threshold: circuit.threshold,
      },
      smtp: smtpOk ? "configured" : "missing",
      processorReadiness,
      timestamp: new Date().toISOString(),
      sha: BUILD_SHA,
      builtAt: BUILD_AT,
      env: BUILD_ENV,
    });
  });

  // GET /api/admin/live-health is registered in server/routes/admin.ts with role-guard caching.

  app.get("/api/ghl/health", isAuthenticated, async (_req, res) => {
    try {
      const config = getSdrGhlConfig();
      let authTest = false;
      if (isSdrGhlConfigured()) {
        try {
          await fetchCalendars();
          authTest = true;
        } catch {}
      }
      const { getGhlCircuitStatus } = await import("../services/ghl-sync");
      const circuit = getGhlCircuitStatus();
      res.json({ ...config, authTest, ...circuit });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/circuit-reset", isAuthenticated, async (_req, res) => {
    try {
      const { resetGhlCircuit } = await import("../services/ghl-sync");
      resetGhlCircuit();
      await storage.createAuditLog({ action: "GHL_CIRCUIT_RESET", entityType: "system", details: "GHL circuit breaker manually reset via Activation Panel" });
      res.json({ ok: true, message: "GHL circuit breaker reset — consecutive failure count cleared" });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/health", isAuthenticated, async (_req, res) => {
    try {
      const identities = await storage.getSendingIdentities();
      const activeIdentities = identities.filter((i: any) => i.status === "active");

      const eligibleLeads = await db.select({ count: sql<number>`count(*)` })
        .from(sdrLeadState)
        .where(sql`${sdrLeadState.stage} NOT IN ('DEAD', 'CONVERTED') AND ${sdrLeadState.nextActionAt} IS NOT NULL`);

      const recentFailures = await db.select({ count: sql<number>`count(*)` })
        .from(sdrChannelAttempts)
        .where(sql`${sdrChannelAttempts.status} = 'failed' AND ${sdrChannelAttempts.sentAt} > NOW() - INTERVAL '24 hours'`);

      const lastWebhookEvent = await db.select({ createdAt: sdrLeadEvents.createdAt })
        .from(sdrLeadEvents)
        .where(sql`${sdrLeadEvents.eventType} LIKE '%webhook%' OR ${sdrLeadEvents.eventType} IN ('reply_received', 'call_outcome', 'appointment_booked')`)
        .orderBy(desc(sdrLeadEvents.createdAt))
        .limit(1);

      res.json({
        sendingIdentityCount: identities.length,
        activeIdentityCount: activeIdentities.length,
        eligibleLeadCount: Number(eligibleLeads[0]?.count || 0),
        orchestratorRunning: isOrchestratorRunning(),
        globalPaused: isGloballyPaused(),
        globalPauseReason: getGlobalPauseReason(),
        lastSweepTime: getLastSweepTime()?.toISOString() || null,
        lastSweepErrors: getLastSweepErrors(),
        recentFailures24h: Number(recentFailures[0]?.count || 0),
        webhookLastReceived: lastWebhookEvent[0]?.createdAt?.toISOString() || null,
        flags: getAllFlags(),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === FEATURE FLAGS ===
  app.get("/api/sdr/flags", isAuthenticated, (_req, res) => {
    res.json(getAllFlags());
  });

  // === GLOBAL PAUSE / RESUME ===
  app.post("/api/sdr/pause-all", requireRole("admin"), (req, res) => {
    const reason = req.body?.reason || "Manual pause from admin panel";
    pauseAll(reason);
    res.json({ success: true, paused: true, reason });
  });

  app.post("/api/sdr/resume-all", requireRole("admin"), (req, res) => {
    resumeAll();
    res.json({ success: true, paused: false });
  });

  // === BRIDGE SCRIPT ===
  app.post("/api/sdr/bridge", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") return res.status(403).json({ message: "Admin only" });
    try {
      const source = req.body?.source || "contacts";
      const limit = Math.min(parseInt(req.body?.limit || "50", 10), 500);
      const dryRun = req.body?.dryRun === true || req.query.dryRun === "true";
      const verticalFilter = req.body?.vertical || null;
      const geographyFilter = req.body?.geography || null;

      if (source === "contacts") {
        const { data: allContacts } = await storage.getContacts({ limit: 500 });
        let filtered = allContacts;

        if (verticalFilter) {
          filtered = filtered.filter((c: any) => c.vertical && c.vertical.toLowerCase().includes(verticalFilter.toLowerCase()));
        }
        if (geographyFilter) {
          filtered = filtered.filter((c: any) => (c.city && c.city.toLowerCase().includes(geographyFilter.toLowerCase())) || (c.state && c.state.toLowerCase().includes(geographyFilter.toLowerCase())));
        }

        filtered = filtered.slice(0, limit);

        const existingLeads = await db.select({ contactId: sdrLeadState.contactId })
          .from(sdrLeadState)
          .where(sql`${sdrLeadState.contactId} IS NOT NULL`);
        const existingContactIds = new Set(existingLeads.map((l: any) => l.contactId));

        const results: any[] = [];
        let created = 0, deduped = 0, skipped = 0, errors = 0;

        for (const contact of filtered) {
          if (existingContactIds.has(contact.id)) {
            deduped++;
            results.push({ id: contact.id, name: contact.companyName || `${contact.firstName} ${contact.lastName}`, status: "deduped" });
            continue;
          }
          if (!contact.email && !contact.phone) {
            skipped++;
            results.push({ id: contact.id, name: contact.companyName || `${contact.firstName} ${contact.lastName}`, status: "skipped", reason: "No email or phone" });
            continue;
          }

          if (dryRun) {
            created++;
            results.push({ id: contact.id, name: contact.companyName || `${contact.firstName} ${contact.lastName}`, status: "would_create", vertical: contact.vertical, city: contact.city });
          } else {
            try {
              const bridgeResult = await bridgeContactsToSdr({ limit: 1, contactIds: [contact.id] });
              if (bridgeResult.imported > 0) {
                created++;
                results.push({ id: contact.id, name: contact.companyName || `${contact.firstName} ${contact.lastName}`, status: "created" });
              } else {
                skipped++;
                results.push({ id: contact.id, name: contact.companyName || `${contact.firstName} ${contact.lastName}`, status: "skipped" });
              }
            } catch (err: any) {
              errors++;
              results.push({ id: contact.id, name: contact.companyName || `${contact.firstName} ${contact.lastName}`, status: "error", reason: err.message });
            }
          }
        }

        res.json({ dryRun, source, totalProcessed: filtered.length, created, deduped, skipped, errors, results });
      } else if (source === "sunbiz") {
        let sunbizEntities: Record<string, unknown>[] = [];
        try {
          const rawResult = await db.execute(sql`
            SELECT * FROM sunbiz_entities
            WHERE TRUE
            ${verticalFilter ? sql`AND vertical ILIKE ${'%' + verticalFilter + '%'}` : sql``}
            ${geographyFilter ? sql`AND (city ILIKE ${'%' + geographyFilter + '%'} OR state ILIKE ${'%' + geographyFilter + '%'})` : sql``}
            LIMIT ${limit}
          `);
          sunbizEntities = (rawResult.rows || []) as Record<string, unknown>[];
        } catch {
          sunbizEntities = [];
        }

        const existingMerchantRefs = await db.select({ sourceRef: sdrMerchants.sourceRef })
          .from(sdrMerchants)
          .where(sql`${sdrMerchants.source} = 'sunbiz_bridge'`);
        const existingRefs = new Set(existingMerchantRefs.map(r => r.sourceRef));

        interface BridgeResult { id: unknown; name: unknown; status: string; reason?: string; vertical?: unknown; city?: unknown; businessId?: number; merchantId?: number }
        const results: BridgeResult[] = [];
        let created = 0, deduped = 0, skipped = 0, errors = 0;

        for (const entity of sunbizEntities) {
          const entityId = entity.id;
          const businessName = (entity.business_name || entity.businessName || "Unknown") as string;
          const entityEmail = entity.email as string | null;
          const entityPhone = entity.phone as string | null;

          if (!entityEmail && !entityPhone) {
            skipped++;
            results.push({ id: entityId, name: businessName, status: "skipped", reason: "No contact info" });
            continue;
          }

          const refKey = `sunbiz_${entityId}`;
          if (existingRefs.has(refKey)) {
            deduped++;
            results.push({ id: entityId, name: businessName, status: "deduped" });
            continue;
          }

          if (dryRun) {
            created++;
            results.push({ id: entityId, name: businessName, status: "would_create", vertical: entity.vertical, city: entity.city });
          } else {
            try {
              const bizResult = await ingestBusiness({
                name: businessName,
                phone: entityPhone || undefined,
                email: entityEmail || undefined,
                address: (entity.address as string) || undefined,
                city: (entity.city as string) || undefined,
                state: (entity.state as string) || "FL",
                vertical: (entity.vertical as string) || undefined,
                sourceType: "sunbiz_bridge",
                sourceLabel: refKey,
              });
              const resolvedBusinessId = bizResult.businessId;

              const [merchant] = await db.insert(sdrMerchants).values({
                businessName,
                website: null,
                mainPhone: entityPhone || null,
                mainEmail: entityEmail || null,
                address: (entity.address as string) || null,
                city: (entity.city as string) || null,
                state: (entity.state as string) || "FL",
                vertical: (entity.vertical as string) || null,
                source: "sunbiz_bridge",
                sourceRef: refKey,
                businessId: resolvedBusinessId,
              }).returning();

              await db.insert(sdrLeadState).values({
                merchantId: merchant.id,
                businessId: resolvedBusinessId,
                companyName: businessName,
                email: entityEmail || null,
                phone: entityPhone || null,
                vertical: (entity.vertical as string) || null,
                city: (entity.city as string) || null,
                state: (entity.state as string) || "FL",
                stage: "DISCOVERED",
                sourceType: "sunbiz_bridge",
                sourceId: refKey,
                nextActionType: "score",
                nextActionAt: new Date(),
              });

              existingRefs.add(refKey);
              created++;
              results.push({ id: entityId, name: businessName, status: "created", businessId: resolvedBusinessId, merchantId: merchant.id });
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              if (errMsg.includes("duplicate") || errMsg.includes("already exists")) {
                deduped++;
                results.push({ id: entityId, name: businessName, status: "deduped" });
              } else {
                errors++;
                results.push({ id: entityId, name: businessName, status: "error", reason: errMsg });
              }
            }
          }
        }

        res.json({ dryRun, source, totalProcessed: sunbizEntities.length, created, deduped, skipped, errors, results });
      } else {
        res.status(400).json({ message: "source must be 'contacts' or 'sunbiz'" });
      }
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === COMPLIANCE CHANNEL STATUS ===
  app.get("/api/sdr/compliance-channel-status", isDashboardUser, async (_req, res) => {
    try {
      const [totalRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(contacts)
        .where(sql`${contacts.archivedAt} IS NULL`);
      const totalContacts = totalRow?.count ?? 0;

      const [smsPewcRow] = await db
        .select({ count: sql<number>`count(distinct ${consentAuditLogs.contactId})::int` })
        .from(consentAuditLogs)
        .where(and(
          eq(consentAuditLogs.channel, "sms"),
          eq(consentAuditLogs.consented, true),
          eq(consentAuditLogs.consentType, "express_written"),
        ));
      const smsPewcCount = smsPewcRow?.count ?? 0;

      const [callPewcRow] = await db
        .select({ count: sql<number>`count(distinct ${consentAuditLogs.contactId})::int` })
        .from(consentAuditLogs)
        .where(and(
          eq(consentAuditLogs.channel, "call"),
          eq(consentAuditLogs.consented, true),
          eq(consentAuditLogs.consentType, "express_written"),
        ));
      const callPewcCount = callPewcRow?.count ?? 0;

      const [smsAnyConsentRow] = await db
        .select({ count: sql<number>`count(distinct ${consentAuditLogs.contactId})::int` })
        .from(consentAuditLogs)
        .where(and(eq(consentAuditLogs.channel, "sms"), eq(consentAuditLogs.consented, true)));
      const smsAnyConsentCount = smsAnyConsentRow?.count ?? 0;

      const strictStates = (process.env.STRICT_STATE_CONSENT_REQUIRED || "FL")
        .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

      const missingApiKeys: string[] = [];
      if (!process.env.SERPER_API_KEY) missingApiKeys.push("SERPER_API_KEY");
      const disabledPaidSources = ["Outscraper", "Apify", "Apollo"];

      const smsEnabled = featureFlags.SMS_ENABLED;
      const voiceEnabled = featureFlags.VOICE_AI_ENABLED;
      const discoveryEnabled = featureFlags.NIGHTLY_DISCOVERY_ENABLED;
      const orchestratorEnabled = featureFlags.ORCHESTRATOR_ENABLED;
      const sdrEnabled = featureFlags.SDR_ENABLED;

      res.json({
        strictStates,
        lastUpdated: new Date().toISOString(),
        channels: [
          {
            key: "cold_email",
            name: "Cold Email",
            icon: "mail",
            status: sdrEnabled ? "safe" : "warning",
            flagKey: "SDR_ENABLED",
            flagEnabled: sdrEnabled,
            regulation: "CAN-SPAM",
            consentRequired: false,
            summary: sdrEnabled
              ? "Safe to use — B2B cold email is governed by CAN-SPAM, not TCPA. No prior consent required for business contacts."
              : "SDR_ENABLED is off. Email sequences will not run until you enable it.",
            requirements: [
              "Include physical mailing address in every email",
              "Honor unsubscribe requests within 10 business days",
              "No deceptive subject lines",
              "Identify message as an advertisement",
            ],
            blockers: sdrEnabled ? [] : ["SDR_ENABLED=false — set to true in Replit Secrets"],
            stats: null,
          },
          {
            key: "manual_call",
            name: "Manual Cold Call (Human Rep)",
            icon: "phone",
            status: "safe",
            flagKey: null,
            flagEnabled: true,
            regulation: "TCPA — B2B DNC Exemption",
            consentRequired: false,
            summary: "Safe — manually dialed B2B calls by a human rep are exempt from TCPA auto-dialer restrictions and the National DNC Registry.",
            requirements: [
              "Rep must manually dial — no predictive or auto-dialer software",
              "Respect individual Do-Not-Call requests immediately",
              "Comply with FL quiet hours: 8am–8pm local time",
              "Identify yourself and your company at the start of every call",
            ],
            blockers: [],
            stats: null,
          },
          {
            key: "automated_sms",
            name: "Automated SMS",
            icon: "message-square",
            status: !smsEnabled ? "off" : smsPewcCount === 0 ? "blocked" : "warning",
            flagKey: "SMS_ENABLED",
            flagEnabled: smsEnabled,
            regulation: "TCPA + FL SB 1120",
            consentRequired: true,
            summary: !smsEnabled
              ? "SMS_ENABLED=false — automated SMS is disabled. Safe default for launch."
              : smsPewcCount === 0
              ? "Automated SMS is enabled but 0 contacts have express written consent (PEWC). Do not send until consent is captured."
              : `${smsPewcCount} of ${totalContacts} contacts have PEWC for SMS. Only send to consented contacts.`,
            requirements: [
              "Express written consent (PEWC) required before any automated message",
              "FL contacts require PEWC per SB 1120 — captured via merchant application checkbox",
              "Reply STOP must stop all messages immediately",
              "Identify sender in every message",
              "Message & data rates disclosure required at opt-in",
            ],
            blockers: [
              ...(!smsEnabled ? ["SMS_ENABLED=false — set to true in Replit Secrets when ready"] : []),
              ...(smsEnabled && smsPewcCount === 0 ? ["0 contacts have express written consent — capture PEWC via merchant application before sending"] : []),
            ],
            stats: { totalContacts, smsAnyConsentCount, smsPewcCount, strictStates },
          },
          {
            key: "voice_ai",
            name: "Voice AI / Auto-Dialer",
            icon: "mic",
            status: !voiceEnabled ? "off" : callPewcCount === 0 ? "blocked" : "warning",
            flagKey: "VOICE_AI_ENABLED",
            flagEnabled: voiceEnabled,
            regulation: "TCPA + FL SB 1120",
            consentRequired: true,
            summary: !voiceEnabled
              ? "VOICE_AI_ENABLED=false — automated calling is disabled. Recommended: keep off until PEWC is established."
              : callPewcCount === 0
              ? "Voice AI is enabled but 0 contacts have express written consent for calls. Do not place automated calls."
              : `${callPewcCount} of ${totalContacts} contacts have PEWC for calls.`,
            requirements: [
              "Express written consent required before any automated or pre-recorded call",
              "FL contacts require PEWC per SB 1120",
              "Identify caller and company in the first seconds of every call",
              "Provide opt-out mechanism during every call",
              "Comply with quiet hours (8am–9pm local time)",
            ],
            blockers: [
              ...(!voiceEnabled ? ["VOICE_AI_ENABLED=false — set to true in Replit Secrets only after PEWC flow is established"] : []),
              ...(voiceEnabled && callPewcCount === 0 ? ["0 contacts have call PEWC — do not place automated calls"] : []),
            ],
            stats: { totalContacts, callPewcCount, strictStates },
          },
          {
            key: "ringless_voicemail",
            name: "Ringless Voicemail (RVM)",
            icon: "voicemail",
            status: "blocked",
            flagKey: "VOICE_AI_ENABLED",
            flagEnabled: false,
            regulation: "TCPA — Legally Uncertain",
            consentRequired: true,
            summary: "Treat RVM as an automated call. FL courts and multiple federal circuits classify RVM as a TCPA 'call'. Requires PEWC — keep off until consent infrastructure is fully established.",
            requirements: [
              "Treat exactly like an automated call — PEWC required",
              "FL 11th Circuit has ruled RVM = TCPA call",
              "FCC rulemaking expected to formally classify RVM as a call",
            ],
            blockers: ["RVM is gated by VOICE_AI_ENABLED — keep off until PEWC is widespread"],
            stats: null,
          },
          {
            key: "nightly_discovery",
            name: "Nightly Lead Discovery",
            icon: "search",
            status: !discoveryEnabled ? "off" : missingApiKeys.length > 0 ? "blocked" : "warning",
            flagKey: "NIGHTLY_DISCOVERY_ENABLED",
            flagEnabled: discoveryEnabled,
            regulation: "No TCPA restriction",
            consentRequired: false,
            summary: !discoveryEnabled
              ? "NIGHTLY_DISCOVERY_ENABLED=false — automated lead discovery is off."
              : missingApiKeys.length === 0
              ? "Serper is configured; paid discovery sources remain disabled pending durable provider commands."
              : `Serper is not configured. Paid discovery sources also remain disabled pending durable provider commands.`,
            requirements: [
              "Configure Serper through its approved control plane",
              "Discovery does not contact leads — it only populates the prospect queue",
              "Contacts discovered here will need consent captured before automated SMS/calls",
            ],
            blockers: [
              ...(!discoveryEnabled ? ["NIGHTLY_DISCOVERY_ENABLED=false — set to true in Replit Secrets when ready"] : []),
              ...missingApiKeys.map((k) => `${k} not set — this discovery source will be skipped`),
               ...disabledPaidSources.map((source) => `${source} is disabled pending a durable approved provider operation`),
            ],
            stats: { missingApiKeys, disabledPaidSources, configuredCount: missingApiKeys.length === 0 ? 1 : 0 },
          },
        ],
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === ACTIVATION PANEL DATA ===
  app.get("/api/sdr/activation/recent-attempts", isAdmin, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string || "50", 10);
      const attempts = await db.select()
        .from(sdrChannelAttempts)
        .orderBy(desc(sdrChannelAttempts.sentAt))
        .limit(limit);
      res.json(attempts);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/activation/recent-events", isAdmin, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string || "50", 10);
      const events = await db.select()
        .from(sdrLeadEvents)
        .orderBy(desc(sdrLeadEvents.createdAt))
        .limit(limit);
      res.json(events);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/activation/stuck-leads", isAdmin, async (_req, res) => {
    try {
      const stuckLeads = await db.select()
        .from(sdrLeadState)
        .where(sql`
          ${sdrLeadState.stage} NOT IN ('DEAD', 'CONVERTED')
          AND (
            (${sdrLeadState.nextActionAt} < NOW() - INTERVAL '24 hours')
            OR (${sdrLeadState.updatedAt} < NOW() - INTERVAL '72 hours' AND ${sdrLeadState.stage} NOT IN ('DEAD', 'CONVERTED'))
          )
        `)
        .orderBy(sql`${sdrLeadState.nextActionAt} ASC NULLS LAST`)
        .limit(100);
      res.json(stuckLeads);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === SDR WEBHOOK RECEIVER ===
  // Guard: reject all GHL webhooks with 503 in production when NEITHER
  // GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY (Ed25519, current) NOR GHL_WEBHOOK_SECRET
  // (HMAC-SHA256, legacy) is configured.  Forces the operator to set at least
  // one verification key before enabling GHL webhooks.
  app.use("/api/webhooks/ghl/", (req, res, next) => {
    const hasEd25519 = !!process.env.GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY;
    const hasHmac    = !!process.env.GHL_WEBHOOK_SECRET;
    if (!hasEd25519 && !hasHmac && process.env.NODE_ENV === "production") {
      console.error("[SDR Webhook] Neither GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY nor GHL_WEBHOOK_SECRET is set — rejecting webhook in production");
      return res.status(503).json({ received: false, error: "Webhook signing not configured" });
    }
    next();
  });

  function getSdrWebhookRawBody(req: ExpressRequest): string {
    const rawBody = (req as ExpressRequest & { rawBody?: Buffer }).rawBody;
    if (rawBody && Buffer.isBuffer(rawBody)) {
      return rawBody.toString("utf8");
    }
    return JSON.stringify(req.body);
  }

  // ── Webhook signature + replay verification middleware ─────────────────────
  // Runs BEFORE the dedup middleware so invalid/replayed events are rejected
  // without being recorded in webhook_event_log (which would permanently block
  // legitimate re-deliveries of the same payload with a fresh timestamp).
  //
  // Verification priority (see ghl-client.ts for full docs):
  //   1. x-ghl-signature + GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY → Ed25519 (current)
  //   2. x-ghl-signature + GHL_WEBHOOK_SECRET              → HMAC-SHA256 (legacy)
  //   3. x-wh-signature  + GHL_WEBHOOK_SECRET              → HMAC-SHA256 (oldest)
  //   4. No signature                                       → reject (401) always
  //
  // Replay window: 5 minutes (dateAdded/createdAt/timestamp / x-ghl-timestamp).
  app.use("/api/webhooks/ghl/", (req, res, next) => {
    const rawBody = getSdrWebhookRawBody(req);
    const { validateWebhookRequest } = require("../services/sdr/ghl-client") as typeof import("../services/sdr/ghl-client");
    const result = validateWebhookRequest(rawBody, req.headers as Record<string, string | string[] | undefined>);
    if (!result.valid) {
      if (result.replayRejected) {
        console.warn(`[SDR Webhook] Replay rejected — ${result.error}`);
        return res.status(401).json({ received: false, error: "Webhook replay rejected", detail: result.error });
      }
      console.warn(`[SDR Webhook] Signature verification failed (method=${result.method}) — ${result.error}`);
      return res.status(401).json({ received: false, error: "Invalid webhook signature" });
    }
    next();
  });

  // ── Durable webhook receipts ───────────────────────────────────────────────
  // received → claimed → applied | failed. The acknowledgement is held until the receipt outcome is
  // durable; duplicates of an applied event are acknowledged without reprocessing, retries of a failed
  // event are re-claimed, and receipt-storage faults are refused (503) so the sender retries.
  // webhook_event_log is intentionally left untouched (other certified paths read it).
  app.use("/api/webhooks/ghl/", ghlWebhookReceiptMiddleware());

  app.post("/api/webhooks/ghl/contact-updated", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      await handleContactUpdated(req.body);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] contact-updated error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/message-received", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      const payload = req.body as Record<string, unknown>;
      const inbound = payload.direction === "inbound";
      const occurrence = inbound
        ? await claimExplicitGhlOccurrence("inbound_message", payload, payload.messageId ?? payload.eventId)
        : null;
      await handleMessageReceived(payload);
      if (occurrence) await linkExplicitGhlOccurrence(occurrence.id, payload);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] message-received error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/call-outcome", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      const payload = req.body as Record<string, unknown>;
      const occurrence = payload.direction === "inbound"
        ? await claimExplicitGhlOccurrence("inbound_call", payload, payload.callId ?? payload.eventId)
        : null;
      await handleCallOutcome(payload);
      if (occurrence) await linkExplicitGhlOccurrence(occurrence.id, payload);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] call-outcome error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/appointment-booked", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      const payload = req.body as Record<string, unknown>;
      const gate = await gateAppointmentLifecycle("booked", payload, res);
      if (!gate) return;
      const occurrence = await claimExplicitGhlOccurrence("appointment_booked", payload, payload.appointmentId ?? payload.id ?? payload.eventId);
      await handleAppointmentBooked(payload);
      await runReceiptStep("booked:link_inbound_request", () => linkExplicitGhlOccurrence(occurrence.id, payload));
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] appointment-booked error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  // #appointment-to-statement — fires when a GHL appointment shows/completes
  app.post("/api/webhooks/ghl/appointment-showed", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      if (!await gateAppointmentLifecycle("showed", req.body, res)) return;
      await handleAppointmentShowed(req.body);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] appointment-showed error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/appointment-canceled", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      if (!await gateAppointmentLifecycle("canceled", req.body, res)) return;
      await handleAppointmentCanceled(req.body);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] appointment-canceled error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  // The transition is decided AND recorded in one transaction under a per-appointment lock, as a durable step of the
  // receipt, BEFORE any booked/showed/canceled effect runs. A stale, terminal, replayed or untrusted event never
  // enrolls, tags, moves a lead stage or sends anything; a retry of the same delivery reuses the stored decision
  // and never records the transition twice. The handlers' own effects are further durable steps (see
  // ghl-webhook-effects.ts) that re-check, under the same lock, that a later accepted transition did not supersede them.
  const appointmentScope = () => ({
    allowedLocationId: process.env.GHL_LOCATION_ID || null,
    allowedCalendarIds: configuredAppointmentCalendarIds(),
  });
  const acceptAppointmentTransition = (kind: AppointmentEventKind, payload: unknown) =>
    acceptGhlAppointmentTransition({ kind, payload: (payload ?? {}) as Record<string, unknown>, ...appointmentScope() });
  async function gateAppointmentLifecycle(kind: AppointmentEventKind, payload: unknown, res: import("express").Response): Promise<boolean> {
    const verdict = await acceptAppointmentTransition(kind, payload);
    if (verdict.decision === "apply") return true;
    if (verdict.decision === "rejected") {
      console.warn(`[SDR Webhook] appointment-${kind} rejected: ${verdict.reason}`);
      // An event without a provable origin or event time is not applied and is not acknowledged as handled.
      res.status(422).json({ received: false, error: verdict.reason });
      return false;
    }
    res.json({ received: true, applied: false, reason: verdict.decision });
    return false;
  }

  // Updated / rescheduled appointments: ordering record plus an audit event. These never enroll workflows,
  // tag contacts, or move lead stage — booked/canceled own those chains.
  for (const kind of ["updated", "rescheduled"] as const) {
    app.post(`/api/webhooks/ghl/appointment-${kind}`, async (req, res) => {
      try {
        const signature = req.headers["x-ghl-signature"] as string || "";
        if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
          return res.status(401).json({ message: "Invalid webhook signature" });
        }
        const payload = (req.body ?? {}) as Record<string, unknown>;
        const verdict = await acceptAppointmentTransition(kind, payload);
        if (verdict.decision === "rejected") {
          console.warn(`[SDR Webhook] appointment-${kind} rejected: ${verdict.reason}`);
          return res.status(422).json({ received: false, error: verdict.reason });
        }
        // The audit row is a transactional step of this receipt: written exactly once with the step record, and a
        // retry after any later failure finds the step complete.
        if (verdict.decision === "apply" && typeof payload.contactId === "string") {
          const contactId = payload.contactId;
          await runReceiptTxStep("audit_event", async tx => {
            const [merchant] = await tx.select().from(sdrMerchants).where(eq(sdrMerchants.ghlContactId, contactId));
            if (!merchant) return { audited: false };
            const eventTime = String(payload.dateUpdated ?? payload.dateAdded ?? payload.timestamp ?? "");
            const auditRef = `${String(payload.appointmentId ?? payload.id ?? contactId)}:${kind}:${eventTime}`;
            const [already] = await tx.select({ id: sdrLeadEvents.id }).from(sdrLeadEvents)
              .where(and(eq(sdrLeadEvents.merchantId, merchant.id), eq(sdrLeadEvents.eventType, `appointment_${kind}`), eq(sdrLeadEvents.ghlRefId, auditRef)))
              .limit(1);
            if (already) return { audited: false };
            await tx.insert(sdrLeadEvents).values({
              merchantId: merchant.id, eventType: `appointment_${kind}`, channel: "calendar", actorType: "merchant",
              payloadJson: payload, ghlRefId: auditRef,
            });
            return { audited: true };
          });
        }
        res.json({ received: true, applied: verdict.decision === "apply", reason: verdict.decision === "apply" ? "applied" : verdict.decision });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SDR Webhook] appointment-${kind} error:`, errMsg);
        trackWebhookFailure();
        res.status(500).json({ message: safeMessage(errMsg) });
      }
    });
  }

  app.post("/api/webhooks/ghl/opt-out", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      await handleOptOut(req.body);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] opt-out error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/conversation-created", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      await handleConversationCreated(req.body);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] conversation-created error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/chat-message", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      const payload = req.body as Record<string, unknown>;
      const occurrence = payload.direction === "inbound"
        ? await claimExplicitGhlOccurrence("chat_message", payload, payload.messageId ?? payload.eventId)
        : null;
      const result = await handleChatMessage(payload);
      if (occurrence) await linkExplicitGhlOccurrence(occurrence.id, payload);
      res.json({ received: true, ...(result || {}) });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] chat-message error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/sms-thread", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      const result = await handleSmsThread(req.body);
      res.json({ received: true, ...(result || {}) });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] sms-thread error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/email-thread", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      const result = await handleEmailThread(req.body);
      res.json({ received: true, ...(result || {}) });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] email-thread error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/webhooks/ghl/chat-booking", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      const payload = req.body as Record<string, unknown>;
      const occurrence = await claimExplicitGhlOccurrence("chat_booking", payload, payload.appointmentId ?? payload.eventId);
      await handleChatBooking(payload);
      await linkExplicitGhlOccurrence(occurrence.id, payload);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] chat-booking error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  // ── GHL email bounce webhook ────────────────────────────────────────────────
  // Fired by GHL when a sent email hard-bounces. Marks the contact as bounced,
  // updates the outbound_messages row, and pauses all active sequence enrollments
  // so the contactability gate correctly suppresses future sends.
  app.post("/api/webhooks/ghl/email-bounce", async (req, res) => {
    try {
      const signature = req.headers["x-ghl-signature"] as string || "";
      if (!validateWebhookSignature(getSdrWebhookRawBody(req), signature)) {
        return res.status(401).json({ message: "Invalid webhook signature" });
      }

      await handleEmailBounce(req.body);
      res.json({ received: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[SDR Webhook] email-bounce error:", errMsg);
      trackWebhookFailure();
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });


  // === SDR DASHBOARD API ===
  app.get("/api/sdr/dashboard/summary", isAuthenticated, async (_req, res) => {
    try {
      const summary = await storage.getSdrDashboardSummary();
      res.json(summary);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/dashboard/funnel", isAuthenticated, async (_req, res) => {
    try {
      const funnel = await storage.getSdrFunnelData();
      res.json(funnel);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/dashboard/stuck-leads", isAuthenticated, async (_req, res) => {
    try {
      const stuck = await storage.getSdrStuckLeads();
      res.json(stuck);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/dashboard/activity", isAuthenticated, async (_req, res) => {
    try {
      const activity = await storage.getSdrActivityData();
      res.json(activity);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/dashboard/chat-analytics", isAuthenticated, async (_req, res) => {
    try {
      const { getChatAnalytics } = await import("../services/sdr/chat-handlers");
      const analytics = await getChatAnalytics();
      res.json(analytics);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/config", isAuthenticated, async (_req, res) => {
    try {
      const { getSearchMatrix } = await import("../services/sdr/lead-finder");
      const matrix = await getSearchMatrix();
      res.json(matrix);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.put("/api/sdr/discovery/config", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    try {
      const { updateSearchMatrix } = await import("../services/sdr/lead-finder");
      const updated = await updateSearchMatrix(req.body);
      res.json(updated);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/discovery/run", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    try {
      return res.status(503).json({ message: "Lead discovery is disabled pending durable command ownership.", execution: "unavailable" });
      const { runLeadDiscovery } = await import("../services/sdr/lead-finder");
      const { acquireJobLock } = await import("../services/job-registry");
      const lease = await acquireJobLock("sdr-lead-discovery");
      if (lease.status === "held") return res.status(409).json({ message: "Lead discovery is already running", execution: "held" });
      if (lease.status === "unavailable") return res.status(503).json({ message: "Lead discovery registry is unavailable", execution: "unavailable" });
      const { verticals, metros, dataSources } = req.body;
      res.status(202).json({ message: "Lead discovery accepted", started: true, execution: "accepted" });
      runLeadDiscovery("manual", { verticals, metros, dataSources }, { lockToken: (lease as any).lockToken }).catch(err =>
        console.error("[LeadDiscovery API] Error:", err)
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/key-status", isAuthenticated, async (_req, res) => {
    res.json({
      serper: !!process.env.SERPER_API_KEY,
      outscraper: !!process.env.OUTSCRAPER_API_KEY,
      apify: !!process.env.APIFY_TOKEN,
      apollo: !!process.env.APOLLO_API_KEY,
      zeroBounce: !!process.env.ZEROBOUNCE_API_KEY,
    });
  });

  app.post("/api/sdr/discovery/pilot", isAuthenticated, async (req, res) => {
    if ((req as any).user?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    try {
      return res.status(503).json({ message: "Pilot discovery is disabled pending durable command ownership.", execution: "unavailable" });
      const safeLimit = Math.min(req.body.limit ?? 25, 50);
      const { sources, verticals, metros } = req.body;
      const job = await storage.createLeadDiscoveryJob({
        status: "pending",
        triggerType: "pilot",
        searchVerticals: verticals,
        searchMetros: metros,
        dataSources: sources,
        startedAt: new Date(),
      });
      const { runPilotDiscovery } = await import("../services/sdr/lead-finder");
      runPilotDiscovery({ limit: safeLimit, sources: sources || [], verticals, metros, jobId: job.id }).catch(err =>
        console.error("[PilotDiscovery API] Error:", err)
      );
      res.json({ message: "Pilot discovery started", jobId: job.id, safeLimit });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/source-performance", isAuthenticated, async (_req, res) => {
    try {
      const jobs = await storage.getLeadDiscoveryJobs(100);
      const pilotJobs = jobs.filter(j => j.triggerType === "pilot");

      // Estimate-only per-result cost constants, for display purposes only —
      // NOT billing-accurate figures. Sources not listed here have genuinely
      // unknown per-result pricing and are reported as costTracked: false
      // rather than being defaulted to $0.
      // Free/no-cost sources are listed explicitly with a cost of 0 so they
      // are distinguishable from "cost unknown".
      const SOURCE_COST_PER_RESULT_ESTIMATE: Record<string, { perResult: number; basis: string }> = {
        outscraper: { perResult: 0.021, basis: "outscraper_per_result_estimate" },
        serper: { perResult: 0.001, basis: "serper_per_query_estimate" },
        apify: { perResult: 0.05, basis: "apify_per_result_estimate" },
        apollo: { perResult: 0.05, basis: "apollo_per_contact_estimate" },
        osm: { perResult: 0, basis: "free_source" },
        yellowpages: { perResult: 0, basis: "free_source" },
        bbb: { perResult: 0, basis: "free_source" },
      };

      const sourceMap: Record<string, {
        leadsFound: number;
        newInserted: number;
        duplicatesSkipped: number;
        abLeads: number;
        processorCoverage: number;
        totalScored: number;
      }> = {};

      for (const job of pilotJobs) {
        const results = await storage.getLeadDiscoveryResults(job.id);
        for (const r of results) {
          const src = r.source || "unknown";
          if (!sourceMap[src]) {
            sourceMap[src] = { leadsFound: 0, newInserted: 0, duplicatesSkipped: 0, abLeads: 0, processorCoverage: 0, totalScored: 0 };
          }
          sourceMap[src].leadsFound++;
          if (r.status === "inserted") sourceMap[src].newInserted++;
          if (r.status?.startsWith("duplicate")) sourceMap[src].duplicatesSkipped++;

          if (r.merchantId) {
            const leadState = await storage.getSdrLeadStateByMerchant(r.merchantId);
            if (leadState) {
              sourceMap[src].totalScored++;
              if (leadState.qualificationTier === "A" || leadState.qualificationTier === "B") {
                sourceMap[src].abLeads++;
              }
              const enrichData = (leadState.enrichmentData as Record<string, any>) || {};
              if (enrichData.processorSignals && Object.keys(enrichData.processorSignals).length > 0) {
                sourceMap[src].processorCoverage++;
              }
            }
          }
        }
        // Deliberately NOT using job.costEstimate here: leadDiscoveryJobs
        // stores a single job-level cost with no per-source attribution, so
        // splitting it evenly across dataSources would misrepresent sources
        // that produced very different result volumes. Instead, cost is
        // derived per source from actual result counts × a labeled
        // per-result estimate (see SOURCE_COST_PER_RESULT_ESTIMATE above).
      }

      const performance = Object.entries(sourceMap).map(([source, data]) => {
        const pricing = SOURCE_COST_PER_RESULT_ESTIMATE[source];
        const costTracked = !!pricing;
        const costEstimate = costTracked ? Math.round(data.leadsFound * pricing.perResult * 100) / 100 : null;
        const costBasis = costTracked ? pricing.basis : "not_tracked";
        const costPerAbLead = costTracked && costEstimate !== null && data.abLeads > 0
          ? Math.round((costEstimate / data.abLeads) * 100) / 100
          : null;

        return {
          source,
          leadsFound: data.leadsFound,
          newInserted: data.newInserted,
          duplicatesSkipped: data.duplicatesSkipped,
          duplicateRate: data.leadsFound > 0 ? Math.round((data.duplicatesSkipped / data.leadsFound) * 100) : 0,
          abRate: data.totalScored > 0 ? Math.round((data.abLeads / data.totalScored) * 100) : null,
          processorCoverage: data.totalScored > 0 ? Math.round((data.processorCoverage / data.totalScored) * 100) : null,
          costTracked,
          costEstimate,
          costBasis,
          costPerAbLead,
        };
      });

      res.json({ performance, pilotJobCount: pilotJobs.length });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/status", isAuthenticated, async (_req, res) => {
    try {
      const { isDiscoveryRunning, isNightlyDiscoveryRunning } = await import("../services/sdr/lead-finder");
      res.json({
        discoveryRunning: isDiscoveryRunning(),
        nightlySchedulerActive: isNightlyDiscoveryRunning(),
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/discovery/nightly/start", isAuthenticated, async (_req, res) => {
    // MI-04: Legacy nightly discovery is retired. Durable BullMQ pipeline is now
    // the sole authority for free enrichment scheduling.
    return res.status(410).json({
      code: "DURABLE_DISCOVERY_AUTHORITY_REQUIRED",
      message: "Legacy nightly discovery is retired. The free enrichment pipeline is now managed by the durable BullMQ enrichment queue with a 4-hour cadence fence.",
    });
  });

  app.post("/api/sdr/discovery/nightly/stop", isAuthenticated, async (req, res) => {
    if ((req as any).user?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    try {
      const { stopNightlyDiscovery } = await import("../services/sdr/lead-finder");
      stopNightlyDiscovery();
      res.json({ message: "Nightly discovery scheduler stopped" });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/jobs", isAuthenticated, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const jobs = await storage.getLeadDiscoveryJobs(limit);
      res.json(jobs);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/jobs/:id", isAuthenticated, async (req, res) => {
    try {
      const job = await storage.getLeadDiscoveryJob(Number(req.params.id));
      if (!job) return res.status(404).json({ message: "Job not found" });
      const results = await storage.getLeadDiscoveryResults(job.id);
      res.json({ ...job, results });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/stats", isAuthenticated, async (_req, res) => {
    try {
      const stats = await storage.getLeadDiscoveryStats();
      res.json(stats);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/owner-coverage", isAuthenticated, async (_req, res) => {
    try {
      const { getOwnerEmailCoverage } = await import("../services/sdr/contactpage-enrichment");
      const coverage = await getOwnerEmailCoverage();
      res.json(coverage);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery/source-status", isAuthenticated, async (_req, res) => {
    try {
      const { isOutscraperConfigured, getOutscraperUsage } = await import("../services/sdr/outscraper");
      const { isApifyConfigured, getApifyUsage } = await import("../services/sdr/apify");
      const { isApolloConfigured, getApolloUsage } = await import("../services/sdr/apollo");
      const serperConfigured = isSerperConfigured();
      const serperUsage = await getSerperUsage();
      const outscrConfigured = isOutscraperConfigured();
      const outscrUsage = outscrConfigured ? await getOutscraperUsage() : null;
      const apifyConfigured = isApifyConfigured();
      const apifyUsage = apifyConfigured ? await getApifyUsage() : null;
      const apolloConfigured = isApolloConfigured();
      const apolloUsage = await getApolloUsage();

      res.json({
        serper: { configured: serperConfigured, usage: serperUsage },
        outscraper: { configured: false, enabled: false, state: "disabled_pending_durable_operation" },
        apify: { configured: false, enabled: false, state: "disabled_pending_durable_operation" },
        apollo: { configured: false, enabled: false, state: "disabled_pending_durable_operation" },
        osm: { configured: true, free: true, description: "OpenStreetMap Overpass — no key required" },
        yellowpages: { configured: true, free: true, description: "YP.com scraper — no key required" },
        bbb: { configured: true, free: true, description: "BBB.org accreditation listings — no key required" },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/discovery/test-source", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    const { source } = req.body;
    try {
      return res.status(503).json({ success: false, message: "Provider connection tests are disabled pending durable approved operations." });
      if (source === "apollo") {
        const { testApolloConnection } = await import("../services/sdr/apollo");
        const result = await testApolloConnection();
        return res.json(result);
      }
      return res.status(400).json({ success: false, message: `Test not supported for source: ${source}` });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ success: false, message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/bot-contexts", isAuthenticated, async (_req, res) => {
    const { getAllBotContexts } = await import("../services/sdr/conversation-ai");
    const contexts = getAllBotContexts().map(c => ({
      contextId: c.contextId,
      name: c.name,
      verticalKey: c.verticalKey || null,
    }));
    res.json(contexts);
  });

  app.post("/api/sdr/bot-context/resolve", isAuthenticated, async (req, res) => {
    try {
      const { getBotContextForContact } = await import("../services/sdr/chat-handlers");
      const { ghlContactId, pageUrl } = req.body;
      if (!ghlContactId) return res.status(400).json({ message: "ghlContactId required" });
      const result = await getBotContextForContact(ghlContactId, pageUrl);
      res.json(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/config", isAuthenticated, async (_req, res) => {
    const { getSdrGhlConfig } = await import("../services/sdr/ghl-client");
    res.json(getSdrGhlConfig());
  });

  app.post("/api/sdr/bootstrap-ghl", isAuthenticated, async (req, res) => {
    if ((req.user as { role?: string })?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    try {
      const { bootstrapGhlCustomFieldsAndTags } = await import("../services/sdr/ghl-client");
      const result = await bootstrapGhlCustomFieldsAndTags();
      res.json(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/sync-lead-state/:merchantId", isAuthenticated, async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      const { syncLeadStateToGhl } = await import("../services/sdr/ghl-sync-rules");
      await syncLeadStateToGhl(merchantId);
      res.json({ success: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/classify-intent", isAuthenticated, async (req, res) => {
    try {
      const { classifyIntent } = await import("../services/sdr/reply-intelligence");
      const { messageText, context } = req.body;
      if (!messageText) return res.status(400).json({ message: "messageText is required" });
      const result = await classifyIntent(messageText, context || {});
      res.json(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/trigger-call/:merchantId", isAuthenticated, async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      if (!Number.isFinite(merchantId) || merchantId <= 0) return res.status(400).json({ message: "Invalid merchantId" });
      const { botMode } = req.body;
      if (!botMode) return res.status(400).json({ message: "botMode is required" });
      const { triggerAiCall, VOICE_BOT_MODES } = await import("../services/sdr/voice-orchestrator");
      if (!(VOICE_BOT_MODES as readonly string[]).includes(botMode)) {
        return res.status(400).json({ message: `Invalid botMode. Valid modes: ${VOICE_BOT_MODES.join(", ")}` });
      }
      const result = await triggerAiCall(merchantId, botMode);
      res.json(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/send-booking-link/:merchantId", isAuthenticated, async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      if (!Number.isFinite(merchantId) || merchantId <= 0) return res.status(400).json({ message: "Invalid merchantId" });
      const channel = req.body.channel || "sms";
      if (!["sms", "email", "chat"].includes(channel)) return res.status(400).json({ message: "Channel must be sms, email, or chat" });
      const { sendBookingLink } = await import("../services/sdr/scheduling");
      const result = await sendBookingLink(merchantId, channel);
      res.json(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/compliance-check/:merchantId/:channel", isAuthenticated, async (req, res) => {
    try {
      const merchantId = Number(req.params.merchantId);
      if (!Number.isFinite(merchantId) || merchantId <= 0) return res.status(400).json({ message: "Invalid merchantId" });
      const channel = req.params.channel as "sms" | "email" | "call";
      if (!["sms", "email", "call"].includes(channel)) {
        return res.status(400).json({ message: "Channel must be sms, email, or call" });
      }
      const { checkBeforeSend } = await import("../services/sdr/compliance-engine");
      const result = await checkBeforeSend(merchantId, channel);
      res.json(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/compliance/dashboard", isAuthenticated, async (_req, res) => {
    try {
      const { getComplianceDashboard } = await import("../services/sdr/compliance-engine");
      const dashboard = await getComplianceDashboard();
      res.json(dashboard);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/compliance/blocked-sends", isAuthenticated, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string || "100", 10);
      const { getBlockedSends } = await import("../services/sdr/compliance-engine");
      const blocked = await getBlockedSends(limit);
      res.json(blocked);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/leads/:id/handoff", isAuthenticated, async (req, res) => {
    try {
      const leadId = Number(req.params.id);
      if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ message: "Invalid lead ID" });
      const { assignedUserId, note } = req.body;
      if (!assignedUserId || typeof assignedUserId !== "string") return res.status(400).json({ message: "assignedUserId required" });
      if ((req.user as { role?: string })?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
      const { handoffToHuman } = await import("../services/sdr/human-handoff");
      const result = await handoffToHuman(leadId, assignedUserId, note);
      if (!result.success) return res.status(400).json({ message: result.error });
      res.json({ success: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/leads/:id/return-to-ai", isAuthenticated, async (req, res) => {
    try {
      const leadId = Number(req.params.id);
      if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ message: "Invalid lead ID" });
      if ((req.user as { role?: string })?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
      const { note } = req.body;
      const { returnToAi } = await import("../services/sdr/human-handoff");
      const result = await returnToAi(leadId, note);
      if (!result.success) return res.status(400).json({ message: result.error });
      res.json({ success: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/leads/:id/block-automation", isAuthenticated, async (req, res) => {
    try {
      const leadId = Number(req.params.id);
      if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ message: "Invalid lead ID" });
      if ((req.user as { role?: string })?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
      const { reason } = req.body;
      const { blockAutomation } = await import("../services/sdr/human-handoff");
      const result = await blockAutomation(leadId, reason);
      if (!result.success) return res.status(400).json({ message: result.error });
      res.json({ success: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/proposals/:trackingId/mark-viewed", async (req, res) => {
    try {
      const trackingId = req.params.trackingId;
      if (!trackingId || trackingId.length < 16) return res.status(400).json({ message: "Invalid tracking ID" });
      const { markProposalViewedByTrackingId } = await import("../services/sdr/proposal-tracking");
      const result = await markProposalViewedByTrackingId(trackingId);
      res.json({ success: result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/proposals/:trackingId/mark-clicked", async (req, res) => {
    try {
      const trackingId = req.params.trackingId;
      if (!trackingId || trackingId.length < 16) return res.status(400).json({ message: "Invalid tracking ID" });
      const { markProposalClickedByTrackingId } = await import("../services/sdr/proposal-tracking");
      const result = await markProposalClickedByTrackingId(trackingId);
      res.json({ success: result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/leads/:id/terminal-shipped", isAuthenticated, async (req, res) => {
    try {
      const leadId = Number(req.params.id);
      if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ message: "Invalid lead ID" });
      if ((req.user as { role?: string })?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
      const { trackingNumber } = req.body;
      if (!trackingNumber || typeof trackingNumber !== "string") return res.status(400).json({ message: "trackingNumber required" });
      const { handleTerminalShipped } = await import("../services/sdr/terminal-shipping");
      const result = await handleTerminalShipped(leadId, trackingNumber);
      res.json({ success: result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/statement-upload/:token", async (req, res) => {
    try {
      const token = req.params.token;

      // Check statement_requests table first (CRM-issued manual request tokens)
      const statementReq = await storage.getStatementRequestByToken(token);
      if (statementReq) {
        const contact = await storage.getContact(statementReq.contactId);
        return res.json({
          merchantId: null,
          companyName: contact?.companyName ?? contact?.firstName ?? "Merchant",
          valid: true,
          source: "statement_request",
        });
      }

      // Fallback: legacy SDR lead upload token
      const { findLeadByUploadToken } = await import("../services/sdr/statement-flow");
      const lead = await findLeadByUploadToken(token);
      if (!lead) return res.status(404).json({ message: "Invalid or expired upload link" });
      res.json({ merchantId: lead.merchantId, companyName: lead.companyName, valid: true, source: "sdr" });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/statement-upload/:token", async (req, res, next) => {
    const { upload } = await import("./helpers");
    upload.single("statementFile")(req, res, async (multerErr) => {
      if (multerErr) {
        return res.status(400).json({ message: `File upload error: ${multerErr.message}` });
      }
      // Tracks the idempotency slot we own so a route-level error can honestly
      // mark the command recoverable-failed instead of leaving it in_progress.
      let ownedCommandId: string | null = null;
      let idemMarkRecoverableFailedRef: ((id: string, result: Record<string, unknown>) => Promise<unknown>) | null = null;
      try {
        const token = req.params.token;

        // ── Idempotency-Key guard (required before any business mutation) ──
        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
        if (!idempotencyKey) {
          return res.status(400).json({
            error: "MISSING_IDEMPOTENCY_KEY",
            message: "Idempotency-Key header is required. Supply a UUID v4.",
          });
        }
        const { claimCommand: claim, computeRequestFingerprint, isValidUUIDv4, updateContext: idemUpdateContext, markRecoverableFailed: idemMarkRecoverableFailed } =
          await import("../services/statement-upload-idempotency");
        idemMarkRecoverableFailedRef = idemMarkRecoverableFailed;
        const { createHash: _sha256 } = await import("node:crypto");
        if (!isValidUUIDv4(idempotencyKey)) {
          return res.status(400).json({
            error: "INVALID_IDEMPOTENCY_KEY",
            message: "Idempotency-Key must be a valid UUID v4.",
          });
        }

        // Derive a non-reversible scope from the token so we never expose the raw token.
        const tokenScope = (t: string) =>
          `token-sha256:${_sha256("sha256").update(t).digest("hex")}`;

        // Check statement_requests table first
        const statementReq = await storage.getStatementRequestByToken(token);
        if (statementReq) {
          const fileBuffer = (req as any).file?.buffer as Buffer | undefined;
          if (!fileBuffer || !(req as any).file?.originalname) {
            return res.status(400).json({
              error: "STATEMENT_FILE_REQUIRED",
              message: "A statement file is required before this upload can be accepted.",
            });
          }
          const fingerprint = computeRequestFingerprint({
            fields: {
              contactId: statementReq.contactId,
              dealId: statementReq.dealId ?? null,
              source: "token-upload",
              workflow: "statement-request-upload",
              fileName: (req as any).file?.originalname ?? null,
            },
            fileBuffer: fileBuffer ?? Buffer.alloc(0),
          });
          const ownerScope = tokenScope(token);

          const claimResult = await claim({
            requestId: idempotencyKey,
            fingerprint,
            ownerScope,
            source: "token-upload",
            contactId: statementReq.contactId,
            dealId: statementReq.dealId ?? undefined,
          });

          if (claimResult.outcome === "conflict") {
            return res.status(409).json({ error: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency-Key used with different payload." });
          }
          if (claimResult.outcome === "scope_mismatch") {
            return res.status(403).json({ error: "IDEMPOTENCY_KEY_SCOPE_MISMATCH", message: "Idempotency-Key belongs to a different caller." });
          }
          if (claimResult.outcome === "claimed_by_other") {
            return res.status(202).json({ error: "IDEMPOTENCY_IN_PROGRESS", message: "Upload already in progress.", commandId: claimResult.commandId });
          }
          if (claimResult.outcome === "replay") {
            const stored = claimResult.command.result as Record<string, unknown> | null;
            res.setHeader("Idempotency-Key", idempotencyKey);
            res.setHeader("X-Statement-Upload-Request-Id", claimResult.command.id);
            return res.status(200).json({
              success: true,
              replayed: true,
              statement_upload_request_id: claimResult.command.id,
              ...(stored ?? {}),
            });
          }
          if (claimResult.outcome === "recoverable_failed_replay") {
            // Prior attempt for this key failed recoverably — return the honest
            // stored failure; never fall through to a fresh mutation.
            const stored = claimResult.command.result as Record<string, unknown> | null;
            res.setHeader("Idempotency-Key", idempotencyKey);
            res.setHeader("X-Statement-Upload-Request-Id", claimResult.command.id);
            return res.status(422).json({
              error: "IDEMPOTENCY_KEY_RECOVERABLE_FAILED",
              message: "A prior attempt with this Idempotency-Key failed. Retry with a new Idempotency-Key.",
              replayed: true,
              statement_upload_request_id: claimResult.command.id,
              ...(stored ?? {}),
            });
          }

          const commandId = claimResult.command.id;
          ownedCommandId = commandId;

          // Persist context before running the chain.
          await idemUpdateContext(commandId, {
            contactId: statementReq.contactId,
            dealId: statementReq.dealId ?? null,
            source: "token-upload",
            workflow: "statement-request-upload",
            fileName: (req as any).file?.originalname ?? null,
          });

          const { persistAndEnqueueStatementCommand } = await import("../services/statement-command-worker");
          const { putProtectedObject } = await import("../services/protected-object");
          const protectedObject = await putProtectedObject({
            bytes: fileBuffer,
            mimeType: (req as any).file?.mimetype || "application/pdf",
            fileName: (req as any).file.originalname,
            tenantScope: `contact:${statementReq.contactId}`,
          });
          const statementQueued = await persistAndEnqueueStatementCommand({
            contactId: statementReq.contactId,
            dealId: statementReq.dealId ?? undefined,
            fileName: (req as any).file?.originalname,
            protectedObjectRef: protectedObject.objectRef,
            protectedObjectChecksum: protectedObject.checksumSha256,
            source: "token-upload",
            commandId,
          });
          if (!statementQueued) {
            return res.status(503).json({ error: "STATEMENT_COMMAND_QUEUE_UNAVAILABLE", statement_upload_request_id: commandId });
          }
          const srAccepted = {
            success: true,
            deferred: true,
            statement_upload_request_id: commandId,
          };
          // Do NOT markSucceeded here — the chain owns its own terminal result.

          res.setHeader("Idempotency-Key", idempotencyKey);
          res.setHeader("X-Statement-Upload-Request-Id", commandId);
          return res.status(202).json(srAccepted);
        }

        // Fallback: check sdrLeadState token
        const { findLeadByUploadToken } = await import("../services/sdr/statement-flow");
        const lead = await findLeadByUploadToken(token);
        if (!lead) return res.status(404).json({ message: "Invalid or expired upload link" });

        const fileBuffer = (req as any).file?.buffer as Buffer | undefined;
        if (!fileBuffer || !(req as any).file?.originalname) {
          return res.status(400).json({
            error: "STATEMENT_FILE_REQUIRED",
            message: "A statement file is required before this upload can be accepted.",
          });
        }
        if (!lead.contactId) {
          return res.status(422).json({
            error: "STATEMENT_UPLOAD_CONTACT_REQUIRED",
            message: "This upload link is not linked to a contact and cannot be processed.",
          });
        }
        const fingerprint = computeRequestFingerprint({
          fields: {
            leadId: lead.id,
            contactId: lead.contactId ?? null,
            source: "token-upload",
            workflow: "sdr-lead-statement-upload",
            fileName: (req as any).file?.originalname ?? null,
          },
          fileBuffer: fileBuffer ?? Buffer.alloc(0),
        });
        const ownerScope = tokenScope(token);

        const claimResult = await claim({
          requestId: idempotencyKey,
          fingerprint,
          ownerScope,
          source: "token-upload",
          contactId: lead.contactId ?? undefined,
          dealId: lead.dealId ?? undefined,
        });

        if (claimResult.outcome === "conflict") {
          return res.status(409).json({ error: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency-Key used with different payload." });
        }
        if (claimResult.outcome === "scope_mismatch") {
          return res.status(403).json({ error: "IDEMPOTENCY_KEY_SCOPE_MISMATCH", message: "Idempotency-Key belongs to a different caller." });
        }
        if (claimResult.outcome === "claimed_by_other") {
          return res.status(202).json({ error: "IDEMPOTENCY_IN_PROGRESS", message: "Upload already in progress.", commandId: claimResult.commandId });
        }
        if (claimResult.outcome === "replay") {
          const stored = claimResult.command.result as Record<string, unknown> | null;
          res.setHeader("Idempotency-Key", idempotencyKey);
          res.setHeader("X-Statement-Upload-Request-Id", claimResult.command.id);
          return res.status(200).json({
            success: true,
            replayed: true,
            statement_upload_request_id: claimResult.command.id,
            ...(stored ?? {}),
          });
        }
        if (claimResult.outcome === "recoverable_failed_replay") {
          // Prior attempt for this key failed recoverably — return the honest
          // stored failure; never fall through to a fresh mutation.
          const stored = claimResult.command.result as Record<string, unknown> | null;
          res.setHeader("Idempotency-Key", idempotencyKey);
          res.setHeader("X-Statement-Upload-Request-Id", claimResult.command.id);
          return res.status(422).json({
            error: "IDEMPOTENCY_KEY_RECOVERABLE_FAILED",
            message: "A prior attempt with this Idempotency-Key failed. Retry with a new Idempotency-Key.",
            replayed: true,
            statement_upload_request_id: claimResult.command.id,
            ...(stored ?? {}),
          });
        }

        const commandId = claimResult.command.id;
        ownedCommandId = commandId;

        // Persist context before handing off to the queue-owned chain.
        await idemUpdateContext(commandId, {
          leadId: lead.id,
          contactId: lead.contactId ?? null,
          dealId: lead.dealId ?? null,
          source: "token-upload",
          workflow: "sdr-lead-statement-upload",
          fileName: (req as any).file?.originalname ?? null,
        });

        const { persistAndEnqueueStatementCommand } = await import("../services/statement-command-worker");
        const { putProtectedObject } = await import("../services/protected-object");
        const protectedObject = await putProtectedObject({
          bytes: fileBuffer,
          mimeType: (req as any).file?.mimetype || "application/pdf",
          fileName: (req as any).file.originalname,
          tenantScope: `contact:${lead.contactId}`,
        });
        const statementQueued = await persistAndEnqueueStatementCommand({
          contactId: lead.contactId,
          dealId: lead.dealId ?? undefined,
          fileName: (req as any).file?.originalname,
          protectedObjectRef: protectedObject.objectRef,
          protectedObjectChecksum: protectedObject.checksumSha256,
          source: "token-upload",
          commandId,
        });
        if (!statementQueued) {
          return res.status(503).json({ error: "STATEMENT_COMMAND_QUEUE_UNAVAILABLE", statement_upload_request_id: commandId });
        }

        const leadAccepted = {
          success: true,
          deferred: true,
          statement_upload_request_id: commandId,
        };

        res.setHeader("Idempotency-Key", idempotencyKey);
        res.setHeader("X-Statement-Upload-Request-Id", commandId);
        return res.status(202).json(leadAccepted);
      } catch (err: unknown) {
        // Route-level error after claim — honestly mark the owned slot
        // recoverable-failed so the key never replays as a success.
        if (ownedCommandId && idemMarkRecoverableFailedRef) {
          await idemMarkRecoverableFailedRef(ownedCommandId, {
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => { /* best-effort */ });
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ message: safeMessage(errMsg) });
      }
    });
  });

  app.get("/api/sdr/dashboard", isAuthenticated, async (req, res) => {
    try {
      const stats = await getSdrDashboardStats();
      res.json(stats);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/leads", isAuthenticated, async (req, res) => {
    try {
      const { stage, priorityBucket, limit } = req.query;
      const leads = await storage.getSdrLeadStates({
        stage: stage as string | undefined,
        priorityBucket: priorityBucket as string | undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.json(leads);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/leads/:id", isAuthenticated, async (req, res) => {
    const lead = await storage.getSdrLeadState(Number(req.params.id));
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    const events = await storage.getSdrLeadEvents(lead.id);
    const attempts = await storage.getSdrChannelAttempts(lead.id);
    res.json({ lead, events, attempts });
  });

  app.post("/api/sdr/leads/:id/score", isAuthenticated, async (req, res) => {
    try {
      const lead = await storage.getSdrLeadState(Number(req.params.id));
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      const scores = scoreLeadFull(lead);
      const updated = await storage.updateSdrLeadState(lead.id, {
        fitScore: scores.fitScore,
        revenueScore: scores.revenueScore,
        reachabilityScore: scores.reachabilityScore,
        priorityScore: scores.priorityScore,
        priorityBucket: scores.priorityBucket,
        scoreBreakdown: scores.breakdown,
        lastScoredAt: new Date(),
      });
      res.json({ scores, lead: updated });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/sdr/leads/:id", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    try {
      const allowedFields = ["stage", "pausedUntil", "vertical", "companyName", "ownerName", "ownerEmail", "ownerPhone", "decisionReason"];
      const sanitized: Record<string, any> = {};
      for (const key of allowedFields) {
        if (req.body[key] !== undefined) sanitized[key] = req.body[key];
      }
      const leadId = Number(req.params.id);
      const lead = await storage.getSdrLeadState(leadId);
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      const operatorEvidence = typeof req.body.evidenceNote === "string" ? req.body.evidenceNote.trim() : "";
      for (const [field, channel] of [["consentEmail", "email"], ["consentSms", "sms"], ["consentCall", "automated_phone"]] as const) {
        if (req.body[field] === undefined) continue;
        const enabled = req.body[field] === true;
        if (enabled && !operatorEvidence) {
          return res.status(400).json({ message: `evidenceNote is required to grant ${field}` });
        }
        await applyConsentCommand({
          subject: { type: "sdr_lead_state", id: leadId },
          kind: enabled ? "opt_in" : "opt_out",
          channel,
          purpose: "outreach",
          eventNamespace: "sdr_operator_edit",
          eventKey: `${leadId}:${field}:${String(req.body.requestId ?? Date.now())}`,
          source: "sdr_operator_edit",
          actorId: String((req.user as any)?.id ?? ""),
          evidence: { operatorEvidence: operatorEvidence || "explicit withdrawal", field },
          details: { field, enabled },
        });
      }
      for (const [field, channel] of [["optedOutEmail", "email"], ["optedOutSms", "sms"]] as const) {
        if (req.body[field] !== true) continue;
        await applyConsentCommand({
          subject: { type: "sdr_lead_state", id: leadId },
          kind: "opt_out",
          channel,
          purpose: "outreach",
          eventNamespace: "sdr_operator_edit",
          eventKey: `${leadId}:${field}:${String(req.body.requestId ?? Date.now())}`,
          source: "sdr_operator_edit",
          actorId: String((req.user as any)?.id ?? ""),
          evidence: { field, explicit: true },
          details: { field },
        });
      }
      if (Object.keys(sanitized).length === 0 && !["consentEmail", "consentSms", "consentCall", "optedOutEmail", "optedOutSms"].some((field) => req.body[field] !== undefined)) {
        return res.status(400).json({ message: "No valid fields provided" });
      }
      const updated = Object.keys(sanitized).length > 0
        ? await storage.updateSdrLeadState(leadId, sanitized)
        : await storage.getSdrLeadState(leadId);
      if (!updated) return res.status(404).json({ message: "Lead not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sdr/orchestrator/sweep", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    try {
      const result = await sweepLeads();
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sdr/orchestrator/start", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    if (!featureFlags.ORCHESTRATOR_ENABLED) {
      return res.status(400).json({ success: false, message: "Orchestrator is disabled via ORCHESTRATOR_ENABLED feature flag" });
    }
    startOrchestrator();
    res.json({ success: true, message: "Orchestrator started" });
  });

  app.post("/api/sdr/orchestrator/stop", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    stopOrchestrator();
    res.json({ success: true, message: "Orchestrator stopped" });
  });

  app.get("/api/sdr/orchestrator/status", isAuthenticated, async (req, res) => {
    res.json({
      running: isOrchestratorRunning(),
      enabled: featureFlags.ORCHESTRATOR_ENABLED,
      webhookFailures: getWebhookFailureCount(),
      dailyLimits: getDailyLimits(),
    });
  });

  app.post("/api/sdr/bridge-contacts", isAuthenticated, async (_req, res) => {
    res.status(410).json({ message: "Deprecated — use POST /api/sdr/bridge with source='contacts' instead" });
  });

  app.get("/api/sdr/daily-limits", isAuthenticated, async (req, res) => {
    res.json(getDailyLimits());
  });

  app.get("/api/sdr/voice-scripts", isAuthenticated, async (_req, res) => {
    res.json(getAllVoiceScripts());
  });

  app.get("/api/sdr/voice-scripts/:verticalKey", isAuthenticated, async (req, res) => {
    const script = getVoiceScript(req.params.verticalKey as string);
    if (!script) return res.status(404).json({ message: "Voice script not found for vertical: " + req.params.verticalKey });
    res.json(script);
  });

  app.post("/api/sdr/voice-scripts/resolve", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager', 'agent'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Insufficient permissions" });
    try {
      const { leadId, agentName } = req.body;
      if (!leadId) return res.status(400).json({ message: "leadId required" });

      const leads = await db.select().from(sdrLeadState).where(eq(sdrLeadState.id, leadId)).limit(1);
      const lead = leads[0];
      if (!lead) return res.status(404).json({ message: "Lead not found" });

      const script = resolveVoiceScriptForLead(lead);
      if (!script) return res.json({ script: null, reason: "No vertical-specific voice script available for this lead" });

      const personalized = personalizeVoiceScript(script, lead, agentName || "a team member");
      const ghlPayload = buildGhlVoicePayload(script, lead, agentName || "a team member");
      res.json({ script: personalized, ghlPayload });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/sending-identities", isAdmin, async (_req, res) => {
    try {
      const identities = await storage.getSendingIdentities();
      res.json(identities);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/sending-identities/:id", isAdmin, async (req, res) => {
    try {
      const identity = await storage.getSendingIdentity(Number(req.params.id));
      if (!identity) return res.status(404).json({ message: "Not found" });
      res.json(identity);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sdr/sending-identities", isAdmin, async (req, res) => {
    try {
      const { insertSendingIdentitySchema } = await import("@shared/schema");
      const { clampDailyLimit } = await import("../services/sdr/inbox-rotation");
      const parsed = insertSendingIdentitySchema.parse(req.body);
      if (parsed.dailyLimit !== undefined && parsed.dailyLimit !== null) {
        parsed.dailyLimit = clampDailyLimit(parsed.dailyLimit);
      }
      const identity = await storage.createSendingIdentity(parsed);
      res.status(201).json(identity);
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string; errors?: unknown[] };
      if (error.name === "ZodError") return res.status(400).json({ message: "Validation error", errors: error.errors });
      serverError(res, error);
    }
  });

  app.put("/api/sdr/sending-identities/:id", isAdmin, async (req, res) => {
    try {
      const { insertSendingIdentitySchema } = await import("@shared/schema");
      const { clampDailyLimit } = await import("../services/sdr/inbox-rotation");
      const updateSchema = insertSendingIdentitySchema.partial();
      const parsed = updateSchema.parse(req.body);
      if (parsed.dailyLimit !== undefined && parsed.dailyLimit !== null) {
        parsed.dailyLimit = clampDailyLimit(parsed.dailyLimit);
      }
      const identity = await storage.updateSendingIdentity(Number(req.params.id), parsed);
      if (!identity) return res.status(404).json({ message: "Not found" });
      res.json(identity);
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string; errors?: unknown[] };
      if (error.name === "ZodError") return res.status(400).json({ message: "Validation error", errors: error.errors });
      serverError(res, error);
    }
  });

  app.delete("/api/sdr/sending-identities/:id", isAdmin, async (req, res) => {
    try {
      const deleted = await storage.deleteSendingIdentity(Number(req.params.id));
      if (!deleted) return res.status(404).json({ message: "Not found" });
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/inbox-health", isAdmin, async (_req, res) => {
    try {
      const { getInboxHealthDashboard } = await import("../services/sdr/inbox-rotation");
      const dashboard = await getInboxHealthDashboard();
      res.json(dashboard);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sdr/inbox-maintenance", isAdmin, async (_req, res) => {
    try {
      const { runDailyMaintenance } = await import("../services/sdr/inbox-rotation");
      const result = await runDailyMaintenance();
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sdr/inbox-health-scores", isAdmin, async (_req, res) => {
    try {
      const { calculateHealthScores } = await import("../services/sdr/inbox-rotation");
      const result = await calculateHealthScores();
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/processor-intelligence", isAuthenticated, async (_req, res) => {
    try {
      const { getProcessorDistribution, getProcessorCoverage, getConversionByProcessor } = await import("../services/sdr/processor-detector");
      const { getAdDistribution } = await import("../services/sdr/ad-detector");
      const [distribution, coverage, adDist, conversionByProcessor] = await Promise.all([
        getProcessorDistribution(),
        getProcessorCoverage(),
        getAdDistribution(),
        getConversionByProcessor(),
      ]);
      res.json({ processorDistribution: distribution, coverage, adDistribution: adDist, conversionByProcessor });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/processor-signals/:businessId", isAuthenticated, async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ message: "Invalid business ID" });
    try {
      const { getProcessorSignals } = await import("../services/sdr/processor-detector");
      const signals = await getProcessorSignals(businessId);
      res.json(signals);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sdr/detect-processors/:businessId", isAuthenticated, async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ message: "Invalid business ID" });
    try {
      const { detectProcessors } = await import("../services/sdr/processor-detector");
      const results = await detectProcessors(businessId);
      res.json({ detected: results.length, results });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/ad-signals/:businessId", isAuthenticated, async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ message: "Invalid business ID" });
    try {
      const { getAdSignals } = await import("../services/sdr/ad-detector");
      const signals = await getAdSignals(businessId);
      res.json(signals);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sdr/detect-ads/:businessId", isAuthenticated, async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!businessId || isNaN(businessId)) return res.status(400).json({ message: "Invalid business ID" });
    try {
      const { detectAds } = await import("../services/sdr/ad-detector");
      const results = await detectAds(businessId);
      res.json({ detected: results.length, results });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // A business collection has no single object on which an agent scope can be
  // established before querying. Keep this discovery/count boundary privileged.
  app.get("/api/businesses", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { status, vertical, limit } = req.query;
      const result = await storage.getBusinesses({
        status: status as string | undefined,
        vertical: vertical as string | undefined,
        limit: limit ? Number(limit) : undefined,
      });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/businesses", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertBusinessSchema.parse(req.body);
      const { resolveOrganization } = await import("../services/organization-resolver");
      const result = await resolveOrganization({
        canonicalName: input.canonicalName,
        websiteDomain: input.websiteDomain,
        googlePlaceId: input.googlePlaceId,
        mainPhone: input.mainPhone,
        city: input.city,
        state: input.state,
        create: input,
      });
      if (result.kind === "deferred") return res.status(409).json(result);
      res.status(result.kind === "created" ? 201 : 200).json(result.business);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.post("/api/businesses/ingest", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const result = await ingestBusiness(req.body);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/businesses/bridge-contacts", isAuthenticated, async (_req, res) => {
    res.status(410).json({ message: "Deprecated — use POST /api/sdr/bridge with source='contacts' instead" });
  });

  app.get("/api/businesses/dedupe/stats", isDashboardUser, requireRole("admin", "manager"), async (_req, res) => {
    try {
      const stats = await getDedupeStats();
      res.json(stats);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/businesses/:id", isAuthenticated, async (req, res) => {
    try {
      if (!await authorizeBusinessAccess(req, res, Number(req.params.id))) return;
      const biz = await storage.getBusiness(Number(req.params.id));
      if (!biz) return res.status(404).json({ message: "Not found", code: "CRM_OBJECT_NOT_FOUND" });
      res.json(biz);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/businesses/:id", isAuthenticated, async (req, res) => {
    try {
      if (!await authorizeBusinessAccess(req, res, Number(req.params.id))) return;
      if (!["admin", "manager"].includes((req.user as any)?.role)) return res.status(404).json({ message: "Not found", code: "CRM_OBJECT_NOT_FOUND" });
      const partial = insertBusinessSchema.partial().parse(req.body);
      const biz = await updateOrganizationDescriptive(Number(req.params.id), partial);
      if (!biz) return res.status(404).json({ message: "Business not found" });
      res.json(biz);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.get("/api/businesses/:id/aliases", isAuthenticated, async (req, res) => {
    try {
      if (!await authorizeBusinessAccess(req, res, Number(req.params.id))) return;
      const aliases = await storage.getBusinessAliases(Number(req.params.id));
      res.json(aliases);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/businesses/:id/aliases", isAuthenticated, async (req, res) => {
    try {
      if (!await authorizeBusinessAccess(req, res, Number(req.params.id))) return;
      if (!["admin", "manager"].includes((req.user as any)?.role)) return res.status(404).json({ message: "Not found", code: "CRM_OBJECT_NOT_FOUND" });
      const input = insertBusinessAliasSchema.parse({ ...req.body, businessId: Number(req.params.id) });
      const alias = await storage.createBusinessAlias(input);
      res.status(201).json(alias);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.get("/api/businesses/:id/locations", isAuthenticated, async (req, res) => {
    try {
      if (!await authorizeBusinessAccess(req, res, Number(req.params.id))) return;
      const locations = await storage.getBusinessLocations(Number(req.params.id));
      res.json(locations);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/businesses/:id/locations", isAuthenticated, async (req, res) => {
    try {
      if (!await authorizeBusinessAccess(req, res, Number(req.params.id))) return;
      if (!["admin", "manager"].includes((req.user as any)?.role)) return res.status(404).json({ message: "Not found", code: "CRM_OBJECT_NOT_FOUND" });
      const input = insertBusinessLocationSchema.parse({ ...req.body, businessId: Number(req.params.id) });
      const loc = await storage.createBusinessLocation(input);
      res.status(201).json(loc);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.get("/api/businesses/:id/sources", isAuthenticated, async (req, res) => {
    try {
      if (!await authorizeBusinessAccess(req, res, Number(req.params.id))) return;
      const sources = await storage.getLeadSources(Number(req.params.id));
      res.json(sources);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/businesses/:id/enrichment-runs", isAuthenticated, async (req, res) => {
    try {
      if (!await authorizeBusinessAccess(req, res, Number(req.params.id))) return;
      const runs = await storage.getEnrichmentRuns(Number(req.params.id));
      res.json(runs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/lead-sources", isAuthenticated, async (req, res) => {
    try {
      const sources = await storage.getLeadSources();
      res.json(sources);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/lead-sources", isAuthenticated, async (req, res) => {
    try {
      const input = insertLeadSourceSchema.parse(req.body);
      const source = await storage.createLeadSource(input);
      res.status(201).json(source);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.get("/api/lead-sources/by-batch/:batchId", isAuthenticated, async (req, res) => {
    try {
      const sources = await storage.getLeadSourcesByBatch(req.params.batchId as string);
      res.json(sources);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sdr/lookalike/profile", isAuthenticated, async (_req, res) => {
    try {
      const { getLookalikeProfile } = await import("../services/sdr/lookalike");
      const profile = await getLookalikeProfile();
      res.json(profile);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/lookalike/top", isAuthenticated, async (req, res) => {
    try {
      const { getTopLookalikes } = await import("../services/sdr/lookalike");
      const limit = parseInt(req.query.limit as string) || 20;
      const top = await getTopLookalikes(limit);
      res.json(top);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/lookalike/apply", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    try {
      const { applyLookalikeBoosts } = await import("../services/sdr/lookalike");
      const result = await applyLookalikeBoosts();
      res.json(result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/re-enrichment/stats", isAuthenticated, async (_req, res) => {
    try {
      const { getReEnrichmentStats } = await import("../services/sdr/re-enrichment");
      const stats = await getReEnrichmentStats();
      res.json(stats);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/re-enrichment/run", requireRole("admin", "manager"), async (_req, res) => {
    res.status(503).json({
      code: "CRO03_CANONICAL_SUBJECT_REQUIRED",
      message: "SDR staging re-enrichment is disabled pending canonical subject conversion.",
    });
  });

  app.get("/api/sdr/funnel-metrics", isAuthenticated, async (req, res) => {
    try {
      const { getFunnelMetrics } = await import("../services/sdr/funnel-metrics");
      const metrics = await getFunnelMetrics({
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        vertical: req.query.vertical as string,
        state: req.query.state as string,
        sourceType: req.query.sourceType as string,
      });
      res.json(metrics);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/funnel-metrics/aggregate", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    try {
      const { aggregateDailyMetrics } = await import("../services/sdr/funnel-metrics");
      const dateStr = req.body.date as string | undefined;
      await aggregateDailyMetrics(dateStr);
      res.json({ message: "Aggregation complete" });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/source-quality", isAuthenticated, async (_req, res) => {
    try {
      const { getSourceQualityReport } = await import("../services/sdr/funnel-metrics");
      const report = await getSourceQualityReport();
      res.json(report);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/identity-health", isAuthenticated, async (_req, res) => {
    try {
      const { getIdentityHealthReport } = await import("../services/sdr/funnel-metrics");
      const report = await getIdentityHealthReport();
      res.json(report);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/event-kind-census", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { getSdrEventKindCensus } = await import("../services/sdr/funnel-metrics");
      res.json(await getSdrEventKindCensus(Number(req.query.days) || 30));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/market-expansion", isAuthenticated, async (_req, res) => {
    try {
      const { getMarketExpansionData } = await import("../services/sdr/funnel-metrics");
      const data = await getMarketExpansionData();
      res.json(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/weekly-kpi", isAuthenticated, async (_req, res) => {
    try {
      const { getWeeklyKpiDigestData } = await import("../services/sdr/funnel-metrics");
      const data = await getWeeklyKpiDigestData();
      res.json(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/operator/kpis", isAdmin, async (req, res) => {
    try {
      const { getOperatorKpis } = await import("../services/sdr/funnel-metrics");
      const range = (req.query.range as string) || "today";
      const data = await getOperatorKpis(range);
      res.json(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/operator/send-monitoring", isAdmin, async (_req, res) => {
    try {
      const { getSendMonitoringData } = await import("../services/sdr/funnel-metrics");
      const data = await getSendMonitoringData();
      res.json(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/operator/webhook-events", isAdmin, async (req, res) => {
    try {
      const { getWebhookEventLog } = await import("../services/sdr/funnel-metrics");
      const eventType = req.query.eventType as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const data = await getWebhookEventLog({ eventType, limit });
      res.json(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/operator/low-confidence", isAdmin, async (_req, res) => {
    try {
      const { getLowConfidenceClassifications } = await import("../services/sdr/funnel-metrics");
      const data = await getLowConfidenceClassifications();
      res.json(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/operator/bounce-feedback-summary", isAdmin, async (_req, res) => {
    try {
      const { getBounceFeedbackSummary } = await import("../services/bounce-feedback");
      const data = await getBounceFeedbackSummary();
      res.json(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/operator/send-daily-digest", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    try {
      const { buildSdrDailyDigest, sendSdrDailyDigest } = await import("../services/sdr/operator-digest");
      const digest = await buildSdrDailyDigest();
      await sendSdrDailyDigest(digest);
      res.json({ message: "Daily digest sent", summary: digest.summary });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/anomaly-alerts", isAuthenticated, async (_req, res) => {
    try {
      const { getAnomalyAlertsSummary } = await import("../services/sdr/anomaly-detection");
      const data = await getAnomalyAlertsSummary();
      res.json(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/operator/job-status", isAdmin, async (_req, res) => {
    try {
      const { getJobStatuses } = await import("../services/job-registry");
      const jobs = await getJobStatuses();
      res.json({ jobs });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/serper-enrichment/metrics", isAuthenticated, async (_req, res) => {
    try {
      const { getSerperEnrichmentMetrics } = await import("../services/sdr/serper-enrichment");
      const metrics = await getSerperEnrichmentMetrics();
      res.json(metrics);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/sdr/serper-enrichment/run", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    // SDR merchant records are staging projections, not canonical CRO-03
    // subjects.  Do not dispatch Serper or start a second scheduler here.
    res.status(409).json({
      code: "CRO03_CANONICAL_INTAKE_REQUIRED",
      message: "Admit the subject to a canonical contact, then submit a CRO-03 batch.",
    });
  });

  app.post("/api/sdr/serper-enrichment/merchant/:id", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    res.status(409).json({
      code: "CRO03_CANONICAL_INTAKE_REQUIRED",
      message: "Direct SDR provider enrichment is denied; use a canonical CRO-03 batch.",
    });
  });

  app.post("/api/sdr/sending-identities/bulk-action", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    try {
      const { action, identityIds } = req.body as { action: "pause" | "resume"; identityIds: number[] };
      if (!action || !["pause", "resume"].includes(action) || !identityIds || !Array.isArray(identityIds) || identityIds.length === 0) {
        return res.status(400).json({ message: "action must be 'pause' or 'resume', identityIds must be a non-empty array" });
      }

      const { sendingIdentities } = await import("@shared/schema");
      const { inArray } = await import("drizzle-orm");

      if (action === "pause") {
        await db.update(sendingIdentities).set({
          isActive: false,
          warmupStatus: "paused",
          updatedAt: new Date(),
        }).where(inArray(sendingIdentities.id, identityIds));
      } else if (action === "resume") {
        await db.update(sendingIdentities).set({
          isActive: true,
          warmupStatus: "warming",
          warmupStartedAt: new Date(),
          updatedAt: new Date(),
        }).where(inArray(sendingIdentities.id, identityIds));
      }

      res.json({ message: `${action}d ${identityIds.length} identities`, count: identityIds.length });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/discovery-controls", isAuthenticated, async (_req, res) => {
    try {
      const { getSearchMatrix, isNightlyDiscoveryRunning, isDiscoveryRunning } = await import("../services/sdr/lead-finder");
      const matrix = await getSearchMatrix();
      res.json({
        ...matrix,
        nightlySchedulerRunning: isNightlyDiscoveryRunning(),
        discoveryInProgress: isDiscoveryRunning(),
        nightlyDiscoveryEnabled: featureFlags.NIGHTLY_DISCOVERY_ENABLED,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.put("/api/sdr/discovery-controls", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin only" });
    try {
      const { updateSearchMatrix } = await import("../services/sdr/lead-finder");
      const updated = await updateSearchMatrix(req.body);
      res.json(updated);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/voice-ai/status", isAuthenticated, async (_req, res) => {
    try {
      const { getAllVoiceScripts } = await import("../services/sdr/voice-orchestrator");
      const scripts = getAllVoiceScripts();
      res.json({
        voiceAiEnabled: featureFlags.VOICE_AI_ENABLED,
        configuredScripts: scripts.map(s => ({
          verticalKey: s.verticalKey,
          verticalLabel: s.verticalLabel,
          hasOpening: !!s.opening,
          hasQualifyingQuestions: s.qualifyingQuestions.length > 0,
          hasObjectionHandlers: Object.keys(s.objectionHandlers).length > 0,
          hasComplianceDisclosure: !!s.complianceDisclosure,
        })),
        totalScripts: scripts.length,
        readyForActivation: scripts.length > 0 && scripts.every(s =>
          s.opening && s.qualifyingQuestions.length > 0 && s.complianceDisclosure
        ),
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/sms-metrics", isAuthenticated, async (_req, res) => {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const smsAttempts = await db.select({
        total: sql<number>`count(*)`,
        sent: sql<number>`count(case when ${sdrChannelAttempts.status} = 'sent' then 1 end)`,
        failed: sql<number>`count(case when ${sdrChannelAttempts.status} = 'failed' then 1 end)`,
        replied: sql<number>`count(case when ${sdrChannelAttempts.repliedAt} is not null then 1 end)`,
      }).from(sdrChannelAttempts).where(
        sql`${sdrChannelAttempts.channel} = 'sms' AND ${sdrChannelAttempts.sentAt} >= ${todayStart}`
      );

      const stats = smsAttempts[0] || { total: 0, sent: 0, failed: 0, replied: 0 };

      res.json({
        smsEnabled: featureFlags.SMS_ENABLED,
        today: {
          total: Number(stats.total),
          sent: Number(stats.sent),
          failed: Number(stats.failed),
          replied: Number(stats.replied),
          replyRate: Number(stats.sent) > 0 ? Math.round((Number(stats.replied) / Number(stats.sent)) * 100) : 0,
        },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/ghl-enrollment/status", isAuthenticated, async (_req, res) => {
    try {
      const status = getEnrollmentStatus();
      res.json(status);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/ghl-enrollment/mappings", isAuthenticated, async (_req, res) => {
    try {
      const mappings = getWorkflowMappings();
      const smartListTags = getInboxSmartListTags();
      res.json({ mappings, smartListTags });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/merchants/:id/contacts", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const merchantId = parseInt(req.params.id as string, 10);
      if (isNaN(merchantId)) {
        return res.status(400).json({ message: "Invalid merchant ID" });
      }
      const { sdrMerchants: merchants, sdrMerchantContacts: contactsTable } = await import("@shared/schema");
      const rows = await db
        .select({
          id: contactsTable.id,
          merchantId: contactsTable.merchantId,
          merchantSource: merchants.source,
          contactName: contactsTable.contactName,
          title: contactsTable.title,
          email: contactsTable.email,
          mobile: contactsTable.mobile,
          directPhone: contactsTable.directPhone,
          primaryContactFlag: contactsTable.primaryContactFlag,
          roleGuess: contactsTable.roleGuess,
          bestContactChannel: contactsTable.bestContactChannel,
          createdAt: contactsTable.createdAt,
        })
        .from(contactsTable)
        .leftJoin(merchants, eq(contactsTable.merchantId, merchants.id))
        .where(eq(contactsTable.merchantId, merchantId));
      res.json(rows);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/sdr/merchant-contacts", isDashboardUser, requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { sdrMerchants: merchants, sdrMerchantContacts: contactsTable } = await import("@shared/schema");
      const rows = await db
        .select({
          contactId: contactsTable.id,
          merchantId: contactsTable.merchantId,
          businessName: merchants.businessName,
          source: merchants.source,
          contactName: contactsTable.contactName,
          title: contactsTable.title,
          email: contactsTable.email,
          mobile: contactsTable.mobile,
          directPhone: contactsTable.directPhone,
          primaryContactFlag: contactsTable.primaryContactFlag,
          roleGuess: contactsTable.roleGuess,
          bestContactChannel: contactsTable.bestContactChannel,
          createdAt: contactsTable.createdAt,
        })
        .from(contactsTable)
        .innerJoin(merchants, eq(contactsTable.merchantId, merchants.id))
        .orderBy(desc(contactsTable.createdAt));
      res.json(rows);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  // ── Enrollment Subject Audit ──────────────────────────────────────────────

  app.get("/api/operator/enrollment-subject-audit", isAdmin, async (_req, res) => {
    try {
      const { sequenceEnrollments, followUpSequences, sequenceSteps } = await import("@shared/schema");
      const { and, gt, inArray } = await import("drizzle-orm");

      const activeEnrollments = await db
        .select({
          id: sequenceEnrollments.id,
          contactId: sequenceEnrollments.contactId,
          dealId: sequenceEnrollments.dealId,
          sequenceId: sequenceEnrollments.sequenceId,
          currentStep: sequenceEnrollments.currentStep,
          status: sequenceEnrollments.status,
          nextActionAt: sequenceEnrollments.nextActionAt,
          updatedAt: sequenceEnrollments.updatedAt,
          sequenceName: followUpSequences.name,
        })
        .from(sequenceEnrollments)
        .leftJoin(followUpSequences, eq(sequenceEnrollments.sequenceId, followUpSequences.id))
        .where(eq(sequenceEnrollments.status, "active"));

      const midSequence = activeEnrollments.filter(e => (e.currentStep ?? 0) > 0);

      const nextSteps = midSequence.length > 0
        ? await db
            .select({
              sequenceId: sequenceSteps.sequenceId,
              stepOrder: sequenceSteps.stepOrder,
              subject: sequenceSteps.subject,
              actionType: sequenceSteps.actionType,
            })
            .from(sequenceSteps)
            .where(
              inArray(
                sequenceSteps.sequenceId,
                [...new Set(midSequence.map(e => e.sequenceId).filter((id): id is number => id != null))]
              )
            )
        : [];

      const items = midSequence.map(e => {
        const nextStep = nextSteps.find(
          s => s.sequenceId === e.sequenceId && s.stepOrder === (e.currentStep ?? 0)
        );
        return {
          ...e,
          nextStepSubject: nextStep?.subject ?? null,
          nextStepType: nextStep?.actionType ?? null,
        };
      });

      res.json({
        totalActive: activeEnrollments.length,
        midSequenceCount: midSequence.length,
        items,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.post("/api/operator/enrollment-subject-audit/retrigger", isAdmin, async (_req, res) => {
    try {
      const { sequenceEnrollments } = await import("@shared/schema");
      const { and, gt } = await import("drizzle-orm");
      const { decideCr06SequenceLifecycle } = await import("../services/cr06-promotional-lifecycle-decision");

      const now = new Date();
      const candidates = await db
        .select({ id: sequenceEnrollments.id, sequenceId: sequenceEnrollments.sequenceId })
        .from(sequenceEnrollments)
        .where(
          and(
            eq(sequenceEnrollments.status, "active"),
            gt(sequenceEnrollments.currentStep, 0)
          )
        );
      const result: Array<{ id: number }> = [];
      for (const candidate of candidates) {
        if (!candidate.sequenceId) continue;
        const sequence = await storage.getFollowUpSequence(candidate.sequenceId);
        if (!sequence || !decideCr06SequenceLifecycle(sequence, "legacy_release").allowed) continue;
        const [released] = await db.update(sequenceEnrollments)
          .set({ nextActionAt: now, updatedAt: now })
          .where(eq(sequenceEnrollments.id, candidate.id))
          .returning({ id: sequenceEnrollments.id });
        if (released) result.push(released);
      }

      res.json({
        message: `Re-triggered ${result.length} mid-sequence enrollment(s). The next step for each will be sent on the next sequence-worker tick using updated subject lines.`,
        count: result.length,
        retriggeredIds: result.map(r => r.id),
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  // ── Sync Conflicts ────────────────────────────────────────────────────────

  app.get("/api/operator/sync-conflicts", isAdmin, async (req, res) => {
    try {
      const resolution = req.query.resolution as string | undefined;
      const conflicts = await storage.getSyncConflicts(resolution);
      res.json(conflicts);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.patch("/api/operator/sync-conflicts/:id/resolve", isAdmin, async (req, res) => {
    try {
      return res.status(503).json({
        code: "RECONCILIATION_COMMAND_REQUIRED",
        message: "Conflict resolution requires a durable reconciliation command.",
      });
      const id = parseInt(req.params.id as string, 10);
      const { resolution } = req.body as { resolution: "kept-internal" | "kept-ghl" | "manual" };
      if (!["kept-internal", "kept-ghl", "manual"].includes(resolution)) {
        return res.status(400).json({ message: "Invalid resolution value" });
      }

      const conflicts = await storage.getSyncConflicts();
      const conflict = conflicts.find(c => c.id === id) as any;
      if (!conflict) return res.status(404).json({ message: "Conflict not found" });

      const { upsertGhlContact } = await import("../services/ghl");

      // Resolve the route-level pause before either a local conflict write or
      // its paired GHL mutation. The adapter repeats the canonical epoch gate.
      if (resolution !== "manual") {
        const contact = await storage.getContact(conflict.contactId);
        if (contact?.ghlContactId && !(await requireGhlRouteMutationAllowed(res))) return;
      }

      if (resolution === "kept-ghl") {
        const ghlVal = conflict.ghlValue ?? "";
        const updatePayload: import("@shared/schema").UpdateContactRequest = {};
        switch (conflict.fieldName) {
          case "firstName":   updatePayload.firstName   = ghlVal; break;
          case "lastName":    updatePayload.lastName    = ghlVal; break;
          case "email":       updatePayload.email       = ghlVal; break;
          case "phone":       updatePayload.phone       = ghlVal; break;
          case "companyName": updatePayload.companyName = ghlVal; break;
          default:
            return res.status(400).json({ message: `Field '${conflict.fieldName}' cannot be resolved via this endpoint` });
        }
        await storage.updateContact(conflict.contactId, updatePayload);
        const contact = await storage.getContact(conflict.contactId);
        if (contact?.ghlContactId) {
          try {
            await upsertGhlContact(contact);
          } catch (ghlErr: any) {
            const msg = ghlErr instanceof Error ? ghlErr.message : String(ghlErr);
            console.error(`[Sync Conflict] GHL write failed for kept-ghl resolution #${id}: ${msg}`);
            return res.status(502).json({ message: safeMessage(msg, "DB updated but GHL sync failed") });
          }
        }
      } else if (resolution === "kept-internal") {
        const contact = await storage.getContact(conflict.contactId);
        if (contact?.ghlContactId) {
          try {
            await upsertGhlContact(contact);
          } catch (ghlErr: any) {
            const msg = ghlErr instanceof Error ? ghlErr.message : String(ghlErr);
            console.error(`[Sync Conflict] GHL write failed for kept-internal resolution #${id}: ${msg}`);
            return res.status(502).json({ message: safeMessage(msg, "GHL sync failed — conflict remains pending") });
          }
        }
      }
      // resolution === "manual" requires no system writes — admin has handled it externally

      const updated = await storage.resolveSyncConflict(id, resolution);
      res.json(updated);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  app.get("/api/operator/bounce-stats", isAdmin, async (req, res) => {
    try {
      const { db } = await import("../db");
      const { contacts, auditLogs } = await import("@shared/schema");
      const { gte, eq, like, and, count, inArray, sql } = await import("drizzle-orm");

      const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
      const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const FAILURE_EVENT_TYPES = [
        "comm_event_email_bounce",
        "comm_event_sms_undeliverable",
        "comm_event_call_no_answer",
        "comm_event_call_busy",
        "comm_event_voicemail_left",
      ];

      const [unreachableCount] = await db
        .select({ count: count() })
        .from(contacts)
        .where(eq(contacts.doNotAutoContact, true));

      const [emailBouncedTotal] = await db
        .select({ count: count() })
        .from(contacts)
        .where(eq(contacts.emailStatus, "bounced"));

      const [smsUndeliverableTotal] = await db
        .select({ count: count() })
        .from(contacts)
        .where(eq(contacts.smsStatus, "undeliverable"));

      const [emailBounceEvents7d] = await db
        .select({ count: count() })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "comm_event_email_bounce"), gte(auditLogs.createdAt, windowStart)));

      const [emailTotalEvents7d] = await db
        .select({ count: count() })
        .from(auditLogs)
        .where(and(like(auditLogs.action, "comm_event_email_%"), gte(auditLogs.createdAt, windowStart)));

      const [smsFailEvents7d] = await db
        .select({ count: count() })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "comm_event_sms_undeliverable"), gte(auditLogs.createdAt, windowStart)));

      const [smsTotalEvents7d] = await db
        .select({ count: count() })
        .from(auditLogs)
        .where(and(like(auditLogs.action, "comm_event_sms_%"), gte(auditLogs.createdAt, windowStart)));

      const [todayFailureEvents] = await db
        .select({ count: count() })
        .from(auditLogs)
        .where(and(inArray(auditLogs.action, FAILURE_EVENT_TYPES), gte(auditLogs.createdAt, todayStart)));

      const recentFailureRows = await db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(inArray(auditLogs.action, FAILURE_EVENT_TYPES), gte(auditLogs.createdAt, windowStart)))
        .orderBy(sql`${auditLogs.createdAt} DESC`)
        .limit(500);

      const failureReasonMap: Record<string, number> = {};
      for (const row of recentFailureRows) {
        const label = row.action.replace("comm_event_", "");
        failureReasonMap[label] = (failureReasonMap[label] ?? 0) + 1;
      }
      const topFailureReasons = Object.entries(failureReasonMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count }));

      const emailBounceRate = (emailTotalEvents7d.count || 0) > 0
        ? Number(((emailBounceEvents7d.count / emailTotalEvents7d.count) * 100).toFixed(1))
        : 0;
      const smsFailureRate = (smsTotalEvents7d.count || 0) > 0
        ? Number(((smsFailEvents7d.count / smsTotalEvents7d.count) * 100).toFixed(1))
        : 0;

      res.json({
        windowDays: days,
        emailBounceRate,
        smsFailureRate,
        emailBouncedTotal: emailBouncedTotal.count,
        smsUndeliverableTotal: smsUndeliverableTotal.count,
        unreachableContactCount: unreachableCount.count,
        todayFailureEvents: todayFailureEvents.count,
        topFailureReasons,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: safeMessage(errMsg) });
    }
  });

  // === SDR STATS (Wave 9) ===
  app.get("/api/operator/sdr-stats", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { sequenceEnrollments, followUpSequences, outboundMessages, analyticsEvents, sdrLeadState, contacts } = await import("@shared/schema");
      const { count, eq: eqOp, gte: gteOp } = await import("drizzle-orm");

      const warnings: string[] = [];

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      const twentyFourHrsAgo = new Date(Date.now() - 86400000);
      const now = new Date();

      // enrolledLeads: active enrollments
      const [enrolledResult] = await db.select({ cnt: count(sequenceEnrollments.id) })
        .from(sequenceEnrollments)
        .where(eqOp(sequenceEnrollments.status, "active"));
      const enrolledLeads = Number(enrolledResult.cnt);

      // activeSequencesByFamily: GROUP BY sequenceFamily where status = 'active'
      const familyRows = await db
        .select({ family: followUpSequences.sequenceFamily, cnt: count(followUpSequences.id) })
        .from(followUpSequences)
        .where(eqOp(followUpSequences.status, "active"))
        .groupBy(followUpSequences.sequenceFamily);
      const activeSequencesByFamily = familyRows.map(r => ({
        family: r.family || "unassigned",
        count: Number(r.cnt),
      }));

      // sequencesByStatus: GROUP BY status
      const statusRows = await db
        .select({ status: followUpSequences.status, cnt: count(followUpSequences.id) })
        .from(followUpSequences)
        .groupBy(followUpSequences.status);
      const sequencesByStatus = statusRows.map(r => ({
        status: r.status || "unknown",
        count: Number(r.cnt),
      }));

      // sentTodayByChannel: from outboundMessages where sentAt >= today start
      const channelRows = await db
        .select({ channel: outboundMessages.channel, cnt: count(outboundMessages.id) })
        .from(outboundMessages)
        .where(gteOp(outboundMessages.sentAt, todayStart))
        .groupBy(outboundMessages.channel);
      const sentTodayByChannel = channelRows.map(r => ({
        channel: r.channel || "unknown",
        count: Number(r.cnt),
      }));

      // senderUtilization: from storage.getSendingIdentities() — no PII, only senderName
      let senderUtilization: Array<{
        senderName: string; sentToday: number; dailyLimit: number;
        utilizationPct: number; healthScore: number | null; status: string;
      }> = [];
      try {
        const identities = await storage.getSendingIdentities();
        senderUtilization = (identities as any[]).map((i: any) => ({
          senderName: i.label || "Unnamed Sender",
          sentToday: i.sentToday || 0,
          dailyLimit: i.dailyLimit || 0,
          utilizationPct: i.dailyLimit > 0 ? Math.round((i.sentToday || 0) / i.dailyLimit * 100) : 0,
          healthScore: i.healthScore ?? null,
          status: i.status || "unknown",
        }));
      } catch {
        warnings.push("Sender utilization unavailable — storage.getSendingIdentities() failed");
      }

      // bounceRate: bounced / total sent last 30 days
      let bounceRate: number | null = null;
      try {
        const [bouncedResult] = await db.select({ cnt: count(outboundMessages.id) })
          .from(outboundMessages)
          .where(sql`${outboundMessages.status} = 'bounced' AND ${outboundMessages.sentAt} >= ${thirtyDaysAgo}`);
        const [totalSentResult] = await db.select({ cnt: count(outboundMessages.id) })
          .from(outboundMessages)
          .where(gteOp(outboundMessages.sentAt, thirtyDaysAgo));
        const bounced = Number(bouncedResult.cnt);
        const total = Number(totalSentResult.cnt);
        bounceRate = total > 0 ? Math.round((bounced / total) * 10000) / 100 : 0;
      } catch {
        warnings.push("Bounce rate unavailable — outboundMessages query failed");
      }

      // optOutRate: contacts with doNotContact updated in last 30 days / total
      let optOutRate: number | null = null;
      try {
        const [optOutResult] = await db.select({ cnt: count(contacts.id) })
          .from(contacts)
          .where(sql`${contacts.doNotContact} = true AND ${contacts.updatedAt} >= ${thirtyDaysAgo}`);
        const [totalContactedResult] = await db.select({ cnt: count(contacts.id) })
          .from(contacts);
        const optOuts = Number(optOutResult.cnt);
        const total = Number(totalContactedResult.cnt);
        optOutRate = total > 0 ? Math.round((optOuts / total) * 10000) / 100 : 0;
      } catch {
        warnings.push("Opt-out rate unavailable — contacts query failed");
      }

      // manualCallsDueToday: tasks due (NOT calls placed)
      let manualCallsDueToday = 0;
      try {
        const [dueResult] = await db.select({ cnt: count(sdrLeadState.id) })
          .from(sdrLeadState)
          .where(sql`${sdrLeadState.nextActionAt} IS NOT NULL AND ${sdrLeadState.nextActionAt} <= ${now} AND ${sdrLeadState.nextActionAt} >= ${todayStart}`);
        manualCallsDueToday = Number(dueResult.cnt);
        warnings.push("manualCallsDueToday represents tasks due — not calls placed or auto-dialed.");
      } catch {
        warnings.push("Manual calls due today unavailable — sdrLeadState query failed");
      }

      // blockedStepsLast24h: analyticsEvents with blockReason IS NOT NULL in last 24h
      let blockedStepsLast24h = 0;
      try {
        const [blockedResult] = await db.select({ cnt: count(analyticsEvents.id) })
          .from(analyticsEvents)
          .where(sql`${analyticsEvents.blockReason} IS NOT NULL AND ${analyticsEvents.occurredAt} >= ${twentyFourHrsAgo}`);
        blockedStepsLast24h = Number(blockedResult.cnt);
      } catch {
        warnings.push("Blocked steps count unavailable — analyticsEvents query failed");
      }

      // intentBreakdown: not available without metadata parsing
      const intentBreakdown: Array<{ intent: string; count: number }> = [];
      warnings.push("Intent breakdown unavailable — intent classifications are not indexed in analyticsEvents.");

      res.json({
        generatedAt: new Date().toISOString(),
        enrolledLeads,
        activeSequencesByFamily,
        sequencesByStatus,
        sentTodayByChannel,
        senderUtilization,
        bounceRate,
        optOutRate,
        manualCallsDueToday,
        blockedStepsLast24h,
        intentBreakdown,
        warnings,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── A-LEAD REVIEW QUEUE ────────────────────────────────────────────────────

  app.get("/api/sdr/a-lead-queue", isDashboardUser, requireRole("admin", "manager"), async (_req, res) => {
    try {
      const leads = await storage.getALeadQueue();
      res.json(leads);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sdr/a-lead-queue/:id/promote", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const actorId = String((req.user as any)?.id ?? "");
      const { reason } = req.body as { reason?: string };

      const lead = await storage.getSdrLeadState(id);
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (["PROMOTED_TO_CRM", "CONVERTED", "DEAD", "DISCARDED", "SUPPRESSED"].includes(lead.stage)) {
        return res.status(400).json({ message: `Lead is already in terminal stage: ${lead.stage}` });
      }

      const merchant = lead.merchantId ? await storage.getSdrMerchant(lead.merchantId) : undefined;

      // Email dedup: ownerEmail first, then lead.email, then merchant mainEmail
      const candidateEmails = [lead.ownerEmail, lead.email, merchant?.mainEmail].filter(Boolean) as string[];
      let existingContact: Awaited<ReturnType<typeof storage.getContactByEmail>> | undefined;
      for (const email of candidateEmails) {
        const found = await storage.getContactByEmail(email);
        if (found) { existingContact = found; break; }
      }

      // Phone dedup if no email match found
      if (!existingContact) {
        const candidatePhone = lead.phone ?? merchant?.mainPhone ?? null;
        if (candidatePhone) {
          const phoneMatch = await storage.getContactByPhone(candidatePhone);
          if (phoneMatch) {
            await storage.updateSdrLeadState(id, {
              contactId: phoneMatch.id,
              stage: "CONVERTED",
              decisionReason: "human_promote_linked_phone",
            });
            await storage.createSdrLeadEvent({
              merchantId: lead.merchantId,
              leadStateId: id,
              eventType: "human_promote",
              fromStage: lead.stage,
              toStage: "CONVERTED",
              actorType: "human",
              payloadJson: { actorUserId: actorId, dedupResult: "linked_existing", matchedBy: "phone", contactId: phoneMatch.id, reason: reason || null },
            });
            await storage.createAuditLog({
              action: "sdr_lead_promoted",
              entityType: "sdr_lead_state",
              entityId: id,
              actorType: "human",
              actorId,
              userId: actorId,
              details: { contactId: phoneMatch.id, dedupResult: "linked_existing", matchedBy: "phone", reason: reason || null },
            });
            return res.json({ ok: true, contactId: phoneMatch.id, dedupResult: "linked_existing", matchedBy: "phone", action: "linked" });
          }
        }
      }

      let contactId: number;
      const dedupResult: "linked_existing" | "created_new" = existingContact ? "linked_existing" : "created_new";

      if (existingContact) {
        contactId = existingContact.id;
        await storage.updateSdrLeadState(id, {
          contactId: existingContact.id,
          stage: "PROMOTED_TO_CRM",
          decisionReason: "human_promote_linked_existing",
        });
      } else {
        const ownerFirstName = lead.ownerName?.split(" ")[0] ?? merchant?.ownerFirstName ?? "";
        const ownerLastName = lead.ownerName?.split(" ").slice(1).join(" ") ?? merchant?.ownerLastName ?? "";
        const email = candidateEmails[0] ?? undefined;
        const phone = lead.phone ?? merchant?.mainPhone ?? undefined;

        const newContact = await createContactLocalFirst({
          firstName: ownerFirstName,
          lastName: ownerLastName,
          email: String(email ?? "") as unknown as string,
          phone: phone ?? null,
          companyName: lead.companyName ?? merchant?.businessName ?? null,
          vertical: merchant?.subvertical ?? lead.vertical ?? merchant?.vertical ?? null,
          source: merchant?.source ?? "sdr_queue",
          notes: [
            `Promoted from A-Lead Review Queue (lead state #${id})`,
            merchant?.source ? `Source: ${merchant.source}` : null,
            reason ? `Reason: ${reason}` : null,
          ].filter(Boolean).join("\n"),
        } as any, { actorType: "human", actorId });

        contactId = newContact.id;
        await storage.updateSdrLeadState(id, {
          contactId: newContact.id,
          stage: "PROMOTED_TO_CRM",
          decisionReason: "human_promote_created_new",
        });
      }

      await storage.createSdrLeadEvent({
        merchantId: lead.merchantId,
        leadStateId: id,
        eventType: "human_promote",
        fromStage: lead.stage,
        toStage: "PROMOTED_TO_CRM",
        actorType: "human",
        payloadJson: { actorUserId: actorId, dedupResult, contactId, reason: reason || null },
      });

      await storage.createAuditLog({
        action: "sdr_lead_promoted",
        entityType: "sdr_lead_state",
        entityId: id,
        actorType: "human",
        actorId,
        userId: actorId,
        details: { contactId, dedupResult, reason: reason || null },
      });

      res.json({ ok: true, contactId, dedupResult });
    } catch (err: any) {
      console.error("[A-Lead Promote] Error:", err);
      serverError(res, err);
    }
  });

  app.post("/api/sdr/a-lead-queue/:id/discard", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const actorId = String((req.user as any)?.id ?? "");
      const { reason } = req.body as { reason?: string };

      const lead = await storage.getSdrLeadState(id);
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (["DISCARDED", "SUPPRESSED", "PROMOTED_TO_CRM", "CONVERTED", "DEAD"].includes(lead.stage)) {
        return res.status(400).json({ message: `Lead is already in terminal stage: ${lead.stage}` });
      }

      await storage.updateSdrLeadState(id, {
        stage: "DISCARDED",
        decisionReason: "human_discarded",
      });

      await storage.createSdrLeadEvent({
        merchantId: lead.merchantId,
        leadStateId: id,
        eventType: "human_discard",
        fromStage: lead.stage,
        toStage: "DISCARDED",
        actorType: "human",
        payloadJson: { actorUserId: actorId, reason: reason || null },
      });

      await storage.createAuditLog({
        action: "sdr_lead_discarded",
        entityType: "sdr_lead_state",
        entityId: id,
        actorType: "human",
        actorId,
        userId: actorId,
        details: { reason: reason || null },
      });

      res.json({ ok: true });
    } catch (err: any) {
      console.error("[A-Lead Discard] Error:", err);
      serverError(res, err);
    }
  });

  app.post("/api/sdr/a-lead-queue/:id/suppress", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const actorId = String((req.user as any)?.id ?? "");
      const { reason } = req.body as { reason?: string };

      const lead = await storage.getSdrLeadState(id);
      if (!lead) return res.status(404).json({ message: "Lead not found" });
      if (["DISCARDED", "SUPPRESSED", "PROMOTED_TO_CRM", "CONVERTED", "DEAD"].includes(lead.stage)) {
        return res.status(400).json({ message: `Lead is already in terminal stage: ${lead.stage}` });
      }

      await storage.updateSdrLeadState(id, {
        stage: "SUPPRESSED",
        decisionReason: "human_suppressed — internal not-a-fit decision, NOT a merchant-requested DNC/opt-out",
      });

      await storage.createSdrLeadEvent({
        merchantId: lead.merchantId,
        leadStateId: id,
        eventType: "human_suppress",
        fromStage: lead.stage,
        toStage: "SUPPRESSED",
        actorType: "human",
        payloadJson: { actorUserId: actorId, reason: reason || null },
      });

      await storage.createAuditLog({
        action: "sdr_lead_suppressed",
        entityType: "sdr_lead_state",
        entityId: id,
        actorType: "human",
        actorId,
        userId: actorId,
        details: { reason: reason || null },
      });

      res.json({ ok: true });
    } catch (err: any) {
      console.error("[A-Lead Suppress] Error:", err);
      serverError(res, err);
    }
  });

  // ── Confirmation Metric ─────────────────────────────────────────────────────
  // GET /api/operator/confirmation-metric
  // Returns the "Confirmation send success rate" stat for today's ET window.
  //
  // Liberty is single-tenant; all dashboard users may access all contacts.
  // Metric cohort semantics: "terminal_event_in_window" (Option B).
  // Retry-after-midnight: a failure in today's cohort resolved by a retry tomorrow
  // is NOT reflected in today's archived metric once the day has ended.
  // Operators should check the Confirmation Failures panel for corrections.
  app.get("/api/operator/confirmation-metric", isDashboardUser, async (req, res) => {
    try {
      const { getConfirmationMetricForRange } = await import("../services/confirmation-status");
      const { APP_TIMEZONE, getTzDayBoundaries } = await import("../config");

      // Build today's ET window using deterministic Intl.DateTimeFormat.formatToParts helper.
      // getTzDayBoundaries does not depend on the server's local timezone or locale env.
      const { windowStart, windowEnd } = getTzDayBoundaries(APP_TIMEZONE);

      const metric = await getConfirmationMetricForRange(windowStart, windowEnd, APP_TIMEZONE);
      res.json(metric);
    } catch (err: any) {
      console.error("[confirmation-metric GET]", err.message);
      serverError(res, err);
    }
  });

  // ── Confirmation Failures ───────────────────────────────────────────────────
  // GET /api/operator/confirmation-failures
  // Returns unresolved inbound confirmation failures within the lookback window.
  // Raw details.reason is NEVER returned — passes through sanitizeFailureReason() first.
  //
  // Query params: ?lookbackDays=7&limit=50&offset=0
  // lookbackDays default: 7, max: 30
  // limit default: 50, max: 200
  //
  // Liberty is single-tenant; all dashboard users may access all contacts.
  // TODO: add tenant predicate if multi-tenant support is added.
  app.get("/api/operator/confirmation-failures", isDashboardUser, async (req, res) => {
    try {
      const { getUnresolvedConfirmationFailures } = await import("../services/confirmation-status");

      const rawLookback = req.query.lookbackDays !== undefined ? Number(req.query.lookbackDays) : 7;
      const rawLimit    = req.query.limit         !== undefined ? Number(req.query.limit)         : 50;
      const rawOffset   = req.query.offset        !== undefined ? Number(req.query.offset)        : 0;

      // Reject non-numeric or out-of-bounds inputs with 400 so callers get deterministic errors
      // instead of silent mis-behaviour (e.g. LIMIT -1 = no limit in Postgres).
      if (!Number.isFinite(rawLookback) || !Number.isFinite(rawLimit) || !Number.isFinite(rawOffset)) {
        return res.status(400).json({ message: "lookbackDays, limit, and offset must be numeric" });
      }
      if (rawLookback < 1 || rawLookback > 30) {
        return res.status(400).json({ message: "lookbackDays must be between 1 and 30" });
      }
      if (rawLimit < 1 || rawLimit > 200) {
        return res.status(400).json({ message: "limit must be between 1 and 200" });
      }
      if (rawOffset < 0) {
        return res.status(400).json({ message: "offset must be >= 0" });
      }

      const lookbackDays = Math.floor(rawLookback);
      const limit        = Math.floor(rawLimit);
      const offset       = Math.floor(rawOffset);

      const result = await getUnresolvedConfirmationFailures({ lookbackDays, limit, offset });
      res.json(result);
    } catch (err: any) {
      console.error("[confirmation-failures GET]", err.message);
      serverError(res, err);
    }
  });

}
