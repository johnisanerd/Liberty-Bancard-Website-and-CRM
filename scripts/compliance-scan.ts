#!/usr/bin/env tsx
/**
 * Wave 12 — Static Compliance Scanner
 *
 * Scans the server source tree for all call sites of the 10 outbound send
 * functions listed in the Wave 12 preflight findings and classifies each as
 * PASS or FAIL.
 *
 * ── ALLOWLIST (low-level sender wrapper files — always PASS) ──────────────
 * These files ARE the low-level send wrappers.  Call sites here are expected
 * and do not require an upstream evaluateContactability gate.
 *   server/services/ghl.ts
 *   server/services/smtp-email.ts
 *   server/services/sdr/ghl-client.ts
 *   server/services/ghl-workflow-enrollment.ts
 *
 * ── SEND FUNCTIONS SCANNED ────────────────────────────────────────────────
 *   sendGhlSms          → SMS
 *   sendSmsReply        → SMS (SDR)
 *   unifiedSendSms      → SMS (abstraction)
 *   triggerAiCall       → voice_ai
 *   enrollContactInGhlWorkflow → ringless_vm / GHL workflow
 *   triggerWorkflow     → GHL workflow (low-level)
 *   sendGhlEmail        → email
 *   sendGhlEmailForMerchant → email (merchant-specific)
 *   sendTemplatedMessage  → email/SMS template delivery
 *   sendSmtpEmail       → email (SMTP fallback)
 *   sendEmailReply      → email (SDR)
 *   unifiedSendEmail    → email (abstraction)
 *
 * ── EMAIL CLASSIFICATION (for email call sites outside the allowlist) ─────
 *   marketing_outreach    — must be gated by evaluateContactability
 *   sequence_step         — must be guarded by sequence-worker gate
 *   transactional_merchant — merchant confirmation, portal, MID welcome; PASS if in allowlist with reason
 *   internal_admin        — internal team notifications, alerts; PASS if allowlisted with reason
 *   unknown               — FAIL: must classify before release
 *
 * ── PER-FINDING OUTPUT FORMAT ─────────────────────────────────────────────
 *   PASS/FAIL | file:line | enclosing_function | channel | email_category | nearest_gate | reason | suggested_fix
 *
 * Exit codes:
 *   0 — all PASS
 *   1 — any FAIL
 *
 * Run:
 *   npx tsx scripts/compliance-scan.ts
 */

import fs from "fs";
import path from "path";
import {
  GHL_ROUTE_MUTATION_ALLOWLIST,
  GHL_ROUTE_MUTATION_FUNCTIONS,
} from "./ghl-route-mutation-allowlist";

// ── Configuration ────────────────────────────────────────────────────────────

/** Files that ARE the low-level sender wrappers — always PASS. */
const ALLOWLISTED_FILES = new Set([
  "server/services/ghl.ts",
  "server/services/smtp-email.ts",
  "server/services/sdr/ghl-client.ts",
  "server/services/ghl-workflow-enrollment.ts",
]);

/** Additional per-call-site allowlist entries.
 *  Format: { file: "server/...", lineContains: "substring", channel, category, reason, reviewDate }
 *  These are transactional or internal_admin call sites that have been reviewed.
 */
