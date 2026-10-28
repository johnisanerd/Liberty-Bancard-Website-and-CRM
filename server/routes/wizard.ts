import type { Express } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { db } from "../db";
import { contacts, contactSourceEvents, followUpSequences, auditLogs, sequenceEnrollments } from "@shared/schema";
import { eq, and, like, ilike } from "drizzle-orm";
import { featureFlags } from "../services/feature-flags";
import { sendGhlEmail } from "../services/ghl";
import {
  getWizardFlagOverride,
  setWizardFlagOverride,
  getAllFlagStates,
  isValidWizardFlag,
  startFlagCacheRefresh,
} from "../services/wizard-flag-overrides";
import { analyzeStatementBuffer } from "../services/statement-analyzer";
import { writeContact } from "../services/contact-writer";
import { getQueueManager } from "../services/queue-manager";
import { serverError, safeMessage } from "../utils/server-error";
import { decideCr06SequenceLifecycle } from "../services/cr06-promotional-lifecycle-decision";

const wizardUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = file.mimetype === "application/pdf";
    cb(null, ok);
  },
});

const wizardTestRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: "Too many test sends — limit is 5 per 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (process.env.NODE_ENV === "production") return false;
    const ip = req.ip ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
});

const CALENDAR_VARS: Array<{ key: string; name: string }> = [
  { key: "GHL_CALENDAR_ID", name: "Default" },
  { key: "GHL_CALENDAR_MEDICAL", name: "Medical" },
  { key: "GHL_CALENDAR_DENTAL", name: "Dental" },
  { key: "GHL_CALENDAR_MEDSPA", name: "Med Spa" },
  { key: "GHL_CALENDAR_AUTO", name: "Auto" },
  { key: "GHL_CALENDAR_RESTAURANT", name: "Restaurant" },
];

// Queues shown on the wizard health step. Cadence and freshness come from the queue registry's own metric
// (interval / cron / event-driven model), not from a hand-maintained interval table that can drift from the schedule.
const WIZARD_QUEUE_NAMES = ["ghl-sync", "sequences", "sla-checks", "enrichment", "digests", "discovery", "mid-ingestion"];

function isWizardTestContact(contact: { tags: string[] | null }): boolean {
  return Array.isArray(contact.tags) && contact.tags.includes("wizard_test_contact");
}

function hasIsolatedWizardProviderTransport(): boolean {
  // Live wizard test contacts are user-entered identities. Provider effects are
  // only permissible under the explicit fail-fast transport used by controlled
  // tests; production connectivity is checked by non-sending health probes.
  return process.env.GHL_TRANSPORT_FAILFAST === "true";
}

function wizardProviderTestBlocked(res: import("express").Response): boolean {
  if (hasIsolatedWizardProviderTransport()) return false;
  res.status(409).json({
    ok: false,
    blocked: true,
    reason: "Provider test sends are disabled unless the isolated fail-fast transport is active.",
  });
  return true;
}

