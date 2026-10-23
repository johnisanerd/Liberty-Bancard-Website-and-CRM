import type { Express } from "express";
import { isAuthenticated, requireRole } from "../replit_integrations/auth";
import { storage } from "../storage";
import { z } from "zod";
import { insertMessageTemplateSchema, insertSavedFilterSchema, insertSlaConfigSchema } from "@shared/schema";
import { getEmailSignatureHtml, getEmailSignaturePlainText, getStoredSignature, saveSignature } from "../services/email-signatures";
import { parse } from "csv-parse/sync";
import { serverError } from "../utils/server-error";

export function registerTemplatesSettingsRoutes(app: Express) {
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

  app.post("/api/message-templates", requireRole("admin", "manager"), async (req, res) => {
    try {
      const input = insertMessageTemplateSchema.parse(req.body);
      const template = await storage.createMessageTemplate(input);
      res.status(201).json(template);
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  app.put("/api/message-templates/:id", requireRole("admin", "manager"), async (req, res) => {
    try {
      const updated = await storage.updateMessageTemplate(Number(req.params.id), req.body);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch (err: any) {
      serverError(res, err);
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
