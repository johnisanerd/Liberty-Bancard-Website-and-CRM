import type { Express } from "express";
import { isAuthenticated, isAdmin, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { contacts } from "@shared/schema";
import { and } from "drizzle-orm";
import { checkGhlHealth, getCalendarBookingUrl, getGhlStatus, handleGhlWebhook, isGhlConfigured, sendGhlEmail, sendGhlSms, sendTemplatedMessage, validateGhlWebhookSignature, validateGhlWebhookSignatureEd25519 } from "../services/ghl";
import { routeContact } from "../services/smart-router";
import { fullSyncFromGhl, fullSyncToGhl, getGhlSyncStatus, getFullSyncDashboard, syncContactToGhl, syncDealToGhl, syncCompanyToGhl, syncTaskToGhl, syncTicketToGhl, syncNoteToGhl, syncTagsToGhl } from "../services/ghl-sync";
import { getWorkflowStatus, GHL_WORKFLOW_REGISTRY, getPlatformEmailConfig, getWorkflowRegistryWithStatus, setWorkflowEnvValue } from "../services/ghl-workflows";
import { buildSequenceList } from "../services/sequence-blueprints";
import { requireInternalWebhookSecret } from "../middleware/internal-webhook-auth";
import { publicLeadRateLimit, webhookRateLimit } from "../middleware/public-rate-limit";
import { parseId, parsePagination } from "./helpers";
import dns from "node:dns/promises";
import net from "node:net";
import { serverError, safeMessage } from "../utils/server-error";
import { authorizeContactAccess } from "../services/crm-object-access";

export function registerIntegrationsRoutes(app: Express) {
  const getAuthorizedRecipient = async (req: any, res: any, rawContactId: unknown, respond = true) => {
    const contactId = Number(rawContactId);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      if (respond) res.status(400).json({ message: "A valid contactId is required" });
      return null;
    }
    const contact = await authorizeContactAccess(req, res, contactId);
    if (!contact) return null;
    return { contactId, contact };
  };

  // === GHL INTEGRATION ===
  app.get("/api/ghl/status", isAuthenticated, async (req, res) => {
    res.json(getGhlStatus());
  });

  app.get("/api/ghl/health-check", isAuthenticated, async (req, res) => {
    try {
      const result = await checkGhlHealth();
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/send-email", isDashboardUser, async (req, res) => {
    try {
      const { contactId, dealId, subject, body } = req.body;
      if (!contactId || !subject || !body) return res.status(400).json({ message: "contactId, subject, and body required" });
    const recipient = await getAuthorizedRecipient(req, res, contactId);
      if (!recipient) return;
      const { channelOrchestrator } = await import("../services/transports/index");
      const result = await channelOrchestrator.sendEmail({ contactId: recipient.contactId, dealId, subject, body });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/send-sms", isDashboardUser, async (req, res) => {
    try {
      const { contactId, dealId, body } = req.body;
      if (!contactId || !body) return res.status(400).json({ message: "contactId and body required" });
      const recipient = await getAuthorizedRecipient(req, res, contactId);
      if (!recipient) return;
      const { channelOrchestrator } = await import("../services/transports/index");
      const result = await channelOrchestrator.sendSms({ contactId: recipient.contactId, dealId, body });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/send-template", isDashboardUser, async (req, res) => {
    try {
      const { templateId, contactId, dealId, extraData } = req.body;
      if (!templateId || !contactId) return res.status(400).json({ message: "templateId and contactId required" });
      const recipient = await getAuthorizedRecipient(req, res, contactId);
      if (!recipient) return;
      const template = await storage.getMessageTemplate(Number(templateId));
      if (!template || !template.isActive || !["email", "sms"].includes(template.channel)) {
        return res.status(400).json({ message: "Active email or SMS template required" });
      }
      const { evaluateContactability } = await import("../services/contactability");
      const decision = await evaluateContactability({
        contactId: recipient.contactId,
        channel: template.channel as "email" | "sms",
        campaignType: "operator_template_send",
        mode: "enforcement",
      });
      if (!decision.allowed) {
        return res.status(403).json({ message: decision.reason, code: "CONTACTABILITY_BLOCKED" });
      }
      const result = await sendTemplatedMessage({ templateId, contactId: recipient.contactId, dealId, extraData });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/sync-contact", requireRole("admin"), async (req, res) => {
    try {
      const contactId = Number(req.body?.contactId);
      const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
      if (!Number.isSafeInteger(contactId) || contactId <= 0) {
        return res.status(400).json({ code: "INVALID_CONTACT_ID", message: "A valid contactId is required." });
      }
      if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        return res.status(400).json({ code: "INVALID_IDEMPOTENCY_KEY", message: "idempotencyKey must contain 8–200 characters." });
      }
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ code: "CONTACT_NOT_FOUND", message: "Contact not found." });
      const { createGhlPermissionProjection } = await import("../services/ghl-specialized-commands");
      const run = await createGhlPermissionProjection(
        String((req.user as any)?.id ?? "admin"),
        idempotencyKey,
        contact.id,
      );
      res.status(202).json({
        accepted: true,
        runId: run.runId,
        kind: run.kind,
        state: run.state,
        contactId: contact.id,
        ghlContactId: contact.ghlContactId ?? null,
        pollingUrl: `/api/ghl/sync-permissions/${run.runId}`,
        stepUrl: `/api/ghl/sync-permissions/${run.runId}/step`,
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
        fieldProjection: run.fieldProjection,
      });
    } catch (err: any) {
      if (err?.message === "GHL_SPECIALIZED_COMMAND_ACTIVE") {
        return res.status(409).json({ code: err.message, message: "Another GHL specialized command currently owns the active command slot." });
      }
      serverError(res, err);
    }
  });

  app.post("/api/ghl/sync-permissions/:runId/step", requireRole("admin"), async (req, res) => {
    try {
      const { getGhlSpecializedRun, stepGhlSpecializedRun } = await import("../services/ghl-specialized-commands");
      const runId = String(req.params.runId || "");
      const existing = await getGhlSpecializedRun(runId);
      if (!existing || existing.kind !== "permission_projection") {
        return res.status(404).json({ code: "GHL_PERMISSION_RUN_NOT_FOUND", message: "Permission projection command was not found." });
      }
      const result = await stepGhlSpecializedRun(runId);
      const run = result.run;
      res.status(result.leaseBusy ? 409 : 200).json({
        accepted: !result.leaseBusy,
        runId: run.runId,
        kind: run.kind,
        state: run.state,
        contactId: run.contactId,
        ghlContactId: run.ghlContactId ?? null,
        pollingUrl: `/api/ghl/sync-permissions/${run.runId}`,
        stepUrl: `/api/ghl/sync-permissions/${run.runId}/step`,
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
        fieldProjection: run.fieldProjection,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/ghl/sync-permissions/:runId", isAuthenticated, async (req, res) => {
    try {
      const { getGhlSpecializedRun } = await import("../services/ghl-specialized-commands");
      const run = await getGhlSpecializedRun(String(req.params.runId || ""));
      if (!run || run.kind !== "permission_projection" || !run.contactId) {
        return res.status(404).json({ code: "GHL_PERMISSION_RUN_NOT_FOUND", message: "Permission projection command was not found." });
      }
      if (!await authorizeContactAccess(req, res, run.contactId)) return;
      res.json({
        accepted: true,
        runId: run.runId,
        kind: run.kind,
        state: run.state,
        contactId: run.contactId,
        ghlContactId: run.ghlContactId ?? null,
        pollingUrl: `/api/ghl/sync-permissions/${run.runId}`,
        stepUrl: `/api/ghl/sync-permissions/${run.runId}/step`,
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
        fieldProjection: run.fieldProjection,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/ghl/calendar-url", isAuthenticated, (req, res) => {
    const url = getCalendarBookingUrl({
      contactEmail: req.query.email as string,
      contactName: req.query.name as string,
      source: req.query.source as string,
    });
    res.json({ url });
  });

  app.get("/api/ghl/activity", isAuthenticated, async (req, res) => {
    const contactId = req.query.contactId ? (parseId(req.query.contactId as string) ?? undefined) : undefined;
    const logs = await storage.getGhlActivityLogs(contactId);
    res.json(logs);
  });

  app.post("/api/webhooks/ghl", webhookRateLimit, async (req, res) => {
    try {
      const rawBody = req.rawBody instanceof Buffer ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

      // Current GHL standard: Ed25519 public-key signature in X-GHL-Signature
      const ed25519Sig = req.headers["x-ghl-signature"] as string | undefined;
      // Legacy HMAC-SHA256 fallback: X-WH-Signature or X-Hub-Signature-256
      const legacySig = (req.headers["x-wh-signature"] || req.headers["x-hub-signature-256"] || "") as string;

      const isProd = process.env.NODE_ENV === "production";
      // Accept both env var names — GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY is the
      // current standard (matches SDR path + GHL Marketplace SDK convention);
      // GHL_WEBHOOK_PUBLIC_KEY is the legacy alias kept for existing deployments.
      const pubKeyConfigured = !!(
        process.env.GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY ||
        process.env.GHL_WEBHOOK_PUBLIC_KEY
      );

      if (ed25519Sig) {
        // Prefer Ed25519 when X-GHL-Signature header is present
        if (!pubKeyConfigured && isProd) {
          console.error("[GHL Webhook] X-GHL-Signature received but GHL_WEBHOOK_PUBLIC_KEY not set — rejecting in production");
          return res.status(503).json({ received: false, error: "Webhook Ed25519 public key not configured" });
        }
        if (!validateGhlWebhookSignatureEd25519(rawBody, ed25519Sig)) {
          console.error("[GHL Webhook] Ed25519 signature verification failed");
          return res.status(401).json({ message: "Invalid Ed25519 webhook signature" });
        }
      } else if (legacySig) {
        // Legacy HMAC-SHA256 fallback (X-WH-Signature / X-Hub-Signature-256)
        if (!validateGhlWebhookSignature(rawBody, legacySig)) {
          console.error("[GHL Webhook] Legacy HMAC-SHA256 signature verification failed");
          return res.status(401).json({ message: "Invalid legacy webhook signature" });
        }
      } else {
        // No recognisable signature header
        if (isProd) {
          console.error("[GHL Webhook] No X-GHL-Signature or X-WH-Signature header — rejecting in production");
          return res.status(401).json({ message: "Missing webhook signature" });
        }
        console.warn("[GHL Webhook] No signature header — allowing in non-production environment");
      }

      await handleGhlWebhook(req.body);
      res.json({ success: true });
    } catch (err: any) {
      console.error("GHL webhook error:", err.message);
      serverError(res, err);
    }
  });


  // === GHL 2-WAY SYNC ===
  app.get("/api/ghl/sync-status", isAuthenticated, async (req, res) => {
    const [status, hotLeadSync, hotLeadEnrollment] = await Promise.all([
      getGhlSyncStatus(),
      storage.getSystemSetting("ghl_hot_lead_sync"),
      storage.getSystemSetting("hot_lead_enrollment"),
    ]);
    res.json({ ...status, hotLeadSync, hotLeadEnrollment });
  });

  app.post("/api/ghl/sync-all-to-ghl", requireRole("admin"), async (_req, res) => {
    // A former detached full-sync lane. Broad reconciliation must be submitted
    // as a bounded durable command; this legacy endpoint never claims success
    // or performs provider I/O.
    res.status(503).json({
      code: "RECONCILIATION_COMMAND_REQUIRED",
      message: "Bulk GHL reconciliation requires a bounded durable command and is unavailable from this legacy endpoint.",
    });
  });

  app.post("/api/ghl/sync-all-from-ghl", requireRole("admin"), async (_req, res) => {
    res.status(503).json({
      code: "RECONCILIATION_COMMAND_REQUIRED",
      message: "Bulk GHL reconciliation requires a bounded durable command and is unavailable from this legacy endpoint.",
    });
  });

  app.get("/api/ghl/sync-status/contact/:id", isAuthenticated, async (req, res) => {
    try {
      const contactId = parseId(req.params.id);
      if (contactId === null) return res.status(404).json({ message: "Not found" });
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Not found" });
      if (!await authorizeContactAccess(req, res, contactId)) return;
      const logs = await storage.getGhlActivityLogs(contactId);
      const lastOutboundSync = logs.find(l => l.direction === "outbound" && l.channel === "sync");
      const { getContactPermissionProjectionStatus } = await import("../services/ghl-specialized-commands");
      const permissionProjection = await getContactPermissionProjectionStatus(contactId);
      const lastSyncedAt = lastOutboundSync?.createdAt || null;
      const isSynced = !!contact.ghlContactId && !!lastSyncedAt;
      const syncAge = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() : null;
      const isRecent = syncAge !== null && syncAge < 24 * 60 * 60 * 1000;
      res.json({
        ghlContactId: contact.ghlContactId || null,
        isSynced,
        isRecent,
        lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : null,
        syncAgeMs: syncAge,
        permissionProjection: permissionProjection ? {
          runId: permissionProjection.runId,
          state: permissionProjection.state,
          contactId: permissionProjection.contactId,
          ghlContactId: permissionProjection.ghlContactId ?? null,
          fieldProjection: permissionProjection.fieldProjection,
          processed: permissionProjection.processed,
          matched: permissionProjection.matched,
          errors: permissionProjection.errors,
          heartbeatAt: permissionProjection.heartbeatAt,
          lastError: permissionProjection.lastError,
          complete: permissionProjection.state === "complete",
        } : null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/sync-contact/:id", isAuthenticated, async (req, res) => {
    // Direct route-time GHL I/O is retired. Use the admin-only projection
    // reconciliation endpoint, whose worker owns circuit and pause fencing.
    res.status(503).json({
      code: "RECONCILIATION_COMMAND_REQUIRED",
      message: "Direct GHL synchronization is unavailable; submit an admin reconciliation command.",
    });
  });

  app.post("/api/ghl/sync-deal/:id", isAuthenticated, async (req, res) => {
    return res.status(503).json({ code: "RECONCILIATION_COMMAND_REQUIRED", message: "Direct GHL reconciliation requires a durable admin command." });
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    const syncDealId = parseId(req.params.id);
    if (syncDealId === null) return res.status(404).json({ message: "Not found" });
    const result = await syncDealToGhl(syncDealId!);
    res.json(result);
  });

  app.post("/api/ghl/sync-company/:id", isAuthenticated, async (req, res) => {
    return res.status(503).json({ code: "RECONCILIATION_COMMAND_REQUIRED", message: "Direct GHL reconciliation requires a durable admin command." });
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Invalid company ID" });
    try {
      const result = await syncCompanyToGhl(id!);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/sync-task/:id", isAuthenticated, async (req, res) => {
    return res.status(503).json({ code: "RECONCILIATION_COMMAND_REQUIRED", message: "Direct GHL reconciliation requires a durable admin command." });
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Invalid task ID" });
    try {
      const result = await syncTaskToGhl(id!);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/sync-ticket/:id", isAuthenticated, async (req, res) => {
    return res.status(503).json({ code: "RECONCILIATION_COMMAND_REQUIRED", message: "Direct GHL reconciliation requires a durable admin command." });
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Invalid ticket ID" });
    try {
      const result = await syncTicketToGhl(id!);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/sync-note/:id", isAuthenticated, async (req, res) => {
    return res.status(503).json({ code: "RECONCILIATION_COMMAND_REQUIRED", message: "Direct GHL reconciliation requires a durable admin command." });
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Invalid note ID" });
    try {
      const result = await syncNoteToGhl(id!);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/sync-tags/:contactId", isAuthenticated, async (req, res) => {
    return res.status(503).json({ code: "RECONCILIATION_COMMAND_REQUIRED", message: "Direct GHL reconciliation requires a durable admin command." });
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    const id = parseId(req.params.contactId);
    if (id === null) return res.status(400).json({ message: "Invalid contact ID" });
    try {
      const result = await syncTagsToGhl(id!);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/ghl/sync-dashboard", isAuthenticated, async (req, res) => {
    try {
      const dashboard = await getFullSyncDashboard();
      res.json(dashboard);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/sync-hot-leads", isAuthenticated, async (req, res) => {
    res.status(503).json({
      code: "RECONCILIATION_COMMAND_REQUIRED",
      message: "Hot-lead GHL reconciliation requires a bounded durable command.",
    });
  });

  app.post("/api/ghl/test-connection", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    try {
      const health = await checkGhlHealth();
      res.json(health);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/ghl/test-send-email", isDashboardUser, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    try {
      const { contactId, subject, body } = req.body;
      if (!contactId) return res.status(400).json({ message: "contactId required" });
      const recipient = await getAuthorizedRecipient(req, res, contactId);
      if (!recipient) return;
      const { channelOrchestrator } = await import("../services/transports/index");
      const result = await channelOrchestrator.sendEmail({
        contactId: recipient.contactId,
        subject: subject || "Test Email from Liberty Bancard CRM",
        body: body || "<p>This is a test email sent through the GHL integration to verify connectivity.</p>",
      });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/outreach/enroll-hot-leads", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    const maxLeads = Math.min(Math.max(1, Number(req.body.limit) || 100), 500);
    res.json({ message: `Enrolling up to ${maxLeads} hot leads into sequences...`, started: true });

    (async () => {
      try {
        const { routeContact } = await import("../services/smart-router");
        const { data: deals } = await storage.getDeals({ limit: 500 });
        const hotDeals = deals.filter(d => d.stage === "New Lead" && d.contactId);
        const contactIds = [...new Set(hotDeals.map(d => d.contactId!))].slice(0, maxLeads);

        let enrolled = 0;
        let skipped = 0;
        let blocked = 0;
        for (const contactId of contactIds) {
          try {
            const result = await routeContact(contactId);
            if (result.complianceBlocked) { blocked++; continue; }
            if (result.sequenceIds.length > 0) enrolled++;
            else skipped++;
          } catch { skipped++; }
        }

        await storage.setSystemSetting("hot_lead_enrollment", {
          timestamp: new Date().toISOString(),
          enrolled,
          skipped,
          blocked,
          total: contactIds.length,
        });
        console.log(`[Hot Lead Enrollment] Complete: ${enrolled} enrolled, ${skipped} skipped, ${blocked} compliance-blocked`);
      } catch (err) {
        console.error("[Hot Lead Enrollment] Error:", err);
      }
    })();
  });


  // === BULK MESSAGING ===
  app.post("/api/bulk-message", isDashboardUser, async (req, res) => {
    try {
      const { contactIds, channel, subject, message: msgBody, templateId } = req.body;

      if (!contactIds?.length || !channel || !msgBody) {
        return res.status(400).json({ message: "contactIds, channel, and message are required" });
      }

      if (!["email", "sms"].includes(channel)) {
        return res.status(400).json({ message: "Channel must be email or sms" });
      }

      const results: { contactId: number; status: string; error?: string }[] = [];

      for (const contactId of contactIds) {
        try {
          const recipient = await getAuthorizedRecipient(req, res, contactId, false);
          if (!recipient) {
            results.push({ contactId, status: "denied", error: "Recipient is unavailable or unauthorized" });
            continue;
          }
          const { contact, contactId: authorizedContactId } = recipient;

          const personalizedMsg = msgBody
            .replace(/\{\{firstName\}\}/g, contact.firstName || "")
            .replace(/\{\{lastName\}\}/g, contact.lastName || "")
            .replace(/\{\{companyName\}\}/g, contact.companyName || "")
            .replace(/\{\{email\}\}/g, contact.email || "");

          let auditOutcome: "sent" | "failed" | "skipped" | "not_configured";
          let auditProvider: string | undefined;
          let auditError: string | undefined;

          if (channel === "email") {
            if (isGhlConfigured() && contact.email) {
              const { channelOrchestrator } = await import("../services/transports/index");
              const result = await channelOrchestrator.sendEmail({
                contactId: authorizedContactId,
                subject: subject || "Message from Liberty Bancard",
                body: personalizedMsg,
              });
              auditOutcome = result.success ? "sent" : result.skipped ? "skipped" : "failed";
              auditProvider = result.provider;
              auditError = result.skipReason || result.error;
              results.push(result.success
                ? { contactId, status: "sent" }
                : { contactId, status: "skipped", error: result.skipReason || result.error || "Contactability blocked" });
            } else {
              auditOutcome = "not_configured";
              auditError = "GHL not configured or contact has no email";
              results.push({ contactId, status: "not_configured", error: "GHL not configured or contact has no email" });
            }
          } else {
            if (isGhlConfigured() && contact.phone) {
              const { channelOrchestrator } = await import("../services/transports/index");
              const result = await channelOrchestrator.sendSms({ contactId: authorizedContactId, body: personalizedMsg });
              auditOutcome = result.success ? "sent" : result.skipped ? "skipped" : "failed";
              auditProvider = result.provider;
              auditError = result.skipReason || result.error;
              results.push(result.success
                ? { contactId, status: "sent" }
                : { contactId, status: "skipped", error: result.skipReason || result.error || "Contactability blocked" });
            } else {
              auditOutcome = "not_configured";
              auditError = "GHL not configured or contact has no phone";
              results.push({ contactId, status: "not_configured", error: "GHL not configured or contact has no phone" });
            }
          }

          await storage.createAuditLog({
            action: `bulk_${channel}_${auditOutcome}`,
            entityType: "contact",
            entityId: contactId,
            details: {
              channel,
              subject,
              outcome: auditOutcome,
              provider: auditProvider ?? null,
              error: auditError ?? null,
            },
          }).catch((auditErr) => {
            console.error(`[BulkMessage] Failed to audit ${channel} ${auditOutcome} for contact ${contactId}:`, auditErr);
          });
        } catch (err: any) {
          const error = safeMessage(err.message, "Send failed");
          results.push({ contactId, status: "error", error });
          await storage.createAuditLog({
            action: `bulk_${channel}_failed`,
            entityType: "contact",
            entityId: contactId,
            details: { channel, subject, outcome: "failed", error },
          }).catch((auditErr) => {
            console.error(`[BulkMessage] Failed to audit ${channel} failure for contact ${contactId}:`, auditErr);
          });
        }
      }

      const sent = results.filter(r => r.status === "sent").length;
      const skipped = results.filter(r => r.status === "skipped").length;
      const errors = results.filter(r => r.status === "error").length;

      res.json({ sent, skipped, errors, total: contactIds.length, results });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === BLAZE.AI INTEGRATION ===
  const BLAZE_SETTINGS_KEY = "blaze_integration";
  const defaultBlazeSettings = { enabled: false, webhookUrl: "", zapierConnected: false, lastSyncAt: null, contentTypes: ["email", "social", "blog", "newsletter"], workspaceId: "" };

  app.get("/api/integrations/blaze", isAuthenticated, async (req, res) => {
    const saved = await storage.getSystemSetting(BLAZE_SETTINGS_KEY);
    res.json(saved || defaultBlazeSettings);
  });

  // SSRF guard: blocks requests to loopback, private (RFC1918), link-local
  // (incl. cloud metadata 169.254.169.254), unique-local, and multicast
  // ranges. Resolves the hostname first so DNS rebinding can't bypass the
  // check (the resolved IP — not the original hostname — is what gets used
  // for the outbound request).
  function isBlockedIp(ip: string): boolean {
    const type = net.isIP(ip);
    if (type === 4) {
      const parts = ip.split(".").map(Number);
      const [a, b] = parts;
      if (a === 127) return true; // loopback
      if (a === 10) return true; // RFC1918
      if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
      if (a === 192 && b === 168) return true; // RFC1918
      if (a === 169 && b === 254) return true; // link-local / cloud metadata
      if (a === 0) return true; // "this" network
      if (a >= 224) return true; // multicast/reserved
      return false;
    }
    if (type === 6) {
      const lower = ip.toLowerCase();
      if (lower === "::1") return true; // loopback
      if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
      if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
      if (lower.startsWith("::ffff:")) {
        const v4 = lower.split(":").pop() || "";
        if (net.isIP(v4) === 4) return isBlockedIp(v4);
      }
      return false;
    }
    return true; // unknown/unparseable — fail closed
  }

  async function resolveSafeHttpUrl(rawUrl: string): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, reason: "invalid_url" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "invalid_protocol" };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return { ok: false, reason: "blocked_host" };
    }
    const literalIpType = net.isIP(hostname);
    if (literalIpType) {
      if (isBlockedIp(hostname)) return { ok: false, reason: "blocked_host" };
      return { ok: true, url: parsed };
    }
    try {
      const records = await dns.lookup(hostname, { all: true, verbatim: false });
      if (!records.length) return { ok: false, reason: "dns_failed" };
      if (records.some((r) => isBlockedIp(r.address))) return { ok: false, reason: "blocked_host" };
      return { ok: true, url: parsed };
    } catch {
      return { ok: false, reason: "dns_failed" };
    }
  }

  app.post("/api/integrations/blaze", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    const { webhookUrl, workspaceId } = req.body;
    const current = (await storage.getSystemSetting(BLAZE_SETTINGS_KEY)) || { ...defaultBlazeSettings };
    const updated = {
      ...current,
      webhookUrl: webhookUrl || current.webhookUrl,
      workspaceId: workspaceId || current.workspaceId,
      enabled: !!(webhookUrl || workspaceId || current.webhookUrl || current.workspaceId),
    };
    await storage.setSystemSetting(BLAZE_SETTINGS_KEY, updated);
    await storage.createAuditLog({
      action: "blaze_settings_updated",
      entityType: "integration",
      details: { webhookUrl: !!webhookUrl, workspaceId: !!workspaceId },
    });
    res.json({ success: true, settings: updated });
  });

  app.post("/api/integrations/blaze/test", isAuthenticated, requireRole("admin", "manager"), async (req, res) => {
    const saved = (await storage.getSystemSetting(BLAZE_SETTINGS_KEY)) || defaultBlazeSettings;

    // No config at all — nothing to test.
    if (!saved.webhookUrl && !saved.workspaceId) {
      return res.json({
        status: "not_configured",
        success: false,
        message: "No Blaze.ai webhook URL or workspace ID configured. Use Zapier integration as the recommended approach.",
      });
    }

    // Only a workspace ID is set. Blaze.ai does not expose a public, non-mutating
    // endpoint we can use to verify a workspace ID, so we do not fake a result.
    if (!saved.webhookUrl) {
      return res.json({
        status: "configured_unverified",
        success: false,
        message: "Blaze is configured, but no safe live test endpoint is available. No test event was sent.",
      });
    }

    // Resolve + validate the URL before ever making an outbound request.
    // Blocks SSRF against loopback/private/link-local/cloud-metadata hosts,
    // and re-validates the resolved IP (not just the hostname) to close the
    // DNS-rebinding gap.
    const safe = await resolveSafeHttpUrl(saved.webhookUrl);
    if (!safe.ok) {
      if (safe.reason === "dns_failed") {
        return res.json({
          status: "webhook_unreachable",
          success: false,
          message: "Could not resolve the Blaze webhook host.",
        });
      }
      return res.json({
        status: "request_failed",
        success: false,
        message: "The configured Blaze webhook URL is not a valid, externally reachable http(s) URL.",
      });
    }
    const parsedUrl = safe.url;

    // A webhook URL is "workspace-specific" (and a 404 provably means
    // "workspace not found", rather than just a wrong/generic path) only
    // when the configured workspace ID actually appears as a distinct
    // segment of the URL's path or query string.
    const workspaceId = (saved.workspaceId || "").trim();
    const isWorkspaceScopedUrl =
      workspaceId.length > 0 &&
      (parsedUrl.pathname.split("/").includes(workspaceId) ||
        Array.from(parsedUrl.searchParams.values()).includes(workspaceId));

    // Non-mutating reachability check: a HEAD request confirms the endpoint is
    // reachable and reports auth status without sending any lead/event payload.
    const controller = new AbortController();
    const timeoutMs = 5000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(parsedUrl.toString(), {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        return res.json({
          status: "auth_failed",
          success: false,
          message: "Blaze rejected the request as unauthorized. Check the configured credentials.",
        });
      }
      if (response.status === 404) {
        if (isWorkspaceScopedUrl) {
          return res.json({
            status: "workspace_not_found",
            success: false,
            message: "Blaze reported that the configured workspace ID could not be found.",
          });
        }
        return res.json({
          status: "request_failed",
          success: false,
          message: "The Blaze webhook URL returned 404 Not Found.",
        });
      }
      if (response.status >= 200 && response.status < 300) {
        return res.json({
          status: "connected",
          success: true,
          message: "The Blaze webhook endpoint responded successfully.",
        });
      }
      if (response.status === 405 || (response.status >= 300 && response.status < 400)) {
        // Something is listening (e.g. a POST-only receiver, or a redirect),
        // but that alone isn't a confirmed provider response — do not send a
        // test payload to find out, just report it as unverified.
        return res.json({
          status: "configured_unverified",
          success: false,
          message: "Blaze is configured and the endpoint is reachable, but it does not offer a safe way to confirm the connection without sending a live event. No test event was sent.",
        });
      }
      return res.json({
        status: "request_failed",
        success: false,
        message: `The Blaze webhook responded with an unexpected status (${response.status}).`,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name === "AbortError") {
        return res.json({
          status: "webhook_unreachable",
          success: false,
          message: `Timed out after ${timeoutMs / 1000}s trying to reach the Blaze webhook URL.`,
        });
      }
      return res.json({
        status: "webhook_unreachable",
        success: false,
        message: "Could not reach the Blaze webhook URL.",
      });
    }
  });

  app.post("/api/webhooks/blaze", requireInternalWebhookSecret, async (req, res) => {
    try {
      const { type, content, metadata } = req.body;
      console.log(`[Blaze Webhook] Received: ${type}`, metadata);

      await storage.createAuditLog({
        action: "blaze_webhook_received",
        entityType: "integration",
        details: { type, metadata },
      });

      const current = (await storage.getSystemSetting(BLAZE_SETTINGS_KEY)) || { ...defaultBlazeSettings };
      current.lastSyncAt = new Date().toISOString();
      await storage.setSystemSetting(BLAZE_SETTINGS_KEY, current);

      if (type === "content_published" && content) {
        await storage.createNotification({
          channel: "internal",
          title: "Blaze.ai Content Published",
          message: `New ${metadata?.contentType || "content"}: ${content?.title || "Untitled"}`,
          type: "info",
          metadata: { source: "blaze", contentType: metadata?.contentType },
        });
      }

      res.json({ success: true, received: true });
    } catch (err: any) {
      console.error("Blaze webhook error:", err.message);
      serverError(res, err);
    }
  });

  app.get("/api/ghl/workflows", isAuthenticated, async (req, res) => {
    try {
      const status = getWorkflowStatus();
      res.json({
        ...status,
        registry: GHL_WORKFLOW_REGISTRY.map(w => ({
          id: w.id,
          name: w.name,
          category: w.category,
          envKey: w.envKey,
          configured: !!process.env[w.envKey],
          description: w.description,
        })),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/integrations/ghl-workflow-registry", isDashboardUser, requireRole("admin", "manager"), async (_req, res) => {
    try {
      const registry = await getWorkflowRegistryWithStatus();
      res.json(registry.map(w => ({
        id: w.id,
        name: w.name,
        category: w.category,
        envKey: w.envKey,
        value: w.value,
        isSet: w.isSet,
        description: w.description,
      })));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Wave 7: GHL permission-check endpoint ────────────────────────────────
  // Called by GHL workflows via Custom Webhook action before any outbound send.
  // HTTP response codes:
  //   401 — auth/config failures (missing secret, wrong token)
  //   400 — malformed request (missing identifiers, invalid channel)
  //   200 — all business-rule outcomes (allowed or denied) + internal errors
  //         (200 for business denials so GHL's conditional branch sees the body
  //          rather than treating it as a transient error and retrying)
  const VALID_CHANNELS = new Set(["email", "sms", "voice_ai", "ringless_vm", "manual_call"]);

  app.post("/api/ghl/permission-check", publicLeadRateLimit, async (req, res) => {
    const crypto = await import("crypto");

    // ── 1. Secret configuration check (fail closed with 401) ───────────────
    const secret = process.env.GHL_WEBHOOK_SECRET;
    if (!secret) {
      storage.createAuditLog({
        action: "ghl_permission_check_misconfigured",
        entityType: "system",
        details: { reason: "GHL_WEBHOOK_SECRET not set", source: "ghl_permission_check_api" },
      }).catch(() => {});
      return res.status(401).json({
        allowed: false,
        reason: "configuration_missing",
        message: "GHL_WEBHOOK_SECRET not configured — permission-check endpoint is disabled",
      });
    }

    // ── 2. Bearer token auth (timing-safe, fail closed with 401) ───────────
    const authHeader = String(req.headers["authorization"] || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    const secretBuf = Buffer.from(secret, "utf8");
    const tokenBuf = Buffer.from(token, "utf8");
    const match = secretBuf.length === tokenBuf.length &&
      secretBuf.length > 0 &&
      crypto.timingSafeEqual(secretBuf, tokenBuf);

    if (!match) {
      return res.status(401).json({
        allowed: false,
        reason: "unauthorized",
        message: "Invalid or missing authorization token",
      });
    }

    // ── 3. Input validation (fail with 400) ─────────────────────────────────
    const { ghlContactId, email, channel } = req.body;
    if (!ghlContactId && !email) {
      return res.status(400).json({
        allowed: false,
        reason: "bad_request",
        message: "Request body must include ghlContactId or email",
      });
    }
    const resolvedChannel = String(channel || "email");
    if (!VALID_CHANNELS.has(resolvedChannel)) {
      return res.status(400).json({
        allowed: false,
        reason: "bad_request",
        message: `Invalid channel '${resolvedChannel}'. Must be one of: ${[...VALID_CHANNELS].join(", ")}`,
      });
    }

    // ── 4. Business-rule evaluation (200 for all outcomes incl. internal errors)
    try {
      // Use indexed lookups — never full-table scan
      const contact = ghlContactId
        ? await storage.getContactByGhlContactId(String(ghlContactId))
        : await storage.getContactByEmail(String(email));

      if (!contact) {
        // Log evidence of unmapped GHL contact
        storage.createAuditLog({
          action: "ghl_permission_check_contact_not_found",
          entityType: "contact",
          details: { ghlContactId: ghlContactId || null, email: email || null, channel: resolvedChannel, source: "ghl_permission_check_api" },
        }).catch(() => {});
        return res.status(200).json({
          allowed: false,
          reason: "contact_not_found",
          message: `No local contact found for ${ghlContactId ? `ghlContactId=${ghlContactId}` : `email=${email}`}`,
        });
      }

      const { evaluateContactability } = await import("../services/contactability");
      const result = await evaluateContactability({
        contactId: contact.id,
        channel: resolvedChannel as any,
        mode: "dryRun",
      });

      // Log to activity log (and audit log) for dashboard metrics
      storage.createGhlActivityLog({
        contactId: contact.id,
        dealId: null,
        direction: "outbound",
        channel: "permission_check",
        templateId: null,
        subject: resolvedChannel,
        body: null,
        status: result.allowed ? "sent" : "blocked",
        ghlMessageId: ghlContactId ? String(ghlContactId) : null,
        metadata: { channel: resolvedChannel, allowed: result.allowed, reason: result.reason, tier: (result as any).tier, source: "ghl_permission_check_api" },
      }).catch(() => {});
      storage.createAuditLog({
        action: "ghl_permission_check",
        entityType: "contact",
        entityId: contact.id,
        details: { channel: resolvedChannel, allowed: result.allowed, reason: result.reason, tier: (result as any).tier },
      }).catch(() => {});

      return res.status(200).json({
        allowed: result.allowed,
        reason: result.reason || (result.allowed ? "permitted" : "blocked"),
        tier: (result as any).tier,
        contactId: contact.id,
        doNotContact: contact.doNotContact,
        doNotAutoContact: contact.doNotAutoContact,
        ghlPermissionPayload: result.ghlPermissionPayload,
        checkedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[GHL Permission Check] Error:", err.message);
      // Fail closed — business error returns 200 with allowed=false so GHL
      // conditional branches see the body rather than treating it as a retry
      return res.status(200).json({
        allowed: false,
        reason: "internal_error",
        message: "Internal evaluation error — contact was suppressed",
      });
    }
  });

  // ── Wave 7: Circuit breaker status endpoint ───────────────────────────────
  app.get("/api/ghl/circuit-status", isAuthenticated, async (_req, res) => {
    try {
      const { getGhlCircuitStatus } = await import("../services/ghl-sync");
      const circuit = getGhlCircuitStatus();
      // Each event family is filtered in SQL, so an older trip/reset is never hidden behind newer unrelated audit rows.
      const [tripPage, resetPage] = await Promise.all([
        storage.getAuditLogsByActions(["GHL_CIRCUIT_OPEN"], { limit: 1 }),
        storage.getAuditLogsByActions(["GHL_CIRCUIT_RESET"], { limit: 1 }),
      ]);
      const lastTrip = tripPage.rows[0];
      const lastReset = resetPage.rows[0];
      const lastTripDetails = lastTrip?.details as any;
      res.json({
        ...circuit,
        lastTripAt: lastTrip?.createdAt ? new Date(lastTrip.createdAt).toISOString() : null,
        lastTripReason: lastTripDetails?.reason ?? lastTripDetails?.details ?? (typeof lastTrip?.details === "string" ? lastTrip.details : null),
        lastResetAt: lastReset?.createdAt ? new Date(lastReset.createdAt).toISOString() : null,
        ghlWebhookSecretConfigured: !!process.env.GHL_WEBHOOK_SECRET,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/ghl/email-config", isAuthenticated, async (req, res) => {
    try {
      res.json(getPlatformEmailConfig());
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // GHL Sequences List
  app.get("/api/sequences/list", isAuthenticated, async (req, res) => {
    try {
      const sequences = buildSequenceList();
      res.json({ sequences, total: sequences.length });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Sequence steps for cadence visualizer (name-based lookup; distinct path
  // from the numeric-ID `/api/sequences/:sequenceId/steps` route in
  // campaigns.ts so the two never collide in Express's route matching).
  app.get("/api/sequences/by-name/:name/steps", isAuthenticated, async (req, res) => {
    try {
      const name = decodeURIComponent(req.params.name as string);
      const allSequences = await storage.getFollowUpSequences();
      const sequence = allSequences.find(s => s.name === name);
      if (!sequence) return res.status(404).json({ message: "Sequence not found" });
      const steps = await storage.getSequenceSteps(sequence.id);
      const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
      res.json({ sequence: { id: sequence.id, name: sequence.name, description: sequence.description }, steps: sorted });
    } catch (err: unknown) {
      serverError(res, err);
    }
  });

  // GHL Workflow ID Manager
  app.get("/api/ghl/workflow-mappings", isAuthenticated, async (req, res) => {
    try {
      const mappings = await storage.getGhlWorkflowMappings();
      res.json(mappings);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/ghl/workflow-mappings/:sequenceName", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const sequenceName = decodeURIComponent(req.params.sequenceName as string);
      const { ghlWorkflowId, category, description } = req.body;
      const mapping = await storage.upsertGhlWorkflowMapping(sequenceName, ghlWorkflowId || null, category, description);
      res.json(mapping);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GHL Workflow Env-Key Registry ===
  app.get("/api/ghl/workflow-env-ids", isAuthenticated, async (_req, res) => {
    try {
      const registry = await getWorkflowRegistryWithStatus();
      res.json(registry);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/ghl/workflow-env-ids/:envKey", isAdmin, async (req, res) => {
    try {
      const envKey = req.params.envKey as string;
      const entry = GHL_WORKFLOW_REGISTRY.find(w => w.envKey === envKey);
      if (!entry) return res.status(404).json({ message: "Unknown envKey" });
      const value: string | null = req.body.value || null;
      await setWorkflowEnvValue(envKey, value);
      res.json({ envKey, value, isSet: !!value });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === Seed Scott Sending Identity ===
  app.post("/api/admin/seed-scott-identity", isAdmin, async (_req, res) => {
    try {
      const identities = await storage.getSendingIdentities();
      const existing = identities.find((i: any) => i.emailAddress === "Scott@mail.libertybancard.com");
      if (existing) {
        return res.json({ created: false, identity: existing, message: "Scott's sending identity already exists" });
      }
      const identity = await storage.createSendingIdentity({
        label: "Scott - Liberty Bancard",
        domain: "mail.libertybancard.com",
        emailAddress: "Scott@mail.libertybancard.com",
        mailboxType: "google_workspace",
        isActive: true,
        warmupStatus: "warm",
        warmupStartedAt: new Date(),
        dailyLimit: 30,
        sentToday: 0,
        bouncesToday: 0,
        complaintsToday: 0,
        healthScore: 100,
        verticalAssignment: null,
        lastUsedAt: null,
        provider: null,
        ghlLocationId: null,
      });
      console.log("[Seed] Scott sending identity created:", identity.id);
      res.status(201).json({ created: true, identity, message: "Scott's sending identity seeded successfully" });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/ghl/deleted-records", isAuthenticated, async (req, res) => {
    try {
      const { limit, offset } = parsePagination(req.query as Record<string, any>, 200);
      const deleteActions = ["ghl_delete_received", "ghl_delete_detected", "ghl_delete_propagated", "ghl_delete_failed"];
      // Action filter and paging happen in the database; total is the exact matching count, not a sampled length.
      const page = await storage.getAuditLogsByActions(deleteActions, { limit, offset });
      const records = page.rows.map(l => ({
        id: l.id,
        entityType: l.entityType,
        entityId: l.entityId,
        entityKey: (l as any).entityKey || null,
        action: l.action,
        details: l.details,
        createdAt: l.createdAt,
      }));
      res.json({ records, total: page.total, hasMore: page.hasMore, limit, offset, coverage: "exact" });
    } catch (err: any) {
      serverError(res, err);
    }
  });

}
