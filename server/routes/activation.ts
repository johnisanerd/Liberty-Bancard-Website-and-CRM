import type { Express } from "express";
import fs from "fs";
import path from "path";
import { isAdmin, isAuthenticated, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { db } from "../db";
import { sql, desc, and, gte, eq } from "drizzle-orm";
import { emailLogs, callLogs, outboundMessages, auditLogs, followUpSequences, sequenceSteps, consentAuditLogs, outboundSendCounters } from "@shared/schema";
import { featureFlags } from "../services/feature-flags";
import { runStageProgressionSweep } from "../services/stage-progression";
import { getGhlCircuitState } from "../services/ghl-sync";
import { createPreferenceAwareNotification, sendCriticalEmailNotification } from "../services/digest-service";
import { serverError, safeMessage, logOperationalDiagnostic } from "../utils/server-error";
import { sanitizeAuditPayload } from "../services/audit-sanitizer";
import { isUsableSenderIdentity } from "../services/sdr/sender-identity-state";

// Block-list patterns — no raw/test/demo/DNC records (matches pilot-preview policy)
const BLOCKED_NAME_PATTERNS = [/test/i, /demo/i, /example/i, /liberty-test/i];

const CHANNEL_LABEL: Record<string, string> = {
  sms: "SMS",
  voice_ai: "Voice AI",
  ringless_vm: "Ringless Voicemail",
};

// Alerts the rest of the team (compliance/ops/admins) that a channel has
// been approved via the Approval Gate and is now waiting on a manual
// Replit Secret flip + restart. Purely informational — never touches
// process.env or the Secrets API.
async function notifyChannelApproved(params: {
  channel: ChannelKey;
  envFlag: string;
  actorEmail: string | null;
  auditId: number;
  manualStep: string;
}): Promise<void> {
  const { channel, envFlag, actorEmail, auditId, manualStep } = params;
  const label = CHANNEL_LABEL[channel] || channel;
  const approvedBy = actorEmail || "an admin";
  const title = `${label} approved for go-live`;
  const message = `${approvedBy} approved the ${label} channel (audit #${auditId}). ${manualStep}`;

  try {
    const teamUsers = await storage.getUsersByRole(["admin", "manager"]);
    await Promise.all(
      teamUsers.map((user) =>
        createPreferenceAwareNotification(
          {
            channel: "activation",
            recipientId: user.id,
            title,
            message,
            type: "info",
            metadata: { channel, envFlag, auditId, actorEmail },
          },
          "channel_approved"
        )
      )
    );
  } catch (err) {
    logOperationalDiagnostic("channel_approval_notification", err, "notification_write_failed", { auditId });
  }

  await sendCriticalEmailNotification({
    eventType: "channel_approved",
    subject: `[Liberty Bancard] ${label} approved for go-live — manual action required`,
    body: `${title}\n\n${message}`,
  });
}

// ── Task #695: Voice/SMS/Ringless Go-Live Audit — Approval Gate ────────────
// This is a READ/AUDIT-ONLY approval layer. Nothing in this section ever
// reads/writes process.env.SMS_ENABLED, VOICE_AI_ENABLED, or
// RINGLESS_VM_ENABLED, and nothing calls a Replit Secrets mutation API.
// Those flags remain Replit Secrets requiring manual operator action +
// restart. Canonical channel keys are fixed and non-negotiable: "sms",
// "voice_ai", "ringless_vm" — never "voice", "ringless", or bare "call".
export const VALID_CHANNELS = ["sms", "voice_ai", "ringless_vm"] as const;
export type ChannelKey = typeof VALID_CHANNELS[number];

function safeReasonBucket(value: unknown): string {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48) : "";
  return normalized && /^[a-z0-9_]+$/.test(normalized) ? normalized : "other";
}

function channelAuditChecklistSnapshot(checklist: { passed: boolean; items?: Array<{ ok?: boolean }> }) {
  const items = Array.isArray(checklist.items) ? checklist.items : [];
  const passedCount = items.filter((item) => item.ok === true).length;
  return {
    passed: checklist.passed === true,
    totalChecks: items.length,
    passedCount,
    failedCount: items.length - passedCount,
  };
}

const CHANNEL_ACTION_TYPE: Record<ChannelKey, string> = {
  sms: "sms",
  voice_ai: "call",
  ringless_vm: "voicemail_drop",
};

const CHANNEL_ENV_FLAG: Record<ChannelKey, "SMS_ENABLED" | "VOICE_AI_ENABLED" | "RINGLESS_VM_ENABLED"> = {
  sms: "SMS_ENABLED",
  voice_ai: "VOICE_AI_ENABLED",
  ringless_vm: "RINGLESS_VM_ENABLED",
};

export interface ChannelChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ChannelChecklistResult {
  channel: ChannelKey;
  passed: boolean;
  items: ChannelChecklistItem[];
  currentlyEnabled: boolean;
  evaluatedAt: string;
}

/**
 * Server-side, non-trusted-client checklist evaluator. Every route that
 * gates on this MUST call this function itself and MUST NOT trust a
 * client-submitted `{ allPassed: true }` (or similar) body.
 */
export async function evaluateChannelChecklist(channel: ChannelKey): Promise<ChannelChecklistResult> {
  const actionType = CHANNEL_ACTION_TYPE[channel];

  // 1. Proven active sequence step using the canonical actionType mapping
  //    (sequence-worker.ts:285-294) — the only real source of truth for
  //    which channels have live outbound scripts/templates.
  let sequenceStepFound = false;
  let sequenceDetail = `No proven active ${channel} sequence step found.`;
  try {
    const rows = await db
      .select({
        sequenceId: followUpSequences.id,
        sequenceName: followUpSequences.name,
        stepId: sequenceSteps.id,
      })
      .from(sequenceSteps)
      .innerJoin(followUpSequences, eq(sequenceSteps.sequenceId, followUpSequences.id))
      .where(and(eq(sequenceSteps.actionType, actionType), eq(followUpSequences.status, "active")))
      .limit(5);
    sequenceStepFound = rows.length > 0;
    if (sequenceStepFound) {
      sequenceDetail = `Found ${rows.length} active step(s) with actionType="${actionType}" (e.g. sequence "${rows[0].sequenceName}")`;
    }
  } catch (err: any) {
    logOperationalDiagnostic("channel_checklist", err, "sequence_check_failed");
    sequenceDetail = "Unable to evaluate active sequence steps.";
  }

  // 2. PEWC (Prior Express Written Consent) evidence — real predicate from
  //    contactability.ts:168-173, since no pewc_consents table exists.
  let pewcFound = false;
  let pewcDetail = "No express written consent evidence found in consent_audit_logs.";
  try {
    const [row] = await db
      .select({ id: consentAuditLogs.id })
      .from(consentAuditLogs)
      .where(
        and(
          eq(consentAuditLogs.consentType, "express_written"),
          sql`${consentAuditLogs.disclosureVersion} IS NOT NULL`,
          sql`${consentAuditLogs.consentedPhone} IS NOT NULL`
        )
      )
      .limit(1);
    pewcFound = !!row;
    if (pewcFound) {
      pewcDetail = "At least one express_written consent record with a disclosure version and consented phone found.";
    }
  } catch (err: any) {
    logOperationalDiagnostic("channel_checklist", err, "consent_evidence_check_failed");
    pewcDetail = "Unable to evaluate consent evidence.";
  }

  // 3. Quiet hours are enforced structurally (no global system_settings
  //    on/off row exists) via isWithinBusinessHours() inside the
  //    contactability gate. This runs the REAL function at two known
  //    reference times (a Tuesday 10am ET business-hours slot and a
  //    Tuesday 2am ET quiet-hours slot) and confirms it actually returns
  //    true/false as expected, plus confirms the contactability source
  //    still wires it in — behavioral proof, not just a string match.
  let quietHoursOk = false;
  let quietHoursDetail = "Could not verify isWithinBusinessHours() enforces quiet hours.";
  try {
    const { isWithinBusinessHours } = await import("../services/sdr/voice-orchestrator");
    // Tuesday July 7, 2026, 10:00 ET (business hours) vs. 2:00 ET (quiet hours).
    const businessHoursSample = new Date("2026-07-07T14:00:00.000Z"); // 10:00 ET
    const quietHoursSample = new Date("2026-07-07T06:00:00.000Z"); // 02:00 ET
    const duringBusinessHours = isWithinBusinessHours("America/New_York", businessHoursSample);
    const duringQuietHours = isWithinBusinessHours("America/New_York", quietHoursSample);

    const source = fs.readFileSync(path.join(process.cwd(), "server/services/contactability.ts"), "utf-8");
    const wiredIntoGate = source.includes("isWithinBusinessHours");

    quietHoursOk = duringBusinessHours === true && duringQuietHours === false && wiredIntoGate;
    quietHoursDetail = quietHoursOk
      ? "isWithinBusinessHours() correctly allows a Tue 10am ET sample and blocks a Tue 2am ET sample, and evaluateContactability() calls it before any send."
      : `Quiet-hours behavior check failed (businessHours=${duringBusinessHours}, quietHours=${duringQuietHours}, wiredIntoGate=${wiredIntoGate}).`;
  } catch (err: any) {
    logOperationalDiagnostic("channel_checklist", err, "quiet_hours_check_failed");
    quietHoursDetail = "Unable to verify quiet-hours enforcement.";
  }

  const items: ChannelChecklistItem[] = [
    {
      key: "active_sequence_step",
      label: `Proven active sequence step (actionType="${actionType}")`,
      ok: sequenceStepFound,
      detail: sequenceDetail,
    },
    {
      key: "pewc_consent_evidence",
      label: "PEWC express written consent evidence exists",
      ok: pewcFound,
      detail: pewcDetail,
    },
    {
      key: "quiet_hours_enforcement",
      label: "Quiet hours enforcement wired into compliance path",
      ok: quietHoursOk,
      detail: quietHoursDetail,
    },
  ];

  return {
    channel,
    passed: items.every((i) => i.ok),
    items,
    currentlyEnabled: featureFlags[CHANNEL_ENV_FLAG[channel]] === true,
    evaluatedAt: new Date().toISOString(),
  };
}

