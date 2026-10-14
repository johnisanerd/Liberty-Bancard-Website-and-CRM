import type { Express } from "express";
import { storage } from "../storage";
import { db } from "../db";
import { isAuthenticated, isDashboardUser } from "../replit_integrations/auth";
import { authorizeContactAccess, authorizeLiveChatAccess } from "../services/crm-object-access";
import { z } from "zod";
import { randomUUID } from "crypto";
import { contacts } from "@shared/schema";
import type { LiveChat } from "@shared/schema";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { createContactLocalFirst } from "../services/contact-writer";
import { sendCriticalEmailNotification } from "../services/digest-service";
import { serverError } from "../utils/server-error";

interface AuthUser {
  role?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

function isBusinessHours(): boolean {
  const now = new Date();
  const eastern = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = eastern.getDay();
  const hour = eastern.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

export function registerLiveChatRoutes(app: Express) {

  // === PUBLIC: Start a new chat session ===
  app.post("/api/public/chat/session", async (req, res) => {
    if (req.query.probe === "1") return res.json({ probe: true, endpoint: "/api/public/chat/session" });
    try {
      const schema = z.object({
        pageUrl: z.string().optional(),
        visitorName: z.string().optional(),
        visitorEmail: z.string().email().optional(),
      });
      const { pageUrl, visitorName, visitorEmail } = schema.parse(req.body);
      const sessionId = randomUUID();

      const chat = await storage.createLiveChat({
        sessionId,
        visitorName: visitorName || null,
        visitorEmail: visitorEmail || null,
        pageUrl: pageUrl || null,
        status: "active",
        contactId: null,
      });

      await storage.createNotification({
        channel: "internal",
        title: "New Live Chat Started",
        message: `Visitor started a chat${visitorName ? ` — ${visitorName}` : ""}${pageUrl ? ` on ${pageUrl}` : ""}`,
        type: "info",
        metadata: { chatId: chat.id, sessionId },
      });

      const escapeHtml = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const safeVisitorName = visitorName ? escapeHtml(visitorName) : "(not provided)";
      const safeVisitorEmail = visitorEmail ? escapeHtml(visitorEmail) : "(not provided)";
      const safePageUrl = pageUrl ? escapeHtml(pageUrl) : "(not provided)";

      const dashboardUrl = `${process.env.APP_URL || "https://app.libertybancard.com"}/dashboard/live-chat`;
      const emailBody = `
<h2>New Live Chat Started</h2>
<p>A visitor has started a live chat session on your website.</p>
<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
  <tr><td style="font-weight:bold;padding-right:12px;">Visitor Name:</td><td>${safeVisitorName}</td></tr>
  <tr><td style="font-weight:bold;padding-right:12px;">Visitor Email:</td><td>${safeVisitorEmail}</td></tr>
  <tr><td style="font-weight:bold;padding-right:12px;">Page URL:</td><td>${safePageUrl}</td></tr>
  <tr><td style="font-weight:bold;padding-right:12px;">Chat ID:</td><td>${chat.id}</td></tr>
  <tr><td style="font-weight:bold;padding-right:12px;">Started At:</td><td>${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} EST</td></tr>
</table>
<p style="margin-top:20px;">
  <a href="${dashboardUrl}" style="background:#1a56db;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;font-weight:bold;">
    Open Live Chat Dashboard
  </a>
</p>
<p style="color:#888;font-size:12px;margin-top:24px;">Liberty Bancard CRM — automated alert</p>`;

      sendCriticalEmailNotification({
        eventType: "live_chat_started",
        subject: `New Live Chat — ${visitorName || "Visitor"}${pageUrl ? ` on ${pageUrl}` : ""}`,
        body: emailBody,
        recipientEmail: process.env.SUPPORT_INBOX_EMAIL || process.env.ADMIN_DIGEST_EMAIL || undefined,
      }).catch((err) => {
        console.error("[LiveChat] Failed to send new-chat email notification:", err);
      });

      res.status(201).json({ sessionId, chatId: chat.id, isBusinessHours: isBusinessHours() });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === PUBLIC: Send a visitor message ===
  app.post("/api/public/chat/session/:sessionId/message", async (req, res) => {
    try {
      const schema = z.object({ content: z.string().min(1).max(2000) });
      const { content } = schema.parse(req.body);
      const chat = await storage.getLiveChatBySession(req.params.sessionId);
      if (!chat) return res.status(404).json({ message: "Chat session not found" });
      if (chat.status === "closed") return res.status(410).json({ message: "Chat session closed" });

      const message = await storage.createLiveChatMessage({
        chatId: chat.id,
        senderType: "visitor",
        senderName: chat.visitorName || "Visitor",
        content,
      });

      await storage.updateLiveChat(chat.id, { lastMessageAt: new Date() });

      await storage.createNotification({
        channel: "internal",
        title: "New Chat Message",
        message: `${chat.visitorName || "Visitor"}: ${content.slice(0, 100)}`,
        type: "info",
        metadata: { chatId: chat.id, sessionId: chat.sessionId },
      });

      res.json(message);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === PUBLIC: Poll for new messages ===
  app.get("/api/public/chat/session/:sessionId/messages", async (req, res) => {
    try {
      const chat = await storage.getLiveChatBySession(req.params.sessionId);
      if (!chat) return res.status(404).json({ message: "Chat session not found" });

      const afterId = req.query.afterId ? Number(req.query.afterId) : undefined;
      const messages = await storage.getLiveChatMessages(chat.id, afterId);
      res.json({ messages, status: chat.status, isBusinessHours: isBusinessHours() });
    } catch (err: unknown) {
      serverError(res, err);
    }
  });

  // === PUBLIC: Identify visitor (set email/name → creates/matches CRM contact) ===
  app.post("/api/public/chat/session/:sessionId/identify", async (req, res) => {
    try {
      const schema = z.object({
        name: z.string().min(1),
        email: z.string().email(),
      });
      const { name, email } = schema.parse(req.body);
      const chat = await storage.getLiveChatBySession(req.params.sessionId);
      if (!chat) return res.status(404).json({ message: "Chat session not found" });

      const nameParts = name.trim().split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      let contactId = chat.contactId;
      try {
        const contact = await createContactLocalFirst({
          firstName,
          lastName,
          email,
          phone: "",
          status: "New",
          tags: ["src_live_chat", "lead_website_chat"],
          landingPage: chat.pageUrl || "/",
        });
        contactId = contact.id;

        await storage.createNote({
          entityType: "contact",
          entityId: contact.id,
          content: `Live chat initiated from ${chat.pageUrl || "website"} on ${new Date(chat.createdAt).toLocaleString()}`,
          authorName: "System",
          pinned: false,
        });
      } catch (_) {
        const existing = await storage.getContactByEmail(email).catch(() => undefined);
        if (existing) contactId = existing.id;
      }

      await storage.updateLiveChat(chat.id, {
        visitorName: name,
        visitorEmail: email,
        contactId,
      });

      res.json({ success: true, contactId });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === PUBLIC: Close a chat session ===
  app.post("/api/public/chat/session/:sessionId/close", async (req, res) => {
    try {
      const chat = await storage.getLiveChatBySession(req.params.sessionId);
      if (!chat) return res.status(404).json({ message: "Chat session not found" });

      if (chat.contactId) {
        const messages = await storage.getLiveChatMessages(chat.id);
        if (messages.length > 0) {
          const transcript = messages
            .map(m => `[${m.senderType === "agent" ? "Agent" : "Visitor"}] ${m.content}`)
            .join("\n");
          await storage.createNote({
            entityType: "contact",
            entityId: chat.contactId,
            content: `Live chat transcript (${new Date(chat.createdAt).toLocaleString()}):\n\n${transcript}`,
            authorName: "System",
            pinned: false,
          });
        }
      }

      await storage.updateLiveChat(chat.id, { status: "closed", closedAt: new Date() });
      res.json({ success: true });
    } catch (err: unknown) {
      serverError(res, err);
    }
  });

  // === PUBLIC: Offline form capture ===
  app.post("/api/public/chat/offline", async (req, res) => {
    try {
      const schema = z.object({
        name: z.string().min(1),
        email: z.string().email(),
        message: z.string().min(1).max(2000),
        pageUrl: z.string().optional(),
      });
      const { name, email, message, pageUrl } = schema.parse(req.body);

      const nameParts = name.trim().split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      let contactId: number | undefined;
      try {
        const contact = await createContactLocalFirst({
          firstName,
          lastName,
          email,
          phone: "",
          status: "New",
          tags: ["src_live_chat", "offline_chat_message"],
          landingPage: pageUrl || "/",
          notes: `Offline chat message: ${message}`,
        });
        contactId = contact.id;
      } catch (_) {
        const existing = await storage.getContactByEmail(email).catch(() => undefined);
        if (existing) contactId = existing.id;
      }

      const sessionId = randomUUID();
      const chat = await storage.createLiveChat({
        sessionId,
        visitorName: name,
        visitorEmail: email,
        pageUrl: pageUrl || null,
        status: "offline_captured",
        contactId: contactId || null,
      });

      await storage.createLiveChatMessage({
        chatId: chat.id,
        senderType: "visitor",
        senderName: name,
        content: message,
      });

      if (contactId) {
        await storage.createNote({
          entityType: "contact",
          entityId: contactId,
          content: `Offline chat message (${new Date().toLocaleString()}):\n${message}`,
          authorName: "System",
          pinned: false,
        });
      }

      await storage.createNotification({
        channel: "internal",
        title: "Offline Chat Message",
        message: `${name} (${email}) left a message: ${message.slice(0, 120)}`,
        type: "info",
        metadata: { chatId: chat.id, contactId },
      });

      res.status(201).json({ success: true });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === AGENT: List all chat sessions ===
  app.get("/api/live-chat/sessions", isDashboardUser, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      let chats: LiveChat[];
      if (status === "active") {
        chats = await storage.getActiveLiveChats();
      } else {
        chats = await storage.getAllLiveChats({ limit: 100 });
      }
      if ((req.user as AuthUser)?.role === "agent") {
        const agentEmail = (req.user as AuthUser)?.email;
        const visible = await Promise.all(chats.map(async (chat) => {
          if (!chat.contactId) return false;
          const contact = await storage.getContact(chat.contactId);
          return !!contact && (!contact.assignedTo || contact.assignedTo === agentEmail);
        }));
        chats = chats.filter((_chat, index) => visible[index]);
      }
      res.json(chats);
    } catch (err: unknown) {
      serverError(res, err);
    }
  });

  // === AGENT: Get messages for a session ===
  app.get("/api/live-chat/sessions/:id/messages", isDashboardUser, async (req, res) => {
    try {
      const chatId = Number(req.params.id);
      const chat = await storage.getLiveChat(chatId);
      if (!await authorizeLiveChatAccess(req, res, chat)) return;
      const afterId = req.query.afterId ? Number(req.query.afterId) : undefined;
      const messages = await storage.getLiveChatMessages(chatId, afterId);
      res.json({ messages, chat });
    } catch (err: unknown) {
      serverError(res, err);
    }
  });

  // === AGENT: Reply to a chat ===
  app.post("/api/live-chat/sessions/:id/reply", isDashboardUser, async (req, res) => {
    try {
      const schema = z.object({ content: z.string().min(1).max(2000) });
      const { content } = schema.parse(req.body);
      const chatId = Number(req.params.id);
      const chat = await storage.getLiveChat(chatId);
      if (!await authorizeLiveChatAccess(req, res, chat, { exactAssignment: true })) return;

      const user = req.user as AuthUser;
      const agentName = user?.firstName && user?.lastName
        ? `${user.firstName} ${user.lastName}`
        : user?.email ?? "Support Agent";

      const message = await storage.createLiveChatMessage({
        chatId,
        senderType: "agent",
        senderName: agentName,
        content,
      });

      await storage.updateLiveChat(chatId, { lastMessageAt: new Date() });
      res.json(message);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === AGENT: Update a chat session (close or link contact) ===
  app.patch("/api/live-chat/sessions/:id", isDashboardUser, async (req, res) => {
    try {
      const schema = z.object({
        status: z.enum(["active", "closed"]).optional(),
        contactId: z.number().int().positive().nullable().optional(),
      }).refine(d => d.status !== undefined || d.contactId !== undefined, {
        message: "At least one of status or contactId is required",
      });
      const body = schema.parse(req.body);
      const chatId = Number(req.params.id);
      const chat = await storage.getLiveChat(chatId);
      const authorizedChat = await authorizeLiveChatAccess(req, res, chat, { exactAssignment: true });
      if (!authorizedChat) return;
      if (body.contactId !== undefined && body.contactId !== null && body.contactId !== authorizedChat.contactId) {
        if (!await authorizeContactAccess(req, res, body.contactId, { exactAssignment: true })) return;
      }

      const baseUpdate: Parameters<typeof storage.updateLiveChat>[1] = {};

      if (body.status !== undefined) {
        baseUpdate.status = body.status;
        if (body.status === "closed") {
          baseUpdate.closedAt = new Date();
          const resolvedContactId = body.contactId !== undefined ? body.contactId : authorizedChat.contactId;
          if (resolvedContactId) {
            const messages = await storage.getLiveChatMessages(chatId);
            if (messages.length > 0) {
              const transcript = messages
                .map(m => `[${m.senderType === "agent" ? "Agent" : "Visitor"}] ${m.content}`)
                .join("\n");
              await storage.createNote({
                entityType: "contact",
                entityId: resolvedContactId,
                content: `Live chat transcript (${new Date(authorizedChat.createdAt).toLocaleString()}):\n\n${transcript}`,
                authorName: "System",
                pinned: false,
              });
            }
          }
        }
      }

      if (body.contactId !== undefined) {
        baseUpdate.contactId = body.contactId;
      }

      const updated = await storage.updateLiveChat(chatId, baseUpdate);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });

  // === AGENT: Search contacts for linking ===
  app.get("/api/live-chat/contacts/search", isDashboardUser, async (req, res) => {
    try {
      const q = (req.query.q as string || "").toLowerCase().trim();
      if (!q || q.length < 2) return res.json([]);
      const agentEmail = (req.user as AuthUser)?.role === "agent" ? (req.user as AuthUser)?.email : undefined;
      const pattern = `%${q}%`;
      const ownership = agentEmail
        ? or(eq(contacts.assignedTo, agentEmail), isNull(contacts.assignedTo))
        : undefined;
      const matches = await db
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          companyName: contacts.companyName,
        })
        .from(contacts)
        .where(and(
          ownership,
          or(
            ilike(contacts.firstName, pattern),
            ilike(contacts.lastName, pattern),
            ilike(contacts.email, pattern),
            ilike(contacts.companyName, pattern),
            ilike(contacts.phone, pattern),
          ),
        ))
        .limit(15);
      res.json(matches);
    } catch (err: unknown) {
      serverError(res, err);
    }
  });
}
