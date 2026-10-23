import type { Express } from "express";
import { isAuthenticated, isDashboardUser } from "../replit_integrations/auth";
import rateLimit from "express-rate-limit";
import { publicLeadRateLimit } from "../middleware/public-rate-limit";

const partnerOrgLoginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts, please try again later." },
});
import { storage } from "../storage";
import { z } from "zod";
import { insertPartnerOrgSchema, insertPartnerOrgUserSchema } from "@shared/schema";
import { partnerOrgUsers } from "@shared/schema";
import { db } from "../db";
import { and, eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { upload } from "./helpers";
import path from "path";
import fs from "fs";
import { addNote, addTag, isSdrGhlConfigured } from "../services/sdr/ghl-client";
import { enrollInGhlWorkflow, enrollInGhlWorkflowCompliant } from "../services/ghl-workflows";
import { createContactLocalFirst } from "../services/contact-writer";
import { writeContact, upsertContactSourceEvent } from "../services/contact-writer";
import { claimPublicInbound } from "../services/public-inbound-intake";
import { orchestrateInboundRequest, setInboundRequestLifecycle } from "../services/inbound-request-authority";
import { describeAckReceiptState } from "../services/inbound-acknowledgement";
import { processExistingPublicFormSubmission } from "../services/public-form-submission";
import { buildPublicContactPayload } from "../services/public-form-payload";
import {
  createCoBrandedProposal,
  sendCoBrandedProposalEmail,
  trackProposalView,
  generateCoBrandedProposalHtml,
  generateCoBrandedProposalPdf,
} from "../services/co-branded-proposal";
import { logOperationalDiagnostic, serverError } from "../utils/server-error";
import { authorizeGhlRouteMutation, requireGhlRouteMutationAllowed } from "./ghl-mutation-pause";
import {
  isValidUUIDv4,
  computeRequestFingerprint,
  claimCommand,
  updateContext,
  updateCommandFKs,
  markSucceeded,
  markRecoverableFailed,
} from "../services/statement-upload-idempotency";
import { consumeAuthAction, isAuthActionValid, issueAuthAction, setAuthActionDelivery } from "../services/auth-actions";

function isPartnerOrgAdmin(req: any) {
  return req.session?.partnerOrgUserId && req.session?.partnerOrgId;
}
function authActionHeaders(res: any) {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Pragma", "no-cache"); res.setHeader("Referrer-Policy", "no-referrer");
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));

