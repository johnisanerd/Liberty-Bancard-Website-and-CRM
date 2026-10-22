import type { Express } from "express";
import { isAuthenticated, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { db } from "../db";
import { statementProposals, documents } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { contacts, deals, insertDealCompetitorSchema, insertDealSchema, insertPipelineStageSchema, insertStageAutomationRuleSchema } from "@shared/schema";
import { autoEnrollFromTrigger } from "../services/sequence-worker";
import { triggerWorkflowsByEvent } from "../services/workflow-executor";
import { scoreContact } from "../services/lead-scoring";
import { generateDealBlueprint } from "../services/deal-blueprint";
import { estimateFromContact, estimateFromDeal, estimateFromProspect } from "../services/volume-estimator";
import { createPreferenceAwareNotification, sendCriticalEmailNotification } from "../services/digest-service";
import { sendGhlEmailForMerchant, isGhlConfigured } from "../services/ghl";
import { advanceDealStage, DealStageConflictError, DealStageIllegalTransitionError, readDealStageTransitionOptions } from "../services/deal-stage-service";
import { classifyAiError, logAiCredentialError } from "../services/ai-audit-logger";
import { updateContactLocalFirst } from "../services/contact-writer";
import { parse } from "csv-parse/sync";
import path from "path";
import { randomUUID } from "crypto";
import { sendPushToAllReps } from "../services/push-service";
import { computeDealTerminalEconomics } from "../services/terminal-economics";
import { enrollInGhlWorkflow, enrollInGhlWorkflowCompliant } from "../services/ghl-workflows";
import { updateCustomFields } from "../services/sdr/ghl-client";
import { serverError } from "../utils/server-error";
import { GO_LIVE_GATE_STAGES, checkGoLiveReadiness, GoLiveGateError } from "../services/go-live-gate";
import { requireGhlRouteMutationAllowed } from "./ghl-mutation-pause";
import { agentOwnershipEmail, authorizeContactAccess, authorizeDealAccess, denyCrmObject, parseStrictPagination } from "../services/crm-object-access";
import { readRevenueDeals } from "../services/revenue-read-authority";
import { decideCr06SequenceLifecycle } from "../services/cr06-promotional-lifecycle-decision";

export function registerDealsRoutes(app: Express) {
  // === DEALS ===

  // ─── GET /api/contacts/:id/deals — deals for a specific contact (mobile + detail tabs) ─
  app.get("/api/contacts/:id/deals", isDashboardUser, async (req, res) => {
    try {
      const contactId = Number(req.params.id);
      if (isNaN(contactId)) return res.status(400).json({ message: "Invalid contact ID" });
      const rows = await db
        .select()
        .from(deals)
        .where(eq(deals.contactId, contactId))
        .orderBy(desc(deals.createdAt));
      // REV-05A: Serialize each deal — masks mid and sanitizes boardingLog.
      const { serializeDeal: _serializeDeal1 } = await import("../utils/mask-mid");
      res.json(rows.map((d: any) => _serializeDeal1(d)));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/deals", isDashboardUser, async (req, res) => {
    // This ID is server-generated: an inbound request identifier is never a
    // trusted correlation value.
    const correlationId = randomUUID();
    res.setHeader("X-Request-Id", correlationId);
    try {
      const pipelineValue = req.query.pipeline;
      if (pipelineValue !== undefined && (typeof pipelineValue !== "string" || !pipelineValue.trim())) {
        return res.status(400).json({
          message: "pipeline must be a non-empty string",
          code: "INVALID_PIPELINE",
          correlationId,
        });
      }
      const pipeline = typeof pipelineValue === "string" ? pipelineValue : undefined;
      const pagination = parseStrictPagination(req.query as Record<string, unknown>, { defaultLimit: 100, maxLimit: 2000 });
      if ("error" in pagination) {
        return res.status(400).json({
          message: "limit and offset/page must be positive whole-number values within the route limit",
          code: "INVALID_PAGINATION",
          correlationId,
        });
      }
      const { limit, offset } = pagination;
      const parsedFilters=z.object({
        includeArchived:z.enum(["true","false"]).optional(),
        noFollowUp:z.enum(["true","false"]).optional(),
        unassigned:z.enum(["true","false"]).optional(),
        pastGoLive:z.enum(["true","false"]).optional(),
        createdLast7Days:z.enum(["true","false"]).optional(),
        assignedTo:z.string().trim().min(1).max(320).optional(),
        vertical:z.string().trim().min(1).max(160).optional(),
        offerPath:z.string().trim().min(1).max(160).optional(),
        groupContactId:z.string().regex(/^[1-9][0-9]*$/).transform(Number).refine(Number.isSafeInteger).optional(),
      }).safeParse(req.query);
      if(!parsedFilters.success)return res.status(400).json({message:"Invalid deal scope filters",code:"INVALID_DEAL_FILTERS",correlationId});
      const {includeArchived,noFollowUp,unassigned,pastGoLive,createdLast7Days,...dealFilters}=parsedFilters.data;
      if(dealFilters.groupContactId && !await authorizeContactAccess(req,res,dealFilters.groupContactId))return;
      const result = await readRevenueDeals(req.user as any, { pipeline, limit, offset,...dealFilters,includeArchived:includeArchived==="true",
        noFollowUp:noFollowUp==="true",unassigned:unassigned==="true",pastGoLive:pastGoLive==="true",createdLast7Days:createdLast7Days==="true" });
      // REV-05A: Serialize each deal — masks mid and sanitizes boardingLog.
      const { serializeDeal: _serializeDeal2 } = await import("../utils/mask-mid");
      const maskedResult = {
        ...result,
        data: Array.isArray((result as any).data)
          ? (result as any).data.map((d: any) => _serializeDeal2(d))
          : (result as any).data,
      };
      res.json(maskedResult);
    } catch {
      console.error(JSON.stringify({
        route: "GET /api/deals",
        code: "DEALS_LIST_INTERNAL_ERROR",
        status: 500,
        correlationId,
      }));
      res.status(500).json({
        message: "Internal server error",
        code: "DEALS_LIST_INTERNAL_ERROR",
        correlationId,
      });
    }
  });

  app.post("/api/deals", isDashboardUser, async (req, res) => {
    try {
      const input = insertDealSchema.parse(req.body);
      const deal = await storage.createDeal(input, { userId: (req.user as any)?.id ?? null });
      await storage.createAuditLog({ action: "deal_created", entityType: "deal", entityId: deal.id, userId: (req.user as any)?.id ?? null, details: { pipeline: deal.pipeline, stage: deal.stage } });
      if (deal.contactId) {
        scoreContact(deal.contactId).catch(err => console.error("Lead scoring error:", err));
        // Backfill contact.assignedTo from deal owner when contact is unassigned.
        if (deal.owner) {
          storage.getContact(deal.contactId).then(async (c) => {
            if (c && !(c as any).assignedTo) {
              await storage.updateContact(deal.contactId!, { assignedTo: deal.owner } as any);
            }
          }).catch(err => console.warn("[Deals] assignedTo backfill failed:", err));
        }
      }
      generateDealBlueprint(deal.id).catch(err => console.error("Blueprint generation error:", err));
      // Auto-initialize onboarding checklist for deals created directly in the
      // onboarding pipeline (#440 — idempotent via onConflictDoNothing).
      if (deal.pipeline === "onboarding") {
        storage.initializeOnboardingChecklist(deal.id).catch(err =>
          console.error(`[Deals] Checklist init failed for new onboarding deal #${deal.id}:`, err?.message)
        );
      }
      // REV-05A: Serialize deal — masks mid and sanitizes boardingLog.
      const { serializeDeal: _serializeDealCreate } = await import("../utils/mask-mid");
      res.status(201).json(_serializeDealCreate(deal as any));
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.get("/api/deals/:id", isDashboardUser, async (req, res) => {
    try {
      const deal = await authorizeDealAccess(req, res, Number(req.params.id));
      if (!deal) return;
      // REV-05A: Serialize deal — masks mid and sanitizes boardingLog.
      const { serializeDeal: _serializeDeal3 } = await import("../utils/mask-mid");
      res.json(_serializeDeal3(deal as any));
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/deals/:id/transition-options",isDashboardUser,async(req,res)=>{
    try {
      const deal=await authorizeDealAccess(req,res,Number(req.params.id));
      if(!deal)return;
      res.json({dealId:deal.id,pipeline:deal.pipeline,stage:deal.stage,
        stages:readDealStageTransitionOptions(deal.pipeline,deal.stage),asOf:new Date().toISOString(),
        capability:"structural_policy_observation_only",execution:"existing owner rechecks actor, object, expectedStage, readiness and effects"});
    } catch(error){serverError(res,error);}
  });
  app.put("/api/deals/:id", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.id);
      const userId = (req.user as any)?.id ?? null;
      const old = await authorizeDealAccess(req, res, dealId);
      if (!old) return;

      // Split stage from the rest so stage transitions always go through the service layer,
      // which guarantees GHL sync + Closed Won onboarding kickoff for every code path.
      // overrideReason is a UI-only field for go-live gate overrides — strip it before persisting.
      // REV-05A: `mid` must never be written via the generic deal PUT — all MID changes must go
      // through assignMerchantMidToCanonical() via PUT /api/admin/merchants/:id/mid. Strip it here
      // so a dashboard user cannot bypass the canonical MID service.
      const { stage: newStageRaw, overrideReason, expectedStage, mid: _strippedMid, ...otherFields } = req.body as Record<string, unknown>;
      if(expectedStage!==undefined && (typeof expectedStage!=="string" || !expectedStage.trim())) {
        return res.status(400).json({message:"expectedStage must be the displayed stage"});
      }
      const newStage = typeof newStageRaw === "string" ? newStageRaw : undefined;
      const stageChanging = newStage !== undefined && newStage !== old.stage;

      // ── Go-Live Gate (HTTP layer) ──────────────────────────────────────────
      // For user-initiated stage changes to Go-Live or later on the onboarding
      // pipeline, check prerequisites here (where we have req.user context).
      // advanceDealStage enforces the same gate for all other callers.
      let goLiveOverrideCtx: { reason: string; actor: string; expectedStage?: string } | undefined;
      if (stageChanging && old.pipeline === "onboarding" && (GO_LIVE_GATE_STAGES as readonly string[]).includes(newStage!)) {
        const readiness = await checkGoLiveReadiness(old);
        if (!readiness.ready) {
          const actorRole = (req.user as any)?.role as string | undefined;
          const canOverride = actorRole === "admin" || actorRole === "manager";
          const overrideText = typeof overrideReason === "string" ? overrideReason.trim() : "";

          if (!canOverride || !overrideText) {
            return res.status(422).json({
              code: "GO_LIVE_GATE_FAILED",
              message: "Cannot advance to Go-Live: prerequisites not met",
              missing: readiness.missing,
              canOverride,
            });
          }

          // Valid override — pass context to advanceDealStage so it skips the
          // duplicate check and writes the single audit log entry.
          goLiveOverrideCtx = {
            reason: overrideText,
            actor: (req.user as any)?.email ?? actorRole ?? "unknown",
            expectedStage: old.stage,
          };
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let updated: any;
      if (!stageChanging) {
        // No stage change — stage is stripped even for same-stage replays.
        updated = await storage.updateDeal(dealId, otherFields, { userId });
        if (!updated) return res.status(404).json({ message: "Not found" });
        // Auto-initialize onboarding checklist when pipeline is moved to "onboarding" (#440)
        const newPipeline = (req.body as any).pipeline;
        if (newPipeline === "onboarding" && old.pipeline !== "onboarding") {
          storage.initializeOnboardingChecklist(dealId).catch(err =>
            console.error(`[Deals] Checklist init failed for deal #${dealId} (pipeline→onboarding):`, err?.message)
          );
        }
      } else {
        // Stage is changing — route through advanceDealStage (gate check + GHL sync + Closed Won).
        // For go-live stages on the onboarding pipeline, the gate is atomic inside advanceDealStage;
        // we write non-stage fields ONLY after a successful stage advance so a blocked gate does
        // not silently persist unrelated edits. For all other stages, the original order (fields
        // first, then stage) is preserved so GHL sync fires with the latest field values.
        const isGoLiveGate = (GO_LIVE_GATE_STAGES as readonly string[]).includes(newStage!)
          && old.pipeline === "onboarding";

        if (isGoLiveGate) {
          updated = await advanceDealStage(dealId, newStage!, "put_route", goLiveOverrideCtx, expectedStage as string|undefined);
          if (!updated) return res.status(404).json({ message: "Not found" });
          if (Object.keys(otherFields).length > 0) {
            const merged = await storage.updateDeal(dealId, otherFields, { userId });
            if (merged) updated = merged;
          }
        } else {
          updated = await advanceDealStage(dealId, newStage!, "put_route", goLiveOverrideCtx, expectedStage as string|undefined);
          if (!updated) return res.status(404).json({ message: "Not found" });
          if (Object.keys(otherFields).length > 0) {
            updated = await storage.updateDeal(dealId, otherFields, { userId }) ?? updated;
          }
        }
      }

      if (stageChanging) {
        await storage.createAuditLog({ action: "deal_stage_changed", entityType: "deal", entityId: updated.id, details: { from: old.stage, to: updated.stage } });
        await createPreferenceAwareNotification({ channel: "internal", title: "Deal Stage Changed", message: `Deal #${updated.id} moved from "${old.stage}" to "${updated.stage}"`, type: "info", metadata: { dealId: updated.id, eventType: "deal_stage_changed" } }, "deal_stage_changed");
        sendPushToAllReps({ title: "Deal Stage Changed", body: `Deal #${updated.id} moved from "${old.stage}" → "${updated.stage}"`, url: "/mobile/pipeline" }).catch(() => {});

        // ── Attribution wiring: carry contact UTM/gclid onto deal at key milestones ──
        if (["Call Booked", "Closed Won"].includes(updated.stage) && updated.contactId) {
          storage.getContact(updated.contactId).then(async (attrContact) => {
            if (!attrContact) return;
            const { db: attrDb } = await import("../db");
            const { sql: attrSql } = await import("drizzle-orm");
            const now = new Date();
            await attrDb.execute(attrSql`
              UPDATE deals SET
                attribution_gclid     = COALESCE(attribution_gclid, ${attrContact.gclid ?? null}),
                attribution_source    = COALESCE(attribution_source, ${attrContact.utmSource ?? null}),
                attribution_medium    = COALESCE(attribution_medium, ${attrContact.utmMedium ?? null}),
                attribution_campaign  = COALESCE(attribution_campaign, ${attrContact.utmCampaign ?? null}),
                booking_attributed_at   = CASE WHEN ${updated.stage} = 'Call Booked' AND booking_attributed_at IS NULL THEN ${now} ELSE booking_attributed_at END,
                conversion_attributed_at = CASE WHEN ${updated.stage} = 'Closed Won' AND conversion_attributed_at IS NULL THEN ${now} ELSE conversion_attributed_at END
              WHERE id = ${updated.id}
            `);
          }).catch(err => console.warn("[Deal Attribution] Wiring failed:", err.message));
        }

        if (updated.stage === "Closed Won") {
          const closedContact = updated.contactId ? await storage.getContact(updated.contactId) : null;
          await createPreferenceAwareNotification({ channel: "internal", title: "Deal Closed Won!", message: `Deal #${updated.id}${closedContact ? ` — ${closedContact.firstName} ${closedContact.lastName}` : ""} has been closed won.`, type: "alert", metadata: { dealId: updated.id, eventType: "deal_closed_won" } }, "deal_closed_won");
          sendCriticalEmailNotification({ eventType: "deal_closed_won", subject: `Closed Won: Deal #${updated.id}${closedContact ? ` — ${closedContact.companyName || closedContact.firstName}` : ""}`, body: `<h3>Deal Closed Won</h3><p>Deal #${updated.id} has moved to <strong>Closed Won</strong>.</p>${closedContact ? `<p>Contact: ${closedContact.firstName} ${closedContact.lastName}${closedContact.companyName ? ` (${closedContact.companyName})` : ""}</p>` : ""}<p>Owner: ${updated.owner || "Unassigned"}</p>`, ownerName: updated.owner }).catch(err => console.error("Closed won email error:", err));

          // Notify referring partner that their merchant just went live.
          import("../services/partner-notifications").then(({ notifyPartnerMerchantWentLive }) => {
            notifyPartnerMerchantWentLive({
              id: updated.id,
              contactId: updated.contactId ?? null,
              referredBy: (updated as any).referredBy ?? null,
              partnerOrgId: (updated as any).partnerOrgId ?? null,
              owner: updated.owner ?? null,
            }).catch(err => console.error("[Deal] Partner go-live notification error:", err.message));
          }).catch(err => console.error("[Deal] Failed to import partner-notifications:", err.message));

          // Onboarding kickoff (deal + SLA tasks + GHL welcome) is fired by advanceDealStage.
        }

        try {
          const matchingRules = await storage.getMatchingStageRules(updated.pipeline, old.stage, updated.stage);
          for (const rule of matchingRules) {
            const ruleActions = (rule.actions as any[]) || [];
            for (const action of ruleActions) {
              if (action.type === "create_task") {
                await storage.createAuthorityTask({
                  title: action.title || `Auto: Stage moved to ${updated.stage}`,
                  assignedTo: action.assignedTo || updated.owner || "Unassigned",
                  priority: action.priority || "medium",
                  dueDate: action.dueHours ? new Date(Date.now() + action.dueHours * 3600000) : undefined,
                  dealId: updated.id,
                  contactId: updated.contactId || undefined,
                });
              } else if (action.type === "send_notification") {
                await storage.createNotification({
                  channel: action.channel || "internal",
                  title: action.title || `Stage Automation: ${rule.name}`,
                  message: action.message || `Deal moved to ${updated.stage}`,
                  type: "info",
                  metadata: { dealId: updated.id, contactId: updated.contactId || undefined, entityType: "deal", entityId: updated.id },
                });
              } else if (action.type === "create_follow_up") {
                const followUpDate = new Date(Date.now() + (action.delayHours || 24) * 3600000);
                await storage.createAuthorityTask({
                  title: action.title || `Follow up: ${updated.stage}`,
                  assignedTo: updated.owner || "Unassigned",
                  priority: "high",
                  dueDate: followUpDate,
                  dealId: updated.id,
                  contactId: updated.contactId || undefined,
                  description: action.description || `Auto-generated follow-up from stage automation rule: ${rule.name}`,
                });
              } else if (action.type === "enroll_sequence" && action.sequenceId) {
                const sequence = await storage.getFollowUpSequence(action.sequenceId);
                if (sequence && decideCr06SequenceLifecycle(sequence).allowed) await storage.createSequenceEnrollment({
                  sequenceId: action.sequenceId,
                  contactId: updated.contactId || undefined,
                  dealId: updated.id,
                  status: "active",
                  nextActionAt: new Date(),
                  currentStep: 0,
                });
              }
            }
            await storage.createAuditLog({
              action: "stage_rule_triggered",
              entityType: "deal",
              entityId: updated.id,
              details: { ruleName: rule.name, fromStage: old.stage, toStage: updated.stage },
            });
          }
        } catch (ruleErr) {
          console.error("Stage automation error:", ruleErr);
        }

        try {
          const contact = updated.contactId ? await storage.getContact(updated.contactId) : null;
          const volumeEst = estimateFromDeal(updated, contact);
          await storage.updateDeal(updated.id, {
            estimatedGrossProfitBps: volumeEst.estimatedGrossProfitBps,
            estimatedGrossProfitMonthly: volumeEst.estimatedGrossProfitMonthly,
            estimatedNetProfitMonthly: volumeEst.estimatedNetProfitMonthly,
            merchantTier: volumeEst.merchantTier,
          });
          if (contact) {
            await updateContactLocalFirst(contact.id, {
              estimatedProcessingVolume: volumeEst.estimatedProcessingVolume,
              estimatedResidual: volumeEst.estimatedResidual,
              volumeConfidence: volumeEst.volumeConfidence,
            });
          }
        } catch (volErr) {
          console.error("Volume estimate recalc error:", volErr);
        }

        autoEnrollFromTrigger("deal_stage_changed", {
          contactId: updated.contactId || undefined,
          dealId: updated.id,
          toStage: updated.stage,
          fromStage: old.stage,
          pipeline: updated.pipeline,
        } as any).catch(err => console.error("Auto-enroll on stage change error:", err));

        triggerWorkflowsByEvent("deal_stage_changed", {
          entityType: "deal",
          entityId: updated.id,
          contactId: updated.contactId || undefined,
          dealId: updated.id,
        }, { toStage: updated.stage, fromStage: old.stage }).catch(err => console.error("Workflow trigger error:", err));

        // GHL sync is handled by advanceDealStage (which was called above for the stage transition).
      }
      // === Terminal Economics: auto-trigger approval task when recommendation changes to a red-tier terminal ===
      const terminalStatus = (updated as any).terminalApprovalStatus as string | null | undefined;
      if (
        old &&
        updated.terminalRecommendation &&
        old.terminalRecommendation !== updated.terminalRecommendation &&
        (!terminalStatus || terminalStatus === "not_required")
      ) {
        (async () => {
          try {
            const econ = await computeDealTerminalEconomics(updated.id);
            if (econ && econ.tier === "red") {
              const managers = await storage.getUsersByRole(["manager"]);
              const managerEmail = managers[0]?.email || process.env.ADMIN_EMAIL || "admin";

              const contact = updated.contactId ? await storage.getContact(updated.contactId) : null;
              const merchantName = contact?.companyName || [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || `Deal #${updated.id}`;
              const paybackStr = econ.paybackMonths ? `${econ.paybackMonths}-month` : "unknown";

              const task = await storage.createAuthorityTask({
                dealId: updated.id,
                contactId: updated.contactId || undefined,
                title: `Terminal approval needed — ${merchantName} — $${econ.terminalCost.toFixed(0)} terminal, ${paybackStr} payback`,
                description: `Terminal "${econ.terminalModel}" on Deal #${updated.id} (${merchantName}) has a payback period of ${econ.paybackMonths ?? "N/A"} months (threshold: ${econ.yellowThreshold} months). Manager approval required before committing the free terminal.\n\nTerminal cost: $${econ.terminalCost.toFixed(0)}\nMonthly GP: $${econ.estimatedMonthlyGrossProfit.toFixed(0)}\nPayback: ${econ.paybackMonths ?? "N/A"} months\n\nApprove or reject at: /dashboard/pipeline?deal=${updated.id}`,
                assignedTo: managerEmail,
                priority: "high",
                dueDate: new Date(Date.now() + 48 * 60 * 60 * 1000),
              });

              await storage.updateDeal(updated.id, {
                terminalApprovalStatus: "pending_approval",
                terminalApprovalTaskId: task.id,
              } as any);

              await storage.createNotification({
                channel: "internal",
                title: "Terminal Approval Required",
                message: `Deal #${updated.id} (${merchantName}) — ${econ.terminalModel} has ${econ.paybackMonths ?? "N/A"}mo payback. Manager approval needed.`,
                type: "urgent",
                recipientId: managerEmail,
                metadata: { dealId: updated.id, terminalModel: econ.terminalModel, paybackMonths: econ.paybackMonths, taskId: task.id },
              });

              await storage.createAuditLog({
                action: "terminal_approval_auto_triggered",
                entityType: "deal",
                entityId: updated.id,
                details: { terminalModel: econ.terminalModel, terminalCost: econ.terminalCost, paybackMonths: econ.paybackMonths, taskId: task.id, assignedTo: managerEmail },
              });

              console.log(`[Terminal Economics] Auto-triggered approval task #${task.id} for Deal #${updated.id} — assigned to ${managerEmail}`);
            }
          } catch (econErr) {
            console.error("[Terminal Economics] Auto-trigger approval error:", econErr);
          }
        })();
      }

      // REV-05A: Serialize deal — masks mid and sanitizes boardingLog.
      const { serializeDeal: _serializeDealUpdate } = await import("../utils/mask-mid");
      res.json(_serializeDealUpdate(updated as any));
    } catch (err: any) {
      // Surface go-live gate blocks as 422 rather than 500
      if(err instanceof DealStageConflictError) return res.status(409).json({
        code:err.code,message:"Displayed deal stage changed. Reload before moving.",dealId:err.dealId,currentStage:err.actual,expectedStage:err.expected});
      if(err instanceof DealStageIllegalTransitionError) return res.status(422).json({code:err.code,message:err.message,dealId:err.dealId,currentStage:err.from});
      if (err instanceof GoLiveGateError) {
        return res.status(422).json({
          code: "GO_LIVE_GATE_FAILED",
          message: "Cannot advance to Go-Live: prerequisites not met",
          missing: err.missing,
          canOverride: false, // no role context here — client should use the pre-flight check
        });
      }
      serverError(res, err);
    }
  });

  app.post("/api/deals/:id/recalculate-volume", isDashboardUser, async (req, res) => {
    try {
      const deal = await storage.getDeal(Number(req.params.id));
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      const contact = deal.contactId ? await storage.getContact(deal.contactId) : null;
      const estimate = estimateFromDeal(deal, contact);
      await storage.updateDeal(deal.id, {
        estimatedGrossProfitBps: estimate.estimatedGrossProfitBps,
        estimatedGrossProfitMonthly: estimate.estimatedGrossProfitMonthly,
        estimatedNetProfitMonthly: estimate.estimatedNetProfitMonthly,
        merchantTier: estimate.merchantTier,
      });
      if (contact) {
        await updateContactLocalFirst(contact.id, {
          estimatedProcessingVolume: estimate.estimatedProcessingVolume,
          estimatedResidual: estimate.estimatedResidual,
          volumeConfidence: estimate.volumeConfidence,
        });
      }
      res.json({ success: true, estimate });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/contacts/:id/recalculate-volume", isDashboardUser, async (req, res) => {
    try {
      const contact = await storage.getContact(Number(req.params.id));
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      const estimate = estimateFromContact(contact);
      await updateContactLocalFirst(contact.id, {
        estimatedProcessingVolume: estimate.estimatedProcessingVolume,
        estimatedResidual: estimate.estimatedResidual,
        volumeConfidence: estimate.volumeConfidence,
      });
      res.json({ success: true, estimate });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/prospects/:id/recalculate-volume", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const prospect = await storage.getProspect(Number(req.params.id));
      if (!prospect) return res.status(404).json({ message: "Prospect not found" });
      const estimate = estimateFromProspect(prospect);
      await storage.updateProspect(prospect.id, {
        estimatedVolume: estimate.estimatedProcessingVolume,
        estimatedResidual: estimate.estimatedResidual,
        estimatedAvgTicket: estimate.estimatedAvgTicket,
      });
      res.json({ success: true, estimate });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  app.post("/api/deals/:id/sync-analysis-to-ghl", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.id);
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const contact = deal.contactId ? await storage.getContact(deal.contactId) : null;
      if (!contact || !contact.ghlContactId) {
        return res.status(400).json({ message: "Contact not linked to GHL" });
      }

      const proposal = deal.savingsProposal as any;
      if (!proposal) return res.status(400).json({ message: "No analysis available to sync" });

      const fields: Record<string, string> = {
        "lb_current_rate": proposal.currentState?.effectiveRate || "",
        "lb_monthly_volume": proposal.currentState?.monthlyVolume?.toString() || "",
        "lb_estimated_savings": proposal.plans?.find((p: any) => p.shortName === proposal.recommendedPlan)?.annualSavings?.toString() || "",
        "lb_recommended_program": proposal.recommendedPlan || "",
      };

      if (proposal.verticalInsights) {
        fields["lb_vertical_benchmark"] = proposal.verticalInsights.verticalBenchmark || "";
        fields["lb_opportunity_score"] = proposal.verticalInsights.opportunityScore?.toString() || "";
      }

      if (!(await requireGhlRouteMutationAllowed(res))) return;
      await updateCustomFields(contact.ghlContactId, fields);
      await enrollInGhlWorkflowCompliant({
        workflowKey: "statement_analyzed",
        ghlContactId: contact.ghlContactId,
        contactId: contact.id,
        metadata: { dealId: deal.id, analysisDate: new Date().toISOString() }
      });

      await storage.createAuditLog({
        action: "ghl_analysis_sync",
        entityType: "deal",
        entityId: deal.id,
        details: { fields }
      });

      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === DEAL COMPETITORS ===
  app.get("/api/deal-competitors", isDashboardUser, async (req, res) => {
    try {
      const competitors = await storage.getDealCompetitors();
      res.json(competitors);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/deal-competitors/deal/:dealId", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.dealId);
      if (!await authorizeDealAccess(req, res, dealId)) return;
      const competitors = await storage.getDealCompetitorsByDeal(dealId);
      res.json(competitors);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/deal-competitors", isDashboardUser, async (req, res) => {
    try {
      const input = insertDealCompetitorSchema.parse(req.body);
      if (!input.dealId) return denyCrmObject(res);
      if (!await authorizeDealAccess(req, res, input.dealId)) return;
      const competitor = await storage.createDealCompetitor(input);
      res.status(201).json(competitor);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join('.') });
      res.status(400).json({ message: err.message });
    }
  });

  app.patch("/api/deal-competitors/:id", isDashboardUser, async (req, res) => {
    try {
      const competitor = await storage.getDealCompetitor(Number(req.params.id));
      if (!competitor?.dealId || !await authorizeDealAccess(req, res, competitor.dealId)) return;
      const updated = await storage.updateDealCompetitor(Number(req.params.id), req.body);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ message: err.message });
    }
  });


  // === STAGE AUTOMATION RULES ===
  app.get("/api/stage-rules", isDashboardUser, async (req, res) => {
    try {
      const pipeline = req.query.pipeline as string | undefined;
      const rules = await storage.getStageAutomationRules(pipeline);
      res.json(rules);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/stage-rules/:id", isDashboardUser, async (req, res) => {
    try {
      const rule = await storage.getStageAutomationRule(Number(req.params.id));
      if (!rule) return res.status(404).json({ message: "Not found" });
      res.json(rule);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/stage-rules", requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertStageAutomationRuleSchema.parse(req.body);
      const rule = await storage.createStageAutomationRule(input);
      await storage.createAuditLog({ action: "stage_rule_created", entityType: "stage_rule", entityId: rule.id, details: { name: rule.name, pipeline: rule.pipeline } });
      res.status(201).json(rule);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.put("/api/stage-rules/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const updated = await storage.updateStageAutomationRule(Number(req.params.id), req.body);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.delete("/api/stage-rules/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      await storage.deleteStageAutomationRule(Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === PIPELINE STAGES CONFIGURATION ===
  app.get("/api/pipeline-stages", isDashboardUser, async (req, res) => {
    try {
      const pipeline = req.query.pipeline ? String(req.query.pipeline) : undefined;
      const stages = await storage.getPipelineStages(pipeline);
      res.json(stages);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/pipeline-stages", requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertPipelineStageSchema.parse(req.body);
      const stage = await storage.createPipelineStage(input);
      res.status(201).json(stage);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.put("/api/pipeline-stages/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const updated = await storage.updatePipelineStage(Number(req.params.id), req.body);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.delete("/api/pipeline-stages/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      await storage.deletePipelineStage(Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/pipeline-stages/reorder", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { stages } = req.body;
      if (!Array.isArray(stages)) return res.status(400).json({ message: "stages array required" });
      for (const s of stages) {
        await storage.updatePipelineStage(s.id, { sortOrder: s.sortOrder });
      }
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === AUTO DEAL STAGE PROGRESSION ===
  app.post("/api/ai/auto-progress-deals", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { data: allDeals } = await storage.getDeals({ limit: 500 });
      const salesDeals = allDeals.filter(d => d.pipeline === "sales" && d.stage !== "Closed Won" && d.stage !== "Closed Lost");
      const progressions: Array<{ dealId: number; from: string; to: string; reason: string }> = [];

      const stageOrder = ["New Lead", "Statement Received", "Review In Progress", "Call Booked", "Proposal Sent", "Negotiation / Follow-Up", "Verbal Commit", "Closed Won"];

      for (const deal of salesDeals) {
        const currentIndex = stageOrder.indexOf(deal.stage);
        if (currentIndex < 0) continue;

        let shouldAdvance = false;
        let reason = "";

        if (deal.stage === "New Lead" && deal.lastStatementReviewDate) {
          shouldAdvance = true;
          reason = "Statement document received - advancing to review";
        }
        if (deal.stage === "Statement Received" && deal.recommendedPath) {
          shouldAdvance = true;
          reason = "Statement review completed with recommendation - advancing to in-progress";
        }
        if (deal.stage === "Review In Progress" && deal.effectiveRate) {
          shouldAdvance = true;
          reason = "Review analysis complete - advancing to proposal sent";
        }

        if (shouldAdvance && currentIndex + 1 < stageOrder.length) {
          const nextStage = stageOrder[currentIndex + 1];
          await advanceDealStage(deal.id, nextStage, "ai_auto_progress");
          progressions.push({ dealId: deal.id, from: deal.stage, to: nextStage, reason });
          await storage.createAuditLog({ action: "deal_auto_progressed", entityType: "deal", entityId: deal.id, details: { from: deal.stage, to: nextStage, reason } });
        }
      }

      const noOpReason = progressions.length === 0
        ? "No active sales deals met the criteria for automatic stage advancement."
        : undefined;

      if (noOpReason) {
        // Record that the button was actually run, even though no deal qualified —
        // otherwise the Command Center's run-count/last-run would look like the
        // action never executed even though it did (it just found nothing to do).
        await storage.createAuditLog({
          action: "deal_auto_progressed",
          entityType: "system",
          entityId: 0,
          details: { progressed: 0, actorId: (req as any).user?.id, resultState: "no_op_with_reason", reason: noOpReason },
        }).catch((err: any) => console.error("[AI] Failed to write no-op deal_auto_progressed audit log:", err.message));
      }

      res.json({ progressed: progressions.length, progressions, reason: noOpReason });
    } catch (err: any) {
      const info = classifyAiError(err);
      if (info.kind === "credential" || info.kind === "quota") {
        await logAiCredentialError({
          triggerType: "advisor",
          actorType: (req as any).user?.role,
          actorId: (req as any).user?.id?.toString(),
          error: err?.message ?? String(err),
        });
        res.json({ error: true, errorType: info.kind, message: info.userMessage });
      } else {
        serverError(res, err);
      }
    }
  });


  // === STATEMENT ANALYSIS ===
  app.get("/api/deals/:id/analysis", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.id);
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const [proposal] = await db
        .select()
        .from(statementProposals)
        .where(eq(statementProposals.dealId, dealId))
        .orderBy(desc(statementProposals.id))
        .limit(1);

      // Check whether a statement document exists for this deal
      const statementCategories = ["Processing Statement", "Rate Review Statement"];
      const dealDocs = await db
        .select({ id: documents.id, category: documents.category })
        .from(documents)
        .where(eq(documents.dealId, dealId));
      const hasStatementDoc = dealDocs.some(
        (d) => d.category && statementCategories.includes(d.category)
      );

      res.json({
        analysisStatus: deal.analysisStatus ?? "none",
        proposal: proposal ?? null,
        hasStatementDoc,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === STATEMENT RE-ANALYSIS ===
  app.post("/api/deals/:id/reanalyze-statement", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.id);
      if (!Number.isFinite(dealId) || dealId <= 0) {
        return res.status(404).json({ message: "Not found" });
      }

      const deal = await storage.getDeal(dealId);
      if (!deal || deal.archivedAt) return res.status(404).json({ message: "Deal not found" });

      // Find the most recent statement document linked to this deal
      const statementCategories = ["Processing Statement", "Rate Review Statement"];
      const allDocs = await db
        .select()
        .from(documents)
        .where(eq(documents.dealId, dealId))
        .orderBy(desc(documents.createdAt));

      const statementDoc = allDocs.find(
        (d) => d.category && statementCategories.includes(d.category)
      );

      if (!statementDoc) {
        return res.status(404).json({ message: "No statement document found for this deal" });
      }

      // Rate-limit: reject if re-analysis was already queued in the last 5 minutes
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const recentLog = await storage.getAuditLogs({
        entityType: "deal",
        entityId: dealId,
        startDate: fiveMinutesAgo,
        limit: 10,
      });
      const recentReanalyze = recentLog.find(
        (l: any) => l.action === "statement_reanalysis_queued"
      );
      if (recentReanalyze) {
        const retryAfterMs = new Date(recentReanalyze.createdAt!).getTime() + 5 * 60 * 1000 - Date.now();
        const retryAfterSecs = Math.ceil(retryAfterMs / 1000);
        return res.status(429).json({
          message: "Re-analysis already queued recently. Please wait before trying again.",
          retryAfterSeconds: retryAfterSecs,
        });
      }

      // Enqueue the statement-blueprint BullMQ job
      const { enqueueStatementAnalysis } = await import("../services/queue-manager");
      const jobId = await enqueueStatementAnalysis(dealId);

      // If the queue is unavailable, tell the caller rather than silently returning 202
      if (!jobId) {
        return res.status(503).json({
          message: "Statement queue is temporarily unavailable. Please try again in a moment.",
        });
      }

      // Log only after confirmed enqueue
      await storage.createAuditLog({
        action: "statement_reanalysis_queued",
        entityType: "deal",
        entityId: dealId,
        userId: String((req.user as any)?.id ?? ""),
        actorType: "user",
        actorId: String((req.user as any)?.id ?? ""),
        details: {
          documentId: statementDoc.id,
          documentName: statementDoc.fileName,
          jobId,
          queuedBy: (req.user as any)?.email ?? "unknown",
        },
      });

      return res.status(202).json({
        jobId,
        documentId: statementDoc.id,
        message: "Statement re-analysis queued",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === CHECKLIST SUMMARY ===
  // Returns { total, completed } for the deal's onboarding checklist.
  // "completed" = items in a terminal-progress state (received or approved).
  // "requested" is still pending (awaiting merchant action); "rejected" is a dead end, not done.
  app.get("/api/deals/:id/checklist-summary", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.id);
      if (!Number.isFinite(dealId) || dealId <= 0) {
        return res.status(404).json({ message: "Not found" });
      }
      const items = await storage.getOnboardingChecklistItems(dealId);
      const total = items.length;
      // Only "received" and "approved" count as done — "requested" is still pending, "rejected" is a dead-end
      const completed = items.filter((i) => i.status === "received" || i.status === "approved").length;
      res.json({ total, completed });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /**
   * GET /api/deals/:id/underwriting-tasks
   * #1445 — Return all underwriting checklist tasks for a deal.
   * Tasks are auto-created by initUnderwritingChecklist when a deal enters an underwriting stage.
   * Applies the same agent-ownership guard as GET /api/deals/:id.
   */
  app.get("/api/deals/:id/underwriting-tasks", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.id);
      if (!Number.isFinite(dealId) || dealId <= 0) {
        return res.status(400).json({ message: "Invalid deal ID" });
      }
      // Ownership guard: agents may only view tasks for their own deals.
      const deal = await storage.getDeal(dealId);
      if (!deal || deal.archivedAt) return res.status(404).json({ message: "Not found" });
      const role = (req.user as any)?.role;
      const userEmail = (req.user as any)?.email;
      if (role === "agent" && deal.owner && deal.owner !== userEmail) {
        return res.status(403).json({ message: "Forbidden", code: "NOT_YOUR_DEAL" });
      }
      const { db: dbConn } = await import("../db");
      const { tasks: tasksTable } = await import("../../shared/schema");
      const { eq, and, asc } = await import("drizzle-orm");
      const rows = await dbConn
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.dealId, dealId), eq((tasksTable as any).source, "underwriting")))
        .orderBy(asc(tasksTable.dueDate));
      res.json(rows);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  /**
   * PATCH /api/deals/:id/underwriting-tasks/:taskId
   * #1445 — Toggle the status of an underwriting checklist task (pending ↔ completed).
   * Applies the same agent-ownership guard as PUT /api/deals/:id.
   */
  app.patch("/api/deals/:id/underwriting-tasks/:taskId", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.id);
      const taskId = Number(req.params.taskId);
      if (!Number.isFinite(dealId) || !Number.isFinite(taskId)) {
        return res.status(400).json({ message: "Invalid ID" });
      }
      // Ownership guard: agents may only modify tasks on their own deals.
      const deal = await storage.getDeal(dealId);
      if (!deal || deal.archivedAt) return res.status(404).json({ message: "Not found" });
      const role = (req.user as any)?.role;
      const userEmail = (req.user as any)?.email;
      if (role === "agent" && deal.owner && deal.owner !== userEmail) {
        return res.status(403).json({ message: "Forbidden", code: "NOT_YOUR_DEAL" });
      }
      const { status } = req.body as { status?: string };
      const allowed = ["pending", "completed", "skipped"];
      if (!status || !allowed.includes(status)) {
        return res.status(400).json({ message: `status must be one of: ${allowed.join(", ")}` });
      }
      const { db: dbConn } = await import("../db");
      const { tasks: tasksTable } = await import("../../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const [updated] = await dbConn
        .update(tasksTable)
        .set({
          status,
          ...(status === "completed"
            ? { completedAt: new Date() }
            : { completedAt: null }),
        } as any)
        .where(and(eq(tasksTable.id, taskId), eq(tasksTable.dealId, dealId)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Task not found on this deal" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === ENHANCED DEAL STAGE CHANGE WITH AUTOMATION ===
  // (Stage automation is now handled in the existing PUT /api/deals/:id route enhancement)

}
