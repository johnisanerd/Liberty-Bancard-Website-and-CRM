import { storage } from "../storage";
import { createHash, randomUUID } from "crypto";
import type { Prospect, Campaign, Contact, CampaignStep } from "@shared/schema";
import OpenAI from "openai";
import { isGhlConfigured } from "./ghl";
import { sanitizeFirstName } from "./contact-name-utils";
import { getEmailSignatureHtml, type EmailSignature } from "./email-signatures";
import { sendSmtpEmail, isSmtpConfigured } from "./smtp-email";
import { logAiCall } from "./ai-audit-logger";
import { evaluateContactability, evaluateContactDecisions } from "./contactability";
import { READINESS_MODEL_VERSION } from "./contact-readiness";
import { hashEmailToken } from "./provider-readiness-control";
import { db } from "../db";
import { campaignPreviews, campaignPreviewMembers, campaignQueueItems, campaignQueueRuns, outboundMessages, contacts } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  CR04_POLICY_VERSION,
  evaluateCr04ChannelQualification,
} from "./cr04-cohort-ready-authority";
import { decideCr06PromotionalLifecycle } from "./cr06-promotional-lifecycle-decision";

// Deliberately not an environment flag: CR-04 permanently retires the mutable
// legacy selectors. Kept as a function so TypeScript still checks their dead
// implementation while static scans can prove both entry points fail closed.
function legacyCampaignQueueDisabled(): boolean {
  return true;
}

// ZeroBounce statuses that are undeliverable — contacts with these are skipped without queuing.
/**
 * Lazy ZeroBounce validation for a CRM contact before queuing a campaign email.
 * Returns false if the contact should be skipped (and logs the reason).
 * Returns true if the send is safe to proceed.
 *
 * Structured in isolated phases so that audit-write failures cannot alter the
 * block decision:
 *  Phase 1  — fast-path checks (already-bad or already-validated status)
 *  Phase 2  — budget / credit-claim gate (fail-closed for unvalidated contacts)
 *  Phase 3  — ZeroBounce API call (fail-closed: provider failure defers batch)
 *  Phase 4  — best-effort DB writeback (failure does not affect block decision)
 *  Phase 5  — capture shouldBlock BEFORE any audit I/O
 *  Phase 6  — best-effort audit writes in their own isolated try/catch
 *  Return   — based on shouldBlock, independent of audit success
 *
 * Exported for direct unit-testing; not part of the public API surface.
 * Pass `_deps` to inject mocked ZB functions in tests.
 */
export async function passesZeroBounceCheck(
  contact: { id: number; email: string | null; emailStatus?: string | null },
  _campaignId: number,
): Promise<boolean> {
  // BT-10 authority: outbound paths consume current durable evidence only.
  // Missing/stale evidence schedules the recoverable validation intent; this
  // compatibility helper never performs a paid validation itself.
  const { evaluateMarketingEmailEligibility, enqueueCurrentValidationIntent } = await import("./provider-readiness-control");
  const durableDecision = await evaluateMarketingEmailEligibility(contact.id);
  if (!durableDecision.allowed) {
    await enqueueCurrentValidationIntent(contact.id).catch(() => {});
    return false;
  }
  return true;
}

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
}

const DEFAULT_QUEUE_LIMIT = 2000;
const SEND_INTERVAL_MS = 45000;

async function generatePersonalizedEmail(
  prospect: Prospect,
  campaign: Campaign,
  stepSubject: string,
  stepBody: string,
  stepNumber: number
): Promise<{ subject: string; body: string }> {
  const mergeFields: Record<string, string> = {
    "{{first_name}}": sanitizeFirstName(prospect.ownerFirstName) || "there",
    "{{last_name}}": prospect.ownerLastName || "",
    "{{company_name}}": prospect.companyName || "your business",
    "{{vertical}}": prospect.vertical || "your industry",
    "{{city}}": prospect.city || "",
    "{{state}}": prospect.state || "",
  };

  let subject = stepSubject;
  let body = stepBody;

  for (const [key, value] of Object.entries(mergeFields)) {
    subject = subject.replace(new RegExp(key.replace(/[{}]/g, "\\$&"), "g"), value);
    body = body.replace(new RegExp(key.replace(/[{}]/g, "\\$&"), "g"), value);
  }

  if (campaign.aiPersonalization) {
    try {
      const prompt = `You are a B2B outreach email writer for Liberty Bancard, a merchant payment processing company. Personalize this email for maximum engagement.

Prospect Info:
- Company: ${prospect.companyName || "Unknown"}
- Industry: ${prospect.vertical || "Unknown"}
- Location: ${prospect.city || ""} ${prospect.state || ""}
- Estimated Revenue: ${prospect.estimatedRevenue || "Unknown"}
- Score: ${prospect.score || "Unknown"}

Email Template:
Subject: ${subject}
Body: ${body}

Step ${stepNumber} of ${campaign.totalSteps || 3} in sequence.
${stepNumber > 1 ? "This is a follow-up email. Keep it shorter and reference the previous outreach." : ""}

Rules:
- Keep it professional but conversational
- Do NOT promise savings or specific pricing
- Include compliance line: "Eligibility, underwriting, card brand rules, and applicable laws apply."
- Keep subject under 60 characters
- Keep body under 200 words
- Do not use emojis

Return JSON: { "subject": "...", "body": "..." }`;

      const campaignMessages = [{ role: "user" as const, content: prompt }];
      const { completion: response, flagged: campFlagged, reviewQueueId: campReviewId } = await logAiCall(
        { triggerType: "outbound-copy", actorType: "system", rawPrompt: JSON.stringify(campaignMessages) },
        () => getOpenAI().chat.completions.create({
          model: "gpt-4o-mini",
          messages: campaignMessages,
          response_format: { type: "json_object" },
        })
      );

      if (campFlagged) {
        console.warn(`[AI Governance] Campaign personalization flagged (reviewQueueId=${campReviewId}) — using unmodified template to prevent low-confidence outbound send`);
        return { subject, body };
      }

      const content = response.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        return { subject: parsed.subject || subject, body: parsed.body || body };
      }
    } catch (err) {
      console.error("AI personalization failed, using template:", err);
    }
  }

  return { subject, body };
}

// Contact-native personalization for CRM-targeted campaigns.
// Separate from generatePersonalizedEmail (which takes a Prospect)
// so the contact path never silently falls through to prospect logic.
async function generateContactCampaignEmail(
  contact: Contact,
  campaign: Campaign,
  stepSubject: string,
  stepBody: string,
  stepNumber: number
): Promise<{ subject: string; body: string }> {
  const mergeFields: Record<string, string> = {
    "{{first_name}}": sanitizeFirstName(contact.firstName) || "there",
    "{{last_name}}": contact.lastName || "",
    "{{company_name}}": contact.companyName || "your business",
    "{{vertical}}": contact.vertical || "your industry",
    "{{city}}": contact.city || "",
    "{{state}}": contact.state || "",
  };

  let subject = stepSubject;
  let body = stepBody;

  for (const [key, value] of Object.entries(mergeFields)) {
    subject = subject.replace(new RegExp(key.replace(/[{}]/g, "\\$&"), "g"), value);
    body = body.replace(new RegExp(key.replace(/[{}]/g, "\\$&"), "g"), value);
  }

  if (campaign.aiPersonalization) {
    try {
      const prompt = `You are a B2B outreach email writer for Liberty Bancard, a merchant payment processing company. Personalize this email for maximum engagement.

Contact Info:
- First Name: ${contact.firstName || "Unknown"}
- Company: ${contact.companyName || "Unknown"}
- Industry: ${contact.vertical || contact.industry || "Unknown"}
- Location: ${contact.city || ""} ${contact.state || ""}

Email Template:
Subject: ${subject}
Body: ${body}

Step ${stepNumber} of ${campaign.totalSteps || 3} in sequence.
${stepNumber > 1 ? "This is a follow-up email. Keep it shorter and reference the previous outreach." : ""}

Rules:
- Keep it professional but conversational
- Do NOT promise savings or specific pricing
- Include compliance line: "Eligibility, underwriting, card brand rules, and applicable laws apply."
- Keep subject under 60 characters
- Keep body under 200 words
- Do not use emojis

Return JSON: { "subject": "...", "body": "..." }`;

      const msgs = [{ role: "user" as const, content: prompt }];
      const { completion: response, flagged, reviewQueueId } = await logAiCall(
        { triggerType: "outbound-copy", actorType: "system", rawPrompt: JSON.stringify(msgs) },
        () => getOpenAI().chat.completions.create({
          model: "gpt-4o-mini",
          messages: msgs,
          response_format: { type: "json_object" },
        })
      );

      if (flagged) {
        console.warn(`[AI Governance] Contact campaign personalization flagged (reviewQueueId=${reviewQueueId}) — using template`);
        return { subject, body };
      }

      const content = response.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        return { subject: parsed.subject || subject, body: parsed.body || body };
      }
    } catch (err) {
      console.error("AI personalization failed for contact, using template:", err);
    }
  }

  return { subject, body };
}

