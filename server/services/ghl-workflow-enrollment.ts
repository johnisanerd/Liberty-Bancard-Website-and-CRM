/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ARCHITECTURE BOUNDARY — Replit Orchestrates, GHL Transports            ║
 * ║                                                                          ║
 * ║  Replit owns ALL sequence scheduling and gate-checking:                  ║
 * ║    • BullMQ ticks drive every step                                       ║
 * ║    • Contactability, daily-cap, DNC, quiet-hours guards run in Replit    ║
 * ║    • Step advancement (currentStep++) happens in sequence-worker.ts      ║
 * ║                                                                          ║
 * ║  GHL is a TRANSPORT layer only:                                          ║
 * ║    • sendGhlEmail / sendGhlSms — deliver a message Replit composed       ║
 * ║    • upsertGhlContact          — keep CRM contact record in sync         ║
 * ║    • addTag / addNote          — label contact for inbox organisation     ║
 * ║                                                                          ║
 * ║  The ONE allowed GHL workflow trigger is GHL_WORKFLOW_INBOUND_CONFIRMATION║
 * ║  (see enrollInInboundConfirmation below). It fires on inbound web-form   ║
 * ║  submissions to deliver an instant transactional confirmation email.     ║
 * ║  GHL is used here because the confirmation must be immediate and does    ║
 * ║  not depend on Replit's BullMQ tick cadence. GHL does NOT drive any     ║
 * ║  follow-on sequence steps; Replit enrolls those separately.             ║
 * ║                                                                          ║
 * ║  enrollContactInGhlWorkflow() NEVER triggers a GHL workflow. It syncs   ║
 * ║  the contact to GHL (upsert + tags + note) and returns method:          ║
 * ║  "replit_direct" so sequence-worker can proceed with BullMQ-scheduled   ║
 * ║  steps. GHL_DEFAULT_WORKFLOW_ID and per-sequence env vars are ignored   ║
 * ║  for outbound sequences.                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { storage } from "../storage";
import { isGhlConfigured, upsertGhlContact, sendGhlEmail, sendGhlSms, getCalendarBookingUrl } from "./ghl";
import {
  triggerWorkflow, addTag, addNote, isSdrGhlConfigured,
  upsertContact as sdrUpsertContact,
  sendEmailReply as sdrSendEmail,
  sendSmsReply as sdrSendSms,
} from "./sdr/ghl-client";
import { createPreferenceAwareNotification } from "./digest-service";
import { getWorkflowEnvValue } from "./ghl-workflows";
import { sendSmtpEmail, isSmtpConfigured } from "./smtp-email";
import { denyCro03OrCro08aForbiddenEffect as denyCro03cForbiddenEffect } from "./cro03/cro08a-effect-fence";

const SALES_CALENDAR = "https://api.leadconnectorhq.com/widget/bookings/libertybancard";
const AM_CALENDAR = "https://api.leadconnectorhq.com/widget/booking/kBRoNz5XoTpddupMQg0c";

export function isGhlInboundActive(): boolean {
  return isGhlConfigured() || isSdrGhlConfigured();
}

async function unifiedUpsertContact(contact: { id: number; ghlContactId?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; companyName?: string | null; vertical?: string | null }): Promise<string | null> {
  if (isGhlConfigured()) {
    return upsertGhlContact({
      id: contact.id,
      firstName: contact.firstName ?? "",
      lastName: contact.lastName ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      ghlContactId: contact.ghlContactId ?? null,
      companyName: contact.companyName ?? undefined,
      vertical: contact.vertical ?? undefined,
    });
  }
  if (isSdrGhlConfigured()) {
    return sdrUpsertContact({
      firstName: contact.firstName || undefined,
      lastName: contact.lastName || undefined,
      email: contact.email || undefined,
      phone: contact.phone || undefined,
      companyName: contact.companyName || undefined,
      existingGhlId: contact.ghlContactId || undefined,
    });
  }
  return null;
}

async function unifiedSendEmail(params: {
  contactId: number;
  ghlContactId: string;
  subject: string;
  body: string;
  fromEmail?: string;
  fromName?: string;
}): Promise<void> {
  if (isGhlConfigured()) {
    await sendGhlEmail({ contactId: params.contactId, subject: params.subject, body: params.body, fromEmail: params.fromEmail, fromName: params.fromName, commercialPurpose: "transactional_response" });
    return;
  }
  if (isSdrGhlConfigured()) {
    await sdrSendEmail({ contactId: params.ghlContactId, dbContactId: params.contactId, commercialPurpose: "transactional_response", subject: params.subject, htmlBody: params.body, fromEmail: params.fromEmail, fromName: params.fromName });
    return;
  }
  throw new Error("No GHL client configured for sending email");
}

async function unifiedSendSms(params: { contactId: number; ghlContactId: string; body: string; inboundRequestId?: string }): Promise<void> {
  if (isGhlConfigured()) {
    await sendGhlSms({
      contactId: params.contactId, body: params.body, commercialPurpose: "transactional_response",
      inboundRequestId: params.inboundRequestId, intendedRecipientContactId: params.contactId,
    });
    return;
  }
  if (isSdrGhlConfigured()) {
    await sdrSendSms({ contactId: params.ghlContactId, dbContactId: params.contactId, commercialPurpose: "transactional_response", inboundRequestId: params.inboundRequestId, intendedRecipientContactId: params.contactId, message: params.body });
    return;
  }
  throw new Error("No GHL client configured for sending SMS");
}

type ConfirmationEmailResult =
  | { sent: true; provider: "ghl_direct" | "smtp"; providerMessageId?: string | null }
  | { sent: false; providerAttempts: Array<{ provider: "ghl_direct" | "smtp"; error: string }>; reason: string };

/**
 * Explicit, typed outcome of `enrollInInboundConfirmation`.
 *
 * The `status` field is the single source of truth for how the confirmation
 * was delivered — callers MUST consume this and MUST NOT infer delivery from
 * config/contact state or the mere fact that the Promise resolved.
 *
 *   "enrolled"        — native GHL workflow trigger succeeded.
 *   "sent"            — direct provider (GHL direct or SMTP) delivered the email.
 *   "skipped"         — a prerequisite was missing (e.g. no email); no error.
 *   "not_configured"  — neither a native workflow nor any direct provider was
 *                       usable, so nothing was attempted.
 *   "failed"          — an explicit delivery failure occurred (all providers
 *                       failed) — no confirmation was delivered.
 *   "unknown"         — no branch produced a definitive outcome (should not
 *                       normally happen; treated as a non-success by callers).
 *
 * `channel` records which mechanism produced the outcome where relevant.
 */
export type InboundConfirmationOutcome =
  | { status: "enrolled";       channel: "ghl_workflow"; ghlWorkflowId: string; ghlContactId: string }
  | { status: "sent";           channel: "ghl_direct" | "smtp"; providerMessageId?: string | null }
  | { status: "skipped";        reason: string }
  | { status: "not_configured"; reason: string }
  | { status: "failed";         reason: string; providerAttempts?: Array<{ provider: "ghl_direct" | "smtp"; error: string }> }
  | { status: "unknown" };

/**
 * Provider-independent confirmation email delivery.
 * Tries GHL direct first (when available + contact ID present), then SMTP.
 * Returns a typed result. NEVER writes to the database — audit logging and
 * queue scheduling belong in the caller (sendInboundConfirmation).
 */
async function sendConfirmationEmail(params: {
  contactId: number;
  ghlContactId?: string | null;
  email: string;
  subject: string;
  body: string;
  inboundRequestId?: string;
}): Promise<ConfirmationEmailResult> {
  const providerAttempts: Array<{ provider: "ghl_direct" | "smtp"; error: string }> = [];

  // Provider 1: GHL direct (requires GHL configured AND a GHL contact ID)
  if ((isGhlConfigured() || isSdrGhlConfigured()) && params.ghlContactId) {
    try {
      if (isGhlConfigured()) {
        const result = await sendGhlEmail({
          contactId: params.contactId,
          subject: params.subject,
          body: params.body,
          commercialPurpose: "transactional_response",
          inboundRequestId: params.inboundRequestId,
          intendedRecipientContactId: params.contactId,
          skipActivityLog: true, // deliver-only: caller (enrollInInboundConfirmation) owns all audit writes
        });
        if (result.success) {
          return { sent: true, provider: "ghl_direct", providerMessageId: result.messageId ?? null };
        }
        providerAttempts.push({ provider: "ghl_direct", error: result.error || "GHL direct send failed" });
      } else {
        // SDR GHL client (no return value)
        await sdrSendEmail({ contactId: params.ghlContactId, dbContactId: params.contactId, commercialPurpose: "transactional_response", inboundRequestId: params.inboundRequestId, intendedRecipientContactId: params.contactId, subject: params.subject, htmlBody: params.body });
        return { sent: true, provider: "ghl_direct" };
      }
    } catch (err: any) {
      providerAttempts.push({ provider: "ghl_direct", error: err.message ?? "Unknown GHL error" });
    }
  }

  // Provider 2: SMTP (contact.email used directly, no GHL contact ID required)
  if (isSmtpConfigured()) {
    try {
      const result = await sendSmtpEmail({ to: params.email, subject: params.subject, html: params.body, category: "accounts", contactId: params.contactId, commercialPurpose: "transactional_response", inboundRequestId: params.inboundRequestId, intendedRecipientContactId: params.contactId });
      if (result.success) {
        return { sent: true, provider: "smtp", providerMessageId: result.messageId ?? null };
      }
      providerAttempts.push({ provider: "smtp", error: result.error || "SMTP send returned failure" });
    } catch (err: any) {
      providerAttempts.push({ provider: "smtp", error: err.message ?? "Unknown SMTP error" });
    }
  } else {
    providerAttempts.push({ provider: "smtp", error: "SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)" });
  }

  const reason =
    providerAttempts.length === 0
      ? "No delivery provider available (GHL not configured or missing contact ID, SMTP not configured)"
      : `All providers failed: ${providerAttempts.map((a) => `${a.provider}: ${a.error}`).join("; ")}`;

  return { sent: false, providerAttempts, reason };
}

