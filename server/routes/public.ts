import type { Express } from "express";
import { storage } from "../storage";
import { z } from "zod";
import { and, isNull, sql } from "drizzle-orm";
import { verifyUnsubscribeToken } from "../services/unsubscribe-token";
import { sendGhlEmail, sendGhlSms } from "../services/ghl";
import { generateDealBlueprint } from "../services/deal-blueprint";
import { autoGenerateProposal } from "../services/proposal-engine";
import { ingestBusinessFromContact } from "../services/sdr/dedupe";
import { writeContact, upsertContactSourceEvent } from "../services/contact-writer";
import { processExistingPublicFormSubmission } from "../services/public-form-submission";
import { buildPublicContactPayload } from "../services/public-form-payload";
import type { Contact } from "@shared/schema";
import { contacts } from "@shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { normalizePhoneE164 } from "../services/sdr/dedupe";
import { persistAndEnqueueStatementCommand } from "../services/statement-command-worker";
import {
  claimCommand,
  computeRequestFingerprint,
  isValidUUIDv4,
  markRecoverableFailed,
} from "../services/statement-upload-idempotency";
import { parse } from "csv-parse/sync";
import path from "path";
import fs from "fs";
import { upload, trackReferral } from "./helpers";
import { publicLeadRateLimit } from "../middleware/public-rate-limit";
import { recordPewcDecision } from "../services/consent-evidence";
import { applyConsentCommand } from "../services/consent-authority";
// StatementChainTracker removed — not exported from statement-upload-chain
import { resolveReferralAttribution } from "../services/attribution";
import { serverError } from "../utils/server-error";
import { recordAnalyticsEvent } from "../services/analytics-events";
import { FORM_SUBMITTED, DEAL_CREATED } from "@shared/analytics-events";
import {
  claimInboundRequest,
  getPublicInboundRequestStatus,
  inboundSlaDueAt,
  orchestrateInboundRequest,
  queueAmbiguousCallbackReview,
  setInboundRequestLifecycle,
} from "../services/inbound-request-authority";

const PUBLIC_INBOUND_SOURCES: Record<string, [string, string]> = {
  "/api/public/estimate": ["website_form", "estimate_form"],
  "/api/public/support": ["website_form", "support_form"],
  "/api/public/get-started": ["website_form", "get_started_form"],
  "/api/public/integration-request": ["website_form", "integration_request"],
  "/api/public/callback": ["website_form", "callback_form"],
  "/api/equipment-order": ["website_form", "equipment_order"],
  "/api/public/testimonial-submit": ["website_form", "testimonial_submit"],
  "/api/newsletter/subscribe": ["website_form", "newsletter_signup"],
};

function publicInboundCallerScope(req: { ip?: string }): string {
  return `public:${req.ip || "unknown"}`;
}

