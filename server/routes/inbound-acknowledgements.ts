import type { Express } from "express";
import { z } from "zod";
import { requireRole } from "../replit_integrations/auth";
import { serverError } from "../utils/server-error";
import { getBackgroundProfile } from "../services/background-profile";
import {
  ACK_SOURCE_CLASSES,
  getAckCapability,
  getAcknowledgementStatusCounts,
  setAckCapability,
  startInboundAcknowledgementWorker,
} from "../services/inbound-acknowledgement";

/**
 * Admin surface for the inbound acknowledgement owner. "Enable transactional purpose" lives here and is distinct
 * from publishing message content and from activating any campaign or release. It never unpauses outbound.
 */
export function registerInboundAcknowledgementRoutes(app: Express) {
  if (getBackgroundProfile() !== "off") {
    startInboundAcknowledgementWorker();
  } else {
    console.log("[BackgroundProfile] off — InboundAcknowledgementWorker not started");
  }

  app.get("/api/admin/inbound-acknowledgements/status", requireRole("admin", "manager"), async (_req, res) => {
    try {
      const [capability, counts] = await Promise.all([getAckCapability(), getAcknowledgementStatusCounts()]);
      res.json({
        capability,
        counts,
        meaning: {
          blocked: "Request recorded; no email attempt is authorized yet.",
          accepted: "Accepted by the mail transport; not proof of inbox delivery.",
          uncertain: "Transport outcome unknown; never resent automatically.",
        },
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  const capabilitySchema = z.object({
    enabled: z.boolean(),
    sourceClasses: z.array(z.enum(ACK_SOURCE_CLASSES)).max(ACK_SOURCE_CLASSES.length).optional(),
    eligibleFrom: z.string().datetime().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  }).strict();

  app.post("/api/admin/inbound-acknowledgements/capability", requireRole("admin"), async (req, res) => {
    try {
      const body = capabilitySchema.parse(req.body);
      if (body.enabled && (!body.sourceClasses || body.sourceClasses.length === 0)) {
        return res.status(400).json({ message: "Choose at least one request type to enable." });
      }
      const actor = (req.user as { email?: string; id?: string } | undefined)?.email ?? (req.user as { id?: string } | undefined)?.id ?? "admin";
      const capability = await setAckCapability({
        enabled: body.enabled,
        sourceClasses: body.sourceClasses,
        eligibleFrom: body.eligibleFrom ? new Date(body.eligibleFrom) : undefined,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        actor,
      });
      res.json({ capability });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: err.errors[0].message });
      serverError(res, err);
    }
  });
}