export function registerPartnerOrgsRoutes(app: Express) {
  // Cookie data is only a locator. A DB-backed credential version invalidates
  // every outstanding partner-org session after password recovery.
  app.use("/api/partner-org", async (req, _res, next) => {
    const session = req.session as any;
    if (!session?.partnerOrgUserId) return next();
    try {
      const user = await storage.getPartnerOrgUser(session.partnerOrgUserId);
      if (!user || user.status !== "active" || session.partnerOrgSessionVersion !== user.sessionVersion) {
        return req.session.destroy(() => next());
      }
      return next();
    } catch {
      return req.session.destroy(() => next());
    }
  });
  // ── Public: get branding by slug (no auth required) ────────────────────────
  app.get("/api/partner-org/:slug/branding", async (req, res) => {
    try {
      const org = await storage.getPartnerOrgBySlug(req.params.slug);
      if (!org || org.status !== "active") {
        return res.status(404).json({ message: "Partner portal not found." });
      }
      res.json({
        id: org.id,
        name: org.name,
        slug: org.slug,
        logoUrl: org.logoUrl,
        primaryColor: org.primaryColor,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Public: submit contact from partner branded page (no auth required) ────
  app.post("/api/contacts/public", publicLeadRateLimit, async (req, res) => {
    if (req.query.probe === "1") return res.json({ probe: true, endpoint: "/api/contacts/public" });
    try {
      const {
        firstName, lastName, email, phone, companyName,
        monthlyVolume, utmSource, utmMedium, utmCampaign,
      } = req.body;

      if (!firstName || !email) {
        return res.status(400).json({ message: "First name and email are required." });
      }

      // Canonical inbound path: claim the occurrence before any write (UUIDv4 Idempotency-Key required).
      const inbound = await claimPublicInbound(req, res, ["partner_referral", "partner_portal"], {
        firstName, lastName, email, phone, companyName, monthlyVolume, utmCampaign,
      });
      if (!inbound) return;

      try {
        // Resolve partnerOrgId server-side from slug (utmCampaign holds the slug); ignore client-supplied id
        let resolvedOrgId: number | null = null;
        if (utmCampaign) {
          const org = await storage.getPartnerOrgBySlug(utmCampaign);
          if (org && org.status === "active") resolvedOrgId = org.id;
        }

        const normalizedEmail = String(email).trim().toLowerCase().slice(0, 300);
        const profile = {
          firstName: String(firstName).slice(0, 200),
          lastName: lastName ? String(lastName).slice(0, 200) : "",
          email: normalizedEmail,
          phone: phone ? String(phone).slice(0, 50) : "",
          companyName: companyName ? String(companyName).slice(0, 300) : null,
          notes: monthlyVolume ? `Monthly volume estimate: ${monthlyVolume}` : null,
        };
        const existingContact = await storage.getContactByEmail(normalizedEmail);
        const contact = existingContact
          ? await processExistingPublicFormSubmission({
              existingContact,
              permittedProfileUpdates: buildPublicContactPayload("partner_portal_form", {
                ...profile,
                companyName: profile.companyName ?? undefined,
                notes: undefined,
                utmSource: utmSource || "partner_portal",
                utmMedium: utmMedium || "white_label",
                utmCampaign: utmCampaign || undefined,
                landingPage: "/partner/" + (utmCampaign || ""),
              }),
              incomingConsent: {},
              submissionId: inbound.id,
              formType: "partner_portal_form",
              requestEvidence: {
                ipAddress: req.ip || req.socket.remoteAddress || "unknown",
                userAgent: req.headers["user-agent"] || "unknown",
              },
            })
          : await writeContact({
              mode: "local_first",
              mutation: {
                ...profile,
                status: "New",
                utmSource: utmSource || "partner_portal",
                utmMedium: utmMedium || "white_label",
                utmCampaign: utmCampaign || null,
                landingPage: "/partner/" + (utmCampaign || ""),
                partnerOrgId: resolvedOrgId,
                tags: ["partner_portal", utmCampaign ? `partner_${utmCampaign}` : "partner"].filter(Boolean),
              },
              provenance: {
                sourceCategory: "partner_referral",
                sourceType: "partner_portal",
                eventKey: `form:partner_portal:${inbound.id}`,
                actorType: "public",
              },
              actor: { actorType: "public" },
            });

        // This occurrence's own provenance (awaited): the inbound authority admits an unclassified contact into the
        // management review path only with exact evidence for this request.
        await upsertContactSourceEvent({
          contactId: contact.id,
          provenance: {
            eventKey: `form:partner_portal:${inbound.id}`,
            sourceCategory: "partner_referral",
            sourceType: "partner_portal",
            actorType: "public",
          },
        });

        // Assignment, the follow-up task, and the receipt belong to the inbound authority. This handler no longer
        // scores, routes, enrolls, or fires workflows directly, and it promises no response time.
        const orchestrated = await orchestrateInboundRequest({ requestId: inbound.id, contactId: contact.id });
        const emailReceipt = await describeAckReceiptState(inbound.id);

        res.status(201).json({
          message: "Thank you. Your request has been received.",
          requestReceipt: inbound.id,
          status: orchestrated.lifecycleState,
          emailReceipt,
        });
      } catch (err) {
        await setInboundRequestLifecycle(inbound.id, "failed", "PARTNER_PORTAL_INTAKE_FAILED").catch(() => undefined);
        throw err;
      }
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Public: partner portal statement upload (no auth required) ─────────────
  app.post("/api/statements/upload", publicLeadRateLimit, upload.single("file"), async (req, res) => {
    // ── Idempotency-Key validation (required before any mutations) ────────────
    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined)?.trim();
    if (!idempotencyKey) {
      return res.status(400).json({
        message: "Idempotency-Key header is required.",
        code: "IDEMPOTENCY_KEY_REQUIRED",
      });
    }
    if (!isValidUUIDv4(idempotencyKey)) {
      return res.status(400).json({
        message: "Idempotency-Key must be a valid UUID v4.",
        code: "IDEMPOTENCY_KEY_INVALID",
      });
    }

    let commandId: string | undefined;

    try {
      const { email, partnerSlug } = req.body;
      if (!email) {
        return res.status(400).json({ message: "Email is required." });
      }

      const fileBuffer = req.file?.buffer ?? Buffer.alloc(0);
      const rawName = req.file?.originalname || `statement_${Date.now()}`;
      const fileName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");

      // ── Compute fingerprint from normalized partner/merchant fields + file bytes
      const fingerprint = computeRequestFingerprint({
        fields: {
          email: email.toLowerCase(),
          partnerSlug: partnerSlug ?? "",
          firstName: (req.body.firstName ?? "").toLowerCase(),
          lastName: (req.body.lastName ?? "").toLowerCase(),
          phone: req.body.phone ?? "",
          companyName: req.body.companyName ?? "",
          fileName,
        },
        fileBuffer,
      });

      // ── Owner scope: non-reversible identity from slug + email (no session on public route)
      // We use "partner:<slug>:email:<email>" so each (partner, submitter) pair is isolated.
      const ownerScope = `partner:${partnerSlug ?? "direct"}:email:${email.toLowerCase()}`;

      // ── Claim the idempotency slot ─────────────────────────────────────────
      const claim = await claimCommand({
        requestId: idempotencyKey,
        fingerprint,
        ownerScope,
        source: "partner_portal_web",
        context: {
          email: email.toLowerCase(),
          partnerSlug: partnerSlug ?? null,
          firstName: req.body.firstName ?? null,
          lastName: req.body.lastName ?? null,
          phone: req.body.phone ?? null,
          companyName: req.body.companyName ?? null,
          fileName,
          hasFile: !!req.file,
        },
      });

      if (claim.outcome === "scope_mismatch") {
        return res.status(403).json({
          message: "This Idempotency-Key was issued under a different partner/email scope.",
          code: "IDEMPOTENCY_KEY_SCOPE_MISMATCH",
        });
      }

      if (claim.outcome === "conflict") {
        return res.status(409).json({
          message: "This Idempotency-Key was already used with different request data.",
          code: "IDEMPOTENCY_KEY_CONFLICT",
        });
      }

      if (claim.outcome === "claimed_by_other") {
        res.setHeader("Idempotency-Key", idempotencyKey);
        res.setHeader("X-Request-Id", claim.commandId);
        return res.status(202).json({
          message: "Upload already in progress.",
          code: "IN_PROGRESS",
          requestId: claim.commandId,
        });
      }

      if (claim.outcome === "replay") {
        // Return the stored successful result verbatim.
        const stored = claim.command.result as Record<string, unknown> | null;
        res.setHeader("Idempotency-Key", idempotencyKey);
        res.setHeader("X-Request-Id", claim.command.id);
        res.setHeader("X-Idempotency-Replay", "true");
        return res.status(200).json(
          stored ?? { message: "Statement received! We'll prepare your savings analysis within 24 hours." }
        );
      }

      if (claim.outcome === "recoverable_failed_replay") {
        // Prior attempt for this key failed recoverably — return the honest
        // stored failure; never fall through to a fresh mutation.
        const stored = claim.command.result as Record<string, unknown> | null;
        res.setHeader("Idempotency-Key", idempotencyKey);
        res.setHeader("X-Request-Id", claim.command.id);
        res.setHeader("X-Idempotency-Replay", "true");
        return res.status(422).json({
          message: "A prior upload with this Idempotency-Key failed. Use a new Idempotency-Key to retry.",
          code: "IDEMPOTENCY_KEY_RECOVERABLE_FAILED",
          ...(stored ?? {}),
        });
      }

      // outcome === "claimed" — we own the slot, proceed with mutations.
      commandId = claim.command.id;
      res.setHeader("Idempotency-Key", idempotencyKey);
      res.setHeader("X-Request-Id", commandId);

      // ── Resolve partnerOrgId server-side from slug; ignore client-supplied partnerOrgId
      let orgId: number | null = null;
      if (partnerSlug) {
        const org = await storage.getPartnerOrgBySlug(partnerSlug);
        if (org && org.status === "active") orgId = org.id;
      }

      let contact = await storage.getContactByEmail(email.toLowerCase());
      if (!contact) {
        contact = await createContactLocalFirst({
          firstName: req.body.firstName || email.split("@")[0],
          lastName: req.body.lastName || "",
          email: email.toLowerCase(),
          phone: req.body.phone || null,
          companyName: req.body.companyName || null,
          status: "New",
          utmSource: "partner_portal",
          utmMedium: "white_label",
          utmCampaign: partnerSlug || null,
          partnerOrgId: orgId,
          tags: ["partner_portal", partnerSlug ? `partner_${partnerSlug}` : "partner"].filter(Boolean),
        } as any, undefined, {
          sourceCategory: "partner_referral",
          sourceType: "partner_portal",
          eventKey: `partner-portal:${partnerSlug ?? "direct"}:${email.toLowerCase()}`,
        });
      } else if (orgId && !contact!.partnerOrgId) {
        await storage.updateContact(contact!.id, { partnerOrgId: orgId });
        contact = { ...contact, partnerOrgId: orgId };
      }

      // Update command FK and context with resolved contactId
      await updateCommandFKs(commandId, { contactId: contact!.id });
      await updateContext(commandId, {
        email: email.toLowerCase(),
        partnerSlug: partnerSlug ?? null,
        contactId: contact!.id,
        orgId,
        hasFile: !!req.file,
      });

      const deal = await storage.createDeal({
        contactId: contact!.id,
        pipeline: "sales",
        stage: "Statement Received",
        leadSource: "partner_portal",
        campaignName: partnerSlug || undefined,
        notes: `Statement uploaded via partner portal${partnerSlug ? ` (${partnerSlug})` : ""}.`,
        partnerOrgId: orgId || undefined,
      });

      // Update command FK with dealId
      await updateCommandFKs(commandId, { contactId: contact!.id, dealId: deal.id });

      let documentId: number | undefined;
      if (fileBuffer.length > 0) {
        const uploadsDir = path.join(process.cwd(), "uploads");
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const diskFileName = `${Date.now()}_${fileName}`;
        fs.writeFileSync(path.join(uploadsDir, diskFileName), fileBuffer);
        const doc = await storage.createDocument({
          type: "merchant_statement",
          fileName,
          storageKey: `statements/${diskFileName}`,
          dealId: deal.id,
          contactId: contact!.id,
          accessScope: "internal",
        });
        documentId = doc?.id;
        if (documentId) {
          await updateCommandFKs(commandId, { contactId: contact!.id, dealId: deal.id, documentId });
        }
      }

      await storage.updateDeal(deal.id, { statementReceived: true, docReadinessScore: fileBuffer.length > 0 ? 2 : 1 });
      await storage.createAuthorityTask({
        dealId: deal.id, contactId: contact!.id,
        title: "Review partner statement + send breakdown",
        assignedTo: "Scott Stevenson",
        dueDate: new Date(Date.now() + 2 * 60 * 60 * 1000),
        priority: "high",
      });
      await storage.createAuditLog({ action: "statement_uploaded", entityType: "contact", entityId: contact!.id, details: { source: "partner_portal", partnerSlug, hasFile: fileBuffer.length > 0 } });

      const { isSmtpConfigured: checkSmtpUpload } = await import("../services/smtp-email");
      // Use actual GHL upsert outcome (ghlContactId set) not just config presence
      const ghlUploadSucceeded = !!contact!.ghlContactId;
      const smtpUploadAvailable = checkSmtpUpload();
      const commsAvailable = ghlUploadSucceeded || smtpUploadAvailable;
      if (!commsAvailable) {
        logOperationalDiagnostic("partner_portal_upload_notification", new Error("delivery unavailable"), "outbound_delivery_unavailable", { contactId: contact!.id });
      }

      const responseBody: Record<string, unknown> = {
        message: "Statement received! We'll prepare your savings analysis within 24 hours.",
        ...(commsAvailable ? {} : { warning: "Statement saved. Confirmation email may be delayed — communications not yet configured." }),
      };

      // ── Mark command succeeded and persist result ─────────────────────────
      await markSucceeded(commandId, responseBody);

      res.status(201).json(responseBody);
    } catch (err: any) {
      // ── Mark command as recoverable-failed if we own the slot ────────────
      if (commandId) {
        await markRecoverableFailed(commandId, {
          error: err?.message ?? "unknown error",
          code: err?.code ?? null,
        }).catch(() => { /* best-effort */ });
      }
      serverError(res, err);
    }
  });

  // Public auth-action routes intentionally expose neither identity nor account state.
  app.post("/api/partner-org/auth-action/validate", publicLeadRateLimit, async (req, res) => {
    authActionHeaders(res);
    const purpose = req.body?.purpose;
    const valid = (purpose === "partner_org_activation" || purpose === "partner_org_password_reset")
      && await isAuthActionValid(typeof req.body?.token === "string" ? req.body.token : "", purpose);
    res.status(valid ? 200 : 400).json({ valid: !!valid });
  });
  app.post("/api/partner-org/auth-action/consume", publicLeadRateLimit, async (req, res) => {
    authActionHeaders(res);
    const { token, password, purpose } = req.body ?? {};
    if ((purpose !== "partner_org_activation" && purpose !== "partner_org_password_reset") ||
      typeof token !== "string" || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ message: "This link is invalid or expired." });
    }
    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const consumed = await consumeAuthAction({
        token, purpose,
        mutate: async (subject, tx) => {
          if (subject.type !== "partner_org_user") return false;
          const [user] = await tx.select().from(partnerOrgUsers).where(eq(partnerOrgUsers.id, Number(subject.id)));
          if (!user) return false;
          await tx.update(partnerOrgUsers).set({
            passwordHash, status: "active", sessionVersion: sql`${partnerOrgUsers.sessionVersion} + 1`,
          }).where(eq(partnerOrgUsers.id, user.id));
          return true;
        },
      });
      return res.status(consumed.ok && consumed.value ? 200 : 400).json({
        message: consumed.ok && consumed.value ? "Password updated." : "This link is invalid or expired.",
      });
    } catch {
      return res.status(500).json({ message: "Unable to complete this request." });
    }
  });

  // ── Partner org login ───────────────────────────────────────────────────────
  app.post("/api/partner-org/login", partnerOrgLoginRateLimit, async (req, res) => {
    try {
      const { email, password, slug } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required." });
      }

      // Resolve org by slug first (if provided) so login is strictly scoped to that org
      let user = null;
      let resolvedOrg = null;
      if (slug) {
        resolvedOrg = await storage.getPartnerOrgBySlug(slug);
        if (!resolvedOrg || resolvedOrg.status !== "active") {
          return res.status(404).json({ message: "Partner portal not found or inactive." });
        }
        user = await storage.getPartnerOrgUserByEmailAndOrg(email.toLowerCase(), resolvedOrg.id);
      } else {
        user = await storage.getPartnerOrgUserByEmail(email.toLowerCase());
      }

      if (!user || !user.passwordHash) {
        return res.status(401).json({ message: "Invalid email or password." });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ message: "Invalid email or password." });
      }
      if (user.status !== "active") {
        return res.status(403).json({ message: "Account is not active." });
      }

      const org = resolvedOrg || await storage.getPartnerOrg(user.partnerOrgId);

      if (!org) {
        return res.status(404).json({ message: "Partner organization not found." });
      }
      if (org.status !== "active") {
        return res.status(403).json({ message: "This partner portal is currently inactive." });
      }

      (req.session as any).partnerOrgUserId = user.id;
      (req.session as any).partnerOrgId = org.id;
      (req.session as any).partnerOrgSlug = org.slug;
       (req.session as any).partnerOrgSessionVersion = user.sessionVersion;

      res.json({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role },
        org: { id: org.id, name: org.name, slug: org.slug, logoUrl: org.logoUrl, primaryColor: org.primaryColor },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Partner org session check ───────────────────────────────────────────────
  app.get("/api/partner-org/session", async (req, res) => {
    try {
      const partnerOrgUserId = (req.session as any).partnerOrgUserId;
      if (!partnerOrgUserId) {
        return res.status(401).json({ message: "Not authenticated." });
      }
      const user = await storage.getPartnerOrgUser(partnerOrgUserId);
      if (!user || user.status !== "active" || (req.session as any).partnerOrgSessionVersion !== user.sessionVersion) {
        return res.status(401).json({ message: "Session invalid." });
      }
      const org = await storage.getPartnerOrg(user.partnerOrgId);
      if (!org || org.status !== "active") {
        return res.status(403).json({ message: "Partner portal is inactive." });
      }
      res.json({
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role },
        org: { id: org.id, name: org.name, slug: org.slug, logoUrl: org.logoUrl, primaryColor: org.primaryColor },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Partner org logout ──────────────────────────────────────────────────────
  app.post("/api/partner-org/logout", (req, res) => {
    delete (req.session as any).partnerOrgUserId;
    delete (req.session as any).partnerOrgId;
    delete (req.session as any).partnerOrgSlug;
    res.json({ message: "Logged out." });
  });

  // ── Partner org dashboard (pipeline, contacts, commission) ──────────────────
  app.get("/api/partner-org/dashboard", async (req, res) => {
    try {
      const partnerOrgUserId = (req.session as any).partnerOrgUserId;
      const partnerOrgId = (req.session as any).partnerOrgId;
      if (!partnerOrgUserId || !partnerOrgId) {
        return res.status(401).json({ message: "Please log in." });
      }
      const org = await storage.getPartnerOrg(partnerOrgId);
      if (!org) return res.status(404).json({ message: "Organization not found." });

      const [orgDeals, orgContacts] = await Promise.all([
        storage.getDealsByPartnerOrg(partnerOrgId),
        storage.getContactsByPartnerOrg(partnerOrgId),
      ]);

      const closedDeals = orgDeals.filter(d => d.stage === "Closed Won");
      const pipelineDeals = orgDeals.filter(d => d.stage !== "Closed Won" && d.stage !== "Closed Lost");

      const totalCommission = closedDeals.reduce((sum, d) => {
        const rev = parseFloat(d.estMonthlyRevenue || "0");
        return sum + rev * (org.commissionRate || 10) / 100;
      }, 0);

      const now = new Date();
      const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const mtdDeals = closedDeals.filter(d => d.closedAt && new Date(d.closedAt) >= mtdStart);
      const mtdCommission = mtdDeals.reduce((sum, d) => {
        const rev = parseFloat(d.estMonthlyRevenue || "0");
        return sum + rev * (org.commissionRate || 10) / 100;
      }, 0);

      res.json({
        org: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          logoUrl: org.logoUrl,
          primaryColor: org.primaryColor,
          commissionRate: org.commissionRate,
        },
        kpis: {
          totalLeads: orgContacts.length,
          pipelineDeals: pipelineDeals.length,
          closedDeals: closedDeals.length,
          commissionMTD: Math.round(mtdCommission * 100) / 100,
          totalCommissionEarned: Math.round(totalCommission * 100) / 100,
        },
        deals: orgDeals.slice(0, 100).map(d => ({
          id: d.id,
          stage: d.stage,
          pipeline: d.pipeline,
          contactId: d.contactId,
          estMonthlyRevenue: d.estMonthlyRevenue,
          closedAt: d.closedAt,
          createdAt: d.createdAt,
          estimatedCommission: (() => {
            const rev = parseFloat(d.estMonthlyRevenue || "0");
            return Math.round(rev * (org.commissionRate || 10) / 100 * 100) / 100;
          })(),
        })),
        contacts: orgContacts.slice(0, 100).map(c => ({
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          companyName: c.companyName,
          status: c.status,
          createdAt: c.createdAt,
        })),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Partner org: invite a sub-agent/member (uses partner org session) ────────
  app.post("/api/partner-org/invite-user", async (req, res) => {
    if (!isPartnerOrgAdmin(req)) {
      return res.status(401).json({ message: "Please log in to your partner portal." });
    }
    const partnerOrgId = (req.session as any).partnerOrgId;
    try {
      const inviter = await storage.getPartnerOrgUser((req.session as any).partnerOrgUserId);
      if (!inviter || inviter.role !== "admin") {
        return res.status(403).json({ message: "Only org admins can invite team members." });
      }
      const { email, firstName, lastName, role } = req.body;
      if (!email || !firstName) {
        return res.status(400).json({ message: "Email and first name are required." });
      }
      const existing = await storage.getPartnerOrgUserByEmail(email.toLowerCase());
      if (existing && existing.partnerOrgId === partnerOrgId) {
        return res.status(409).json({ message: "A user with this email already exists in your org." });
      }
      const user = await storage.createPartnerOrgUser({
        partnerOrgId,
        email: email.toLowerCase(),
        firstName,
        lastName: lastName || "",
        role: role || "member",
        status: "pending",
      });
      const action = await issueAuthAction({
        purpose: "partner_org_activation", subject: { type: "partner_org_user", id: user.id }, ttlMs: 72 * 60 * 60 * 1000,
      });
      const { sendSmtpEmail, isSmtpConfigured } = await import("../services/smtp-email");
      if (!isSmtpConfigured()) {
        await setAuthActionDelivery(action.id, "definite_failure");
        return res.status(503).json({ message: "Unable to send invitation." });
      }
      const baseUrl = process.env.APP_URL || "https://libertybancard.com";
      try {
        const result = await sendSmtpEmail({
          to: email.toLowerCase(), subject: "Activate your Liberty Bancard Partner Portal account",
          html: `<p>Hi ${escapeHtml(firstName)},</p><p><a href="${baseUrl}/partner-org/login#action=activate&token=${encodeURIComponent(action.token)}">Activate your account</a></p>`,
          category: "partners",
        });
        await setAuthActionDelivery(action.id, result.success ? "sent" : "definite_failure");
        if (!result.success) return res.status(503).json({ message: "Unable to send invitation." });
      } catch {
        await setAuthActionDelivery(action.id, "ambiguous");
        return res.status(503).json({ message: "Unable to send invitation." });
      }
      const { passwordHash: _ph, ...safeUser } = user;
      res.status(201).json(safeUser);
    } catch (err: any) {
      serverError(res, err, "partner_org_team_invite");
    }
  });

  // ── Partner org: list team members (admin role within org required) ─────────
  app.get("/api/partner-org/team", async (req, res) => {
    if (!isPartnerOrgAdmin(req)) {
      return res.status(401).json({ message: "Please log in to your partner portal." });
    }
    const partnerOrgId = (req.session as any).partnerOrgId;
    try {
      const requester = await storage.getPartnerOrgUser((req.session as any).partnerOrgUserId);
      if (!requester || requester.role !== "admin") {
        return res.status(403).json({ message: "Only org admins can view the team roster." });
      }
      const users = await storage.getPartnerOrgUsers(partnerOrgId);
      res.json(users.map(({ passwordHash: _ph, ...u }) => u));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: list all partner orgs ────────────────────────────────────────────
  app.get("/api/partner-orgs", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const orgs = await storage.getPartnerOrgs();
      res.json(orgs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: get single partner org ───────────────────────────────────────────
  app.get("/api/partner-orgs/:id", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const org = await storage.getPartnerOrg(Number(req.params.id));
      if (!org) return res.status(404).json({ message: "Not found." });
      res.json(org);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: create partner org ───────────────────────────────────────────────
  app.post("/api/partner-orgs", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const input = insertPartnerOrgSchema.parse(req.body);
      const slug = input.slug || input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const existing = await storage.getPartnerOrgBySlug(slug);
      if (existing) {
        return res.status(409).json({ message: "A partner org with this slug already exists." });
      }
      const org = await storage.createPartnerOrg({ ...input, slug });
      res.status(201).json(org);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.errors[0].message });
      }
      res.status(400).json({ message: err.message });
    }
  });

  // ── Admin: update partner org ───────────────────────────────────────────────
  app.patch("/api/partner-orgs/:id", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const updates = req.body;
      const org = await storage.updatePartnerOrg(Number(req.params.id), updates);
      if (!org) return res.status(404).json({ message: "Not found." });
      res.json(org);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // ── Admin: upload partner org logo (#159) ──────────────────────────────────
  app.post("/api/partner-orgs/:id/logo", isAuthenticated, upload.single("logo"), async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const orgId = Number(req.params.id);
      const org = await storage.getPartnerOrg(orgId);
      if (!org) return res.status(404).json({ message: "Partner org not found." });

      if (!req.file) return res.status(400).json({ message: "No file uploaded." });

      const { fileBuffer, fileName } = req.file as any;
      const buffer: Buffer = fileBuffer ?? req.file.buffer;
      const originalName: string = fileName ?? req.file.originalname;

      if (!buffer) return res.status(400).json({ message: "File buffer missing." });

      // Validate MIME type — only images allowed
      const mime = req.file.mimetype ?? "";
      if (!mime.startsWith("image/")) {
        return res.status(400).json({ message: "Only image files are allowed for logos." });
      }

      const fs = await import("fs");
      const nodePath = await import("path");
      const ext = nodePath.extname(originalName).toLowerCase() || ".png";
      const diskFileName = `partner-logo-${orgId}-${Date.now()}${ext}`;
      const uploadsDir = nodePath.join(process.cwd(), "uploads");
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(nodePath.join(uploadsDir, diskFileName), buffer);

      const logoUrl = `/uploads/${diskFileName}`;
      await storage.updatePartnerOrg(orgId, { logoUrl });

      await storage.createAuditLog({
        action: "partner_org_logo_uploaded",
        entityType: "partner_org",
        entityId: orgId,
        actorType: "user",
        actorId: String((req.user as any)?.id ?? ""),
        details: { logoUrl, originalName },
      });

      res.json({ logoUrl });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: delete partner org ───────────────────────────────────────────────
  app.delete("/api/partner-orgs/:id", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      await storage.deletePartnerOrg(Number(req.params.id));
      res.json({ message: "Deleted." });
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });

  // ── Admin: get partner org users ────────────────────────────────────────────
  app.get("/api/partner-orgs/:id/users", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const users = await storage.getPartnerOrgUsers(Number(req.params.id));
      res.json(users.map(({ passwordHash: _ph, ...u }) => u));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: invite user to partner org ──────────────────────────────────────
  app.post("/api/partner-orgs/:id/users", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const { email, firstName, lastName, role } = req.body;
      if (!email || !firstName) {
        return res.status(400).json({ message: "Email and first name are required." });
      }
      const orgId = Number(req.params.id);
      const existing = await storage.getPartnerOrgUserByEmail(email.toLowerCase());
      if (existing && existing.partnerOrgId === orgId) {
        return res.status(409).json({ message: "User already exists in this org." });
      }
      const user = await storage.createPartnerOrgUser({
        partnerOrgId: orgId,
        email: email.toLowerCase(),
        firstName,
        lastName: lastName || "",
        role: role || "member",
        status: "pending",
      });
      const { passwordHash: _ph, ...safeUser } = user;
      const action = await issueAuthAction({
        purpose: "partner_org_activation", subject: { type: "partner_org_user", id: user.id }, ttlMs: 72 * 60 * 60 * 1000,
      });

      // Send welcome email to the new org user
      (async () => {
        try {
          const { sendSmtpEmail, isSmtpConfigured, verifySmtpLive } = await import("../services/smtp-email");
          if (!isSmtpConfigured()) {
             await setAuthActionDelivery(action.id, "definite_failure");
            return;
          }
          // #1249 — Live connectivity check before sending so we don't silently fail
          const smtpLive = await verifySmtpLive();
          if (!smtpLive) {
             await setAuthActionDelivery(action.id, "ambiguous");
            return;
          }
          const { getEmailSignatureHtml } = await import("../services/email-signatures");
          const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
          const baseUrl = process.env.APP_URL ||
            (replitDomain ? `https://${replitDomain}` : "https://libertybancard.com");
           const loginUrl = `${baseUrl}/partner-org/login#action=activate&token=${encodeURIComponent(action.token)}`;
          const welcomeHtml = `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;">
   <p>Hi ${escapeHtml(firstName)},</p>
  <p>You've been invited to join the <strong>Liberty Bancard Partner Portal</strong> as a team member.</p>
   <p>Use this one-time link to choose a password and activate your account.</p>
  <p>
    <a href="${loginUrl}" style="display:inline-block;background-color:#1e3a5f;color:#ffffff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:bold;">
       Activate Partner Portal &rarr;
    </a>
  </p>
  <p>Questions? Contact <a href="mailto:partners@libertybancard.com" style="color:#1e3a5f;">partners@libertybancard.com</a>.</p>
${getEmailSignatureHtml("partners")}
</div>`;
          const result = await sendSmtpEmail({
            to: email.toLowerCase(),
            subject: "You've been added to the Liberty Bancard Partner Portal",
            html: welcomeHtml,
            category: "partners",
          });
          if (result.success) {
             await setAuthActionDelivery(action.id, "sent");
          } else {
             await setAuthActionDelivery(action.id, "definite_failure");
          }
         } catch {
           await setAuthActionDelivery(action.id, "ambiguous");
        }
      })();

      res.status(201).json(safeUser);
    } catch (err: any) {
      serverError(res, err, "partner_org_user_invite");
    }
  });

  // ── Admin: reset partner org user password (#158) ──────────────────────────
  app.post("/api/partner-orgs/:orgId/users/:userId/reset-password", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const user = await storage.getPartnerOrgUser(Number(req.params.userId));
      if (!user || user.partnerOrgId !== Number(req.params.orgId)) {
        return res.status(404).json({ message: "User not found in this org." });
      }

      const action = await issueAuthAction({
        purpose: "partner_org_password_reset", subject: { type: "partner_org_user", id: user.id }, ttlMs: 60 * 60 * 1000,
      });

      await storage.createAuditLog({
        action: "partner_org_user_password_reset",
        entityType: "partner_org_user",
        entityId: Number(req.params.userId),
        actorType: "user",
        actorId: String((req.user as any)?.id ?? ""),
        details: { orgId: user.partnerOrgId },
      });

      // Email a one-time password-reset link to the user.
      (async () => {
        try {
          const { sendSmtpEmail, isSmtpConfigured } = await import("../services/smtp-email");
          if (!isSmtpConfigured()) {
            await setAuthActionDelivery(action.id, "definite_failure");
            return;
          }
          const { getEmailSignatureHtml } = await import("../services/email-signatures");
          const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
          const baseUrl = process.env.APP_URL || (replitDomain ? `https://${replitDomain}` : "https://libertybancard.com");
           const loginUrl = `${baseUrl}/partner-org/login#action=reset&token=${encodeURIComponent(action.token)}`;
           const result = await sendSmtpEmail({
            to: user.email,
            subject: "Your Liberty Bancard Partner Portal password has been reset",
            html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;">
<p>Hi ${escapeHtml(user.firstName)},</p>
<p>Your Partner Portal password was reset by an administrator. Use this one-time link to choose a new password.</p>
<p><a href="${loginUrl}" style="display:inline-block;background-color:#1e3a5f;color:#ffffff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:bold;">Set New Password &rarr;</a></p>
${getEmailSignatureHtml("partners")}
</div>`,
            category: "partners",
          });
          await setAuthActionDelivery(action.id, result.success ? "sent" : "definite_failure");
        } catch {
          await setAuthActionDelivery(action.id, "ambiguous");
        }
      })();

      res.json({ message: "Password reset link issued." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: update partner org user ─────────────────────────────────────────
  app.patch("/api/partner-orgs/:orgId/users/:userId", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const { status, role } = req.body;
      const user = await storage.updatePartnerOrgUser(Number(req.params.userId), { status, role });
      if (!user) return res.status(404).json({ message: "Not found." });
      const { passwordHash: _ph, ...safeUser } = user;
      res.json(safeUser);
    } catch (err: any) {
      serverError(res, err, "partner_org_user_update");
    }
  });

  // ── Admin: get aggregate performance for all orgs ──────────────────────────
  app.get("/api/partner-orgs-performance", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== "admin") {
      return res.status(403).json({ message: "Admin only." });
    }
    try {
      const orgs = await storage.getPartnerOrgs();
      const performance = await Promise.all(
        orgs.map(async (org) => {
          const [deals, contacts] = await Promise.all([
            storage.getDealsByPartnerOrg(org.id),
            storage.getContactsByPartnerOrg(org.id),
          ]);
          const closedDeals = deals.filter(d => d.stage === "Closed Won");
          const totalCommission = closedDeals.reduce((sum, d) => {
            return sum + parseFloat(d.estMonthlyRevenue || "0") * (org.commissionRate || 10) / 100;
          }, 0);
          return {
            ...org,
            dealCount: deals.length,
            closedDealCount: closedDeals.length,
            leadCount: contacts.length,
            totalCommissionEarned: Math.round(totalCommission * 100) / 100,
          };
        })
      );
      res.json(performance);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ── CO-BRANDED PROPOSALS ──────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────────

  function getBaseUrl(req: any): string {
    const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
    return process.env.APP_URL ||
      (replitDomain ? `https://${replitDomain}` : `${req.protocol}://${req.get("host")}`);
  }

  // ── Partner org: create a co-branded proposal (partner session) ────────────
  app.post("/api/partner-org/proposals", async (req, res) => {
    if (!isPartnerOrgAdmin(req)) {
      return res.status(401).json({ message: "Please log in to your partner portal." });
    }
    const partnerOrgId = (req.session as any).partnerOrgId as number;
    try {
      const {
        merchantName, merchantEmail, merchantMonthlyVolume, merchantEffectiveRate,
        pricingPlan, customMessage, contactId, dealId,
      } = req.body;

      if (!merchantName || typeof merchantName !== "string") {
        return res.status(400).json({ message: "Merchant name is required." });
      }

      const user = await storage.getPartnerOrgUser((req.session as any).partnerOrgUserId);

      const proposal = await createCoBrandedProposal({
        partnerOrgId,
        dealId: dealId ? Number(dealId) : undefined,
        contactId: contactId ? Number(contactId) : undefined,
        merchantName: String(merchantName).slice(0, 300),
        merchantEmail: merchantEmail ? String(merchantEmail).slice(0, 300) : undefined,
        merchantMonthlyVolume: merchantMonthlyVolume ? String(merchantMonthlyVolume) : undefined,
        merchantEffectiveRate: merchantEffectiveRate ? String(merchantEffectiveRate) : undefined,
        pricingPlan: pricingPlan || "interchangePlus",
        customMessage: customMessage ? String(customMessage).slice(0, 2000) : undefined,
        createdBy: user ? `${user.firstName} ${user.lastName}`.trim() : "Partner",
      });

      res.status(201).json(proposal);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Partner org: list proposals ────────────────────────────────────────────
  app.get("/api/partner-org/proposals", async (req, res) => {
    if (!isPartnerOrgAdmin(req)) {
      return res.status(401).json({ message: "Please log in to your partner portal." });
    }
    const partnerOrgId = (req.session as any).partnerOrgId as number;
    try {
      const proposals = await storage.getCoBrandedProposals(partnerOrgId);
      const baseUrl = getBaseUrl(req);
      const enriched = proposals.map(p => ({
        ...p,
        viewerUrl: `${baseUrl}/co-branded-proposal/${p.token}`,
      }));
      res.json(enriched);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Partner org: send a proposal via email ─────────────────────────────────
  app.post("/api/partner-org/proposals/:id/send", async (req, res) => {
    if (!isPartnerOrgAdmin(req)) {
      return res.status(401).json({ message: "Please log in to your partner portal." });
    }
    const partnerOrgId = (req.session as any).partnerOrgId as number;
    try {
      const proposal = await storage.getCoBrandedProposal(Number(req.params.id));
      if (!proposal || proposal.partnerOrgId !== partnerOrgId) {
        return res.status(404).json({ message: "Proposal not found." });
      }
      const baseUrl = getBaseUrl(req);

      const { merchantEmail } = req.body;
      if (merchantEmail) {
        if (proposal.contactId) {
          await storage.updateContact(proposal.contactId, { email: merchantEmail });
        }
      }

      const sent = await sendCoBrandedProposalEmail(proposal.id, baseUrl);
      if (!sent) {
        return res.status(500).json({ message: "Failed to deliver email. Please configure GHL or SMTP." });
      }
      res.json({ message: "Proposal sent successfully." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Partner org: delete a proposal ────────────────────────────────────────
  app.delete("/api/partner-org/proposals/:id", async (req, res) => {
    if (!isPartnerOrgAdmin(req)) {
      return res.status(401).json({ message: "Please log in to your partner portal." });
    }
    const partnerOrgId = (req.session as any).partnerOrgId as number;
    try {
      const proposal = await storage.getCoBrandedProposal(Number(req.params.id));
      if (!proposal || proposal.partnerOrgId !== partnerOrgId) {
        return res.status(404).json({ message: "Proposal not found." });
      }
      await storage.deleteCoBrandedProposal(proposal.id);
      res.json({ message: "Deleted." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Public: view co-branded proposal (tracking) ────────────────────────────
  app.get("/api/public/co-branded-proposal/:token", async (req, res) => {
    try {
      const proposal = await storage.getCoBrandedProposalByToken(req.params.token);
      if (!proposal) return res.status(404).json({ message: "Proposal not found." });

      const org = await storage.getPartnerOrg(proposal.partnerOrgId!);
      if (!org) return res.status(404).json({ message: "Partner not found." });

      // trackProposalView atomically claims the first view via UPDATE...WHERE viewed_at IS NULL;
      // only the claim winner fires owner notifications/audit. Use its result to gate GHL side
      // effects so concurrent page loads don't duplicate tags or workflow enrollments.
      const { claimedFirstView } = await trackProposalView(req.params.token);

      // T303: First view GHL side effects — gated on the atomic claim result
      if (claimedFirstView && proposal.dealId) {
        try {
          const deal = await storage.getDeal(proposal.dealId!);
          if (deal) {
            await storage.updateDeal(deal.id, { proposalStatus: "viewed" });
            if (deal.contactId) {
              const contact = await storage.getContact(deal.contactId);
              if (contact?.ghlContactId) {
                // Preserve the public proposal read while paused; only its
                // auxiliary provider mutations are skipped.
                const pauseDecision = await authorizeGhlRouteMutation();
                if (pauseDecision.allowed) {
                  await Promise.all([
                    addNote({ contactId: contact!.ghlContactId, body: `Co-branded proposal viewed: ${proposal.merchantName}` }),
                    addTag({ contactId: contact!.ghlContactId, tags: ["proposal-viewed"] }),
                    enrollInGhlWorkflowCompliant({ workflowKey: "proposal_viewed", ghlContactId: contact!.ghlContactId, contactId: contact!.id })
                  ]);
                } else {
                  logOperationalDiagnostic("proposal_view_alert", new Error("provider mutation paused"), "proposal_mutation_paused", { proposalId: proposal.id, dealId: proposal.dealId });
                }
              }
              // Owner-scoped in-app notification is now handled inside trackProposalView
              // (resolved to a specific user ID, fail-closed). The legacy system-wide
              // createNotification is intentionally removed to prevent data-scope leaks.
            }
          }
        } catch (err) {
          logOperationalDiagnostic("proposal_view_alert", err, "proposal_view_alert_failed", { proposalId: proposal.id, dealId: proposal.dealId });
        }
      }

      res.json({
        id: proposal.id,
        merchantName: proposal.merchantName,
        merchantMonthlyVolume: proposal.merchantMonthlyVolume,
        merchantEffectiveRate: proposal.merchantEffectiveRate,
        pricingPlan: proposal.pricingPlan,
        proposalData: proposal.proposalData,
        customMessage: proposal.customMessage,
        status: proposal.status,
        partner: {
          name: org.name,
          logoUrl: org.logoUrl,
          primaryColor: org.primaryColor,
          tagline: org.tagline,
          contactName: org.contactName,
          email: org.email,
          phone: org.phone,
        },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Public: accept a proposal ─────────────────────────────────────────────
  app.post("/api/public/co-branded-proposal/:token/accept", async (req, res) => {
    try {
      const proposal = await storage.getCoBrandedProposalByToken(req.params.token);
      if (!proposal) return res.status(404).json({ message: "Proposal not found." });
      if (!proposal.acceptedAt) {
        // Resolve the route disposition before accepting locally. Otherwise a
        // 503 after the acceptedAt write would be a misleading partial failure.
        if (proposal.dealId) {
          const deal = await storage.getDeal(proposal.dealId);
          const contact = deal?.contactId ? await storage.getContact(deal.contactId) : null;
          if (contact?.ghlContactId && isSdrGhlConfigured() && !(await requireGhlRouteMutationAllowed(res))) return;
        }
        await storage.updateCoBrandedProposal(proposal.id, {
          status: "accepted",
          acceptedAt: new Date(),
        });

        if (proposal.dealId) {
          try {
            const deal = await storage.getDeal(proposal.dealId!);
            if (deal) {
              const partnerOrgIdForDeal = proposal.partnerOrgId ?? deal.partnerOrgId ?? null;
              const dealUpdates: Record<string, any> = { proposalStatus: "accepted" };
              if (partnerOrgIdForDeal && !deal.partnerOrgId) dealUpdates.partnerOrgId = partnerOrgIdForDeal;
              await storage.updateDeal(deal.id, dealUpdates);
              if (deal.contactId) {
                const contact = await storage.getContact(deal.contactId);
                if (contact && partnerOrgIdForDeal && !contact!.partnerOrgId) {
                  await storage.updateContact(contact!.id, { partnerOrgId: partnerOrgIdForDeal, referralSource: "co_branded_proposal" });
                }
                if (contact?.ghlContactId) {
                  await Promise.all([
                    addNote({ contactId: contact!.ghlContactId, body: `Co-branded proposal ACCEPTED: ${proposal.merchantName}` }),
                    addTag({ contactId: contact!.ghlContactId, tags: ["proposal-accepted"] }),
                    enrollInGhlWorkflowCompliant({ workflowKey: "proposal_accepted", ghlContactId: contact!.ghlContactId, contactId: contact!.id })
                  ]);
                }
                await storage.createNotification({
                  channel: "app",
                  title: "Proposal Accepted",
                  message: `Proposal for ${proposal.merchantName} has been accepted!`,
                  type: "success",
                  metadata: { dealId: deal.id, proposalId: proposal.id }
                });
              }
            }
          } catch (err) {
            logOperationalDiagnostic("proposal_accept_alert", err, "proposal_accept_alert_failed", { proposalId: proposal.id, dealId: proposal.dealId });
          }
        }
      }
      res.json({ message: "Proposal accepted." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Public: tracking pixel for email open tracking ─────────────────────────
  app.get("/api/public/co-branded-proposal/:token/viewed", async (req, res) => {
    try {
      await trackProposalView(req.params.token);
    } catch {
    }
    const pixel = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64"
    );
    res.set({
      "Content-Type": "image/gif",
      "Content-Length": String(pixel.length),
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(pixel);
  });

  // ── Admin: generate co-branded proposal for a deal ─────────────────────────
  app.post("/api/deals/:dealId/co-branded-proposal", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.dealId);
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found." });

      const partnerOrgId = req.body.partnerOrgId || deal.partnerOrgId;
      if (!partnerOrgId) {
        return res.status(400).json({ message: "This deal is not linked to a partner organization." });
      }

      const contact = deal.contactId ? await storage.getContact(deal.contactId) : null;
      const merchantName = contact?.companyName ||
        (contact ? `${contact.firstName} ${contact.lastName}`.trim() : req.body.merchantName || "Unknown Merchant");

      const user = req.user as any;
      const proposal = await createCoBrandedProposal({
        partnerOrgId: Number(partnerOrgId),
        dealId,
        contactId: deal.contactId ?? undefined,
        merchantName,
        merchantMonthlyVolume: deal.totalVolume || contact?.monthlyVolume || req.body.merchantMonthlyVolume,
        merchantEffectiveRate: deal.effectiveRate || req.body.merchantEffectiveRate,
        pricingPlan: req.body.pricingPlan || deal.recommendedPath?.toLowerCase().replace(/\s+/g, "") || "interchangePlus",
        customMessage: req.body.customMessage,
        proposalData: deal.savingsProposal as any,
        createdBy: user?.firstName ? `${user.firstName} ${user.lastName || ""}`.trim() : "Admin",
      });

      const baseUrl = getBaseUrl(req);
      res.status(201).json({
        ...proposal,
        viewerUrl: `${baseUrl}/co-branded-proposal/${proposal.token}`,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: list co-branded proposals for a deal ────────────────────────────
  app.get("/api/deals/:dealId/co-branded-proposals", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.dealId);
      const allProposals = await storage.getAllCoBrandedProposals();
      const dealProposals = allProposals.filter(p => p.dealId === dealId);
      const baseUrl = getBaseUrl(req);
      res.json(dealProposals.map(p => ({
        ...p,
        viewerUrl: `${baseUrl}/co-branded-proposal/${p.token}`,
      })));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: send any co-branded proposal ───────────────────────────────────
  app.post("/api/co-branded-proposals/:id/send", isDashboardUser, async (req, res) => {
    try {
      const proposal = await storage.getCoBrandedProposal(Number(req.params.id));
      if (!proposal) return res.status(404).json({ message: "Proposal not found." });
      const baseUrl = getBaseUrl(req);
      const sent = await sendCoBrandedProposalEmail(proposal.id, baseUrl);
      if (!sent) {
        return res.status(500).json({ message: "Failed to deliver email. Please configure GHL or SMTP." });
      }
      res.json({ message: "Proposal sent successfully." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: enroll a proposal in a GHL workflow ───────────────────────────
  app.post("/api/co-branded-proposals/:id/enroll-workflow", isDashboardUser, async (req, res) => {
    try {
      const proposal = await storage.getCoBrandedProposal(Number(req.params.id));
      if (!proposal) return res.status(404).json({ message: "Proposal not found." });

      const { workflowKey } = req.body;
      if (!workflowKey) {
        return res.status(400).json({ message: "workflowKey is required." });
      }

      const contact = proposal.contactId ? await storage.getContact(proposal.contactId) : null;
      if (!contact || !contact!.ghlContactId) {
        return res.status(400).json({ message: "Associated contact not found or not synced to GHL." });
      }

      if (isSdrGhlConfigured() && !(await requireGhlRouteMutationAllowed(res))) return;
      const result = await enrollInGhlWorkflowCompliant({
        workflowKey,
        ghlContactId: contact!.ghlContactId,
        contactId: contact!.id,
        metadata: {
          proposalId: proposal.id,
          proposalToken: proposal.token,
          merchantName: proposal.merchantName,
        },
      });

      if (!result.success) {
        logOperationalDiagnostic("partner_org_workflow_enrollment", new Error("workflow enrollment failed"), "workflow_enrollment_failed", { proposalId: proposal.id, contactId: contact.id });
        return res.status(500).json({ message: "Internal server error" });
      }

      res.json({ message: "Enrolled in workflow successfully." });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Admin: list all co-branded proposals ──────────────────────────────────
  app.get("/api/co-branded-proposals", isDashboardUser, async (req, res) => {
    if (!["admin", "manager"].includes((req.user as any)?.role)) {
      return res.status(403).json({ message: "Admin or manager access required." });
    }
    try {
      const proposals = await storage.getAllCoBrandedProposals();
      const baseUrl = getBaseUrl(req);
      // Fetch all referenced partner orgs in one pass
      const orgIds = [...new Set(proposals.map(p => p.partnerOrgId).filter(Boolean))] as number[];
      const orgs = orgIds.length
        ? await Promise.all(orgIds.map(id => storage.getPartnerOrg(id)))
        : [];
      const orgMap = new Map(orgs.filter(Boolean).map(o => [o!.id, o!.name]));
      res.json(proposals.map(p => ({
        ...p,
        partnerName: p.partnerOrgId ? (orgMap.get(p.partnerOrgId) ?? null) : null,
        viewerUrl: `${baseUrl}/co-branded-proposal/${p.token}`,
      })));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Public: download proposal as printable HTML document ──────────────────
  app.get("/api/public/co-branded-proposal/:token/download", async (req, res) => {
    try {
      const proposal = await storage.getCoBrandedProposalByToken(req.params.token);
      if (!proposal) return res.status(404).json({ message: "Proposal not found." });

      const org = await storage.getPartnerOrg(proposal.partnerOrgId!);
      if (!org) return res.status(404).json({ message: "Partner not found." });

      const baseUrl = getBaseUrl(req);
      const pdfBuffer = await generateCoBrandedProposalPdf({
        org,
        merchantName: proposal.merchantName || "Merchant",
        merchantMonthlyVolume: proposal.merchantMonthlyVolume ?? undefined,
        merchantEffectiveRate: proposal.merchantEffectiveRate ?? undefined,
        pricingPlan: proposal.pricingPlan ?? undefined,
        customMessage: proposal.customMessage ?? undefined,
        proposalData: proposal.proposalData,
        token: proposal.token,
        baseUrl,
      });

      const slug = (proposal.merchantName || "merchant").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const fileName = `savings-proposal-${slug}.pdf`;

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(pdfBuffer.length),
        "Cache-Control": "no-store",
      });
      res.send(pdfBuffer);
    } catch (err: any) {
      serverError(res, err);
    }
  });
}
