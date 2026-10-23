import type { Express } from "express";
import { isAuthenticated, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { z } from "zod";
import { insertMessageTemplateSchema, insertSavedFilterSchema, insertSlaConfigSchema } from "@shared/schema";
import { getEmailSignatureHtml, getEmailSignaturePlainText, getStoredSignature, saveSignature } from "../services/email-signatures";
import { parse } from "csv-parse/sync";
import { serverError } from "../utils/server-error";
import {
  TemplateVersionError, discardDraft, getTemplateWorkspace, previewTemplate, previewTemplateFinal, publishDraft, saveDraft, setTemplateActive,
} from "../services/message-template-versions";

export function registerTemplatesSettingsRoutes(app: Express) {
  // === REVIEWED COPY CONVERGENCE (versioned wording repair; never enables, activates or sends) ===
  app.get("/api/message-copy/convergence", requireRole("admin"), async (_req, res) => {
    try {
      const { getCopyConvergenceStatus } = await import("../services/reviewed-copy-replacements");
      res.json({ last: await getCopyConvergenceStatus() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/message-copy/convergence", requireRole("admin"), async (_req, res) => {
    try {
      const { convergeReviewedCopy } = await import("../services/reviewed-copy-replacements");
      res.json(await convergeReviewedCopy());
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // === REVIEW OWNER AND DUE TIME for partner applications and privacy requests (recorded policy only) ===
  app.get("/api/admin/inbound-review-policy", requireRole("admin"), async (_req, res) => {
    try {
      const { getReviewPolicy } = await import("../services/inbound-review-policy");
      res.json({ policy: await getReviewPolicy() });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/admin/inbound-review-policy", requireRole("admin"), async (req, res) => {
    try {
      const { setReviewPolicy } = await import("../services/inbound-review-policy");
      res.json({ policy: await setReviewPolicy(req.body?.policy ?? {}, String((req.user as any)?.id ?? "admin")) });
    } catch (err: any) {
      if (typeof err?.message === "string" && /^INVALID_REVIEW_/.test(err.message)) return res.status(400).json({ message: err.message });
      serverError(res, err);
    }
  });

  // === MESSAGE TEMPLATES ===
  app.get("/api/message-templates", isAuthenticated, async (req, res) => {
    try {
      const category = req.query.category as string | undefined;
      const templates = category
        ? await storage.getMessageTemplatesByCategory(category)
        : await storage.getMessageTemplates();
      res.json(templates);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/message-templates/:id", isAuthenticated, async (req, res) => {
    try {
      const template = await storage.getMessageTemplate(Number(req.params.id));
      if (!template) return res.status(404).json({ message: "Not found" });
      res.json(template);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  // Creating a template never makes it live: it starts inactive and its wording follows the same
  // draft -> publish -> activate path as every other template.
  app.post("/api/message-templates", requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertMessageTemplateSchema.parse(req.body);
      const template = await storage.createMessageTemplate({ ...input, isActive: false });
      res.status(201).json(template);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // Metadata only. Wording changes go through draft/publish and activation through the activation route.
  const templateMetadataSchema = z.object({
    name: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    channel: z.enum(["email", "sms"]).optional(),
    mergeFields: z.array(z.string()).nullable().optional(),
  }).strict();

  app.put("/api/message-templates/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const body = templateMetadataSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ message: "Only name, category, channel and merge fields can be edited here. Use Save draft / Publish for wording and Activate for use." });
      }
      const updated = await storage.updateMessageTemplate(Number(req.params.id), body.data);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  const templateId = (req: any) => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const actor = (req: any) => String(req.user?.id ?? "");
  const versionError = (res: any, err: unknown) => {
    if (err instanceof TemplateVersionError) return res.status(err.status).json({ message: err.message, findings: err.findings });
    return serverError(res, err);
  };

  app.get("/api/message-templates/:id/workspace", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = templateId(req);
      if (!id) return res.status(400).json({ message: "Invalid template id" });
      res.json(await getTemplateWorkspace(id));
    } catch (err) { versionError(res, err); }
  });

  // Preview renders sample values only. It sends nothing and stores nothing.
  app.post("/api/message-templates/preview", requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = z.object({ subject: z.string().nullable().optional(), body: z.string().min(1), channel: z.enum(["email", "sms"]).optional() }).strict().parse(req.body);
      res.json(await previewTemplateFinal(input));
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.put("/api/message-templates/:id/draft", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = templateId(req);
      if (!id) return res.status(400).json({ message: "Invalid template id" });
      const input = z.object({
        subject: z.string().nullable(), body: z.string().min(1, "Message body is required"), baseVersion: z.number().int().positive(),
      }).strict().parse(req.body);
      res.json(await saveDraft(id, input, actor(req)));
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      versionError(res, err);
    }
  });

  app.delete("/api/message-templates/:id/draft", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = templateId(req);
      if (!id) return res.status(400).json({ message: "Invalid template id" });
      res.json(await discardDraft(id, actor(req)));
    } catch (err) { versionError(res, err); }
  });

  // Publishing changes wording only. It never activates the template, enables a workflow or opens a send path.
  app.post("/api/message-templates/:id/publish", requireRole("admin", "manager"), async (req, res) => {
    try {
      const id = templateId(req);
      if (!id) return res.status(400).json({ message: "Invalid template id" });
      const input = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(req.body);
      res.json(await publishDraft(id, input, actor(req)));
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      versionError(res, err);
    }
  });

  // "Activate campaign actions": allows workflow and operator sends to use this template's published wording.
  app.post("/api/message-templates/:id/activation", requireRole("admin"), async (req, res) => {
    try {
      const id = templateId(req);
      if (!id) return res.status(400).json({ message: "Invalid template id" });
      const input = z.object({ active: z.boolean() }).strict().parse(req.body);
      res.json(await setTemplateActive(id, input.active, actor(req)));
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      versionError(res, err);
    }
  });


  // === SLA CONFIGS ===
  app.get("/api/sla-configs", isAuthenticated, async (req, res) => {
    try {
      const configs = await storage.getSlaConfigs();
      res.json(configs);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/sla-configs", isAuthenticated, async (req, res) => {
    try {
      const input = insertSlaConfigSchema.parse(req.body);
      const config = await storage.createSlaConfig(input);
      res.status(201).json(config);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.put("/api/sla-configs/:id", isAuthenticated, async (req, res) => {
    try {
      const updated = await storage.updateSlaConfig(Number(req.params.id), req.body);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === EMAIL SIGNATURES ===
  app.get("/api/email-signatures/:type", isAuthenticated, async (req, res) => {
    try {
      const type = req.params.type as "sales" | "support" | "onboarding";
      const sig = await getStoredSignature(type);
      res.json({
        signature: sig,
        html: getEmailSignatureHtml(type, sig),
        plainText: getEmailSignaturePlainText(type, sig),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.put("/api/email-signatures/:type", isAuthenticated, async (req, res) => {
    try {
      if (!['admin', 'manager'].includes((req.user as any)?.role)) return res.status(403).json({ message: "Admin/Manager only" });
      const type = req.params.type as "sales" | "support" | "onboarding";
      await saveSignature(type, req.body);
      const sig = await getStoredSignature(type);
      res.json({
        signature: sig,
        html: getEmailSignatureHtml(type as any, sig),
        plainText: getEmailSignaturePlainText(type as any, sig),
      });
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.get("/api/email-signatures", isAuthenticated, async (req, res) => {
    try {
      const types = ["sales", "support", "onboarding"];
      const signatures: Record<string, any> = {};
      for (const type of types) {
        const sig = await getStoredSignature(type);
        signatures[type] = {
          signature: sig,
          html: getEmailSignatureHtml(type as any, sig),
          plainText: getEmailSignaturePlainText(type as any, sig),
        };
      }
      res.json(signatures);
    } catch (err: any) {
      serverError(res, err);
    }
  });


  // === SAVED FILTERS ===
  app.get("/api/saved-filters", isAuthenticated, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const entityType = req.query.entityType ? String(req.query.entityType) : undefined;
      const filters = await storage.getSavedFilters(userId, entityType);
      res.json(filters);
    } catch (err: any) {
      serverError(res, err);
    }
  });

  app.post("/api/saved-filters", isAuthenticated, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      const input = insertSavedFilterSchema.parse({ ...req.body, userId });
      const filter = await storage.createSavedFilter(input);
      res.status(201).json(filter);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.delete("/api/saved-filters/:id", isAuthenticated, async (req, res) => {
    try {
      await storage.deleteSavedFilter(Number(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      serverError(res, err);
    }
  });

}
