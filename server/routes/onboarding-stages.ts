import type { Express } from "express";
import { isDashboardUser, requireRole } from "../replit_integrations/auth";
import { parseId } from "./helpers";
import { storage } from "../storage";
import { db } from "../db";
import { merchantOnboardingStages, deals, contacts, tasks, MERCHANT_ONBOARDING_STAGE_KEYS, OPEN_SALES_LEAD_STAGES } from "@shared/schema";
import { eq, and, lt, isNull, sql } from "drizzle-orm";
import { storedAmountNumericSql } from "../utils/amount-sql";
import { amountAvailability } from "@shared/amount-contract";
import { privatePartnerResponse, toPartnerOperatorRecord, toPartnerPipelineRecord } from "../utils/partner-response";
import { serverError } from "../utils/server-error";
import { createAndSendNpsSurvey } from "../services/nps-email";
import { checkGoLiveReadiness } from "../services/go-live-gate";

// Re-export so existing consumers (deals.ts, Onboarding.tsx API) still work
export { checkGoLiveReadiness } from "../services/go-live-gate";
export { GO_LIVE_GATE_STAGES } from "../services/go-live-gate";

export function registerOnboardingStagesRoutes(app: Express) {
  // ── GET go-live readiness for a deal ─────────────────────────────────────
  app.get("/api/deals/:id/go-live-readiness", isDashboardUser, async (req, res) => {
    try {
      const dealId = parseId(req.params.id);
      if (dealId === null) return res.status(404).json({ message: "Deal not found" });
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      const result = await checkGoLiveReadiness(deal);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GET all stages for a deal ──────────────────────────────────────────────
  app.get("/api/deals/:id/onboarding-stages", isDashboardUser, async (req, res) => {
    try {
      const dealId = parseId(req.params.id);
      if (dealId === null) return res.status(404).json({ message: "Deal not found" });
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      const stages = await storage.getMerchantOnboardingStages(dealId);
      res.json(stages);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── Initialize stages for a deal (idempotent) ──────────────────────────────
  app.post("/api/deals/:id/onboarding-stages/initialize", isDashboardUser, async (req, res) => {
    try {
      const dealId = parseId(req.params.id);
      if (dealId === null) return res.status(404).json({ message: "Deal not found" });
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      const stages = await storage.initializeMerchantOnboardingStages(dealId);
      await storage.createAuditLog({
        action: "onboarding_stages_initialized",
        entityType: "deal",
        entityId: dealId,
        details: { stageCount: stages.length },
      });
      res.json(stages);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── PATCH a single stage ───────────────────────────────────────────────────
  app.patch("/api/deals/:id/onboarding-stages/:stageKey", isDashboardUser, async (req, res) => {
    try {
      const dealId = parseId(req.params.id);
      if (dealId === null) return res.status(404).json({ message: "Deal not found" });
      const stageKey = req.params.stageKey;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      if (!MERCHANT_ONBOARDING_STAGE_KEYS.includes(stageKey as any)) {
        return res.status(400).json({ message: `Invalid stage key: ${stageKey}` });
      }

      const { status, owner, dueDate, notes, equipmentOrderRef } = req.body;
      const updates: Record<string, any> = { updatedAt: new Date() };

      if (status !== undefined) {
        const validStatuses = ["pending", "in_progress", "complete", "blocked"];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({ message: `Invalid status: ${status}` });
        }
        updates.status = status;
        if (status === "complete") {
          updates.completedAt = new Date();
        } else {
          updates.completedAt = null;
        }
      }
      if (owner !== undefined) updates.owner = owner;
      if (dueDate !== undefined) updates.dueDate = dueDate ? new Date(dueDate) : null;
      if (notes !== undefined) updates.notes = notes;
      if (equipmentOrderRef !== undefined) updates.equipmentOrderRef = equipmentOrderRef;

      const stage = await storage.upsertMerchantOnboardingStage(dealId, String(stageKey), updates);

      // Write to audit log
      await storage.createAuditLog({
        action: "onboarding_stage_updated",
        entityType: "deal",
        entityId: dealId,
        details: { stageKey, ...updates },
      });

      // If stage moves to complete, log GHL stage note (non-blocking)
      if (status === "complete") {
        storage.createAuditLog({
          action: "onboarding_stage_completed",
          entityType: "deal",
          entityId: dealId,
          details: { stageKey, label: MERCHANT_ONBOARDING_STAGE_KEYS.includes(stageKey as any) ? stageKey : stageKey },
        }).catch(() => {});
      }

      // Send NPS survey when "First Batch Processed" milestone is reached (non-blocking)
      if (status === "complete" && stageKey === "first_batch_processed" && deal.contactId) {
        createAndSendNpsSurvey({
          contactId: deal.contactId,
          dealId,
          dayTrigger: 1,
        }).catch((err: Error) =>
          console.warn(`[OnboardingStages] NPS survey dispatch failed for deal ${dealId}:`, err.message)
        );
      }

      res.json(stage);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GET overdue stages across all onboarding deals ────────────────────────
  app.get("/api/onboarding-stages/overdue", isDashboardUser, async (req, res) => {
    try {
      const now = new Date();
      const overdue = await db
        .select({
          id: merchantOnboardingStages.id,
          dealId: merchantOnboardingStages.dealId,
          stageKey: merchantOnboardingStages.stageKey,
          status: merchantOnboardingStages.status,
          owner: merchantOnboardingStages.owner,
          dueDate: merchantOnboardingStages.dueDate,
          notes: merchantOnboardingStages.notes,
        })
        .from(merchantOnboardingStages)
        .where(
          and(
            lt(merchantOnboardingStages.dueDate, now),
            isNull(merchantOnboardingStages.completedAt),
          )
        )
        .limit(100);
      res.json(overdue);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GET account health summary for a contact ──────────────────────────────
  app.get("/api/contacts/:contactId/account-health", isDashboardUser, async (req, res) => {
    try {
      const contactId = parseId(req.params.contactId);
      if (contactId === null) return res.status(404).json({ message: "Contact not found" });
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const contactDeals = await db
        .select()
        .from(deals)
        .where(eq(deals.contactId, contactId))
        .limit(50);
      const onboardingDeal = contactDeals.find(d => d.pipeline === "onboarding" && !d.archivedAt);
      const primaryDeal = contactDeals.find(d => !d.archivedAt) || null;

      // Compute health badge
      const lastContactDate = contact.lastContactedAt;
      const daysSinceContact = lastContactDate
        ? Math.floor((Date.now() - new Date(lastContactDate).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      // Volume trend from mid stats
      let processingVolumeTrend: "up" | "down" | "flat" | null = null;
      let chargebackRatio: number | null = null;
      let lastBatchDate: string | null = null;

      if (primaryDeal?.mid) {
        const stats = await storage.getMidDailyStatsByDeal(primaryDeal.id, 60);
        if (stats.length > 0) {
          lastBatchDate = stats[0]?.date || null;
          const recent = stats.slice(0, 30);
          const older = stats.slice(30, 60);
          const recentVol = recent.reduce((s, r) => s + (Number(r.volume) || 0), 0);
          const olderVol = older.reduce((s, r) => s + (Number(r.volume) || 0), 0);
          if (olderVol > 0) {
            processingVolumeTrend = recentVol > olderVol * 1.05 ? "up" : recentVol < olderVol * 0.95 ? "down" : "flat";
          }
          const totalVol = recent.reduce((s, r) => s + (Number(r.volume) || 0), 0);
          const totalCb = recent.reduce((s, r) => s + (Number(r.chargebackAmount) || 0), 0);
          chargebackRatio = totalVol > 0 ? totalCb / totalVol : 0;
        }
      }

      // Compute health status
      let healthStatus: "Healthy" | "At Risk" | "Attention Needed" = "Healthy";
      const reasons: string[] = [];

      if (chargebackRatio !== null && chargebackRatio > 0.01) {
        healthStatus = "At Risk";
        reasons.push(`Chargeback ratio ${(chargebackRatio * 100).toFixed(2)}% exceeds 1%`);
      }
      if (processingVolumeTrend === "down") {
        if (healthStatus === "Healthy") healthStatus = "At Risk";
        reasons.push("Processing volume declining");
      }
      if (daysSinceContact !== null && daysSinceContact > 90) {
        if (healthStatus === "Healthy") healthStatus = "Attention Needed";
        reasons.push(`No contact in ${daysSinceContact} days`);
      }

      // Get onboarding stages progress
      let onboardingProgress: { total: number; complete: number; pct: number } | null = null;
      if (onboardingDeal) {
        const stages = await storage.getMerchantOnboardingStages(onboardingDeal.id);
        const complete = stages.filter(s => s.status === "complete").length;
        onboardingProgress = {
          total: stages.length || MERCHANT_ONBOARDING_STAGE_KEYS.length,
          complete,
          pct: stages.length > 0 ? Math.round((complete / stages.length) * 100) : 0,
        };
      }

      // Scheduled touchpoints due (query directly)
      const allTasks = await db
        .select({ id: tasks.id, title: tasks.title, status: tasks.status, source: tasks.source, dueDate: tasks.dueDate })
        .from(tasks)
        .where(and(eq(tasks.contactId, contactId), eq(tasks.status, "pending")))
        .limit(20);
      const pendingTouchpoints = allTasks.filter(t => t.source === "retention_touchpoint");

      res.json({
        contactId,
        healthStatus,
        healthReasons: reasons,
        lastContactDate: contact.lastContactedAt,
        daysSinceContact,
        processingVolumeTrend,
        chargebackRatio,
        lastBatchDate,
        onboardingProgress,
        pendingTouchpoints: pendingTouchpoints.length,
        primaryDealId: primaryDeal?.id || null,
        onboardingDealId: onboardingDeal?.id || null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── POST: Create scheduled retention touchpoints for a contact ────────────
  app.post("/api/contacts/:contactId/retention-touchpoints", requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId = parseId(req.params.contactId);
      if (contactId === null) return res.status(404).json({ message: "Contact not found" });
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const now = new Date();
      const assignedTo = req.body.assignedTo || "Account Manager";

      const touchpoints = [
        {
          title: `Quarterly Rate Review — ${contact.companyName || contact.firstName}`,
          daysFromNow: 90,
          description: "Quarterly rate review touchpoint. Review current processing rates and identify savings opportunities.",
        },
        {
          title: `PCI Compliance Reminder — ${contact.companyName || contact.firstName}`,
          daysFromNow: 365,
          description: "Annual PCI compliance reminder. Confirm merchant has completed PCI questionnaire and is compliant.",
        },
        {
          title: `Equipment Refresh Check — ${contact.companyName || contact.firstName}`,
          daysFromNow: 540,
          description: "18-month equipment check. Review terminal age, software version, and recommend upgrade if needed.",
        },
        {
          title: `Referral Ask — ${contact.companyName || contact.firstName}`,
          daysFromNow: 60,
          description: "Ask merchant for a referral. Merchant has been active 60+ days — a good time to request introductions.",
        },
      ];

      const created = [];
      for (const tp of touchpoints) {
        const dueDate = new Date(now.getTime() + tp.daysFromNow * 24 * 60 * 60 * 1000);
        const task = await storage.createAuthorityTask({
          contactId,
          title: tp.title,
          description: tp.description,
          assignedTo,
          dueDate,
          priority: "normal",
          source: "retention_touchpoint",
        } as any);
        created.push(task);
      }

      await storage.createAuditLog({
        action: "retention_touchpoints_created",
        entityType: "contact",
        entityId: contactId,
        details: { count: created.length, assignedTo },
      });

      res.json({ created: created.length, tasks: created });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── GET partner referral pipeline ─────────────────────────────────────────
  app.get("/api/partners/referral-pipeline", requireRole("admin", "manager"), async (req, res) => {
    try {
      const partners = await storage.getPartners();

      // One aggregate read for every partner. Referral count is every referral of the partner. Pipeline volume is the
      // total processing volume of open sales-stage, production, non-archived deals on the partner's referred
      // contacts, each deal counted once per partner. This is scoped to admin/manager (all owners), like the page.
      const aggregateRows = await db.execute(sql`
        WITH referral_counts AS (
          SELECT partner_id, COUNT(*)::int AS referred_count FROM referrals WHERE partner_id IS NOT NULL GROUP BY partner_id
        ), referred_deals AS (
          SELECT DISTINCT r.partner_id, d.id AS deal_id, ${storedAmountNumericSql(sql`d.total_volume`)} AS volume
          FROM referrals r
          JOIN deals d ON d.contact_id = r.contact_id
          WHERE r.partner_id IS NOT NULL AND r.contact_id IS NOT NULL
            AND d.record_class = 'production' AND d.archived_at IS NULL AND d.pipeline = 'sales'
            AND d.stage IN (${sql.join(OPEN_SALES_LEAD_STAGES.map(stage => sql`${stage}`), sql`, `)})
        ), deal_totals AS (
          SELECT partner_id, COUNT(*)::int AS deal_count,
            COUNT(volume)::int AS known_count,
            COALESCE(SUM(volume), 0)::float8 AS volume
          FROM referred_deals GROUP BY partner_id
        )
        SELECT p.id AS partner_id, COALESCE(rc.referred_count, 0) AS referred_count,
          COALESCE(dt.deal_count, 0) AS deal_count, COALESCE(dt.known_count, 0) AS known_count, COALESCE(dt.volume, 0) AS volume
        FROM partners p
        LEFT JOIN referral_counts rc ON rc.partner_id = p.id
        LEFT JOIN deal_totals dt ON dt.partner_id = p.id`);
      const aggregates = new Map<number, { referred: number; deals: number; known: number; volume: number }>();
      for (const row of aggregateRows.rows as Array<Record<string, unknown>>) {
        aggregates.set(Number(row.partner_id), { referred: Number(row.referred_count), deals: Number(row.deal_count), known: Number(row.known_count), volume: Number(row.volume) });
      }

      const enriched = await Promise.all(
        partners.map(async (p) => {
          // Next follow-up task for the referral owner
          let nextFollowupDue: Date | null = null;
          if (p.referralOwner) {
            const followupRows = await db
              .select({ dueDate: tasks.dueDate })
              .from(tasks)
              .where(and(eq(tasks.assignedTo, p.referralOwner), eq(tasks.status, "pending")))
              .orderBy(tasks.dueDate)
              .limit(5);
            const row = followupRows.find(r => r.dueDate !== null);
            nextFollowupDue = row?.dueDate ?? null;
          }
          const aggregate = aggregates.get(p.id);
          return toPartnerPipelineRecord(p, {
            referredMerchantCount: aggregate?.referred ?? 0,
            // Unknown amounts are counted, never summed as zero: all known = complete, some = partial, none = unavailable (null).
            openPipelineVolume: (aggregate?.deals ?? 0) > 0 && amountAvailability(aggregate!.deals, aggregate!.deals - aggregate!.known) === "unavailable"
              ? null : (aggregate?.volume ?? 0),
            openPipelineDealCount: aggregate?.deals ?? 0,
            openPipelineVolumeUnknownDeals: aggregate ? aggregate.deals - aggregate.known : 0,
            openPipelineVolumeStatus: amountAvailability(aggregate?.deals ?? 0, aggregate ? aggregate.deals - aggregate.known : 0),
            nextFollowupDue,
          });
        })
      );

      privatePartnerResponse(res);
      res.json(enriched);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── PATCH partner (enhanced fields: referralOwner, commissionStatus, etc.) ─
  app.patch("/api/partners/:id/tracking", requireRole("admin", "manager"), async (req, res) => {
    try {
      const partnerId = parseId(req.params.id);
      if (partnerId === null) return res.status(404).json({ message: "Partner not found" });
      const partner = await storage.getPartner(partnerId);
      if (!partner) return res.status(404).json({ message: "Partner not found" });

      const { referralOwner, commissionStatus, lastContactAt, partnerCategory, notes } = req.body;
      const updates: Record<string, any> = { updatedAt: new Date() };

      if (referralOwner !== undefined) updates.referralOwner = referralOwner;
      if (commissionStatus !== undefined) {
        const validStatuses = ["pending", "approved", "paid"];
        if (!validStatuses.includes(commissionStatus)) {
          return res.status(400).json({ message: "commissionStatus must be pending, approved, or paid" });
        }
        updates.commissionStatus = commissionStatus;
      }
      if (lastContactAt !== undefined) updates.lastContactAt = lastContactAt ? new Date(lastContactAt) : null;
      if (partnerCategory !== undefined) updates.partnerCategory = partnerCategory;
      if (notes !== undefined) updates.notes = notes;

      const updated = await storage.updatePartner(partnerId, updates as any);
      if (!updated) return res.status(404).json({ message: "Partner not found" });
      privatePartnerResponse(res);
      res.json(toPartnerOperatorRecord(updated));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // ── POST: Link referral source on application to partner ──────────────────
  app.post("/api/partners/link-referral", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { contactId, dealId, referralSource, referredCompany, referredName, referredEmail } = req.body;

      if (!referralSource) return res.status(400).json({ message: "referralSource is required" });

      // Find partner by company name or affiliate code matching the referral source
      const allPartners = await storage.getPartners();
      const matched = allPartners.find(
        p => p.companyName?.toLowerCase() === referralSource.toLowerCase()
          || p.affiliateCode?.toLowerCase() === referralSource.toLowerCase()
          || p.contactName?.toLowerCase() === referralSource.toLowerCase()
      );

      if (!matched) {
        return res.status(404).json({ message: `No partner found matching referral source: ${referralSource}` });
      }

      // Create referral record
      const referral = await storage.createReferral({
        partnerId: matched.id,
        contactId: contactId || null,
        dealId: dealId || null,
        referredName: referredName || null,
        referredEmail: referredEmail || null,
        referredCompany: referredCompany || null,
        status: "pending",
      });

      // Update partner referred_count
      await storage.updatePartner(matched.id, {
        referredCount: (matched.referredCount || 0) + 1,
        updatedAt: new Date(),
      } as any);

      // Create follow-up task for referral owner
      if (matched.referralOwner) {
        await storage.createAuthorityTask({
          contactId: contactId || undefined,
          dealId: dealId || undefined,
          title: `Follow up with referred lead — ${referredCompany || referredName || referredEmail || "New Lead"}`,
          description: `Referred by partner: ${matched.companyName}. Source: ${referralSource}`,
          assignedTo: matched.referralOwner,
          priority: "high",
          dueDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          source: "partner_referral",
        } as any);
      }

      // Create 30-day follow-up task for the partner
      await storage.createAuthorityTask({
        title: `Partner check-in — ${matched.companyName}`,
        description: `Monthly check-in with partner ${matched.companyName}. Review recent referrals and pipeline status.`,
        assignedTo: matched.referralOwner || "Account Manager",
        priority: "normal",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        source: "partner_followup",
      } as any);

      await storage.createAuditLog({
        action: "partner_referral_linked",
        entityType: "contact",
        entityId: contactId || undefined,
        details: { partnerId: matched.id, referralSource, referralId: referral.id },
      });

      privatePartnerResponse(res);
      res.json({ referral, partner: toPartnerOperatorRecord(matched), tasksCreated: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });
}
