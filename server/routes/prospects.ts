import type { Express } from "express";
import { isAuthenticated, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { z } from "zod";
import { DateValidationError } from "../utils/date-coerce";
import { insertProspectListSchema, insertProspectSchema } from "@shared/schema";
import { enqueuePromotionalEnrollment } from "../services/promotional-enrollment-eligibility";
import { scoreContact } from "../services/lead-scoring";
import { generateDealBlueprint } from "../services/deal-blueprint";
import { getRoutingRecommendation, routeContact } from "../services/smart-router";
import { getEntityDetail, parseSunbizCsv, searchSunbiz, streamCorevtFromZip } from "../services/sunbiz-scraper";
import { isMassEnrichmentRunning, reEnrichAllSunbizEntities, runMassEnrichment } from "../services/daily-outreach";
import { importExecutions } from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { convertToProspect, deepEnrichEntity, enrichSunbizEntitySafe, isPipelineRunning, processSunbizEnrichmentBatch, processSunbizEnrichmentQueue, runAutoDeduplication, runBulkAIClassification, runDailyEnrichmentPipeline } from "../services/sunbiz-enrichment";
import { parse } from "csv-parse/sync";
import path from "path";
import fs from "fs";
import { upload, uploadLarge } from "./helpers";
import { computeFileHash, computeRowFingerprint, isValidEmailFormat, normalizeProspectEmail, normalizeProspectPhone } from "../services/import-normalizer";
import { prospectConversionMinReadiness } from "../config";
import { computeProspectConversionReadiness } from "../services/contact-readiness";
import {
  convertProspectDurably,
} from "../services/prospect-conversion";
import { serverError, safeMessage } from "../utils/server-error";
import { createCro03SourceBatch } from "../services/cro03/source-staging";
import { isProspectListReplayConflict } from "../storage/prospects";

export function registerProspectsRoutes(app: Express) {
  /** Evidence-first staging intake. Enrichment never implies CRM promotion. */
  async function createCro03BatchForProspects(input: {
    prospectIds: number[];
    idempotencyKey: string;
    actorId: string;
  }) {
    const blocked: Array<{ prospectId: number; code: string }> = [];
    const subjects: Parameters<typeof createCro03SourceBatch>[0]["subjects"] = [];
    for (const prospectId of [...new Set(input.prospectIds)].slice(0, 1000)) {
      const prospect = await storage.getProspect(prospectId);
      if (!prospect) {
        blocked.push({ prospectId, code: "PROSPECT_NOT_FOUND" });
        continue;
      }
      subjects.push({
        subjectType: "prospect", subjectKey: String(prospectId), sourceSystem: "prospect_staging",
        payload: {
          prospectId, companyName: prospect.companyName ?? null, firstName: prospect.ownerFirstName ?? null,
          lastName: prospect.ownerLastName ?? null, email: prospect.email ?? prospect.ownerEmail ?? null,
          phone: prospect.phone ?? prospect.ownerPhone ?? null,
          website: prospect.website ?? null, city: prospect.city ?? null, state: prospect.state ?? null,
          industry: prospect.vertical ?? null,
        },
        provenance: { sourceSystem: "prospect_staging", prospectId, existingContactId: prospect.contactId ?? null },
        candidateValues: {
          ...(prospect.companyName ? { business_name: prospect.companyName } : {}),
          ...(prospect.email ? { email: prospect.email } : {}),
          ...(prospect.phone ? { phone: prospect.phone } : {}),
          ...(prospect.website ? { website: prospect.website } : {}),
          ...(prospect.city ? { city: prospect.city } : {}),
          ...(prospect.state ? { state: prospect.state } : {}),
        },
      });
    }
    if (subjects.length === 0) {
      return { batch: null, blocked, contactIds: [] };
    }
    const batch = await createCro03SourceBatch({
      idempotencyKey: input.idempotencyKey, subjects,
      actorType: "user", actorId: input.actorId, purpose: "staging_review",
    });
    return { batch, blocked, contactIds: [] };
  }

  function sunbizSourceSubject(entityId: number, rawEntity: unknown): Parameters<typeof createCro03SourceBatch>[0]["subjects"][number] {
    const entity = rawEntity as Record<string, any>;
    const companyName = entity.entityName ?? entity.businessName ?? entity.name ?? null;
    const address = entity.principalAddress ?? entity.address ?? null;
    return {
      subjectType: "sunbiz_entity", subjectKey: String(entityId), sourceSystem: "sunbiz",
      payload: {
        entityId, filingNumber: entity.filingNumber ?? null, companyName,
        entityStatus: entity.entityStatus ?? null, address, city: entity.principalCity ?? null,
        state: entity.principalState ?? null, postalCode: entity.principalZip ?? null,
      },
      provenance: { sourceSystem: "sunbiz", entityId, importExecutionId: entity.importExecutionId ?? null },
      sourceEventKey: `sunbiz:${entityId}:${entity.updatedAt ? new Date(entity.updatedAt).toISOString() : "snapshot"}`,
      sourceObservedAt: entity.updatedAt ? new Date(entity.updatedAt).toISOString() : undefined,
      timestampProvenance: entity.updatedAt ? "source" : "ingestion_only",
      candidateValues: {
        ...(companyName ? { business_name: String(companyName) } : {}),
        ...(entity.filingNumber ? { registry_id: String(entity.filingNumber) } : {}),
        ...(address ? { address: String(address) } : {}),
        ...(entity.principalCity ? { city: String(entity.principalCity) } : {}),
        ...(entity.principalState ? { state: String(entity.principalState) } : {}),
        ...(entity.principalZip ? { postal_code: String(entity.principalZip) } : {}),
        ...(entity.entityStatus ? { entity_status: String(entity.entityStatus) } : {}),
      },
    };
  }

  // === PROSPECT LISTS ===
  app.get("/api/prospect-lists", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const lists = await storage.getProspectLists({ includeArchived });
      res.json(lists);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Archive a specific prospect list (soft-delete)
  app.post("/api/prospect-lists/:id/archive", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const user = req.user as any;
      if (user?.role !== "admin") return res.status(403).json({ message: "Admin only" });
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid list ID" });
      const reason = (req.body?.reason as string) || "manual_archive";
      const list = await storage.archiveProspectList(id, reason);
      if (!list) return res.status(404).json({ message: "List not found" });
      res.json(list);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Advance readiness state for a prospect list (staged pipeline)
  app.post("/api/prospect-lists/:id/readiness", isDashboardUser, requireRole("admin"), async (req, res) => {
    try {
      const user = req.user as any;
      if (user?.role !== "admin") return res.status(403).json({ message: "Admin only" });
      const id = Number(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid list ID" });

      const VALID_STATES = ["uploaded", "mapped", "validated", "scored", "suppressed", "ready"];
      const state = req.body?.state as string;
      if (!VALID_STATES.includes(state)) {
        return res.status(400).json({ message: `state must be one of: ${VALID_STATES.join(", ")}` });
      }

      const list = await storage.updateProspectList(id, { readinessState: state });
      if (!list) return res.status(404).json({ message: "List not found" });

      await storage.createAuditLog({
        action: "prospect_list_readiness_updated",
        entityType: "prospect_list",
        entityId: id,
        details: { newState: state, actorId: user?.id } as any,
      });

      res.json(list);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // BT-06: heuristic name-based demo cleanup is permanently disabled.
  app.post("/api/prospect-lists/demo-cleanup", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    return res.status(410).json({
      error: "Gone",
      message: "Heuristic demo cleanup is disabled. Use commercial classification reconciliation instead.",
    });
  });

  app.get("/api/prospect-lists/:id", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const list = await storage.getProspectList(Number(req.params.id));
      if (!list) return res.status(404).json({ message: "List not found" });
      res.json(list);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/prospect-lists", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertProspectListSchema.parse(req.body);
      const list = await storage.createProspectList(input);
      res.status(201).json(list);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });


  // === PROSPECTS ===
  // Server pagination: total is the filtered total across the whole table, and
  // search/vertical/score/sort run in SQL so rows beyond one page are reachable.
  const prospectListQuery = z.object({
    listId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(10_000_000).optional(),
    search: z.string().trim().max(200).optional(),
    vertical: z.string().trim().min(1).max(200).optional(),
    score: z.enum(["hot", "warm", "cold"]).optional(),
    scoreSort: z.enum(["asc", "desc"]).optional(),
  }).strict();
  app.get("/api/prospects", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const parsed = prospectListQuery.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ message: `Invalid prospect query: ${parsed.error.errors[0].path.join(".")}` });
      const { listId, limit, offset, search, vertical, score, scoreSort } = parsed.data;
      const result = await storage.getProspects(listId, { limit, offset }, { search: search || undefined, vertical, score, scoreSort });
      res.json(result);
    } catch (err: any) {
      console.error("Get prospects error:", err.message);
      serverError(res, err);
    }
  });

  app.get("/api/prospects/verticals", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const listId = req.query.listId ? Number(req.query.listId) : undefined;
      if (listId !== undefined && !Number.isSafeInteger(listId)) return res.status(400).json({ message: "Invalid listId" });
      res.json({ verticals: await storage.getProspectVerticals(listId) });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/prospects/:id", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const prospect = await storage.getProspect(Number(req.params.id));
      if (!prospect) return res.status(404).json({ message: "Prospect not found" });
      res.json(prospect);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/prospects", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertProspectSchema.parse(req.body);
      const prospect = await storage.createProspect(input);
      res.status(201).json(prospect);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.put("/api/prospects/:id", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const nullableString = z.string().nullable().optional();
      const body = z.object({
        companyName: nullableString, dba: nullableString, website: nullableString,
        phone: nullableString, email: nullableString, ownerFirstName: nullableString,
        ownerLastName: nullableString, ownerEmail: nullableString, ownerPhone: nullableString,
        address: nullableString, city: nullableString, state: nullableString, zip: nullableString,
        vertical: nullableString, estimatedVolume: nullableString, estimatedResidual: nullableString,
        estimatedAvgTicket: nullableString, estimatedProcessor: nullableString,
        employeeCount: nullableString, yearEstablished: nullableString, googleRating: nullableString,
        googleReviews: nullableString, estimatedRevenue: nullableString, notes: nullableString,
        tags: z.array(z.string()).nullable().optional(),
        doNotContact: z.boolean().nullable().optional(),
        lastContactedAt: z.coerce.date().nullable().optional(),
      }).strict().parse(req.body);
      const updated = await storage.updateProspect(Number(req.params.id), body);
      if (!updated) return res.status(404).json({ message: "Prospect not found" });
      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: "Invalid prospect update payload", field: err.errors[0].path.join(".") || undefined });
      if (err instanceof DateValidationError) return res.status(400).json({ message: err.message, field: err.field });
      serverError(res, err);
    }
  });

  app.post("/api/prospects/:id/convert", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const prospect = await storage.getProspect(Number(req.params.id));
      if (!prospect) return res.status(404).json({ message: "Prospect not found" });

      // (A) Already converted — short-circuit before any claim attempt
      if (prospect.contactId) {
        return res.json({
          status: "already_converted",
          contactId: prospect.contactId,
          message: "Prospect already converted",
        });
      }

      const threshold = prospectConversionMinReadiness;
      const readiness = computeProspectConversionReadiness(prospect, threshold);
      const { conversionReadinessScore, meetsThreshold } = readiness;

      // (B) Override parsing — must happen before any claim or contact creation
      const override = req.body?.override;
      const hasOverride = override?.enabled === true;
      if (hasOverride) {
        const user = req.user as any;
        const role = user?.role;
        if (role !== "admin") {
          return res.status(403).json({
            error: "override_unauthorized",
            message: "Only admins can override the readiness threshold",
          });
        }
        if (!override.reason || typeof override.reason !== "string" || !override.reason.trim()) {
          return res.status(400).json({ error: "override_reason_required", message: "override.reason is required" });
        }
      }

      // (C) Threshold gate
      if (!meetsThreshold && !hasOverride) {
        return res.status(422).json({
          error: "readiness_below_threshold",
          conversionReadinessScore,
          threshold,
          grade: readiness.grade,
          missingFields: readiness.missingFields,
        });
      }

      // (D) Override audit — written on every valid override attempt (success OR failure)
      if (hasOverride) {
        storage.createAuditLog({
          action: "prospect_conversion_override",
          entityType: "prospect",
          entityId: prospect.id,
          details: {
            actor: (req.user as any)?.id,
            prospectIds: [prospect.id],
            threshold,
            scores: [{ prospectId: prospect.id, conversionReadinessScore }],
            reason: override.reason,
            outcome: "attempted",
          },
        }).catch(err => console.error("[Convert] Override audit write failed:", err));
      }

      const conversion = await convertProspectDurably(prospect, (req.user as any)?.id?.toString());
      if (conversion.status === "already_converted") {
        return res.json({ status: "already_converted", contactId: conversion.contactId, message: "Prospect already converted" });
      }
      if (conversion.status === "conversion_in_progress") {
        return res.status(409).json({ error: "conversion_in_progress", contactId: conversion.contactId, message: "Another conversion is in progress — retry in a few seconds" });
      }
      if (conversion.status === "conflict_incompatible_identity") {
        return res.status(409).json({ error: "conflict_incompatible_identity", message: "An existing contact has a different identity" });
      }
      if (conversion.status === "failed") {
        return res.status(500).json({ error: conversion.reasonCode, message: "Conversion could not be completed" });
      }

      const { contactId: convertedContactId, dealId } = conversion;
      scoreContact(convertedContactId).catch(err => console.error("[Convert] Scoring error:", err));
      routeContact(convertedContactId).catch(err => console.error("[Convert] Routing error:", err));
      generateDealBlueprint(dealId).catch(err => console.error("[Convert] Blueprint error:", err));
      storage.getMatchingStageRules("sales", null, "New Lead").then(async (rules) => {
        for (const rule of rules) for (const action of ((rule.actions as any[]) || [])) {
          if (action.type === "create_task") await storage.createAuthorityTask({
            title: action.title || "Auto: New Lead", assignedTo: action.assignedTo || "Scott Stevenson",
            priority: action.priority || "medium", dueDate: action.dueHours ? new Date(Date.now() + action.dueHours * 3600000) : undefined, dealId, contactId: convertedContactId,
          });
          else if (action.type === "send_notification") await storage.createNotification({
            channel: action.channel || "internal", title: action.title || `Stage Automation: ${rule.name}`,
            message: action.message || "New lead entered pipeline", type: "info",
          });
        }
      }).catch(err => console.error("[Convert] Stage rule error:", err));
      let enrollmentOutcome: { status: string; jobId?: string } = { status: "not_attempted" };
      try {
        enrollmentOutcome = await enqueuePromotionalEnrollment({ contactId: convertedContactId, triggerType: "contact_created", sourceEventId: `prospect-convert-${prospect.id}` });
      } catch {
        enrollmentOutcome = { status: "enrollment_error" };
      }
      await storage.createAuditLog({
        action: "prospect_converted", entityType: "contact", entityId: convertedContactId,
        details: { prospectId: prospect.id, dealId, company: prospect.companyName },
      });
      return res.json({ status: "converted", contactId: convertedContactId, dealId, conversionReadinessScore, threshold, enrollmentOutcome });
    } catch (err: any) {
      if (err?.name === "ClaimLostError") {
        return res.status(409).json({
          error: "claim_lost",
          message: "Conversion claim expired during processing — retry to check status",
          dealId: (err as any).dealId ?? undefined,
        });
      }
      serverError(res, err);
    }
  });

  /**
   * POST /api/prospects/convert-batch
   *
   * BATCH CONVERSION — PER-ITEM ISOLATION CONTRACT
   * ================================================
   * This handler converts up to 50 prospects in a single request while
   * guaranteeing that one failure CANNOT abort or corrupt the remaining items.
   *
   * Key invariants — DO NOT break these:
   *
   * 1. ISOLATION: Every prospect is processed inside its own inner try/catch
   *    (lines ~511–626). The catch block pushes a { status: "failed" } result
   *    and then the loop continues — it does NOT re-throw.
   *
   * 2. COMPLETE RESULTS: Every input ID receives exactly one entry in `results[]`
   *    before the loop moves on (via results.push(...) + continue, or the
   *    success push at the bottom of the try block). The final response always
   *    contains one result per requested ID.
   *
   * 3. HTTP 200 ALWAYS: res.json() is called unconditionally after the loop.
   *    The outer try/catch only fires for structural errors (bad request body,
   *    auth failures) that occur before the loop starts — individual item
   *    failures never reach the outer catch.
   *
   * 4. CLAIM RELEASE ON FAILURE: The inner catch always calls
   *    releaseClaimWithError(...).catch(() => {}) so a failed item never leaves
   *    a prospect stuck in "claimed" status. The .catch(() => {}) on the release
   *    itself prevents a release failure from propagating.
   *
   * 5. DB LOAD SAFEGUARD: Any unexpected error thrown by storage, writeContact,
   *    completeConversionTransaction, etc. is caught by the inner try/catch and
   *    recorded as status:"failed" for that item. The batch as a whole still
   *    returns 200 with a full results array and summary counts.
   *
   * Cap: rawIds.slice(0, 50) enforces a hard maximum of 50 items per request.
   */
  app.post("/api/prospects/convert-batch", isDashboardUser, requireRole("admin", "manager"), async (req, res) => {
    try {
      const { prospectIds: rawIds, override } = req.body as { prospectIds: number[]; override?: { enabled?: boolean; reason?: string } };
      if (!rawIds?.length) return res.status(400).json({ message: "No prospect IDs provided" });

      // Admin override validation — before any claim or contact creation
      const hasOverride = override?.enabled === true;
      if (hasOverride) {
        const user = req.user as any;
        if (user?.role !== "admin") {
          return res.status(403).json({
            error: "override_unauthorized",
            message: "Only admins can override the readiness threshold",
          });
        }
        if (!override!.reason || typeof override!.reason !== "string" || !override!.reason.trim()) {
          return res.status(400).json({ error: "override_reason_required", message: "override.reason is required" });
        }
      }

      // Deduplicate input but track original positions
      const inputIds = rawIds.slice(0, 50);
      const seenIds = new Set<number>();

      const threshold = prospectConversionMinReadiness;

      interface BatchResult {
        prospectId: number;
        status: "converted" | "already_converted" | "conversion_in_progress" | "readiness_below_threshold" | "conflict_incompatible_identity" | "failed" | "not_found";
        conversionReadinessScore?: number;
        threshold?: number;
        contactId?: number;
        dealId?: number;
        claimId?: string;
        reasonCode?: string;
        enrollmentOutcome?: { status: string; jobId?: string };
      }

      const results: BatchResult[] = [];
      const overrideScores: Array<{ prospectId: number; conversionReadinessScore: number }> = [];

      for (const pid of inputIds) {
        // Return a result for every input position including duplicates
        if (seenIds.has(pid)) {
          // Duplicate in input — find what we already know about it
          const prior = results.find(r => r.prospectId === pid);
          results.push(prior ? { ...prior } : { prospectId: pid, status: "already_converted", reasonCode: "duplicate_in_input" });
          continue;
        }
        seenIds.add(pid);

        const prospect = await storage.getProspect(pid);
        if (!prospect) {
          results.push({ prospectId: pid, status: "not_found" });
          continue;
        }

        // Already converted — short-circuit
        if (prospect.contactId) {
          results.push({ prospectId: pid, status: "already_converted", contactId: prospect.contactId });
          continue;
        }

        // Readiness score
        const readiness = computeProspectConversionReadiness(prospect, threshold);
        const { conversionReadinessScore, meetsThreshold } = readiness;
        overrideScores.push({ prospectId: pid, conversionReadinessScore });

        if (!meetsThreshold && !hasOverride) {
          results.push({
            prospectId: pid,
            status: "readiness_below_threshold",
            conversionReadinessScore,
            threshold,
          });
          continue;
        }

        try {
          const conversion = await convertProspectDurably(prospect, (req.user as any)?.id?.toString());
          if (conversion.status === "converted") {
            scoreContact(conversion.contactId).catch(() => {});
            routeContact(conversion.contactId).catch(() => {});
            generateDealBlueprint(conversion.dealId).catch(() => {});
            let enrollmentOutcome: { status: string; jobId?: string } = { status: "not_attempted" };
            try {
              enrollmentOutcome = await enqueuePromotionalEnrollment({
                contactId: conversion.contactId,
                triggerType: "contact_created",
                sourceEventId: `prospect-convert-${pid}`,
              });
            } catch {
              enrollmentOutcome = { status: "enrollment_error" };
            }
            results.push({
              prospectId: pid, status: "converted", contactId: conversion.contactId,
              dealId: conversion.dealId, claimId: conversion.claimId,
              conversionReadinessScore, threshold, enrollmentOutcome,
            });
          } else if (conversion.status === "already_converted") {
            results.push({ prospectId: pid, status: "already_converted", contactId: conversion.contactId, conversionReadinessScore });
          } else if (conversion.status === "conversion_in_progress") {
            results.push({ prospectId: pid, status: "conversion_in_progress", contactId: conversion.contactId, conversionReadinessScore });
          } else if (conversion.status === "conflict_incompatible_identity") {
            results.push({ prospectId: pid, status: "conflict_incompatible_identity", claimId: conversion.claimId, conversionReadinessScore, reasonCode: "conflict_incompatible_identity" });
          } else {
            results.push({ prospectId: pid, status: "failed", claimId: conversion.claimId, conversionReadinessScore, reasonCode: conversion.reasonCode });
          }
        } catch (err: any) {
          results.push({
            prospectId: pid,
            status: "failed",
            conversionReadinessScore,
            reasonCode: err?.name === "ClaimLostError" ? "claim_lost" : "conversion_failed",
          });
        }
      }

      // Aggregate override audit log
      if (hasOverride) {
        await storage.createAuditLog({
          action: "prospect_batch_override",
          entityType: "prospect",
          entityId: 0,
          details: {
            actor: (req.user as any)?.id,
            prospectIds: inputIds,
            prospectCount: inputIds.length,
            threshold,
            scores: overrideScores,
            reason: override!.reason,
            outcomes: results.map(r => ({ prospectId: r.prospectId, status: r.status })),
          },
        }).catch(err => console.error("[BatchConvert] Audit log error:", err));
      }

      const converted = results.filter(r => r.status === "converted").length;
      const skipped = results.filter(r => r.status === "already_converted" || r.status === "conversion_in_progress" || r.status === "readiness_below_threshold").length;
      const failed = results.filter(r => r.status === "failed" || r.status === "conflict_incompatible_identity" || r.status === "not_found").length;

      res.json({
        results,
        summary: {
          requested: inputIds.length,
          converted,
          skipped,
          failed,
        },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // CSV Upload endpoint — idempotent via file-hash replay protection
  app.post("/api/prospects/import", isDashboardUser, requireRole("admin", "manager"), upload.single("file"), async (req, res) => {
    let list: Awaited<ReturnType<typeof storage.createProspectList>> | null = null;
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const fileBuffer = req.file.buffer;
      const fileHash = computeFileHash(fileBuffer);

      // Replay check: same bytes already imported → return existing result
      const existing = await storage.getProspectListByHash("prospect_csv", fileHash);
      if (existing) {
        return res.status(200).json({
          list: existing,
          imported: existing.insertedRows,
          skippedWithinFile: existing.skippedWithinFile,
          skippedExisting: existing.skippedExisting,
          possibleMatchReview: existing.conflictRows,
          invalid: (existing.totalRecords ?? 0) - (existing.insertedRows ?? 0) - (existing.skippedWithinFile ?? 0) - (existing.skippedExisting ?? 0) - (existing.conflictRows ?? 0),
          replay: true,
        });
      }

      const csvContent = fileBuffer.toString("utf-8");
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      }) as Record<string, string>[];

      const listName = (req.body.listName as string) || `Import ${new Date().toLocaleDateString()}`;
      try {
        list = await storage.createProspectList({
          name: listName,
          fileName: req.file.originalname || "upload.csv",
          fileHash,
          importType: "prospect_csv",
          totalRecords: records.length,
          status: "running",
          actor: (req as any).user?.email ?? null,
        });
      } catch (createErr: any) {
        // Race: another concurrent request for the same file committed first.
        // pg unique_violation = error code 23505
        if (isProspectListReplayConflict(createErr)) {
          const raceExisting = await storage.getProspectListByHash("prospect_csv", fileHash);
          if (raceExisting) {
            return res.status(200).json({
              list: raceExisting,
              imported: raceExisting.insertedRows,
              skippedWithinFile: raceExisting.skippedWithinFile,
              skippedExisting: raceExisting.skippedExisting,
              possibleMatchReview: raceExisting.conflictRows,
              invalid: (raceExisting.totalRecords ?? 0) - (raceExisting.insertedRows ?? 0) - (raceExisting.skippedWithinFile ?? 0) - (raceExisting.skippedExisting ?? 0) - (raceExisting.conflictRows ?? 0),
              replay: true,
            });
          }
        }
        throw createErr;
      }

      const columnMap: Record<string, string> = {
        "company": "companyName", "company_name": "companyName", "business": "companyName", "business_name": "companyName", "name": "companyName",
        "dba": "dba", "doing_business_as": "dba",
        "email": "email", "email_address": "email", "contact_email": "email",
        "phone": "phone", "phone_number": "phone", "telephone": "phone", "contact_phone": "phone",
        "website": "website", "url": "website", "web": "website",
        "owner_first_name": "ownerFirstName", "first_name": "ownerFirstName", "firstname": "ownerFirstName", "owner_first": "ownerFirstName", "contact_first_name": "ownerFirstName",
        "owner_last_name": "ownerLastName", "last_name": "ownerLastName", "lastname": "ownerLastName", "owner_last": "ownerLastName", "contact_last_name": "ownerLastName",
        "owner_email": "ownerEmail",
        "owner_phone": "ownerPhone",
        "address": "address", "street": "address", "street_address": "address",
        "city": "city",
        "state": "state", "st": "state",
        "zip": "zip", "zipcode": "zip", "zip_code": "zip", "postal": "zip", "postal_code": "zip",
        "vertical": "vertical", "industry": "vertical", "category": "vertical", "type": "vertical",
        "volume": "estimatedVolume", "estimated_volume": "estimatedVolume", "monthly_volume": "estimatedVolume",
        "processor": "estimatedProcessor", "current_processor": "estimatedProcessor",
        "employees": "employeeCount", "employee_count": "employeeCount",
        "year_established": "yearEstablished", "established": "yearEstablished", "year": "yearEstablished",
        "google_rating": "googleRating", "rating": "googleRating",
        "google_reviews": "googleReviews", "reviews": "googleReviews",
      };

      // --- Parse and normalize all rows, assign sourceRowIndex ---
      interface NormalizedRow {
        sourceRowIndex: number;
        raw: Record<string, any>;
        normalizedEmail: string | null;
        normalizedPhone: string | null;
        fingerprint: string;
        rowType: "email_candidate" | "phone_only" | "invalid";
      }

      const allRows: NormalizedRow[] = records.map((row, idx) => {
        const mapped: Record<string, any> = {};
        for (const [csvCol, value] of Object.entries(row)) {
          const normalizedCol = csvCol.toLowerCase().trim().replace(/\s+/g, "_");
          const schemaField = columnMap[normalizedCol];
          if (schemaField && value) {
            mapped[schemaField] = value;
          }
        }
        const normalizedEmail = normalizeProspectEmail(mapped.email ?? "");
        const normalizedPhone = normalizeProspectPhone(mapped.phone ?? "");
        const fingerprint = computeRowFingerprint({
          email: normalizedEmail,
          phone: normalizedPhone,
          companyName: mapped.companyName ?? null,
        });

        // Classification: normalization is canonical (trim+lower+blank→null).
        // Format validation (@ check) is a separate concern applied only here.
        let rowType: NormalizedRow["rowType"] = "invalid";
        if (normalizedEmail && isValidEmailFormat(normalizedEmail)) {
          rowType = "email_candidate";
        } else if (normalizedPhone) {
          rowType = "phone_only";
        }
        // rows with no valid email and no phone → invalid (company-only included)

        return {
          sourceRowIndex: idx,
          raw: mapped,
          normalizedEmail,
          normalizedPhone,
          fingerprint,
          rowType,
        };
      });

      // --- Dedup within file: group by normalizedEmail (if present) or fingerprint ---
      const seenDedupeKeys = new Set<string>();
      let skippedWithinFile = 0;
      const dedupedRows = allRows.filter(r => {
        if (r.rowType === "invalid") return true; // count as invalid, not dedup
        const dedupeKey = r.normalizedEmail ?? r.fingerprint;
        if (seenDedupeKeys.has(dedupeKey)) {
          skippedWithinFile++;
          return false;
        }
        seenDedupeKeys.add(dedupeKey);
        return true;
      });

      // --- Classify rows ---
      const emailCandidates = dedupedRows.filter(r => r.rowType === "email_candidate");
      const phoneOnlyRows = dedupedRows.filter(r => r.rowType === "phone_only");
      const invalidRows = dedupedRows.filter(r => r.rowType === "invalid");

      // --- Batch-check existing prospects by email ---
      const candidateEmails = emailCandidates
        .map(r => r.normalizedEmail)
        .filter((e): e is string => !!e);
      const existingEmails = await storage.getExistingProspectEmailsChunked(candidateEmails);
      let skippedExisting = 0;
      const toInsert = emailCandidates.filter(r => {
        if (r.normalizedEmail && existingEmails.has(r.normalizedEmail)) {
          skippedExisting++;
          return false;
        }
        return true;
      });

      // --- Build insert payloads ---
      const prospectInserts = toInsert.map(r => ({
        listId: list!.id,
        importExecutionId: list!.id,
        sourceRowIndex: r.sourceRowIndex,
        companyName: r.raw.companyName ?? null,
        dba: r.raw.dba ?? null,
        website: r.raw.website ?? null,
        phone: r.normalizedPhone ?? null,
        email: r.normalizedEmail ?? null,
        ownerFirstName: r.raw.ownerFirstName ?? null,
        ownerLastName: r.raw.ownerLastName ?? null,
        ownerEmail: r.raw.ownerEmail ?? null,
        ownerPhone: r.raw.ownerPhone ?? null,
        address: r.raw.address ?? null,
        city: r.raw.city ?? null,
        state: r.raw.state ?? null,
        zip: r.raw.zip ?? null,
        vertical: r.raw.vertical ?? null,
        estimatedVolume: r.raw.estimatedVolume ?? null,
        estimatedProcessor: r.raw.estimatedProcessor ?? null,
        employeeCount: r.raw.employeeCount ?? null,
        yearEstablished: r.raw.yearEstablished ?? null,
        googleRating: r.raw.googleRating ?? null,
        googleReviews: r.raw.googleReviews ?? null,
        status: "raw" as const,
        score: "cold" as const,
        qualificationScore: "C" as const,
        doNotContact: false,
      }));

      // --- phone-only rows: write as possible_match_review ---
      const phoneOnlyInserts = phoneOnlyRows.map(r => ({
        listId: list!.id,
        importExecutionId: list!.id,
        sourceRowIndex: r.sourceRowIndex,
        companyName: r.raw.companyName ?? null,
        phone: r.normalizedPhone ?? null,
        email: null,
        status: "possible_match_review" as const,
        score: "cold" as const,
        qualificationScore: "C" as const,
        doNotContact: false,
      }));

      // Insert email candidates and phone-only rows separately so counts are independent.
      const { inserted: emailInserted } = await storage.createProspectsBulkIdempotent(prospectInserts as any[]);
      // Any toInsert rows the DB skipped (concurrent same-email from another import)
      // are treated as skippedExisting to keep total accounting correct.
      const emailSkippedByDB = prospectInserts.length - emailInserted;
      const totalSkippedExisting = skippedExisting + emailSkippedByDB;

      const { inserted: phoneInserted } = await storage.createProspectsBulkIdempotent(phoneOnlyInserts as any[]);

      const finalCounts = {
        insertedRows: emailInserted,
        skippedWithinFile,
        skippedExisting: totalSkippedExisting,
        conflictRows: phoneInserted,
        totalRecords: records.length,
        status: "complete" as const,
      };

      const updatedList = await storage.updateProspectList(list.id, finalCounts);

      res.status(201).json({
        list: updatedList,
        imported: finalCounts.insertedRows,
        skippedWithinFile: finalCounts.skippedWithinFile,
        skippedExisting: finalCounts.skippedExisting,
        possibleMatchReview: finalCounts.conflictRows,
        invalid: invalidRows.length,
      });
    } catch (err: any) {
      console.error("CSV import error:", err);
      if (list) {
        await storage.updateProspectList(list.id, { status: "failed" }).catch(() => {});
      }
      serverError(res, err);
    }
  });


  // === ENRICHMENT ===
  app.get("/api/enrichment-jobs", requireRole("admin", "manager"), async (req, res) => {
    try {
      const listId = req.query.listId ? Number(req.query.listId) : undefined;
      const jobs = await storage.getEnrichmentJobs(listId);
      res.json(jobs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/enrichment-jobs", requireRole("admin", "manager"), async (req, res) => {
    const parsed = z.object({
      prospectId: z.number().int().positive().optional(),
      listId: z.number().int().positive().optional(),
      idempotencyKey: z.string().trim().min(8).max(200).optional(),
    }).strict().safeParse(req.body);
    if (!parsed.success || (!parsed.data.prospectId && !parsed.data.listId)) {
      return res.status(400).json({ code: "CRO03_INVALID_REQUEST", message: "Provide a prospectId or listId." });
    }
    try {
      const listProspects = parsed.data.listId ? await storage.getProspects(parsed.data.listId) : null;
      const prospectIds = parsed.data.prospectId
        ? [parsed.data.prospectId]
        : ((listProspects as any)?.data ?? listProspects ?? []).map((p: any) => p.id);
      const key = parsed.data.idempotencyKey ?? req.header("idempotency-key");
      if (!key) return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required." });
      const result = await createCro03BatchForProspects({
        prospectIds, idempotencyKey: key, actorId: String((req.user as any)?.id ?? ""),
      });
      if (!result.batch) {
        return res.status(409).json({ code: "CRO03_CANONICAL_INTAKE_BLOCKED", message: "No selected prospect could be admitted to canonical intake.", blocked: result.blocked });
      }
      return res.status(result.batch.replayed ? 200 : 202).json({
        batchId: result.batch.id, statusUrl: `/api/cro03/batches/${result.batch.id}`,
        total: result.batch.totalCount, blocked: result.blocked,
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  // PATCH /api/enrichment-jobs/:id — TASK-1830: governed state machine required (Gen-1 gate).
  // Returns 503 until CAS + audit + worker-ownership + transition-matrix is implemented.
  // TODO TASK-1830-PHASE2: replace this 503 with a governed state machine:
  //   - CAS check: verify current status matches expected before transition
  //   - Audit log: write enrichment_job_status_changed to audit_logs
  //   - Worker ownership: only the owning worker (or admin override) may cancel processing jobs
  //   - Transition matrix: pending→cancelled, failed→pending, cancelled→pending only
  //     (no completed→pending, no processing→cancelled without owner override)
  app.patch("/api/enrichment-jobs/:id", requireRole("admin", "manager"), async (_req, res) => {
    res.status(503).json({
      code: "ENRICHMENT_JOB_CONTROL_GOVERNED",
      message: "Enrichment job controls require activation authorization. The governed state machine will be available in a future release.",
    });
  });

  app.post("/api/enrichment/process-queue", requireRole("admin", "manager"), async (_req, res) => {
    res.status(503).json({
      code: "CRO03_LEGACY_QUEUE_RETIRED",
      message: "The process-local enrichment queue has been retired.",
    });
  });

  // === SUNBIZ LEAD GEN CLEANER ===
  app.get("/api/sunbiz/entities", isAuthenticated, async (req, res) => {
    try {
      const listId = req.query.listId ? Number(req.query.listId) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const offset = req.query.offset ? Number(req.query.offset) : undefined;
      const result = await storage.getSunbizEntities(listId, { limit, offset });
      res.json(result);
    } catch (err: any) {
      console.error("Get sunbiz entities error:", err.message);
      serverError(res, err);
    }
  });

  app.get("/api/sunbiz/entities/:id", isAuthenticated, async (req, res) => {
    try {
      const entity = await storage.getSunbizEntity(Number(req.params.id));
      if (!entity) return res.status(404).json({ message: "Entity not found" });
      res.json(entity);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sunbiz/stats", isAuthenticated, async (req, res) => {
    try {
      const listId = req.query.listId ? Number(req.query.listId) : undefined;
      const stats = await storage.getSunbizStats(listId);
      res.json(stats);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/search", isAuthenticated, async (req, res) => {
    try {
      const { query, entityType } = req.body;
      if (!query) return res.status(400).json({ message: "Search query required" });
      const results = await searchSunbiz(query, entityType);
      res.json(results);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/import-detail", isAuthenticated, async (req, res) => {
    try {
      const { detailUrl, listId } = req.body;
      if (!detailUrl) return res.status(400).json({ message: "Detail URL required" });
      const detail = await getEntityDetail(detailUrl);
      if (!detail) return res.status(404).json({ message: "Could not fetch entity detail" });

      const existing = detail.filingNumber ? await storage.getSunbizEntityByFiling(detail.filingNumber) : null;
      if (existing) return res.json(existing);

      const entity = await storage.createSunbizEntity({
        entityName: detail.entityName,
        filingNumber: detail.filingNumber || undefined,
        feiEinNumber: detail.feiEinNumber || undefined,
        entityType: detail.entityType || undefined,
        entityStatus: detail.entityStatus || undefined,
        filingDate: detail.filingDate || undefined,
        lastEvent: detail.lastEvent || undefined,
        lastEventDate: detail.lastEventDate || undefined,
        principalAddress: detail.principalAddress || undefined,
        principalCity: detail.principalCity || undefined,
        principalState: detail.principalState || "FL",
        principalZip: detail.principalZip || undefined,
        mailingAddress: detail.mailingAddress || undefined,
        registeredAgentName: detail.registeredAgentName || undefined,
        registeredAgentAddress: detail.registeredAgentAddress || undefined,
        officers: detail.officers.length > 0 ? detail.officers : undefined,
        detailUrl: detail.detailUrl || undefined,
        listId: listId || undefined,
        source: "sunbiz",
        enrichmentStatus: "pending",
      });

      res.json(entity);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/upload", isAuthenticated, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const content = req.file.buffer.toString("utf-8");
      const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        bom: true,
      });

      const listName = req.body.listName || `Sunbiz Import ${new Date().toLocaleDateString()}`;
      const list = await storage.createProspectList({
        name: listName,
        description: `Sunbiz directory upload: ${req.file.originalname}`,
        fileName: req.file.originalname,
        totalRecords: records.length,
        status: "processing",
      });

      // Create import_executions row to anchor provenance for this Sunbiz upload batch
      const [sunbizImportExec] = await db.insert(importExecutions).values({
        importType: "sunbiz_csv",
        status: "running",
        totalRows: records.length,
        actorType: "user",
        actorId: String((req as any).user?.id ?? ""),
        metadata: { listId: list.id, fileName: req.file!.originalname },
      }).returning();

      const parsed = parseSunbizCsv(records as Record<string, string>[]);
      const entities = parsed.map(p => ({
        entityName: p.entityName || "",
        filingNumber: p.filingNumber || undefined,
        feiEinNumber: p.feiEinNumber || undefined,
        entityType: p.entityType || undefined,
        entityStatus: p.entityStatus || "Active",
        filingDate: p.filingDate || undefined,
        principalAddress: p.principalAddress || undefined,
        principalCity: p.principalCity || undefined,
        principalState: p.principalState || "FL",
        principalZip: p.principalZip || undefined,
        mailingAddress: p.mailingAddress || undefined,
        registeredAgentName: p.registeredAgentName || undefined,
        registeredAgentAddress: p.registeredAgentAddress || undefined,
        officers: p.officers || undefined,
        dba: p.dba || undefined,
        website: p.website || undefined,
        email: p.email || undefined,
        phone: p.phone || undefined,
        detailUrl: p.detailUrl || undefined,
        listId: list.id,
        source: "sunbiz",
        enrichmentStatus: "pending" as const,
        searchQuery: listName,
        importExecutionId: sunbizImportExec?.id ?? undefined,
      }));

      const created = await storage.createSunbizEntitiesBulk(entities);

      // Mark import_executions completed
      if (sunbizImportExec) {
        db.update(importExecutions)
          .set({ status: "completed", insertedRows: created.length, completedAt: new Date() })
          .where(eq(importExecutions.id, sunbizImportExec.id))
          .execute()
          .catch((e: any) => console.warn("[Sunbiz Upload] import_executions update failed:", e?.message || e));
      }

      await storage.updateProspectList(list.id, {
        totalRecords: created.length,
        status: "ready",
      });

      res.json({ list, imported: created.length });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/upload-corevt", isAuthenticated, uploadLarge.single("file"), async (req, res) => {
    let list: Awaited<ReturnType<typeof storage.createProspectList>> | null = null;
    let filePath: string | null = null;
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      filePath = req.file.path;
      const listName = req.body.listName || `Sunbiz Corevt Import ${new Date().toLocaleDateString()}`;
      const maxRecords = parseInt(req.body.maxRecords) || 10000;
      const onlyWithAddress = req.body.onlyWithAddress === "true";

      // Compute file hash for replay detection
      const fileBuffer = fs.readFileSync(filePath);
      const fileHash = computeFileHash(fileBuffer);

      // Replay check: same zip bytes already imported → return existing result
      const existing = await storage.getProspectListByHash("sunbiz_corevt", fileHash);
      if (existing) {
        try { fs.unlinkSync(filePath); } catch {}
        return res.status(200).json({
          list: existing,
          imported: existing.insertedRows,
          replay: true,
        });
      }

      try {
        list = await storage.createProspectList({
          name: listName,
          description: `Sunbiz corevt fixed-width upload: ${req.file.originalname}`,
          fileName: req.file.originalname || "corevt.zip",
          fileHash,
          importType: "sunbiz_corevt",
          totalRecords: 0,
          insertedRows: 0,
          status: "running",
          actor: (req as any).user?.email ?? null,
        });
      } catch (createErr: any) {
        if (isProspectListReplayConflict(createErr)) {
          const raceExisting = await storage.getProspectListByHash("sunbiz_corevt", fileHash);
          if (raceExisting) {
            try { if (filePath) fs.unlinkSync(filePath); } catch {}
            filePath = null;
            return res.status(200).json({
              list: raceExisting,
              imported: raceExisting.insertedRows,
              replay: true,
            });
          }
        }
        throw createErr;
      }

      // Create import_executions row to anchor provenance for this Corevt upload batch
      let corevtImportExec: { id: string } | null = null;
      try {
        const [execRow] = await db.insert(importExecutions).values({
          importType: "sunbiz_corevt",
          status: "running",
          totalRows: 0,
          actorType: "user",
          actorId: String((req as any).user?.id ?? ""),
          metadata: { listId: list!.id, fileName: req.file!.originalname, fileHash },
        }).returning();
        corevtImportExec = execRow ?? null;
      } catch (execErr: any) {
        console.warn("[Corevt Upload] import_executions create failed:", execErr?.message || execErr);
      }

      let totalInserted = 0;
      let totalUpserted = 0;

      try {
        for await (const batch of streamCorevtFromZip(filePath, { maxRecords })) {
          const filtered = onlyWithAddress
            ? batch.filter(e => e.principalAddress || e.principalCity)
            : batch;

          if (filtered.length === 0) continue;

          const entities = filtered.map(p => ({
            entityName: p.entityName || "",
            filingNumber: p.filingNumber || undefined,
            feiEinNumber: p.feiEinNumber || undefined,
            entityType: p.entityType || undefined,
            entityStatus: p.entityStatus || "Active",
            filingDate: p.filingDate || undefined,
            principalAddress: p.principalAddress || undefined,
            principalCity: p.principalCity || undefined,
            principalState: p.principalState || "FL",
            principalZip: p.principalZip || undefined,
            mailingAddress: p.mailingAddress || undefined,
            registeredAgentName: p.registeredAgentName || undefined,
            registeredAgentAddress: p.registeredAgentAddress || undefined,
            officers: p.officers && p.officers.length > 0 ? p.officers : undefined,
            dba: p.dba || undefined,
            website: p.website || undefined,
            email: p.email || undefined,
            phone: p.phone || undefined,
            detailUrl: p.detailUrl || undefined,
            listId: list!.id,
            source: "corevt",
            enrichmentStatus: "pending" as const,
            searchQuery: listName,
            importExecutionId: corevtImportExec?.id ?? undefined,
          }));

          const result = await storage.upsertSunbizEntitiesBulk(entities);
          totalInserted += result.inserted;
          totalUpserted += result.updated;

          // Persist incremental progress so partial failures are recoverable
          await storage.updateProspectList(list!.id, {
            insertedRows: totalInserted,
            totalRecords: totalInserted + totalUpserted,
          });
        }
      } finally {
        try { fs.unlinkSync(filePath); } catch {}
        filePath = null;
      }

      const updatedList = await storage.updateProspectList(list.id, {
        insertedRows: totalInserted,
        totalRecords: totalInserted + totalUpserted,
        status: "complete",
      });

      // Mark import_executions completed for corevt batch
      if (corevtImportExec) {
        db.update(importExecutions)
          .set({ status: "completed", insertedRows: totalInserted, completedAt: new Date() })
          .where(eq(importExecutions.id, corevtImportExec.id))
          .execute()
          .catch((e: any) => console.warn("[Corevt Upload] import_executions update failed:", e?.message || e));
      }

      res.json({ list: updatedList, imported: totalInserted, updated: totalUpserted });
    } catch (err: any) {
      if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
      if (list) {
        await storage.updateProspectList(list.id, { status: "failed" }).catch(() => {});
      }
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/entities/:id/enrich", requireRole("admin", "manager"), async (req, res) => {
    const entityId = Number(req.params.id);
    const entity = await storage.getSunbizEntity(entityId);
    if (!entity) return res.status(404).json({ code: "not_found", message: "Entity not found" });
    const idempotencyKey = req.body?.idempotencyKey ?? req.header("idempotency-key");
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
      return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required." });
    }
    try {
      const batch = await createCro03SourceBatch({
        idempotencyKey, actorType: "user", actorId: String((req.user as any)?.id ?? ""),
        subjects: [sunbizSourceSubject(entityId, entity)],
      });
      return res.status(batch.replayed ? 200 : 202).json({
        batchId: batch.id, statusUrl: `/api/cro03/batches/${batch.id}`,
        blocked: [{ entityId, code: "STAGING_RECIPE_DISABLED" }],
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/enrich-batch", requireRole("admin", "manager"), async (req, res) => {
    const entityIds = z.array(z.number().int().positive()).max(1000).optional().safeParse(req.body?.entityIds);
    const idempotencyKey = req.body?.idempotencyKey ?? req.header("idempotency-key");
    if (!entityIds.success || !entityIds.data?.length || typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
      return res.status(400).json({ code: "CRO03_INVALID_REQUEST", message: "entityIds and Idempotency-Key are required." });
    }
    try {
      const subjects: Parameters<typeof createCro03SourceBatch>[0]["subjects"] = [];
      for (const entityId of entityIds.data) {
        const entity = await storage.getSunbizEntity(entityId);
        if (entity) subjects.push(sunbizSourceSubject(entityId, entity));
      }
      if (!subjects.length) return res.status(404).json({ code: "not_found", message: "No entities found" });
      const batch = await createCro03SourceBatch({
        idempotencyKey, actorType: "user", actorId: String((req.user as any)?.id ?? ""), subjects,
      });
      return res.status(batch.replayed ? 200 : 202).json({
        batchId: batch.id, statusUrl: `/api/cro03/batches/${batch.id}`, total: batch.totalCount,
        blocked: subjects.map((subject) => ({ entityId: Number(subject.subjectKey), code: "STAGING_RECIPE_DISABLED" })),
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/entities/:id/convert", isAuthenticated, async (req, res) => {
    try {
      const prospectId = await convertToProspect(Number(req.params.id), req.body.listId);
      if (!prospectId) return res.status(404).json({ message: "Entity not found" });
      res.json({ prospectId });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/convert-batch", isAuthenticated, async (req, res) => {
    try {
      const { entityIds, listId } = req.body;
      if (!entityIds || !Array.isArray(entityIds)) return res.status(400).json({ message: "entityIds array required" });
      const results: number[] = [];
      for (const id of entityIds) {
        const prospectId = await convertToProspect(id, listId);
        if (prospectId) results.push(prospectId);
      }
      res.json({ converted: results.length, prospectIds: results });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/sunbiz/entities/:id", isAuthenticated, async (req, res) => {
    try {
      const updated = await storage.updateSunbizEntity(Number(req.params.id), req.body);
      if (!updated) return res.status(404).json({ message: "Entity not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sunbiz/export", isAuthenticated, async (req, res) => {
    try {
      const listId = req.query.listId ? Number(req.query.listId) : undefined;
      const entities = await storage.getSunbizEntities(listId);
      const enrichedOnly = req.query.enrichedOnly === "true";
      const entitiesArr = (entities as any).data ?? entities;
      const filtered = enrichedOnly ? entitiesArr.filter((e: any) => e.enrichmentStatus === "enriched") : entitiesArr;

      const headers = ["Entity Name", "DBA", "Filing Number", "Entity Type", "Status", "Filing Date", "Principal Address", "City", "State", "Zip", "Owner Name", "Owner Email", "Owner Phone", "Website", "Email", "Phone", "Vertical", "Score", "AI Summary", "Officers"];
      const csvRows = [headers.join(",")];
      for (const e of filtered) {
        const officers = (e.officers as any[]) || [];
        const officerStr = officers.map((o: any) => `${o.title}: ${o.name}`).join("; ");
        csvRows.push([
          `"${(e.entityName || "").replace(/"/g, '""')}"`,
          `"${(e.dba || "").replace(/"/g, '""')}"`,
          e.filingNumber || "",
          e.entityType || "",
          e.entityStatus || "",
          e.filingDate || "",
          `"${(e.principalAddress || "").replace(/"/g, '""')}"`,
          e.principalCity || "",
          e.principalState || "",
          e.principalZip || "",
          `"${(e.ownerName || "").replace(/"/g, '""')}"`,
          e.ownerEmail || "",
          e.ownerPhone || "",
          e.website || "",
          e.email || "",
          e.phone || "",
          e.vertical || "",
          e.score || "",
          `"${(e.aiSummary || "").replace(/"/g, '""')}"`,
          `"${officerStr.replace(/"/g, '""')}"`,
        ].join(","));
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="sunbiz-leads-${Date.now()}.csv"`);
      res.send(csvRows.join("\n"));
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === LEAD INTELLIGENCE ENGINE ===
  app.post("/api/lead-intelligence/score/:contactId", isAuthenticated, async (req, res) => {
    try {
      const contactId = Number(req.params.contactId);
      const breakdown = await scoreContact(contactId);
      if (!breakdown) return res.status(404).json({ message: "Contact not found" });
      res.json(breakdown);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/lead-intelligence/score/:contactId", isAuthenticated, async (req, res) => {
    try {
      const contact = await storage.getContact(Number(req.params.contactId));
      if (!contact) return res.status(404).json({ message: "Contact not found" });
      res.json({
        leadScore: contact.leadScore || 0,
        revPotentialScore: contact.revPotentialScore || 0,
        switchabilityScore: contact.switchabilityScore || 0,
        uwConfidenceScore: contact.uwConfidenceScore || 0,
        engagementScore: contact.engagementScore || 0,
        scoreBreakdown: contact.scoreBreakdown || null,
        lastScoredAt: contact.lastScoredAt,
        tier: (contact.leadScore || 0) >= 70 ? "hot" : (contact.leadScore || 0) >= 45 ? "warm" : (contact.leadScore || 0) >= 20 ? "cold" : "unqualified",
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/lead-intelligence/blueprint/:dealId", isAuthenticated, async (req, res) => {
    try {
      const dealId = Number(req.params.dealId);
      const blueprint = await generateDealBlueprint(dealId);
      if (!blueprint) return res.status(404).json({ message: "Deal not found or blueprint generation failed" });
      res.json(blueprint);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/lead-intelligence/blueprint/:dealId", isAuthenticated, async (req, res) => {
    try {
      const deal = await storage.getDeal(Number(req.params.dealId));
      if (!deal) return res.status(404).json({ message: "Deal not found" });
      res.json({
        dealBlueprint: deal.dealBlueprint,
        recommendedProgram: deal.recommendedProgram,
        hardwarePackage: deal.hardwarePackage,
        estMonthlyRevenue: deal.estMonthlyRevenue,
        underwritingPath: deal.underwritingPath,
        competitivePositioning: deal.competitivePositioning,
        repBriefing: deal.repBriefing,
        repOpener: deal.repOpener,
        likelyObjections: deal.likelyObjections,
        blueprintGeneratedAt: deal.blueprintGeneratedAt,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/lead-intelligence/route/:contactId", isAuthenticated, async (req, res) => {
    try {
      const contactId = Number(req.params.contactId);
      const result = await routeContact(contactId);
      res.json(result);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/lead-intelligence/routing/:contactId", isAuthenticated, async (req, res) => {
    try {
      const contactId = Number(req.params.contactId);
      const recommendation = await getRoutingRecommendation(contactId);
      res.json(recommendation);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/lead-intelligence/doc-readiness/:dealId", isAuthenticated, async (req, res) => {
    try {
      const deal = await storage.getDeal(Number(req.params.dealId));
      if (!deal) return res.status(404).json({ message: "Deal not found" });

      const docs = {
        statementReceived: deal.statementReceived || false,
        voidedCheckReceived: deal.voidedCheckReceived || false,
        idReceived: deal.idReceived || false,
        appCompleted: deal.appCompleted || false,
      };
      const completed = Object.values(docs).filter(Boolean).length;
      const total = 4;

      let stage = "Lead";
      if (completed >= 4) stage = "Submit to Processor";
      else if (completed >= 3) stage = "Underwriting Ready";
      else if (completed >= 2) stage = "Proposal Stage";
      else if (completed >= 1) stage = "Qualified";

      const missing: string[] = [];
      if (!docs.statementReceived) missing.push("Processing Statement");
      if (!docs.appCompleted) missing.push("Merchant Application");
      if (!docs.voidedCheckReceived) missing.push("Voided Check");
      if (!docs.idReceived) missing.push("Owner ID");

      res.json({
        ...docs,
        docReadinessScore: completed,
        docReadinessMax: total,
        docReadinessPercent: Math.round((completed / total) * 100),
        readinessStage: stage,
        missing,
        lastNudgeAt: deal.lastNudgeAt,
        nextNudgeAt: deal.nextNudgeAt,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/lead-intelligence/full/:contactId", isAuthenticated, async (req, res) => {
    try {
      const contactId = Number(req.params.contactId);
      const contact = await storage.getContact(contactId);
      if (!contact) return res.status(404).json({ message: "Contact not found" });

      const contactDeals = await storage.getDealsByContact(contactId);
      const primaryDeal = contactDeals[0] || null;

      const scoring = {
        leadScore: contact.leadScore || 0,
        revPotentialScore: contact.revPotentialScore || 0,
        switchabilityScore: contact.switchabilityScore || 0,
        uwConfidenceScore: contact.uwConfidenceScore || 0,
        engagementScore: contact.engagementScore || 0,
        scoreBreakdown: typeof contact.scoreBreakdown === 'object' && contact.scoreBreakdown
          ? (contact.scoreBreakdown as any).summary || JSON.stringify(contact.scoreBreakdown)
          : contact.scoreBreakdown || "",
        lastScoredAt: contact.lastScoredAt,
        tier: (contact.leadScore || 0) >= 70 ? "hot" : (contact.leadScore || 0) >= 45 ? "warm" : (contact.leadScore || 0) >= 20 ? "cold" : "unqualified",
      };

      let blueprint = null;
      let docReadiness = null;

      if (primaryDeal) {
        blueprint = {
          dealId: primaryDeal.id,
          recommendedProgram: primaryDeal.recommendedProgram,
          hardwarePackage: primaryDeal.hardwarePackage,
          estMonthlyRevenue: primaryDeal.estMonthlyRevenue,
          underwritingPath: primaryDeal.underwritingPath,
          competitivePositioning: primaryDeal.competitivePositioning,
          repBriefing: primaryDeal.repBriefing,
          repOpener: primaryDeal.repOpener,
          likelyObjections: primaryDeal.likelyObjections,
          blueprintGeneratedAt: primaryDeal.blueprintGeneratedAt,
        };

        const docs = {
          statementReceived: primaryDeal.statementReceived || false,
          voidedCheckReceived: primaryDeal.voidedCheckReceived || false,
          idReceived: primaryDeal.idReceived || false,
          appCompleted: primaryDeal.appCompleted || false,
        };
        const completed = Object.values(docs).filter(Boolean).length;
        const missing: string[] = [];
        if (!docs.statementReceived) missing.push("Processing Statement");
        if (!docs.appCompleted) missing.push("Merchant Application");
        if (!docs.voidedCheckReceived) missing.push("Voided Check");
        if (!docs.idReceived) missing.push("Owner ID");

        docReadiness = {
          ...docs,
          score: completed,
          max: 4,
          percent: Math.round((completed / 4) * 100),
          missing,
        };
      }

      const routingRec = await getRoutingRecommendation(contactId);

      const complianceStatus = {
        doNotContact: contact.doNotContact || false,
        consentSms: contact.consentSms || false,
        consentEmail: contact.consentEmail || false,
        smsOptInAt: contact.smsOptInAt,
        coolingUntil: contact.coolingUntil,
        contactAttempts: contact.contactAttempts || 0,
        dncReason: contact.dncReason,
      };

      res.json({
        contact: {
          id: contact.id,
          name: `${contact.firstName} ${contact.lastName}`,
          company: contact.companyName,
          vertical: contact.vertical,
          monthlyVolume: contact.monthlyVolume,
          currentProvider: contact.currentProvider,
          painPoints: contact.painPoints,
          contractStatus: contact.contractStatus,
          lookingReason: contact.lookingReason,
          referralSource: contact.referralSource,
        },
        scoring,
        blueprint,
        docReadiness,
        routing: routingRec,
        compliance: complianceStatus,
        deal: primaryDeal ? {
          id: primaryDeal.id,
          stage: primaryDeal.stage,
          pipeline: primaryDeal.pipeline,
        } : null,
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/lead-intelligence/score-batch", isAuthenticated, async (req, res) => {
    try {
      const { contactIds } = req.body;
      if (!Array.isArray(contactIds)) return res.status(400).json({ message: "contactIds array required" });
      let scored = 0;
      for (const id of contactIds.slice(0, 50)) {
        try {
          await scoreContact(id);
          scored++;
        } catch (e: any) {
          console.error(`[Prospects] scoreContact failed for id ${id}:`, e.message);
        }
      }
      res.json({ scored, total: contactIds.length });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === BATCH RE-ENRICHMENT & CLASSIFICATION ===
  // DEPRECATED: This route no longer triggers enrichment. The scheduled pipeline
  // (runEnrichmentTick → processSunbizEnrichmentQueue + runSunbizAutoConvert)
  // is the only active intake path. Hits are logged for observability.
  app.post("/api/sunbiz/re-enrich-all", requireRole("admin", "manager"), async (req, res) => {
    // Fire-and-forget audit log — failure does not affect the 200 response.
    const { auditLogs: _auditLogs } = await import("@shared/schema");
    db.insert(_auditLogs).values({
      action: "legacy_enrich_all_attempted",
      entityType: "system",
      actorType: "user",
      actorId: (req as any).user?.id ? String((req as any).user.id) : undefined,
      details: { ip: req.ip, userAgent: req.headers["user-agent"] },
    }).catch((err: any) => console.error("[sunbiz] audit log insert failed:", err?.message));

    // Increment the in-process observability counter (read via /api/lead-ops/health).
    const { incrementLegacyEnrichAttemptCounter } = await import("./lead-ops");
    incrementLegacyEnrichAttemptCounter();

    // Report the actual active intake path(s) rather than hard-coding an assumption.
    const { featureFlags } = await import("../services/feature-flags");
    const sunbizOn = featureFlags.SUNBIZ_ENRICHMENT_ENABLED;
    const legacyOn  = featureFlags.LEGACY_OUTREACH_ENABLED;
    const activeIntakePath =
      sunbizOn && legacyOn ? "both"
      : sunbizOn ? "scheduled-sunbiz-pipeline"
      : legacyOn ? "legacy-outreach-cycle"
      : "none";

    res.status(200).json({
      deprecated: true,
      message: "This trigger is deprecated and has no effect. Check the Lead Ops health panel for the currently active intake path.",
      activeIntakePath,
    });
  });

  app.get("/api/sunbiz/enrichment-progress", isAuthenticated, async (req, res) => {
    try {
      const progress = await storage.getSystemSetting("enrichment_progress");
      res.json(progress || { status: "idle" });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/mass-enrich", requireRole("admin"), async (_req, res) => {
    res.status(503).json({ code: "CRO03_LEGACY_PATH_RETIRED", message: "Use a CRO-03 durable batch after canonical intake." });
  });

  app.get("/api/sunbiz/mass-enrich-progress", isAuthenticated, async (req, res) => {
    try {
      const progress = await storage.getSystemSetting("mass_enrichment_progress");
      res.json({ progress: progress || { status: "idle" }, running: isMassEnrichmentRunning() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/promote-qualified", isAuthenticated, async (req, res) => {
    if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
    return res.status(503).json({
      code: "CRO03A_GOVERNED_HANDOFF_REQUIRED",
      message: "Legacy Sunbiz bulk promotion is retired. Use the effect-denied CRO-03A handoff for CRO-03B.",
    });
  });

  app.post("/api/sunbiz/bulk-ai-classify", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    const limit = Number(req.body?.limit) || 5000;
    res.json({ message: `AI classification started for up to ${limit} entities.`, started: true });
    runBulkAIClassification(limit).catch(err => console.error("[AI Classify API] Error:", err));
  });

  app.get("/api/sunbiz/ai-classify-progress", isAuthenticated, async (req, res) => {
    try {
      const progress = await storage.getSystemSetting("ai_classify_progress");
      res.json({ progress: progress || { status: "idle" } });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/run-pipeline", requireRole("admin"), async (_req, res) => {
    res.status(503).json({ code: "CRO03_LEGACY_PATH_RETIRED", message: "The legacy enrichment pipeline has been retired." });
  });

  app.get("/api/sunbiz/pipeline-progress", isAuthenticated, async (req, res) => {
    try {
      const progress = await storage.getSystemSetting("daily_pipeline_progress");
      res.json({ progress: progress || { status: "idle" }, running: isPipelineRunning() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sunbiz/deep-enrich/:id", requireRole("admin", "manager"), async (_req, res) => {
    res.status(503).json({ code: "CRO03_LEGACY_PATH_RETIRED", message: "Use a CRO-03 durable batch after canonical intake." });
  });

  app.post("/api/sunbiz/deduplicate", isAuthenticated, async (req, res) => {
    if ((req.user as any)?.role !== 'admin') return res.status(403).json({ message: "Admin only" });
    try {
      const limit = Number(req.body?.limit) || 500;
      const result = await runAutoDeduplication(limit);
      res.json({ message: `Deduplication complete: checked ${result.checked} groups, merged ${result.merged} records.`, ...result });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sunbiz/enrichment-dashboard", isAuthenticated, async (req, res) => {
    try {
      const dashboard = await storage.getSunbizEnrichmentDashboard();
      const pipelineProgress = await storage.getSystemSetting("daily_pipeline_progress");
      res.json({
        ...dashboard,
        pipeline: { progress: pipelineProgress || { status: "idle" }, running: isPipelineRunning() },
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/sunbiz/verticals", isAuthenticated, async (req, res) => {
    try {
      const dashboard = await storage.getSunbizEnrichmentDashboard();
      const verticals = Object.entries(dashboard.verticals)
        .filter(([name]) => name !== "Unclassified" && name !== "Other")
        .map(([name, data]: [string, any]) => ({
          name,
          total: data.total,
          withContact: data.withContact,
          contactRate: data.total > 0 ? Math.round((data.withContact / data.total) * 100) : 0,
        }))
        .sort((a, b) => b.withContact - a.withContact);
      res.json({ verticals, totalClassified: dashboard.classified, readyForOutreach: dashboard.readyForOutreach });
    } catch (err: any) {
      serverError(res, err);
    }
  });

}
