import type { Express } from "express";
import { strictRecordId, workCommandEnvelope, workSelection } from "@shared/work-item-commands";
import { commandWorkItems, WorkCommandError, bindWorkActor } from "../services/work-item-command";
import {contactLifecycleFields,commandContactLifecycle} from "../services/contact-lifecycle-command";
import {readContactCompanies,linkCompany,unlinkCompany} from "../services/company-authority";
import { deleteTaskCommand, type NativeTaskDeleteTransport } from "../services/task-deletion-command";
import { registerWorkBulkRoutes } from "./work-bulk-commands";
import { isAuthenticated, isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { z } from "zod";
import { contacts, contactCompanies, insertContactCompanySchema } from "@shared/schema";
import { and } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import { isGhlConfigured, upsertGhlContact } from "../services/ghl";
import { syncContactToGhl, syncDealToGhl } from "../services/ghl-sync";
import { extractRelationshipsForContact } from "../services/relationship-extractor";
import { propagateDealDeleteToGhl, propagateTaskDeleteToGhl } from "../services/ghl-delete-sync";
import { serverError } from "../utils/server-error";
import { streamKeysetCsv } from "../services/bounded-csv-export";
import { contactReadPredicate, dealReadPredicate } from "../services/revenue-read-authority";
import { advanceDealStage, DealStageConflictError, DealStageIllegalTransitionError } from "../services/deal-stage-service";
import { GoLiveGateError } from "../services/go-live-gate";
import { authorizeContactAccess, canAccessOwner } from "../services/crm-object-access";
import { taskReadPredicate, taskStateSql } from "../services/task-read-authority";
import { contactSections } from "../../client/src/lib/crm-destination-state";
import {isSdrSourcedContact} from "../services/sales-prep";
import { db, pool } from "../db";
import { tickets, tasks } from "@shared/schema";
import { eq, getTableColumns } from "drizzle-orm";
import { onboardingPreparationFields } from "@shared/onboarding-preparation";
import { prepareOnboarding, readOnboardingPreparation } from "../services/onboarding-preparation-command";
import { isUuidV4 } from "../services/chargeback-submission-service";

export function registerCrmOperationsRoutes(app: Express, deps: { nativeTaskDeleteTransport?: NativeTaskDeleteTransport;
  relationshipExtractor?:(contactId:number)=>Promise<unknown>;
  onboardingPreparationAfterStep?:(step:string)=>Promise<void> } = {}) {
  const preparationError=(res:any,error:unknown)=>{
    if(error instanceof z.ZodError)return res.status(400).json({message:error.errors[0].message});
    if(error instanceof WorkCommandError)return res.status(error.status).json({message:error.message});
    // An accepted local intent can outlive this response. Do not report rollback.
    return res.status(503).json({message:"Preparation outcome unavailable. Read back the captured intent before retrying; no native effects were requested."});
  };
  app.get("/api/deals/:id/onboarding-preparation",isDashboardUser,async(req,res)=>{
    try{
      const id=strictRecordId.parse(req.params.id);
      const commandId=req.query.commandId;
      if(commandId!==undefined && (typeof commandId!=="string" || !isUuidV4(commandId)))
        return res.status(400).json({message:"Use a UUIDv4 preparation command ID"});
      res.json(await readOnboardingPreparation(bindWorkActor(req.user),id,(commandId as string|undefined)?.toLowerCase()));
    }catch(error){preparationError(res,error);}
  });
  app.post("/api/deals/:id/onboarding-preparation",isDashboardUser,async(req,res)=>{
    try{
      const id=strictRecordId.parse(req.params.id);
      const rawKey=req.get("Idempotency-Key");
      if(!isUuidV4(rawKey))return res.status(400).json({message:"UUIDv4 Idempotency-Key required"});
      const commandId=rawKey.toLowerCase();
      const fields=onboardingPreparationFields.parse(req.body);
      const result=await prepareOnboarding({selectedId:id,commandId,fields,
        actor:bindWorkActor(req.user,fields.expectedActorId,fields.expectedAccountVersion)},deps.onboardingPreparationAfterStep);
      res.status(202).json({accepted:true,...result});
    }catch(error){preparationError(res,error);}
  });
  app.post("/api/deals/:id/onboarding-preparation/:commandId/resume",isDashboardUser,async(req,res)=>{
    try{
      const id=strictRecordId.parse(req.params.id),commandId=z.string().parse(req.params.commandId).toLowerCase();
      if(!isUuidV4(commandId) || req.get("Idempotency-Key")?.toLowerCase()!==commandId)
        return res.status(400).json({message:"Use the unchanged UUIDv4 accepted intent"});
      const fields=z.object({expectedActorId:z.string().min(1),expectedAccountVersion:z.number().int().nonnegative()}).strict().parse(req.body);
      const result=await prepareOnboarding({selectedId:id,commandId,
        actor:bindWorkActor(req.user,fields.expectedActorId,fields.expectedAccountVersion)},deps.onboardingPreparationAfterStep);
      res.status(202).json({accepted:true,...result});
    }catch(error){preparationError(res,error);}
  });
  app.post("/api/contacts/bulk-archive",requireRole("admin","manager"),async(req,res)=>{
    try {
      const fields=contactLifecycleFields.parse(req.body);
      res.json(await commandContactLifecycle(bindWorkActor(req.user,fields.expectedActorId,fields.expectedAccountVersion),"archive",fields));
    } catch(error) {
      if(error instanceof z.ZodError) return res.status(400).json({message:error.errors[0].message});
      if(error instanceof WorkCommandError) return res.status(error.status).json({message:error.message});
      serverError(res,error);
    }
  });
  registerWorkBulkRoutes(app);
  // === CONTACT DETAIL AGGREGATE ===
  app.get("/api/contacts/:id/detail", isDashboardUser, async (req, res) => {
    try {
      const section=req.query.section;
      if(section!==undefined && (typeof section!=="string" || !contactSections.includes(section as any) || section==="activity" || section==="history"))
        return res.status(400).json({code:"INVALID_CONTACT_SECTION",message:"A valid underlying contact section is required"});
      const contactId = Number(req.params.id);
      const contact = await authorizeContactAccess(req, res, contactId);
      if (!contact) return;

      // Default preserves the aggregate contract for older consumers. C2 asks
      // for only the mounted section; omitted arrays are explicitly unloaded,
      // never authoritative empty collections or zero counts.
      const full=section===undefined || section==="overview";
      const loadDeals=full || ["deals","onboarding-stages","documents"].includes(String(section));
      const loadTickets=full || section==="tickets";
      const loadTasks=full || section==="tasks";
      const loadNotes=full || section==="notes";
      const asOf=new Date();
      const [linkedDeals, contactTickets, contactTasks, contactNotes, sdrSourced] = await Promise.all([
        storage.getDealsByContact(contactId),
        loadTickets?db.select().from(tickets).where(eq(tickets.contactId, contactId)):Promise.resolve([]),
        loadTasks?db.select({...getTableColumns(tasks),effectiveState:taskStateSql}).from(tasks).where(and(eq(tasks.contactId,contactId),
          taskReadPredicate({actor:req.user as any,asOf,timezone:"UTC"}))):Promise.resolve([]),
        loadNotes?storage.getNotes("contact", contactId):Promise.resolve([]),
        isSdrSourcedContact(contactId),
      ]);
      const rawDeals=linkedDeals.filter(deal=>canAccessOwner(req.user as any,deal.owner,false));

      // REV-05A: mask raw MID from deal objects before returning to the client.
      // Full MIDs are available only via dedicated receipted endpoints.
      const { serializeDeal } = await import("../utils/mask-mid");
      const contactDeals = loadDeals?rawDeals.map((d: any) => serializeDeal(d)):[];
      const activeDeals=rawDeals.filter(deal=>!deal.archivedAt &&
        !["Closed Won","Closed Lost"].includes(deal.stage)).sort((a,b)=>
          new Date(b.updatedAt ?? b.createdAt ?? 0).getTime()-new Date(a.updatedAt ?? a.createdAt ?? 0).getTime() || b.id-a.id);
      const activeDeal=activeDeals[0];
      const nextFollowUp=activeDeals.find(deal=>deal.nextFollowUp)?.nextFollowUp;

      res.json({ contact, deals: contactDeals, tickets: contactTickets, tasks: contactTasks, notes: contactNotes,
        capabilities:{hasOnboarding:rawDeals.some(deal=>deal.pipeline==="onboarding" && !deal.archivedAt),
          sdrSourced},
        loaded:{deals:loadDeals,tickets:loadTickets,tasks:loadTasks,notes:loadNotes},
        headerDealFacts:{activeDeal:activeDeal?{id:activeDeal.id,stage:activeDeal.stage,pipeline:activeDeal.pipeline,
          nextFollowUp:activeDeal.nextFollowUp,archivedAt:activeDeal.archivedAt}:null,
          nextFollowUp:nextFollowUp?.toISOString()??null},
        projection:section??"legacy_full",asOf:asOf.toISOString() });
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === EXPORT CSV ===
  // === CSV EXPORTS ===
  // Complete (uncapped) exports, read in bounded keyset pages by ascending id and streamed; see bounded-csv-export.ts.
  // Contacts and deals use the same authorized read predicates as the People and Pipeline lists. Tickets use the same
  // population as the Today open-ticket count and the ticket list (all tickets; tickets carry no archive/class/owner scope).
  // A mid-stream failure destroys the connection rather than finishing a short file.
  const exportFailed = (label: string) => (error: unknown) => console.error(`[export/${label}] stream failed:`, (error as any)?.message ?? error);
  app.get("/api/export/contacts", requireRole("admin", "manager"), async (req, res) => {
    try {
      const text = (key: string) => typeof req.query[key] === "string" && (req.query[key] as string).trim() ? (req.query[key] as string).trim() : undefined;
      const filters = { limit: 0, offset: 0, search: text("search"), status: text("status"), assignedTo: text("assignedTo"), recordClass: text("recordClass") } as Parameters<typeof contactReadPredicate>[1];
      await streamKeysetCsv(res, {
        filename: "contacts.csv",
        headers: ["ID","First Name","Last Name","Email","Phone","Company","Status","Decision Maker","Email Status","Tags","Created"],
        headersExtra: { "X-Metric-Population": "people_matching_shared_filters" },
        onStreamFailure: exportFailed("contacts"),
        fetchPage: async (afterId, limit) => {
          const values: unknown[] = [];
          const where = contactReadPredicate(req.user as any, filters, values);
          values.push(afterId, limit);
          return (await pool.query(`SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.company_name, c.status, c.is_decision_maker, c.email_status, c.tags, c.created_at
            FROM contacts c WHERE ${where} AND c.id > $${values.length - 1} ORDER BY c.id ASC LIMIT $${values.length}`, values)).rows;
        },
        toRows: page => page.map((c: any) => [c.id, c.first_name, c.last_name, c.email, c.phone, c.company_name || "", c.status || "",
          c.is_decision_maker === true ? "true" : "false", c.email_status || "", (c.tags || []).join(";"),
          c.created_at ? new Date(c.created_at).toISOString() : ""]),
      });
    } catch (err: any) {
      if (!res.headersSent) serverError(res, err);
    }
  });

  app.get("/api/export/deals", requireRole("admin", "manager"), async (req, res) => {
    try {
      await streamKeysetCsv(res, {
        filename: "deals.csv",
        headers: ["ID","Contact","Company","Pipeline","Stage","Offer Path","Volume","Fees","Profit/mo","Created"],
        headersExtra: { "X-Metric-Population": "production_non_archived_deals" },
        onStreamFailure: exportFailed("deals"),
        fetchPage: async (afterId, limit) => {
          const values: unknown[] = [];
          const where = dealReadPredicate(req.user as any, { includeArchived: false }, values);
          values.push(afterId, limit);
          return (await pool.query(`SELECT d.id, d.contact_id, d.pipeline, d.stage, d.offer_path, d.total_volume, d.total_fees, d.estimated_net_profit_monthly, d.created_at
            FROM deals d WHERE ${where} AND d.id > $${values.length - 1} ORDER BY d.id ASC LIMIT $${values.length}`, values)).rows;
        },
        // Contacts are resolved by the page's linked ids, never by position in a separate first-page list.
        toRows: async (page: any[]) => {
          const ids = [...new Set(page.map(d => d.contact_id).filter((id): id is number => typeof id === "number"))];
          const linked = ids.length ? (await pool.query("SELECT id, first_name, last_name, company_name FROM contacts WHERE id = ANY($1::int[])", [ids])).rows : [];
          const byId = new Map<number, any>(linked.map((c: any) => [c.id, c]));
          return page.map(d => {
            const c = d.contact_id ? byId.get(d.contact_id) : null;
            return [d.id, c ? `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() : "", c?.company_name || "", d.pipeline, d.stage, d.offer_path || "",
              d.total_volume || "", d.total_fees || "", d.estimated_net_profit_monthly || "", d.created_at ? new Date(d.created_at).toISOString() : ""];
          });
        },
      });
    } catch (err: any) {
      if (!res.headersSent) serverError(res, err);
    }
  });

  app.get("/api/export/tickets", requireRole("admin", "manager"), async (req, res) => {
    try {
      await streamKeysetCsv(res, {
        filename: "tickets.csv",
        headers: ["ID","Subject","Category","Priority","Status","Assigned To","SLA Deadline","Created"],
        headersExtra: { "X-Metric-Population": "all_tickets_not_role_scoped" },
        onStreamFailure: exportFailed("tickets"),
        fetchPage: async (afterId, limit) =>
          (await pool.query(`SELECT id, subject, category, priority, status, assigned_to, sla_deadline, created_at FROM tickets WHERE id > $1 ORDER BY id ASC LIMIT $2`, [afterId, limit])).rows,
        toRows: page => page.map((t: any) => [t.id, t.subject, t.category || "", t.priority || "", t.status || "", t.assigned_to || "",
          t.sla_deadline ? new Date(t.sla_deadline).toISOString() : "", t.created_at ? new Date(t.created_at).toISOString() : ""]),
      });
    } catch (err: any) {
      if (!res.headersSent) serverError(res, err);
    }
  });


  // === CONTACT-COMPANY ASSOCIATIONS ===
  app.get("/api/contacts/:id/companies", isDashboardUser, async (req, res) => {
    try {
      const result = await readContactCompanies(bindWorkActor(req.user),strictRecordId.parse(req.params.id));
      res.json(result);
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:"Invalid contact ID"});
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      console.error("Get contact companies error:", err.message);
      serverError(res, err);
    }
  });

  app.post("/api/contacts/:id/companies", isDashboardUser, async (req, res) => {
    try {
      const input=z.object({companyId:z.number().int().positive().max(2147483647),
        role:z.string().trim().min(1).max(100).default("Owner"),isPrimary:z.boolean().default(false)}).strict().parse(req.body);
      const contactId=strictRecordId.parse(req.params.id);
      const result=await linkCompany(bindWorkActor(req.user),{...input,contactId});
      // Human membership is accepted locally. Heuristic reconciliation is a
      // separate outcome and never grants an agent access to foreign members.
      let extractionState="management_review_required";
      if(["admin","manager"].includes((req.user as any).role)) {
        try {await (deps.relationshipExtractor ?? extractRelationshipsForContact)(contactId);extractionState="completed";}
        catch {extractionState="failed";}
      }
      res.status(result.changed?201:200).json({...result.link,changed:result.changed,replayed:result.replayed,extractionState});
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      console.error("Add contact company error:", err.message);
      serverError(res, err);
    }
  });

  app.delete("/api/contact-companies/:id", isDashboardUser, async (req, res) => {
    try {
      res.json({success:true,...await unlinkCompany(bindWorkActor(req.user),strictRecordId.parse(req.params.id))});
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:"Invalid association ID"});
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      console.error("Remove contact company error:", err.message);
      serverError(res, err);
    }
  });


  // === ARCHIVE / RESTORE ===
  app.post("/api/contacts/:id/archive", requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId=strictRecordId.parse(req.params.id),fields=contactLifecycleFields.parse(req.body);
      if(fields.items.length!==1 || fields.items[0].id!==contactId) return res.status(400).json({message:"Path and selected contact must match"});
      const result=await commandContactLifecycle(bindWorkActor(req.user,fields.expectedActorId,fields.expectedAccountVersion),"archive",fields);
      res.json({...result.contacts[0],lifecycleChanged:result.changed>0,replayed:result.replayed});
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:err.errors[0].message});
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      console.error("Archive contact error:", err.message);
      serverError(res, err);
    }
  });

  app.post("/api/contacts/:id/restore", requireRole("admin", "manager"), async (req, res) => {
    try {
      const contactId=strictRecordId.parse(req.params.id),fields=contactLifecycleFields.parse(req.body);
      if(fields.items.length!==1 || fields.items[0].id!==contactId) return res.status(400).json({message:"Path and selected contact must match"});
      const result=await commandContactLifecycle(bindWorkActor(req.user,fields.expectedActorId,fields.expectedAccountVersion),"restore",fields);
      res.json({...result.contacts[0],lifecycleChanged:result.changed>0,replayed:result.replayed});
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:err.errors[0].message});
      if(err instanceof WorkCommandError) return res.status(err.status).json({message:err.message});
      console.error("Restore contact error:", err.message);
      serverError(res, err);
    }
  });

  app.post("/api/deals/:id/archive", isDashboardUser, async (req, res) => {
    try {
      const dealId = Number(req.params.id);
      const auditCtx = { actorType: "user" as const, userId: (req.user as any)?.id ?? null };
      const existingDeal = await storage.getDeal(dealId);
      if (!existingDeal) return res.status(404).json({ message: "Not found" });
      // C-02 (#1626): propagate the GHL delete BEFORE archiving locally, and
      // leave local state unchanged when propagation is pause-blocked or fails.
      const ghlResult = await propagateDealDeleteToGhl(dealId);
      if (!ghlResult.ok) {
        const status = ghlResult.reason === "paused" ? 503 : 409;
        return res.status(status).json({
          message: `GHL delete did not complete (${ghlResult.reason}). Deal was NOT archived locally — retry archive to re-attempt.`,
          localArchived: false,
          ghlPropagated: false,
          reason: ghlResult.reason,
        });
      }
      const result = await storage.archiveDeal(dealId, auditCtx);
      if (!result) return res.status(404).json({ message: "Not found" });
      res.json(result);
    } catch (err: any) {
      console.error("Archive deal error:", err.message);
      serverError(res, err);
    }
  });

  app.post("/api/deals/:id/restore", isDashboardUser, async (req, res) => {
    try {
      const auditCtx = { actorType: "user" as const, userId: (req.user as any)?.id ?? null };
      const result = await storage.restoreDeal(Number(req.params.id), auditCtx);
      if (!result) return res.status(404).json({ message: "Not found" });
      res.json(result);
    } catch (err: any) {
      console.error("Restore deal error:", err.message);
      serverError(res, err);
    }
  });


  // === BULK OPERATIONS ===
  app.post("/api/deals/bulk-stage", requireRole("admin", "manager"), async (req, res) => {
    try {
      const { dealIds, stage, overrideReason } = req.body;
      if (!Array.isArray(dealIds) || !stage) return res.status(400).json({ message: "dealIds array and stage required" });
      if(!dealIds.length || dealIds.length>500 || dealIds.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0)
        || typeof stage!=="string" || !stage.trim()) return res.status(400).json({message:"Valid bounded deal IDs and stage required"});
      const expectedStages=z.record(z.string().min(1)).optional().safeParse(req.body.expectedStages);
      if(!expectedStages.success) return res.status(400).json({message:"Invalid displayed stages"});

      const actor = req.user as any;
      const actorEmail: string = actor?.email ?? actor?.role ?? "unknown";

      // Build override context for go-live gate if a reason was supplied.
      // Admin/manager role is already enforced by requireRole above.
      const overrideCtx =
        typeof overrideReason === "string" && overrideReason.trim()
          ? { reason: overrideReason.trim(), actor: actorEmail }
          : undefined;

      let advanced = 0;
      let blocked = 0;
      const blockedDealIds: number[] = [];
      const results:Array<{id:number;outcome:"confirmed"|"blocked"|"unknown"|"unattempted";reason?:string;currentStage?:string}>=[];
      let interrupted=false;

      for (const rawId of dealIds) {
        const dealId = Number(rawId);
        if(interrupted) { results.push({id:dealId,outcome:"unattempted",reason:"Earlier outcome unresolved"});continue; }
        try {
          const result = await advanceDealStage(dealId, stage, "bulk_stage", overrideCtx, expectedStages.data?.[String(dealId)]);
          if (result) { advanced++;results.push({id:dealId,outcome:"confirmed",currentStage:result.stage}); }
          else { blocked++;blockedDealIds.push(dealId);results.push({id:dealId,outcome:"blocked",reason:"Record unavailable"}); }
        } catch (err) {
          if (err instanceof GoLiveGateError) {
            blocked++;
            blockedDealIds.push(dealId);
            results.push({id:dealId,outcome:"blocked",reason:"Go-live prerequisites not met"});
            // GoLiveGateError already wrote an audit log inside advanceDealStage
          } else if(err instanceof DealStageConflictError || err instanceof DealStageIllegalTransitionError) {
            blocked++;blockedDealIds.push(dealId);
            results.push({id:dealId,outcome:"blocked",reason:err.code,
              currentStage:err instanceof DealStageConflictError ? err.actual : err.from});
          } else {
            // A service can commit before an effect/readback fails. Never lose
            // confirmed item receipts or call this item a rollback.
            interrupted=true;results.push({id:dealId,outcome:"unknown",reason:"Read back this deal before retrying"});
          }
        }
      }

      res.json({ success:!interrupted, partial:blocked>0 || interrupted, advanced, blocked, blockedDealIds,results,
        confirmedDealIds:results.filter(r=>r.outcome==="confirmed").map(r=>r.id),
        unresolvedDealIds:results.filter(r=>r.outcome==="unknown" || r.outcome==="unattempted").map(r=>r.id) });
    } catch (err: any) {
      console.error("Bulk stage update error:", err.message);
      serverError(res, err);
    }
  });

  app.post("/api/tasks/bulk-assign", requireRole("admin", "manager"), async (req, res) => {
    try {
      const body = workCommandEnvelope.omit({ expectedFence: true }).extend({
        items: workSelection, assignedTo: z.string().min(1).max(190),
      }).strict().parse(req.body);
      const user = req.user as any;
      const command = await commandWorkItems({ kind: "task", items: body.items, commandId: body.commandId,
        recordClass: body.recordClass, actor: bindWorkActor(user, body.expectedActorId,body.expectedAccountVersion), updates: { assignedTo: body.assignedTo } });
      res.json({ success: true, count: command.changed, replayed: command.replayed });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof WorkCommandError) return res.status(err.status).json({ message: err.message });
      console.error("Bulk assign tasks error:", err.message);
      serverError(res, err);
    }
  });

  app.delete("/api/tasks/:id", isDashboardUser, async (req, res) => {
    try {
      const id = strictRecordId.parse(req.params.id);
      const body = workCommandEnvelope.strict().parse(req.body);
      const user = req.user as any;
      res.json(await deleteTaskCommand({ id, ...body, actor: bindWorkActor(user, body.expectedActorId,body.expectedAccountVersion) }, deps.nativeTaskDeleteTransport));
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof WorkCommandError) return res.status(err.status).json({ message: err.message, localDeleted: false });
      console.error("Delete task error:", err.message);
      serverError(res, err);
    }
  });

  app.post("/api/tasks/bulk-delete", requireRole("admin", "manager"), async (req, res) => {
    try {
      const body = workCommandEnvelope.omit({ expectedFence: true }).extend({ items: workSelection }).strict().parse(req.body);
      const user = req.user as any;
      const command = await commandWorkItems({ kind: "task", items: body.items, commandId: body.commandId,
        recordClass: body.recordClass, actor: bindWorkActor(user, body.expectedActorId,body.expectedAccountVersion), operation: "soft_delete", updates: {} });
      res.json({ deleted: command.changed, replayed: command.replayed });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof WorkCommandError) return res.status(err.status).json({ message: err.message });
      console.error("Bulk delete tasks error:", err.message);
      serverError(res, err);
    }
  });


  // === LEGACY DUPLICATE DETECTION & MERGE (BT-07 containment) ==============
  // The unsafe storage.mergeContacts helper is deliberately unavailable to
  // every role. Reviewed candidates and execution are registered in
  // routes/contacts.ts under their own authorization boundary.
  app.get("/api/contacts/duplicates", isDashboardUser, requireRole("admin", "manager"), async (_req, res) => {
    return res.status(410).json({
      code: "LEGACY_CONTACT_MERGE_DISABLED",
      message: "Legacy duplicate discovery is disabled. Use reviewed identity candidates.",
    });
  });

  app.post("/api/contacts/merge", isDashboardUser, requireRole("admin"), async (req, res) => {
    await storage.createAuditLog({
      action: "legacy_contact_merge_blocked",
      entityType: "contact_merge",
      actorType: "user",
      actorId: (req.user as any)?.id ?? null,
      details: { reason: "LEGACY_CONTACT_MERGE_DISABLED" },
    }).catch(() => {});
    return res.status(410).json({
      code: "LEGACY_CONTACT_MERGE_DISABLED",
      message: "Legacy merge execution is permanently disabled. Use the reviewed merge operation API.",
    });
  });

}