const CALL_SITE_ALLOWLIST: Array<{
  file: string;
  lineContains: string;
  channel: string;
  category: "transactional_merchant" | "internal_admin" | "pipeline_gated" | "sequence_worker" | "admin_gated";
  reason: string;
  reviewDate: string;
}> = [
  {
    file: "server/services/inbound-acknowledgement.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Single owner of inbound request receipts. Factual receipt to the mailbox the visitor submitted, category support, transactional_response purpose; the SMTP boundary and pause authority re-verify the prepared recipient/content/claim from durable state and the delivery capability ships closed. No enrollment, no promotional content.",
    reviewDate: "2026-10-23",
  },
  {
    file: "server/routes/activation.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Rep invitation delivery is an explicit admin provisioning action, not automated outreach; it contains a one-time activation link and is only sent to the newly provisioned rep.",
    reviewDate: "2026-09-10",
  },
  {
    file: "server/services/merchant-welcome.ts",
    lineContains: "sendEmailReply",
    channel: "email",
    category: "transactional_merchant",
    reason: "Merchant portal welcome reply via GHL chat — triggered by operator approval action, not automated outreach. Contact must be in closed_won state.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/merchant-welcome.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Merchant portal welcome SMTP fallback — triggered by operator approval action when GHL is not configured. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/merchant-application-status.ts",
    lineContains: "sendEmailReply",
    channel: "email",
    category: "transactional_merchant",
    reason: "Merchant application status update via GHL reply — triggered by admin approval/rejection action on a specific application, not automated sequence.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/co-branded-proposal.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Co-branded proposal delivery via GHL (sendGhlEmail/sendGhlEmailForMerchant — lineContains matches both) — triggered explicitly by agent action, not automated sequence.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/co-branded-proposal.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Co-branded proposal delivery SMTP fallback — triggered explicitly by agent action when GHL is not configured. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/digest-service.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "internal_admin",
    reason: "Digest service GHL email — sends KPI/SLA digest to admin/operator email; triggered by scheduled digest job or operator-initiated digest send, not outbound marketing.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/digest-service.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "internal_admin",
    reason: "Digest service SMTP fallback — sends KPI/SLA digest to admin/operator when GHL is not configured. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/operator-digest.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "internal_admin",
    reason: "SDR operator daily digest GHL email — sends pipeline summary to operator/admin email; triggered by scheduled digest job, not outbound marketing.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/operator-digest.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "internal_admin",
    reason: "SDR operator daily digest SMTP fallback — sends pipeline summary when GHL is not configured. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/weekly-digest.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "internal_admin",
    reason: "Weekly KPI digest email — sends weekly performance summary to admin email; triggered by scheduled digest job, not outbound marketing.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/public.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Auto-proposal email — gated by hasEmailConsent flag before send; only fires when merchant explicitly consented to email communications.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/nps-email.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "NPS survey email — sent only to confirmed active Liberty Bancard merchants (closed_won deal, live stage) via createAndSendNpsSurvey(); never sent to cold prospects. Idempotent lease prevents duplicate sends. Reviewed 2026-08-06.",
    reviewDate: "2026-08-06",
  },
  {
    file: "server/services/ghl-sync.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "internal_admin",
    reason: "GHL circuit breaker alert — sent only to the internal ops admin email when the GHL sync circuit breaker opens (5+ consecutive API failures). Never sent to prospects or merchants. 1-hour cooldown prevents spam. Reviewed 2026-08-06.",
    reviewDate: "2026-08-06",
  },
  {
    file: "server/services/pipeline-silence-check.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "internal_admin",
    reason: "Pipeline stage silence alert — sent only to ADMIN_ALERT_EMAIL when a pipeline stage has had no deal movement for 24+ hours. 24-hour cooldown prevents repeat alerts. Never sent to prospects or merchants. Reviewed 2026-08-07.",
    reviewDate: "2026-08-07",
  },
  {
    file: "server/routes/partner-orgs.ts",
    lineContains: "await sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Partner org user welcome email — triggered by admin action (adding a user to a partner org), not automated outreach. Sends login credentials to the newly invited partner user only. Reviewed 2026-08-07.",
    reviewDate: "2026-08-07",
  },
  {
    file: "server/services/merchant-portal-invite.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Merchant portal invitation email — triggered by admin approval action (sendMerchantPortalInvite/resendMerchantPortalInvite), never automated. Only fires when SMTP is configured; skipped with a logged warning otherwise. Delivers a one-time activation link to the merchant. Reviewed 2026-08-07.",
    reviewDate: "2026-08-07",
  },
  // ── SDR pipeline email sends — explicitly reviewed 2026-06-26 ────────────
  // These files are always invoked from server/services/sdr/orchestrator.ts
  // whose runSdrCycle() calls evaluateContactability() at the top of every
  // cycle before any outbound action.  The gate is at the pipeline entry point,
  // not co-located with each send, which is a deliberate architectural choice.
  {
    file: "server/services/campaign-engine.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "pipeline_gated",
    reason: "SDR campaign email — evaluateContactability enforced at orchestrator top-of-cycle; SDR_ENABLED runtime flag guard prevents unsolicited sends. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/chat-handlers.ts",
    lineContains: "sendEmailReply",
    channel: "email",
    category: "pipeline_gated",
    reason: "SDR chat-handler reply email — triggered only inside the pipeline conversation flow; evaluateContactability gate sits at orchestrator entry. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/orchestrator.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "pipeline_gated",
    reason: "SDR orchestrator direct email — same file that calls evaluateContactability at top-of-cycle; local gate is the function itself. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/proposal-tracking.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "pipeline_gated",
    reason: "SDR proposal follow-up email — invoked from orchestrator after contactability check; proposal tracking only fires for contacts already in active pipeline stage. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/statement-flow.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "pipeline_gated",
    reason: "SDR statement-request and statement-follow-up emails — invoked from orchestrator after contactability check; fires only for contacts who submitted a statement. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/terminal-shipping.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "pipeline_gated",
    reason: "SDR terminal-shipping confirmation and tracking emails — invoked from orchestrator after contactability check; transactional in nature (hardware order). Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sequence-worker.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "sequence_worker",
    reason: "Sequence-worker step email — sequence-worker enforces canEnrollContactInSequence gate before each step execution; sequences require explicit enrollment. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  // ── Transactional services — reviewed 2026-06-26 ─────────────────────────
  {
    file: "server/services/partner-welcome.ts",
    lineContains: "sendEmailReply",
    channel: "email",
    category: "transactional_merchant",
    reason: "Partner portal welcome email — triggered by operator partner-approval action, sent to the specific partner who just received approval. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/proposal-engine.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Proposal delivery via GHL email — triggered by explicit agent action in proposal workflow for a specific contact. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/proposal-engine.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "transactional_merchant",
    reason: "Proposal delivery via merchant-specific GHL email — triggered by explicit agent action for a specific merchant. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/proposal-engine.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Proposal delivery SMTP fallback — triggered by explicit agent action when GHL is not configured. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sla-worker.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "internal_admin",
    reason: "SLA breach notification email — sent to internal admin/agent on SLA violation event; not automated outbound marketing. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/statement-upload-chain.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Statement upload confirmation SMTP — triggered by specific contact's statement submission, sent to the submitting rep. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/statement-upload-chain.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "transactional_merchant",
    reason: "Statement receipt confirmation via GHL — triggered by specific contact's statement submission. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  // ── Admin-gated routes — reviewed 2026-06-26 ─────────────────────────────
  {
    file: "server/routes/activity.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "internal_admin",
    reason: "Activity route email — route requires isAuthenticated; sent as part of an activity log action initiated by an authenticated operator. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/admin.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "internal_admin",
    reason: "Admin route SMTP email — route requires admin role; operator-initiated notification, not automated outbound. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/provider-credit-alert.ts",
    lineContains: "const result = await sendSmtpEmail(",
    channel: "email",
    category: "internal_admin",
    reason: "Credit exhaustion alert goes only to the configured admin address, not to prospects; global pause authority and monitoring coordinator hold are checked before sending.",
    reviewDate: "2026-09-30",
  },
  {
    file: "server/routes/analytics.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "internal_admin",
    reason: "Analytics weekly KPI digest — sent to admin email on operator-triggered digest action; not automated outbound marketing. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/integrations.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "internal_admin",
    reason: "Integrations route email — route requires admin/manager role; used for test sends and admin-initiated GHL email actions. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/notifications.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "internal_admin",
    reason: "Notifications daily digest — sent to admin email on operator-triggered digest action; not automated outbound marketing. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/partners.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "transactional_merchant",
    reason: "Partner status/approval email — triggered by admin partner approval or partner-specific action; sent to the specific partner contact. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/partners.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Partner SMTP fallback email — triggered by admin partner approval when GHL is not configured. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/rate-review.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Rate review result email — triggered by specific merchant's rate review request; sent to the requesting contact. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/residuals.ts",
    lineContains: "sendGhlEmailForMerchant",
    channel: "email",
    category: "internal_admin",
    reason: "Residual reconciliation alert email — sent to admin on reconciliation discrepancy; not automated outbound marketing. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/savings.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Savings analysis result email via GHL — triggered by specific contact's savings analysis request. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/savings.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "Savings analysis result SMTP fallback — triggered by specific contact's savings analysis request when GHL is not configured. Reviewed and approved.",
    reviewDate: "2026-06-26",
  },
  // ── Campaign engine send — pipeline_gated (evaluateContactability at top of function) ────
  {
    file: "server/services/campaign-engine.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "pipeline_gated",
    reason: "Campaign-engine contact-mode email send — evaluateContactability() is called at the top of the same function (processContactModeMessage) before reaching the sendSmtpEmail call site; the gate is co-located within the same function body, just separated by arbitration and compliance-prereq checks. Reviewed 2026-08-09.",
    reviewDate: "2026-08-09",
  },
  // ── Non-email send sites: admin_gated routes (operator-initiated only) ──────
  {
    file: "server/routes/activity.ts",
    lineContains: "sendGhlSms",
    channel: "sms",
    category: "admin_gated",
    reason: "Manual SMS from activity-feed route — triggered by authenticated dashboard user action; not automated outreach. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/contacts.ts",
    lineContains: "enrollContactInGhlWorkflow",
    channel: "ringless_vm/workflow",
    category: "admin_gated",
    reason: "GHL workflow enrollment from contacts management route — operator-initiated re-engagement or sequence trigger for a specific contact. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/contacts.ts",
    lineContains: "sendGhlEmail({ contactId, subject, body",
    channel: "email",
    category: "admin_gated",
    reason: "CRM email composer — POST /api/contacts/:id/send-email protected by isDashboardUser; authenticated dashboard rep manually composes and sends an email to a specific contact. Not automated outreach. Reviewed 2026-07-26.",
    reviewDate: "2026-07-26",
  },
  {
    file: "server/routes/helpers.ts",
    lineContains: "sendGhlSms",
    channel: "sms",
    category: "admin_gated",
    reason: "Helper SMS utility — invoked by authenticated dashboard routes after an agent creates or updates a contact. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/integrations.ts",
    lineContains: "sendGhlSms({ contactId, dealId",
    channel: "sms",
    category: "admin_gated",
    reason: "Manual SMS from integrations panel — authenticated admin/agent sends to a specific contact by ID. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/integrations.ts",
    lineContains: "sendGhlSms({ contactId, body: personalizedMsg",
    channel: "sms",
    category: "admin_gated",
    reason: "Personalised batch SMS from admin integrations panel — operator-initiated; contacts are existing active-sequence members already in pipeline. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/partners.ts",
    lineContains: "enrollContactInGhlWorkflow",
    channel: "ringless_vm/workflow",
    category: "admin_gated",
    reason: "Partner sequence enrollment via partners management route — operator-initiated on partner approval or management action. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/routes/sdr.ts",
    lineContains: "triggerAiCall(merchantId, botMode)",
    channel: "voice_ai",
    category: "admin_gated",
    reason: "Manual voice AI trigger from authenticated SDR manual-dial endpoint — operator-initiated, not automated outreach. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  // ── Non-email send sites: transactional services (one-to-one, contact-action-triggered) ──
  // ── ghl-form-sync.ts per-call-site entries (T-02, #1626) ──
  // The old single "triggerWorkflow" entry was replaced by per-call-site
  // entries. Each raw fetch mutation below is gated by
  // authorizeGhlMutation() (pause authority, fail-closed) and checks
  // response.ok with typed failures — corrected under C-10 (#1626).
  {
    file: "server/services/ghl-form-sync.ts",
    lineContains: "await triggerWorkflow({",
    channel: "ringless_vm/workflow",
    category: "transactional_merchant",
    reason: "GHL workflow enrollment triggered by form-submission sync — sends only to the contact who just submitted the form; goes through the gated sdr/ghl-client adapter. Reviewed 2026-08-18.",
    reviewDate: "2026-08-18",
  },
  {
    file: "server/services/ghl-form-sync.ts",
    lineContains: "fetch(\"https://services.leadconnectorhq.com/opportunities/\"",
    channel: "crm_mutation",
    category: "transactional_merchant",
    reason: "Onboarding opportunity POST after merchant application submit — gated by authorizeGhlMutation() pause authority (C-10 #1626); response.ok checked; failure logged as typed error. Reviewed 2026-08-18.",
    reviewDate: "2026-08-18",
  },
  {
    file: "server/services/ghl-form-sync.ts",
    lineContains: "fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}/tasks`",
    channel: "crm_mutation",
    category: "transactional_merchant",
    reason: "Support task POST for the contact who just opened a support ticket — gated by authorizeGhlMutation() pause authority (C-10 #1626); response.ok checked. Reviewed 2026-08-18.",
    reviewDate: "2026-08-18",
  },
  {
    file: "server/services/ghl-form-sync.ts",
    lineContains: "fetch(\"https://services.leadconnectorhq.com/contacts/\"",
    channel: "crm_mutation",
    category: "transactional_merchant",
    reason: "Affiliate signup contact POST — creates a CRM contact for the affiliate who just signed up; gated by authorizeGhlMutation() pause authority (C-10 #1626); response.ok checked; affiliate email removed from logs. Reviewed 2026-08-18.",
    reviewDate: "2026-08-18",
  },
  {
    file: "server/services/ghl-form-sync.ts",
    lineContains: "fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}`",
    channel: "crm_mutation",
    category: "transactional_merchant",
    reason: "DND PUT reflecting the submitting contact's own consent choice — gated by authorizeGhlMutation() pause authority (C-10 #1626); response.ok checked; provider body not logged. Reviewed 2026-08-18.",
    reviewDate: "2026-08-18",
  },
  {
    file: "server/services/ghl-workflows.ts",
    lineContains: "triggerWorkflow",
    channel: "ringless_vm/workflow",
    category: "transactional_merchant",
    reason: "Centralised GHL workflow service — invoked by specific business events (merchant approval, partner welcome, onboarding) for the relevant contact only. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/merchant-welcome.ts",
    lineContains: "triggerWorkflow",
    channel: "ringless_vm/workflow",
    category: "transactional_merchant",
    reason: "Merchant welcome workflow enrollment — triggered by closed_won/approval event, sends only to the newly approved merchant. 2 call sites; both transactional. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/partner-welcome.ts",
    lineContains: "triggerWorkflow",
    channel: "ringless_vm/workflow",
    category: "transactional_merchant",
    reason: "Partner welcome workflow enrollment — triggered by partner-approval event, sends only to the newly approved partner. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  // ── Non-email send sites: pipeline_gated SDR (evaluateContactability at orchestrator top-of-pipeline) ──
  {
    file: "server/services/sdr/chat-handlers.ts",
    lineContains: "sendSmsReply",
    channel: "sms",
    category: "pipeline_gated",
    reason: "SDR chat-handler SMS reply — invoked within the SDR pipeline whose entry point (orchestrator.ts) enforces evaluateContactability before any downstream handler. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/orchestrator.ts",
    lineContains: "sendGhlSms",
    channel: "sms",
    category: "pipeline_gated",
    reason: "SDR orchestrator outbound SMS — this IS the evaluateContactability gate file; the gate runs before the send on the same pipeline tick. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/proposal-tracking.ts",
    lineContains: "sendGhlSms({ contactId: lead.contactId, body: smsBody",
    channel: "sms",
    category: "pipeline_gated",
    reason: "SDR proposal-tracking SMS follow-up — invoked after evaluateContactability passes at orchestrator level; proposal tracking is a downstream pipeline step. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/reply-intelligence.ts",
    lineContains: "triggerAiCall(merchantId, \"intro_qualification\")",
    channel: "voice_ai",
    category: "pipeline_gated",
    reason: "SDR reply-intelligence voice trigger — invoked after intent classification in the gated SDR pipeline; evaluateContactability enforced at orchestrator before pipeline entry. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/scheduling.ts",
    lineContains: "triggerWorkflow",
    channel: "ringless_vm/workflow",
    category: "pipeline_gated",
    reason: "SDR scheduling workflow triggers (booking confirmation and 24-hour reminder) — invoked after successful appointment booking in the gated SDR pipeline. 2 call sites. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/statement-flow.ts",
    lineContains: "sendGhlSms({ contactId: lead.contactId",
    channel: "sms",
    category: "pipeline_gated",
    reason: "SDR statement-flow SMS (upload link and follow-up nudge) — invoked from the gated SDR pipeline after evaluateContactability passes at orchestrator. 2 call sites. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/voice-orchestrator.ts",
    lineContains: "triggerWorkflow",
    channel: "ringless_vm/workflow",
    category: "pipeline_gated",
    reason: "Voice orchestrator GHL workflow trigger — routes voice AI call via GHL workflow in the gated SDR pipeline. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sdr/voice-orchestrator.ts",
    lineContains: "sendGhlSms({ contactId: contact.id",
    channel: "sms",
    category: "pipeline_gated",
    reason: "Voice orchestrator voicemail SMS fallback — sent to the contact after a missed AI call, within the gated SDR pipeline. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  // ── Non-email send sites: sequence_worker (canEnrollContactInSequence gate per step) ──────────────
  {
    file: "server/services/sequence-worker.ts",
    lineContains: "enrollContactInGhlWorkflow",
    channel: "ringless_vm/workflow",
    category: "sequence_worker",
    reason: "Sequence-worker GHL workflow enrollment step — canEnrollContactInSequence is called before each sequence step execution. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sequence-worker.ts",
    lineContains: "sendGhlSms",
    channel: "sms",
    category: "sequence_worker",
    reason: "Sequence-worker SMS step — executed only after canEnrollContactInSequence passes; each step is individually gated by the sequence-worker. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  {
    file: "server/services/sequence-worker.ts",
    lineContains: "triggerAiCall(merchant.id, callMode)",
    channel: "voice_ai",
    category: "sequence_worker",
    reason: "Sequence-worker voice AI step — executed only after canEnrollContactInSequence passes; each step is individually gated. Reviewed 2026-06-26.",
    reviewDate: "2026-06-26",
  },
  // ── Sequence-worker SMTP path — reviewed 2026-07-22 ──────────────────────
  {
    file: "server/services/sequence-worker.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "sequence_worker",
    reason: "Sequence-worker SMTP cold-outreach branch (useSmtpForThisStep) — executed only after canEnrollContactInSequence passes and the sequence step is gated. SMTP is an optional transport; GHL is the primary executor. Architecture reviewed 2026-07-22.",
    reviewDate: "2026-07-22",
  },
  // ── Setup Wizard admin-gated test sends — reviewed 2026-07-22 ────────────
  // Routes are protected by requireRole("admin","manager") + wizardTestRateLimit.
  // Sends go only to the wizard_test_contact created and tagged in Phase 2 of
  // the wizard flow — not to any real merchant or prospect contact.
  {
    file: "server/routes/wizard.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "admin_gated",
    reason: "Setup Wizard live channel test — POST /api/wizard/test-send/email requires admin or manager role and wizardTestRateLimit; recipient is always the wizard_test_contact (tagged wizard_test_contact). Not automated outreach. Reviewed 2026-07-22.",
    reviewDate: "2026-07-22",
  },
  {
    file: "server/routes/wizard.ts",
    lineContains: "sendGhlSms",
    channel: "sms",
    category: "admin_gated",
    reason: "Setup Wizard live channel test — POST /api/wizard/test-send/sms requires admin or manager role, wizardTestRateLimit, and SMS_ENABLED feature flag; recipient is always the wizard_test_contact. Not automated outreach. Reviewed 2026-07-22.",
    reviewDate: "2026-07-22",
  },
  // ── Internal test sequence email sends — reviewed 2026-07-26 ─────────────
  // POST /api/wizard/test-sequence-emails: admin-only + wizardTestRateLimit.
  // Recipient is hardcoded to scott@libertybancard.com — never a real prospect.
  // SMTP is preferred transport; GHL (sendGhlEmail) is the fallback path.
  // Both send calls are in the same route handler and share the same gate.
  {
    file: "server/routes/wizard.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "internal_admin",
    reason: "Internal test send for all active sequence templates — admin-only, wizardTestRateLimit, recipient hardcoded to scott@libertybancard.com. SMTP preferred transport path. Never sends to real prospects. Reviewed 2026-07-26.",
    reviewDate: "2026-07-26",
  },
  // ── CRM one-off email composer — reviewed 2026-07-26 ─────────────────────
  // POST /api/contacts/:id/send-email — gated by isDashboardUser (no merchants).
  // Rep-initiated manual send via GHL to a specific known contact. Not automated
  // outreach; the rep selects the recipient explicitly in the UI. Subject and body
  // are entered by the rep at send time.
  {
    file: "server/routes/contacts.ts",
    lineContains: "sendGhlEmail({ contactId, subject, body })",
    channel: "email",
    category: "admin_gated",
    reason: "CRM email composer — POST /api/contacts/:id/send-email requires isDashboardUser; rep manually composes and sends to a specific contact via GHL. Not automated outreach; no bulk or sequence path. Reviewed 2026-07-26.",
    reviewDate: "2026-07-26",
  },
  // ── Continuous health monitor degradation alert — reviewed 2026-08-06 ─────
  // Fires ONLY when a previously-ok critical subsystem becomes non-ok.
  // Recipient is always ADMIN_ALERT_EMAIL (operator-owned inbox, not a prospect).
  // category=internal_ops; no consumer/prospect data involved.
  {
    file: "server/services/health-monitor.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "internal_admin",
    reason: "Health monitor degradation alert — sent only to ADMIN_ALERT_EMAIL when a critical subsystem (db/sequenceWorker/redis/kpiQuery) newly degrades. Operator-only recipient, no prospect/consumer data, fire-and-forget. Reviewed 2026-08-06.",
    reviewDate: "2026-08-06",
  },
  {
    file: "server/services/partner-notifications.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "transactional_merchant",
    reason: "sendPartnerGoLiveEmail — triggered only when a referred merchant deal transitions to Closed Won. Recipient is the referring partner (operator-vetted), not a consumer prospect. No marketing content; confirms a business event the partner is expecting.",
    reviewDate: "2026-08-07",
  },
  {
    file: "server/services/partner-notifications.ts",
    lineContains: "sendSmtpEmail",
    channel: "email",
    category: "internal_admin",
    reason: "sendMonthlyDigestEmail — monthly residuals summary to a registered partner (internal_admin class: operator-vetted B2B recipient). Sent by the BullMQ monthly residuals job, not to consumer prospects. Partners have opted-in through the partner program.",
    reviewDate: "2026-08-07",
  },
  {
    file: "server/services/transports/ghl-email-transport.ts",
    lineContains: "sendGhlEmail",
    channel: "email",
    category: "admin_gated",
    reason: "GhlEmailTransport.send() is a low-level transport adapter called exclusively through ChannelOrchestrator.sendEmail(), which applies the full compliance fence (global pause → DNC → contactability → consent) before delegating to any transport. Direct callers are prohibited by design.",
    reviewDate: "2026-08-08",
  },
  {
    file: "server/services/transports/ghl-sms-transport.ts",
    lineContains: "sendGhlSms",
    channel: "sms",
    category: "admin_gated",
    reason: "GhlSmsTransport.send() is a low-level transport adapter called exclusively through ChannelOrchestrator.sendSms(), which applies the full compliance fence (global pause → DNC → contactability → consent) before delegating to any transport. Direct callers are prohibited by design.",
    reviewDate: "2026-08-08",
  },
  // ── 2026-08-11 remediation batch ─────────────────────────────────────────
  {
    file: "server/services/ghl-enrollment-recovery.ts",
    lineContains: "await sendSmtpEmail({",
    channel: "email",
    category: "internal_admin",
    reason: "Admin alert on permanent GHL enrollment failure — sent to ADMIN_SEED_EMAIL only when a deferred GHL enrollment exhausts all retries and is permanently abandoned. Fire-and-forget; non-fatal. Never sent to prospects or merchants. ghl-enrollment-recovery.ts is also in PAUSE_CHECK_EXEMPTIONS (recovery path intentional bypass). Reviewed 2026-08-11.",
    reviewDate: "2026-08-11",
  },
  {
    file: "server/services/winback-outreach-engine.ts",
    lineContains: "await sendSmtpEmail({",
    channel: "email",
    category: "pipeline_gated",
    reason: "Win-back outreach email — runWinbackOutreachEngine() reads outboundGlobalPaused via storage at function entry and returns early if set; SMTP-preferred for CAN-SPAM compliance. Only sends to churned contacts who have not been contacted for 90+ days and have email consent. Global-pause gate is at function entry, not co-located with the send call (same architectural pattern as campaign-engine). Reviewed 2026-08-11.",
    reviewDate: "2026-08-11",
  },
  {
    file: "server/routes/campaigns.ts",
    lineContains: "await sendSmtpEmail({",
    channel: "email",
    category: "admin_gated",
    reason: "Sequence step test-send — POST /api/sequences/steps/test-send protected by isDashboardUser; sends a preview of a sequence email step to the authenticated user's own email address only. Never sent to contacts/prospects; purely an internal operator tool for reviewing template output before activation. Reviewed 2026-08-11.",
    reviewDate: "2026-08-11",
  },
  // ── 2026-08-12 remediation batch ─────────────────────────────────────────
  {
    file: "server/services/underwriting-checklist-service.ts",
    lineContains: "await sendSmtpEmail({",
    channel: "email",
    category: "transactional_merchant",
    reason: "Underwriting document request email — sent to the merchant when their deal enters an underwriting stage, listing the specific documents required to advance. Triggered once per deal by initUnderwritingConditions() (idempotent). Never bulk-sent; always tied to a specific deal transition. Reviewed 2026-08-12.",
    reviewDate: "2026-08-12",
  },
  {
    file: "server/routes/inbox.ts",
    lineContains: "await sendSmtpEmail({",
    channel: "email",
    category: "transactional_merchant",
    reason: "Inbox manual reply — rep-initiated SMTP reply to a specific contact from the CRM inbox UI. Triggered by explicit operator action on an existing conversation thread; never automated or bulk-sent. category field updated from cold_outreach → transactional_merchant to match intent. Reviewed 2026-08-12.",
    reviewDate: "2026-08-12",
  },
  {
    file: "server/services/post-enrichment-worker.ts",
    lineContains: "enrollContactInGhlWorkflow({",
    channel: "ringless_vm/workflow",
    category: "sequence_worker",
    reason: "Post-enrichment auto-advance — enrolls a newly enriched cold lead into a vertical sequence using email-only channel. Contactability is enforced INSIDE enrollContactInGhlWorkflow() via its own evaluateContactability() call (line 374 of ghl-workflow-enrollment.ts). The outer worker also gates on outboundGlobalPaused. Only fires once per deal (idempotency stamp at post_enrichment_automation_at). Reviewed 2026-08-12.",
    reviewDate: "2026-08-12",
  },
  // ── 2026-08-18 remediation batch ─────────────────────────────────────────
  {
    file: "server/services/serper-gateway.ts",
    lineContains: "sendSmtpEmail({ to, subject, html, category:",
    channel: "email",
    category: "internal_admin",
    reason: "SerperGateway alert email — sent ONLY to ADMIN_ALERT_EMAIL (operator-owned inbox) when the Serper budget is exhausted or the circuit breaker opens. Recipient is always a static operator address, never a prospect or merchant. Guarded by _claimAlertCooldown to prevent spam. Reviewed 2026-08-18.",
    reviewDate: "2026-08-18",
  },
];


/** Send function → channel mapping. */
const SEND_FUNCTIONS: Record<string, string> = {
  sendGhlSms: "sms",
  sendSmsReply: "sms",
  unifiedSendSms: "sms",
  triggerAiCall: "voice_ai",
  enrollContactInGhlWorkflow: "ringless_vm/workflow",
  triggerWorkflow: "workflow",
  sendGhlEmail: "email",
  sendGhlEmailForMerchant: "email",
  sendTemplatedMessage: "template",
  sendSmtpEmail: "email",
  sendEmailReply: "email",
  unifiedSendEmail: "email",
};

/** Directories to scan. */
const SCAN_DIRS = ["server/services", "server/routes"];

/** Skip these files entirely (test fixtures, scripts, migrations). */
const SKIP_PATTERNS = [/node_modules/, /\.d\.ts$/, /scripts\//, /migrations\//];

// ── Types ────────────────────────────────────────────────────────────────────

type EmailCategory = "marketing_outreach" | "sequence_step" | "transactional_merchant" | "internal_admin" | "unknown";

interface Finding {
  verdict: "PASS" | "FAIL";
  file: string;
  line: number;
  enclosingFunction: string;
  channel: string;
  emailCategory: EmailCategory | null;
  nearestGate: string;
  reason: string;
  suggestedFix: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function relPath(abs: string): string {
  return path.relative(process.cwd(), abs).replace(/\\/g, "/");
}

function isAllowlisted(rel: string): boolean {
  return ALLOWLISTED_FILES.has(rel);
}

function findCallSiteAllowlistEntry(rel: string, lineText: string) {
  return CALL_SITE_ALLOWLIST.find(
    e => e.file === rel && lineText.includes(e.lineContains)
  );
}

/**
 * Search upward from startLine for the nearest enclosing function/method name.
 * Returns "unknown" if no enclosing function found within 100 lines.
 */
function detectEnclosingFunction(lines: string[], callLineIdx: number): string {
  const FUNC_PATTERNS = [
    /async\s+function\s+(\w+)/,
    /function\s+(\w+)/,
    /(?:const|let|var)\s+(\w+)\s*=\s*async\s*\(/,
    /(?:const|let|var)\s+(\w+)\s*=\s*function/,
    /(?:const|let|var)\s+(\w+)\s*=\s*\(.*\)\s*=>/,
    /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
    /^\s*(?:async\s+)?(\w+)\s*\([^)]*\):\s*\w.*\{/,
  ];

  for (let i = callLineIdx; i >= 0 && i >= callLineIdx - 100; i--) {
    const line = lines[i];
    for (const pat of FUNC_PATTERNS) {
      const m = line.match(pat);
      if (m && m[1]) return m[1];
    }
  }
  return "unknown";
}

/**
 * Search within SCAN_RADIUS lines before the call site for an evaluateContactability call.
 * Returns the line number (1-based) and context if found, "none" otherwise.
 */
function findNearestGate(lines: string[], callLineIdx: number, SCAN_RADIUS = 120): string {
  const start = Math.max(0, callLineIdx - SCAN_RADIUS);
  for (let i = callLineIdx; i >= start; i--) {
    if (/evaluateContactability|checkBeforeSend|canEnrollContactInSequence|canSendWorkflowTemplate/.test(lines[i])) {
      return `line ${i + 1}: ${lines[i].trim().slice(0, 80)}`;
    }
  }
  return "none";
}

/**
 * Classify email category based on enclosing function name and file context.
 */
function classifyEmailCategory(
  funcName: string,
  relFile: string,
  lineText: string
): EmailCategory {
  const fn = funcName.toLowerCase();
  const file = relFile.toLowerCase();
  const line = lineText.toLowerCase();

  // Sequence step — inside sequence-worker or sequence execution context
  if (file.includes("sequence-worker") || line.includes("sequencestep") || fn.includes("runsequence") || fn.includes("executestep")) {
    return "sequence_step";
  }

  // Transactional merchant — named patterns for confirmations/portals
  if (
    fn.includes("welcome") || fn.includes("portal") || fn.includes("onboard") ||
    fn.includes("approval") || fn.includes("approved") || fn.includes("applicationstatus") ||
    fn.includes("merchantapplication") || fn.includes("sendmid") || fn.includes("midwelcome") ||
    fn.includes("proposal") || fn.includes("esign") || fn.includes("statement") ||
    fn.includes("invoice") || fn.includes("receipt") || fn.includes("confirmation") ||
    fn.includes("partner") || fn.includes("savings") || fn.includes("ratereview") ||
    fn.includes("ratechange") || fn.includes("notify") ||
    line.includes("transactional") || line.includes("confirmation email") ||
    file.includes("merchant-welcome") || file.includes("merchant-application") ||
    file.includes("co-branded-proposal") || file.includes("esign") ||
    file.includes("proposal-engine") || file.includes("partner-welcome") ||
    file.includes("statement-upload-chain") || file.includes("savings") ||
    file.includes("rate-review") || file.includes("/routes/partners")
  ) {
    return "transactional_merchant";
  }

  // Internal admin — alerts, digests, internal notifications, admin-only routes
  if (
    fn.includes("alert") || fn.includes("digest") || fn.includes("notify") ||
    fn.includes("internal") || fn.includes("admin") || fn.includes("operator") ||
    fn.includes("slack") || fn.includes("webhook") || fn.includes("anomaly") ||
    fn.includes("sla") || fn.includes("reconcil") || fn.includes("residual") ||
    file.includes("anomaly") || file.includes("digest") || file.includes("alert") ||
    file.includes("sla-worker") ||
    file.includes("/routes/activity") || file.includes("/routes/admin") ||
    file.includes("/routes/analytics") || file.includes("/routes/integrations") ||
    file.includes("/routes/notifications") || file.includes("/routes/residuals") ||
    file.includes("/routes/helpers")
  ) {
    return "internal_admin";
  }

  // Marketing outreach — SDR, campaign, outreach, sequence enrollment
  if (
    fn.includes("campaign") || fn.includes("outreach") || fn.includes("sdr") ||
    fn.includes("enroll") || fn.includes("send") || fn.includes("broadcast") ||
    file.includes("campaign") || file.includes("sdr") || file.includes("outreach") ||
    line.includes("marketing") || line.includes("outreach")
  ) {
    return "marketing_outreach";
  }

  // Default to unknown — requires manual classification via CALL_SITE_ALLOWLIST
  return "unknown";
}

// ── Scanner ──────────────────────────────────────────────────────────────────

function scanFile(absPath: string): Finding[] {
  const rel = relPath(absPath);
  if (SKIP_PATTERNS.some(p => p.test(rel))) return [];
  if (!rel.endsWith(".ts")) return [];

  const content = fs.readFileSync(absPath, "utf8");
  const lines = content.split("\n");
  const findings: Finding[] = [];

  for (const [funcName, channel] of Object.entries(SEND_FUNCTIONS)) {
    const callPattern = new RegExp(`\\b${funcName}\\s*\\(`);

    lines.forEach((line, idx) => {
      if (!callPattern.test(line)) return;

      // Skip comment lines
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) return;

      // Skip function definition lines — the scanner looks for call sites, not declarations
      if (new RegExp(`function\\s+${funcName}\\b`).test(line)) return;

      const lineNum = idx + 1;

      // PASS: call site is in a low-level sender wrapper allowlist file
      if (isAllowlisted(rel)) {
        findings.push({
          verdict: "PASS",
          file: rel,
          line: lineNum,
          enclosingFunction: detectEnclosingFunction(lines, idx),
          channel,
          emailCategory: null,
          nearestGate: "N/A — allowlisted sender wrapper",
          reason: `Allowlisted low-level sender wrapper: ${rel}`,
          suggestedFix: "No action required.",
        });
        return;
      }

      const enclosingFunction = detectEnclosingFunction(lines, idx);
      const nearestGate = findNearestGate(lines, idx);
      const isEmailChannel = channel.includes("email");
      const emailCategory: EmailCategory | null = isEmailChannel
        ? classifyEmailCategory(enclosingFunction, rel, line)
        : null;

      // Check per-call-site allowlist entries
      const allowlistEntry = findCallSiteAllowlistEntry(rel, line);
      if (allowlistEntry) {
        findings.push({
          verdict: "PASS",
          file: rel,
          line: lineNum,
          enclosingFunction,
          channel,
          emailCategory: (allowlistEntry.category === "admin_gated" ? "internal_admin"
            : allowlistEntry.category === "pipeline_gated" || allowlistEntry.category === "sequence_worker" ? "sequence_step"
            : allowlistEntry.category) as EmailCategory,
          nearestGate,
          reason: `Call-site allowlisted (reviewed ${allowlistEntry.reviewDate}): ${allowlistEntry.reason}`,
          suggestedFix: "No action required.",
        });
        return;
      }

      // FAIL: email channel without classification
      if (isEmailChannel && emailCategory === "unknown") {
        findings.push({
          verdict: "FAIL",
          file: rel,
          line: lineNum,
          enclosingFunction,
          channel,
          emailCategory: "unknown",
          nearestGate,
          reason: "Email send call site is UNKNOWN category — must be classified before release.",
          suggestedFix: `Classify as marketing_outreach/sequence_step/transactional_merchant/internal_admin. Add an entry to CALL_SITE_ALLOWLIST in scripts/compliance-scan.ts with file, lineContains, category, reason, reviewDate.`,
        });
        return;
      }

      // FAIL: marketing_outreach or sequence_step email without a visible gate.
      // All such sends must either have an evaluateContactability gate within 120 lines
      // OR an explicit CALL_SITE_ALLOWLIST entry (checked above). No file-level auto-pass.
      if (isEmailChannel && (emailCategory === "marketing_outreach" || emailCategory === "sequence_step")) {
        if (nearestGate === "none") {
          findings.push({
            verdict: "FAIL",
            file: rel,
            line: lineNum,
            enclosingFunction,
            channel,
            emailCategory,
            nearestGate,
            reason: `${emailCategory} email send lacks a visible evaluateContactability gate within 120 lines upstream and has no CALL_SITE_ALLOWLIST entry.`,
            suggestedFix: `Ensure evaluateContactability() is called before ${funcName}() in ${enclosingFunction}(), or add an explicit entry to CALL_SITE_ALLOWLIST in scripts/compliance-scan.ts with file, lineContains, channel, category, reason, and reviewDate.`,
          });
          return;
        }
      }

      // FAIL: any email send with no inline gate and no CALL_SITE_ALLOWLIST entry.
      // Every email send site must be explicitly reviewed — no file-level auto-pass.
      // (The CALL_SITE_ALLOWLIST check above returns PASS before reaching here for all reviewed sites;
      //  this block only fires for new/unreviewed sends.)
      if (isEmailChannel && nearestGate === "none") {
        findings.push({
          verdict: "FAIL",
          file: rel,
          line: lineNum,
          enclosingFunction,
          channel,
          emailCategory,
          nearestGate,
          reason: `Email send (${emailCategory ?? "unclassified"}) has no inline evaluateContactability gate and no CALL_SITE_ALLOWLIST entry. All email send sites must be explicitly reviewed.`,
          suggestedFix: `Add an explicit entry to CALL_SITE_ALLOWLIST in scripts/compliance-scan.ts with file="${rel}", lineContains (unique substring of the call line), channel, category (transactional_merchant|internal_admin|pipeline_gated|sequence_worker), reason, and reviewDate.`,
        });
        return;
      }

      // FAIL: non-email channels (SMS/voice/RVM/workflow) without a visible gate and no CALL_SITE_ALLOWLIST entry.
      // All send sites must have either an evaluateContactability gate in-scope OR an explicit CALL_SITE_ALLOWLIST entry.
      if (!isEmailChannel && nearestGate === "none") {
        findings.push({
          verdict: "FAIL",
          file: rel,
          line: lineNum,
          enclosingFunction,
          channel,
          emailCategory: null,
          nearestGate,
          reason: `${channel} send call has no visible evaluateContactability gate within 120 lines upstream and no CALL_SITE_ALLOWLIST entry.`,
          suggestedFix: `Add an explicit entry to CALL_SITE_ALLOWLIST in scripts/compliance-scan.ts with file="${rel}", lineContains (unique substring of the call line), channel="${channel}", category (admin_gated|transactional_merchant|pipeline_gated|sequence_worker), reason, and reviewDate — or add an evaluateContactability() call before ${funcName}().`,
        });
        return;
      }

      // PASS: gate found within scope (all remaining sends reached here with nearestGate !== "none")
      findings.push({
        verdict: "PASS",
        file: rel,
        line: lineNum,
        enclosingFunction,
        channel,
        emailCategory,
        nearestGate,
        reason: isEmailChannel
          ? `${emailCategory} email send — gate at ${nearestGate}`
          : `${channel} send — gate at ${nearestGate}`,
        suggestedFix: "No action required.",
      });
    });
  }

  return findings;
}

/**
 * Contactability is never an allowlisted exception. A true bypass weakens both
 * the orchestrator's arbitration and the canonical evaluator, so reject it
 * before per-call-site classifications can mask the architectural violation.
 */
function scanForbiddenContactabilityBypasses(absPath: string): Finding[] {
  const rel = relPath(absPath);
  if (SKIP_PATTERNS.some(p => p.test(rel)) || !rel.endsWith(".ts")) return [];
  const lines = fs.readFileSync(absPath, "utf8").split("\n");
  const findings: Finding[] = [];
  lines.forEach((line, idx) => {
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) return;
    if (!/\bskipContactabilityCheck\s*:\s*true\b/.test(line)) return;
    findings.push({
      verdict: "FAIL",
      file: rel,
      line: idx + 1,
      enclosingFunction: detectEnclosingFunction(lines, idx),
      channel: "all",
      emailCategory: null,
      nearestGate: "N/A — prohibited bypass",
      reason: "skipContactabilityCheck: true bypasses canonical contactability and communication arbitration",
      suggestedFix: "Remove the bypass. Route merchant-directed sends through ChannelOrchestrator with its mandatory contactability fence.",
    });
  });
  return findings;
}

function walkDir(dir: string): Finding[] {
  const results: Finding[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else if (entry.isFile()) {
      results.push(...scanFile(full), ...scanForbiddenContactabilityBypasses(full));
    }
  }
  return results;
}

// ── Architectural Boundary Check (Task #1531) ─────────────────────────────────
//
// Fails when any production module:
//   1. Uses `skipGlobalPauseCheck` (removed; must use pauseExceptionKey or
//      route through the versioned exception registry instead)
//   2. Imports a raw transport primitive outside an approved adapter boundary
//      without also importing from outbound-pause-authority (requires AuthorizedSendDecision)
//
// Transport adapter files are exempt (they ARE the boundary).

const BOUNDARY_ADAPTER_FILES = new Set([
  "server/services/ghl.ts",
  "server/services/smtp-email.ts",
  "server/services/gmail-oauth.ts",           // Gmail API transport boundary
  "server/services/sdr/ghl-client.ts",
  "server/services/ghl-workflow-enrollment.ts",
  "server/services/transports/ghl-email-transport.ts",
  "server/services/transports/ghl-sms-transport.ts",
  "server/services/transports/ghl-rvm-transport.ts",
  "server/services/transports/index.ts",
  "server/services/transports/sms-transport.ts",
  "server/services/transports/email-transport.ts",
  "server/services/channel-orchestrator.ts",
  "server/services/outbound-pause-authority.ts",
  "server/services/outbound-control-service.ts",
  "server/routes/social.ts",                     // LinkedIn publish boundary (gated inline)
  "server/services/content-scheduler.ts",        // LinkedIn auto-publish boundary (gated inline)
]);

/**
 * Raw provider-send sink patterns. Any production file that calls one of these
 * outside an approved adapter boundary must also import from
 * outbound-pause-authority (assertPauseAllowed / authorize) AND from
 * outbound-control-service (registerInflight / deregisterInflight).
 *
 * The adapter files in BOUNDARY_ADAPTER_FILES are exempt — they ARE the boundary.
 * Route files that contain a local ghlFetch helper AND only read (GET conversations)
 * are also excluded via the ROUTE_READ_ONLY_EXEMPTIONS set.
 */
const RAW_SEND_SINKS: Array<{ pattern: RegExp; label: string }> = [
  // Direct GHL conversation message POST (both location-scoped and SDR clients)
  { pattern: /sdrGhlFetch\s*\(\s*["'`]\/conversations\/messages["'`]/, label: "sdrGhlFetch(/conversations/messages)" },
  { pattern: /ghlFetch\s*\(\s*["'`]\/conversations\/messages["'`]/, label: "ghlFetch(/conversations/messages)" },
  // SDR workflow trigger
  { pattern: /sdrGhlFetch\s*\(.*\/workflow\//, label: "sdrGhlFetch(/workflow/)" },
  // Gmail API — delivers email via Google's transport
  { pattern: /gmail\.users\.messages\.send\s*\(/, label: "gmail.users.messages.send()" },
  // GHL document send — delivers a recipient-facing signing email
  { pattern: /ghlFetch\s*\(\s*["'`]\/documents\//, label: "ghlFetch(/documents/) — delivers signing email to recipient" },
  // LinkedIn API — public outbound content publish
  { pattern: /fetch\s*\(\s*["'`]https:\/\/api\.linkedin\.com\/v2\/ugcPosts["'`]/, label: "fetch(api.linkedin.com/v2/ugcPosts) — LinkedIn publish" },
  // ── Raw GHL mutation fetch() sinks (T-02, #1626) ──
  // Ungated raw fetch() calls to GHL mutation endpoints are provider
  // mutations and must be flagged unless per-call-site allowlisted.
  { pattern: /fetch\s*\(\s*["'`]https:\/\/services\.leadconnectorhq\.com\/contacts\/["'`]/, label: "raw fetch(GHL /contacts/ POST) — contact create" },
  { pattern: /fetch\s*\(\s*`https:\/\/services\.leadconnectorhq\.com\/contacts\/\$\{[^}]+\}`/, label: "raw fetch(GHL /contacts/:id) — contact PUT/DELETE" },
  { pattern: /fetch\s*\(\s*`https:\/\/services\.leadconnectorhq\.com\/contacts\/\$\{[^}]+\}\/tasks`/, label: "raw fetch(GHL /contacts/:id/tasks POST) — task create" },
  { pattern: /fetch\s*\(\s*["'`]https:\/\/services\.leadconnectorhq\.com\/opportunities\/["'`]/, label: "raw fetch(GHL /opportunities/ POST) — opportunity create" },
];

/** Files that provide ghlFetch as a READ-ONLY internal tool (no message sends). */
const ROUTE_READ_ONLY_FILES = new Set<string>([
  // add here if any route file uses a local ghlFetch only for reads
]);

/**
 * Approved upstream callers: files that invoke gated adapter functions
 * (sendGhlEmail, sendGhlSms, sendSmtpEmail, sendGmailEmail) and therefore
 * go through the pause authority gate transitively.  They must NOT call raw
 * provider sinks directly.  The check below verifies this property.
 */
const APPROVED_UPSTREAM_CALLERS = new Set([
  "server/services/ghl-workflow-enrollment.ts",
  "server/services/sdr/statement-flow.ts",
  "server/services/sdr/terminal-shipping.ts",
  "server/services/sdr/proposal-tracking.ts",
  "server/services/sdr/voice-orchestrator.ts",
  "server/services/campaign-engine.ts",
  "server/services/co-branded-proposal.ts",
  "server/services/proposal-engine.ts",
  "server/services/sla-worker.ts",
  "server/routes/activity.ts",
  "server/routes/contacts.ts",
  "server/routes/helpers.ts",
  "server/routes/integrations.ts",
  "server/routes/public.ts",
  "server/routes/savings.ts",
  "server/routes/wizard.ts",
]);

function checkArchitecturalBoundaries(): { passed: boolean; violations: string[] } {
  const violations: string[] = [];

  function walkForBoundary(dir: string, files: string[] = []): string[] {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walkForBoundary(full, files);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(full);
      }
    }
    return files;
  }

  const allFiles = [
    ...walkForBoundary("server/services"),
    ...walkForBoundary("server/routes"),
  ];

  for (const filePath of allFiles) {
    const rel = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
    if (BOUNDARY_ADAPTER_FILES.has(rel)) continue;
    if (ROUTE_READ_ONLY_FILES.has(rel)) continue;
    if (rel.endsWith(".d.ts")) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    // Check 1: skipGlobalPauseCheck must not appear in production code
    if (content.includes("skipGlobalPauseCheck")) {
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (line.includes("skipGlobalPauseCheck") && !/^\s*\/\//.test(line) && !/^\s*\*/.test(line)) {
          violations.push(
            `BOUNDARY VIOLATION: ${rel}:${idx + 1} — ` +
            `skipGlobalPauseCheck is removed (use pauseExceptionKey + versioned exception registry): ${line.trim().slice(0, 100)}`,
          );
        }
      });
    }

    // Check 2: Raw provider-send sink used without pause authority import
    for (const { pattern, label } of RAW_SEND_SINKS) {
      if (!pattern.test(content)) continue;

      // Check that this file imports from outbound-pause-authority
      const hasAuthorityImport =
        content.includes("outbound-pause-authority") ||
        content.includes("assertPauseAllowed");

      if (!hasAuthorityImport) {
        const lines = content.split("\n");
        lines.forEach((lineText, idx) => {
          if (pattern.test(lineText) && !/^\s*\/\//.test(lineText) && !/^\s*\*/.test(lineText)) {
            violations.push(
              `BOUNDARY VIOLATION: ${rel}:${idx + 1} — ` +
              `raw send sink "${label}" called without pause authority import ` +
              `(outbound-pause-authority must be imported and authorize()/assertPauseAllowed() must gate this call): ` +
              lineText.trim().slice(0, 120),
            );
          }
        });
      }
    }
  }

  // ── Check 3: Approved upstream callers must NOT call raw sinks directly ──────
  // They route through sendGhlEmail/sendGhlSms/sendSmtpEmail/sendGmailEmail
  // (gated adapters). Calling a raw sink directly in addition would bypass
  // the gate for that specific call, making their "transitive gate" claim false.
  for (const callerPath of APPROVED_UPSTREAM_CALLERS) {
    let callerContent: string;
    try {
      callerContent = fs.readFileSync(callerPath, "utf8");
    } catch {
      // File may not exist; skip
      continue;
    }
    for (const { pattern, label } of RAW_SEND_SINKS) {
      if (!pattern.test(callerContent)) continue;
      const lines = callerContent.split("\n");
      lines.forEach((lineText, idx) => {
        if (pattern.test(lineText) && !/^\s*\/\//.test(lineText) && !/^\s*\*/.test(lineText)) {
          violations.push(
            `APPROVED_CALLER VIOLATION: ${callerPath}:${idx + 1} — ` +
            `approved upstream caller calls raw send sink "${label}" directly ` +
            `(must only send through gated adapter functions): ` +
            lineText.trim().slice(0, 120),
          );
        }
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

// ── Route-level GHL mutation disposition check (C-04, #1629) ───────────────

function checkGhlRouteMutationGates(): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  const cache = new Map<string, string[]>();
  const coveredCallLines = new Set<string>();

  for (const entry of GHL_ROUTE_MUTATION_ALLOWLIST) {
    let lines = cache.get(entry.file);
    if (!lines) {
      if (!fs.existsSync(entry.file)) {
        violations.push(`GHL ROUTE GATE VIOLATION: reviewed file missing: ${entry.file}`);
        continue;
      }
      lines = fs.readFileSync(entry.file, "utf8").split("\n");
      cache.set(entry.file, lines);
    }

    const matches = lines
      .map((line, idx) => line.includes(entry.lineContains) ? idx : -1)
      .filter(idx => idx >= 0);
    const occurrence = entry.occurrence ?? 1;
    const callIdx = matches[occurrence - 1];
    if (callIdx === undefined) {
      violations.push(
        `GHL ROUTE GATE VIOLATION: ${entry.file} — reviewed call site not found ` +
        `(lineContains="${entry.lineContains}", occurrence=${occurrence})`,
      );
      continue;
    }
    coveredCallLines.add(`${entry.file}:${callIdx}`);

    const start = Math.max(0, callIdx - entry.maxLinesBetween);
    const gateIdx = lines
      .slice(start, callIdx)
      .map((line, offset) => line.includes(entry.gateContains) ? start + offset : -1)
      .filter(idx => idx >= 0)
      .pop();
    if (gateIdx === undefined) {
      violations.push(
        `GHL ROUTE GATE VIOLATION: ${entry.file}:${callIdx + 1} — ${entry.disposition} gate missing ` +
        `within ${entry.maxLinesBetween} lines (expected "${entry.gateContains}")`,
      );
      continue;
    }

    if (entry.disposition === "skip_auxiliary") {
      const guardedWindow = lines.slice(gateIdx, callIdx + 1).join("\n");
      if (!guardedWindow.includes("pauseDecision.allowed")) {
        violations.push(
          `GHL ROUTE GATE VIOLATION: ${entry.file}:${callIdx + 1} — auxiliary mutation is not inside an allowed-decision branch`,
        );
      }
    }
  }

  // Discovery check: adding another targeted helper call to any reviewed route
  // file without a reviewed entry must fail, rather than silently inheriting a
  // nearby gate or file-level exemption.
  const targetFiles = new Set(GHL_ROUTE_MUTATION_ALLOWLIST.map(entry => entry.file));
  const helperPattern = new RegExp(`\\b(?:${GHL_ROUTE_MUTATION_FUNCTIONS.join("|")})\\s*\\(`);
  for (const file of targetFiles) {
    const lines = cache.get(file) ?? fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) return;
      // Do not treat helper names mentioned in log/error strings as calls.
      const codeOnly = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
      if (!helperPattern.test(codeOnly)) return;
      if (!coveredCallLines.has(`${file}:${idx}`)) {
        violations.push(
          `GHL ROUTE GATE VIOLATION: ${file}:${idx + 1} — targeted mutation helper call has no reviewed per-call-site entry: ${line.trim().slice(0, 120)}`,
        );
      }
    });
  }

  return { passed: violations.length === 0, violations };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("=== Wave 12 Static Compliance Scanner ===\n");
  console.log("Scanning: " + SCAN_DIRS.join(", ") + "\n");

  // ── Merchant encryption key check (production release gate) ─────────────────
  // Validates that MERCHANT_DATA_ENCRYPTION_KEY is present and valid when
  // NODE_ENV=production. Dev builds are not blocked by a missing key.
  // The key value is NEVER printed.
  if (process.env.NODE_ENV === "production") {
    const merchantKey = (process.env.MERCHANT_DATA_ENCRYPTION_KEY ?? "").trim();
    const isValidHex = /^[0-9a-fA-F]{64}$/.test(merchantKey);
    const isValidB64 = !isValidHex && Buffer.from(merchantKey, "base64").length === 32 && merchantKey.length === 44;
    if (!merchantKey || (!isValidHex && !isValidB64)) {
      console.error("✗ MERCHANT KEY GATE: MERCHANT_DATA_ENCRYPTION_KEY is not set or invalid.");
      console.error("  Production releases require a valid 32-byte merchant encryption key.");
      console.error("  Expected: 64-char hex OR 44-char base64. Value is NOT printed.");
      console.error("  See docs/merchant-data-key-rotation.md for key generation guidance.");
      process.exit(1);
    }
    console.log("  ✓ MERCHANT_DATA_ENCRYPTION_KEY present and valid (value not printed)\n");
  } else {
    const merchantKey = (process.env.MERCHANT_DATA_ENCRYPTION_KEY ?? "").trim();
    if (merchantKey) {
      console.log("  ✓ MERCHANT_DATA_ENCRYPTION_KEY is set (dev/test mode — format not enforced)\n");
    } else {
      console.log("  ○ MERCHANT_DATA_ENCRYPTION_KEY not set (non-production — not required for dev build)\n");
    }
  }

  // ── Allowlist integrity check (T-02, #1626) ────────────────────────────────
  // Every allowlist entry must target a SPECIFIC call site via a non-trivial
  // lineContains substring. Whole-file coverage (empty/blank lineContains) is
  // forbidden — exit non-zero immediately.
  const badEntries = CALL_SITE_ALLOWLIST.filter(
    (e) => !e.lineContains || e.lineContains.trim().length < 5,
  );
  if (badEntries.length > 0) {
    console.error("✗ ALLOWLIST INTEGRITY FAILURE: entries below cover a whole file instead of a specific call site (lineContains missing or too broad):");
    for (const e of badEntries) console.error(`   - ${e.file} (lineContains="${e.lineContains}")`);
    process.exit(1);
  }
  const badGhlEntries = GHL_ROUTE_MUTATION_ALLOWLIST.filter(
    e => !e.lineContains || e.lineContains.trim().length < 8 || !e.gateContains || e.gateContains.trim().length < 8,
  );
  if (badGhlEntries.length > 0) {
    console.error("✗ GHL ROUTE ALLOWLIST INTEGRITY FAILURE: every entry needs a specific call and gate marker:");
    for (const e of badGhlEntries) console.error(`   - ${e.file} (call="${e.lineContains}", gate="${e.gateContains}")`);
    process.exit(1);
  }

  const allFindings: Finding[] = [];
  for (const dir of SCAN_DIRS) {
    allFindings.push(...walkDir(path.join(process.cwd(), dir)));
  }

  // De-duplicate by file+line+function
  const seen = new Set<string>();
  const findings = allFindings.filter(f => {
    const key = `${f.file}:${f.line}:${f.channel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const passes = findings.filter(f => f.verdict === "PASS");
  const failures = findings.filter(f => f.verdict === "FAIL");

  // Email classification summary
  const emailFindings = findings.filter(f => f.emailCategory);
  const byCat: Record<string, number> = {};
  emailFindings.forEach(f => {
    const cat = f.emailCategory ?? "unknown";
    byCat[cat] = (byCat[cat] ?? 0) + 1;
  });

  console.log("── Email Call-Site Classification Summary ───────────────────\n");
  for (const [cat, count] of Object.entries(byCat)) {
    const status = (cat === "marketing_outreach" || cat === "sequence_step")
      ? (failures.some(f => f.emailCategory === cat) ? "⚠ some FAIL" : "✓ gated")
      : "✓ allowlisted";
    console.log(`  ${cat.padEnd(30)} ${String(count).padStart(3)} sites  ${status}`);
  }

  console.log("\n── Allowlist Entries ──────────────────────────────────────────\n");
  const allowlistPasses = passes.filter(f => !isAllowlisted(f.file) && f.nearestGate === "N/A — allowlisted sender wrapper" || passes.filter(x => x.file === f.file && x.reason.includes("allowlisted")));
  const callSiteAllowlistEntries = CALL_SITE_ALLOWLIST;
  callSiteAllowlistEntries.forEach(e => {
    console.log(`  ✓ ${e.file} | ${e.channel} | ${e.category}`);
    console.log(`    Reason: ${e.reason}`);
    console.log(`    Review date: ${e.reviewDate}\n`);
  });
  ALLOWLISTED_FILES.forEach(f => {
    console.log(`  ✓ [sender wrapper] ${f} — all call sites in this file are intentional low-level sends`);
  });

  console.log("\n── All Findings ───────────────────────────────────────────────\n");
  for (const f of findings) {
    const cat = f.emailCategory ? ` | ${f.emailCategory}` : "";
    const gate = f.nearestGate !== "N/A — allowlisted sender wrapper" ? ` | gate: ${f.nearestGate.slice(0, 60)}` : "";
    console.log(`${f.verdict} | ${f.file}:${f.line} | ${f.enclosingFunction} | ${f.channel}${cat}${gate}`);
    if (f.verdict === "FAIL") {
      console.log(`  FAIL: ${f.reason}`);
      console.log(`  FIX:  ${f.suggestedFix}\n`);
    }
  }

  console.log(`\n── Summary ────────────────────────────────────────────────────\n`);
  console.log(`  Total call sites scanned: ${findings.length}`);
  console.log(`  PASS: ${passes.length}`);
  console.log(`  FAIL: ${failures.length}`);
  console.log(`  Email call sites classified: ${emailFindings.length}`);

  // ── Architectural boundary check ─────────────────────────────────────────
  console.log("\n── Architectural Boundary Check (pause authority) ─────────────────\n");
  const boundaryResult = checkArchitecturalBoundaries();
  if (boundaryResult.passed) {
    console.log("  ✓ No skipGlobalPauseCheck usage outside approved adapter files");
    console.log("  ✓ Architectural boundary: pause authority pattern enforced");
  } else {
    for (const v of boundaryResult.violations) {
      console.error(`  ✗ ${v}`);
    }
  }

  console.log("\n── GHL Route Mutation Pause Gates (C-04, #1629) ────────────────\n");
  const ghlRouteResult = checkGhlRouteMutationGates();
  if (ghlRouteResult.passed) {
    console.log(`  ✓ ${GHL_ROUTE_MUTATION_ALLOWLIST.length} reviewed GHL route mutation call sites retain their pause disposition`);
  } else {
    for (const v of ghlRouteResult.violations) console.error(`  ✗ ${v}`);
  }

  const totalFailures = failures.length
    + (boundaryResult.passed ? 0 : boundaryResult.violations.length)
    + (ghlRouteResult.passed ? 0 : ghlRouteResult.violations.length);

  if (totalFailures > 0) {
    console.error(
      `\n✗ Compliance scan FAILED: ${failures.length} call site(s) require remediation; ` +
      `${boundaryResult.violations.length} architectural boundary violation(s); ` +
      `${ghlRouteResult.violations.length} GHL route gate violation(s).`,
    );
    process.exit(1);
  } else {
    console.log(`\n✅ Compliance scan PASSED: all ${passes.length} call sites are properly gated or allowlisted.\n`);
    process.exit(0);
  }
}

main();