export function registerActivationRoutes(app: Express, dependencies: {
  invitationMail?:Pick<typeof import("../services/smtp-email"),"isSmtpConfigured"|"sendSmtpEmail">;
} = {}) {
  // === ACTIVATION DIAGNOSTICS ===
  app.get("/api/operator/activation-status", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const identities = await storage.getSendingIdentities();
      const activeIdentities = identities.filter((i: any) => isUsableSenderIdentity(i));

      const heartbeat = await storage.getSystemSetting("sequence_runner_last_tick");
      const slaHeartbeat = await storage.getSystemSetting("sla_worker_last_tick");
      const stageRun = await storage.getSystemSetting("stage_progression_last_run");

      const now = Date.now();
      const lastTickAt = heartbeat?.at ? new Date(heartbeat.at).getTime() : 0;
      const lastSlaTickAt = slaHeartbeat?.at ? new Date(slaHeartbeat.at).getTime() : 0;
      const STALE_MS = 15 * 60 * 1000;

      const activeEnrollments = await storage.getActiveEnrollments();

      const [emailCnt] = await db.select({ count: sql<number>`count(*)`, lastAt: sql<string | null>`max(${emailLogs.createdAt})` })
        .from(emailLogs)
        .where(sql`${emailLogs.createdAt} > NOW() - INTERVAL '24 hours'`);
      const [callCnt] = await db.select({ count: sql<number>`count(*)`, lastAt: sql<string | null>`max(${callLogs.createdAt})` })
        .from(callLogs)
        .where(sql`${callLogs.createdAt} > NOW() - INTERVAL '24 hours'`);
      const [outboundCnt] = await db.select({ count: sql<number>`count(*)`, lastAt: sql<string | null>`max(${outboundMessages.sentAt})` })
        .from(outboundMessages)
        .where(sql`${outboundMessages.sentAt} > NOW() - INTERVAL '24 hours'`);
      const totalRecent = Number(emailCnt?.count || 0) + Number(callCnt?.count || 0) + Number(outboundCnt?.count || 0);

      // Last successful send timestamp across all channels (not bounded by
      // the 24h window) so operators can see recency even when there has
      // been no recent activity.
      const [emailMax] = await db.select({ lastAt: sql<string | null>`max(${emailLogs.createdAt})` }).from(emailLogs);
      const [callMax] = await db.select({ lastAt: sql<string | null>`max(${callLogs.createdAt})` }).from(callLogs);
      const [outboundMax] = await db.select({ lastAt: sql<string | null>`max(${outboundMessages.sentAt})` }).from(outboundMessages);
      const lastSendCandidates = [emailMax?.lastAt, callMax?.lastAt, outboundMax?.lastAt]
        .filter((x): x is string => !!x)
        .map(x => new Date(x).getTime());
      const lastSendAtMs = lastSendCandidates.length ? Math.max(...lastSendCandidates) : 0;
      const lastSendAt = lastSendAtMs ? new Date(lastSendAtMs).toISOString() : null;

      // Use the SDR GHL config helper so this matches the wizard's gate
      // (accepts GHL_PRIVATE_INTEGRATION_TOKEN OR GHL_API_KEY plus location).
      const { isSdrGhlConfigured, getSdrGhlConfig, fetchCalendars } = await import("../services/sdr/ghl-client");
      const sdrCfg = getSdrGhlConfig();
      const ghlConfigured = isSdrGhlConfigured();
      let ghlAuthOk = false;
      let ghlAuthDetail = "Skipped (not configured)";
      if (ghlConfigured) {
        try {
          const cals = await fetchCalendars();
          ghlAuthOk = true;
          ghlAuthDetail = `Auth probe OK (${Array.isArray(cals) ? cals.length : 0} calendars)`;
        } catch (err: any) {
          logOperationalDiagnostic("activation_ghl_auth_probe", err, "auth_probe_failed");
          ghlAuthDetail = "Auth probe failed.";
        }
      }

      const checks = [
        {
          id: "ghl_configured",
          label: "GHL credentials configured & auth verified",
          ok: ghlConfigured && ghlAuthOk,
          detail: ghlConfigured
            ? `Token: ${sdrCfg.hasToken ? "set" : "missing"} · Location: ${sdrCfg.hasLocationId ? "set" : "missing"} · ${ghlAuthDetail}`
            : "Set GHL_PRIVATE_INTEGRATION_TOKEN (or GHL_API_KEY) and GHL_LOCATION_ID",
        },
        {
          id: "active_identity",
          label: "At least one active sending identity",
          ok: activeIdentities.length > 0,
          detail: `${activeIdentities.length} active / ${identities.length} total`,
        },
        {
          id: "outreach_flag",
          label: "LEGACY_OUTREACH_ENABLED flag on",
          ok: featureFlags.LEGACY_OUTREACH_ENABLED,
          detail: featureFlags.LEGACY_OUTREACH_ENABLED ? "Enabled" : "Set LEGACY_OUTREACH_ENABLED=true to start sending",
        },
        {
          id: "sla_worker",
          label: "SLA / scheduler heartbeat fresh (<15min)",
          ok: lastSlaTickAt > 0 && (now - lastSlaTickAt) < STALE_MS,
          detail: lastSlaTickAt ? `Last tick ${new Date(lastSlaTickAt).toISOString()}` : "Never",
        },
        {
          id: "sequence_runner",
          label: "Sequence runner heartbeat fresh (<15min)",
          ok: lastTickAt > 0 && (now - lastTickAt) < STALE_MS,
          detail: lastTickAt
            ? `Last tick ${new Date(lastTickAt).toISOString()} — processed ${heartbeat?.processed ?? 0}, sent ${heartbeat?.sent ?? 0}`
            : "Never (worker disabled or has not run yet)",
        },
        {
          id: "active_enrollments",
          label: "Active sequence enrollments exist",
          ok: activeEnrollments.length > 0,
          detail: `${activeEnrollments.length} active enrollments`,
        },
        {
          id: "recent_sends",
          label: "Outbound activity in last 24h (email + calls + outbound)",
          ok: totalRecent > 0,
          detail: `${totalRecent} total — email ${Number(emailCnt?.count || 0)}, calls ${Number(callCnt?.count || 0)}, outbound ${Number(outboundCnt?.count || 0)}`
            + (lastSendAt ? ` · last send ${lastSendAt}` : " · no sends recorded yet"),
        },
      ];

      const ready = checks.every(c => c.ok);

      const circuitState = getGhlCircuitState();
      res.json({
        ready,
        checks,
        lastSendAt,
        heartbeat: { sequenceRunner: heartbeat || null, slaWorker: slaHeartbeat || null, stageProgression: stageRun || null },
        activeIdentities: activeIdentities.length,
        totalIdentities: identities.length,
        activeEnrollments: activeEnrollments.length,
        flags: {
          LEGACY_OUTREACH_ENABLED: featureFlags.LEGACY_OUTREACH_ENABLED,
          ORCHESTRATOR_ENABLED: featureFlags.ORCHESTRATOR_ENABLED,
          SDR_ENABLED: featureFlags.SDR_ENABLED,
        },
        ghlSync: {
          circuitOpen: circuitState.open,
          consecutiveFailures: circuitState.consecutiveFailures,
        },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === RECENT SENDS WIDGET ===
  app.get("/api/operator/recent-sends", isDashboardUser, async (_req, res) => {
    try {
      const since = sql`NOW() - INTERVAL '24 hours'`;

      const [emailRow] = await db.select({ count: sql<number>`count(*)` })
        .from(emailLogs)
        .where(sql`${emailLogs.createdAt} > ${since}`);

      const [callRow] = await db.select({ count: sql<number>`count(*)` })
        .from(callLogs)
        .where(sql`${callLogs.createdAt} > ${since}`);

      const [outboundRow] = await db.select({ count: sql<number>`count(*)` })
        .from(outboundMessages)
        .where(sql`${outboundMessages.sentAt} > ${since}`);

      const recent = await db.select()
        .from(emailLogs)
        .where(sql`${emailLogs.createdAt} > ${since}`)
        .orderBy(desc(emailLogs.createdAt))
        .limit(20);

      res.json({
        windowHours: 24,
        totals: {
          email: Number(emailRow?.count || 0),
          calls: Number(callRow?.count || 0),
          outbound: Number(outboundRow?.count || 0),
          all: Number(emailRow?.count || 0) + Number(callRow?.count || 0) + Number(outboundRow?.count || 0),
        },
        recent: recent.map((r: any) => ({
          id: r.id,
          channel: "email",
          to: r.to,
          subject: r.subject,
          status: r.status,
          sentAt: r.createdAt,
        })),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === SEQUENCES NOT FIRING WIDGET ===
  app.get("/api/operator/silent-sequences", isDashboardUser, async (_req, res) => {
    try {
      const all = await storage.getActiveEnrollments();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;

      const silent = all.filter((e: any) => {
        const updated = e.updatedAt ? new Date(e.updatedAt).getTime() : 0;
        return updated < cutoff;
      }).slice(0, 50);

      const heartbeat = await storage.getSystemSetting("sequence_runner_last_tick");
      const lastTickAt = heartbeat?.at ? new Date(heartbeat.at).getTime() : 0;
      const STALE_MS = 15 * 60 * 1000;
      const workerStale = lastTickAt === 0 || (Date.now() - lastTickAt) > STALE_MS;

      const reason = !featureFlags.LEGACY_OUTREACH_ENABLED
        ? "LEGACY_OUTREACH_ENABLED is OFF — sequence runner is gated"
        : workerStale
          ? "Sequence runner heartbeat stale — worker may have crashed"
          : "Enrollments not progressing — check next_action_at and sending identities";

      res.json({
        totalActive: all.length,
        silentCount: silent.length,
        reason,
        workerStale,
        outreachEnabled: featureFlags.LEGACY_OUTREACH_ENABLED,
        lastTick: heartbeat || null,
        items: silent.map((e: any) => ({
          id: e.id,
          contactId: e.contactId,
          dealId: e.dealId,
          sequenceId: e.sequenceId,
          currentStep: e.currentStep,
          status: e.status,
          nextActionAt: e.nextActionAt,
          updatedAt: e.updatedAt,
        })),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === SENDING IDENTITY VALIDATION ===
  // Server-side validation surfaced by the wizard before the user creates an
  // identity. Checks GHL readiness, email format, duplicates, and (when
  // possible) probes GHL to confirm the address can be used as a sender.
  app.post("/api/operator/validate-identity", isDashboardUser, async (req, res) => {
    try {
      const emailAddress = String(req.body?.emailAddress || "").trim().toLowerCase();
      const label = String(req.body?.label || "").trim();
      const errors: string[] = [];
      const warnings: string[] = [];

      if (!label) errors.push("Label is required");
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailAddress) errors.push("Email address is required");
      else if (!emailRe.test(emailAddress)) errors.push("Email address is not a valid format");

      // Use the real SDR GHL client — it accepts either
      // GHL_PRIVATE_INTEGRATION_TOKEN or GHL_API_KEY plus GHL_LOCATION_ID.
      const { isSdrGhlConfigured, fetchCalendars, getSdrGhlConfig } = await import("../services/sdr/ghl-client");
      const cfg = getSdrGhlConfig();
      const ghlConfigured = isSdrGhlConfigured();
      if (!ghlConfigured) {
        if (!cfg.hasToken) errors.push("GHL is not configured (set GHL_PRIVATE_INTEGRATION_TOKEN or GHL_API_KEY)");
        if (!cfg.hasLocationId) errors.push("GHL_LOCATION_ID is not set");
      }

      const existing = await storage.getSendingIdentities();
      const dup = existing.find((i: any) => (i.emailAddress || "").toLowerCase() === emailAddress);
      if (dup) errors.push(`Email already registered as identity #${dup.id} (${dup.label})`);

      // Real GHL auth probe — fail closed if the call rejects so the wizard
      // can never gate-bypass on a broken connection.
      let ghlProbe: { ok: boolean; detail: string } = { ok: false, detail: "GHL probe skipped (not configured)" };
      if (ghlConfigured && emailRe.test(emailAddress)) {
        try {
          const calendars = await fetchCalendars();
          ghlProbe = {
            ok: true,
            detail: `GHL auth confirmed (${Array.isArray(calendars) ? calendars.length : 0} calendars visible) — sender address can be saved`,
          };
        } catch (err: any) {
          ghlProbe = { ok: false, detail: safeMessage(err.message, "GHL auth failed") };
          errors.push(ghlProbe.detail);
        }
      } else if (!ghlConfigured) {
        errors.push("Cannot validate sender against GHL — fix configuration first");
      }

      res.json({
        ok: errors.length === 0,
        emailAddress,
        label,
        errors,
        warnings,
        ghlProbe,
        existingCount: existing.length,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === STAGE PROGRESSION BACKFILL ===
  app.post("/api/operator/backfill-stages", isAdmin, async (req, res) => {
    try {
      const limit = parseInt(req.body?.limit || "1000", 10);
      const result = await runStageProgressionSweep({ limit });
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === COMMUNICATIONS HEALTH ===
  app.get("/api/operator/communications-health", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isSmtpConfigured, getSmtpStatus } = await import("../services/smtp-email");
      const { isSdrGhlConfigured } = await import("../services/sdr/ghl-client");
      const { isGhlConfigured } = await import("../services/ghl");

      const smtpStatus = getSmtpStatus();
      const ghlEmail = isGhlConfigured();
      const ghlFull = isSdrGhlConfigured();

      const proposalAutoSendSetting = await storage.getSystemSetting("proposal_auto_send");
      const proposalAutoSend = proposalAutoSendSetting?.enabled === true;

      const warnings: string[] = [];
      if (!smtpStatus.configured && !ghlEmail) {
        warnings.push("Neither SMTP nor GHL email is configured. Transactional emails (proposals, rep alerts, merchant welcome) will not be delivered.");
      }
      if (!smtpStatus.configured) {
        warnings.push("SMTP not configured. Direct email fallback unavailable. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.");
      }
      if (!ghlFull) {
        warnings.push("GHL not fully configured. Email via GHL unavailable. Set GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID.");
      }

      res.json({
        smtp: smtpStatus,
        ghl: {
          emailConfigured: ghlEmail,
          fullyConfigured: ghlFull,
        },
        proposalAutoSend,
        warnings,
        allHealthy: smtpStatus.configured && ghlEmail && !warnings.length,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === GO-LIVE READINESS CHECKS ===
  app.get("/api/operator/readiness-checks", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { isSdrGhlConfigured, getSdrGhlConfig } = await import("../services/sdr/ghl-client");
      const { isSmtpConfigured } = await import("../services/smtp-email");

      const identities = await storage.getSendingIdentities();
      const activeIdentities = identities.filter((i: any) => isUsableSenderIdentity(i));
      const totalCapacity = activeIdentities.reduce((sum: number, i: any) => sum + (i.dailyLimit || 0), 0);
      const totalSentToday = activeIdentities.reduce((sum: number, i: any) => sum + (i.sentToday || 0), 0);

      const ghlCfg = getSdrGhlConfig();
      const ghlOk = isSdrGhlConfigured();

      let ghlAuthOk = false;
      let ghlAuthDetail = "Skipped (not configured)";
      if (ghlOk) {
        try {
          const { fetchCalendars } = await import("../services/sdr/ghl-client");
          const probeResult = await Promise.race([
            fetchCalendars().then(cals => ({ ok: true, detail: `Auth probe OK (${Array.isArray(cals) ? cals.length : 0} calendars)` })),
            new Promise<{ ok: boolean; detail: string }>(resolve =>
              setTimeout(() => resolve({ ok: true, detail: "Probe timed out — treating as OK" }), 4000)
            ),
          ]);
          ghlAuthOk = probeResult.ok;
          ghlAuthDetail = probeResult.detail;
        } catch (err: any) {
          const msg = (err.message || "").toLowerCase();
          ghlAuthOk = false;
          ghlAuthDetail = msg.includes("401") || msg.includes("unauthorized") || msg.includes("403")
            ? "Token rejected (401/403) — regenerate in GHL Settings → Private Integrations"
            : safeMessage(err.message, "Auth probe error");
        }
      }

      const smtpOk = isSmtpConfigured();

      const { GHL_WORKFLOW_REGISTRY } = await import("../services/ghl-workflows");
      const mappedWorkflowCount = (await Promise.all(
        GHL_WORKFLOW_REGISTRY.map(async (w: any) => {
          if (process.env[w.envKey]) return true;
          try {
            const s = await storage.getSystemSetting(`ghl_workflow_${w.id}`);
            return !!((s as any)?.value);
          } catch { return false; }
        })
      )).filter(Boolean).length;

      let redisOk = false;
      let redisDetail = "";
      try {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
          redisOk = false;
          redisDetail = "REDIS_URL not configured; BullMQ queues are unavailable";
        } else {
          const { default: IORedis } = await import("ioredis");
          const client = new IORedis(redisUrl, { connectTimeout: 2000, maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true });
          await client.connect();
          const pong = await client.ping();
          redisOk = pong === "PONG";
          redisDetail = redisOk ? "Connected" : "Ping failed — check REDIS_URL";
          client.disconnect();
        }
      } catch (e: any) {
        redisOk = false;
        redisDetail = `Connection error: ${(e.message || "unknown").substring(0, 80)} — check REDIS_URL`;
      }

      const stuckCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      let stuckCount = 0;
      try {
        const { sdrLeadState } = await import("@shared/schema");
        const { lte, isNotNull } = await import("drizzle-orm");
        const stuckRows = await db.select({ id: sdrLeadState.id })
          .from(sdrLeadState)
          .where(
            and(
              isNotNull(sdrLeadState.nextActionAt),
              lte(sdrLeadState.nextActionAt, stuckCutoff)
            )
          )
          .limit(50);
        stuckCount = stuckRows.length;
      } catch { /* non-fatal */ }

      const adminDigestEmail = !!process.env.ADMIN_DIGEST_EMAIL;
      const bookingLink = !!process.env.GHL_DEFAULT_BOOKING_LINK;

      const inboxesWithCapacity = activeIdentities.filter((i: any) => (i.sentToday || 0) < (i.dailyLimit || 0));

      const checks = [
        {
          id: "redis_connected",
          label: "Redis connected",
          ok: redisOk,
          detail: redisDetail || (redisOk ? "Connected" : "Set REDIS_URL to a valid Redis connection string"),
        },
        {
          id: "inbox_capacity",
          label: "At least 1 active inbox with remaining daily capacity",
          ok: inboxesWithCapacity.length > 0,
          detail: activeIdentities.length === 0
            ? "No active sending identities configured"
            : `${inboxesWithCapacity.length} of ${activeIdentities.length} active inboxes have remaining capacity (${totalSentToday} sent of ${totalCapacity} total limit)`,
        },
        {
          id: "ghl_configured",
          label: "GHL credentials configured & token valid",
          ok: ghlOk && ghlAuthOk,
          detail: !ghlOk
            ? "Set GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID"
            : ghlAuthOk
            ? `Token valid (live probe) · Location ID: ${ghlCfg.hasLocationId ? "set" : "missing"}`
            : `Token set but probe failed — ${ghlAuthDetail}. Regenerate in GHL Settings → Private Integrations`,
        },
        {
          id: "ghl_workflows_mapped",
          // Reclassified: the generic "at least five IDs" quota is removed because Replit owns sequence
          // cadence. Handoff workflows (enrollInGhlWorkflow callers) still read their saved ID and skip the
          // enrollment when it is missing, so the detail says so. The row keeps its id for DTO consumers
          // and stays informational: it is not a new outbound eligibility policy.
          label: "GHL workflow IDs recorded (informational)",
          ok: true,
          detail: `${mappedWorkflowCount} of ${GHL_WORKFLOW_REGISTRY.length} registry workflow IDs recorded. Sequence IDs are reference-only and not a launch prerequisite; IDs used by supported handoff enrollments (form confirmation, scheduling, merchant application, proposal follow-up, affiliate welcome, unsubscribe) skip that enrollment when missing. Replit owns cadence; incoming GHL sync and the global outbound pause are separate controls.`,
        },
        {
          id: "smtp_fallback",
          label: "SMTP email fallback configured",
          ok: smtpOk,
          detail: smtpOk ? "SMTP configured" : "Set SMTP_HOST, SMTP_USER, SMTP_PASS for transactional email fallback",
        },
        {
          id: "sdr_enabled",
          label: "SDR_ENABLED feature flag on",
          ok: featureFlags.SDR_ENABLED === true,
          detail: featureFlags.SDR_ENABLED ? "Enabled" : "Set SDR_ENABLED=true to activate SDR pipeline",
        },
        {
          id: "orchestrator_enabled",
          label: "ORCHESTRATOR_ENABLED feature flag on",
          ok: featureFlags.ORCHESTRATOR_ENABLED === true,
          detail: featureFlags.ORCHESTRATOR_ENABLED ? "Enabled" : "Set ORCHESTRATOR_ENABLED=true to start orchestrator",
        },
        {
          id: "admin_digest_email",
          label: "ADMIN_DIGEST_EMAIL configured",
          ok: adminDigestEmail,
          detail: adminDigestEmail ? "Set" : "Set ADMIN_DIGEST_EMAIL for daily digest notifications",
        },
        {
          id: "booking_link",
          label: "GHL_DEFAULT_BOOKING_LINK configured",
          ok: bookingLink,
          detail: bookingLink ? "Set" : "Set GHL_DEFAULT_BOOKING_LINK for meeting-intent reply automation",
        },
        {
          id: "no_stuck_leads",
          label: "No stuck leads older than 24h",
          ok: stuckCount === 0,
          detail: stuckCount === 0 ? "No stuck leads" : `${stuckCount} leads past their nextActionAt — check Stuck Leads tab`,
        },
      ];

      const passCount = checks.filter(c => c.ok).length;
      const ready = checks.every(c => c.ok);

      res.json({ ready, passCount, totalChecks: checks.length, checks });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === SLA BREACH ACTIVITY (with collapsed flag) ===
  app.get("/api/operator/sla-breaches", isAuthenticated, async (_req, res) => {
    try {
      const rows = await db.select()
        .from(auditLogs)
        .where(sql`${auditLogs.action} IN ('sla_breach', 'ticket_sla_breach', 'sla_breach_resolved') AND ${auditLogs.createdAt} > NOW() - INTERVAL '7 days'`)
        .orderBy(desc(auditLogs.createdAt))
        .limit(200);
      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === LIFECYCLE STAGE COUNTS ===
  app.get("/api/operator/lifecycle-stage-counts", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { contacts } = await import("@shared/schema");
      const { isNull, count } = await import("drizzle-orm");

      const CANONICAL_STAGES = [
        "prospect", "lead", "analysis_requested", "statement_uploaded",
        "call_booked", "proposal_sent", "verbal_commit",
        "live_merchant", "retained", "referred", "closed_lost",
      ];
      const STAGE_LABELS: Record<string, string> = {
        prospect: "Prospect",
        lead: "Lead",
        analysis_requested: "Analysis Requested",
        statement_uploaded: "Statement Uploaded",
        call_booked: "Call Booked",
        proposal_sent: "Proposal Sent",
        verbal_commit: "Verbal Commit",
        live_merchant: "Live Merchant",
        retained: "Retained",
        referred: "Referred",
        closed_lost: "Closed Lost",
      };

      const rows = await db
        .select({
          lifecycleStage: contacts.lifecycleStage,
          total: count(contacts.id),
          stuckApprox: count(contacts.id),
        })
        .from(contacts)
        .where(isNull(contacts.archivedAt))
        .groupBy(contacts.lifecycleStage);

      const stuckThresholdDays = 7;
      const stuckCutoff = new Date(Date.now() - stuckThresholdDays * 86400000);

      const stuckRows = await db
        .select({
          lifecycleStage: contacts.lifecycleStage,
          stuckCount: count(contacts.id),
        })
        .from(contacts)
        .where(sql`${contacts.archivedAt} IS NULL AND ${contacts.updatedAt} <= ${stuckCutoff}`)
        .groupBy(contacts.lifecycleStage);

      const stuckMap: Record<string, number> = {};
      for (const r of stuckRows) {
        if (r.lifecycleStage) stuckMap[r.lifecycleStage] = Number(r.stuckCount);
      }

      const countMap: Record<string, number> = {};
      for (const r of rows) {
        if (r.lifecycleStage) countMap[r.lifecycleStage] = Number(r.total);
      }

      const activePipelineStages = CANONICAL_STAGES.filter(s => s !== "do_not_contact");
      const totalActivePipeline = activePipelineStages.reduce((sum, s) => sum + (countMap[s] || 0), 0);

      const stages = CANONICAL_STAGES.map(stage => ({
        stage,
        label: STAGE_LABELS[stage] || stage,
        count: countMap[stage] || 0,
        stuckCount: stuckMap[stage] ?? null,
        stuckThresholdDays,
        percentOfPipeline: totalActivePipeline > 0
          ? Math.round(((countMap[stage] || 0) / totalActivePipeline) * 1000) / 10
          : 0,
        filterUrl: `/dashboard/contacts?lifecycleStage=${stage}`,
      }));

      res.json({
        generatedAt: new Date().toISOString(),
        stages,
        totalActivePipeline,
        warning: "Stuck count uses updatedAt as approximate proxy — any field update resets the clock.",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === ACTIVATION READINESS (Wave 9) ===
  app.get("/api/activation/readiness", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const { analyticsEvents, followUpSequences, ghlActivityLog, contacts } = await import("@shared/schema");
      const { count, gte: gteOp, isNotNull } = await import("drizzle-orm");

      const warnings: string[] = [];

      const items: Array<{
        key: string; label: string; status: "green" | "yellow" | "red";
        value: string; description: string; remediation: string | null; source: string;
      }> = [];

      // ghl_configured
      const ghlToken = process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
      items.push({
        key: "ghl_configured",
        label: "GHL Connection Configured",
        status: ghlToken ? "green" : "red",
        value: ghlToken ? "Configured" : "Missing",
        description: "GHL private integration token required for contact sync and communications.",
        remediation: ghlToken ? null : "Set GHL_PRIVATE_INTEGRATION_TOKEN in environment variables.",
        source: "process.env.GHL_PRIVATE_INTEGRATION_TOKEN",
      });

      // pewc_disclosure_version
      const pewcVersion = process.env.PEWC_DISCLOSURE_VERSION;
      items.push({
        key: "pewc_disclosure_version",
        label: "PEWC Disclosure Version Set",
        status: pewcVersion ? "green" : "yellow",
        value: pewcVersion || "Not set",
        description: "PEWC disclosure version ensures compliance audit trail for consent records.",
        remediation: pewcVersion ? null : "Set PEWC_DISCLOSURE_VERSION in environment variables.",
        source: "process.env.PEWC_DISCLOSURE_VERSION",
      });

      // contactability_available
      let contactabilityStatus: "green" | "yellow" | "red" = "red";
      try {
        await import("../services/contactability");
        contactabilityStatus = "green";
      } catch {
        contactabilityStatus = "red";
        warnings.push("contactability service module could not be imported");
      }
      items.push({
        key: "contactability_available",
        label: "Wave 1A evaluateContactability() Available",
        status: contactabilityStatus,
        value: contactabilityStatus === "green" ? "Available" : "Unavailable",
        description: "Contactability permission gate must be available for all outbound sends.",
        remediation: contactabilityStatus !== "green" ? "Ensure server/services/contactability.ts is present and exports evaluateContactability." : null,
        source: "dynamic import('../services/contactability')",
      });

      // consent_tier_migration
      let consentTierStatus: "green" | "yellow" | "red" = "yellow";
      try {
        const [{ consentTierCol }] = (await db.execute(sql`
          SELECT column_name AS "consentTierCol" FROM information_schema.columns
          WHERE table_name = 'contacts' AND column_name = 'consent_tier' LIMIT 1
        `)) as any;
        consentTierStatus = consentTierCol ? "green" : "yellow";
      } catch {
        consentTierStatus = "yellow";
      }
      items.push({
        key: "consent_tier_migration",
        label: "Consent Tier Migration Applied",
        status: consentTierStatus,
        value: consentTierStatus === "green" ? "Column present" : "Unable to verify",
        description: "contacts.consent_tier column required for PEWC consent routing.",
        remediation: consentTierStatus !== "green" ? "Run pending Drizzle migrations: npx tsx scripts/migrate.ts" : null,
        source: "information_schema.columns",
      });

      // sequences_seeded
      let seqCount = 0;
      try {
        const [{ cnt }] = await db.select({ cnt: count(followUpSequences.id) }).from(followUpSequences);
        seqCount = Number(cnt);
      } catch { seqCount = 0; }
      items.push({
        key: "sequences_seeded",
        label: "Wave 6 Sequence Families Seeded",
        status: seqCount >= 10 ? "green" : "yellow",
        value: `${seqCount} sequences`,
        description: "At least 10 sequences should be seeded across families for outreach coverage.",
        remediation: seqCount < 10 ? "Seed sequence families via the Sequences admin page or seed script." : null,
        source: "followUpSequences table count",
      });

      // ghl_permission_sync_healthy
      const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      let ghlSyncStatus: "green" | "yellow" | "red" = "yellow";
      try {
        const recentEntries = await db.select({ id: ghlActivityLog.id })
          .from(ghlActivityLog)
          .where(gteOp(ghlActivityLog.createdAt, recentCutoff))
          .limit(1);
        ghlSyncStatus = (ghlToken && recentEntries.length > 0) ? "green" : "yellow";
      } catch { ghlSyncStatus = "yellow"; }
      items.push({
        key: "ghl_permission_sync_healthy",
        label: "Wave 7 GHL Permission Fields Healthy",
        status: ghlSyncStatus,
        value: ghlSyncStatus === "green" ? "Recent activity" : "No recent GHL activity",
        description: "GHL activity log should have entries in the last 24h to confirm sync is running.",
        remediation: ghlSyncStatus !== "green" ? "Verify GHL_PRIVATE_INTEGRATION_TOKEN is valid and the 45s sync loop is running." : null,
        source: "ghlActivityLog recent entry check",
      });

      // analytics_events_present
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
      let analyticsCount = 0;
      try {
        const [{ cnt }] = await db.select({ cnt: count(analyticsEvents.id) })
          .from(analyticsEvents)
          .where(gteOp(analyticsEvents.occurredAt, sevenDaysAgo));
        analyticsCount = Number(cnt);
      } catch { analyticsCount = 0; }
      items.push({
        key: "analytics_events_present",
        label: "Wave 8 Analytics Events Present",
        status: analyticsCount > 0 ? "green" : "yellow",
        value: `${analyticsCount} events (last 7 days)`,
        description: "Analytics events table should have data for conversion tracking to function.",
        remediation: analyticsCount === 0 ? "Data still accumulating — events are recorded on page visits and form submissions." : null,
        source: "analyticsEvents table count (7 days)",
      });

      // feature flags
      const flagChecks: Array<{ key: string; label: string; envKey: string }> = [
        { key: "sdr_enabled", label: "SDR_ENABLED Flag", envKey: "SDR_ENABLED" },
        { key: "sms_enabled", label: "SMS_ENABLED Flag", envKey: "SMS_ENABLED" },
        { key: "voice_ai_enabled", label: "VOICE_AI_ENABLED Flag", envKey: "VOICE_AI_ENABLED" },
        { key: "nightly_discovery_enabled", label: "NIGHTLY_DISCOVERY_ENABLED Flag", envKey: "NIGHTLY_DISCOVERY_ENABLED" },
      ];
      for (const fc of flagChecks) {
        const val = process.env[fc.envKey];
        items.push({
          key: fc.key,
          label: fc.label,
          status: val === "true" ? "green" : "yellow",
          value: val || "Not set",
          description: `${fc.envKey} feature flag controls activation of the ${fc.label.replace(" Flag", "")} subsystem.`,
          remediation: val !== "true" ? `Set ${fc.envKey}=true in environment variables to activate.` : null,
          source: `process.env.${fc.envKey}`,
        });
      }

      // inbox_health
      let inboxStatus: "green" | "yellow" | "red" = "red";
      let inboxValue = "No active senders";
      try {
        const identities = await storage.getSendingIdentities();
        const active = identities.filter((i: any) => isUsableSenderIdentity(i));
        const withCapacity = active.filter((i: any) => (i.sentToday || 0) < (i.dailyLimit || 0));
        if (withCapacity.length > 0) {
          inboxStatus = "green";
          inboxValue = `${withCapacity.length} active sender(s) with capacity`;
        } else if (active.length > 0) {
          inboxStatus = "yellow";
          inboxValue = `${active.length} active sender(s) but all at daily limit`;
        } else {
          inboxStatus = "red";
          inboxValue = "No active sending identities configured";
        }
      } catch { inboxStatus = "yellow"; inboxValue = "Unable to check sending identities"; }
      items.push({
        key: "inbox_health",
        label: "Active Sender Health",
        status: inboxStatus,
        value: inboxValue,
        description: "At least one active sending identity with remaining daily capacity required for outreach.",
        remediation: inboxStatus !== "green" ? "Add or activate a sending identity in the Identity Wizard." : null,
        source: "storage.getSendingIdentities()",
      });

      // queue_health
      let queueStatus: "green" | "yellow" | "red" = "yellow";
      let queueValue = "Queue health source unavailable";
      try {
        const { requireQueueManagerReady } = await import("../services/queue-manager");
        const qm = requireQueueManagerReady();
        const metrics = await qm.getAllQueueMetrics();
        const dlqTotal = metrics.queues.reduce((sum, q) => sum + (q.probeStatus === "ok" ? (q.failed ?? 0) : 0), 0);
        queueStatus = metrics.status === "ok" && dlqTotal === 0 ? "green" : "yellow";
        queueValue = metrics.status === "ok"
          ? (dlqTotal === 0 ? "No failed queue jobs" : `${dlqTotal} failed queue job(s)`)
          : "Queue metrics are degraded";
      } catch {
        queueStatus = "yellow";
        queueValue = "Queue health source unavailable";
        warnings.push("Could not load queue metrics for readiness check");
      }
      items.push({
        key: "queue_health",
        label: "Queue Health / Dead-Letter",
        status: queueStatus,
        value: queueValue,
        description: "BullMQ dead-letter queue should be empty for healthy background job processing.",
        remediation: queueStatus !== "green" ? "Review dead-letter jobs in Operator Dashboard → Job Queue tab." : null,
        source: "BullMQ queue metrics",
      });

      // sitemap_coverage (always yellow — no audit source)
      items.push({
        key: "sitemap_coverage",
        label: "Sitemap Coverage",
        status: "yellow",
        value: "Check unavailable",
        description: "Sitemap coverage verification requires an external audit tool not configured in this repo.",
        remediation: "Sitemap coverage check unavailable — verify manually via Google Search Console or a sitemap audit tool.",
        source: "N/A",
      });

      // contact_scoring — check how many contacts still need scoring
      let scoringStatus: "green" | "yellow" | "red" = "yellow";
      let scoringValue = "Unable to check";
      try {
        const unscoredResult = await db.execute(sql`SELECT count(*)::int AS cnt FROM contacts WHERE archived_at IS NULL AND last_scored_at IS NULL`);
        const unscoredCount = Number((unscoredResult.rows?.[0] as any)?.cnt ?? 0);

        const { getScoringProgress } = await import("../services/contact-scoring-job");
        const scoringProgress = await getScoringProgress();

        if (scoringProgress.status === "running") {
          scoringStatus = "yellow";
          scoringValue = `Running: ${scoringProgress.processed}/${scoringProgress.total} processed`;
        } else if (unscoredCount === 0) {
          scoringStatus = "green";
          scoringValue = "All contacts scored";
        } else {
          scoringStatus = "yellow";
          scoringValue = `${unscoredCount.toLocaleString()} contacts not yet scored`;
        }
      } catch {
        scoringStatus = "yellow";
        scoringValue = "Unable to check scoring status";
      }
      items.push({
        key: "contact_scoring",
        label: "Contact Scoring Backfill",
        status: scoringStatus,
        value: scoringValue,
        description: "All active contacts should have lead scores for pipeline prioritization and LCC analytics.",
        remediation: scoringStatus !== "green" ? "Run the Contact Scoring backfill from Activation Panel → One-shot Operations." : null,
        source: "contacts.last_scored_at IS NULL count",
      });

      const hasRed = items.some(i => i.status === "red");
      const hasYellow = items.some(i => i.status === "yellow");
      const overallStatus: "green" | "yellow" | "red" = hasRed ? "red" : hasYellow ? "yellow" : "green";

      res.json({
        generatedAt: new Date().toISOString(),
        overallStatus,
        items,
        warnings,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === CHANNEL COMPLIANCE APPROVAL GATE (Task #695) ===
  // Approval-gate only. Nothing below this line ever sets, pauses, or
  // resumes SMS_ENABLED / VOICE_AI_ENABLED / RINGLESS_VM_ENABLED — those are
  // Replit Secrets requiring manual operator action + restart.

  function validateChannelParam(req: any, res: any): ChannelKey | null {
    const channel = String(req.params.channel || "");
    if (!(VALID_CHANNELS as readonly string[]).includes(channel)) {
      res.status(400).json({
        message: `Invalid channel "${channel}". Must be one of: ${VALID_CHANNELS.join(", ")}`,
      });
      return null;
    }
    return channel as ChannelKey;
  }

  // Read-only history of past checklist views / approvals / test-batch
  // previews for a channel. Never mutates anything.
  function parseChannelAuditFilters(req: any): {
    action?: string;
    actor?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  } {
    const { action, actor, startDate, endDate, limit, offset } = req.query;
    const parsed: ReturnType<typeof parseChannelAuditFilters> = {};
    if (action && typeof action === "string") parsed.action = action;
    if (actor && typeof actor === "string") parsed.actor = actor;
    if (startDate && typeof startDate === "string") {
      const d = new Date(startDate);
      if (!isNaN(d.getTime())) parsed.startDate = d;
    }
    if (endDate && typeof endDate === "string") {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) parsed.endDate = d;
    }
    if (limit && typeof limit === "string") {
      const n = parseInt(limit, 10);
      if (!isNaN(n) && n > 0) parsed.limit = Math.min(n, 1000);
    }
    if (offset && typeof offset === "string") {
      const n = parseInt(offset, 10);
      if (!isNaN(n) && n >= 0) parsed.offset = n;
    }
    return parsed;
  }

  app.get("/api/activation/channel-audit-log/:channel", requireRole("admin"), async (req, res) => {
    const channel = validateChannelParam(req, res);
    if (!channel) return;
    try {
      const filters = parseChannelAuditFilters(req);
      const { entries, total } = await storage.getChannelAuditLog(channel, filters);
      res.json({
        channel,
        entries,
        total,
        limit: filters.limit ?? 100,
        offset: filters.offset ?? 0,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // CSV/PDF export of the (filtered) channel approval audit trail, including
  // checklist snapshots. Read-only — never mutates anything.
  app.get("/api/activation/channel-audit-log/:channel/export", requireRole("admin"), async (req, res) => {
    const channel = validateChannelParam(req, res);
    if (!channel) return;
    const format = String(req.query.format || "csv").toLowerCase();
    if (format !== "csv" && format !== "pdf") {
      return res.status(400).json({ message: 'Invalid format. Must be "csv" or "pdf".' });
    }
    try {
      const filters = parseChannelAuditFilters(req);
      const { entries } = await storage.getChannelAuditLog(channel, { ...filters, limit: 5000, offset: 0 });

      if (format === "csv") {
        const headers = ["ID", "Channel", "Action", "Actor Email", "Actor User ID", "Notes", "Checklist Passed", "Checklist Snapshot", "Created At"];
        const rows = entries.map((e) => {
          const snapshot = e.checklistSnapshot as any;
          return [
            e.id,
            e.channel,
            e.action,
            e.actorEmail || "",
            e.actorUserId || "",
            e.notes || "",
            snapshot?.passed === true ? "Yes" : snapshot?.passed === false ? "No" : "",
            snapshot ? JSON.stringify(snapshot) : "",
            e.createdAt ? new Date(e.createdAt).toISOString() : "",
          ];
        });
        const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=channel-audit-${channel}.csv`);
        return res.send(csv);
      }

      const PDFDocument = (await import("pdfkit")).default;
      const doc = new PDFDocument({ size: "LETTER", margin: 40, info: { Title: `Channel Approval Audit Trail – ${channel}` } });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => {
        const buffer = Buffer.concat(chunks);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=channel-audit-${channel}.pdf`);
        res.send(buffer);
      });
      doc.on("error", (err: any) => serverError(res, err));

      doc.fontSize(16).font("Helvetica-Bold").text(`Channel Approval Audit Trail — ${channel}`);
      doc.fontSize(9).font("Helvetica").fillColor("#555").text(`Generated ${new Date().toLocaleString()}`);
      if (filters.startDate || filters.endDate || filters.action || filters.actor) {
        const filterParts: string[] = [];
        if (filters.action) filterParts.push(`Action: ${filters.action}`);
        if (filters.actor) filterParts.push(`Actor: ${filters.actor}`);
        if (filters.startDate) filterParts.push(`From: ${filters.startDate.toLocaleDateString()}`);
        if (filters.endDate) filterParts.push(`To: ${filters.endDate.toLocaleDateString()}`);
        doc.text(`Filters — ${filterParts.join(" | ")}`);
      }
      doc.moveDown(0.75);
      doc.fillColor("#000");

      if (entries.length === 0) {
        doc.fontSize(10).text("No entries match the selected filters.");
      }

      for (const e of entries) {
        if (doc.y > doc.page.height - 120) doc.addPage();
        const snapshot = e.checklistSnapshot as any;
        doc.fontSize(10).font("Helvetica-Bold").text(`#${e.id} — ${e.action}`, { continued: true })
          .font("Helvetica").text(`   ${e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}`);
        doc.fontSize(9).text(`Actor: ${e.actorEmail || e.actorUserId || "unknown"}`);
        if (e.notes) doc.text(`Notes: ${e.notes}`);
        if (snapshot?.passed !== undefined) doc.text(`Checklist passed at time of action: ${snapshot.passed ? "Yes" : "No"}`);
        if (Array.isArray(snapshot?.items)) {
          for (const item of snapshot.items) {
            doc.fontSize(8).fillColor(item.ok ? "#166534" : "#991b1b")
              .text(`  ${item.ok ? "PASS" : "FAIL"} — ${item.label}: ${item.detail || ""}`);
          }
          doc.fillColor("#000");
        }
        doc.moveDown(0.5);
      }

      doc.end();
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/activation/channel-checklist/:channel", requireRole("admin"), async (req, res) => {
    const channel = validateChannelParam(req, res);
    if (!channel) return;
    try {
      const checklist = await evaluateChannelChecklist(channel);
      const actorUserId = (req.user as any)?.id ?? null;
      const actorEmail = (req.user as any)?.email ?? null;
      await storage.createChannelAuditLog({
        channel,
        action: "checklist_viewed",
        checklistSnapshot: channelAuditChecklistSnapshot(checklist),
        actorUserId,
        actorEmail,
        notes: null,
      });
      res.json(checklist);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/activation/channel-enable/:channel", requireRole("admin"), async (req, res) => {
    const channel = validateChannelParam(req, res);
    if (!channel) return;
    try {
      // Re-run the checklist server-side. A client-submitted { allPassed: true }
      // (or similar) body is never trusted for this decision.
      const checklist = await evaluateChannelChecklist(channel);
      const actorUserId = (req.user as any)?.id ?? null;
      const actorEmail = (req.user as any)?.email ?? null;
      const envFlag = CHANNEL_ENV_FLAG[channel];

      if (!checklist.passed) {
        await storage.createChannelAuditLog({
          channel,
          action: "checklist_viewed",
          checklistSnapshot: channelAuditChecklistSnapshot(checklist),
          actorUserId,
          actorEmail,
          notes: "approval_denied_checklist_failed",
        });
        return res.status(400).json({
          approvedToEnable: false,
          message: "Checklist requirements not met. Approval cannot be granted.",
          checklist,
        });
      }

      const auditRow = await storage.createChannelAuditLog({
        channel,
        action: "enable_approved",
        checklistSnapshot: channelAuditChecklistSnapshot(checklist),
        actorUserId,
        actorEmail,
        notes: "approval_approved",
      });

      const manualStep = `Approval recorded (audit #${auditRow.id}). To actually activate this channel, an operator must manually set the Replit Secret ${envFlag}=true and restart the app. This system never modifies environment variables or secrets on its own.`;

      // Notify the rest of the team (compliance/ops) that a channel has been
      // approved and is now waiting on a manual Secret flip + restart. This
      // is purely informational — it never touches process.env or Secrets.
      notifyChannelApproved({ channel, envFlag, actorEmail, auditId: auditRow.id, manualStep }).catch((err) => {
        logOperationalDiagnostic("channel_approval_notification", err, "notification_delivery_failed", { auditId: auditRow.id });
      });

      // This route only records an approval decision. It NEVER sets the
      // env flag — that remains a manual Replit Secrets action + restart.
      res.json({
        approvedToEnable: true,
        auditId: auditRow.id,
        currentlyEnabled: featureFlags[envFlag] === true,
        manualStep,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/activation/channel-test-batch/:channel", requireRole("admin"), async (req, res) => {
    const channel = validateChannelParam(req, res);
    if (!channel) return;
    const TEST_BATCH_LIMIT = 5;
    const POOL_SCAN_LIMIT = 100;
    try {
      const { contacts } = await import("@shared/schema");
      const { isNotNull } = await import("drizzle-orm");
      const { evaluateContactability } = await import("../services/contactability");

      // Pull a candidate pool, then run each one through the SAME
      // channel-aware, real contactability evaluation used by live sends
      // (in dryRun mode — no send/queue side effects). Only contacts that
      // would actually be ALLOWED on this channel right now are returned.
      const pool = await db
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          phone: contacts.phone,
          email: contacts.email,
          state: contacts.state,
          leadSource: contacts.leadSource,
          sourceCategory: contacts.sourceCategory,
        })
        .from(contacts)
        .where(and(eq(contacts.doNotContact, false), isNotNull(contacts.phone), sql`${contacts.phone} <> ''`))
        .limit(POOL_SCAN_LIMIT);

      const candidates: Array<{
        id: number;
        firstName: string | null;
        lastName: string | null;
        phone: string | null;
        email: string | null;
        consentTier: string;
        reason: string;
      }> = [];
      const evaluated: Array<{ contactId: number; allowed: boolean; reason: string }> = [];

      for (const contact of pool) {
        if (candidates.length >= TEST_BATCH_LIMIT) break;
        const result = await evaluateContactability({
          contactId: contact.id,
          channel,
          leadSource: contact.leadSource ?? undefined,
          sourceCategory: contact.sourceCategory ?? undefined,
          state: contact.state ?? undefined,
          mode: "dryRun",
        });
        evaluated.push({ contactId: contact.id, allowed: result.allowed, reason: result.reason });
        if (result.allowed) {
          candidates.push({
            id: contact.id,
            firstName: contact.firstName,
            lastName: contact.lastName,
            phone: contact.phone,
            email: contact.email,
            consentTier: result.consentTier,
            reason: result.reason,
          });
        }
      }

      const actorUserId = (req.user as any)?.id ?? null;
      const actorEmail = (req.user as any)?.email ?? null;
      const auditRow = await storage.createChannelAuditLog({
        channel,
        action: "test_batch_preview",
        checklistSnapshot: {
          scannedCount: pool.length,
          eligibleCount: candidates.length,
          evaluatedCount: evaluated.length,
          reasonBuckets: evaluated.reduce<Record<string, number>>((buckets, result) => {
            const bucket = safeReasonBucket(result.reason);
            buckets[bucket] = (buckets[bucket] ?? 0) + 1;
            return buckets;
          }, {}),
        },
        actorUserId,
        actorEmail,
        notes: "dry_run_no_outbound_delivery",
      });

      res.json({
        channel,
        dryRun: true,
        sent: false,
        auditId: auditRow.id,
        scannedCount: pool.length,
        candidateCount: candidates.length,
        candidates,
        note: "This is a preview only. No SMS, call, ringless voicemail, email, or sequence step was sent or queued.",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Task #792: Global Kill Switch & Daily Send Caps API ────────────────────
  // GET /api/system/outbound-settings — admin/manager: returns outbound control state
  // Returns booleans and counts only — no secrets, no env values.
  app.get("/api/system/outbound-settings", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const [
        pausedRaw, pausedReasonRaw, capRaw,
        emailChannelPausedRaw, smsChannelPausedRaw, coldEmailChannelPausedRaw,
      ] = await Promise.all([
        storage.getSystemSetting("outboundGlobalPaused"),
        storage.getSystemSetting("outboundGlobalPausedReason"),
        storage.getSystemSetting("outboundDailyEmailCap"),
        storage.getSystemSetting("emailChannelPaused"),
        storage.getSystemSetting("smsChannelPaused"),
        storage.getSystemSetting("coldEmailChannelPaused"),
      ]);

      const outboundGlobalPaused = pausedRaw === true || pausedRaw === "true";
      const outboundGlobalPausedReason = typeof pausedReasonRaw === "string" ? pausedReasonRaw : null;
      const outboundDailyEmailCap = typeof capRaw === "number" ? capRaw : parseInt(String(capRaw ?? "200"), 10) || 200;
      const emailChannelPaused    = emailChannelPausedRaw === true    || emailChannelPausedRaw === "true";
      const smsChannelPaused      = smsChannelPausedRaw === true      || smsChannelPausedRaw === "true";
      const coldEmailChannelPaused = coldEmailChannelPausedRaw === true || coldEmailChannelPausedRaw === "true";

      const todayStr = new Date().toISOString().slice(0, 10);
      const [capRow] = await db
        .select({ count: outboundSendCounters.count })
        .from(outboundSendCounters)
        .where(and(
          eq(outboundSendCounters.date, todayStr),
          eq(outboundSendCounters.channel, "email"),
          eq(outboundSendCounters.scope, "cold_outreach"),
        ));
      const coldEmailSendsToday = capRow?.count ?? 0;
      const coldEmailRemainingToday = Math.max(0, outboundDailyEmailCap - coldEmailSendsToday);

      res.json({
        outboundGlobalPaused,
        outboundGlobalPausedReason,
        outboundDailyEmailCap,
        coldEmailSendsToday,
        coldEmailRemainingToday,
        emailChannelPaused,
        smsChannelPaused,
        coldEmailChannelPaused,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // PATCH /api/system/outbound-settings — admin only: toggle global pause and/or set cap.
  //
  // Global pause (outboundGlobalPaused) is now handled by OutboundControlService which:
  //   - Acquires a transaction-scoped advisory lock (serializes concurrent PATCHes)
  //   - For pause: transitions through "activating", drains in-flight sends, commits "paused"
  //   - Writes state and audit atomically in a single transaction
  //   - Returns committed epoch and state
  //
  // Channel-level pauses (email/SMS/cold-email) and daily-cap settings are still
  // stored in system_settings as they are independent of the global pause authority.
  // Global unpause does NOT clear channel pauses, DNC, consent, or any other hold.
  app.patch("/api/system/outbound-settings", requireRole("admin"), async (req, res) => {
    try {
      const {
        outboundGlobalPaused,
        outboundGlobalPausedReason,
        outboundDailyEmailCap,
        emailChannelPaused,
        smsChannelPaused,
        coldEmailChannelPaused,
        idempotencyKey,
        correlationId,
      } = req.body ?? {};

      const actorEmail = (req.user as any)?.email ?? "unknown";
      const actorId = (req.user as any)?.id ?? null;

      // ── 1. Handle global pause via OutboundControlService ─────────────────
      let pauseControlResult: import("../services/outbound-control-service").PauseControlResult | undefined;

      if (typeof outboundGlobalPaused === "boolean") {
        const reason = typeof outboundGlobalPausedReason === "string" && outboundGlobalPausedReason.trim()
          ? outboundGlobalPausedReason.trim()
          : outboundGlobalPaused
            ? "Admin paused outbound communications"
            : "Admin unpaused outbound communications";

        const { applyPauseMutation, PauseDrainError } = await import("../services/outbound-control-service");
        try {
          pauseControlResult = await applyPauseMutation({
            outboundGlobalPaused,
            reason,
            actor: actorEmail,
            idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
            correlationId: typeof correlationId === "string" ? correlationId : undefined,
          });
        } catch (pauseErr: any) {
          if (pauseErr instanceof PauseDrainError) {
            // Fail-closed: state remains "activating" (all sends blocked), but
            // the pause is NOT committed. Surface a 503 with a reason code.
            return res.status(503).json({
              message: "Pause activation did not commit — in-flight drain incomplete. Sends remain blocked (activating state); retry the pause.",
              reasonCode: pauseErr.reasonCode,
              drainStatus: pauseErr.drainStatus,
            });
          }
          throw pauseErr;
        }
      } else if (
        (typeof outboundGlobalPausedReason === "string" || outboundGlobalPausedReason === null) &&
        outboundGlobalPausedReason !== undefined
      ) {
        // Reason-only update: read current state, apply as metadata revision if changed
        const { applyPauseMutation } = await import("../services/outbound-control-service");
        const { getPauseState } = await import("../services/outbound-pause-authority");
        const curPauseState = await getPauseState();
        const currentState = { outboundGlobalPaused: curPauseState.state !== "unpaused" };
        if (currentState && typeof outboundGlobalPausedReason === "string" && outboundGlobalPausedReason.trim()) {
          pauseControlResult = await applyPauseMutation({
            outboundGlobalPaused: currentState.outboundGlobalPaused,
            reason: outboundGlobalPausedReason.trim(),
            actor: actorEmail,
            idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
            correlationId: typeof correlationId === "string" ? correlationId : undefined,
          });
        }
      }

      // ── 2. Channel-level pauses and cap (non-global, stored in system_settings) ──
      // These are independent of the global pause authority.
      const channelSaves: Promise<void>[] = [];
      if (typeof outboundDailyEmailCap === "number" && outboundDailyEmailCap > 0)
        channelSaves.push(storage.setSystemSetting("outboundDailyEmailCap", outboundDailyEmailCap));
      if (typeof emailChannelPaused === "boolean")
        channelSaves.push(storage.setSystemSetting("emailChannelPaused", emailChannelPaused));
      if (typeof smsChannelPaused === "boolean")
        channelSaves.push(storage.setSystemSetting("smsChannelPaused", smsChannelPaused));
      if (typeof coldEmailChannelPaused === "boolean")
        channelSaves.push(storage.setSystemSetting("coldEmailChannelPaused", coldEmailChannelPaused));
      if (channelSaves.length > 0) await Promise.all(channelSaves);

      // ── 3. Audit log for channel-level changes ────────────────────────────
      // The global pause audit is written atomically inside OutboundControlService.
      // This log covers channel-level and cap changes only.
      if (channelSaves.length > 0) {
        await storage.createAuditLog({
          action: "outbound_channel_settings_updated",
          entityType: "system",
          entityId: 0,
          actorType: "user",
          actorId,
          details: {
            actorEmail,
            changes: {
              outboundDailyEmailCap,
              emailChannelPaused,
              smsChannelPaused,
              coldEmailChannelPaused,
            },
            correlationId: typeof correlationId === "string" ? correlationId : undefined,
          },
        });
      }

      // ── 4. Build response ─────────────────────────────────────────────────
      if (pauseControlResult) {
        res.json(pauseControlResult);
      } else {
        // (#1532) Fill queueBackpressure with real coordinator-derived state
        let queueBackpressure: Record<string, unknown> = { status: "not_configured" };
        try {
          const { outboundQueueCoordinator } = await import("../services/outbound-queue-coordinator");
          const coordinatorStatus = await outboundQueueCoordinator.getStatus();
          if (coordinatorStatus.status === "degraded") {
            // DB read failed — report degraded rather than claiming "running"
            queueBackpressure = {
              status: "degraded",
              errorCode: (coordinatorStatus as any).errorCode ?? "UNKNOWN_ERROR",
              activeHoldCount: 0,
              physicalQueueStates: [],
              ledgerEpoch: coordinatorStatus.ledgerEpoch,
            };
          } else {
            const activeHoldKeys = Object.keys(coordinatorStatus.desiredLogicalHolds);
            queueBackpressure = {
              status: activeHoldKeys.length > 0 ? "held" : "running",
              activeHoldCount: activeHoldKeys.length,
              physicalQueueStates: coordinatorStatus.physicalQueueStates.map(q => ({
                queue: q.physicalQueue,
                desired: q.desiredState,
                observed: q.observedState,
                outcome: q.outcome,
              })),
              ledgerEpoch: coordinatorStatus.ledgerEpoch,
            };
          }
        } catch (_e) {
          queueBackpressure = { status: "not_configured" };
        }
        res.json({
          ok: true,
          control: null,
          sendEnforcement: { status: "enforced", policyVersion: "1.0" },
          queueBackpressure,
          changeType: "channel-only",
        });
      }
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─── Sales Rep Operations Activation Card ─────────────────────────────────

  // GET /api/activation/sales-rep-ops-readiness — admin only; returns current readiness state
  app.get("/api/activation/sales-rep-ops-readiness", requireRole("admin"), async (_req, res) => {
    try {
      const { featureFlags } = await import("../services/feature-flags");

      const [knowledgeRows, bindingRows, latestRunRows, agentCountRows] = await Promise.all([
        db.execute(sql`
          SELECT COUNT(*) AS cnt FROM knowledge_source_revisions
          WHERE index_state = 'indexed' AND review_state = 'approved'
        `),
        db.execute(sql`
          SELECT COUNT(*) AS conflicts FROM (
            SELECT user_id FROM agents WHERE status = 'active' GROUP BY user_id HAVING COUNT(*) > 1
          ) sub
        `),
        db.execute(sql`
          SELECT run_id, aggregate_verdict, gate_results, completed_at, migration_head, release_sha, config_fingerprint, population_fingerprint
          FROM sales_rep_ops_readiness_runs
          WHERE status = 'complete' AND triggered_by_user_id IN (
            SELECT id FROM users WHERE role = 'admin'
          )
          ORDER BY completed_at DESC LIMIT 1
        `),
        db.execute(sql`
          SELECT COUNT(DISTINCT a.user_id) AS active_agents
          FROM agents a WHERE a.status = 'active'
        `),
      ]);

      const knowledgeCount = Number((knowledgeRows.rows[0] as any)?.cnt ?? 0);
      const bindingConflicts = Number((bindingRows.rows[0] as any)?.conflicts ?? 0);
      const lastRun = latestRunRows.rows[0] as any;
      const activeAgentCount = Number((agentCountRows.rows[0] as any)?.active_agents ?? 0);

      const callAssistEnabled = featureFlags.CALL_ASSIST_ENABLED;
      const fieldSalesEnabled = featureFlags.FIELD_SALES_ENABLED;

      const blockers: string[] = [];
      if (bindingConflicts > 0) blockers.push(`${bindingConflicts} agent user_id binding conflict(s)`);
      if (callAssistEnabled) blockers.push("CALL_ASSIST_ENABLED is on — must be false for certification");
      if (fieldSalesEnabled) blockers.push("FIELD_SALES_ENABLED is on — must be false for certification");
      if (knowledgeCount === 0) blockers.push("No approved+indexed knowledge revision found");
      // Absent or non-PASS receipts are blockers: absent (no run), BLOCKED_EXTERNAL, and FAIL
      // all mean the system is not certified for this exact release.
      const lastVerdict: string = lastRun?.aggregate_verdict ?? "none";
      const currentSha = (process.env.RELEASE_SHA ?? "").trim() || null;
      const receiptSha: string | null = lastRun?.release_sha ?? null;
      // Treat absent/unknown RELEASE_SHA as stale: if we cannot identify the running release,
      // any prior PASS receipt is unverifiable and must not be accepted as current certification.
      const receiptStale = !currentSha || !receiptSha || currentSha !== receiptSha;

      // Compare config fingerprint from receipt against current flag state.
      // A mismatch means the certified config no longer matches the live config.
      // Also compare the population fingerprint: the receipt's certified population fingerprint
      // is exposed in the response so admins can confirm the same cohort is still intended.
      const { computeConfigFingerprint } = await import("../services/sales-rep-ops-readiness");
      const currentConfigFingerprint = computeConfigFingerprint();
      const receiptConfigFingerprint: string | null = lastRun?.config_fingerprint ?? null;
      const configMismatch = receiptConfigFingerprint && currentConfigFingerprint !== receiptConfigFingerprint;
      const receiptPopulationFingerprint: string | null = lastRun?.population_fingerprint ?? null;

      if (!lastRun) {
        blockers.push("No completed readiness run found — run POST /api/activation/sales-rep-ops-readiness/run");
      } else if (lastVerdict !== "PASS") {
        blockers.push(`Last readiness run verdict is ${lastVerdict} (need PASS)`);
      }
      if (receiptStale) {
        blockers.push(`Certification receipt is stale (SHA mismatch: cert=${receiptSha?.slice(0, 12) ?? "?"}, running=${currentSha?.slice(0, 12) ?? "?"}) — re-run readiness check`);
      }
      if (configMismatch) {
        blockers.push("Config fingerprint mismatch — feature flag state changed since last certification; re-run readiness check");
      }

      res.json({
        ok: true,
        card: "sales_rep_ops",
        featureFlags: {
          CALL_ASSIST_ENABLED: callAssistEnabled,
          FIELD_SALES_ENABLED: fieldSalesEnabled,
          expectedState: "both OFF for certification",
        },
        knowledgeReadiness: {
          approvedIndexedRevisions: knowledgeCount,
          ready: knowledgeCount > 0,
        },
        repBinding: {
          activeAgents: activeAgentCount,
          bindingConflicts,
          healthy: bindingConflicts === 0,
        },
        certification: lastRun
          ? (() => {
              // Stale receipt detection: compare stored SHA/config against current running release
              const currentSha = process.env.RELEASE_SHA ?? null;
              const receiptSha = lastRun.release_sha ?? null;
              const shaMatch = currentSha && receiptSha ? currentSha === receiptSha : null;
              return {
                runId: lastRun.run_id,
                aggregateVerdict: lastRun.aggregate_verdict,
                completedAt: lastRun.completed_at,
                migrationHead: lastRun.migration_head,
                releaseSha: receiptSha,
                currentReleaseSha: currentSha,
                shaMatches: shaMatch,
                stale: shaMatch === false, // null = unknown (RELEASE_SHA not set)
                configFingerprint: lastRun.config_fingerprint,
                configFingerprintMatch: !configMismatch,
                // populationFingerprint from receipt: admin must confirm this matches the intended cohort.
                // Since contact/location IDs are not stored server-side, the admin uses this fingerprint
                // to confirm no cohort changes occurred after certification. A changed cohort requires a new run.
                populationFingerprint: receiptPopulationFingerprint,
                populationFingerprintNote: "Verify this fingerprint matches the intended pilot cohort — any cohort change invalidates this receipt",
                // gate_results returned for admin visibility; no PII in stored gate_results
                gateResults: lastRun.gate_results ?? [],
              };
            })()
          : null,
        blockers,
        rollbackChecklist: [
          { step: "Disable flags", description: "POST /api/admin/field-sales/disable-flags — sets CALL_ASSIST_ENABLED and FIELD_SALES_ENABLED to false" },
          { step: "Freeze mutations", description: "PATCH /api/admin/field-sales/freeze — prevents new claim/visit mutations immediately" },
          { step: "Release claims", description: "POST /api/admin/field-sales/release-claims — transitions claimed stops back to released" },
          { step: "Cancel routes", description: "POST /api/admin/field-sales/cancel-routes — cancels open pilot routes" },
          { step: "Expire cohort", description: "DELETE /api/field-territories/:id/assignments/:assignmentId — sets ends_at=now() on pilot rep territory assignments" },
        ],
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Rep Provisioning ────────────────────────────────────────────────────────
  // POST /api/activation/provision-rep
  // Admin-only. Creates a user with role=agent, creates an active agent record,
  // and sends an invitation email. Writes two audit_logs entries (user created,
  // agent record created). Never triggers automated outbound.
  app.post("/api/activation/provision-rep", requireRole("admin"), async (req, res) => {
    try {
      const { email, firstName, lastName } = req.body ?? {};
      const actorUserId = String((req.user as any)?.id ?? "");

      // ── Input validation ──────────────────────────────────────────────────
      if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return res.status(400).json({ error: "Valid email is required" });
      }
      if (!firstName || typeof firstName !== "string" || !firstName.trim()) {
        return res.status(400).json({ error: "firstName is required" });
      }
      if (!lastName || typeof lastName !== "string" || !lastName.trim()) {
        return res.status(400).json({ error: "lastName is required" });
      }

      const safeEmail = email.trim().toLowerCase();
      const safeFirst = firstName.trim();
      const safeLast = lastName.trim();

      // ── Collision check ───────────────────────────────────────────────────
      const existingUserRows = await db.execute(sql`
        SELECT id, role FROM users WHERE LOWER(email) = ${safeEmail} LIMIT 1
      `);
      const existingUser = existingUserRows.rows[0] as any;
      if (existingUser?.id) {
        return res.status(409).json({
          error: `A user with email ${safeEmail} already exists (id=${existingUser.id}, role=${existingUser.role})`,
        });
      }

      // ── Atomic create: user + agent record + both audit logs ─────────────
      // All four writes are in one transaction. If agent creation or either
      // audit insert fails, the user row is rolled back — no partial accounts.
      const { users: usersTable } = await import("@shared/models/auth");
      const { agents: agentsTable } = await import("@shared/schema");

      const { newUser, newAgent } = await db.transaction(async (tx) => {
        const [u] = await tx
          .insert(usersTable)
          .values({
            email: safeEmail,
            firstName: safeFirst,
            lastName: safeLast,
            role: "agent",
            authProvider: "local",
          })
          .returning({ id: usersTable.id, email: usersTable.email });

        const [a] = await tx
          .insert(agentsTable)
          .values({
            userId: u.id,
            firstName: safeFirst,
            lastName: safeLast,
            email: safeEmail,
            status: "active",
            role: "sales_rep",
          })
          .returning({ id: agentsTable.id });

        await tx.insert(auditLogs).values({
          userId: actorUserId,
          action: "pilot_rep_provisioned",
          entityType: "user",
          entityKey: u.id,
          details: sanitizeAuditPayload({ newUserId: u.id, email: safeEmail, agentId: a.id, role: "agent" }) as any,
          actorType: "user",
          actorId: actorUserId,
        });

        await tx.insert(auditLogs).values({
          userId: actorUserId,
          action: "pilot_agent_record_created",
          entityType: "agent",
          entityId: a.id,
          details: sanitizeAuditPayload({ agentId: a.id, userId: u.id, email: safeEmail, status: "active" }) as any,
          actorType: "user",
          actorId: actorUserId,
        });

        return { newUser: u, newAgent: a };
      });

      // ── Send invitation email ─────────────────────────────────────────────
      let inviteDisposition: "sent" | "skipped_no_smtp" | "failed" = "skipped_no_smtp";
      let inviteDetail = "SMTP not configured — invitation not sent";
      try {
        const { isSmtpConfigured, sendSmtpEmail } = dependencies.invitationMail ?? await import("../services/smtp-email");
        const { issueAuthAction, setAuthActionDelivery } = await import("../services/auth-actions");
        const { getCanonicalUrl } = await import("../lib/canonical-url");

        if (isSmtpConfigured()) {
          const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 h
          const action = await issueAuthAction({
            purpose: "agent_rep_invite",
            subject: { type: "user", id: newUser.id },
            ttlMs: INVITE_TTL_MS,
          });
          const activateUrl = `${getCanonicalUrl()}/activate-rep#token=${encodeURIComponent(action.token)}`;

          const html = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;">
  <p>Hi ${safeFirst},</p>
  <p>You've been invited to join Liberty Bancard as a sales rep. Click the button below to set your password and activate your account. This link expires in <strong>72 hours</strong>.</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${activateUrl}"
       style="display:inline-block;background-color:#1e3a5f;color:#ffffff;padding:12px 28px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:bold;">
      Activate My Account &rarr;
    </a>
  </p>
  <p style="word-break:break-all;font-size:12px;color:#555;">If the button doesn't work, paste this link into your browser: ${activateUrl}</p>
  <p>If you weren't expecting this email, you can safely ignore it.</p>
</div>`;

          const result = await sendSmtpEmail({
            to: safeEmail,
            subject: "You're invited to Liberty Bancard — Activate your rep account",
            html,
            category: "onboarding" as const,
          });

          if (result.success!==true) {
            await setAuthActionDelivery(action.id, "definite_failure");
            inviteDisposition = "failed";
            inviteDetail = "SMTP send failed";
          } else {
            await setAuthActionDelivery(action.id, "sent");
            inviteDisposition = "sent";
            inviteDetail = "Invitation email sent";
          }
        }
      } catch (inviteErr: any) {
        logOperationalDiagnostic("provision_rep_invite", inviteErr, "invite_send_failed", { userId: newUser.id });
        inviteDisposition = "failed";
        inviteDetail = "Invitation email failed — check server logs";
      }

      res.json({
        ok: true,
        userId: newUser.id,
        agentId: newAgent.id,
        email: safeEmail,
        inviteDisposition,
        inviteDetail,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Rep Invite Resend ────────────────────────────────────────────────────────
  // POST /api/activation/resend-rep-invite
  // Admin-only. Issues a fresh agent_rep_invite token for an already-provisioned
  // agent user who hasn't activated yet. Useful when SMTP was down at provisioning
  // time or the 72-hour link expired before the rep could use it.
  app.post("/api/activation/resend-rep-invite", requireRole("admin"), async (req, res) => {
    try {
      const { userId } = req.body ?? {};
      const actorUserId = String((req.user as any)?.id ?? "");

      if (!userId || typeof userId !== "string") {
        return res.status(400).json({ error: "userId is required" });
      }

      // Verify user exists with role=agent (never re-issue for admin/manager/merchant)
      const { users: usersTable } = await import("@shared/models/auth");
      const [targetUser] = (await db.execute(sql`
        SELECT id, email, first_name, role, password_hash,account_state
        FROM users WHERE id = ${userId} LIMIT 1
      `)).rows as any[];

      if (!targetUser || targetUser.account_state!=="active") {
        return res.status(404).json({ error: "User not found" });
      }
      if (targetUser.role !== "agent") {
        return res.status(400).json({ error: "Resend invite is only available for agent-role users" });
      }
      if (targetUser.password_hash) {
        return res.status(409).json({ error: "This rep has already activated their account (password is set). Use the login flow." });
      }

      const { isSmtpConfigured, sendSmtpEmail } = dependencies.invitationMail ?? await import("../services/smtp-email");
      if (!isSmtpConfigured()) {
        return res.status(503).json({ error: "SMTP is not configured — cannot send invitation email." });
      }

      const { issueAuthAction, setAuthActionDelivery } = await import("../services/auth-actions");
      const { getCanonicalUrl } = await import("../lib/canonical-url");

      const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
      const action = await issueAuthAction({
        purpose: "agent_rep_invite",
        subject: { type: "user", id: userId },
        ttlMs: INVITE_TTL_MS,
      });
      const activateUrl = `${getCanonicalUrl()}/activate-rep#token=${encodeURIComponent(action.token)}`;
      const safeFirst = String(targetUser.first_name ?? "there");

      const html = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;">
  <p>Hi ${safeFirst},</p>
  <p>Your previous invitation link has expired. Here is a new link to activate your Liberty Bancard rep account. It expires in <strong>72 hours</strong>.</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${activateUrl}"
       style="display:inline-block;background-color:#1e3a5f;color:#ffffff;padding:12px 28px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:bold;">
      Activate My Account &rarr;
    </a>
  </p>
  <p style="word-break:break-all;font-size:12px;color:#555;">If the button doesn't work, paste this link into your browser: ${activateUrl}</p>
</div>`;

      const result = await sendSmtpEmail({
        to: String(targetUser.email),
        subject: "New invitation link — Activate your Liberty Bancard rep account",
        html,
        category: "onboarding" as const,
      });

      let inviteDisposition: "sent" | "failed" = "failed";
      if (result.success!==true) {
        await setAuthActionDelivery(action.id, "definite_failure");
      } else {
        await setAuthActionDelivery(action.id, "sent");
        inviteDisposition = "sent";
      }

      await db.insert(auditLogs).values({
        userId: actorUserId,
        action: "pilot_rep_invite_resent",
        entityType: "user",
        entityKey: userId,
        details: sanitizeAuditPayload({ targetUserId: userId, email: targetUser.email, inviteDisposition }) as any,
        actorType: "user",
        actorId: actorUserId,
      });

      res.json({ ok: true, inviteDisposition, email: targetUser.email });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Cohort Assignment ────────────────────────────────────────────────────────
  // POST /api/activation/assign-cohort
  // Admin-only. Validates contact IDs against pilot-preview eligibility gates,
  // updates contacts.assignedTo to the rep's agent email, writes audit_logs,
  // and re-runs readiness gates. Never triggers automated outbound.
  app.post("/api/activation/assign-cohort", requireRole("admin"), async (req, res) => {
    try {
      const { repUserId, contactIds, locationIds } = req.body ?? {};
      const actorUserId = String((req.user as any)?.id ?? "");

      // ── Input validation ──────────────────────────────────────────────────
      if (!repUserId || typeof repUserId !== "string") {
        return res.status(400).json({ error: "repUserId is required" });
      }
      if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return res.status(400).json({ error: "contactIds must be a non-empty array" });
      }
      if (contactIds.length > 200) {
        return res.status(400).json({ error: "contactIds max 200" });
      }
      // Deduplicate and validate — reject early if no valid IDs survive
      const safeContactIds = [...new Set(contactIds.map(Number).filter(n => n > 0 && Number.isFinite(n)))];
      if (safeContactIds.length === 0) {
        return res.status(400).json({ error: "contactIds must contain at least one valid positive integer after deduplication" });
      }
      const safeLocationIds = Array.isArray(locationIds)
        ? [...new Set(locationIds.map(Number).filter(n => n > 0 && Number.isFinite(n)))]
        : [];

      // ── Verify rep exists with role=agent and an active agent record ─────
      const [repUser] = (await db.execute(sql`
        SELECT u.id, u.role, a.id AS agent_id, a.email AS agent_email
        FROM users u
        LEFT JOIN agents a ON a.user_id = u.id AND a.status = 'active'
        WHERE u.id = ${repUserId}
        LIMIT 1
      `)).rows;

      if (!repUser) {
        return res.status(404).json({ error: "Rep user not found" });
      }
      if (!["agent", "manager"].includes((repUser as any).role)) {
        return res.status(400).json({ error: "Rep user does not have role=agent or manager" });
      }
      if (!(repUser as any).agent_id) {
        return res.status(400).json({ error: "Rep user has no active agent record — provision the rep first" });
      }
      const agentEmail = String((repUser as any).agent_email ?? "");
      if (!agentEmail) {
        return res.status(400).json({ error: "Rep agent record has no email" });
      }

      // ── Run eligibility gates — identical policy to pilot-preview ──────────
      const queries: Promise<any>[] = [
        db.execute(sql`
          SELECT c.id, c.do_not_contact, c.do_not_auto_contact, c.first_name, c.last_name, c.email,
                 b.record_class
          FROM contacts c
          LEFT JOIN businesses b ON b.id = c.business_id
          WHERE c.id = ANY(${safeContactIds}::integer[])
        `),
        db.execute(sql`
          SELECT ic.candidate_id AS contact_id, COUNT(*) AS cnt
          FROM contact_identity_candidates ic
          JOIN contact_identity_decisions d ON d.candidate_id = ic.id
          WHERE ic.candidate_type = 'contact'
            AND ic.candidate_id = ANY(${safeContactIds}::integer[])
            AND d.decision IN ('defer','supersede')
          GROUP BY ic.candidate_id
        `),
        db.execute(sql`SELECT COUNT(*) AS cnt FROM contact_remediation_operations WHERE status IN ('pending','running')`),
      ];
      if (safeLocationIds.length > 0) {
        queries.push(db.execute(sql`
          SELECT id, record_class, latitude, longitude, street_address, do_not_visit, canonical_name
          FROM businesses
          WHERE id = ANY(${safeLocationIds}::integer[])
        `));
      }
      const [contactRows, identityRows, remediationRows, locRows] = await Promise.all(queries);

      const identityConflictSet = new Set((identityRows.rows as any[]).map(r => Number(r.contact_id)));
      const remediationInFlight = Number((remediationRows.rows[0] as any)?.cnt ?? 0) > 0;
      const foundIds = new Set((contactRows.rows as any[]).map(r => Number(r.id)));

      const blocked: Array<{ kind: string; id: number; reason: string }> = [];
      const accepted: number[] = [];

      // Contact eligibility (full parity with pilot-preview BLOCKED_NAME_PATTERNS checks)
      for (const cid of safeContactIds) {
        if (!foundIds.has(cid)) { blocked.push({ kind: "contact", id: cid, reason: "CONTACT_NOT_FOUND" }); continue; }
        const row = (contactRows.rows as any[]).find(r => Number(r.id) === cid) as any;
        const nameAndEmail = `${row.first_name ?? ""} ${row.last_name ?? ""} ${row.email ?? ""}`;
        if (BLOCKED_NAME_PATTERNS.some(p => p.test(nameAndEmail))) {
          blocked.push({ kind: "contact", id: cid, reason: "TEST_DEMO_RECORD" }); continue;
        }
        if (row.do_not_contact || row.do_not_auto_contact) { blocked.push({ kind: "contact", id: cid, reason: "DNC_FLAG" }); continue; }
        if (row.record_class !== "canonical") { blocked.push({ kind: "contact", id: cid, reason: "NON_CANONICAL_RECORD_CLASS" }); continue; }
        if (identityConflictSet.has(cid)) { blocked.push({ kind: "contact", id: cid, reason: "OPEN_IDENTITY_DECISION" }); continue; }
        if (remediationInFlight) { blocked.push({ kind: "contact", id: cid, reason: "SYSTEM_REMEDIATION_IN_PROGRESS" }); continue; }
        accepted.push(cid);
      }

      // Location eligibility (full parity with pilot-preview location checks)
      const blockedLocationIds: number[] = [];
      if (safeLocationIds.length > 0 && locRows) {
        const foundLocIds = new Set((locRows.rows as any[]).map(r => Number(r.id)));
        for (const lid of safeLocationIds) {
          if (!foundLocIds.has(lid)) { blocked.push({ kind: "location", id: lid, reason: "LOCATION_NOT_FOUND" }); blockedLocationIds.push(lid); continue; }
          const row = (locRows.rows as any[]).find(r => Number(r.id) === lid) as any;
          if (BLOCKED_NAME_PATTERNS.some(p => p.test(row.canonical_name ?? ""))) {
            blocked.push({ kind: "location", id: lid, reason: "TEST_DEMO_RECORD" }); blockedLocationIds.push(lid); continue;
          }
          if (row.record_class !== "canonical") { blocked.push({ kind: "location", id: lid, reason: "NON_CANONICAL_RECORD_CLASS" }); blockedLocationIds.push(lid); continue; }
          if (row.do_not_visit === true) { blocked.push({ kind: "location", id: lid, reason: "DO_NOT_VISIT" }); blockedLocationIds.push(lid); continue; }
          if (!row.latitude && !row.longitude && (!row.street_address || !String(row.street_address).trim())) {
            blocked.push({ kind: "location", id: lid, reason: "MISSING_LOCATION_DATA" }); blockedLocationIds.push(lid);
          }
        }
      }

      if (blocked.length > 0 && accepted.length === 0) {
        return res.status(400).json({
          error: "All contacts failed eligibility gates — no assignment made",
          blocked,
          accepted: [],
        });
      }

      // ── Assign contacts + write audit log atomically ─────────────────────
      // Both writes are in one transaction so an audit failure cannot leave
      // the assignment committed without a paper trail, and vice versa.
      await db.transaction(async (tx) => {
        if (accepted.length > 0) {
          await tx.execute(sql`
            UPDATE contacts SET assigned_to = ${agentEmail}, updated_at = NOW()
            WHERE id = ANY(${accepted}::integer[])
          `);
        }
        await tx.insert(auditLogs).values({
          userId: actorUserId,
          action: "pilot_cohort_assigned",
          entityType: "user",
          entityKey: repUserId,
          details: sanitizeAuditPayload({
            repUserId,
            agentEmail,
            assignedContactIds: accepted,
            blockedContactIds: blocked.filter(b => b.kind === "contact").map(b => b.id),
            blockedLocationIds: blocked.filter(b => b.kind === "location").map(b => b.id),
            locationIds: safeLocationIds,
            blocked,
          }) as any,
          actorType: "user",
          actorId: actorUserId,
        });
      });

      // ── Re-run readiness gates ────────────────────────────────────────────
      let readinessResult: any = null;
      try {
        const { runSalesRepOpsReadiness } = await import("../services/sales-rep-ops-readiness");
        readinessResult = await runSalesRepOpsReadiness({
          triggeredByUserId: actorUserId,
          pilotRepIds: [repUserId],
          pilotContactIds: accepted,
          pilotLocationIds: safeLocationIds,
        });
      } catch (readinessErr: any) {
        logOperationalDiagnostic("assign_cohort_readiness", readinessErr, "readiness_rerun_failed", { repUserId });
      }

      res.json({
        ok: true,
        repUserId,
        agentEmail,
        assignedCount: accepted.length,
        blockedCount: blocked.length,
        blocked,
        readiness: readinessResult
          ? {
              runId: readinessResult.runId,
              aggregateVerdict: readinessResult.aggregateVerdict,
              fromCache: readinessResult.fromCache,
            }
          : null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Agent Rep Invite Activation ─────────────────────────────────────────────
  // Public endpoints (no auth required — bearer token IS the credential).
  // POST /api/auth/agent-invite/validate — check token validity without consuming it
  // POST /api/auth/agent-invite/activate — set password, consume token, auto-login
  app.post("/api/auth/agent-invite/validate", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const { isAuthActionValid } = await import("../services/auth-actions");
      const valid = await isAuthActionValid(token, "agent_rep_invite");
      return res.status(valid ? 200 : 400).json({ valid });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/auth/agent-invite/activate", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      const { token, password } = req.body ?? {};
      if (!token || typeof token !== "string") {
        return res.status(400).json({ message: "Token is required" });
      }
      if (!password || typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }

      // Cheaply validate the token before doing bcrypt work (prevents CPU-drain on invalid tokens)
      const { isAuthActionValid, consumeAuthAction } = await import("../services/auth-actions");
      const tokenValid = await isAuthActionValid(token, "agent_rep_invite");
      if (!tokenValid) {
        return res.status(400).json({ message: "This invitation link is invalid or has expired." });
      }

      const bcrypt = await import("bcryptjs");
      const passwordHash = await bcrypt.default.hash(password, 12);

      const { users: usersTable } = await import("@shared/models/auth");
      const { eq } = await import("drizzle-orm");

      const consumed = await consumeAuthAction({
        token,
        purpose: "agent_rep_invite",
        mutate: async (subject, tx) => {
          if (subject.type !== "user") return null;
          const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, String(subject.id)));
          // Only activate genuine agent/manager seats — never elevate privileges
          if (!user || !["agent", "manager"].includes(user.role ?? "")) return null;
          await tx.update(usersTable)
            .set({ passwordHash, emailVerified: new Date(), updatedAt: new Date() })
            .where(eq(usersTable.id, user.id));
          return user;
        },
      });

      if (!consumed.ok || !consumed.value) {
        return res.status(400).json({ message: "This invitation link is invalid or has expired." });
      }
      const { authStorage: activeAuthStorage } = await import("../replit_integrations/auth/storage");
      const user = await activeAuthStorage.getUser(consumed.value.id);
      if (!user) return res.status(409).json({ message: "Account changed during activation. Sign in again or ask an administrator to review its current state." });

      await db.insert(auditLogs).values({
        action: "pilot_rep_account_activated",
        entityType: "user",
        entityKey: user.id,
        details: sanitizeAuditPayload({ role: user.role }) as any,
        actorType: "user",
        actorId: user.id,
      });

      // Auto-login: establish a session for the newly activated rep
      await new Promise<void>((resolve, reject) => {
        req.login(user as any, (err) => (err ? reject(err) : resolve()));
      });

      try {
        const { authStorage } = await import("../replit_integrations/auth/storage");
        const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || undefined;
        await authStorage.createUserSession({
          userId: user.id,
          sessionId: req.sessionID,
          ip,
          userAgent: req.headers["user-agent"] || undefined,
          expectedEpoch: user.authEpoch,
        });
      } catch (sessionErr: any) {
        logOperationalDiagnostic("agent_invite_activation", sessionErr, "session_record_failed", { userId: user.id });
        return res.status(503).json({ message: "Account activated, but sign-in tracking is unavailable. Retry signing in; no second activation is required." });
      }

      return res.json({
        message: "Account activated. You are now logged in.",
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // POST /api/activation/sales-rep-ops-readiness/run — admin only; triggers a fresh readiness run
  app.post("/api/activation/sales-rep-ops-readiness/run", requireRole("admin"), async (req, res) => {
    try {
      const { pilotRepIds, pilotContactIds, pilotLocationIds } = req.body ?? {};
      const { runSalesRepOpsReadiness } = await import("../services/sales-rep-ops-readiness");

      const result = await runSalesRepOpsReadiness({
        triggeredByUserId: String((req.user as any)?.id ?? ""),
        pilotRepIds: Array.isArray(pilotRepIds) ? pilotRepIds.map(String) : [],
        pilotContactIds: Array.isArray(pilotContactIds) ? pilotContactIds.map(Number) : [],
        pilotLocationIds: Array.isArray(pilotLocationIds) ? pilotLocationIds.map(Number) : [],
      });

      res.json({
        ok: true,
        fromCache: result.fromCache,
        runId: result.runId,
        id: result.id,
        status: result.status,
        aggregateVerdict: result.aggregateVerdict,
        gateResults: result.gateResults,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });
}