export async function queueCampaignMessages(campaignId: number, maxToQueue?: number): Promise<number> {
  const campaign = await storage.getCampaign(campaignId);
  if (!campaign || campaign.status !== "active") return 0;

  const steps = await storage.getCampaignSteps(campaignId);
  if (steps.length === 0) return 0;
  if (legacyCampaignQueueDisabled()) throw new Error("CR04_FROZEN_PREVIEW_REQUIRED");

  const prospects = campaign.targetListId
    ? await storage.getProspects(campaign.targetListId)
    : [];

  const prospectsData = (prospects as any).data ?? prospects;
  const eligibleProspects = (prospectsData as any[]).filter((p: any) =>
    p.status !== "do_not_contact" &&
    !p.doNotContact &&
    p.email &&
    (campaign.targetScores?.length === 0 || !campaign.targetScores || campaign.targetScores.includes(p.score || ""))
  );

  let queued = 0;
  const now = new Date();
  const limit = maxToQueue ?? DEFAULT_QUEUE_LIMIT;
  const existingMessages = await storage.getOutboundMessages(campaignId);

  for (const prospect of eligibleProspects) {
    if (queued >= limit) break;

    const prospectMessages = existingMessages.filter(m => m.prospectId === prospect.id);
    const completedSteps = prospectMessages.filter(m => m.status === "sent" || m.status === "delivered");

    const nextStepIndex = completedSteps.length;
    if (nextStepIndex >= steps.length) continue;

    const hasReplied = prospectMessages.some(m => m.status === "replied");
    if (hasReplied) continue;

    const step = steps[nextStepIndex];
    const hasPending = prospectMessages.some(m =>
      m.stepId === step.id && (m.status === "queued" || m.status === "scheduled" || m.status === "sent" || m.status === "delivered")
    );
    if (hasPending) continue;

    const lastSent = prospectMessages
      .filter(m => m.sentAt)
      .sort((a, b) => new Date(b.sentAt!).getTime() - new Date(a.sentAt!).getTime())[0];

    if (lastSent && step.delayDays) {
      const delayMs = step.delayDays * 24 * 60 * 60 * 1000;
      if (now.getTime() - new Date(lastSent.sentAt!).getTime() < delayMs) continue;
    }

    // ── Contactability gate for prospects with a linked CRM contact ───────────
    if (prospect.contactId) {
      const { authorizeCommercialUse } = await import("./commercial-resolution");
      const commercial = await authorizeCommercialUse({
        subjectType: "contact", subjectId: prospect.contactId, effect: "marketing_outreach",
      });
      if (!commercial.effectiveDecision.allowed) continue;
      const gate = await evaluateContactability({
        contactId: prospect.contactId,
        channel: "email",
        campaignType: "marketing_campaign",
        mode: "enforcement",
      });
      if (!gate.allowed) {
        await storage.createAuditLog({
          actorType: "system",
          action: "campaign_queue_blocked_contactability",
          entityType: "contact",
          entityId: prospect.contactId,
          details: { reason: gate.reason, campaignId, prospectId: prospect.id },
        });
        continue; // Do NOT create the outbound_messages row.
      }
    }

    const scheduledFor = new Date(now.getTime() + queued * SEND_INTERVAL_MS);

    await storage.createOutboundMessage({
      campaignId,
      prospectId: prospect.id,
      stepId: step.id,
      channel: step.channel || "email",
      subject: step.subject || "",
      body: step.bodyTemplate || "",
      status: "queued",
      scheduledFor,
    });

    queued++;
  }

  return queued;
}

// CRM contact-mode queuing: targets CRM contacts by vertical/completeness.
// evaluateContactability() is called BEFORE every outbound_messages row creation — kill line.
// SQL page size for paginated traversals — large enough to get meaningful
// vertical matches per page, small enough to avoid memory pressure.
const QUEUE_SQL_PAGE = 1000;


export async function queueContactCampaignMessages(campaignId: number, maxToQueue?: number): Promise<number> {
  const campaign = await storage.getCampaign(campaignId);
  if (!campaign || campaign.status !== "active") return 0;

  const steps = await storage.getCampaignSteps(campaignId);
  if (steps.length === 0) return 0;
  if (legacyCampaignQueueDisabled()) throw new Error("CR04_FROZEN_PREVIEW_REQUIRED");

  // Hard caps: DEFAULT_QUEUE_LIMIT (2000) per call, dailySendLimit per day.
  const batchCap = Math.min(maxToQueue ?? DEFAULT_QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT);
  const dailyLimit = campaign.dailySendLimit ?? 200;

  const existingMessages = await storage.getOutboundMessages(campaignId);

  // Count already-committed messages today for daily limit enforcement.
  // Includes: (1) sent/delivered today (sentAt >= todayStart), (2) already-queued
  // messages (will be sent imminently), (3) scheduled messages for today.
  // Including queued/scheduled prevents double-enqueuing on repeated queue calls
  // before any sends have occurred.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const todaySentCount = existingMessages.filter(m => {
    if (m.status === "queued") return true; // already in queue, will be sent
    if (m.status === "scheduled" && m.scheduledFor) {
      const sf = new Date(m.scheduledFor).getTime();
      return sf >= todayStart.getTime() && sf < todayEnd.getTime();
    }
    if ((m.status === "sent" || m.status === "delivered") && m.sentAt) {
      return new Date(m.sentAt).getTime() >= todayStart.getTime();
    }
    return false;
  }).length;

  const remainingDailyBudget = dailyLimit - todaySentCount;
  if (remainingDailyBudget <= 0) return 0;

  const effectiveLimit = Math.min(batchCap, remainingDailyBudget);

  // Index existing messages by contactId for O(1) lookup during traversal.
  const messagesByContact = new Map<number, typeof existingMessages>();
  for (const m of existingMessages) {
    if (!messagesByContact.has(m.contactId!)) {
      messagesByContact.set(m.contactId!, []);
    }
    messagesByContact.get(m.contactId!)!.push(m);
  }

  let queued = 0;
  let sqlOffset = 0;
  const now = new Date();

  // True paginated traversal — iterate through the entire contactable pool
  // using SQL-level OFFSET pages until the daily limit is reached or all
  // contacts have been visited.
  // Apply the same readiness filter at queue time as at preview time so contacts
  // with null/stale/below-threshold scores never enter the outbound queue silently.
  const queueReadinessThreshold = campaign.readinessThreshold ?? null;
  // Apply the filter whenever a threshold is explicitly configured (even 0 = "must have a valid score").
  // Null means "no readiness filter" — do not conflate with 0.
  const applyQueueReadiness = queueReadinessThreshold !== null;

  while (queued < effectiveLimit) {
    const page = await storage.getContactsForCampaignAudience({
      verticals: campaign.targetVerticals ?? undefined,
      offset: sqlOffset,
      limit: QUEUE_SQL_PAGE,
      ...(applyQueueReadiness ? {
        readinessThreshold: queueReadinessThreshold,
        readinessModelVersion: READINESS_MODEL_VERSION,
      } : {}),
    });

    if (page.length === 0) break; // exhausted the contactable pool

    for (const contact of page) {
      if (queued >= effectiveLimit) break;

      const contactMessages = messagesByContact.get(contact.id) ?? [];
      const completedSteps = contactMessages.filter(m => m.status === "sent" || m.status === "delivered");

      const nextStepIndex = completedSteps.length;
      if (nextStepIndex >= steps.length) continue;

      const hasReplied = contactMessages.some(m => m.status === "replied");
      if (hasReplied) continue;

      // Duplicate prevention: skip if already queued/scheduled for same step.
      const step = steps[nextStepIndex];
      const hasPending = contactMessages.some(m =>
        m.stepId === step.id && (m.status === "queued" || m.status === "scheduled" || m.status === "sent" || m.status === "delivered")
      );
      if (hasPending) continue;

      const lastSent = contactMessages
        .filter(m => m.sentAt)
        .sort((a, b) => new Date(b.sentAt!).getTime() - new Date(a.sentAt!).getTime())[0];

      if (lastSent && step.delayDays) {
        const delayMs = step.delayDays * 24 * 60 * 60 * 1000;
        if (now.getTime() - new Date(lastSent.sentAt!).getTime() < delayMs) continue;
      }

      // ── KILL LINE: contactability gate BEFORE row creation ────────────────────
      const { authorizeCommercialUse } = await import("./commercial-resolution");
      const commercial = await authorizeCommercialUse({
        subjectType: "contact", subjectId: contact.id, effect: "marketing_outreach",
      });
      if (!commercial.effectiveDecision.allowed) continue;
      // Task #1956 Step 8: data-hygiene dimension catches DBPR-family lineage
      // and identifier gaps the consent-tier gate below does not check.
      const hygiene = await evaluateContactDecisions({ contactId: contact.id, businessId: (contact as any).businessId ?? null });
      if (hygiene.dataHygiene.status === "blocked") {
        await storage.createAuditLog({
          actorType: "system",
          action: "campaign_queue_blocked_data_hygiene",
          entityType: "contact",
          entityId: contact.id,
          details: { reasonCodes: hygiene.dataHygiene.reasonCodes, campaignId },
        });
        continue;
      }
      const gate = await evaluateContactability({
        contactId: contact.id,
        channel: "email",
        campaignType: "marketing_campaign",
        mode: "enforcement",
      });
      if (!gate.allowed) {
        await storage.createAuditLog({
          actorType: "system",
          action: "campaign_queue_blocked_contactability",
          entityType: "contact",
          entityId: contact.id,
          details: { reason: gate.reason, campaignId },
        });
        continue; // Do NOT create the outbound_messages row.
      }

      // ── ZeroBounce validation gate ─────────────────────────────────────────
      const zbOk = await passesZeroBounceCheck(contact, campaignId);
      if (!zbOk) continue; // audit log already written by passesZeroBounceCheck

      const scheduledFor = new Date(now.getTime() + queued * SEND_INTERVAL_MS);

      await storage.createOutboundMessage({
        campaignId,
        contactId: contact.id,
        stepId: step.id,
        channel: step.channel || "email",
        subject: step.subject || "",
        body: step.bodyTemplate || "",
        status: "queued",
        scheduledFor,
      });

      queued++;
    }

    // Advance SQL offset by full page size regardless of how many passed the
    // JS vertical filter — ensures we never revisit the same SQL rows.
    sqlOffset += QUEUE_SQL_PAGE;
  }

  return queued;
}