export function registerWizardRoutes(app: Express): void {
  // Hydrate the flag cache immediately so getCachedWizardFlagOverrideSync()
  // returns real DB values on the very first featureFlags.* access.
  startFlagCacheRefresh();

  // ── Phase 1: Connectivity ───────────────────────────────────────────────────
  app.get("/api/wizard/connectivity", requireRole("admin", "manager"), async (_req, res) => {
    const timeoutMs = 8_000;

    const [ghlResult, redisResult, openaiResult, smtpResult, webhookResult] = await Promise.allSettled([
      // GHL
      (async () => {
        const { checkGhlHealth } = await import("../services/ghl");
        const start = Date.now();
        const h = await checkGhlHealth();
        return {
          ok: h.connected,
          latencyMs: h.latencyMs ?? (Date.now() - start),
          detail: h.connected
            ? `Connected — ${h.locationName ?? "unknown location"}`
            : (h.error ?? "Not configured"),
        };
      })(),

      // Redis — reuse the shared BullMQ client for ping to avoid consuming an
      // extra Upstash connection slot on every health-check request.
      (async () => {
        const { getSharedRedisClient } = await import("../services/queue-connection");
        const redisUrl = process.env.REDIS_URL;

        if (!redisUrl) {
          return {
            ok: false,
            queueMode: "unavailable",
            detail: "REDIS_URL is not configured; BullMQ queues are unavailable",
          };
        }

        // Prefer the already-open shared client (zero extra connections).
        // Fall back to a fresh probe only if the singleton hasn't been created yet
        // (e.g. BullMQ initialisation hasn't finished during early startup).
        const shared = getSharedRedisClient();
        if (shared) {
          try {
            const result = await Promise.race([
              shared.ping(),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
            ]);
            return {
              ok: result === "PONG",
              queueMode: "bullmq_redis",
              detail: result === "PONG" ? "Connected" : "Unexpected PING response",
            };
          } catch (err: any) {
            return { ok: false, queueMode: "unavailable", detail: safeMessage(err.message, "Ping failed") };
          }
        }

        // Fallback: create a short-lived probe (only during startup before BullMQ is ready)
        try {
          const Redis = (await import("ioredis")).default;
          const url = new URL(redisUrl);
          const forceTls = url.protocol === "rediss:" || url.hostname.includes("upstash.io");
          const probe = new Redis({
            host: url.hostname,
            port: parseInt(url.port || "6379", 10),
            password: url.password || undefined,
            username: url.username || undefined,
            tls: forceTls ? {} : undefined,
            connectTimeout: 5000,
            maxRetriesPerRequest: 1,
            lazyConnect: true,
            enableReadyCheck: false,
          });
          await probe.connect();
          const result = await Promise.race([
            probe.ping(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
          ]);
          probe.disconnect();
          return {
            ok: result === "PONG",
            queueMode: "bullmq_redis",
            detail: result === "PONG" ? "Connected (startup probe)" : "Unexpected PING response",
          };
        } catch (err: any) {
          return { ok: false, queueMode: "unavailable", detail: safeMessage(err.message, "Ping failed") };
        }
      })(),

      // OpenAI
      (async () => {
        const OpenAI = (await import("openai")).default;
        const openai = new OpenAI({
          apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
          baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
        });
        try {
          await Promise.race([
            openai.models.list(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5_000)),
          ]);
          return { ok: true, detail: "API key valid" };
        } catch (err: any) {
          const msg = String(err?.message ?? "");
          if (msg.includes("401") || msg.includes("invalid")) {
            return { ok: false, detail: "Invalid or expired API key" };
          }
          return { ok: false, detail: msg.slice(0, 100) || "Connection failed" };
        }
      })(),

      // SMTP
      (async () => {
        const configured = !!(
          process.env.SMTP_HOST &&
          process.env.SMTP_USER &&
          process.env.SMTP_PASS
        );
        return {
          ok: configured,
          configured,
          detail: configured
            ? `Configured (${process.env.SMTP_HOST})`
            : "SMTP_HOST, SMTP_USER, SMTP_PASS not set — GHL will be used for email",
        };
      })(),

      // Webhook secret
      (async () => {
        const present = !!process.env.GHL_WEBHOOK_SECRET;
        return {
          ok: present,
          detail: present
            ? "GHL_WEBHOOK_SECRET is set"
            : "GHL_WEBHOOK_SECRET not set — webhook signature verification is disabled",
        };
      })(),
    ]);

    const extract = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
      r.status === "fulfilled" ? r.value : fallback;

    res.json({
      ghl: extract(ghlResult, { ok: false, latencyMs: 0, detail: "Check failed" }),
      redis: extract(redisResult, { ok: false, queueMode: "unavailable", detail: "Check failed" }),
      openai: extract(openaiResult, { ok: false, detail: "Check failed" }),
      smtp: extract(smtpResult, { ok: false, configured: false, detail: "Check failed" }),
      webhookSecret: extract(webhookResult, { ok: false, detail: "Check failed" }),
    });
  });

  // ── Phase 2: Test Contact ───────────────────────────────────────────────────
  app.post("/api/wizard/test-contact", requireRole("admin", "manager"), async (req, res) => {
    const { email, phone, firstName } = req.body as {
      email: string;
      phone?: string;
      firstName?: string;
    };

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    // Idempotent: check for existing wizard_test_contact with same email
    const existing = await storage.getContacts({ limit: 5000 });
    const found = existing.data.find(
      (c) => c.email?.toLowerCase() === email.toLowerCase() &&
        Array.isArray(c.tags) && c.tags.includes("wizard_test_contact")
    );

    if (found) {
      return res.json({
        contactId: found.id,
        email: found.email,
        phone: found.phone,
        alreadyExisted: true,
      });
    }

    const contact = await writeContact({
      mode: "local_only",
      mutation: {
        firstName: firstName || "Wizard",
        lastName: "Test",
        email,
        phone: phone || "",
        tags: ["wizard_test_contact"],
      },
      provenance: {
        sourceCategory: "manual_crm",
        sourceType: "dashboard",
        eventKey: `wizard:test-contact:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        actorType: "admin",
        actorId: String((req.user as any)?.id ?? "wizard"),
        metadata: { wizardCreated: true },
      },
      actor: {
        actorType: "admin",
        actorId: String((req.user as any)?.id ?? "wizard"),
        userId: (req.user as any)?.id ?? null,
      },
    });

    res.json({
      contactId: contact.id,
      email: contact.email,
      phone: contact.phone,
      alreadyExisted: false,
    });
  });

  app.delete("/api/wizard/test-contact/:contactId", requireRole("admin", "manager"), async (req, res) => {
    const contactId = Number(req.params.contactId);
    if (!contactId) return res.status(400).json({ error: "Invalid contactId" });

    const contact = await storage.getContact(contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const tags = Array.isArray(contact.tags) ? contact.tags : [];
    if (!tags.includes("wizard_test_contact")) {
      return res.status(403).json({
        error: "This contact does not have the wizard_test_contact tag — refusing to delete to protect real contacts",
      });
    }

    // Null out primary_source_event_id FK first (deferrable constraint), then delete source events, then contact
    await db.update(contacts).set({ primarySourceEventId: null } as any).where(eq(contacts.id, contactId));
    await db.delete(contactSourceEvents).where(eq(contactSourceEvents.contactId, contactId));
    await db.delete(contacts).where(eq(contacts.id, contactId));

    res.json({ deleted: true });
  });

  // ── Phase 3: Live Channel Tests ─────────────────────────────────────────────
  app.post("/api/wizard/test-send/email", requireRole("admin", "manager"), wizardTestRateLimit, async (req, res) => {
    const { contactId } = req.body as { contactId: number };
    if (!contactId) return res.status(400).json({ ok: false, detail: "contactId is required" });
    if (wizardProviderTestBlocked(res)) return;

    try {
      const contact = await storage.getContact(contactId);
      if (!contact || !isWizardTestContact(contact)) {
        return res.status(403).json({ ok: false, detail: "Wizard tests may only target a wizard_test_contact" });
      }
      const result = await sendGhlEmail({
        contactId,
        subject: "Liberty Bancard — System Test Email",
        body: "<p>This is a live test from the Setup Wizard. No action required.</p><p>If you received this, the email channel is working correctly.</p>",
        skipActivityLog: false,
      });
      return res.json({
        ok: result.success,
        messageId: result.messageId,
        detail: result.success ? "Email sent successfully" : (result.error ?? "Send failed"),
      });
    } catch (err: any) {
      return res.json({ ok: false, detail: safeMessage(err.message, "Send failed") });
    }
  });

  app.post("/api/wizard/test-send/sms", requireRole("admin", "manager"), wizardTestRateLimit, async (req, res) => {
    const { contactId } = req.body as { contactId: number };
    if (!contactId) return res.status(400).json({ ok: false, detail: "contactId is required" });
    if (wizardProviderTestBlocked(res)) return;

    if (!featureFlags.SMS_ENABLED) {
      return res.json({ ok: false, blocked: true, reason: "SMS_ENABLED is off — enable in Phase 6" });
    }

    try {
      const contact = await storage.getContact(contactId);
      if (!contact || !isWizardTestContact(contact)) {
        return res.status(403).json({ ok: false, detail: "Wizard tests may only target a wizard_test_contact" });
      }
      const { sendGhlSms } = await import("../services/ghl");
      await sendGhlSms({ contactId, body: "Liberty Bancard setup wizard test SMS — please ignore." });
      return res.json({ ok: true, detail: "SMS sent successfully" });
    } catch (err: any) {
      return res.json({ ok: false, detail: safeMessage(err.message, "SMS send failed") });
    }
  });

  app.post("/api/wizard/test-send/voice", requireRole("admin", "manager"), wizardTestRateLimit, async (req, res) => {
    const { contactId } = req.body as { contactId: number };
    if (!contactId) return res.status(400).json({ ok: false, detail: "contactId is required" });
    if (wizardProviderTestBlocked(res)) return;

    if (!featureFlags.VOICE_AI_ENABLED) {
      return res.json({ ok: false, blocked: true, reason: "VOICE_AI_ENABLED is off — enable in Phase 6" });
    }

    try {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
      if (!contact) return res.json({ ok: false, detail: "Test contact not found" });
      if (!isWizardTestContact(contact)) return res.status(403).json({ ok: false, detail: "Wizard tests may only target a wizard_test_contact" });
      if (!contact.phone) {
        return res.json({ ok: false, detail: "Test contact has no phone number — add one in Phase 2 to test voice" });
      }
      if (!contact.ghlContactId) {
        return res.json({ ok: false, detail: "Contact not yet synced to GHL — wait for the next sync tick (~45 s) and retry" });
      }

      const { enrollInGhlWorkflow } = await import("../services/ghl-workflows");
      const result = await enrollInGhlWorkflow({
        workflowKey: "GHL_WORKFLOW_VOICE_AI_OUTREACH",
        ghlContactId: contact.ghlContactId,
      });
      const resultAny2 = result as any;
      return res.json({
        ok: resultAny2.enrolled,
        method: resultAny2.method ?? null,
        detail: resultAny2.enrolled
          ? `Voice AI workflow triggered for ${contact.firstName ?? contact.email} (GHL contact ${contact.ghlContactId})`
          : (resultAny2.reason ?? "GHL voice workflow not configured — set GHL_WORKFLOW_VOICE_AI_OUTREACH in env or via the Workflow ID Manager"),
      });
    } catch (err: any) {
      return res.json({ ok: false, detail: safeMessage(err.message, "Voice AI initiation failed") });
    }
  });

  app.post("/api/wizard/test-send/voicemail", requireRole("admin", "manager"), wizardTestRateLimit, async (req, res) => {
    const { contactId } = req.body as { contactId: number };
    if (!contactId) return res.status(400).json({ ok: false, detail: "contactId is required" });
    if (wizardProviderTestBlocked(res)) return;

    if (!featureFlags.RINGLESS_VM_ENABLED) {
      return res.json({ ok: false, blocked: true, reason: "RINGLESS_VM_ENABLED is off — enable in Phase 6" });
    }

    try {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
      if (!contact) return res.json({ ok: false, detail: "Test contact not found" });
      if (!isWizardTestContact(contact)) return res.status(403).json({ ok: false, detail: "Wizard tests may only target a wizard_test_contact" });
      if (!contact.phone) {
        return res.json({ ok: false, detail: "Test contact has no phone number — add one in Phase 2 to test ringless VM" });
      }
      if (!contact.ghlContactId) {
        return res.json({ ok: false, detail: "Contact not yet synced to GHL — wait for the next sync tick (~45 s) and retry" });
      }

      const { enrollInGhlWorkflow } = await import("../services/ghl-workflows");
      const result = await enrollInGhlWorkflow({
        workflowKey: "GHL_WORKFLOW_RINGLESS_VM",
        ghlContactId: contact.ghlContactId,
      });
      const resultAny = result as any;
      return res.json({
        ok: resultAny.enrolled,
        method: resultAny.method ?? null,
        detail: resultAny.enrolled
          ? `Ringless voicemail workflow triggered for ${contact.firstName ?? contact.email} (GHL contact ${contact.ghlContactId})`
          : (resultAny.reason ?? "GHL ringless VM workflow not configured — set GHL_WORKFLOW_RINGLESS_VM in env or via the Workflow ID Manager"),
      });
    } catch (err: any) {
      return res.json({ ok: false, detail: safeMessage(err.message, "Ringless VM initiation failed") });
    }
  });

  // ── Phase 4A: Sequence Enrollment ──────────────────────────────────────────
  app.post("/api/wizard/test-sequence", requireRole("admin", "manager"), async (req, res) => {
    const { contactId, sequenceId: rawSequenceId } = req.body as {
      contactId: number;
      sequenceId?: number;
    };

    if (!contactId) return res.status(400).json({ ok: false, error: "contactId is required" });

    let sequence: any;

    if (rawSequenceId) {
      sequence = await (storage as any).getSequence(rawSequenceId);
    } else {
      // Find the "Inbound Confirmation" sequence by name
      const allSeqs = await (storage as any).getSequences();
      sequence = allSeqs.find(
        (s: any) =>
          s.name?.toLowerCase().includes("inbound confirmation") ||
          s.name?.toLowerCase().includes("inbound lead")
      ) ?? allSeqs[0];
    }

    if (!sequence) {
      return res.json({ ok: false, error: "No sequences found — create a sequence first" });
    }

    if (sequence.status !== "active") {
      return res.json({
        ok: false,
        error: `Sequence "${sequence.name}" is paused — activate it in Phase 6 first`,
        sequenceName: sequence.name,
        sequenceId: sequence.id,
      });
    }
    const cr06Decision = decideCr06SequenceLifecycle(sequence);
    if (!cr06Decision.allowed) {
      return res.json({ ok: false, error: cr06Decision.reasonCode, sequenceName: sequence.name, sequenceId: sequence.id });
    }

    const steps = await storage.getSequenceSteps(sequence.id);

    if (!steps || steps.length === 0) {
      return res.json({
        ok: false,
        error: `Sequence "${sequence.name}" has no steps — add at least one step before testing enrollment`,
        sequenceName: sequence.name,
        sequenceId: sequence.id,
      });
    }

    const enrollment = await storage.createSequenceEnrollment({
      contactId,
      sequenceId: sequence.id,
      status: "active",
      currentStep: 0,
      metadata: { wizardTest: true },
    } as any);

    if (!enrollment) {
      return res.json({ ok: false, error: "Failed to create enrollment — contact may already be enrolled" });
    }

    const nextStepAt = new Date(Date.now() + (steps[0]?.delayHours ?? 0) * 3600_000).toISOString();

    return res.json({
      ok: true,
      enrollmentId: enrollment.id,
      sequenceName: sequence.name,
      sequenceId: sequence.id,
      steps: steps.map((s: any) => ({
        stepNumber: s.stepNumber,
        type: s.type,
        delayHours: s.delayHours,
        subject: s.subject ?? null,
      })),
      nextStepAt,
    });
  });

  app.delete("/api/wizard/test-sequence/:enrollmentId", requireRole("admin", "manager"), async (req, res) => {
    const enrollmentId = Number(req.params.enrollmentId);
    if (!enrollmentId) return res.status(400).json({ error: "Invalid enrollmentId" });

    const [enrollment] = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, enrollmentId))
      .limit(1);

    if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });
    if (!(enrollment.metadata as any)?.wizardTest) {
      return res.status(403).json({ error: "This enrollment was not created by the Setup Wizard and cannot be cancelled here" });
    }

    await storage.updateSequenceEnrollment(enrollmentId, { status: "cancelled" } as any);
    return res.json({ cancelled: true });
  });

  // ── Phase 4B: Statement AI Audit ───────────────────────────────────────────
  app.post(
    "/api/wizard/test-statement",
    requireRole("admin", "manager"),
    wizardUpload.single("file"),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded or file too large (max 5MB)" });
      }

      if (!req.file.mimetype.includes("pdf")) {
        return res.status(400).json({ error: "Only PDF files are accepted for statement analysis" });
      }

      try {
        const result = await analyzeStatementBuffer(req.file.buffer, req.file.originalname);
        return res.json(result);
      } catch (err: any) {
        return serverError(res, err);
      }
    }
  );

  // ── Phase 4C: Booking Links ─────────────────────────────────────────────────
  app.get("/api/wizard/booking-links", requireRole("admin", "manager"), async (_req, res) => {
    const configured: Array<{ key: string; name: string; calendarId: string; bookingUrl: string }> = [];
    const unconfigured: string[] = [];

    for (const { key, name } of CALENDAR_VARS) {
      const calendarId = process.env[key];
      if (calendarId && calendarId.trim()) {
        configured.push({
          key,
          name,
          calendarId: calendarId.trim(),
          bookingUrl: `https://api.leadconnectorhq.com/widget/booking/${calendarId.trim()}`,
        });
      } else {
        unconfigured.push(key);
      }
    }

    return res.json({
      configured: configured.length > 0,
      calendars: configured,
      unconfigured,
    });
  });

  // ── Phase 4D: Merchant Application Test ────────────────────────────────────
  app.post("/api/wizard/test-application", requireRole("admin", "manager"), async (req, res) => {
    const { email } = req.body as { email: string };
    if (!email) return res.status(400).json({ error: "email is required" });

    const contact = await writeContact({
      mode: "local_first",
      mutation: {
        firstName: "Wizard",
        lastName: "Test",
        email,
        companyName: "WizardTest LLC",
        tags: ["wizard_application_test"],
      } as any,
      provenance: {
        sourceCategory: "public_form",
        sourceType: "get_started_form",
        eventKey: `wizard:test-app:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        actorType: "admin",
        actorId: String((req.user as any)?.id ?? "wizard"),
        metadata: { wizardApplicationTest: true },
      },
      actor: {
        actorType: "admin",
        actorId: String((req.user as any)?.id ?? "wizard"),
        userId: (req.user as any)?.id ?? null,
      },
    });

    const deal = await storage.createDeal({
      contactId: contact.id,
      pipeline: "sales",
      stage: "New Lead",
      notes: "Wizard test application — safe to delete",
      value: null,
    } as any);

    return res.json({
      ok: true,
      contactId: contact.id,
      dealId: deal.id,
      dealUrl: `/dashboard/contacts/${contact.id}`,
    });
  });

  // ── Phase 5: Queue Health ───────────────────────────────────────────────────
  app.get("/api/wizard/queue-health", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { requireQueueManagerReady, QUEUE_STALE_AFTER_INTERVALS } = await import("../services/queue-manager");
      let qm;
      try {
        qm = requireQueueManagerReady();
      } catch {
        const { getQueueMode } = await import("../services/queue-manager");
        return res.status(503).json({ status: "not_initialized", queueMode: getQueueMode(), queues: [] });
      }
      const { queues, queueMode, status: metricsStatus } = await qm.getAllQueueMetrics();

      const enrichedQueues = queues
        .filter((q: any) => WIZARD_QUEUE_NAMES.some((name) => q.name?.includes(name)))
        .map((q: any) => {
          const probeUnavailable = q.probeStatus !== "ok";
          const freshness = q.freshness ?? null;
          // Stale only when an interval queue's worker is running, its process observed a completion, and that
          // completion is older than the threshold. No observation in this process is unknown, not stale.
          const isStale = freshness?.status === "stale";
          const staleSince = isStale && freshness.lastObservedAt && freshness.expectedIntervalMs
            ? new Date(new Date(freshness.lastObservedAt).getTime() + QUEUE_STALE_AFTER_INTERVALS * freshness.expectedIntervalMs).toISOString()
            : null;

          return {
            name: q.name,
            probeStatus: q.probeStatus,
            errorCode: q.errorCode,
            runtimeState: q.runtimeState,
            capabilityState: q.capabilityState,
            expectedSelected: q.expectedSelected,
            freshnessModel: freshness?.model ?? null,
            freshnessStatus: freshness?.status ?? "unavailable",
            expectedIntervalMs: freshness?.expectedIntervalMs ?? null,
            lastCompletedAt: q.lastCompletedAt ?? null,
            isStale,
            staleSince,
            waiting: probeUnavailable ? null : q.waiting,
            active: probeUnavailable ? null : q.active,
            failed: probeUnavailable ? null : q.failed,
            paused: probeUnavailable ? null : q.paused,
            queueMode,
            metricsStatus,
          };
        });

      return res.json({ queues: enrichedQueues, queueMode });
    } catch (err: any) {
      return serverError(res, err);
    }
  });

  // ── Phase 6A: Sequence Activator (read from existing sequence routes) ───────
  // W6 sequences are listed via GET /api/sequences — no new route needed.
  // The toggle is PUT /api/sequences/:id/toggle-status (existing campaigns.ts route).

  // ── Phase 6B: Feature Flags ─────────────────────────────────────────────────
  app.get("/api/wizard/feature-flags", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const states = await getAllFlagStates();
      return res.json(states);
    } catch (err: any) {
      return serverError(res, err);
    }
  });

  app.post("/api/wizard/feature-flag", requireRole("admin"), async (req, res) => {
    const { flag, enabled, confirmReason } = req.body as {
      flag: string;
      enabled: boolean;
      confirmReason: string;
    };

    if (!flag || !isValidWizardFlag(flag)) {
      return res.status(400).json({
        error: `Invalid flag. Valid flags: SDR_ENABLED, ORCHESTRATOR_ENABLED, LEGACY_OUTREACH_ENABLED, SMS_ENABLED, VOICE_AI_ENABLED, RINGLESS_VM_ENABLED, NIGHTLY_DISCOVERY_ENABLED, SUNBIZ_ENRICHMENT_ENABLED, FREE_ENRICHMENT_ENABLED, CALL_ASSIST_ENABLED, FIELD_SALES_ENABLED`,
      });
    }

    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    if (!confirmReason || String(confirmReason).trim().length < 10) {
      return res.status(400).json({ error: "confirmReason must be at least 10 characters" });
    }

    const actorEmail = (req.user as any)?.email ?? "unknown";
    await setWizardFlagOverride(flag, enabled, actorEmail, confirmReason.trim());

    return res.json({ ok: true, flag, enabled, source: "db_override" });
  });

  // ── Internal Test Email Sends ────────────────────────────────────────────────
  // Sends [TEST]-labeled emails to scott@libertybancard.com for every email step
  // across all active sequences. Never sends to real prospects. SMS stays closed.
  app.post("/api/wizard/test-sequence-emails", requireRole("admin"), wizardTestRateLimit, async (req, res) => {
    const TEST_EMAIL = "scott@libertybancard.com";

    const { sendSmtpEmail, isSmtpConfigured } = await import("../services/smtp-email");
    const { sendGhlEmail, isGhlConfigured } = await import("../services/ghl");

    // Read kill-switch state — included in every test email for transparency
    const pausedRaw = await storage.getSystemSetting("outboundGlobalPaused");
    const outboundGlobalPaused = pausedRaw === true || pausedRaw === "true";

    // Determine send route upfront
    const smtpAvailable = isSmtpConfigured();
    const ghlAvailable  = isGhlConfigured();
    const route = smtpAvailable ? "SMTP" : ghlAvailable ? "GHL" : "none";

    // For GHL fallback we need a local contact whose email is scott@
    let scottContactId: number | null = null;
    if (!smtpAvailable && ghlAvailable) {
      const all = await storage.getContacts({ limit: 5000 });
      const found = all.data.find((c: any) => c.email?.toLowerCase() === TEST_EMAIL.toLowerCase());
      scottContactId = found?.id ?? null;
    }

    // Fetch all active sequences and their email steps
    const allSequences = await storage.getFollowUpSequences();
    const activeSeqs = allSequences.filter((s: any) => s.status === "active");

    interface TestResult {
      sequenceId: number;
      sequenceName: string;
      stepOrder: number;
      stepType: string;
      subject: string;
      status: "sent" | "failed" | "skipped";
      detail: string;
      route: string;
      sentAt: string | null;
    }

    const results: TestResult[] = [];

    for (const seq of activeSeqs) {
      const steps = await storage.getSequenceSteps(seq.id);
      const emailSteps = steps.filter((s: any) => s.actionType === "email");

      for (const step of emailSteps) {
        const originalSubject = (step as any).subject || `${seq.name} — Step ${step.stepOrder}`;
        const testSubject = `[TEST] ${originalSubject}`;

        const metadataHtml = `
<div style="background:#fff3cd;border:2px solid #ffc107;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-family:monospace;font-size:12px;line-height:1.6;">
  <strong style="font-size:14px;">⚠️ INTERNAL TEST — NOT A REAL SEND</strong><br><br>
  <strong>Cadence:</strong> ${seq.name}<br>
  <strong>Step:</strong> ${step.stepOrder}<br>
  <strong>Action type:</strong> ${step.actionType}<br>
  <strong>Route:</strong> ${route}<br>
  <strong>Sender policy applied:</strong> internal_ops → accounts@libertybancard.com<br>
  <strong>outboundGlobalPaused:</strong> ${outboundGlobalPaused}<br>
  <strong>Test recipient:</strong> ${TEST_EMAIL}<br>
  <strong>Timestamp:</strong> ${new Date().toISOString()}<br>
</div>`;

        const originalBody = (step as any).body || "<p><em>(no body configured for this step)</em></p>";
        const testBody = metadataHtml + originalBody;

        if (route === "none") {
          results.push({
            sequenceId: seq.id,
            sequenceName: seq.name,
            stepOrder: step.stepOrder,
            stepType: step.actionType,
            subject: testSubject,
            status: "skipped",
            detail: "No send channel available — configure SMTP or GHL to enable test sends",
            route,
            sentAt: null,
          });
          continue;
        }

        try {
          let sendResult: { success: boolean; messageId?: string; error?: string };

          if (smtpAvailable) {
            sendResult = await sendSmtpEmail({
              to: TEST_EMAIL,
              subject: testSubject,
              html: testBody,
              category: "internal_ops",
            });
          } else {
            // GHL path requires a local contact record
            if (!scottContactId) {
              sendResult = {
                success: false,
                error: `No local contact found for ${TEST_EMAIL} — create a wizard test contact in Phase 2 first`,
              };
            } else {
              sendResult = await sendGhlEmail({
                contactId: scottContactId,
                subject: testSubject,
                body: testBody,
                skipActivityLog: false,
              });
            }
          }

          results.push({
            sequenceId: seq.id,
            sequenceName: seq.name,
            stepOrder: step.stepOrder,
            stepType: step.actionType,
            subject: testSubject,
            status: sendResult.success ? "sent" : "failed",
            detail: sendResult.success
              ? (sendResult.messageId ? `Sent — messageId: ${sendResult.messageId}` : "Sent")
              : (sendResult.error ?? "Send failed"),
            route,
            sentAt: sendResult.success ? new Date().toISOString() : null,
          });
        } catch (err: any) {
          results.push({
            sequenceId: seq.id,
            sequenceName: seq.name,
            stepOrder: step.stepOrder,
            stepType: step.actionType,
            subject: testSubject,
            status: "failed",
            detail: safeMessage(err.message, "Unexpected error during send"),
            route,
            sentAt: null,
          });
        }
      }
    }

    // Audit log
    await storage.createAuditLog({
      action: "internal_test_emails_sent",
      entityType: "system",
      entityId: 0,
      actorType: "admin",
      actorId: String((req.user as any)?.id ?? "admin"),
      details: {
        testRecipient: TEST_EMAIL,
        activeSequences: activeSeqs.length,
        totalEmailSteps: results.length,
        sent: results.filter(r => r.status === "sent").length,
        failed: results.filter(r => r.status === "failed").length,
        skipped: results.filter(r => r.status === "skipped").length,
        route,
        outboundGlobalPaused,
      },
    });

    // Persist last-run timestamp for the go/no-go report
    await storage.setSystemSetting("lastInternalTestEmailsAt", new Date().toISOString());
    await storage.setSystemSetting("lastInternalTestEmailsSummary", JSON.stringify({
      sent: results.filter(r => r.status === "sent").length,
      failed: results.filter(r => r.status === "failed").length,
      skipped: results.filter(r => r.status === "skipped").length,
      total: results.length,
      route,
    }));

    return res.json({
      ok: true,
      testRecipient: TEST_EMAIL,
      route,
      outboundGlobalPaused,
      activeSequences: activeSeqs.length,
      summary: {
        total: results.length,
        sent: results.filter(r => r.status === "sent").length,
        failed: results.filter(r => r.status === "failed").length,
        skipped: results.filter(r => r.status === "skipped").length,
      },
      results,
    });
  });

  // ── End-to-End Flow Audit ────────────────────────────────────────────────────
  // Inspects the recent audit_log record for each pipeline stage and reports
  // gaps with severity: blocker / warning / informational.
  app.post("/api/wizard/flow-audit", requireRole("admin"), async (req, res) => {
    const { db: _db } = await import("../db");
    const { sql } = await import("drizzle-orm");

    interface AuditStage {
      stage: string;
      description: string;
      logAction: string;
      severity: "blocker" | "warning" | "informational";
    }

    const PIPELINE_STAGES: AuditStage[] = [
      // action emitted by: server/services/contact-writer.ts + server/storage/contacts.ts
      { stage: "Inbound form submission",       description: "Contact created from a public form or import",                  logAction: "contact_created",                            severity: "blocker" },
      // action emitted by: server/services/ghl-sync.ts (line 288 — contact upserted successfully)
      { stage: "GHL sync",                      description: "Contact pushed to GoHighLevel CRM",                             logAction: "ghl_sync_success",                           severity: "warning" },
      // action emitted by: server/services/sequence-worker.ts (contactability gate blocks enrollment)
      { stage: "Sequence eligibility check",    description: "Contactability evaluated before enrollment",                    logAction: "sequence_enrollment_blocked_contactability", severity: "informational" },
      // action emitted by: server/services/sequence-worker.ts (kill-switch gate fires)
      { stage: "Global pause gate",             description: "outboundGlobalPaused evaluated before every send",              logAction: "sequence_step_skipped_global_pause",          severity: "informational" },
      // action emitted by: server/services/sequence-worker.ts (auto-enrollment from trigger)
      { stage: "Sequence enrollment",           description: "Contact auto-enrolled in a follow-up sequence",                 logAction: "sequence_auto_enrolled",                     severity: "warning" },
      // action emitted by: server/services/sequence-worker.ts line 1263 (step executed successfully)
      { stage: "Email step dispatch",           description: "Sequence email step executed and sent",                         logAction: "sequence_step_executed",                     severity: "blocker" },
      // action emitted by: server/services/ghl.ts (inbound webhook processed)
      { stage: "Reply / bounce webhook",        description: "Inbound message or bounce received and processed",              logAction: "inbound_message_processed",                  severity: "warning" },
      // action emitted by: POST /api/wizard/test-sequence-emails in this file
      { stage: "Internal test email send",      description: "Test emails sent to scott@ via wizard",                         logAction: "internal_test_emails_sent",                  severity: "informational" },
    ];

    interface StageResult {
      stage: string;
      description: string;
      severity: "blocker" | "warning" | "informational";
      found: boolean;
      lastSeenAt: string | null;
      note: string;
    }

    const stageResults: StageResult[] = [];

    for (const ps of PIPELINE_STAGES) {
      try {
        const rows = await _db.execute(sql`
          SELECT created_at FROM audit_logs
          WHERE action = ${ps.logAction}
          ORDER BY created_at DESC
          LIMIT 1
        `);
        const found = rows.rows.length > 0;
        const lastSeenAt = found ? String(rows.rows[0].created_at) : null;
        stageResults.push({
          stage: ps.stage,
          description: ps.description,
          severity: ps.severity,
          found,
          lastSeenAt,
          note: found
            ? `Last recorded: ${lastSeenAt}`
            : ps.severity === "blocker"
              ? `No audit record found — this stage has never fired or always silently fails`
              : ps.severity === "warning"
                ? `No record found — stage may not have run yet or uses a different action key`
                : `No record yet — expected once the pipeline is active`,
        });
      } catch (err: any) {
        stageResults.push({
          stage: ps.stage,
          description: ps.description,
          severity: ps.severity,
          found: false,
          lastSeenAt: null,
          note: `Audit query failed: ${err.message}`,
        });
      }
    }

    // Additional checks beyond audit_log inspection
    const additionalChecks: Array<{ check: string; ok: boolean; severity: "blocker" | "warning" | "informational"; note: string }> = [];

    // Check outboundGlobalPaused
    const pausedRaw = await storage.getSystemSetting("outboundGlobalPaused");
    const outboundGlobalPaused = pausedRaw === true || pausedRaw === "true";
    additionalChecks.push({
      check: "outboundGlobalPaused is set",
      ok: outboundGlobalPaused,
      severity: "blocker",
      note: outboundGlobalPaused
        ? "Kill switch is active — no bulk outbound will fire"
        : "⚠️ Kill switch is OFF — bulk sequences will send if active sequences exist",
    });

    // Check contact count
    let contactCount = 0;
    try {
      const r = await _db.execute(sql`SELECT COUNT(*) AS cnt FROM contacts`);
      contactCount = Number(r.rows[0]?.cnt ?? 0);
    } catch { /* ignore */ }
    additionalChecks.push({
      check: "Contacts exist in CRM",
      ok: contactCount > 0,
      severity: "informational",
      note: `${contactCount} contacts in database`,
    });

    // Check active sequences
    const allSeqs = await storage.getFollowUpSequences();
    const activeCount = allSeqs.filter((s: any) => s.status === "active").length;
    additionalChecks.push({
      check: "At least one active sequence",
      ok: activeCount > 0,
      severity: "warning",
      note: `${activeCount} active sequences (${allSeqs.length} total)`,
    });

    // Persist audit timestamp
    const auditRanAt = new Date().toISOString();
    await storage.setSystemSetting("lastFlowAuditAt", auditRanAt);

    const blockers = stageResults.filter(r => !r.found && r.severity === "blocker").length
      + additionalChecks.filter(c => !c.ok && c.severity === "blocker").length;
    const warnings = stageResults.filter(r => !r.found && r.severity === "warning").length
      + additionalChecks.filter(c => !c.ok && c.severity === "warning").length;

    return res.json({
      ok: true,
      ranAt: auditRanAt,
      blockers,
      warnings,
      pipelineStages: stageResults,
      additionalChecks,
    });
  });

  // ── Go/No-Go Report ──────────────────────────────────────────────────────────
  // Structured readiness gate for each outbound channel. Saved in system_settings.
  app.get("/api/wizard/gonogo-report", requireRole("admin", "manager"), async (_req, res) => {
    const { isGhlConfigured } = await import("../services/ghl");
    const { isSmtpConfigured } = await import("../services/smtp-email");

    const ghlOk      = isGhlConfigured();
    const smtpOk     = isSmtpConfigured();
    const emailReady = ghlOk || smtpOk;

    const pausedRaw = await storage.getSystemSetting("outboundGlobalPaused");
    const outboundGlobalPaused = pausedRaw === true || pausedRaw === "true";

    const lastTestAt  = await storage.getSystemSetting("lastInternalTestEmailsAt");
    const lastAuditAt = await storage.getSystemSetting("lastFlowAuditAt");
    const lastTestSummaryRaw = await storage.getSystemSetting("lastInternalTestEmailsSummary");
    let lastTestSummary: Record<string, unknown> | null = null;
    try {
      if (typeof lastTestSummaryRaw === "string") {
        lastTestSummary = JSON.parse(lastTestSummaryRaw);
      }
    } catch { /* ignore */ }

    const allSeqs   = await storage.getFollowUpSequences();
    const activeSeqCount = allSeqs.filter((s: any) => s.status === "active").length;

    interface GoNoGoGate {
      gate: string;
      status: "go" | "no_go" | "blocked" | "warning";
      notes: string;
    }

    const gates: GoNoGoGate[] = [
      {
        gate: "Website + CRM",
        status: ghlOk ? "go" : "warning",
        notes: ghlOk
          ? "GHL CRM connected and healthy"
          : "GHL not configured — contact sync and CRM pipeline unavailable",
      },
      {
        gate: "Controlled email outbound (internal test only)",
        status: emailReady && lastTestAt ? "go" : emailReady ? "warning" : "no_go",
        notes: !emailReady
          ? "No email channel configured — set up SMTP or GHL to enable sends"
          : lastTestAt
            ? `Last internal test run: ${lastTestAt}${lastTestSummary ? ` — ${lastTestSummary.sent ?? 0}/${lastTestSummary.total ?? 0} emails sent` : ""}`
            : "Email channel available but no internal test has been run yet — click 'Send Internal Test Emails' above",
      },
      {
        gate: "Bulk sequence release (gated)",
        // "blocked" = kill switch is ON — expected pre-launch state; counts as acceptable in overallGo.
        // "no_go"   = kill switch is OFF with active sequences queued — bulk will fire, requires deliberate action.
        // "warning" = kill switch is OFF but no active sequences — nothing will fire, but pause should be re-enabled.
        status: outboundGlobalPaused ? "blocked" : activeSeqCount > 0 ? "no_go" : "warning",
        notes: outboundGlobalPaused
          ? `Kill switch is ON (outboundGlobalPaused=true) — ${activeSeqCount} active sequence(s) queued but cannot fire. Lift the pause deliberately when ready for live outbound.`
          : activeSeqCount > 0
          ? `Kill switch is OFF and ${activeSeqCount} active sequence(s) exist — bulk sequences will send. Re-enable outboundGlobalPaused until you are ready for live outbound.`
          : "Kill switch is OFF but no active sequences exist — nothing will fire. Consider re-enabling outboundGlobalPaused for safety.",
      },
      {
        gate: "SMS",
        status: "blocked",
        notes: "Permanently blocked — A2P 10DLC registration not completed. No SMS sends will occur regardless of feature flags.",
      },
      {
        gate: "Lead-list import",
        status: "go",
        notes: "CSV import pipeline is functional. Suppression (DNC, unsubscribe, existing-contact) runs automatically on every import.",
      },
    ];

    const reportGeneratedAt = new Date().toISOString();

    return res.json({
      generatedAt: reportGeneratedAt,
      lastFlowAuditAt: typeof lastAuditAt === "string" ? lastAuditAt : null,
      lastInternalTestEmailsAt: typeof lastTestAt === "string" ? lastTestAt : null,
      lastTestSummary,
      outboundGlobalPaused,
      activeSequences: activeSeqCount,
      gates,
      overallGo: gates.every(g => g.status === "go" || g.status === "blocked"),
    });
  });
}