export function registerPublicRoutes(app: Express) {
  // Claim JSON public requests before any business mutation. The multipart
  // statement adapter has its own atomic command claim and is linked by its
  // command ID, so it is intentionally excluded from this middleware.
  app.use(async (req, res, next) => {
    if (req.method !== "POST") return next();
    const source = PUBLIC_INBOUND_SOURCES[req.path];
    if (!source) return next();
    const suppliedKey = req.header("Idempotency-Key");
    if (!suppliedKey) {
      return res.status(400).json({ error: "MISSING_IDEMPOTENCY_KEY" });
    }
    const idempotencyKey = suppliedKey;
    res.setHeader("Idempotency-Key", idempotencyKey);
    try {
      const claim = await claimInboundRequest({
        idempotencyKey,
        sourceCategory: source[0],
        sourceType: source[1],
        callerScope: publicInboundCallerScope(req),
        actorType: "public",
        payload: req.body || {},
      });
      if (claim.outcome === "conflict") return res.status(409).json({ error: "Idempotency key conflicts with another request" });
      if (claim.outcome === "scope_mismatch") return res.status(404).json({ error: "Request not found" });
      if (claim.outcome === "replay") {
        return res.status(200).json({
          success: true,
          replayed: true,
          requestReceipt: claim.request.id,
          status: claim.request.lifecycleState,
        });
      }
      (req as any).inboundRequestId = claim.request.id;
      (req as any).inboundRequest = claim.request;
      return next();
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":")[0] : "INBOUND_REQUEST_REJECTED";
      return res.status(code === "INVALID_INBOUND_IDEMPOTENCY_KEY" ? 400 : 503).json({ error: code });
    }
  });

  // A receipt is not sufficient to read a request. The caller must also prove
  // possession of the original idempotency key and arrive from its bound
  // caller scope. All failed capability checks intentionally look identical.
  app.get("/api/public/inbound-requests/:receipt/status", async (req, res) => {
    const idempotencyKey = req.header("Idempotency-Key");
    if (!idempotencyKey) return res.status(404).json({ error: "Request not found" });
    try {
      const status = await getPublicInboundRequestStatus({
        requestReceipt: req.params.receipt,
        idempotencyKey,
        callerScope: publicInboundCallerScope(req),
      });
      if (!status) return res.status(404).json({ error: "Request not found" });
      return res.status(200).json(status);
    } catch {
      // Do not disclose whether a supplied receipt was syntactically valid or
      // exists when the public capability cannot be verified.
      return res.status(404).json({ error: "Request not found" });
    }
  });
  const autoProposalRateLimit = new Map<string, number>();
  const AUTO_PROPOSAL_COOLDOWN_MS = 60 * 1000;

  async function acceptInbound(req: any, refs: {
    contactId?: number | null;
    dealId?: number | null;
    ticketId?: number | null;
    equipmentOrderIds?: number[];
    notificationId?: number | null;
  }) {
    const requestId = req.inboundRequestId as string | undefined;
    if (!requestId) return null;
    const request = await orchestrateInboundRequest({ requestId, ...refs });
    return { success: true, requestReceipt: request.id, status: request.lifecycleState };
  }

  async function failInbound(req: any, status: number) {
    const requestId = req.inboundRequestId as string | undefined;
    if (requestId) await setInboundRequestLifecycle(requestId, "failed", `HTTP_${status}`);
  }

  async function legacyAutoProposalEmail(dealId: number, contactId: number, meta: { vertical?: string; businessName?: string; contactName?: string; email?: string; consentEmail?: boolean }) {
    try {
      if (meta.email) {
        const lastCall = autoProposalRateLimit.get(meta.email);
        if (lastCall && Date.now() - lastCall < AUTO_PROPOSAL_COOLDOWN_MS) {
          console.log("[AutoProposal] Rate limited for", meta.email);
          return;
        }
        autoProposalRateLimit.set(meta.email, Date.now());
        if (autoProposalRateLimit.size > 1000) {
          const oldest = [...autoProposalRateLimit.entries()].sort((a, b) => a[1] - b[1]).slice(0, 500);
          oldest.forEach(([key]) => autoProposalRateLimit.delete(key));
        }
      }

      const deal = await storage.getDeal(dealId);
      if (!deal) return;
      const contact = await storage.getContact(contactId);
      if (!contact) return;

      const volume = parseFloat((deal.totalVolume || "15000").toString().replace(/[^0-9.]/g, "")) || 15000;
      const effectiveRate = parseFloat((deal.effectiveRate || "2.8").toString().replace(/[^0-9.]/g, "")) || 2.8;
      const avgTicket = parseFloat((deal.avgTicket || "50").toString().replace(/[^0-9.]/g, "")) || 50;
      const currentMonthlyFees = volume * (effectiveRate / 100);

      let proposalData: any;
      let aiGenerationSucceeded = false; // tracked for _generationSource tag on the stored proposal

      const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
      const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
      if (apiKey) {
        try {
          const { OpenAI } = await import("openai");
          const openai = new OpenAI({ apiKey, baseURL });

          const { logAiCall: logAi } = await import("../services/ai-audit-logger");
          const pubStmtMessages = [
            {
              role: "system" as const,
              content: `You are Liberty Bancard's AI Pricing Strategist. Generate a brief, professional savings estimate email for a merchant who just uploaded their processing statement. Be concise and professional. Include a disclaimer that this is a preliminary estimate and actual savings depend on full statement review.

Return JSON with:
- subject: email subject line
- body: plain text email body (use \\n for line breaks)
- estimatedSavingsRange: string like "$200-$500/month"
- recommendedProgram: one of ["Cash Discount", "Interchange Plus", "Dual Pricing"]`
            },
            {
              role: "user" as const,
              content: `Merchant: ${meta.businessName || contact.companyName || meta.contactName || "Unknown"}
Industry: ${meta.vertical || contact.vertical || "General"}
Estimated Monthly Volume: $${volume.toLocaleString()}
Estimated Effective Rate: ${effectiveRate}%
Current Monthly Fees: $${currentMonthlyFees.toFixed(2)}
Average Ticket: $${avgTicket.toFixed(2)}
Current Provider: ${contact.currentProvider || "Unknown"}`
            },
          ];
          const { completion } = await logAi(
            { triggerType: "statement-analysis", actorType: "system", rawPrompt: JSON.stringify(pubStmtMessages) },
            () => openai.chat.completions.create({
              model: "gpt-5",
              messages: pubStmtMessages,
              max_completion_tokens: 8000,
            })
          );

          const raw = completion.choices[0]?.message?.content || "";
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            proposalData = JSON.parse(jsonMatch[0]);
            if (proposalData?.subject && proposalData?.body) aiGenerationSucceeded = true;
          }
        } catch (aiErr: any) {
          console.error("[AutoProposal] AI call failed:", aiErr.message?.slice(0, 100));
        }
      } else {
        console.log("[AutoProposal] No OpenAI API key configured, using fallback proposal");
      }

      if (!proposalData || !proposalData.subject || !proposalData.body) {
        const merchantName = meta.contactName || contact.firstName || "there";
        const savingsEst = Math.round(currentMonthlyFees * 0.25);
        proposalData = {
          subject: `Your Statement Review Is Underway — ${meta.businessName || "Your Business"}`,
          body: `Hi ${merchantName},\n\nThank you for uploading your processing statement. Our team is reviewing it now.\n\nBased on your industry and estimated volume ($${volume.toLocaleString()}/month), merchants like you typically save $${savingsEst}-$${savingsEst * 2}/month by switching to transparent interchange-plus pricing.\n\nWe'll have your full line-by-line breakdown ready within one business day. In the meantime, feel free to call or text us at 954-266-8214 with any questions.\n\nBest,\nLiberty Bancard Team\n\nDisclaimer: This is a preliminary estimate. Actual savings depend on full statement review. Eligibility, underwriting, card brand rules, and applicable laws apply.`,
          estimatedSavingsRange: `$${savingsEst}-$${savingsEst * 2}/month`,
          recommendedProgram: "Interchange Plus",
        };
      }

      // Tag the stored proposal so the UI can show a warning when AI was unavailable.
      proposalData._generationSource = aiGenerationSucceeded ? "ai" : "template";

      await storage.updateDeal(dealId, {
        savingsProposal: proposalData,
        proposalGeneratedAt: new Date(),
        recommendedPath: proposalData.recommendedProgram || deal.recommendedPath,
      });

      await storage.createAuditLog({
        action: "auto_proposal_generated",
        entityType: "deal",
        entityId: dealId,
        details: {
          source: "statement_upload_auto",
          recommendedProgram: proposalData.recommendedProgram,
          estimatedSavings: proposalData.estimatedSavingsRange,
        },
      });

      const hasEmailConsent = meta.consentEmail === true;
      if (meta.email && hasEmailConsent && proposalData.subject && proposalData.body) {
        try {
          const proposalEmailResult = await sendGhlEmail({
            contactId,
            dealId,
            subject: proposalData.subject,
            body: proposalData.body,
            commercialPurpose: "transactional_response",
          });
          if (proposalEmailResult.success) await storage.createAuditLog({
            action: "auto_proposal_emailed",
            entityType: "deal",
            entityId: dealId,
            details: { email: meta.email, subject: proposalData.subject },
          });
        } catch (emailErr: any) {
          console.error("[AutoProposal] Email send failed:", emailErr.message?.slice(0, 100));
        }
      }

      await storage.createNotification({
        channel: "internal",
        title: "Auto-Proposal Generated",
        message: `Auto-proposal for ${meta.contactName || meta.email || "Unknown"} - ${proposalData.estimatedSavingsRange || "N/A"} estimated savings${hasEmailConsent ? " (emailed)" : " (stored, not emailed - no consent)"}`,
        type: "info",
        metadata: { dealId, contactId },
      });
    } catch (err: any) {
      console.error("[AutoProposal] Error:", err.message?.slice(0, 200));
    }
  }


  // === PUBLIC FORM SUBMISSIONS ===
  app.post("/api/public/statement-upload", publicLeadRateLimit, upload.single("statementFile"), async (req, res) => {
    let ownedCommandId: string | null = null;
    let ownedInboundRequestId: string | null = null;
    try {
      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
      if (!idempotencyKey) {
        return res.status(400).json({
          error: "MISSING_IDEMPOTENCY_KEY",
          message: "Idempotency-Key header is required. Supply a UUID v4.",
        });
      }
      if (!isValidUUIDv4(idempotencyKey)) {
        return res.status(400).json({
          error: "INVALID_IDEMPOTENCY_KEY",
          message: "Idempotency-Key must be a valid UUID v4.",
        });
      }

      const { businessName, contactName, email, mobile, vertical, currentProvider, interestedIn0Percent, needTerminal, notes, consentSms, referralCode, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, landingPage, gclid, referrerUrl: bodyReferrerUrl } = req.body;
      const referrerUrl = bodyReferrerUrl || req.headers["referer"] || req.headers["referrer"] || undefined;
      const nameParts = (contactName || "").split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      const parseBool = (v: unknown) => v === true || v === "true";

      // Check if the user is already authenticated — bind upload to their existing merchant record
      const authUserId = (req.user as any)?.id;
      let existingContactId: number | null = null;
      let existingDealId: number | null = null;

      if (authUserId) {
        try {
          const merchantProfile = await storage.getMerchantProfileByUser(authUserId);
          if (merchantProfile?.contactId) {
            existingContactId = merchantProfile.contactId;
          }
          if (merchantProfile?.dealId) {
            existingDealId = merchantProfile.dealId;
          }
        } catch (profileErr) {
          console.warn("[StatementUpload] Could not fetch merchant profile for user", authUserId, profileErr);
        }
      }

      // The request authority owns the public occurrence. Its multipart
      // fingerprint includes the statement bytes, while its caller scope is
      // identical to other public intake capability checks.
      const normalizedEmailForFp = (email || "").trim().toLowerCase();
      const fingerprint = computeRequestFingerprint({
        fields: {
          // Target identity (normalized)
          email: normalizedEmailForFp,
          mobile: (mobile || "").trim(),
          businessName: (businessName || "").trim().toLowerCase(),
          // Source/workflow metadata
          source: "website",
          utmSource: utmSource || null,
          utmCampaign: utmCampaign || null,
          landingPage: landingPage || "/upload-statement",
          // FK hints
          existingContactId: existingContactId ?? null,
          existingDealId: existingDealId ?? null,
        },
        fileBuffer: req.file?.buffer ?? Buffer.alloc(0),
      });

      const callerScope = publicInboundCallerScope(req);
      const inboundClaim = await claimInboundRequest({
        idempotencyKey,
        sourceCategory: "website_form",
        sourceType: "statement_upload",
        callerScope,
        actorType: "public",
        requestFingerprint: fingerprint,
        payload: req.body || {},
      });
      if (inboundClaim.outcome === "conflict") {
        return res.status(409).json({ error: "Idempotency key conflicts with another request" });
      }
      if (inboundClaim.outcome === "scope_mismatch") {
        return res.status(404).json({ error: "Request not found" });
      }
      if (inboundClaim.outcome === "replay") {
        const status = inboundClaim.request.lifecycleState;
        return res.status(status === "claimed" || status === "processing" ? 202 : 200).json({
          success: true,
          requestReceipt: inboundClaim.request.id,
          status,
        });
      }
      const submissionId = inboundClaim.request.id;
      ownedInboundRequestId = submissionId;
      (req as any).inboundRequestId = submissionId;

      // The statement command remains the protected-object/worker authority.
      // It deliberately shares the request fingerprint and caller scope with
      // the occurrence claim; it is never a public receipt.
      const claim = await claimCommand({
        requestId: idempotencyKey,
        fingerprint,
        ownerScope: callerScope,
        source: "website",
        context: {
          email: normalizedEmailForFp,
          businessName: businessName || null,
          source: "website",
          submissionId,
        },
      });

      // ── Handle non-claimed outcomes before any business mutation ──────────
      if (claim.outcome === "conflict") {
        return res.status(409).json({
          error: "IDEMPOTENCY_KEY_CONFLICT",
          message: "This Idempotency-Key was already used with a different request payload.",
        });
      }
      if (claim.outcome === "scope_mismatch") {
        return res.status(403).json({
          error: "IDEMPOTENCY_KEY_SCOPE_MISMATCH",
          message: "This Idempotency-Key belongs to a different caller.",
        });
      }
      if (claim.outcome === "claimed_by_other") {
        return res.status(202).json({
          success: true,
          requestReceipt: submissionId,
          status: inboundClaim.request.lifecycleState,
        });
      }
      if (claim.outcome === "replay") {
        return res.status(200).json({
          success: true,
          requestReceipt: submissionId,
          status: inboundClaim.request.lifecycleState,
        });
      }
      if (claim.outcome === "recoverable_failed_replay") {
        await setInboundRequestLifecycle(submissionId, "failed", "STATEMENT_COMMAND_RECOVERABLE_FAILED");
        return res.status(422).json({ error: "REQUEST_PROCESSING_FAILED" });
      }

      // claim.outcome === "claimed" — we own this slot, proceed with business mutations
      const commandId = claim.command.id;
      ownedCommandId = commandId;

      const tags = ["src_website", "lead_statement_upload", `vertical_${(vertical || "unknown").toLowerCase().replace(/[^a-z]/g, "_")}`];
      if (utmSource) tags.push(`utm_src_${utmSource}`);

      let contact: Contact;
      let statementConsentHandledByMerge = false;
      if (existingContactId) {
        contact = (await storage.getContact(existingContactId))!;
      } else {
        const normalizedEmail = email?.trim().toLowerCase() || null;
        const existingByEmail = normalizedEmail ? await storage.getContactByEmail(normalizedEmail) : null;
        if (existingByEmail) {
          contact = await processExistingPublicFormSubmission({
            existingContact: existingByEmail,
            permittedProfileUpdates: buildPublicContactPayload("statement_upload", {
              firstName, lastName, email, phone: mobile,
              companyName: businessName, vertical, currentProvider,
              interestedIn0Percent: parseBool(interestedIn0Percent),
              needTerminal: parseBool(needTerminal),
              notes, utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
              landingPage: landingPage || "/upload-statement",
              gclid: gclid || undefined,
            }),
            incomingConsent: { consentSms: parseBool(consentSms) ? true : undefined },
            submissionId,
            formType: "statement_upload",
            requestEvidence: {
              ipAddress: req.ip || req.socket.remoteAddress || "unknown",
              userAgent: req.headers["user-agent"] || "unknown",
            },
          });
          statementConsentHandledByMerge = true;
        } else {
          contact = await writeContact({
            mode: "local_first",
            mutation: {
              firstName, lastName, email, phone: mobile,
              companyName: businessName, vertical, currentProvider,
              interestedIn0Percent: parseBool(interestedIn0Percent),
              needTerminal: parseBool(needTerminal),
              notes,
              utmSource: utmSource || undefined,
              utmMedium: utmMedium || undefined,
              utmCampaign: utmCampaign || undefined,
              utmContent: utmContent || undefined,
              utmTerm: utmTerm || undefined,
              landingPage: landingPage || "/upload-statement",
              gclid: gclid || undefined,
              referrerUrl: referrerUrl || undefined,
              status: "New",
              tags,
            },
            provenance: {
              sourceCategory: "website_form",
              sourceType: "statement_upload",
              eventKey: `form:statement_upload:${submissionId}`,
              actorType: "public",
            },
            actor: { actorType: "public" },
          });
        }
      }

      if (!contact) throw new Error("Could not resolve contact record");

      const pewcConsent = parseBool(req.body.pewcConsent);
        if (!statementConsentHandledByMerge && parseBool(consentSms)) {
          await applyConsentCommand({
            subject: { type: "contact", id: contact.id },
            kind: "opt_in",
            channel: "sms",
            purpose: "outreach",
            eventNamespace: "public_form",
            eventKey: `statement_upload:${submissionId}:sms`,
            source: "statement_upload",
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
            evidence: { submissionId, formType: "statement_upload" },
          });
        }
        if (pewcConsent) {
          await recordPewcDecision({
          contactId: contact.id,
          checked: true,
          source: "statement_upload",
          ipAddress: req.ip || req.socket.remoteAddress || "unknown",
          userAgent: req.headers["user-agent"] || "unknown",
            eventKey: `statement_upload:${submissionId}`,
            details: { formType: "statement_upload", submissionId },
          });
      }

      const statementFileBuffer = req.file?.buffer;
      const rawStatementName = req.file?.originalname || (businessName ? businessName + "_statement" : "statement");
      const statementFileName = path.basename(rawStatementName).replace(/[^a-zA-Z0-9._-]/g, "_");

      // Resolve attribution BEFORE the chain so partnerOrgId flows into deal creation
      let resolvedPartnerOrgId: number | null = null;
      try {
        const attr = await resolveReferralAttribution(referralCode, contact.partnerOrgId);
        if (attr.partnerType === "partner_org" && attr.partnerOrgId) {
          if (!contact.partnerOrgId) {
            const orgUpdates: Record<string, unknown> = { partnerOrgId: attr.partnerOrgId, referralSource: attr.referralSource };
            if (attr.promoCode && !contact.promoCode) orgUpdates.promoCode = attr.promoCode;
            await storage.updateContact(contact.id, orgUpdates as Parameters<typeof storage.updateContact>[1]);
            resolvedPartnerOrgId = attr.partnerOrgId;
          } else {
            resolvedPartnerOrgId = contact.partnerOrgId;
            await storage.createAuditLog({ action: "attribution_preserved", entityType: "contact", entityId: contact.id, actorType: "system", details: { reason: "contact already has partnerOrgId", existing: contact.partnerOrgId, inbound: attr.partnerOrgId } });
          }
        } else if (attr.partnerType === "affiliate_partner" && attr.promoCode) {
          if (!contact.promoCode) {
            await storage.updateContact(contact.id, { promoCode: attr.promoCode, referralSource: attr.referralSource });
          } else {
            await storage.createAuditLog({ action: "attribution_preserved", entityType: "contact", entityId: contact.id, actorType: "system", details: { reason: "contact already has promoCode", existing: contact.promoCode, inbound: attr.promoCode } });
          }
        } else if (attr.partnerType !== "none" && attr.referralSource && !contact.referralSource) {
          await storage.updateContact(contact.id, { referralSource: attr.referralSource });
        }
      } catch (err) {
        console.error("[Attribution] statement-upload error:", err);
      }

      // Run the full 11-step conversion chain (fire-and-forget — merchant always gets 201).
      // Replay paths return early above, so everything below the claim runs exactly once
      // per approved Idempotency-Key — no need to serialize side effects behind the chain.
      const statementQueued = await persistAndEnqueueStatementCommand({
        contactId: contact.id,
        dealId: existingDealId || null,
        fileBuffer: statementFileBuffer,
        fileName: statementFileName,
        source: "website",
        businessName: businessName || undefined,
        partnerOrgId: resolvedPartnerOrgId,
        commandId,
        requestId: idempotencyKey,
         inboundRequestId: submissionId,
      });
      if (!statementQueued) {
        await markRecoverableFailed(commandId, {
          code: "STATEMENT_COMMAND_QUEUE_UNAVAILABLE",
        }).catch(() => {});
        await setInboundRequestLifecycle(
          submissionId,
          "failed",
          "STATEMENT_COMMAND_QUEUE_UNAVAILABLE",
        ).catch(() => {});
        ownedCommandId = null;
        ownedInboundRequestId = null;
        return res.status(503).json({ error: "REQUEST_PROCESSING_UNAVAILABLE" });
      }
      // Durable command/object/queue ownership has transferred. Later
      // route-local bookkeeping must not terminalize the worker-owned command.
      ownedCommandId = null;
      // The contact and protected-object command handoff both exist before
      // request orchestration creates request-derived sales work.
      const inboundResponse = await acceptInbound(req, {
        contactId: contact.id,
        dealId: existingDealId || null,
      });
      if (!inboundResponse) throw new Error("INBOUND_REQUEST_HANDOFF_MISSING");
      // Required inbound orchestration is now durable. Optional route-local
      // records below cannot rewrite the canonical request lifecycle.
      ownedInboundRequestId = null;

      // Fire-and-forget side effects — owner execution only (replays returned early above).
      // NOTE: statement_review enrollment is owned by enrollInInboundConfirmation inside
      // runStatementUploadChain (Step 9). Do NOT enroll here a second time.
      recordAnalyticsEvent({
        eventName: FORM_SUBMITTED,
        contactId: contact.id,
        sourceCategory: "website_form",
        formId: "statement_upload",
        vertical: vertical || undefined,
        utmSource: utmSource || undefined,
        utmMedium: utmMedium || undefined,
        utmCampaign: utmCampaign || undefined,
        utmContent: utmContent || undefined,
        utmTerm: utmTerm || undefined,
        gclidPresent: !!gclid,
        landingPage: landingPage || "/upload-statement",
        metadata: { formType: "statement_upload" },
      }).catch(() => {});
      trackReferral(referralCode, contactName, email, mobile, businessName).catch((err: Error) => console.error("Referral tracking error:", err));
      ingestBusinessFromContact(contact.id, "manual_upload", "website_statement").catch((err: Error) => console.warn("[Statement] Business ingest failed:", err));
      // Acknowledge canonical inbound persistence before accepting the form.
      const { recordInboundEvent } = await import("../services/communication-events");
      await recordInboundEvent({
        contactId: contact.id,
        channel: "form",
        provider: "internal",
        subject: `Statement Upload — ${businessName || email || "unknown"}`,
        status: "received",
        metadata: { formType: "statement_upload", submissionId, vertical: vertical || null },
      });
      // NOTE: enrollInInboundConfirmation is owned by Step 9 of runStatementUploadChain.
      // Do NOT call it here — that would duplicate the merchant confirmation for every
      // new upload and break idempotency (replay paths skip the chain entirely).

      await storage.createAuditLog({
        action: "statement_uploaded",
        entityType: "contact",
        entityId: contact.id,
        details: { source: "website", hasFile: !!statementFileBuffer },
      });

      // onStatementReceived() is now called inside runStatementUploadChain() (STEP 5b)
      // so it runs for all upload paths uniformly. Do not call it here again.

      res.status(202).json(inboundResponse);
    } catch (err: any) {
      // If we owned an idempotency slot and failed before/around handing off to
      // the chain, honestly mark it recoverable-failed so the key never replays
      // as a success and can be retried.
      if (ownedCommandId) {
        await markRecoverableFailed(ownedCommandId, {
          error: err?.message ?? "unknown error",
          code: err?.code ?? null,
        }).catch(() => { /* best-effort */ });
      }
      if (ownedInboundRequestId) {
        await setInboundRequestLifecycle(ownedInboundRequestId, "failed", "STATEMENT_UPLOAD_FAILED").catch(() => {});
      }
      res.status(400).json({ message: err.message || "Invalid submission" });
    }
  });

  app.post("/api/public/estimate", publicLeadRateLimit, async (req, res) => {
    try {
      const submissionId = (req as any).inboundRequestId;
      const schema = z.object({
        contactName: z.string().trim().min(1).max(120),
        businessName: z.string().trim().min(1).max(160),
        email: z.string().trim().email().max(160),
        phone: z.string().trim().min(10).max(40),
        vertical: z.enum(["Medical/Dental/Medspa", "Automotive", "Restaurant", "Home Services", "Retail", "Other"]),
        monthlyVolume: z.string().trim().min(1).max(40),
        totalFees: z.string().trim().min(1).max(40),
        currentProvider: z.string().max(120).optional(),
        notes: z.string().max(2000).optional(),
        pewcConsent: z.boolean().optional(),
        referralCode: z.string().max(120).optional(),
        utmSource: z.string().max(200).optional(),
        utmMedium: z.string().max(200).optional(),
        utmCampaign: z.string().max(200).optional(),
        utmContent: z.string().max(200).optional(),
        utmTerm: z.string().max(200).optional(),
        landingPage: z.string().max(1000).optional(),
        gclid: z.string().max(500).optional(),
        gclidPresent: z.boolean().optional(),
        fbclidPresent: z.boolean().optional(),
        msclkidPresent: z.boolean().optional(),
        referrerUrl: z.string().max(2000).optional(),
      }).strict();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        await failInbound(req, 400);
        return res.status(400).json({
          error: "INVALID_SUBMISSION",
          details: parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
        });
      }
      const { contactName, email, phone, monthlyVolume, totalFees, currentProvider, notes, pewcConsent: estimatePewcRaw, referralCode, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, landingPage, gclid, referrerUrl: estimateReferrerUrlBody } = parsed.data;
      const estimateReferrerUrl = estimateReferrerUrlBody
        || (typeof req.headers["referer"] === "string" ? req.headers["referer"] : undefined)
        || (typeof req.headers["referrer"] === "string" ? req.headers["referrer"] : undefined);
      const nameParts = (contactName || "").split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      const tags = ["src_website", "lead_estimate"];
      if (utmSource) tags.push(`utm_src_${utmSource}`);

      const normalizedEstimateEmail = email?.trim().toLowerCase() || null;
      const existingEstimateContact = normalizedEstimateEmail ? await storage.getContactByEmail(normalizedEstimateEmail) : null;
      let contact: Contact;
      if (existingEstimateContact) {
        contact = await processExistingPublicFormSubmission({
          existingContact: existingEstimateContact,
          permittedProfileUpdates: buildPublicContactPayload("estimate_form", {
            firstName, lastName, email, phone: phone || "",
            monthlyVolume, currentProvider, notes,
            utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
            landingPage: landingPage || "/estimate",
            gclid: gclid || undefined,
            referrerUrl: estimateReferrerUrl || undefined,
          }),
          incomingConsent: {},
          submissionId,
          formType: "estimate_form",
          requestEvidence: {
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
          },
        });
      } else {
        contact = await writeContact({
          mode: "local_first",
          mutation: {
            firstName, lastName, email, phone: phone || "",
            monthlyVolume, currentProvider, notes,
            utmSource: utmSource || undefined,
            utmMedium: utmMedium || undefined,
            utmCampaign: utmCampaign || undefined,
            utmContent: utmContent || undefined,
            utmTerm: utmTerm || undefined,
            landingPage: landingPage || "/estimate",
            gclid: gclid || undefined,
            referrerUrl: estimateReferrerUrl || undefined,
            status: "New",
            tags,
          },
          provenance: {
            sourceCategory: "website_form",
            sourceType: "estimate_form",
            eventKey: `form:estimate_form:${submissionId}`,
            actorType: "public",
          },
          actor: { actorType: "public" },
        });
      }

      if (estimatePewcRaw === true) {
        await recordPewcDecision({
          contactId: contact.id,
          checked: true,
          source: "estimate",
          ipAddress: req.ip || req.socket.remoteAddress || "unknown",
          userAgent: req.headers["user-agent"] || "unknown",
          eventKey: `estimate:${submissionId}`,
          details: { formType: "estimate", submissionId },
        });
      }

      const deal = await storage.createDeal({
        contactId: contact.id, pipeline: "sales", stage: "New Lead",
        totalVolume: monthlyVolume, totalFees,
        notes: `Estimate request. Volume: ${monthlyVolume}, Fees: ${totalFees}`,
        leadSource: utmSource ? `utm:${utmSource}` : "website",
        campaignName: utmCampaign || undefined,
        ...(contact.partnerOrgId ? { partnerOrgId: contact.partnerOrgId } : {}),
      });

      await storage.createNotification({
        channel: "#sales", title: "New Estimate Request",
        message: `${firstName} ${lastName} - Volume: ${monthlyVolume}, Fees: ${totalFees}`,
        type: "info",
      });

      recordAnalyticsEvent({
        eventName: FORM_SUBMITTED,
        contactId: contact.id,
        dealId: deal.id,
        sourceCategory: "website_form",
        formId: "estimate_form",
        utmSource: utmSource || undefined,
        utmMedium: utmMedium || undefined,
        utmCampaign: utmCampaign || undefined,
        utmContent: utmContent || undefined,
        utmTerm: utmTerm || undefined,
        gclidPresent: !!gclid,
        landingPage: landingPage || "/estimate",
        metadata: { formType: "estimate" },
      }).catch(() => {});
      recordAnalyticsEvent({
        eventName: DEAL_CREATED,
        contactId: contact.id,
        dealId: deal.id,
        sourceCategory: "website_form",
        formId: "estimate_form",
        utmSource: utmSource || undefined,
        utmMedium: utmMedium || undefined,
        utmCampaign: utmCampaign || undefined,
        metadata: { formType: "estimate", stage: "New Lead" },
      }).catch(() => {});
      trackReferral(referralCode, contactName, email, phone).catch(err => console.error("Referral tracking error:", err));
      resolveReferralAttribution(referralCode, contact.partnerOrgId).then(async attr => {
        if (attr.partnerType === "partner_org" && attr.partnerOrgId) {
          if (!contact.partnerOrgId) {
            const orgUpdates: Record<string, unknown> = { partnerOrgId: attr.partnerOrgId, referralSource: attr.referralSource };
            if (attr.promoCode && !contact.promoCode) orgUpdates.promoCode = attr.promoCode;
            await storage.updateContact(contact.id, orgUpdates as Parameters<typeof storage.updateContact>[1]);
            await storage.updateDeal(deal.id, { partnerOrgId: attr.partnerOrgId });
          } else {
            await storage.createAuditLog({ action: "attribution_preserved", entityType: "contact", entityId: contact.id, actorType: "system", details: { reason: "contact already has partnerOrgId", existing: contact.partnerOrgId, inbound: attr.partnerOrgId } });
          }
        } else if (attr.partnerType === "affiliate_partner" && attr.promoCode) {
          if (!contact.promoCode) {
            await storage.updateContact(contact.id, { promoCode: attr.promoCode, referralSource: attr.referralSource });
          } else {
            await storage.createAuditLog({ action: "attribution_preserved", entityType: "contact", entityId: contact.id, actorType: "system", details: { reason: "contact already has promoCode", existing: contact.promoCode, inbound: attr.promoCode } });
          }
        } else if (attr.partnerType !== "none" && attr.referralSource && !contact.referralSource) {
          await storage.updateContact(contact.id, { referralSource: attr.referralSource });
        }
      }).catch(err => console.error("[Attribution] estimate error:", err));
      ingestBusinessFromContact(contact.id, "manual_upload", "website_estimate").catch(err => console.warn("[Estimate] Business ingest failed:", err));
      res.status(201).json(await acceptInbound(req, { contactId: contact.id, dealId: deal.id }));
    } catch (err: any) {
      await failInbound(req, 400);
      res.status(400).json({ error: "INVALID_SUBMISSION" });
    }
  });

  app.post("/api/public/support", publicLeadRateLimit, async (req, res) => {
    try {
      const submissionId = (req as any).inboundRequestId;
      const schema = z.object({
        name: z.string().trim().min(1).max(120),
        businessName: z.string().trim().min(1).max(160),
        email: z.string().trim().email().max(160),
        mobile: z.string().trim().min(10).max(40),
        issueType: z.enum(["Funding / Deposits", "Terminal", "Chargeback / Dispute", "PCI Compliance", "Other"]),
        priority: z.enum(["Normal", "Urgent"]),
        message: z.string().trim().min(1).max(5000),
        consentSms: z.boolean().optional(),
      }).strict();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        await failInbound(req, 400);
        return res.status(400).json({
          error: "INVALID_SUBMISSION",
          details: parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
        });
      }
      const { name, businessName, email, mobile, issueType, priority, message: msg, consentSms } = parsed.data;
      const nameParts = (name || "").trim().split(" ").filter(Boolean);
      const firstName = nameParts[0] || "there";
      const lastName = nameParts.slice(1).join(" ") || "";

      const normalizedSupportEmail = email?.trim().toLowerCase() || null;
      const existingSupportContact = normalizedSupportEmail ? await storage.getContactByEmail(normalizedSupportEmail) : null;
      let contact: Contact;
      if (existingSupportContact) {
        contact = await processExistingPublicFormSubmission({
          existingContact: existingSupportContact,
          permittedProfileUpdates: buildPublicContactPayload("support_form", {
            firstName, lastName, email, phone: mobile || "",
            companyName: businessName,
          }),
          incomingConsent: { consentSms: consentSms === true ? true : undefined },
          submissionId,
          formType: "support_form",
          requestEvidence: {
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
          },
        });
      } else {
        contact = await writeContact({
          mode: "local_first",
          mutation: {
            firstName, lastName, email, phone: mobile || "",
            companyName: businessName,
            status: "Active",
            tags: ["src_website", "support_request", `support_${(issueType || "other").toLowerCase().replace(/[^a-z]/g, "_")}`],
          },
          provenance: {
            sourceCategory: "website_form",
            sourceType: "support_form",
            eventKey: `form:support_form:${submissionId}`,
            actorType: "public",
          },
          actor: { actorType: "public" },
        });
        // New contacts only: write the opt_in audit row here.
        // Existing contacts: processExistingPublicFormSubmission() writes opt_in (or
        // consent_reenable_blocked) audit rows inside its transaction — never both.
        if (consentSms) {
          await applyConsentCommand({
            subject: { type: "contact", id: contact.id },
            kind: "opt_in",
            channel: "sms",
            purpose: "outreach",
            eventNamespace: "public_form",
            eventKey: `support_form:${submissionId}:sms`,
            source: "website_form",
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
            evidence: { formType: "support", submissionId },
            details: { formType: "support", submissionId },
          });
        }
      }

      const ticket = await storage.createAuthorityTicket({
        contactId: contact.id,
        subject: `${issueType || "Support"} - ${businessName || firstName}`,
        description: msg || "",
        priority: priority || "Normal",
        category: issueType || "Other",
      }, {
        producer: "inbound_request",
        commandKey: `inbound:${(req as any).inboundRequestId}:ticket`,
        issueKey: `inbound-support:${(req as any).inboundRequestId}`,
      });

      const ackMessages: Record<string, string> = {
        "Funding / Deposits": `Hi ${firstName} — thanks for reaching out about a funding question. We know how important it is to have your deposits landing on time, so we're pulling up your account now.\n\nIf this is a same-day issue, feel free to call us directly at 954-266-8214 and we'll get right on it. Otherwise, someone from our team will follow up within a few hours with an update.\n\nHang tight — we're on it.`,
        "Terminal": `Hey ${firstName} — we got your message about your terminal. Whether it's acting up, needs a reset, or you're looking at a replacement, we deal with this stuff daily so we'll get you sorted out.\n\nIf your terminal is completely down and you can't take payments, call us at 954-266-8214 so we can walk you through a fix right away. Otherwise, expect a reply from our tech team shortly.\n\nAppreciate your patience.`,
        "Chargeback / Dispute": `Hi ${firstName} — thanks for letting us know about this. Chargebacks can be stressful, but the good news is we handle these all the time and we're going to walk you through exactly what to do.\n\nTime matters with disputes, so we've flagged this for priority review. A team member will reach out shortly with the specific documents you'll need and the steps to respond. In the meantime, don't worry — we've got your back on this.\n\nIf you have the transaction date and amount handy, that'll help us move faster.`,
        "PCI Compliance": `Hey ${firstName} — good on you for staying on top of PCI compliance. A lot of merchants overlook this until there's a problem, so we're glad you reached out.\n\nOur compliance team will take a look at your account status and let you know exactly where things stand — whether you need to complete your annual questionnaire, update anything, or if you're already good to go.\n\nYou'll hear from us soon. If you have any compliance notices or letters you've received, feel free to forward them to support@libertybancard.com so we can reference them.`,
      };
      const ackText = ackMessages[issueType] || `Hi ${firstName} — thanks for reaching out. We received your request and a team member is reviewing it now.\n\nYou can expect a personal follow-up within a few hours during business hours. If you need something handled immediately, you're always welcome to call us at 954-266-8214.\n\nWe appreciate your patience — we'll be in touch soon.`;

      await storage.createTicketComment({
        ticketId: ticket.id,
        content: ackText,
        authorName: "Liberty Bancard Support",
        isInternal: false,
      });

      await storage.createNotification({
        channel: "#support",
        title: `New ${priority || "Normal"} Support Ticket`,
        message: `${firstName} ${lastName} (${businessName || "N/A"}) — ${issueType || "General"}: ${(msg || "").slice(0, 120)}`,
        type: priority === "Urgent" ? "urgent" : "info",
        metadata: { ticketId: ticket.id, contactId: contact.id },
      });


      res.status(201).json(await acceptInbound(req, { contactId: contact.id, ticketId: ticket.id }));
    } catch (err: any) {
      await failInbound(req, 400);
      res.status(400).json({ error: "INVALID_SUBMISSION" });
    }
  });

  app.post("/api/public/get-started", publicLeadRateLimit, async (req, res) => {
    try {
      const submissionId = (req as any).inboundRequestId;
      const schema = z.object({
        goal: z.enum(["lower fees", "deposit clarity", "0% interest", "need terminal", "compare vs flat-rate", "not sure"]),
        vertical: z.enum(["Medical/Dental/Medspa", "Automotive", "Restaurant", "Home Services", "Retail", "Other"]),
        monthlyVolume: z.enum(["Under $5k", "$5k-$15k", "$15k-$50k", "$50k-$150k", "$150k+"]),
        needTerminal: z.boolean(),
        interestedIn0Percent: z.boolean(),
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(160),
        phone: z.string().trim().min(10).max(40),
        pewcConsent: z.boolean().optional(),
        referralCode: z.string().max(120).optional(),
        promoCode: z.string().max(120).optional(),
        utmSource: z.string().max(200).optional(),
        utmMedium: z.string().max(200).optional(),
        utmCampaign: z.string().max(200).optional(),
        utmContent: z.string().max(200).optional(),
        utmTerm: z.string().max(200).optional(),
        landingPage: z.string().max(1000).optional(),
        gclid: z.string().max(500).optional(),
        gclidPresent: z.boolean().optional(),
        fbclidPresent: z.boolean().optional(),
        msclkidPresent: z.boolean().optional(),
      }).strict();
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        await failInbound(req, 400);
        return res.status(400).json({
          error: "INVALID_SUBMISSION",
          details: parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
        });
      }
      const { goal, vertical, monthlyVolume, needTerminal, interestedIn0Percent, firstName, lastName, email, phone, pewcConsent, referralCode, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, landingPage, gclid } = parsed.data;

      let offerPath = "Not Sure";
      if (goal === "0% interest" || interestedIn0Percent) offerPath = "0% Program";
      else if (goal === "lower fees") offerPath = "Wholesale";
      else if (goal === "need terminal") offerPath = "Terminal Needed";
      else if (goal === "compare vs flat-rate") offerPath = "Compare vs Square/Stripe";

      const tags = ["src_website", "lead_quiz", `vertical_${(vertical || "unknown").toLowerCase().replace(/[^a-z]/g, "_")}`];
      if (utmSource) tags.push(`utm_src_${utmSource}`);
      if (utmMedium) tags.push(`utm_med_${utmMedium}`);
      if (utmCampaign) tags.push(`utm_camp_${utmCampaign}`);

      const normalizedGsEmail = email?.trim().toLowerCase() || null;
      const existingGsContact = normalizedGsEmail ? await storage.getContactByEmail(normalizedGsEmail) : null;
      let contact: Contact;
      if (existingGsContact) {
        contact = await processExistingPublicFormSubmission({
          existingContact: existingGsContact,
          permittedProfileUpdates: buildPublicContactPayload("get_started_form", {
            firstName, lastName, email, phone: phone || "",
            vertical, monthlyVolume, primaryOfferPath: offerPath,
            interestedIn0Percent: interestedIn0Percent === true,
            needTerminal: needTerminal === true,
            utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
            landingPage: landingPage || "/get-started",
            gclid: gclid || undefined,
          }),
          incomingConsent: {},
          submissionId,
          formType: "get_started_form",
          requestEvidence: {
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
          },
        });
      } else {
        contact = await writeContact({
          mode: "local_first",
          mutation: {
            firstName, lastName, email, phone: phone || "",
            vertical, monthlyVolume, primaryOfferPath: offerPath,
            interestedIn0Percent: interestedIn0Percent === true,
            needTerminal: needTerminal === true,
            utmSource: utmSource || undefined,
            utmMedium: utmMedium || undefined,
            utmCampaign: utmCampaign || undefined,
            utmContent: utmContent || undefined,
            utmTerm: utmTerm || undefined,
            landingPage: landingPage || "/get-started",
            gclid: gclid || undefined,
            status: "New",
            tags,
          },
          provenance: {
            sourceCategory: "website_form",
            sourceType: "get_started_form",
            eventKey: `form:get_started_form:${submissionId}`,
            actorType: "public",
          },
          actor: { actorType: "public" },
        });
      }

      if (pewcConsent === true) {
        await recordPewcDecision({
          contactId: contact.id,
          checked: true,
          source: "get_started",
          ipAddress: req.ip || req.socket.remoteAddress || "unknown",
          userAgent: req.headers["user-agent"] || "unknown",
          eventKey: `get_started:${submissionId}`,
          details: { formType: "get_started", submissionId },
        });
      }

      const deal = await storage.createDeal({
        contactId: contact.id, pipeline: "sales", stage: "New Lead",
        offerPath,
        leadSource: utmSource ? `utm:${utmSource}` : "website",
        campaignName: utmCampaign || undefined,
        ...(contact.partnerOrgId ? { partnerOrgId: contact.partnerOrgId } : {}),
      });

      await storage.createNotification({
        channel: "#sales", title: "New Quiz Lead",
        message: `${firstName} ${lastName} - ${vertical}, ${monthlyVolume}, Goal: ${goal}${utmSource ? ` (via ${utmSource})` : ""}`,
        type: "info",
      });

      recordAnalyticsEvent({
        eventName: FORM_SUBMITTED,
        contactId: contact.id,
        dealId: deal.id,
        sourceCategory: "website_form",
        formId: "get_started_form",
        vertical: vertical || undefined,
        utmSource: utmSource || undefined,
        utmMedium: utmMedium || undefined,
        utmCampaign: utmCampaign || undefined,
        utmContent: utmContent || undefined,
        utmTerm: utmTerm || undefined,
        gclidPresent: !!gclid,
        landingPage: landingPage || "/get-started",
        offerRoute: offerPath,
        metadata: { formType: "get_started", goal: goal || undefined },
      }).catch(() => {});
      recordAnalyticsEvent({
        eventName: DEAL_CREATED,
        contactId: contact.id,
        dealId: deal.id,
        sourceCategory: "website_form",
        formId: "get_started_form",
        vertical: vertical || undefined,
        utmSource: utmSource || undefined,
        utmMedium: utmMedium || undefined,
        utmCampaign: utmCampaign || undefined,
        offerRoute: offerPath,
        metadata: { formType: "get_started", stage: "New Lead" },
      }).catch(() => {});
      trackReferral(referralCode, `${firstName} ${lastName}`, email, phone).catch(err => console.error("Referral tracking error:", err));
      resolveReferralAttribution(referralCode, contact.partnerOrgId).then(async attr => {
        if (attr.partnerType === "partner_org" && attr.partnerOrgId) {
          if (!contact.partnerOrgId) {
            const orgUpdates: Record<string, unknown> = { partnerOrgId: attr.partnerOrgId, referralSource: attr.referralSource };
            if (attr.promoCode && !contact.promoCode) orgUpdates.promoCode = attr.promoCode;
            await storage.updateContact(contact.id, orgUpdates as Parameters<typeof storage.updateContact>[1]);
            await storage.updateDeal(deal.id, { partnerOrgId: attr.partnerOrgId });
          } else {
            await storage.createAuditLog({ action: "attribution_preserved", entityType: "contact", entityId: contact.id, actorType: "system", details: { reason: "contact already has partnerOrgId", existing: contact.partnerOrgId, inbound: attr.partnerOrgId } });
          }
        } else if (attr.partnerType === "affiliate_partner" && attr.promoCode) {
          if (!contact.promoCode) {
            await storage.updateContact(contact.id, { promoCode: attr.promoCode, referralSource: attr.referralSource });
          } else {
            await storage.createAuditLog({ action: "attribution_preserved", entityType: "contact", entityId: contact.id, actorType: "system", details: { reason: "contact already has promoCode", existing: contact.promoCode, inbound: attr.promoCode } });
          }
        } else if (attr.partnerType !== "none" && attr.referralSource && !contact.referralSource) {
          await storage.updateContact(contact.id, { referralSource: attr.referralSource });
        }
      }).catch(err => console.error("[Attribution] get-started error:", err));
      if (!contact.primaryOfferPath) {
        import("../services/offer-router").then(({ routeOfferDeterministic }) => {
          const deterministicResult = routeOfferDeterministic(contact);
          if (deterministicResult) {
            storage.updateContact(contact.id, {
              primaryOfferPath: deterministicResult.offerRoute,
              offerRoutingSource: deterministicResult.routingSource,
              offerConfidence: deterministicResult.offerConfidence,
              offerRoutedAt: new Date(),
              processorDetected: deterministicResult.processorDetected ?? null,
              offerMatchedSignals: deterministicResult.matchedSignals,
            }).catch(err => console.error("[OfferRouter] At-creation routing error:", err));
          }
        }).catch(err => console.error("[OfferRouter] Import error:", err));
      }
      generateDealBlueprint(deal.id).catch(err => console.error("Blueprint gen error:", err));
      storage.createReviewQueueItem({
        sourceType: "quiz",
        sourceId: contact.id,
        status: "pending",
        checklistState: {},
        metadata: {
          contactName: `${firstName} ${lastName}`.trim(),
          firstName,
          lastName,
          email,
          phone,
          vertical,
          monthlyVolume,
          goal,
          offerPath,
          source: "get_started",
          utmSource: utmSource || undefined,
          utmCampaign: utmCampaign || undefined,
          contactId: contact.id,
          dealId: deal.id,
        },
      }).catch((err: any) => console.error("[ReviewQueue] Get-started enqueue failed:", err.message));
      res.status(201).json(await acceptInbound(req, { contactId: contact.id, dealId: deal.id }));
    } catch (err: any) {
      await failInbound(req, 400);
      res.status(400).json({ error: "INVALID_SUBMISSION" });
    }
  });


  // === INTEGRATION REQUEST ===
  app.post("/api/public/integration-request", publicLeadRateLimit, async (req, res) => {
    try {
      const submissionId = (req as any).inboundRequestId;
      const schema = z.object({
        softwareName: z.string().min(1, "Software name is required").max(120),
        softwareCategory: z.string().max(80).optional().default(""),
        contactName: z.string().min(1, "Name is required").max(120),
        email: z.string().email("Valid email required").max(160),
        businessName: z.string().max(160).optional().default(""),
        phone: z.string().max(40).optional().default(""),
        notes: z.string().max(2000).optional().default(""),
      });
      const data = schema.parse(req.body);

      const nameParts = data.contactName.trim().split(" ").filter(Boolean);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      const softwareSlug = data.softwareName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "unknown";
      const tags = ["src_website", "lead_integration_request", `integration_${softwareSlug}`];

      const requestNote = `Integration request: ${data.softwareName}${data.softwareCategory ? ` (${data.softwareCategory})` : ""}.${data.notes ? ` Notes: ${data.notes}` : ""}`;

      const normalizedIrEmail = data.email?.trim().toLowerCase() || null;
      const existingIrContact = normalizedIrEmail ? await storage.getContactByEmail(normalizedIrEmail) : null;
      let contact: Contact;
      if (existingIrContact) {
        contact = await processExistingPublicFormSubmission({
          existingContact: existingIrContact,
          permittedProfileUpdates: buildPublicContactPayload("integration_request", {
            firstName, lastName, email: data.email,
            phone: data.phone || "",
            companyName: data.businessName || undefined,
            notes: requestNote,
          }),
          incomingConsent: {},
          submissionId,
          formType: "integration_request",
          requestEvidence: {
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
          },
        });
      } else {
        contact = await writeContact({
          mode: "local_first",
          mutation: {
            firstName,
            lastName,
            email: data.email,
            phone: data.phone || "",
            companyName: data.businessName || undefined,
            notes: requestNote,
            landingPage: "/integrations",
            status: "New",
            tags,
          },
          provenance: {
            sourceCategory: "website_form",
            sourceType: "integration_request",
            eventKey: `form:integration_request:${submissionId}`,
            actorType: "public",
          },
          actor: { actorType: "public" },
        });
      }

      await storage.createNotification({
        channel: "#sales",
        title: "Integration Request",
        message: `${firstName} ${lastName}${data.businessName ? ` (${data.businessName})` : ""} asked about ${data.softwareName}${data.softwareCategory ? ` — ${data.softwareCategory}` : ""}`,
        type: "info",
        metadata: { contactId: contact.id, software: data.softwareName, category: data.softwareCategory },
      });

      await storage.createAuditLog({
        action: "integration_requested",
        entityType: "contact",
        entityId: contact.id,
        details: {
          software: data.softwareName,
          category: data.softwareCategory,
          notes: data.notes,
          source: "website_integrations_page",
        },
      });


      res.status(201).json(await acceptInbound(req, { contactId: contact.id }));
    } catch (err: any) {
      await failInbound(req, 400);
      if (err?.issues) {
        return res.status(400).json({ error: "INVALID_SUBMISSION" });
      }
      res.status(400).json({ error: "INVALID_SUBMISSION" });
    }
  });

  // === CALLBACK REQUEST ===
  // Callback intake has no email identifier, so it resolves on normalized phone
  // only when that produces one unambiguous candidate. It does not write marketing
  // consent; PEWC consent remains on its separate evidence path.
  app.post("/api/public/callback", publicLeadRateLimit, async (req, res) => {
    try {
      const submissionId = (req as any).inboundRequestId;
      const { name, phone, bestTime, notes, pewcConsent: pewcConsentRaw } = req.body;
      const pewcConsent = pewcConsentRaw === true;
      const nameParts = (name || "").trim().split(/\s+/).filter(Boolean);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";
      const normalizedPhone = normalizePhoneE164(typeof phone === "string" ? phone : "");
      const phoneSuffix = normalizedPhone?.replace(/\D/g, "").slice(-10);
      const possibleMatches = phoneSuffix
        ? await db.select().from(contacts).where(and(
          isNull(contacts.archivedAt),
          sql`regexp_replace(${contacts.phone}, '[^0-9]', '', 'g') LIKE ${`%${phoneSuffix}`}`,
        ))
        : [];
      const matchingContacts = possibleMatches.filter(
        (candidate) => normalizePhoneE164(candidate.phone) === normalizedPhone,
      );

      if (matchingContacts.length > 1) {
        const review = await queueAmbiguousCallbackReview({
          requestId: submissionId,
          candidateContactIds: matchingContacts.map((candidate) => candidate.id),
          name: `${firstName} ${lastName}`.trim(),
          phone: normalizedPhone || phone,
          bestTime,
        });
        return res.status(201).json({ success: true, requestReceipt: review.id, status: review.lifecycleState });
      }

      let contact: Contact;
      if (matchingContacts.length === 1) {
        const existingContact = matchingContacts[0];
        const existingName = `${existingContact.firstName || ""} ${existingContact.lastName || ""}`.trim();
        const incomingName = `${firstName} ${lastName}`.trim();
        contact = await processExistingPublicFormSubmission({
          existingContact,
          permittedProfileUpdates: buildPublicContactPayload("callback_form", {
            ...(incomingName.length > existingName.length ? { firstName, lastName } : {}),
            phone: normalizedPhone || phone || "",
          }),
          incomingConsent: {},
          submissionId,
          formType: "callback_form",
          requestEvidence: {
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
          },
        });
      } else {
        contact = await writeContact({
          mode: "local_first",
          mutation: {
            firstName, lastName,
            // contacts.email is non-nullable and uniquely indexed. This follows
            // the existing no-email sentinel convention without pretending that
            // the callback supplied an email address.
            email: `no-email-${submissionId}@no-email.libertybancard.internal`,
            phone: normalizedPhone || phone || "",
            status: "New",
            tags: ["src_website", "lead_callback", `callback_${(bestTime || "anytime").toLowerCase().replace(/[^a-z]/g, "_")}`],
          },
          provenance: {
            sourceCategory: "website_form",
            sourceType: "callback_form",
            eventKey: `form:callback_form:${submissionId}`,
            actorType: "public",
          },
          actor: { actorType: "public" },
        });
      }

      const deal = await storage.createDeal({
        contactId: contact.id, pipeline: "sales", stage: "New Lead",
        notes: `Callback request. Best time: ${bestTime || "Anytime"}. Notes: ${notes || "None"}`,
      });

      await storage.createNotification({
        channel: "#sales", title: "Callback Requested",
        message: `${firstName} ${lastName} - ${phone} - Best time: ${bestTime || "Anytime"}`,
        type: "alert",
      });

      if (pewcConsent) {
        await recordPewcDecision({
          contactId: contact.id,
          checked: true,
          source: "callback",
          ipAddress: req.ip || req.socket.remoteAddress || "unknown",
          userAgent: req.headers["user-agent"] || "unknown",
          eventKey: `callback:${submissionId}`,
          details: { formType: "callback", submissionId },
        });
      }
      recordAnalyticsEvent({
        eventName: FORM_SUBMITTED,
        contactId: contact.id,
        dealId: deal.id,
        sourceCategory: "website_form",
        formId: "callback_form",
        metadata: { formType: "callback", bestTime: bestTime || "anytime" },
      }).catch(() => {});
      recordAnalyticsEvent({
        eventName: DEAL_CREATED,
        contactId: contact.id,
        dealId: deal.id,
        sourceCategory: "website_form",
        formId: "callback_form",
        metadata: { formType: "callback", stage: "New Lead" },
      }).catch(() => {});
      res.status(201).json(await acceptInbound(req, { contactId: contact.id, dealId: deal.id }));
    } catch (err: any) {
      await failInbound(req, 400);
      res.status(400).json({ error: "INVALID_SUBMISSION" });
    }
  });

  app.post("/api/equipment-order", publicLeadRateLimit, async (req, res) => {
    try {
      const submissionId = (req as any).inboundRequestId;
      const claimedRequest = (req as any).inboundRequest;
      if (!submissionId || claimedRequest?.id !== submissionId) {
        return res.status(503).json({ error: "INBOUND_REQUEST_CLAIM_REQUIRED" });
      }
      const { firstName, lastName, email, phone, businessName, message, items, referralCode, promoCode, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, landingPage } = req.body;
      if (!firstName || typeof firstName !== "string" || firstName.length > 100) {
        await failInbound(req, 400);
        return res.status(400).json({ error: "INVALID_SUBMISSION" });
      }
      if (!email || typeof email !== "string" || !email.includes("@") || email.length > 200) {
        await failInbound(req, 400);
        return res.status(400).json({ error: "INVALID_SUBMISSION" });
      }
      if (!phone || typeof phone !== "string" || phone.length > 30) {
        await failInbound(req, 400);
        return res.status(400).json({ error: "INVALID_SUBMISSION" });
      }
      if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
        await failInbound(req, 400);
        return res.status(400).json({ error: "INVALID_SUBMISSION" });
      }
      const validatedItems = items.map((i: any) => ({
        name: String(i.name || "").slice(0, 100),
        quantity: Math.min(Math.max(1, Number(i.quantity) || 1), 50),
        price: String(i.price || "").slice(0, 50),
      }));

      const safeLastName = String(lastName || "").slice(0, 100);
      const safeBusiness = String(businessName || "").slice(0, 200);
      const safeMessage = String(message || "").slice(0, 1000);
      const sanitizedPromo = promoCode
        ? String(promoCode).toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 20)
        : undefined;

      const orderTags = ["src_website", "lead_equipment_order", ...validatedItems.slice(0, 5).map((i: any) => `equip_${i.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`)];
      if (sanitizedPromo) orderTags.push(`promo_${sanitizedPromo.toLowerCase()}`);

      if (utmSource) orderTags.push(`utm_src_${utmSource}`);

      const normalizedEoEmail = email?.trim().toLowerCase() || null;
      const existingEoContact = normalizedEoEmail ? await storage.getContactByEmail(normalizedEoEmail) : null;
      let contact: Contact;
      if (existingEoContact) {
        contact = await processExistingPublicFormSubmission({
          existingContact: existingEoContact,
          permittedProfileUpdates: buildPublicContactPayload("equipment_order", {
            firstName: firstName.slice(0, 100), lastName: safeLastName,
            email: email.slice(0, 200), phone: phone.slice(0, 30),
            companyName: safeBusiness,
            utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
            landingPage: landingPage || "/shop",
          }),
          incomingConsent: {},
          submissionId,
          formType: "equipment_order",
          requestEvidence: {
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
          },
        });
      } else {
        contact = await writeContact({
          mode: "local_first",
          mutation: {
            firstName: firstName.slice(0, 100), lastName: safeLastName, email: email.slice(0, 200), phone: phone.slice(0, 30),
            companyName: safeBusiness,
            promoCode: sanitizedPromo,
            utmSource: utmSource || undefined,
            utmMedium: utmMedium || undefined,
            utmCampaign: utmCampaign || undefined,
            utmContent: utmContent || undefined,
            utmTerm: utmTerm || undefined,
            landingPage: landingPage || "/shop",
            status: "New",
            tags: orderTags,
          },
          provenance: {
            sourceCategory: "website_form",
            sourceType: "equipment_order",
            eventKey: `form:equipment_order:${submissionId}`,
            actorType: "public",
          },
          actor: { actorType: "public" },
        });
      }

      const itemSummary = validatedItems.map((i: any) => `${i.name} x${i.quantity} (${i.price})`).join(", ");
      const primaryTerminal = validatedItems[0]?.name || "Unknown";
      const allTerminals = validatedItems.map((i: any) => i.name).join(", ");
      const orderedAt = new Date();
      const fulfillmentDueAt = inboundSlaDueAt("fulfillment_request", claimedRequest.sourceReceivedAt);
      if (!fulfillmentDueAt) throw new Error("FULFILLMENT_SLA_UNAVAILABLE");

      const deal = await storage.createDeal({
        inboundRequestId: submissionId,
        contactId: contact.id, pipeline: "fulfillment", stage: "Order Received",
        notes: `Equipment order: ${itemSummary}. ${safeMessage}${sanitizedPromo ? `\nPromo Code: ${sanitizedPromo}` : ""}`.trim(),
        promoCode: sanitizedPromo,
        terminalRecommendation: allTerminals,
        terminalStatus: "Ordered — 24hr setup & testing before ship",
        hardwarePackage: allTerminals,
        leadSource: utmSource ? `utm:${utmSource}` : "website",
        campaignName: utmCampaign || undefined,
        ...(contact.partnerOrgId ? { partnerOrgId: contact.partnerOrgId } : {}),
      });

      const equipmentOrderIds: number[] = [];
      for (const [itemIndex, item] of validatedItems.entries()) {
        const order = await storage.createEquipmentOrder({
          inboundRequestId: submissionId,
          commandKey: `inbound:${submissionId}:equipment-order:${itemIndex}`,
          dealId: deal.id,
          contactId: contact.id,
          equipmentType: item.name,
          quantity: item.quantity,
          status: "pending",
          orderedAt,
          fulfillmentDueAt,
          notes: `Price: ${item.price}. 24-hour setup & testing period before shipment.`,
        });
        equipmentOrderIds.push(order.id);
      }

      const notification = await storage.createNotification({
        inboundRequestId: submissionId,
        commandKey: `inbound:${submissionId}:equipment-notification`,
        channel: "#sales", title: "Equipment Order Received",
        message: `${firstName} ${safeLastName} ordered: ${itemSummary}${sanitizedPromo ? ` (promo: ${sanitizedPromo})` : ""}`.slice(0, 500),
        type: "alert",
      });

      res.status(201).json(await acceptInbound(req, {
        contactId: contact.id,
        dealId: deal.id,
        equipmentOrderIds,
        notificationId: notification.id,
      }));
    } catch (err: any) {
      await failInbound(req, 400);
      res.status(400).json({ error: "INVALID_SUBMISSION" });
    }
  });

  app.get("/api/public/testimonials/approved", async (_req, res) => {
    try {
      const submissions = await storage.getPublishedTestimonialSubmissions();
      const sanitized = submissions.map((s) => {
        const firstName = (s.name || "").split(" ")[0] || "Anonymous";
        const lastInitial = ((s.name || "").split(" ")[1] || "").charAt(0);
        return {
          id: s.id,
          displayName: lastInitial ? `${firstName} ${lastInitial}.` : firstName,
          businessName: s.businessName,
          industry: s.industry,
          videoLink: s.videoLink,
          savingsAmount: s.savingsAmount,
          story: s.story,
          createdAt: s.createdAt,
        };
      });
      res.json(sanitized);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/public/testimonial-submit", publicLeadRateLimit, async (req, res) => {
    try {
      const submissionId = (req as any).inboundRequestId;
      const { name, businessName, email, phone, industry, videoLink, savingsAmount, story } = req.body;
      if (!name || typeof name !== "string" || name.length > 200) {
        await failInbound(req, 400);
        return res.status(400).json({ error: "INVALID_SUBMISSION" });
      }
      if (!email || typeof email !== "string" || !email.includes("@") || email.length > 200) {
        await failInbound(req, 400);
        return res.status(400).json({ error: "INVALID_SUBMISSION" });
      }
      if (!story || typeof story !== "string" || story.length < 10) {
        await failInbound(req, 400);
        return res.status(400).json({ error: "INVALID_SUBMISSION" });
      }
      const nameParts = (name || "").split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";
      const safePhone = String(phone || "").slice(0, 30);
      const safeBusiness = String(businessName || "").slice(0, 200);
      const safeIndustry = String(industry || "").slice(0, 100);
      const safeVideoLink = String(videoLink || "").slice(0, 500);
      const safeSavings = String(savingsAmount || "").slice(0, 100);
      const safeStory = String(story || "").slice(0, 5000);

      const normalizedTsEmail = email?.trim().toLowerCase() || null;
      const existingTsContact = normalizedTsEmail ? await storage.getContactByEmail(normalizedTsEmail) : null;
      let contact: Contact;
      if (existingTsContact) {
        contact = await processExistingPublicFormSubmission({
          existingContact: existingTsContact,
          permittedProfileUpdates: buildPublicContactPayload("testimonial_submit", {
            firstName, lastName, email, phone: safePhone,
          }),
          incomingConsent: {},
          submissionId,
          formType: "testimonial_submit",
          requestEvidence: {
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
          },
        });
      } else {
        contact = await writeContact({
          mode: "local_first",
          mutation: {
            firstName, lastName, email, phone: safePhone,
            status: "New",
            tags: ["src_testimonial_submit", "testimonial_prospect"],
          },
          provenance: {
            sourceCategory: "website_form",
            sourceType: "testimonial_submit",
            eventKey: `form:testimonial_submit:${submissionId}`,
            actorType: "public",
          },
          actor: { actorType: "public" },
        });
      }

      const submission = await storage.createTestimonialSubmission({
        name: `${firstName} ${lastName}`.trim().slice(0, 200),
        businessName: safeBusiness || null,
        email,
        phone: safePhone || null,
        industry: safeIndustry || null,
        videoLink: safeVideoLink || null,
        savingsAmount: safeSavings || null,
        story: safeStory,
        status: "pending",
        publish: false,
        contactId: contact.id,
        dealId: null,
      });

      await storage.createNotification({
        channel: "#marketing", title: "New Testimonial Submission",
        message: `${firstName} ${lastName} (${safeBusiness}) submitted their story. Savings: ${safeSavings || "Not specified"}. Review at /dashboard/testimonial-submissions`.slice(0, 500),
        type: "info",
      });

      res.status(201).json(await acceptInbound(req, { contactId: contact.id }));
    } catch (err: any) {
      await failInbound(req, 400);
      res.status(400).json({ error: "INVALID_SUBMISSION" });
    }
  });

  // === NEWSLETTER SIGNUP ===
  app.post("/api/newsletter/subscribe", publicLeadRateLimit, async (req, res) => {
    try {
      const submissionId = (req as any).inboundRequestId;
      const schema = z.object({
        firstName: z.string().min(1).max(100),
        email: z.string().email(),
        sourceArticle: z.string().max(200).optional(),
      });
      const { firstName, email, sourceArticle } = schema.parse(req.body);

      const provenanceMetadata: Record<string, unknown> = { source: "blog_inline" };
      if (sourceArticle) provenanceMetadata.source_article = sourceArticle;

      const normalizedNlEmail = email?.trim().toLowerCase() || null;
      const existingNlContact = normalizedNlEmail ? await storage.getContactByEmail(normalizedNlEmail) : null;
      let contact: Contact;
      if (existingNlContact) {
        contact = await processExistingPublicFormSubmission({
          existingContact: existingNlContact,
          permittedProfileUpdates: buildPublicContactPayload("newsletter_signup", {
            firstName, email,
          }),
          incomingConsent: {},
          submissionId,
          formType: "newsletter_signup",
          requestEvidence: {
            ipAddress: req.ip || req.socket.remoteAddress || "unknown",
            userAgent: req.headers["user-agent"] || "unknown",
          },
        });
        // processExistingPublicFormSubmission does not carry our provenance metadata,
        // so the contact_source_events row it writes lacks source_article.
        // Write a separate attribution row so the newsletter-article-signups analytics
        // query can count this existing contact's signup correctly.
        if (sourceArticle) {
          upsertContactSourceEvent({
            contactId: contact.id,
            provenance: {
              sourceCategory: "website_form",
              sourceType: "newsletter_signup",
              eventKey: `form:newsletter_article:${submissionId}`,
              actorType: "public",
              metadata: { source: "blog_inline", source_article: sourceArticle },
            },
          }).catch(err => console.error("[Newsletter] article attribution upsert:", err));
        }
      } else {
        contact = await writeContact({
          mode: "local_first",
          mutation: {
            firstName,
            lastName: "",
            email,
            phone: "",
            status: "New",
            tags: ["NEWSLETTER-SIGNUP", "src_blog"],
            referralSource: "newsletter",
            landingPage: "/blog",
          },
          provenance: {
            sourceCategory: "website_form",
            sourceType: "newsletter_signup",
            eventKey: `form:newsletter_signup:${submissionId}`,
            actorType: "public",
            metadata: provenanceMetadata,
          },
          actor: { actorType: "public" },
        });
      }

      res.status(201).json(await acceptInbound(req, { contactId: contact.id }));
    } catch (err: any) {
      await failInbound(req, 400);
      return res.status(400).json({ error: "INVALID_SUBSCRIPTION" });
    }
  });

  // ── CAN-SPAM unsubscribe endpoint ─────────────────────────────────────────
  // Handles both the human GET link and the RFC 8058 one-click POST that mail
  // providers send for List-Unsubscribe-Post. Both verify the same signed token
  // and apply the same consent command, keyed by the token's occurrence, so a
  // repeated or replayed request cannot double-apply or write a second event.
  const handleUnsubscribe = async (req: any, res: any) => {
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const result = verifyUnsubscribeToken(token);

    if (!result.valid) {
      return res.status(400).send(
        "<!DOCTYPE html><html><head><title>Invalid Link</title></head><body>" +
        "<h2>This unsubscribe link is invalid or has expired.</h2>" +
        "<p>If you wish to unsubscribe, please reply directly to any email you received and ask to be removed.</p>" +
        "</body></html>"
      );
    }

      const { contactId, occurrenceId } = result;

    try {
      const UNSUB_PAGE =
        "<!DOCTYPE html><html><head><title>Unsubscribed</title></head><body style='font-family:Arial,sans-serif;max-width:600px;margin:60px auto;text-align:center;'>" +
        "<h2 style='color:#333;'>You have been unsubscribed.</h2>" +
        "<p style='color:#666;'>You will no longer receive marketing emails from Liberty Bancard.</p>" +
        "<p style='color:#999;font-size:12px;'>If you unsubscribed by mistake or have questions, reply to any email we sent you.</p>" +
        "</body></html>";

      const contact = await storage.getContact(contactId);
      if (!contact) {
        return res.send(UNSUB_PAGE);
      }

      {
        const outcome = await applyConsentCommand({
          subject: { type: "contact", id: contactId },
          kind: "opt_out",
          channel: "email",
          purpose: "outreach",
          eventNamespace: "public_unsubscribe",
          eventKey: `contact:${contactId}:occurrence:${occurrenceId}`,
          source: "campaign_unsubscribe",
          evidence: { tokenVerified: true, source: "email_footer" },
          details: { source: "email_footer", email: contact.email },
        });

        if (outcome.applied) {
          // Write emailStatus + consentTier back to the contacts row so:
          //   1. evaluateContactability.deriveConsentTier() returns "opted_out"
          //   2. tests reading contact.consentTier directly see the update
          await db.update(contacts)
            .set({ emailStatus: "opted_out", consentTier: "opted_out" })
            .where(eq(contacts.id, contactId));

        await storage.createAuditLog({
          action: "contact_email_unsubscribed_via_link",
          entityType: "contact",
          entityId: contactId,
          actorType: "system",
          details: {
            source: "email_footer",
            contactId,
            email: contact.email,
          },
        });

        // Suppress New Lead auto-enrollment so the next hourly sweep won't re-enroll
        const { suppressNewLeadAutoEnrollmentForContact } = await import("../services/new-lead-enrollment-job");
        suppressNewLeadAutoEnrollmentForContact(contactId, "email_unsubscribe_link").catch((err: any) =>
          console.error("[unsubscribe] suppression error:", err?.message)
        );
        }
      }

      return res.send(UNSUB_PAGE);
    } catch (err: any) {
      console.error("[unsubscribe] error processing opt-out:", err?.message);
      return res.status(500).send(
        "<!DOCTYPE html><html><head><title>Error</title></head><body>" +
        "<h2>An error occurred.</h2>" +
        "<p>Please try again or reply directly to any email and ask to be removed.</p>" +
        "</body></html>"
      );
    }
  };
  app.get("/unsubscribe", handleUnsubscribe);
  app.post("/unsubscribe", handleUnsubscribe);

}