// ---------------------------------------------------------------------------
// Targeting hash — a short fingerprint of campaign audience criteria.
// If any of these change between preview and queue, the preview is invalidated.
// ---------------------------------------------------------------------------

// computeTargetingHash fingerprints all fields that materially affect which
// contacts are reached and what they receive:
//   - target mode: verticals + targetListId (audience scope)
//   - step content: subject + body + channel + delayDays per step (what is sent)
// If ANY of these change after a preview, the hash differs and queueing is blocked.
// Daily send limits are NOT included — they affect rate, not audience validity.
// Criteria Snapshot contract: queue re-runs the same frozen criteria with live
// contactability rechecked immediately before each row is inserted.
// New or changed contacts may cause the queued count to differ from the preview
// eligible count; the queue endpoint always reports both.
export function computeTargetingHash(campaign: Campaign, steps: CampaignStep[]): string {
  const stepDigest = [...steps]
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((s) => [s.stepOrder, s.subject ?? "", s.bodyTemplate ?? "", s.channel ?? "", s.delayDays ?? 0].join("|"))
    .join("\n");
  const payload = JSON.stringify({
    verticals: [...(campaign.targetVerticals ?? [])].sort(),
    targetListId: campaign.targetListId ?? null,
    stepHash: createHash("sha256").update(stepDigest).digest("hex").slice(0, 12),
    // Phase 2: readiness threshold and model version are part of the audience criteria.
    // Any change to either invalidates the prior preview.
    readinessThreshold: campaign.readinessThreshold ?? null,
    readinessModelVersion: READINESS_MODEL_VERSION,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// Preview expiry window: 1 hour from completion.
const PREVIEW_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Async preview state — DB-backed, restart-safe.
// On server restart, any 'running' previews are marked 'interrupted' by
// storage.markInterruptedCampaignPreviews() called in server/index.ts.
// ---------------------------------------------------------------------------

export type CampaignPreviewResult = {
  eligibleCount: number;
  sampleContacts: Array<{ id: number; name: string; email: string; vertical: string | null }>;
  totalInVerticals: number;
  blockedCount: number;
  blockReasons: Record<string, number>;
  // Phase 2: readiness category breakdown
  excludedByReadiness: number;
  readinessSubReasons: { null_score: number; stale_score: number; below_threshold: number };
  blockedByContactability: number;
  alreadyQueued: number;
  queueable: number;
  readinessThreshold: number | null;
  readinessModelVersionUsed: number;
  /** Internal-only frozen members. Never returned by the preview API. */
  _eligibleMembers?: Array<{ contactId: number; subjectGeneration: number; tokenHash: string; subjectMutationAt: Date | null; commercialResolutionSnapshotId?: string; cr04DecisionId: string; dependencyFingerprint: string }>;
};

export async function getCampaignPreviewState(campaignId: number): Promise<{
  status: "idle" | "running" | "done" | "error" | "interrupted";
  previewId?: number;
  result?: CampaignPreviewResult;
  error?: string;
}> {
  const preview = await storage.getLatestCampaignPreview(campaignId);
  if (!preview) return { status: "idle" };
  // Phase 2: read the four audience categories from the first-class readinessBreakdown
  // column (not from __ magic-key entries inside blockReasons).
  const rbd = preview.readinessBreakdown as Record<string, any> | null | undefined;
  const result: CampaignPreviewResult | undefined = preview.status === "done" ? {
    eligibleCount: preview.eligibleCount ?? 0,
    sampleContacts: (preview.sampleContacts as CampaignPreviewResult["sampleContacts"]) ?? [],
    totalInVerticals: preview.totalInVerticals ?? 0,
    blockedCount: preview.blockedCount ?? 0,
    blockReasons: (preview.blockReasons as Record<string, number>) ?? {},
    excludedByReadiness: rbd?.excludedByReadiness ?? 0,
    readinessSubReasons: rbd?.readinessSubReasons ?? { null_score: 0, stale_score: 0, below_threshold: 0 },
    blockedByContactability: rbd?.blockedByContactability ?? 0,
    alreadyQueued: rbd?.alreadyQueued ?? 0,
    queueable: rbd?.queueable ?? 0,
    readinessThreshold: rbd?.readinessThreshold ?? null,
    readinessModelVersionUsed: rbd?.readinessModelVersionUsed ?? READINESS_MODEL_VERSION,
  } : undefined;
  return {
    status: preview.status as "idle" | "running" | "done" | "error" | "interrupted",
    previewId: preview.id,
    result,
    error: preview.status === "error" ? ((preview.blockReasons as any)?.__error ?? "Preview failed") : undefined,
  };
}

// Preview the CRM contact audience without queuing.
// Phase 2: Reports four distinct categories:
//   1. excludedByReadiness: score NULL, stale, or below threshold
//   2. blockedByContactability: failed the contactability gate
//   3. alreadyQueued: already has a queued/sent message for step 1
//   4. queueable: passed all gates
// Call startCampaignPreviewAsync() to run this in the background; poll
// getCampaignPreviewState() for completion.
export async function previewContactCampaignAudience(campaignId: number, snapshotMaxContactId?: number): Promise<CampaignPreviewResult> {
  const campaign = await storage.getCampaign(campaignId);
  if (!campaign) {
    return {
      eligibleCount: 0, sampleContacts: [], totalInVerticals: 0, blockedCount: 0, blockReasons: {},
      excludedByReadiness: 0, readinessSubReasons: { null_score: 0, stale_score: 0, below_threshold: 0 },
      blockedByContactability: 0, alreadyQueued: 0, queueable: 0,
      readinessThreshold: null, readinessModelVersionUsed: READINESS_MODEL_VERSION, _eligibleMembers: [],
    };
  }

  const readinessThreshold = campaign.readinessThreshold ?? null;
  // Apply the filter whenever a threshold is explicitly configured (even 0 = "must have a valid score").
  // Null means "no readiness filter" — do not conflate with 0.
  const applyReadiness = readinessThreshold !== null;

  // ── Step 1: DB-level denominator — total contacts in target verticals ────────
  const totalInVerticals = await storage.countContactsForCampaignAudience({
    verticals: campaign.targetVerticals ?? undefined,
  });

  // ── Step 2: SQL aggregate — readiness exclusion counts (no per-contact JS) ───
  // A single aggregate query produces all three buckets. Contacts never receive
  // a readiness_null_score/stale/below_threshold key in contactability blockReasons;
  // the counts live only in readinessSubReasons.
  let excludedByReadiness = 0;
  const readinessSubReasons = { null_score: 0, stale_score: 0, below_threshold: 0 };
  if (applyReadiness) {
    const breakdown = await storage.getReadinessCategoryBreakdown({
      verticals: campaign.targetVerticals ?? undefined,
      readinessThreshold,
      readinessModelVersion: READINESS_MODEL_VERSION,
    });
    readinessSubReasons.null_score = breakdown.nullScore;
    readinessSubReasons.stale_score = breakdown.staleScore;
    readinessSubReasons.below_threshold = breakdown.belowThreshold;
    excludedByReadiness = breakdown.nullScore + breakdown.staleScore + breakdown.belowThreshold;
  }

  // ── Step 3: Index already-queued contacts from existing messages ─────────────
  const existingMessages = await storage.getOutboundMessages(campaignId);
  const alreadyQueuedContactIds = new Set(
    existingMessages
      .filter(m => m.status === "queued" || m.status === "sent" || m.status === "delivered")
      .map(m => m.contactId)
      .filter((id): id is number => id !== null),
  );

  let eligibleCount = 0;
  let blockedCount = 0;
  const blockReasons: Record<string, number> = {};
  const sampleContacts: Array<{ id: number; name: string; email: string; vertical: string | null }> = [];
  let afterContactId = 0;
  let blockedByContactability = 0;
  let alreadyQueued = 0;
  let queueable = 0;
  const eligibleMembers: NonNullable<CampaignPreviewResult["_eligibleMembers"]> = [];

  // ── Step 4: Paginate through the READINESS-FILTERED pool ─────────────────────
  // SQL excludes null/stale/below-threshold contacts before they reach JS so no
  // per-contact storage.getContact() calls are needed for readiness checks.
  for (;;) {
    const page = await storage.getContactsForCampaignAudience({
      verticals: campaign.targetVerticals ?? undefined,
      afterContactId,
      maxContactId: snapshotMaxContactId,
      limit: QUEUE_SQL_PAGE,
      // Pass readiness filter into SQL only when a threshold is set.
      ...(applyReadiness ? {
        readinessThreshold,
        readinessModelVersion: READINESS_MODEL_VERSION,
      } : {}),
    });

    if (page.length === 0) break;

    for (const contact of page) {
      // ── Already queued check ────────────────────────────────────────────────
      if (alreadyQueuedContactIds.has(contact.id)) {
        alreadyQueued++;
        continue;
      }

      // CR-04 is the single campaign qualification authority. It composes
      // commercial, source, completeness, provider, contactability, offer,
      // ownership, sequence, sender/content and reply-route dependencies.
      const authority = await evaluateCr04ChannelQualification(contact.id, {
        channel: "email",
        campaignId,
        contentVersion: computeTargetingHash(campaign, await storage.getCampaignSteps(campaignId)),
        senderVersion: "sender-policy-v1",
        replyRouteVersion: "campaign-reply-v1",
      });

      if (authority.qualified && authority.id) {
        eligibleCount++;
        queueable++;
        const tokenHash = hashEmailToken(contact.email);
        if (tokenHash) {
          eligibleMembers.push({
            contactId: contact.id,
            subjectGeneration: contact.emailMutationGeneration,
            tokenHash,
            subjectMutationAt: contact.updatedAt ?? null,
            commercialResolutionSnapshotId: authority.commercialResolutionSnapshotId ?? undefined,
            cr04DecisionId: authority.id,
            dependencyFingerprint: authority.dependencyFingerprint,
          });
        }
        if (sampleContacts.length < 5) {
          sampleContacts.push({
            id: contact.id,
            name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.companyName || "Unknown",
            email: contact.email,
            vertical: contact.vertical,
          });
        }
      } else {
        blockedCount++;
        blockedByContactability++;
        for (const reason of authority.reasonCodes) {
          blockReasons[reason] = (blockReasons[reason] || 0) + 1;
        }
      }
    }

    afterContactId = page[page.length - 1].id;
    if (page.length < QUEUE_SQL_PAGE) break;
  }

  return {
    eligibleCount,
    sampleContacts,
    totalInVerticals,
    blockedCount,
    blockReasons,
    excludedByReadiness,
    readinessSubReasons,
    blockedByContactability,
    alreadyQueued,
    queueable,
    readinessThreshold,
    readinessModelVersionUsed: READINESS_MODEL_VERSION,
    _eligibleMembers: eligibleMembers,
  };
}

// Kick off a DB-backed preview computation in the background (non-blocking).
// Creates a campaign_previews row with status=running, then fills it in
// setImmediate so the HTTP response is returned before work starts.
// Returns the new preview's DB id so the caller can include it in the response.
export async function startCampaignPreviewAsync(
  campaignId: number,
  requestedBy?: string,
): Promise<number> {
  const campaign = await storage.getCampaign(campaignId);
  if (!campaign) throw new Error("Campaign not found");

  const steps = await storage.getCampaignSteps(campaignId);
  const targetingHash = computeTargetingHash(campaign, steps);

  const preview = await storage.createCampaignPreview({
    campaignId,
    status: "running",
    targetVerticals: campaign.targetVerticals ?? [],
    targetingHash,
    requestedBy: requestedBy ?? null,
    eligibleCount: null,
    totalInVerticals: null,
    blockedCount: null,
    blockReasons: {},
    sampleContacts: [],
    completedAt: null,
    expiresAt: null,
    consumedAt: null,
    // Phase 2: persist snapshot of readiness criteria so the queue gate can
    // verify model version hasn't changed between preview and queue.
    readinessThreshold: campaign.readinessThreshold ?? null,
    readinessModelVersion: READINESS_MODEL_VERSION,
    cr04PolicyVersion: CR04_POLICY_VERSION,
  });

  const previewId = preview.id;

  // A preview is only exposed after its durable membership has been committed.
  // The prior detached setImmediate() reported "running" without recoverable
  // queue ownership and could strand an accepted preview on process restart.
  try {
      const snapshot = await db.select({ maxId: sql<number>`COALESCE(MAX(${contacts.id}), 0)` }).from(contacts);
      const result = await previewContactCampaignAudience(campaignId, snapshot[0]?.maxId ?? 0);
      const now = new Date();
      // Persist the exact eligible membership before exposing a completed
      // preview. Queueing can only reference these rows (composite FK), never a
      // re-run mutable selector.
      if (result._eligibleMembers?.length) {
        await db.transaction(async (tx) => {
          for (const [index, member] of result._eligibleMembers!.entries()) {
            await tx.insert(campaignPreviewMembers).values({
              previewId,
              contactId: member.contactId,
              subjectGeneration: member.subjectGeneration,
              subjectMutationAt: member.subjectMutationAt,
              normalizedEmailTokenHash: member.tokenHash,
              eligibilityDecision: "eligible",
              reasonCodes: [],
              readinessModelVersion: READINESS_MODEL_VERSION,
              commercialResolutionSnapshotId: member.commercialResolutionSnapshotId,
              cr04DecisionId: member.cr04DecisionId,
              cr04CohortOrdinal: index + 1,
            }).onConflictDoNothing();
          }
        });
      }
      await storage.updateCampaignPreview(previewId, {
        status: "done",
        eligibleCount: result.eligibleCount,
        totalInVerticals: result.totalInVerticals,
        blockedCount: result.blockedCount,
        // blockReasons holds ONLY contactability gate reasons — no __ magic keys.
        // readiness exclusions are a separate data concern stored in readinessBreakdown.
        blockReasons: result.blockReasons,
        // Phase 2: the four audience categories are stored in their own first-class
        // JSONB column so getCampaignPreviewState() can reconstruct them without
        // any __ key hacks inside blockReasons.
        readinessBreakdown: {
          excludedByReadiness: result.excludedByReadiness,
          readinessSubReasons: result.readinessSubReasons,
          blockedByContactability: result.blockedByContactability,
          alreadyQueued: result.alreadyQueued,
          queueable: result.queueable,
          readinessThreshold: result.readinessThreshold,
          readinessModelVersionUsed: result.readinessModelVersionUsed,
        },
        sampleContacts: result.sampleContacts,
        completedAt: now,
        expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
        cr04PolicyVersion: CR04_POLICY_VERSION,
        cr04DependencyFingerprint: createHash("sha256")
          .update(result._eligibleMembers?.map((member) => member.dependencyFingerprint).join("|") ?? "")
          .digest("hex"),
      });
  } catch (err: any) {
      // Sanitize before persisting: strip file paths, SQL detail, stack frames.
      // Never persist raw query text, secrets, or hostnames.
      const rawMsg: string = err?.message ?? "Preview computation failed";
      const safe = rawMsg
        .replace(/\/[^\s"']+\.(ts|js|mjs|cjs):\d+:\d*/g, "[file]")
        .replace(/\bpassword\b[^,}\n]*/gi, "[redacted]")
        .replace(/\bsecret\b[^,}\n]*/gi, "[redacted]")
        .replace(/detail:\s*Failing row[^\n]*/gi, "[row detail redacted]")
        .slice(0, 400);
      await storage.updateCampaignPreview(previewId, {
        status: "failed",
        completedAt: new Date(),
        blockReasons: { __error: safe } as any,
      });
  }

  return previewId;
}

/**
 * Queues only contacts materialized by a completed preview. A send-time check
 * may exclude a member whose email generation/contactability changed; it can
 * never discover or add a new contact.
 */
export async function queueFrozenCampaignPreviewMembers(
  campaignId: number,
  previewId: number,
  actorId?: string,
): Promise<{ queued: number; excluded: number; queueRunId: string | null; deferred?: boolean }> {
  if (!decideCr06PromotionalLifecycle({ boundary: "campaign_queue", purpose: "promotional" }).allowed) {
    return { queued: 0, excluded: 0, queueRunId: null };
  }
  const steps = await storage.getCampaignSteps(campaignId);
  const step = steps.sort((a, b) => a.stepOrder - b.stepOrder)[0];
  if (!step) return { queued: 0, excluded: 0, queueRunId: null };

  // The preview is consumed only in the same transaction that creates its
  // durable owner. A process crash cannot strand a consumed preview with no
  // queue run; an existing nonterminal run is safely resumed below.
  const run = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(campaignQueueRuns)
      .where(eq(campaignQueueRuns.previewId, previewId)).limit(1);
    // HTTP acceptance has a single owner. Existing runs are recovered by the
    // worker; returning one here would let two concurrent requests both claim
    // they accepted the same preview.
    if (existing) return null;
    const [consumed] = await tx.update(campaignPreviews)
      .set({ consumedAt: new Date() })
      .where(and(eq(campaignPreviews.id, previewId), isNull(campaignPreviews.consumedAt)))
      .returning({ id: campaignPreviews.id });
    if (!consumed) return null;
    const [created] = await tx.insert(campaignQueueRuns).values({
      campaignId, previewId, idempotencyKey: `preview:${previewId}`,
      actorId: actorId ?? null, state: "pending",
    }).returning();
    return created ?? null;
  });
  if (!run) return { queued: 0, excluded: 0, queueRunId: null };

  try {
    const { getQueueManagerProducers, QUEUE_NAMES } = await import("./queue-manager");
    const queue = getQueueManagerProducers()?.getQueue(QUEUE_NAMES.ENRICHMENT);
    if (!queue) throw new Error("queue_unavailable");
    await queue.add("campaign-queue-run", { runId: run.id }, {
      jobId: `campaign-queue-run-${run.id}`, attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    });
    return { queued: 0, excluded: 0, queueRunId: run.id };
  } catch {
    await db.update(campaignQueueRuns).set({ state: "deferred", failureCode: "queue_unavailable" })
      .where(eq(campaignQueueRuns.id, run.id));
    return { queued: 0, excluded: 0, queueRunId: run.id, deferred: true };
  }
}

/** Queue-owned, claim-fenced campaign queue execution. Membership remains the
 * frozen preview ledger; send-time checks can only exclude rows. */
export async function processCampaignQueueRun(runId: string): Promise<void> {
  if (!decideCr06PromotionalLifecycle({ boundary: "campaign_claim", purpose: "promotional" }).allowed) {
    return;
  }
  const token = randomUUID();
  const claimed = await db.execute(sql`
    UPDATE campaign_queue_runs
       SET state = 'running', claim_token = ${token}::uuid,
           lease_expires_at = NOW() + INTERVAL '5 minutes', failure_code = NULL
     WHERE id = ${runId}::uuid
       AND state IN ('pending', 'deferred', 'running')
       AND (state <> 'running' OR lease_expires_at IS NULL OR lease_expires_at < NOW())
     RETURNING campaign_id, preview_id
  `);
  const run = (claimed as any).rows?.[0];
  if (!run) return;
  const steps = await storage.getCampaignSteps(run.campaign_id);
  const campaign = await storage.getCampaign(run.campaign_id);
  const step = steps.sort((a, b) => a.stepOrder - b.stepOrder)[0];
  if (!step) {
    await db.execute(sql`UPDATE campaign_queue_runs SET state='failed', failure_code='missing_step', completed_at=NOW()
      WHERE id=${runId}::uuid AND claim_token=${token}::uuid`);
    return;
  }
  const dailyLimit = campaign?.dailySendLimit ?? 200;
  const alreadySendingToday = await getDailySendCount(run.campaign_id);
  const alreadyQueued = (await storage.getOutboundMessages(run.campaign_id))
    .filter((message) => ["queued", "scheduled", "sending"].includes(message.status ?? "")).length;
  const capacity = Math.max(0, Math.min(DEFAULT_QUEUE_LIMIT, dailyLimit - alreadySendingToday - alreadyQueued));
  let queuedThisRun = 0;
  const members = await db.select().from(campaignPreviewMembers)
    .where(and(eq(campaignPreviewMembers.previewId, run.preview_id), eq(campaignPreviewMembers.eligibilityDecision, "eligible")))
    .orderBy(campaignPreviewMembers.contactId);
  for (const member of members) {
    if (queuedThisRun >= capacity) break;
    const contact = await storage.getContact(member.contactId);
    const changed = !contact || contact.emailMutationGeneration !== member.subjectGeneration ||
      hashEmailToken(contact.email ?? "") !== member.normalizedEmailTokenHash;
    let disposition: "excluded" | "queued" = "excluded";
    let reason = changed ? "subject_changed" : "send_time_ineligible";
    if (!changed && contact && campaign) {
      const current = await evaluateCr04ChannelQualification(contact.id, {
        channel: "email",
        campaignId: run.campaign_id,
        contentVersion: computeTargetingHash(campaign, steps),
        senderVersion: "sender-policy-v1",
        replyRouteVersion: "campaign-reply-v1",
      });
      if (current.qualified) {
        disposition = "queued";
        reason = "";
      } else {
        reason = current.reasonCodes[0] ?? "send_time_ineligible";
      }
    }
    await db.transaction(async (tx) => {
      const [item] = await tx.insert(campaignQueueItems).values({
        queueRunId: runId, previewId: run.preview_id, contactId: member.contactId, stepId: step.id,
        disposition: "pending",
      }).onConflictDoNothing().returning();
      if (!item) return;
      if (disposition === "excluded") {
        await tx.update(campaignQueueItems).set({ disposition: "excluded", reasonCode: reason, completedAt: new Date() })
          .where(eq(campaignQueueItems.id, item.id));
        return;
      }
      const [existing] = await tx.select({ id: outboundMessages.id }).from(outboundMessages).where(and(
        eq(outboundMessages.campaignId, run.campaign_id), eq(outboundMessages.contactId, member.contactId),
        eq(outboundMessages.stepId, step.id),
      )).limit(1);
      if (existing) {
        await tx.update(campaignQueueItems).set({ disposition: "excluded", reasonCode: "outbound_exists", completedAt: new Date() })
          .where(eq(campaignQueueItems.id, item.id));
        return;
      }
      const [message] = await tx.insert(outboundMessages).values({
        campaignId: run.campaign_id, contactId: member.contactId, stepId: step.id,
        channel: step.channel || "email", subject: step.subject || "", body: step.bodyTemplate || "",
        status: "queued",
        scheduledFor: new Date(Date.now() + (alreadySendingToday + alreadyQueued + queuedThisRun) * SEND_INTERVAL_MS),
        metadata: { queueRunId: runId },
      }).returning({ id: outboundMessages.id });
      await tx.update(campaignQueueItems).set({
        disposition: "queued", outboundMessageId: message.id, completedAt: new Date(),
      }).where(eq(campaignQueueItems.id, item.id));
      queuedThisRun++;
    });
  }
  const summary = await db.execute(sql`
    SELECT count(*) FILTER (WHERE disposition='queued')::int AS queued,
           count(*) FILTER (WHERE disposition='excluded')::int AS excluded,
           count(*) FILTER (WHERE disposition IN ('pending','failed'))::int AS unresolved
      FROM campaign_queue_items WHERE queue_run_id=${runId}::uuid
  `);
  const totals = (summary as any).rows?.[0];
  const hasUnmaterializedMembers = Number(totals?.queued ?? 0) + Number(totals?.excluded ?? 0) < members.length;
  await db.execute(sql`
    UPDATE campaign_queue_runs
       SET state = CASE WHEN ${Number(totals?.unresolved ?? 1)} = 0 AND ${!hasUnmaterializedMembers} THEN 'completed' ELSE 'deferred' END,
           queued_count=${Number(totals?.queued ?? 0)}, excluded_count=${Number(totals?.excluded ?? 0)},
           completed_at=CASE WHEN ${Number(totals?.unresolved ?? 1)} = 0 AND ${!hasUnmaterializedMembers} THEN NOW() ELSE NULL END,
           claim_token=NULL, lease_expires_at=NULL
     WHERE id=${runId}::uuid AND claim_token=${token}::uuid
  `);
}

/** Re-enqueue durable runs after Redis/process failure. Claims in
 * processCampaignQueueRun make duplicate recovery jobs harmless. */
export async function recoverCampaignQueueRuns(limit = 25): Promise<number> {
  const rows = await db.execute(sql`
    SELECT id FROM campaign_queue_runs
     WHERE state IN ('pending', 'deferred')
        OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
     ORDER BY created_at LIMIT ${limit}
  `);
  const { getQueueManagerProducers, QUEUE_NAMES } = await import("./queue-manager");
  const queue = getQueueManagerProducers()?.getQueue(QUEUE_NAMES.ENRICHMENT);
  if (!queue) return 0;
  let scheduled = 0;
  for (const row of (rows as any).rows ?? []) {
    await queue.add("campaign-queue-run", { runId: row.id }, { attempts: 3, backoff: { type: "exponential", delay: 5_000 } });
    scheduled++;
  }
  return scheduled;
}

export async function processSendQueue(maxToSend?: number): Promise<{ sent: number; failed: number }> {
  if (!isGhlConfigured() && !isSmtpConfigured()) {
    return { sent: 0, failed: 0 };
  }

  // Recover any rows that were left in `sending` by a previous worker crash.
  // They are older than 5 minutes so the send almost certainly never completed;
  // surface them as `failed` so operators can see them.
  await storage.markStaleInFlightMessagesFailed();

  const fetchLimit = maxToSend ? Math.min(maxToSend, 50) : 50;
  const messages = await storage.getQueuedMessages(fetchLimit);
  const now = new Date();
  const ready = messages.filter(m => !m.scheduledFor || new Date(m.scheduledFor).getTime() <= now.getTime());

  const { getStoredSignature } = await import("./email-signatures");
  const storedSig = await getStoredSignature("sales");

  let sent = 0;
  let failed = 0;

  // Cache campaign status to avoid N DB fetches per message.
  const campaignStatusCache = new Map<number, string>();

  for (const msg of ready) {
    if (maxToSend !== undefined && sent >= maxToSend) break;

    try {
      if (!decideCr06PromotionalLifecycle({ boundary: "campaign_transport", purpose: "promotional" }).allowed) {
        await storage.updateOutboundMessage(msg.id, { status: "skipped", error: "CR06_PROMOTIONAL_EXECUTION_DISABLED" });
        continue;
      }
      // ── Skip messages from paused/draft campaigns ──────────────────────────
      if (msg.campaignId) {
        let campaignStatus = campaignStatusCache.get(msg.campaignId);
        if (campaignStatus === undefined) {
          const c = await storage.getCampaign(msg.campaignId);
          campaignStatus = c?.status ?? "unknown";
          campaignStatusCache.set(msg.campaignId, campaignStatus);
        }
        if (campaignStatus === "paused" || campaignStatus === "draft") {
          continue; // Leave in queued state — do not send, do not fail.
        }
      }

      // ── Route to correct send path based on which FK is set ───────────────
      if (msg.contactId && !msg.prospectId) {
        const result = await sendContactCampaignMessage(msg, storedSig);
        if (result === "sent") sent++;
        else if (result === "failed") failed++;
        // "skipped" counts neither
        continue;
      }

      // ── Legacy prospect path ───────────────────────────────────────────────
      // Guard: prospectId may be null on malformed rows; don't crash with !
      if (!msg.prospectId) {
        await storage.updateOutboundMessage(msg.id, { status: "failed", error: "No prospectId or contactId set" });
        failed++;
        continue;
      }

      const prospect = await storage.getProspect(msg.prospectId);
      if (!prospect || !prospect.email) {
        await storage.updateOutboundMessage(msg.id, { status: "failed", error: "No email address" });
        failed++;
        continue;
      }

      if (prospect.doNotContact) {
        await storage.updateOutboundMessage(msg.id, { status: "skipped", error: "Do not contact" });
        continue;
      }

      if (prospect.contactId) {
        let contact = await storage.getContact(prospect.contactId);
        if (contact && (contact.emailStatus === "bounced" || contact.emailStatus === "invalid" || contact.emailStatus === "unsafe")) {
          await storage.updateOutboundMessage(msg.id, { status: "skipped", error: `Email status: ${contact.emailStatus}` });
          await storage.createAuditLog({
            actorType: "system",
            action: "campaign_send_skipped_bad_email",
            entityType: "contact",
            entityId: prospect.contactId,
            details: { emailStatus: contact.emailStatus, messageId: msg.id, reason: "contact email status blocks send" },
          });
          continue;
        }

        // ── ZeroBounce lazy validation gate ───────────────────────────────────
        // All legacy prospect-linked sends share the same fail-closed decision
        // as CRM queueing. Provider failure, budget denial, unknown/catch-all,
        // or writeback failure is a skip, never a send authorization.
        if (contact && prospect.email) {
          const allowed = await passesZeroBounceCheck(contact, msg.campaignId ?? 0);
          if (!allowed) {
            await storage.updateOutboundMessage(msg.id, { status: "skipped", error: "Email validation did not produce positive current evidence" });
            continue;
          }
        }

        // Contactability gate for prospect-linked contacts
        if (contact) {
          const gate = await evaluateContactability({
            contactId: contact.id,
            channel: "email",
            campaignType: "marketing_campaign",
            mode: "enforcement",
          });
          if (!gate.allowed) {
            await storage.updateOutboundMessage(msg.id, { status: "skipped", error: `Contactability blocked: ${gate.reason}` });
            await storage.createAuditLog({
              actorType: "system",
              action: "campaign_send_blocked_contactability",
              entityType: "contact",
              entityId: contact.id,
              details: { reason: gate.reason, messageId: msg.id },
            });
            continue;
          }

          // ── Communication arbitration ────────────────────────────────────────
          // Defers the message by resetting it to queued with a future
          // scheduledFor so processSendQueue picks it up after resumeAfter.
          try {
            const { shouldSuppress: arbCheck, logArbitrationSuppression } = await import("./communication-arbitration");
            const arb = await arbCheck(contact.id, "email");
            if (arb.suppressed) {
              await logArbitrationSuppression(contact.id, "email", arb);
              const resumeAt = arb.resumeAfter ?? new Date(Date.now() + 60 * 60 * 1000);
              await storage.updateOutboundMessage(msg.id, {
                status: "queued",
                scheduledFor: resumeAt,
                error: `arbitration_deferred: ${arb.reason}`,
              });
              await storage.createAuditLog({
                actorType: "system",
                action: "campaign_send_deferred_arbitration",
                entityType: "contact",
                entityId: contact.id,
                details: { reason: arb.reason, messageId: msg.id, resumeAfter: resumeAt.toISOString() },
              });
              continue;
            }
          } catch (arbErr) {
            // Fail closed: retain ownership in the queue and do not expose
            // provider/error detail in the durable message or audit record.
            const resumeAt = new Date(Date.now() + 60 * 60 * 1000);
            await storage.updateOutboundMessage(msg.id, {
              status: "queued",
              scheduledFor: resumeAt,
              error: "arbitration_check_deferred",
            });
            await storage.createAuditLog({
              actorType: "system",
              action: "campaign_send_deferred_arbitration_error",
              entityType: "contact",
              entityId: contact.id,
              details: { reason: "arbitration_check_error", messageId: msg.id, resumeAfter: resumeAt.toISOString() },
            }).catch(() => {});
            continue;
          }
        }
      }

      // Legacy prospect-linked marketing sends use SMTP exclusively so the
      // canonical transport can render compliance and List-Unsubscribe headers.
      if (!isSmtpConfigured()) {
        await storage.updateOutboundMessage(msg.id, {
          status: "failed",
          error: "SMTP required for linked-prospect campaigns",
        });
        await storage.createAuditLog({
          actorType: "system",
          action: "campaign_send_blocked_no_smtp",
          entityType: "prospect",
          entityId: prospect.id,
          details: { messageId: msg.id, reason: "linked_prospect_campaign_requires_smtp" },
        });
        failed++;
        continue;
      }

      const campaign = msg.campaignId ? await storage.getCampaign(msg.campaignId) : null;
      let subject = msg.subject || "";
      let body = msg.body || "";

      if (campaign) {
        const step = msg.stepId ? (await storage.getCampaignSteps(campaign.id)).find(s => s.id === msg.stepId) : null;
        const stepNumber = step?.stepOrder || 1;
        const personalized = await generatePersonalizedEmail(prospect, campaign, subject, body, stepNumber);
        subject = personalized.subject;
        body = personalized.body;
      }

      // Marketing campaigns require a canonical CRM contact. GHL behavior is
      // otherwise preserved; SMTP owns compliance rendering and headers.
      if (!prospect.contactId) {
        await storage.updateOutboundMessage(msg.id, { status: "skipped", error: "No linked contact (unsubscribe link unavailable)" });
        await storage.createAuditLog({
          actorType: "system",
          action: "campaign_send_blocked_no_contact_link",
          entityType: "prospect",
          entityId: prospect.id,
          details: { messageId: msg.id, reason: "prospect has no contactId; cannot generate unsubscribe link" },
        });
        continue;
      }

      const signature = getEmailSignatureHtml("sales", storedSig);
      const bodyWithSig = body + signature;

      // Mark as in-flight BEFORE the network call so a crash between send and
      // status-update leaves the row in `sending` (not `queued`).  A future
      // tick will not re-pick it up; the stale-cleanup in processSendQueue
      // will surface it as `failed` after 5 minutes instead.
      const claimed = await storage.claimOutboundMessageForSending(msg.id);
      if (!claimed) continue;

      // Global pause check — upgraded to OutboundPauseAuthority + coordinator (#1532)
      {
        const { authorize } = await import("./outbound-pause-authority");
        const { canExecute } = await import("./outbound-queue-coordinator");
        const decision = await authorize({});
        if (!decision.allowed) {
          throw new Error(`Outbound communications are globally paused (reason=${decision.reasonCode})`);
        }
        const coordOk = await canExecute("discovery-send");
        if (!coordOk) {
          throw new Error("Coordinator hold active for discovery-send");
        }
      }

      const result = await sendSmtpEmail({
        to: prospect.email!,
        subject,
        html: bodyWithSig,
        category: "cold_outreach",
        contactId: prospect.contactId,
        commercialPurpose: "marketing_outreach",
      });
      if (!result.success) {
        throw new Error(result.error || "SMTP send failed");
      }

      await storage.updateOutboundMessage(msg.id, {
        status: "sent",
        sentAt: new Date(),
        personalizedSubject: subject,
        personalizedBody: bodyWithSig,
      });

      await storage.updateProspect(prospect.id, {
        lastContactedAt: new Date(),
        status: "contacted",
      });

      // #1397 — record to canonical communication_events table
      if (prospect.contactId) {
        const { recordOutboundSend } = await import("./communication-events");
        recordOutboundSend({
          contactId: prospect.contactId,
          channel: "email",
          provider: "smtp",
          subject,
          body: bodyWithSig,
          status: "sent",
          metadata: { outboundMessageId: msg.id, campaignId: msg.campaignId },
        }).catch(err => console.warn("[CampaignEngine] recordOutboundSend failed:", err.message));
      }

      sent++;
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err: any) {
      console.error(`Failed to send message ${msg.id}:`, err);
      await storage.updateOutboundMessage(msg.id, {
        status: "failed",
        error: err.message || "Send failed",
      });
      failed++;
    }
  }

  return { sent, failed };
}

// Contact-mode send: called from processSendQueue when msg.contactId is set.
// Returns "sent" | "failed" | "skipped".
async function sendContactCampaignMessage(
  msg: Awaited<ReturnType<typeof storage.getQueuedMessages>>[number],
  storedSig: EmailSignature
): Promise<"sent" | "failed" | "skipped"> {
  if (!decideCr06PromotionalLifecycle({ boundary: "campaign_transport", purpose: "promotional" }).allowed) {
    await storage.updateOutboundMessage(msg.id, { status: "skipped", error: "CR06_PROMOTIONAL_EXECUTION_DISABLED" });
    return "skipped";
  }
  if (!msg.contactId) return "failed";

  const contact = await storage.getContact(msg.contactId);
  if (!contact || !contact.email) {
    await storage.updateOutboundMessage(msg.id, { status: "failed", error: "Contact not found or no email" });
    return "failed";
  }

  // Contactability gate — enforcement mode writes audit log
  const gate = await evaluateContactability({
    contactId: contact.id,
    channel: "email",
    campaignType: "marketing_campaign",
    mode: "enforcement",
  });

  if (!gate.allowed) {
    await storage.updateOutboundMessage(msg.id, { status: "skipped", error: `Contactability blocked: ${gate.reason}` });
    await storage.createAuditLog({
      actorType: "system",
      action: "campaign_send_blocked_contactability",
      entityType: "contact",
      entityId: contact.id,
      details: { reason: gate.reason, messageId: msg.id },
    });
    return "skipped";
  }

  // Fresh positive evidence for the current normalized email is mandatory for
  // marketing sends. Contactability is a separate authority and cannot make an
  // indeterminate provider result eligible.
  const { evaluateMarketingEmailEligibility, enqueueCurrentValidationIntent } = await import("./provider-readiness-control");
  const validation = await evaluateMarketingEmailEligibility(contact.id);
  if (!validation.allowed) {
    await enqueueCurrentValidationIntent(contact.id).catch(() => {});
    await storage.updateOutboundMessage(msg.id, {
      status: "skipped",
      error: `Email validation blocked: ${validation.reason}`,
    });
    await storage.createAuditLog({
      actorType: "system",
      action: "campaign_send_blocked_validation",
      entityType: "contact",
      entityId: contact.id,
      details: { reason: validation.reason, messageId: msg.id },
    });
    return "skipped";
  }

  // ── Communication arbitration ────────────────────────────────────────────
  // Must run before any send attempt. Defers the message (queued + future
  // scheduledFor) so it is retried automatically after the hold window.
  try {
    const { shouldSuppress: arbCheck, logArbitrationSuppression } = await import("./communication-arbitration");
    const arb = await arbCheck(contact.id, "email");
    if (arb.suppressed) {
      await logArbitrationSuppression(contact.id, "email", arb);
      const resumeAt = arb.resumeAfter ?? new Date(Date.now() + 60 * 60 * 1000);
      await storage.updateOutboundMessage(msg.id, {
        status: "queued",
        scheduledFor: resumeAt,
        error: `arbitration_deferred: ${arb.reason}`,
      });
      await storage.createAuditLog({
        actorType: "system",
        action: "campaign_send_deferred_arbitration",
        entityType: "contact",
        entityId: contact.id,
        details: { reason: arb.reason, messageId: msg.id, resumeAfter: resumeAt.toISOString() },
      });
      return "skipped";
    }
  } catch (arbErr) {
    // Fail closed: leave the message owned by the queue for a later retry.
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000);
    await storage.updateOutboundMessage(msg.id, {
      status: "queued",
      scheduledFor: resumeAt,
      error: "arbitration_check_deferred",
    });
    await storage.createAuditLog({
      actorType: "system",
      action: "campaign_send_deferred_arbitration_error",
      entityType: "contact",
      entityId: contact.id,
      details: { reason: "arbitration_check_error", messageId: msg.id, resumeAfter: resumeAt.toISOString() },
    }).catch(() => {});
    return "skipped";
  }

  // Contact-mode campaigns MUST use SMTP for List-Unsubscribe header compliance.
  if (!isSmtpConfigured()) {
    await storage.updateOutboundMessage(msg.id, { status: "failed", error: "SMTP required for contact-mode campaigns" });
    await storage.createAuditLog({
      actorType: "system",
      action: "campaign_send_blocked_no_smtp",
      entityType: "contact",
      entityId: contact.id,
      details: { messageId: msg.id, reason: "contact-mode campaigns require SMTP for List-Unsubscribe headers" },
    });
    return "failed";
  }

  // Personalize
  const campaign = msg.campaignId ? await storage.getCampaign(msg.campaignId) : null;
  let subject = msg.subject || "";
  let body = msg.body || "";

  if (campaign) {
    const step = msg.stepId ? (await storage.getCampaignSteps(campaign.id)).find(s => s.id === msg.stepId) : null;
    const stepNumber = step?.stepOrder || 1;
    const personalized = await generateContactCampaignEmail(contact as Contact, campaign, subject, body, stepNumber);
    subject = personalized.subject;
    body = personalized.body;
  }

  const signature = getEmailSignatureHtml("sales", storedSig);
  const bodyWithSig = body + signature;

  // Mark as in-flight BEFORE the network call so a crash between send and
  // status-update leaves the row in `sending` (not `queued`).  A future
  // tick will not re-pick it up; the stale-cleanup in processSendQueue
  // will surface it as `failed` after 5 minutes instead.
  const claimed = await storage.claimOutboundMessageForSending(msg.id);
  if (!claimed) return "skipped";

  // Global pause check — upgraded to OutboundPauseAuthority + coordinator (#1532)
  {
    const { authorize } = await import("./outbound-pause-authority");
    const { canExecute } = await import("./outbound-queue-coordinator");
    const decision = await authorize({});
    if (!decision.allowed) {
      await storage.updateOutboundMessage(msg.id, { status: "failed", error: `Outbound communications are globally paused (reason=${decision.reasonCode})` });
      return "failed";
    }
    const coordOk = await canExecute("discovery-send");
    if (!coordOk) {
      await storage.updateOutboundMessage(msg.id, { status: "failed", error: "Coordinator hold active for discovery-send" });
      return "failed";
    }
  }

  const result = await sendSmtpEmail({
    to: contact.email,
    subject,
    html: bodyWithSig,
    category: "cold_outreach",
    contactId: contact.id,
    commercialPurpose: "marketing_outreach",
  });

  if (!result.success) {
    await storage.updateOutboundMessage(msg.id, {
      status: "failed",
      error: result.error || "SMTP send failed",
    });
    return "failed";
  }

  await storage.updateOutboundMessage(msg.id, {
    status: "sent",
    sentAt: new Date(),
    personalizedSubject: subject,
    personalizedBody: bodyWithSig,
  });

  await storage.updateContact(contact.id, { lastContactedAt: new Date() });

  // #1397 — record to canonical communication_events table
  const { recordOutboundSend } = await import("./communication-events");
  recordOutboundSend({
    contactId: contact.id,
    channel: "email",
    provider: "smtp",
    subject,
    body: bodyWithSig,
    status: "sent",
    metadata: { outboundMessageId: msg.id },
  }).catch(err => console.warn("[CampaignEngine] recordOutboundSend failed:", err.message));

  return "sent";
}