export interface GhlWorkflowMapping {
  sequenceName: string;
  ghlWorkflowId: string | null;
  category: string;
  vertical: string;
  inboxLabel: string;
  inboxTags: string[];
}

const SEQUENCE_WORKFLOW_MAP: Record<string, GhlWorkflowMapping> = {
  "1. Switch & Save — Statement Audit": { sequenceName: "1. Switch & Save — Statement Audit", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Statement Audit", inboxTags: ["LB-SDR", "LB-SEQ-STATEMENT-AUDIT"] },
  "2. Payment Stack 101 — Education": { sequenceName: "2. Payment Stack 101 — Education", ghlWorkflowId: null, category: "education", vertical: "all", inboxLabel: "SDR: Education", inboxTags: ["LB-SDR", "LB-SEQ-EDUCATION"] },
  "3. Fast Approval — Application Completion": { sequenceName: "3. Fast Approval — Application Completion", ghlWorkflowId: null, category: "onboarding", vertical: "all", inboxLabel: "SDR: Application", inboxTags: ["LB-SDR", "LB-SEQ-APPLICATION"] },
  "4. Trust Builder — Authority Sequence": { sequenceName: "4. Trust Builder — Authority Sequence", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Trust Builder", inboxTags: ["LB-SDR", "LB-SEQ-TRUST-BUILDER"] },
  "5. Chargeback Defense": { sequenceName: "5. Chargeback Defense", ghlWorkflowId: null, category: "risk", vertical: "all", inboxLabel: "SDR: Chargeback", inboxTags: ["LB-SDR", "LB-SEQ-CHARGEBACK"] },
  "6. Funding Speed & Reliability": { sequenceName: "6. Funding Speed & Reliability", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Funding", inboxTags: ["LB-SDR", "LB-SEQ-FUNDING"] },
  "8. Liberty Smart Terminal — Product Showcase": { sequenceName: "8. Liberty Smart Terminal — Product Showcase", ghlWorkflowId: null, category: "hardware", vertical: "all", inboxLabel: "SDR: Terminal", inboxTags: ["LB-SDR", "LB-SEQ-TERMINAL"] },
  "9. Surcharge & Cash Discount — Compliance": { sequenceName: "9. Surcharge & Cash Discount — Compliance", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Surcharge", inboxTags: ["LB-SDR", "LB-SEQ-SURCHARGE"] },
  "10. Retail Merchants — SDR Outbound + Drip": { sequenceName: "10. Retail Merchants — SDR Outbound + Drip", ghlWorkflowId: null, category: "sdr_outbound", vertical: "retail", inboxLabel: "SDR: Retail Outbound", inboxTags: ["LB-SDR", "LB-RETAIL", "LB-SEQ-RETAIL-SDR"] },
  "11. Auto Merchants — SDR Outbound + Drip": { sequenceName: "11. Auto Merchants — SDR Outbound + Drip", ghlWorkflowId: null, category: "sdr_outbound", vertical: "auto", inboxLabel: "SDR: Auto Outbound", inboxTags: ["LB-SDR", "LB-AUTO", "LB-SEQ-AUTO-SDR"] },
  "12. Medical & Med Spa — SDR Outbound + Drip": { sequenceName: "12. Medical & Med Spa — SDR Outbound + Drip", ghlWorkflowId: null, category: "sdr_outbound", vertical: "medical", inboxLabel: "SDR: Medical Outbound", inboxTags: ["LB-SDR", "LB-MEDSPA", "LB-SEQ-MEDICAL-SDR"] },
  "13. Recurring Billing — Subscription Merchants": { sequenceName: "13. Recurring Billing — Subscription Merchants", ghlWorkflowId: null, category: "sales", vertical: "subscription", inboxLabel: "SDR: Recurring", inboxTags: ["LB-SDR", "LB-SEQ-RECURRING"] },
  "15. Omnichannel — Online + In-Person": { sequenceName: "15. Omnichannel — Online + In-Person", ghlWorkflowId: null, category: "sales", vertical: "omnichannel", inboxLabel: "SDR: Omnichannel", inboxTags: ["LB-SDR", "LB-SEQ-OMNICHANNEL"] },
  "16. Security & PCI Compliance — Made Easy": { sequenceName: "16. Security & PCI Compliance — Made Easy", ghlWorkflowId: null, category: "education", vertical: "all", inboxLabel: "SDR: PCI", inboxTags: ["LB-SDR", "LB-SEQ-PCI"] },
  "17. Contract Escape — Switch Help": { sequenceName: "17. Contract Escape — Switch Help", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Contract Escape", inboxTags: ["LB-SDR", "LB-SEQ-CONTRACT-ESCAPE"] },
  "18. Objection Crusher — Overcome Hesitation": { sequenceName: "18. Objection Crusher — Overcome Hesitation", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Objections", inboxTags: ["LB-SDR", "LB-SEQ-OBJECTION-CRUSHER"] },
  "19. Reactivation — Cold Lead Revival": { sequenceName: "19. Reactivation — Cold Lead Revival", ghlWorkflowId: null, category: "reactivation", vertical: "all", inboxLabel: "SDR: Reactivation", inboxTags: ["LB-SDR", "LB-SEQ-REACTIVATION"] },
  "20. Free Analysis Follow-Up": { sequenceName: "20. Free Analysis Follow-Up", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Analysis Follow-Up", inboxTags: ["LB-SDR", "LB-SEQ-ANALYSIS-FOLLOWUP"] },
  "Post-Call Review Follow-Up": { sequenceName: "Post-Call Review Follow-Up", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Post-Call", inboxTags: ["LB-SDR", "LB-SEQ-POST-CALL"] },
  "Proposal Follow-Up": { sequenceName: "Proposal Follow-Up", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: Proposal", inboxTags: ["LB-SDR", "LB-SEQ-PROPOSAL"] },
  "No-Show Reschedule": { sequenceName: "No-Show Reschedule", ghlWorkflowId: null, category: "sales", vertical: "all", inboxLabel: "SDR: No-Show", inboxTags: ["LB-SDR", "LB-SEQ-NOSHOW"] },
  "Long-Term Nurture": { sequenceName: "Long-Term Nurture", ghlWorkflowId: null, category: "nurture", vertical: "all", inboxLabel: "SDR: Nurture", inboxTags: ["LB-SDR", "LB-SEQ-NURTURE"] },
  "SDR: Cold Outbound — Auto Repair": { sequenceName: "SDR: Cold Outbound — Auto Repair", ghlWorkflowId: null, category: "sdr_cold_outbound", vertical: "Auto Repair", inboxLabel: "SDR: Cold Auto", inboxTags: ["LB-SDR", "LB-AUTO", "LB-SEQ-COLD-AUTO"] },
  "SDR: Cold Outbound — Med Spa": { sequenceName: "SDR: Cold Outbound — Med Spa", ghlWorkflowId: null, category: "sdr_cold_outbound", vertical: "Med Spa", inboxLabel: "SDR: Cold MedSpa", inboxTags: ["LB-SDR", "LB-MEDSPA", "LB-SEQ-COLD-MEDSPA"] },
  "SDR: Cold Outbound — Dental": { sequenceName: "SDR: Cold Outbound — Dental", ghlWorkflowId: null, category: "sdr_cold_outbound", vertical: "Dental", inboxLabel: "SDR: Cold Dental", inboxTags: ["LB-SDR", "LB-DENTAL", "LB-SEQ-COLD-DENTAL"] },
  "SDR: Cold Outbound — Construction": { sequenceName: "SDR: Cold Outbound — Construction", ghlWorkflowId: null, category: "sdr_cold_outbound", vertical: "Construction", inboxLabel: "SDR: Cold Construction", inboxTags: ["LB-SDR", "LB-SDR-CONSTRUCTION", "LB-SEQ-COLD-CONSTRUCTION"] },
  "SDR: Reply Engaged": { sequenceName: "SDR: Reply Engaged", ghlWorkflowId: null, category: "sdr_reply_engaged", vertical: "all", inboxLabel: "SDR: Reply Engaged", inboxTags: ["LB-SDR", "LB-SEQ-REPLY-ENGAGED"] },
  "SDR: Statement Chase": { sequenceName: "SDR: Statement Chase", ghlWorkflowId: null, category: "sdr_statement_chase", vertical: "all", inboxLabel: "SDR: Statement Chase", inboxTags: ["LB-SDR", "LB-STATEMENT-PENDING", "LB-SEQ-STATEMENT-CHASE"] },
  "SDR: Proposal Follow-Up": { sequenceName: "SDR: Proposal Follow-Up", ghlWorkflowId: null, category: "sdr_proposal_followup", vertical: "all", inboxLabel: "SDR: Proposal FU", inboxTags: ["LB-SDR", "LB-PROPOSAL-SENT", "LB-SEQ-PROPOSAL-FU"] },
  "SDR: No-Show Recovery": { sequenceName: "SDR: No-Show Recovery", ghlWorkflowId: null, category: "sdr_noshow_recovery", vertical: "all", inboxLabel: "SDR: No-Show", inboxTags: ["LB-SDR", "LB-SEQ-NOSHOW-RECOVERY"] },
  "V-Retail: SDR Outbound Prospecting": { sequenceName: "V-Retail: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "retail", inboxLabel: "SDR: V-Retail", inboxTags: ["LB-SDR", "LB-RETAIL", "LB-SEQ-V-RETAIL-SDR"] },
  "V-Retail: Inbound Lead Nurture": { sequenceName: "V-Retail: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "retail", inboxLabel: "Inbound: Retail", inboxTags: ["LB-SDR", "LB-RETAIL", "LB-SEQ-V-RETAIL-INBOUND"] },
  "V-Retail: Account Management Ops": { sequenceName: "V-Retail: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "retail", inboxLabel: "Ops: Retail", inboxTags: ["LB-OPS", "LB-RETAIL"] },
  "V-Auto: SDR Outbound Prospecting": { sequenceName: "V-Auto: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "auto", inboxLabel: "SDR: V-Auto", inboxTags: ["LB-SDR", "LB-AUTO", "LB-SEQ-V-AUTO-SDR"] },
  "V-Auto: Inbound Lead Nurture": { sequenceName: "V-Auto: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "auto", inboxLabel: "Inbound: Auto", inboxTags: ["LB-SDR", "LB-AUTO", "LB-SEQ-V-AUTO-INBOUND"] },
  "V-Auto: Account Management Ops": { sequenceName: "V-Auto: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "auto", inboxLabel: "Ops: Auto", inboxTags: ["LB-OPS", "LB-AUTO"] },
  "V-Medical: SDR Outbound Prospecting": { sequenceName: "V-Medical: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "medical", inboxLabel: "SDR: V-Medical", inboxTags: ["LB-SDR", "LB-MEDICAL", "LB-SEQ-V-MEDICAL-SDR"] },
  "V-Medical: Inbound Lead Nurture": { sequenceName: "V-Medical: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "medical", inboxLabel: "Inbound: Medical", inboxTags: ["LB-SDR", "LB-MEDICAL", "LB-SEQ-V-MEDICAL-INBOUND"] },
  "V-Medical: Account Management Ops": { sequenceName: "V-Medical: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "medical", inboxLabel: "Ops: Medical", inboxTags: ["LB-OPS", "LB-MEDICAL"] },
  "V-Med Spa: SDR Outbound Prospecting": { sequenceName: "V-Med Spa: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "medspa", inboxLabel: "SDR: V-MedSpa", inboxTags: ["LB-SDR", "LB-MEDSPA", "LB-SEQ-V-MEDSPA-SDR"] },
  "V-Med Spa: Inbound Lead Nurture": { sequenceName: "V-Med Spa: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "medspa", inboxLabel: "Inbound: MedSpa", inboxTags: ["LB-SDR", "LB-MEDSPA", "LB-SEQ-V-MEDSPA-INBOUND"] },
  "V-Med Spa: Account Management Ops": { sequenceName: "V-Med Spa: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "medspa", inboxLabel: "Ops: MedSpa", inboxTags: ["LB-OPS", "LB-MEDSPA"] },
  "V-Dental: SDR Outbound Prospecting": { sequenceName: "V-Dental: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "dental", inboxLabel: "SDR: V-Dental", inboxTags: ["LB-SDR", "LB-DENTAL", "LB-SEQ-V-DENTAL-SDR"] },
  "V-Dental: Inbound Lead Nurture": { sequenceName: "V-Dental: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "dental", inboxLabel: "Inbound: Dental", inboxTags: ["LB-SDR", "LB-DENTAL", "LB-SEQ-V-DENTAL-INBOUND"] },
  "V-Dental: Account Management Ops": { sequenceName: "V-Dental: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "dental", inboxLabel: "Ops: Dental", inboxTags: ["LB-OPS", "LB-DENTAL"] },
  "V-Auto Repair: SDR Outbound Prospecting": { sequenceName: "V-Auto Repair: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "autorepair", inboxLabel: "SDR: V-AutoRepair", inboxTags: ["LB-SDR", "LB-AUTO", "LB-SEQ-V-AUTOREPAIR-SDR"] },
  "V-Auto Repair: Inbound Lead Nurture": { sequenceName: "V-Auto Repair: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "autorepair", inboxLabel: "Inbound: AutoRepair", inboxTags: ["LB-SDR", "LB-AUTO", "LB-SEQ-V-AUTOREPAIR-INBOUND"] },
  "V-Auto Repair: Account Management Ops": { sequenceName: "V-Auto Repair: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "autorepair", inboxLabel: "Ops: AutoRepair", inboxTags: ["LB-OPS", "LB-AUTO"] },
  "V-Salon: SDR Outbound Prospecting": { sequenceName: "V-Salon: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "salon", inboxLabel: "SDR: V-Salon", inboxTags: ["LB-SDR", "LB-SDR-SALON", "LB-SEQ-V-SALON-SDR"] },
  "V-Salon: Inbound Lead Nurture": { sequenceName: "V-Salon: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "salon", inboxLabel: "Inbound: Salon", inboxTags: ["LB-SDR", "LB-SDR-SALON", "LB-SEQ-V-SALON-INBOUND"] },
  "V-Salon: Account Management Ops": { sequenceName: "V-Salon: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "salon", inboxLabel: "Ops: Salon", inboxTags: ["LB-OPS", "LB-SDR-SALON"] },
  "V-Gym: SDR Outbound Prospecting": { sequenceName: "V-Gym: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "gym", inboxLabel: "SDR: V-Gym", inboxTags: ["LB-SDR", "LB-SDR-GYM", "LB-SEQ-V-GYM-SDR"] },
  "V-Gym: Inbound Lead Nurture": { sequenceName: "V-Gym: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "gym", inboxLabel: "Inbound: Gym", inboxTags: ["LB-SDR", "LB-SDR-GYM", "LB-SEQ-V-GYM-INBOUND"] },
  "V-Gym: Account Management Ops": { sequenceName: "V-Gym: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "gym", inboxLabel: "Ops: Gym", inboxTags: ["LB-OPS", "LB-SDR-GYM"] },
  "V-Hotel: SDR Outbound Prospecting": { sequenceName: "V-Hotel: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "hotel", inboxLabel: "SDR: V-Hotel", inboxTags: ["LB-SDR", "LB-SDR-HOTEL", "LB-SEQ-V-HOTEL-SDR"] },
  "V-Hotel: Inbound Lead Nurture": { sequenceName: "V-Hotel: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "hotel", inboxLabel: "Inbound: Hotel", inboxTags: ["LB-SDR", "LB-SDR-HOTEL", "LB-SEQ-V-HOTEL-INBOUND"] },
  "V-Hotel: Account Management Ops": { sequenceName: "V-Hotel: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "hotel", inboxLabel: "Ops: Hotel", inboxTags: ["LB-OPS", "LB-SDR-HOTEL"] },
  "V-Landscaping: SDR Outbound Prospecting": { sequenceName: "V-Landscaping: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "landscaping", inboxLabel: "SDR: V-Landscaping", inboxTags: ["LB-SDR", "LB-SDR-LANDSCAPING", "LB-SEQ-V-LANDSCAPING-SDR"] },
  "V-Landscaping: Inbound Lead Nurture": { sequenceName: "V-Landscaping: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "landscaping", inboxLabel: "Inbound: Landscaping", inboxTags: ["LB-SDR", "LB-SDR-LANDSCAPING", "LB-SEQ-V-LANDSCAPING-INBOUND"] },
  "V-Landscaping: Account Management Ops": { sequenceName: "V-Landscaping: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "landscaping", inboxLabel: "Ops: Landscaping", inboxTags: ["LB-OPS", "LB-SDR-LANDSCAPING"] },
  "V-Construction: SDR Outbound Prospecting": { sequenceName: "V-Construction: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "construction", inboxLabel: "SDR: V-Construction", inboxTags: ["LB-SDR", "LB-SDR-CONSTRUCTION", "LB-SEQ-V-CONSTRUCTION-SDR"] },
  "V-Construction: Inbound Lead Nurture": { sequenceName: "V-Construction: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "construction", inboxLabel: "Inbound: Construction", inboxTags: ["LB-SDR", "LB-SDR-CONSTRUCTION", "LB-SEQ-V-CONSTRUCTION-INBOUND"] },
  "V-Construction: Account Management Ops": { sequenceName: "V-Construction: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "construction", inboxLabel: "Ops: Construction", inboxTags: ["LB-OPS", "LB-SDR-CONSTRUCTION"] },
  "V-Legal: SDR Outbound Prospecting": { sequenceName: "V-Legal: SDR Outbound Prospecting", ghlWorkflowId: null, category: "sdr", vertical: "legal", inboxLabel: "SDR: V-Legal", inboxTags: ["LB-SDR", "LB-SDR-LEGAL", "LB-SEQ-V-LEGAL-SDR"] },
  "V-Legal: Inbound Lead Nurture": { sequenceName: "V-Legal: Inbound Lead Nurture", ghlWorkflowId: null, category: "inbound", vertical: "legal", inboxLabel: "Inbound: Legal", inboxTags: ["LB-SDR", "LB-SDR-LEGAL", "LB-SEQ-V-LEGAL-INBOUND"] },
  "V-Legal: Account Management Ops": { sequenceName: "V-Legal: Account Management Ops", ghlWorkflowId: null, category: "operations", vertical: "legal", inboxLabel: "Ops: Legal", inboxTags: ["LB-OPS", "LB-SDR-LEGAL"] },
};

const INBOX_SMART_LIST_TAGS = {
  activeSdr: "LB-SDR",
  replied: "LB-REPLIED",
  meetingSet: "LB-BOOKING-READY",
  statementPending: "LB-STATEMENT-PENDING",
  humanHandoff: "LB-HUMAN-HANDOFF",
  activePipeline: "LB-ACTIVE-PIPELINE",
} as const;

function resolveGhlWorkflowIdSync(sequenceName: string): string | null {
  const envKey = `GHL_WORKFLOW_${sequenceName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase()}`;
  if (process.env[envKey]) return process.env[envKey]!;
  const mapping = (SEQUENCE_WORKFLOW_MAP as any)[sequenceName];
  if (mapping?.ghlWorkflowId) return mapping.ghlWorkflowId;
  return process.env.GHL_DEFAULT_WORKFLOW_ID || null;
}

async function resolveGhlWorkflowId(sequenceName: string): Promise<string | null> {
  const envKey = `GHL_WORKFLOW_${sequenceName
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase()}`;

  const envValue = process.env[envKey];
  if (envValue) return envValue;

  try {
    const dbId = await storage.getGhlWorkflowIdBySequenceName(sequenceName);
    if (dbId) return dbId;
  } catch (err) {
    console.warn(`[GHL Enrollment] DB workflow ID lookup failed for "${sequenceName}":`, err);
  }

  const mapping = SEQUENCE_WORKFLOW_MAP[sequenceName];
  if (mapping?.ghlWorkflowId) return mapping.ghlWorkflowId;

  return process.env.GHL_DEFAULT_WORKFLOW_ID || null;
}

export function getVerticalTag(vertical: string | null | undefined): string {
  if (!vertical) return "LB-VERTICAL-GENERAL";
  const v = vertical.toLowerCase().trim();
  if (/auto|automotive|repair|collision|body shop|tire/i.test(v)) return "LB-AUTO";
  if (/med.?spa|medspa|aesthetic|botox|filler|laser/i.test(v)) return "LB-MEDSPA";
  if (/dental|dentist/i.test(v)) return "LB-DENTAL";
  if (/medical|healthcare|clinic|chiro|optom|podiatr/i.test(v)) return "LB-MEDICAL";
  if (/restaurant|food|bar|cafe|catering/i.test(v)) return "LB-RESTAURANT";
  if (/retail|shop|store|boutique/i.test(v)) return "LB-RETAIL";
  if (/\bsalon\b|hair salon|nail salon|beauty salon|barber|beauty parlor|cosmetolog/i.test(v)) return "LB-SDR-SALON";
  if (/\bgym\b|fitness|crossfit|yoga|pilates|martial arts|personal training|boxing|dance studio|wellness center/i.test(v)) return "LB-SDR-GYM";
  if (/\bhotel\b|motel|\binn\b|\blodge\b|\bresort\b|hospitality|bed and breakfast/i.test(v)) return "LB-SDR-HOTEL";
  if (/landscap|lawn care|lawn service|lawn mowing|tree service|tree trimm|grounds.?keep/i.test(v)) return "LB-SDR-LANDSCAPING";
  if (/\bconstruct|contractor|builder|roofer|roofing|plumb|electrician|electrical|hvac|remodel|renovati/i.test(v)) return "LB-SDR-CONSTRUCTION";
  if (/attorney|law firm|\blawyer\b|\blegal\b|solicitor|paralegal|notary/i.test(v)) return "LB-SDR-LEGAL";
  return "LB-VERTICAL-GENERAL";
}

export interface GhlEnrollmentResult {
  enrolled: boolean;
  method: "ghl_workflow" | "replit_direct" | "skipped";
  ghlWorkflowId?: string;
  reason?: string;
  contactGhlId?: string;
}

export async function enrollContactInGhlWorkflow(params: {
  contactId: number;
  sequenceName: string;
  sequenceId: number;
  vertical?: string;
  dealId?: number;
  /**
   * Channels this GHL workflow may trigger. The contactability gate is evaluated
   * for each channel; enrollment is blocked if ANY channel is blocked.
   *
   * When omitted, the gate evaluates ALL automated channels (email, sms, voice_ai,
   * ringless_vm) — failing closed. Callers that know their workflow is email-only
   * MUST pass ["email"] explicitly to avoid requiring PEWC unnecessarily.
   *
   * Providing ["email", "sms", "voice_ai", "ringless_vm"] explicitly is equivalent
   * to omitting the parameter (same fail-closed behavior).
   */
  outboundChannels?: Array<import("./contactability").ContactabilityChannel>;
}): Promise<GhlEnrollmentResult> {
  await denyCro03cForbiddenEffect("sequence_enrollment");
  const { contactId, sequenceName, sequenceId, vertical, dealId } = params;

  const contact = await storage.getContact(contactId);
  if (!contact) {
    return { enrolled: false, method: "skipped", reason: "Contact not found" };
  }

  if (contact.doNotContact) {
    return { enrolled: false, method: "skipped", reason: "Contact is on do-not-contact list" };
  }

  // Task #1956 Step 8: DBPR-family lineage exclusion for GHL workflow/sync eligibility.
  {
    const { evaluateContactDecisions } = await import("./contactability");
    const hygiene = await evaluateContactDecisions({ contactId, businessId: (contact as any).businessId ?? null });
    if (hygiene.dataHygiene.status === "blocked") {
      await storage.createAuditLog({
        action: "ghl_enrollment_blocked_data_hygiene",
        entityType: "contact",
        entityId: contactId,
        details: { sequenceName, sequenceId, reasonCodes: hygiene.dataHygiene.reasonCodes },
      }).catch(() => {});
      return { enrolled: false, method: "skipped", reason: hygiene.dataHygiene.reason ?? "Blocked by data-hygiene authority" };
    }
  }

  // Shared contactability gate — enforces doNotAutoContact, consentTier, PEWC,
  // Florida rule, quiet hours, and channel-specific opt-outs.
  // Evaluates ALL channels that this workflow may trigger (provided by the caller
  // via outboundChannels). If ANY channel is blocked, enrollment is blocked.
  // Defaults to ["email"] for backward compatibility, but callers should specify
  // all channels the workflow triggers so PEWC enforcement works correctly for
  // SMS / voice AI / ringless VM paths.
  {
    const { evaluateContactability } = await import("./contactability");
    // Fail-closed default: when caller does not specify channels, treat the workflow
    // as if it may trigger ALL automated channels (email + SMS + voice AI + ringless VM).
    // This prevents enrolling contacts that lack PEWC into workflows that could
    // trigger automated phone/SMS outreach. Callers that are certain their workflow
    // is email-only MUST pass outboundChannels: ["email"] explicitly.
    // Fail-safe default: when caller does not declare outboundChannels, evaluate
    // only "email" so cold contacts are not rejected for missing SMS/voice consent.
    // Sequences that intentionally gate on SMS or voice MUST pass those channels
    // explicitly in triggerConfig.outboundChannels — a console.warn fires to remind
    // operators when the field is absent on a sequence that contains SMS/voice steps.
    if (params.outboundChannels === undefined) {
      console.warn(
        `[GHL Enrollment] outboundChannels not declared for sequence "${sequenceName}" (id ${sequenceId}). ` +
        `Defaulting to ["email"]. Set triggerConfig.outboundChannels in the sequence to suppress this warning.`
      );
    }
    const channelsToCheck: Array<import("./contactability").ContactabilityChannel> =
      params.outboundChannels ?? ["email"];

    for (const ch of channelsToCheck) {
      const contactabilityCheck = await evaluateContactability({
        contactId,
        channel: ch,
        campaignType: "ghl_workflow_enrollment",
        mode: "enforcement",
      });
      if (!contactabilityCheck.allowed) {
        await storage.createAuditLog({
          action: "ghl_enrollment_blocked_contactability",
          entityType: "contact",
          entityId: contactId,
          details: {
            sequenceName,
            sequenceId,
            channel: ch,
            channelsChecked: channelsToCheck,
            reason: contactabilityCheck.reason,
            consentTier: contactabilityCheck.consentTier,
          },
        }).catch(() => {});
        return { enrolled: false, method: "skipped", reason: contactabilityCheck.reason };
      }
    }
  }

  const contactTags = contact.tags || [];
  if (contactTags.includes(INBOX_SMART_LIST_TAGS.activePipeline)) {
    return { enrolled: false, method: "skipped", reason: "Contact has LB-ACTIVE-PIPELINE tag — excluded from SDR enrollment" };
  }

  if (!isGhlConfigured() && !isSdrGhlConfigured()) {
    return { enrolled: false, method: "replit_direct", reason: "GHL not configured — falling back to Replit direct sends" };
  }

  let ghlContactId = contact.ghlContactId;
  if (!ghlContactId) {
    console.warn(`[GHL Enrollment] GUARD: Contact ${contactId} (${contact.firstName} ${contact.lastName}) has no GHL contact ID — blocking enrollment for sequence "${sequenceName}". Attempting auto-upsert to GHL first.`);
    try {
      ghlContactId = await unifiedUpsertContact(contact);
      if (ghlContactId) {
        await storage.updateContact(contactId, { ghlContactId });
        console.log(`[GHL Enrollment] Auto-upsert succeeded for contact ${contactId} — GHL ID: ${ghlContactId}. Retrying enrollment.`);
      }
    } catch (err) {
      console.error(`[GHL Enrollment] Auto-upsert FAILED for contact ${contactId}:`, err);
      await storage.createAuditLog({
        action: "ghl_enrollment_blocked",
        entityType: "contact",
        entityId: contactId,
        details: { sequenceName, sequenceId, reason: "ghl_upsert_failed" },
      }).catch(() => {});
      return { enrolled: false, method: "replit_direct", reason: "Failed to create GHL contact — enrollment blocked until GHL ID is confirmed" };
    }
  }

  if (!ghlContactId) {
    console.warn(`[GHL Enrollment] BLOCKED: Contact ${contactId} still has no GHL contact ID after upsert attempt — enrollment in "${sequenceName}" is blocked.`);
    await storage.createAuditLog({
      action: "ghl_enrollment_blocked",
      entityType: "contact",
      entityId: contactId,
      details: { sequenceName, sequenceId, reason: "no_ghl_contact_id" },
    }).catch(() => {});
    return { enrolled: false, method: "replit_direct", reason: "No confirmed GHL contact ID — enrollment blocked" };
  }

  const mapping = SEQUENCE_WORKFLOW_MAP[sequenceName];
  const inboxTags = mapping?.inboxTags || ["LB-SDR"];
  const verticalTag = getVerticalTag(vertical || mapping?.vertical);

  const allTags = [
    ...new Set([
      ...inboxTags,
      verticalTag,
      `LB-SEQ-ACTIVE`,
      INBOX_SMART_LIST_TAGS.activeSdr,
    ]),
  ];

  try {
    await addTag({ contactId: ghlContactId, tags: allTags });
  } catch (tagErr) {
    console.warn(`[GHL Enrollment] Failed to add tags for contact ${ghlContactId}:`, tagErr);
  }

  try {
    const noteBody = `Enrolled in sequence: ${sequenceName}\nCategory: ${mapping?.category || "unknown"}\nVertical: ${vertical || mapping?.vertical || "all"}\nReplit Sequence ID: ${sequenceId}\n${dealId ? `Deal ID: ${dealId}` : ""}`;
    await addNote({ contactId: ghlContactId, body: noteBody });
  } catch (noteErr) {
    console.warn(`[GHL Enrollment] Failed to add note for contact ${ghlContactId}:`, noteErr);
  }

  // ── Architecture boundary: Replit orchestrates, GHL transports ────────────
  // This function intentionally does NOT trigger any GHL workflow for outbound
  // sequences. After syncing the contact to GHL (upsert + tags + note above),
  // control always returns to Replit's BullMQ-scheduled sequence-worker, which
  // owns every step decision, timing, and gate check.
  //
  // GHL workflow IDs (GHL_DEFAULT_WORKFLOW_ID, per-sequence env vars, DB entries)
  // are deliberately NOT resolved or used here. Triggering a GHL workflow would
  // hand orchestration authority to GHL, bypassing Replit's contactability gates,
  // daily-cap enforcement, and step tracking — creating a compliance blind spot.
  //
  // The ONE allowed GHL workflow trigger is GHL_WORKFLOW_INBOUND_CONFIRMATION,
  // which lives in enrollInInboundConfirmation() below. That trigger is
  // transactional (not a drip sequence), fires once on inbound form submission,
  // and does not drive any follow-on sequence steps.
  return {
    enrolled: false,
    method: "replit_direct",
    reason: "Replit direct sends — sequence orchestrated locally via BullMQ; GHL is transport only",
    contactGhlId: ghlContactId,
  };
}

/**
 * Injectable provider overrides for `enrollInInboundConfirmation`.
 * All fields are optional — real implementations are used for any field not provided.
 * @internal Production code never passes this. Used exclusively in test scripts
 *           to exercise real routing logic without live DB / GHL / SMTP / BullMQ.
 */
export interface InboundConfirmationTestOverrides {
  /** Pre-fetched contact — skips `storage.getContact()` DB call. */
  contact?: Record<string, any> | null;
  /** Override GHL availability (replaces `isGhlConfigured() || isSdrGhlConfigured()`). */
  ghlAvailable?: boolean;
  /** Override inbound workflow ID lookup (replaces `getWorkflowEnvValue()`). */
  inboundWorkflowId?: string | null;
  /** Override GHL contact upsert. */
  upsertGhlContact?: (contact: any) => Promise<string | null>;
  /** Override GHL tag addition. */
  addGhlTags?: (params: { contactId: string; tags: string[] }) => Promise<void>;
  /** Override GHL workflow trigger. */
  triggerGhlWorkflow?: (params: { workflowId: string; contactId: string; metadata: any }) => Promise<void>;
  /** Override email send (replaces `sendConfirmationEmail()`). */
  sendEmail?: (params: { contactId: number; ghlContactId: string | null; email: string; subject: string; body: string }) => Promise<ConfirmationEmailResult>;
  /** Override SMS send. */
  sendSms?: (params: { contactId: number; ghlContactId: string; body: string }) => Promise<void>;
  /** Override audit log write (replaces `storage.createAuditLog()`). */
  writeAuditLog?: (entry: { action: string; entityType: string; entityId: number; details: any }) => Promise<void>;
  /** Override BullMQ job scheduling. */
  scheduleFollowup?: (jobId: string, data: any, opts: any) => Promise<void>;
}

export async function enrollInInboundConfirmation(params: {
  contactId: number;
  formType: string;
  dealId?: number;
  /** Stable identifier for this form submission — used as the BullMQ dedup jobId.
   *  Route callers must pass `${contactId}-${formType}-${dealId}` so the same
   *  logical submission always produces the same jobId even if retried. */
  submissionId?: string;
  /** @internal Test-only injectable overrides. Never pass in production. */
  _testOverrides?: InboundConfirmationTestOverrides;
}): Promise<InboundConfirmationOutcome> {
  const { contactId, formType, dealId, _testOverrides: ov } = params;

  // ── Fetch contact (real or injected) ───────────────────────────────────────
  const contact = (ov?.contact !== undefined ? ov.contact : await storage.getContact(contactId)) as (Awaited<ReturnType<typeof storage.getContact>> | null);
  if (!contact) return { status: "skipped", reason: "contact_not_found" };

  const submissionId = params.submissionId ?? `${contactId}-${formType}-${dealId ?? "nd"}`;

  const bookingLink =
    getCalendarBookingUrl({
      contactEmail: contact.email ?? undefined,
      contactName: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim(),
      source: formType,
    }) || SALES_CALENDAR;

  // ── Resolve config values (real or injected) ────────────────────────────────
  const inboundWorkflowId = ov?.inboundWorkflowId !== undefined
    ? ov.inboundWorkflowId
    : await getWorkflowEnvValue("GHL_WORKFLOW_INBOUND_CONFIRMATION");

  const ghlAvailable = ov?.ghlAvailable !== undefined
    ? ov.ghlAvailable
    : (isGhlConfigured() || isSdrGhlConfigured());

  // Injected audit log writer (default: real storage)
  const writeAuditLog = ov?.writeAuditLog
    ?? ((entry: Parameters<typeof storage.createAuditLog>[0]) => storage.createAuditLog(entry).catch(() => {}));

  // ── Path 1: GHL workflow trigger ────────────────────────────────────────────
  if (inboundWorkflowId && ghlAvailable) {
    let ghlContactId = contact.ghlContactId as string | null | undefined;
    if (!ghlContactId) {
      try {
        ghlContactId = ov?.upsertGhlContact
          ? await ov.upsertGhlContact(contact)
          : await unifiedUpsertContact(contact);
      } catch (err) {
        console.error(`[GHL Inbound] Failed to upsert contact for inbound confirmation:`, err);
      }
    }

    if (ghlContactId) {
      try {
        const tagsToAdd = ["LB-INBOUND", `LB-FORM-${formType.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`, getVerticalTag(contact.vertical)];
        if (ov?.addGhlTags) {
          await ov.addGhlTags({ contactId: ghlContactId, tags: tagsToAdd });
        } else {
          await addTag({ contactId: ghlContactId, tags: tagsToAdd });
        }

        const workflowParams = {
          workflowId: inboundWorkflowId,
          contactId: ghlContactId,
          metadata: { formType, contactId, dealId, firstName: contact.firstName, companyName: contact.companyName, vertical: contact.vertical, source: "website_form", bookingLink },
        };
        if (ov?.triggerGhlWorkflow) {
          await ov.triggerGhlWorkflow(workflowParams);
        } else {
          await triggerWorkflow(workflowParams);
        }

        await writeAuditLog({
          action: "ghl_inbound_confirmation_enrolled",
          entityType: "contact",
          entityId: contactId,
          details: { formType, ghlWorkflowId: inboundWorkflowId, ghlContactId, submissionId },
        });

        console.log(`[GHL Inbound] Contact ${contactId} enrolled in inbound confirmation workflow`);
        // GHL workflow takes over — no direct email.
        return { status: "enrolled", channel: "ghl_workflow", ghlWorkflowId: inboundWorkflowId, ghlContactId };
      } catch (err) {
        console.error(`[GHL Inbound] Workflow trigger failed, falling back to direct sends:`, err);
      }
    }
  }

  // ── Path 2: Provider-independent direct email (GHL direct → SMTP) ──────────
  // Best-effort GHL contact upsert for sync purposes (only for GHL direct path).
  // Never blocks SMTP delivery — SMTP uses contact.email directly.
  let fallbackGhlContactId = contact.ghlContactId as string | null | undefined;
  if (!fallbackGhlContactId && ghlAvailable) {
    try {
      fallbackGhlContactId = ov?.upsertGhlContact
        ? await ov.upsertGhlContact(contact)
        : await unifiedUpsertContact(contact);
    } catch (err) {
      console.error(`[GHL Inbound] Best-effort GHL upsert failed (SMTP path will proceed):`, err);
    }
  }

  if (!contact.email) {
    // "skipped" (not "failed") — we lack the prerequisite, not a provider error.
    // Callback submissions commonly arrive with no email; this is expected.
    await writeAuditLog({
      action: "inbound_confirmation_skipped",
      entityType: "contact",
      entityId: contactId,
      details: { formType, dealId: dealId ?? null, submissionId, reason: "no_email" },
    });
    console.warn(`[GHL Inbound] Contact ${contactId} has no email — confirmation skipped (no_email)`);
    return { status: "skipped", reason: "no_email" };
  }

  // ── "not_configured": no native workflow enrolled (Path 1 did not return) and
  //     no direct provider (GHL direct or SMTP) usable → nothing can be attempted.
  //     GHL direct requires a GHL contact ID; SMTP requires SMTP configured.
  const smtpUsable = ov?.sendEmail !== undefined ? true : isSmtpConfigured();
  const ghlDirectUsable = ghlAvailable && !!fallbackGhlContactId;
  if (!smtpUsable && !ghlDirectUsable) {
    const reason = "no_delivery_channel";
    await writeAuditLog({
      action: "inbound_confirmation_skipped",
      entityType: "contact",
      entityId: contactId,
      details: { formType, dealId: dealId ?? null, submissionId, reason },
    });
    console.warn(`[GHL Inbound] Contact ${contactId} — no delivery channel configured (not_configured)`);
    return { status: "not_configured", reason };
  }

  const sendEmailImpl = ov?.sendEmail ?? sendConfirmationEmail;
  const emailResult = await sendEmailImpl({
    contactId,
    ghlContactId: fallbackGhlContactId ?? null,
    email: contact.email,
    subject: `Thanks for reaching out, ${contact.firstName}!`,
    body: buildInboundConfirmationEmail(
      contact.firstName || "there",
      contact.companyName || "your business",
      formType,
      bookingLink,
    ),
    inboundRequestId: submissionId,
  });

  if (emailResult.sent) {
    await writeAuditLog({
      action: "inbound_confirmation_sent",
      entityType: "contact",
      entityId: contactId,
      details: {
        provider: emailResult.provider,
        recipient: contact.email,
        providerMessageId: emailResult.providerMessageId ?? null,
        formType,
        dealId: dealId ?? null,
        submissionId,
      },
    });
    console.log(`[GHL Inbound] Confirmation sent via ${emailResult.provider} to contact ${contactId}`);
  } else {
    await writeAuditLog({
      action: "inbound_confirmation_failed",
      entityType: "contact",
      entityId: contactId,
      details: {
        providerAttempts: emailResult.providerAttempts,
        reason: emailResult.reason,
        formType,
        dealId: dealId ?? null,
        submissionId,
      },
    });
    console.error(`[GHL Inbound] All providers failed for contact ${contactId} — no follow-up scheduled`);
    // no follow-up on failed delivery
    return { status: "failed", reason: emailResult.reason, providerAttempts: emailResult.providerAttempts };
  }

  // Direct provider delivered the email — capture the definitive outcome. SMS and
  // the durable follow-up below are best-effort side effects that never change it.
  const deliveredOutcome: InboundConfirmationOutcome = {
    status: "sent",
    channel: emailResult.provider,
    providerMessageId: emailResult.providerMessageId ?? null,
  };

  // ── SMS (optional, non-blocking) ────────────────────────────────────────────
  if (contact.consentSms && contact.phone && fallbackGhlContactId && ghlAvailable) {
    try {
      const smsParams = {
        contactId,
        ghlContactId: fallbackGhlContactId,
        body: `Hi ${contact.firstName}, thanks for connecting with Liberty Bancard! We'll review your info and follow up soon. Book a call anytime: ${bookingLink} — Liberty Bancard`,
        inboundRequestId: submissionId,
      };
      if (ov?.sendSms) {
        await ov.sendSms(smsParams);
      } else {
        await unifiedSendSms(smsParams);
      }
    } catch (err) {
      console.error(`[GHL Inbound] Confirmation SMS failed (non-fatal):`, err);
    }
  }

  // ── Durable 24-hour follow-up (BullMQ enrichment queue) ─────────────────────
  // Scheduling failure is isolated — inbound_confirmation_sent is preserved.
  if (dealId !== undefined) {
    const followupJobId = `inbound_followup-${submissionId}`;
    const jobData = { contactId, dealId, formType, submissionId };
    const jobOpts = {
      delay: 24 * 60 * 60 * 1000,
      jobId: followupJobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: false,
    };
    try {
      if (ov?.scheduleFollowup) {
        await ov.scheduleFollowup(followupJobId, jobData, jobOpts);
      } else {
        const { requireQueueManagerReady, QUEUE_NAMES } = await import("./queue-manager");
        const qm = requireQueueManagerReady();
        const enrichmentQueue = qm.getQueue(QUEUE_NAMES.ENRICHMENT);
        if (!enrichmentQueue) throw new Error("Enrichment queue not available from QueueManager");
        await enrichmentQueue.add("inbound-confirmation-followup", jobData, jobOpts);
      }
      console.log(`[GHL Inbound] Follow-up scheduled: jobId=${followupJobId}`);
    } catch (err: any) {
      console.error(`[GHL Inbound] Follow-up scheduling failed (immediate send preserved):`, err);
      await writeAuditLog({
        action: "inbound_confirmation_followup_schedule_failed",
        entityType: "contact",
        entityId: contactId,
        details: { submissionId, failureReason: err.message, formType, dealId },
      });
    }
  }

  // Definitive delivery outcome (email was sent above). Side effects (SMS,
  // follow-up scheduling) never downgrade a successful send.
  return deliveredOutcome;
}

/**
 * Injectable provider overrides for `runInboundConfirmationFollowupJob`.
 * @internal Test-only. Never pass in production.
 */
export interface InboundFollowupTestOverrides {
  /** Pre-fetched contact — skips `storage.getContact()`. */
  contact?: Record<string, any> | null;
  /** Pre-fetched deal — skips `storage.getDeal()`. */
  deal?: Record<string, any> | null;
  /** Override contactability evaluation. */
  evaluateContactability?: (params: any) => Promise<{ allowed: boolean; reason?: string }>;
  /** Override duplicate-followup guard. Returns true if a duplicate already exists. */
  checkDuplicateFollowup?: () => Promise<boolean>;
  /** Override email send (replaces `sendConfirmationEmail()`). */
  sendEmail?: (params: { contactId: number; ghlContactId: string | null; email: string; subject: string; body: string }) => Promise<ConfirmationEmailResult>;
  /** Override audit log write (replaces `storage.createAuditLog()`). */
  writeAuditLog?: (entry: { action: string; entityType: string; entityId: number; details: any }) => Promise<void>;
}

/**
 * BullMQ handler for the "inbound-confirmation-followup" job.
 * Executed ~24 hours after the initial inbound confirmation.
 * Re-evaluates contactability and deal progression before sending.
 * Re-throws on provider failure so BullMQ can retry (up to 3 attempts).
 */
export async function runInboundConfirmationFollowupJob(data: {
  contactId: number;
  dealId?: number;
  formType: string;
  submissionId: string;
  /** @internal Test-only injectable overrides. Never pass in production. */
  _testOverrides?: InboundFollowupTestOverrides;
}): Promise<void> {
  const { contactId, dealId, formType, submissionId, _testOverrides: fov } = data;
  const logPrefix = `[InboundFollowup:${submissionId}]`;

  const writeAuditLog = fov?.writeAuditLog
    ?? ((entry: Parameters<typeof storage.createAuditLog>[0]) => storage.createAuditLog(entry).catch(() => {}));

  // 1. Contact still exists
  const contact = (fov?.contact !== undefined ? fov.contact : await storage.getContact(contactId)) as (Awaited<ReturnType<typeof storage.getContact>> | null);
  if (!contact) {
    await writeAuditLog({
      action: "inbound_confirmation_followup_skipped",
      entityType: "contact",
      entityId: contactId,
      details: { reason: "no_contact", submissionId },
    });
    console.log(`${logPrefix} Skipped — contact not found`);
    return;
  }

  // 2. Evaluate contactability (catches opt-out, DNC, contactability block)
  const contactabilityCheck = fov?.evaluateContactability
    ? await fov.evaluateContactability({ contactId, channel: "email", campaignType: "inbound_followup", mode: "enforcement" })
    : await (async () => {
        const { evaluateContactability } = await import("./contactability");
        return evaluateContactability({ contactId, channel: "email", campaignType: "inbound_followup", mode: "enforcement" });
      })();

  if (!contactabilityCheck.allowed) {
    const reasonCode: string = contact.doNotContact
      ? "dnc"
      : contact.smsStatus === "opted_out" || contact.emailStatus === "opted_out"
        ? "opted_out"
        : "contactability_blocked";
    await writeAuditLog({
      action: "inbound_confirmation_followup_skipped",
      entityType: "contact",
      entityId: contactId,
      details: { reason: reasonCode, contactabilityReason: contactabilityCheck.reason, submissionId },
    });
    console.log(`${logPrefix} Skipped — ${reasonCode}: ${contactabilityCheck.reason}`);
    return;
  }

  // 3. Contact has a usable email address
  if (!contact.email) {
    await writeAuditLog({
      action: "inbound_confirmation_followup_skipped",
      entityType: "contact",
      entityId: contactId,
      details: { reason: "no_email", submissionId },
    });
    console.log(`${logPrefix} Skipped — no email address`);
    return;
  }

  // 4. Deal progression check
  if (dealId) {
    const deal = (fov?.deal !== undefined ? fov.deal : await storage.getDeal(dealId)) as any;
    if (deal && ["Statement Received", "Engaged", "Call Booked"].includes(deal.stage)) {
      await writeAuditLog({
        action: "inbound_confirmation_followup_skipped",
        entityType: "contact",
        entityId: contactId,
        details: { reason: "deal_progressed", dealStage: deal.stage, submissionId },
      });
      console.log(`${logPrefix} Skipped — deal progressed to ${deal.stage}`);
      return;
    }
  }

  // 5. Duplicate guard: ensure this submission's follow-up hasn't already been sent
  const isDuplicate = fov?.checkDuplicateFollowup
    ? await fov.checkDuplicateFollowup()
    : await (async () => {
        const { db } = await import("../db");
        const { auditLogs: auditLogsTable } = await import("@shared/schema");
        const { eq, and: drizzleAnd, sql: drizzleSql } = await import("drizzle-orm");
        const rows = await db
          .select({ id: auditLogsTable.id })
          .from(auditLogsTable)
          .where(
            drizzleAnd(
              eq(auditLogsTable.entityType, "contact"),
              eq(auditLogsTable.entityId, contactId),
              eq(auditLogsTable.action, "inbound_confirmation_followup_sent"),
              drizzleSql`(${auditLogsTable.details}->>'submissionId') = ${submissionId}`,
            ),
          )
          .limit(1);
        return rows.length > 0;
      })();

  if (isDuplicate) {
    await writeAuditLog({
      action: "inbound_confirmation_followup_skipped",
      entityType: "contact",
      entityId: contactId,
      details: { reason: "duplicate_already_processed", submissionId },
    });
    console.log(`${logPrefix} Skipped — follow-up already sent for this submission`);
    return;
  }

  const bookingLink =
    getCalendarBookingUrl({
      contactEmail: contact.email,
      contactName: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim(),
      source: formType,
    }) || SALES_CALENDAR;

  const sendEmailImpl = fov?.sendEmail ?? sendConfirmationEmail;
  const emailResult = await sendEmailImpl({
    contactId,
    ghlContactId: contact.ghlContactId ?? null,
    email: contact.email,
    subject: `Still want to see how much you could save, ${contact.firstName}?`,
    body: buildInbound24hFollowupEmail(contact.firstName || "there", bookingLink),
  });

  if (emailResult.sent) {
    await writeAuditLog({
      action: "inbound_confirmation_followup_sent",
      entityType: "contact",
      entityId: contactId,
      details: {
        provider: emailResult.provider,
        recipient: contact.email,
        providerMessageId: emailResult.providerMessageId ?? null,
        submissionId,
        formType,
        dealId: dealId ?? null,
      },
    });
    console.log(`${logPrefix} Follow-up sent via ${emailResult.provider}`);
  } else {
    await writeAuditLog({
      action: "inbound_confirmation_followup_failed",
      entityType: "contact",
      entityId: contactId,
      details: {
        providerAttempts: emailResult.providerAttempts,
        reason: emailResult.reason,
        submissionId,
      },
    });
    console.error(`${logPrefix} All providers failed: ${emailResult.reason}`);
    throw new Error(`Inbound follow-up failed for submission ${submissionId}: ${emailResult.reason}`);
  }
}

export async function enrollInAppointmentWorkflow(params: {
  contactId: number;
  appointmentDate: Date;
  calendarType: "sales" | "account_management";
  dealId?: number;
}): Promise<void> {
  const { contactId, appointmentDate, calendarType, dealId } = params;
  const contact = await storage.getContact(contactId);
  if (!contact) return;

  const appointmentWorkflowId = process.env.GHL_WORKFLOW_APPOINTMENT;

  if (appointmentWorkflowId && (isGhlConfigured() || isSdrGhlConfigured())) {
    let ghlContactId = contact.ghlContactId;
    if (!ghlContactId) {
      try {
        ghlContactId = await unifiedUpsertContact(contact);
      } catch (err) {
        console.error(`[GHL Appointment] Failed to upsert contact:`, err);
      }
    }

    if (ghlContactId) {
      try {
        await addTag({
          contactId: ghlContactId,
          tags: ["LB-BOOKING-READY", "LB-MEETING-SET"],
        });

        await triggerWorkflow({
          workflowId: appointmentWorkflowId,
          contactId: ghlContactId,
          metadata: {
            appointmentDate: appointmentDate.toISOString(),
            calendarType,
            contactId,
            dealId,
            firstName: contact.firstName,
            companyName: contact.companyName,
          },
        });

        await storage.createAuditLog({
          action: "ghl_appointment_workflow_enrolled",
          entityType: "contact",
          entityId: contactId,
          details: { appointmentDate, calendarType, ghlWorkflowId: appointmentWorkflowId },
        });

        return;
      } catch (err) {
        console.error(`[GHL Appointment] Workflow trigger failed:`, err);
      }
    }
  }

  if (isGhlConfigured() || isSdrGhlConfigured()) {
    let apptGhlContactId = contact.ghlContactId;
    if (!apptGhlContactId) {
      try {
        apptGhlContactId = await unifiedUpsertContact(contact);
      } catch (err) {
        console.error(`[GHL Appointment] Failed to upsert contact for fallback sends:`, err);
      }
    }

    if (!apptGhlContactId) {
      console.error(`[GHL Appointment] No GHL contact ID for fallback sends — skipping`);
      return;
    }

    try {
      const dateStr = appointmentDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      });

      await unifiedSendEmail({
        contactId,
        ghlContactId: apptGhlContactId,
        subject: `Your call with Liberty Bancard is confirmed — ${dateStr}`,
        body: buildAppointmentConfirmationEmail(contact.firstName || "there", dateStr, calendarType),
      });

      const msUntilAppt = appointmentDate.getTime() - Date.now();
      const capturedApptGhlId = apptGhlContactId;

      if (msUntilAppt > 24 * 60 * 60 * 1000) {
        setTimeout(async () => {
          try {
            await unifiedSendEmail({
              contactId,
              ghlContactId: capturedApptGhlId,
              subject: `Reminder: Your call with Liberty Bancard is tomorrow`,
              body: buildAppointmentReminderEmail(contact.firstName || "there", dateStr, "24h"),
            });
          } catch (err) {
            console.error(`[GHL Appointment] 24h reminder failed:`, err);
          }
        }, msUntilAppt - 24 * 60 * 60 * 1000);
      }

      if (msUntilAppt > 60 * 60 * 1000) {
        setTimeout(async () => {
          try {
            if (contact.consentSms && contact.phone) {
              await unifiedSendSms({
                contactId,
                ghlContactId: capturedApptGhlId,
                body: `Hi ${contact.firstName}, just a reminder — your call with Liberty Bancard is in about 1 hour. Looking forward to speaking with you! — Liberty Bancard`,
              });
            }
          } catch (err) {
            console.error(`[GHL Appointment] 1h reminder failed:`, err);
          }
        }, msUntilAppt - 60 * 60 * 1000);
      }

      setTimeout(async () => {
        try {
          const calLink = calendarType === "account_management" ? AM_CALENDAR : SALES_CALENDAR;
          await unifiedSendEmail({
            contactId,
            ghlContactId: capturedApptGhlId,
            subject: `Thanks for your time, ${contact.firstName}`,
            body: buildPostMeetingFollowupEmail(contact.firstName || "there", calendarType, calLink),
          });
        } catch (err) {
          console.error(`[GHL Appointment] Post-meeting follow-up failed:`, err);
        }
      }, msUntilAppt + 60 * 60 * 1000);
    } catch (err) {
      console.error(`[GHL Appointment] Confirmation email failed:`, err);
    }
  }
}

export async function tagContactForInboxOrganization(params: {
  contactId: number;
  ghlContactId: string;
  sequenceName: string;
  vertical?: string;
  stage?: string;
}): Promise<void> {
  const { ghlContactId, sequenceName, vertical, stage } = params;

  const tags: string[] = [INBOX_SMART_LIST_TAGS.activeSdr];

  const mapping = SEQUENCE_WORKFLOW_MAP[sequenceName];
  if (mapping) {
    tags.push(...mapping.inboxTags);
  }

  if (vertical) {
    tags.push(getVerticalTag(vertical));
  }

  if (stage) {
    const stageTagMap: Record<string, string> = {
      "replied": INBOX_SMART_LIST_TAGS.replied,
      "meeting_set": INBOX_SMART_LIST_TAGS.meetingSet,
      "statement_pending": INBOX_SMART_LIST_TAGS.statementPending,
      "human_handoff": INBOX_SMART_LIST_TAGS.humanHandoff,
    };
    const stageTag = stageTagMap[stage];
    if (stageTag) tags.push(stageTag);
  }

  try {
    await addTag({ contactId: ghlContactId, tags: [...new Set(tags)] });
  } catch (err) {
    console.warn(`[GHL Inbox] Failed to tag contact ${ghlContactId}:`, err);
  }
}

export async function markEsignComplete(params: {
  applicationId: number;
  documentId: string;
}): Promise<{ verified: boolean; status: string }> {
  const { applicationId, documentId } = params;

  try {
    const { getDocumentStatus } = await import("./ghl");
    const docStatus = await getDocumentStatus(documentId);

    if (docStatus.status === "completed" || docStatus.status === "signed") {
      // Route through the canonical merchant-application service — replay-safe
      // conditional local update. Never a raw storage writer for e-sign state.
      const { applyEsignDocumentState } = await import("./merchant-application-service");
      await applyEsignDocumentState({
        applicationId,
        esignStatus: "signed",
        esignedAt: docStatus.signedAt ? new Date(docStatus.signedAt) : new Date(),
      });

      await storage.createAuditLog({
        action: "esign_verified_complete",
        entityType: "merchant_application",
        entityId: applicationId,
        details: { documentId, status: docStatus.status, signedAt: docStatus.signedAt },
      });

      return { verified: true, status: "signed" };
    }

    return { verified: false, status: docStatus.status };
  } catch (err) {
    console.error(`[GHL E-Sign] Verification failed for document ${documentId}:`, err);
    return { verified: false, status: "error" };
  }
}

export function getWorkflowMappings(): Record<string, GhlWorkflowMapping> {
  return { ...SEQUENCE_WORKFLOW_MAP };
}

export function getInboxSmartListTags(): Record<string, string> {
  return { ...INBOX_SMART_LIST_TAGS };
}

export function getEnrollmentStatus(): {
  ghlConfigured: boolean;
  sdrGhlConfigured: boolean;
  ghlWorkflowOnlyMode: boolean;
  totalMappedSequences: number;
  sequencesWithWorkflowIds: number;
  unmappedSequences: string[];
  hasInboundWorkflow: boolean;
  hasAppointmentWorkflow: boolean;
  hasDefaultWorkflow: boolean;
  platformEmailSeparation: {
    transactionalViaReplit: string[];
    marketingViaGhl: string[];
  };
  esignFlow: {
    platform: string;
    templateConfigured: boolean;
    webhookEndpoint: string;
  };
  workflowProvisioningNote: string;
} {
  const mappings = Object.values(SEQUENCE_WORKFLOW_MAP);
  const withIds = mappings.filter(m => resolveGhlWorkflowIdSync(m.sequenceName) !== null);
  const unmapped = mappings.filter(m => resolveGhlWorkflowIdSync(m.sequenceName) === null).map(m => m.sequenceName);

  return {
    ghlConfigured: isGhlConfigured(),
    sdrGhlConfigured: isSdrGhlConfigured(),
    ghlWorkflowOnlyMode: process.env.GHL_WORKFLOW_ONLY_MODE === "true",
    totalMappedSequences: mappings.length,
    sequencesWithWorkflowIds: withIds.length,
    unmappedSequences: unmapped,
    hasInboundWorkflow: !!process.env.GHL_WORKFLOW_INBOUND_CONFIRMATION,
    hasAppointmentWorkflow: !!process.env.GHL_WORKFLOW_APPOINTMENT,
    hasDefaultWorkflow: !!process.env.GHL_DEFAULT_WORKFLOW_ID,
    workflowProvisioningNote: "GHL workflows must be created in the GHL UI (GoHighLevel does not expose a public workflow creation API). Configure workflow IDs via GHL_WORKFLOW_<SEQUENCE_NAME> environment variables. Set GHL_WORKFLOW_ONLY_MODE=true to disable direct sends and enforce GHL-native delivery.",
    platformEmailSeparation: {
      transactionalViaReplit: [
        "Password reset emails",
        "Email verification / account confirmation",
        "Account notification emails (security alerts, plan changes)",
        "System error notifications",
        "Admin-only internal alerts",
      ],
      marketingViaGhl: [
        "SDR outreach sequences (all verticals)",
        "Inbound lead confirmation and nurture",
        "Appointment confirmations and reminders",
        "Proposal follow-ups",
        "Post-call review summaries",
        "Long-term nurture drips",
        "Reactivation campaigns",
        "Account management operations emails",
      ],
    },
    esignFlow: {
      platform: "GHL Documents / E-Sign",
      templateConfigured: !!process.env.GHL_MERCHANT_AGREEMENT_TEMPLATE_ID,
      webhookEndpoint: "/api/webhooks/ghl-document",
    },
  };
}

function buildInboundConfirmationEmail(firstName: string, companyName: string, formType: string, bookingLink: string): string {
  const formTypeLabels: Record<string, string> = {
    statement_upload: "uploading your processing statement",
    estimate: "requesting a savings estimate",
    get_started: "getting started with Liberty Bancard",
    support: "reaching out to our support team",
    callback: "requesting a callback",
  };
  const action = formTypeLabels[formType] || "connecting with us";

  return `<p>Hi ${firstName},</p>
<p>Thanks for ${action}! We're glad you reached out.</p>
<p>Here's what happens next:</p>
<ol>
  <li>Our team will review your information (usually within a few hours)</li>
  <li>We'll prepare a personalized analysis for ${companyName}</li>
  <li>A team member will follow up with your results and recommendations</li>
</ol>
<p>Want to skip the wait? Book a call directly with our team:</p>
<p><a href="${bookingLink}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Book a Call Now</a></p>
<p>In the meantime, feel free to reply to this email with any questions.</p>
<p>— Liberty Bancard Team</p>
<p style="font-size:11px;color:#888;margin-top:24px;">Eligibility, underwriting, card brand rules, and applicable laws apply.</p>`;
}

function buildInbound24hFollowupEmail(firstName: string, bookingLink: string): string {
  return `<p>Hi ${firstName},</p>
<p>Just checking in — we received your information yesterday and wanted to make sure you saw our follow-up.</p>
<p>If you haven't had a chance to book a call yet, here's the link:</p>
<p><a href="${bookingLink}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Schedule Your Free Review</a></p>
<p>Most merchants we work with are surprised by what we find — and the review only takes about 10 minutes.</p>
<p>No obligation, no pressure. Just clarity on what you're paying.</p>
<p>— Liberty Bancard Team</p>
<p style="font-size:11px;color:#888;margin-top:24px;">Eligibility, underwriting, card brand rules, and applicable laws apply.</p>`;
}

function buildAppointmentConfirmationEmail(firstName: string, dateStr: string, calendarType: string): string {
  const teamLabel = calendarType === "account_management" ? "your Account Manager" : "our sales team";
  return `<p>Hi ${firstName},</p>
<p>Your call with ${teamLabel} is confirmed for:</p>
<p style="font-size:18px;font-weight:600;color:#1a56db;">${dateStr} (Eastern Time)</p>
<p>What to expect:</p>
<ul>
  <li>A friendly, no-pressure conversation about your payment processing</li>
  <li>If you have a recent statement, we can do a live line-by-line review</li>
  <li>We'll answer any questions you have about pricing, hardware, or switching</li>
</ul>
<p>If you need to reschedule, just reply to this email and we'll find another time.</p>
<p>Looking forward to speaking with you!</p>
<p>— Liberty Bancard Team</p>
<p style="font-size:11px;color:#888;margin-top:24px;">Eligibility, underwriting, card brand rules, and applicable laws apply.</p>`;
}

function buildAppointmentReminderEmail(firstName: string, dateStr: string, timing: string): string {
  return `<p>Hi ${firstName},</p>
<p>Just a friendly reminder — your call with Liberty Bancard is ${timing === "24h" ? "tomorrow" : "coming up soon"}:</p>
<p style="font-size:16px;font-weight:600;color:#1a56db;">${dateStr} (Eastern Time)</p>
<p>If you have a recent processing statement handy, bring it along — we can review it live on the call.</p>
<p>See you then!</p>
<p>— Liberty Bancard Team</p>`;
}

function buildPostMeetingFollowupEmail(firstName: string, calendarType: string, rebookLink: string): string {
  return `<p>Hi ${firstName},</p>
<p>Thanks for taking the time to connect with us today. We hope the conversation was helpful!</p>
<p>As a quick recap, here are the next steps we discussed:</p>
<ul>
  <li>We'll finalize the analysis based on our conversation</li>
  <li>You'll receive a detailed savings breakdown within 24 hours</li>
  <li>If you have any additional documents to share, just reply to this email</li>
</ul>
<p>If you'd like to schedule a follow-up call to review the results:</p>
<p><a href="${rebookLink}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Book a Follow-Up</a></p>
<p>Thanks again — we're looking forward to helping you!</p>
<p>— Liberty Bancard Team</p>
<p style="font-size:11px;color:#888;margin-top:24px;">Eligibility, underwriting, card brand rules, and applicable laws apply.</p>`;
}
