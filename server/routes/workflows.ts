import type { Express } from "express";
import { isAuthenticated,isDashboardUser, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { z } from "zod";
import { insertWorkflowSchema } from "@shared/schema";
import {rfiWorkCommand} from "@shared/rfi-work-command";
import {commandRfi} from "../services/rfi-work-command";
import {bindWorkActor,WorkCommandError} from "../services/work-item-command";
import { executeWorkflowActions, triggerWorkflowsByEvent } from "../services/workflow-executor";
import { parse } from "csv-parse/sync";
import { requireInternalWebhookSecret } from "../middleware/internal-webhook-auth";
import { serverError } from "../utils/server-error";
import { authorizeContactAccess, authorizeDealAccess } from "../services/crm-object-access";
import { WorkflowCommandError } from "../services/workflow-command-error";
import { WorkflowSmsWordingError, getWorkflowSmsWorkspace, previewWorkflowSms, publishWorkflowSmsStep } from "../services/workflow-sms-wording";
import { WorkflowEmailWordingError, getWorkflowEmailWorkspace, previewWorkflowEmail, publishWorkflowEmailStep } from "../services/workflow-email-wording";

const positiveId = z.coerce.number().int().positive().safe();

export function registerWorkflowsRoutes(app: Express) {
  // === RFIs ===
  app.get("/api/rfis", isDashboardUser,requireRole("admin","manager","agent"), async (req, res) => {
    try {
      const {strictRecordId}=await import("@shared/work-item-commands");
      const contactId=req.query.contactId===undefined?undefined:strictRecordId.parse(req.query.contactId);
      const {readActorRfis}=await import("../services/notification-authority");
      res.json(await readActorRfis((req.user as any).id,contactId));
    } catch (err: any) {
      if(err instanceof z.ZodError)return res.status(400).json({message:"Invalid/conflicting contact ID"});
      serverError(res, err);
    }
  });

  app.get("/api/rfis/:id", isDashboardUser, async (req, res) => {
    try {
      const {strictRecordId}=await import("@shared/work-item-commands");
      const id=strictRecordId.parse(req.params.id);
      const {readActorRfi}=await import("../services/notification-authority");
      const rfi=await readActorRfi((req.user as any).id,id);
      if (!rfi) return res.status(404).json({ message: "Not found" });
      res.json(rfi);
    } catch (err: any) {
      if(err instanceof z.ZodError) return res.status(400).json({message:"Invalid RFI ID"});
      serverError(res, err);
    }
  });

  app.post("/api/rfis", isDashboardUser,requireRole("admin","manager","agent"), async (req, res) => {
    try {
      const input=rfiWorkCommand.parse(req.body);
      const result=await commandRfi(bindWorkActor(req.user,input.expectedActorId,input.expectedAccountVersion),"create",input);
      res.status(result.replayed?200:201).json({...result.rfi,command:{
        id:input.commandId,replayed:result.replayed,changed:result.changed,nativeDelivery:result.nativeDelivery}});
    } catch (err: any) {
      if(err instanceof WorkCommandError)return res.status(err.status).json({message:err.message});
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.put("/api/rfis/:id", isDashboardUser,requireRole("admin","manager","agent"), async (req, res) => {
    try {
      const {strictRecordId}=await import("@shared/work-item-commands");
      const id=strictRecordId.parse(req.params.id),input=rfiWorkCommand.parse(req.body);
      const result=await commandRfi(bindWorkActor(req.user,input.expectedActorId,input.expectedAccountVersion),"edit",input,id);
      res.json({...result.rfi,command:{id:input.commandId,replayed:result.replayed,
        changed:result.changed,nativeDelivery:result.nativeDelivery}});
    } catch (err: any) {
      if(err instanceof WorkCommandError)return res.status(err.status).json({message:err.message});
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });


  // === WORKFLOWS ===
  app.get("/api/workflows", requireRole("admin", "manager"), async (req, res) => {
    try {
      const wfs = await storage.getWorkflows();
      res.json(wfs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/workflows/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      const wf = await storage.getWorkflow(id.data);
      if (!wf) return res.status(404).json({ message: "Not found" });
      res.json(wf);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/workflows", requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertWorkflowSchema.omit({ version: true, retiredAt: true }).parse(req.body);
      const wf = await storage.createWorkflow(input);
      await storage.createAuditLog({ action: "workflow_created", entityType: "workflow", entityId: wf.id, details: { name: wf.name, trigger: wf.triggerType } });
      res.status(201).json(wf);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.put("/api/workflows/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      const { expectedVersion, ...allowed } = insertWorkflowSchema.omit({ version: true, retiredAt: true }).partial()
        .extend({ expectedVersion: z.number().int().positive() }).strict().parse(req.body);
      const updated = await storage.updateWorkflow(id.data, allowed, { expectedVersion, actorId: String((req.user as any).id) });
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof WorkflowCommandError) return res.status(err.status).json({ message: err.message });
      serverError(res, err);
    }
  });

  // Inline email wording: preview, then lint-gated publish through the versioned workflow command.
  // Publishing replaces one step's subject/body only and never changes the workflow's enabled state.
  const emailWordingError = (res: any, err: unknown) => {
    if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
    if (err instanceof WorkflowEmailWordingError) return res.status(err.status).json({ message: err.message, findings: err.findings });
    return serverError(res, err);
  };

  app.get("/api/workflows/:id/email-steps", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      res.json(await getWorkflowEmailWorkspace(id.data));
    } catch (err) { emailWordingError(res, err); }
  });

  app.post("/api/workflows/:id/email-steps/preview", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      const input = z.object({ subject: z.string().nullable().optional(), body: z.string() }).strict().parse(req.body);
      res.json(previewWorkflowEmail(input));
    } catch (err) { emailWordingError(res, err); }
  });

  app.post("/api/workflows/:id/email-steps/publish", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      const input = z.object({
        stepIndex: z.number().int().min(0), subject: z.string().nullable(), body: z.string().min(1, "Email body is required"),
        expectedVersion: z.number().int().positive(),
      }).strict().parse(req.body);
      const workflow = await publishWorkflowEmailStep(id.data, input, String((req.user as any).id));
      res.json({ workflow, published: true, enabled: workflow.enabled });
    } catch (err) { emailWordingError(res, err); }
  });

  // Inline SMS wording: same preview and lint-gated publish path as email steps; never changes enabled state.
  const smsWordingError = (res: any, err: unknown) => {
    if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
    if (err instanceof WorkflowSmsWordingError) return res.status(err.status).json({ message: err.message, findings: err.findings });
    return serverError(res, err);
  };

  app.get("/api/workflows/:id/sms-steps", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      res.json(await getWorkflowSmsWorkspace(id.data));
    } catch (err) { smsWordingError(res, err); }
  });

  app.post("/api/workflows/:id/sms-steps/preview", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      const input = z.object({ body: z.string() }).strict().parse(req.body);
      res.json(previewWorkflowSms(input));
    } catch (err) { smsWordingError(res, err); }
  });

  app.post("/api/workflows/:id/sms-steps/publish", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      const input = z.object({
        stepIndex: z.number().int().min(0), body: z.string().min(1, "Text message body is required"),
        expectedVersion: z.number().int().positive(),
      }).strict().parse(req.body);
      const workflow = await publishWorkflowSmsStep(id.data, input, String((req.user as any).id));
      res.json({ workflow, published: true, enabled: workflow.enabled });
    } catch (err) { smsWordingError(res, err); }
  });

  app.delete("/api/workflows/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid workflow id" });
      const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(req.body);
      const workflow = await storage.deleteWorkflow(id.data, { expectedVersion, actorId: String((req.user as any).id) });
      res.json({ success: true, retired: true, historyRetained: true, workflow });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof WorkflowCommandError) return res.status(err.status).json({ message: err.message });
      serverError(res, err);
    }
  });

  app.post("/api/workflows/:id/restore", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.parse(req.params.id);
      const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(req.body);
      const workflow = await storage.commandWorkflow(id, "restore", { expectedVersion, actorId: String((req.user as any).id) });
      res.json({ workflow, restored: true, enabled: false });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      if (err instanceof WorkflowCommandError) return res.status(err.status).json({ message: err.message });
      serverError(res, err);
    }
  });

  app.get("/api/workflow-runs", requireRole("admin", "manager"), async (req, res) => {
    try {
      const parsed = req.query.workflowId === undefined ? undefined : positiveId.safeParse(req.query.workflowId);
      if (parsed && !parsed.success) return res.status(400).json({ message: "Invalid workflow id" });
      const workflowId = parsed?.success ? parsed.data : undefined;
      const runs = workflowId
        ? await storage.getWorkflowRunsByWorkflow(workflowId)
        : await storage.getWorkflowRuns();
      res.json(runs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/workflows/:id/run", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = positiveId.safeParse(req.params.id);
      const entity = z.object({ entityType: z.enum(["contact", "deal"]), entityId: z.number().int().positive().safe() }).safeParse(req.body);
      if (!id.success || !entity.success) return res.status(400).json({ message: "Valid workflow and contact/deal entity required" });
      const authorized = entity.data.entityType === "contact"
        ? await authorizeContactAccess(req, res, entity.data.entityId)
        : await authorizeDealAccess(req, res, entity.data.entityId);
      if (!authorized) return;
      if ("archivedAt" in authorized && authorized.archivedAt) return res.status(404).json({ message: "Not found" });
      const wf = await storage.getWorkflow(id.data);
      if (!wf) return res.status(404).json({ message: "Workflow not found" });
      if (!wf.enabled || wf.retiredAt) return res.status(400).json({ message: "Workflow is disabled or retired" });

      const actions = (wf.actions as any[]) || [];
      const result = await executeWorkflowActions(wf.id, actions, {
        entityType: entity.data.entityType,
        entityId: entity.data.entityId,
      });
      if (result.status === "blocked") return res.status(409).json({ message: "Workflow changed or its run is unavailable; no run was started", result });
      res.json({ success: true, runId: result.runId, status: result.status, steps: result.log });
    } catch (err: any) {
      if (err instanceof WorkflowCommandError) return res.status(err.status).json({ message: err.message });
      serverError(res, err);
    }
  });


  // === WORKFLOW TRIGGER EXECUTION ===
  // #225 — Rate-limit: max 60 trigger calls per minute per secret (shared bucket)
  const _webhookTriggerWindow: { count: number; resetAt: number } = { count: 0, resetAt: Date.now() + 60_000 };
  function checkWebhookTriggerRateLimit(): boolean {
    const now = Date.now();
    if (now > _webhookTriggerWindow.resetAt) { _webhookTriggerWindow.count = 0; _webhookTriggerWindow.resetAt = now + 60_000; }
    _webhookTriggerWindow.count++;
    return _webhookTriggerWindow.count <= 60;
  }

  app.post("/api/webhooks/trigger", requireInternalWebhookSecret, async (req, res) => {
    if (!checkWebhookTriggerRateLimit()) {
      return res.status(429).json({ message: "Rate limit exceeded: max 60 webhook triggers per minute" });
    }
    try {
      const { event, entityType, entityId, data } = req.body;
      if (!event) return res.status(400).json({ message: "event required" });

      const results = await triggerWorkflowsByEvent(event, {
        entityType: entityType || undefined,
        entityId: entityId ? Number(entityId) : undefined,
        data,
      });

      res.json({ triggered: results.length, workflows: results.map(r => r.workflowName), results });
    } catch (err: any) {
      serverError(res, err);
    }
  });

}