export async function getDailySendCount(campaignId?: number): Promise<number> {
  const { db } = await import("../db");
  const { outboundMessages } = await import("@shared/schema");
  const { gte, eq, and: drizzleAnd, isNotNull, inArray, or } = await import("drizzle-orm");

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Count rows that represent a send attempt today:
  //   1. sentAt IS NOT NULL AND sentAt >= today  — already completed sends
  //   2. status = 'sending' AND sendingAt >= today — in-flight sends
  //
  // Including `sending` rows prevents a crash-and-recover burst from
  // bypassing the daily cap: if N messages are in-flight when the worker
  // crashes, they are still counted against the limit on the next tick.
  const sentTodayConditions = [
    isNotNull(outboundMessages.sentAt),
    gte(outboundMessages.sentAt, today),
  ];
  const sendingTodayConditions = [
    eq(outboundMessages.status, "sending"),
    isNotNull(outboundMessages.sendingAt),
    gte(outboundMessages.sendingAt, today),
  ];

  const baseConditions = [
    or(
      drizzleAnd(...sentTodayConditions),
      drizzleAnd(...sendingTodayConditions),
    )!,
  ];
  if (campaignId !== undefined) {
    baseConditions.push(eq(outboundMessages.campaignId, campaignId));
  }

  const rows = await db
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .where(drizzleAnd(...baseConditions));

  return rows.length;
}

export async function getCampaignAnalytics(campaignId: number) {
  const stats = await storage.getOutboundStats(campaignId);
  const campaign = await storage.getCampaign(campaignId);
  const steps = await storage.getCampaignSteps(campaignId);

  return {
    campaign,
    steps,
    stats: {
      totalSent: stats.sent,
      totalOpened: stats.opened,
      totalReplied: stats.replied,
      totalBounced: stats.bounced,
      openRate: stats.sent > 0 ? ((stats.opened / stats.sent) * 100).toFixed(1) : "0",
      replyRate: stats.sent > 0 ? ((stats.replied / stats.sent) * 100).toFixed(1) : "0",
      bounceRate: stats.sent > 0 ? ((stats.bounced / stats.sent) * 100).toFixed(1) : "0",
    },
  };
}
