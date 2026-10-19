import crypto from "crypto";
import nodemailer from "nodemailer";
import { resolvePolicy, assertNotProhibitedSync, isProhibitedAddress } from "./sender-policy";
import type { MessageCategory } from "./sender-policy";
import { getCommercialComplianceConfig, renderEmailPartsForPurpose } from "./can-spam-footer";
import type { CommercialComplianceLoader } from "./can-spam-footer";
import { redactToken } from "./audit-sanitizer";
import { denyCro03OrCro08aForbiddenEffect as denyCro03cForbiddenEffect } from "./cro03/cro08a-effect-fence";

type SmtpTransporter = ReturnType<typeof nodemailer.createTransport>;
let transporter: SmtpTransporter | null = null;

export function logSmtpStartupWarning(): void {
  if (!isSmtpConfigured()) {
    console.warn(
      "[SMTP] ⚠️  SMTP is NOT configured. Transactional emails (proposals, merchant welcome, rep alerts) " +
      "will fall back to GHL or be silently skipped. " +
      "Set SMTP_HOST, SMTP_USER, and SMTP_PASS to enable direct email delivery.",
    );
  } else {
    console.log(
      `[SMTP] ✓ SMTP configured — host=${process.env.SMTP_HOST} port=${process.env.SMTP_PORT || 587} user=${process.env.SMTP_USER}`,
    );
  }
}

export function getSmtpStatus(): { configured: boolean; host: string | null; port: number; user: string | null; from: string | null } {
  return {
    configured: isSmtpConfigured(),
    host: process.env.SMTP_HOST || null,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    user: process.env.SMTP_USER || null,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
  };
}

function getTransporter(): SmtpTransporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return transporter;
}

export function isSmtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * #1249 — Probe the SMTP connection with a live verify() call (10s timeout).
 * Returns true when the transporter can reach the server, false otherwise.
 * Use before sending critical user-facing emails so we fail gracefully when
 * SMTP is temporarily down rather than queuing silently broken sends.
 */
export async function verifySmtpLive(): Promise<boolean> {
  if (!isSmtpConfigured()) return false;
  const t = getTransporter();
  if (!t) return false;
  try {
    await Promise.race([
      t.verify(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SMTP verify timeout")), 10_000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What is known about a send that did not succeed.
 *  - "unsent": refused before any bytes left this process, or rejected by the server before it accepted
 *    the message. Safe to treat as not delivered.
 *  - "uncertain": the connection failed after the message body was transmitted. The server may or may not
 *    have accepted it, so it must never be treated as unsent or retried automatically.
 */
export type SmtpSendOutcome = "sent" | "unsent" | "uncertain";
export interface SmtpSendResult { success: boolean; messageId?: string; error?: string; outcome?: SmtpSendOutcome }

/** Conservative: only errors that prove the message was not accepted are "unsent". */
export function classifySmtpFailure(err: any): SmtpSendOutcome {
  const command = String(err?.command ?? "").toUpperCase();
  const code = String(err?.code ?? "");
  const responseCode = Number(err?.responseCode);
  const beforeData = ["EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO", "API"].includes(command);
  if (code === "EAUTH" || code === "EENVELOPE" || code === "EMESSAGE" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EDNS") return "unsent";
  // nodemailer reports every connection-level failure, including a connection lost AFTER the body was sent, as
  // command "CONN". Only the connect-phase messages prove nothing was transmitted; anything else is uncertain.
  if (command === "CONN") {
    const message = String(err?.message ?? "");
    const errno = String(err?.errno ?? err?.syscall ?? "");
    return /^(Connection timeout|Greeting never received)/i.test(message)
      || ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(errno) ? "unsent" : "uncertain";
  }
  if (beforeData) return "unsent";
  // A reply to the end of DATA with a final 4xx/5xx status means the server declined the message.
  if (command.startsWith("DATA") && Number.isFinite(responseCode) && responseCode >= 400 && responseCode < 600) return "unsent";
  return "uncertain";
}

/** Public SMTP entry point. Failures carry an outcome so callers can tell "not sent" from "unknown". */
export async function sendSmtpEmail(params: Parameters<typeof sendSmtpEmailCore>[0]): Promise<SmtpSendResult> {
  const result = await sendSmtpEmailCore(params);
  if (result.success) return { ...result, outcome: "sent" };
  return { ...result, outcome: result.outcome ?? "unsent" };
}

/**
 * Send an email via SMTP.
 *
 * Sender resolution order (when `category` is supplied):
 *   1. From/Reply-To are resolved from the sender policy registry.
 *   2. The explicit `from` param is ignored — policy is authoritative.
 *
 * When `category` is absent (legacy callers still migrating):
 *   From resolves as: params.from → SMTP_FROM env → SMTP_USER env → "support@libertybancard.com"
 *   A deprecation warning is logged. Callers MUST be updated to pass `category`.
 *
 * Either way, the resolved From address is checked against the prohibition
 * guard — no-reply/noreply on any Liberty Bancard domain throws immediately.
 */
async function sendSmtpEmailCore(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Preferred: supply message category; From/Reply-To are resolved from the policy registry. */
  category?: MessageCategory;
  /**
   * @deprecated Pass `category` instead. Only used when `category` is absent.
   * Will be removed once all callers are updated.
   */
  from?: string;
  /**
   * Reply-To address override. When `category` is supplied, the policy's
   * replyTo is used automatically; this param is ignored. Only effective
   * for legacy callers that do not pass `category`.
   */
  replyTo?: string;
  /**
   * Fully-qualified mailto: and/or https:// unsubscribe URLs for the
   * List-Unsubscribe header (RFC 2369). Providing an https URL also enables
   * one-click unsubscribe (RFC 8058) via List-Unsubscribe-Post.
   */
  unsubscribeMailto?: string;
  unsubscribeUrl?: string;
  /**
   * DB contact ID used to generate a signed CAN-SPAM unsubscribe token.
   * When provided, the injected footer contains a functional `/unsubscribe?t=…`
   * link. When absent, a reply-to-unsubscribe instruction is used instead.
   */
  contactId?: number;
  commercialPurpose?: "marketing_outreach" | "transactional_response";
  inboundRequestId?: string;
  intendedRecipientContactId?: number;
  /**
   * Operator seed test only. Never a bypass: the transport re-verifies, from durable state, that this exact message
   * was claimed for the one mailbox the operator authorized. No contact exists for a seed, so it can never touch,
   * suppress or unsubscribe a prospect. The global pause authority below still applies.
   */
  seedTest?: { receiptKey: string; occurrenceId: string };
}): Promise<SmtpSendResult> {
  // CRO-03C initial-batch continuations are evidence-only. This is a canonical
  // SMTP boundary, so an inherited fence records and terminalizes the attempt.
  await denyCro03cForbiddenEffect("smtp_email");
  const isCommercial = params.category === "cold_outreach" || params.commercialPurpose === "marketing_outreach";
  let seedLoader: CommercialComplianceLoader | undefined;
  if (params.seedTest) {
    const { verifySeedTransportCapability } = await import("./sfp-seed-authority");
    const verdict = await verifySeedTransportCapability(params, params.seedTest);
    if (!verdict.ok) return { success: false, error: verdict.error, outcome: "unsent" };
    seedLoader = verdict.complianceLoader;
  }
  let rendered;
  try {
    rendered = await renderEmailPartsForPurpose({
      html: params.html,
      text: params.text,
      purpose: isCommercial ? "marketing_outreach" : "transactional_response",
      contactId: params.contactId,
      ...(seedLoader ? { complianceLoader: seedLoader } : {}),
    });
  } catch (error: any) {
    return { success: false, error: error.message ?? "COMPLIANCE_CONFIGURATION_UNAVAILABLE" };
  }
  // Final commercial classification boundary. No-contact exceptions are limited
  // to server-owned operational/security sender categories, never marketing.
  const serverOwnedNoContactCategories = new Set<MessageCategory>([
    "internal_ops", "security", "onboarding", "support", "partners",
  ]);
  if (seedLoader) {
    // Authorized by the verified seed capability above; a seed has no contact by construction.
  } else if (params.contactId) {
    try {
      const { authorizeCommercialUse } = await import("./commercial-resolution");
      const trustedTransactionalCategories = new Set<MessageCategory>([
        "security", "onboarding", "support", "partners",
      ]);
      const purpose = params.commercialPurpose ??
          (params.category && trustedTransactionalCategories.has(params.category)
            ? "transactional_response"
            : "marketing_outreach");
      const hasInboundBinding = purpose === "transactional_response"
        && !!params.inboundRequestId?.trim()
        && params.intendedRecipientContactId === params.contactId;
      const decision = await authorizeCommercialUse({
        subjectType: "contact",
        subjectId: params.contactId,
        effect: purpose === "marketing_outreach"
          ? "marketing_outreach"
          : hasInboundBinding ? "inbound_transactional_acknowledgement" : "account_transactional",
        inboundRequestId: hasInboundBinding ? params.inboundRequestId : undefined,
        intendedRecipientId: hasInboundBinding ? params.intendedRecipientContactId : undefined,
      });
      if (!decision.effectiveDecision.allowed) {
        return { success: false, error: decision.effectiveDecision.reasonCode };
      }
    } catch {
      return { success: false, error: "COMMERCIAL_CLASS_UNKNOWN" };
    }
  } else if (!params.category || !serverOwnedNoContactCategories.has(params.category)) {
    return { success: false, error: "COMMERCIAL_CLASS_UNKNOWN" };
  }
  // ── Unavoidable pause authority gate (transport boundary) ────────────────
  // Every SMTP send must clear the canonical pause authority BEFORE any
  // network I/O. This is the final enforcement boundary.
  try {
    const { authorize, recheckEpoch } = await import("./outbound-pause-authority");
    const { registerInflight, deregisterInflight } = await import("./outbound-control-service");
    const decision = await authorize({});
    if (!decision.allowed) {
      // C-16 (#1626): redact recipient and subject in operational logs
      console.warn(
        `[SMTP] Blocked by pause authority: ${decision.reasonCode} ` +
        `(subject=${redactToken(params.subject)}, to=${redactToken(params.to)})`,
      );
      return { success: false, error: `Outbound paused: ${decision.reasonCode}` };
    }
    const token = crypto.randomUUID();
    await registerInflight(token, decision.epoch);
    try {
      const epochOk = await recheckEpoch(decision.epoch);
      if (!epochOk) {
        return { success: false, error: "Outbound paused: epoch changed before send" };
      }
      return await _sendSmtpEmailInner({ ...params, html: rendered.html, text: rendered.text }, rendered.complianceConfig);
    } finally {
      deregisterInflight(token);
    }
  } catch (gateErr: any) {
    console.error(`[SMTP] Pause authority gate error — fail closed: ${gateErr.message}`);
    return { success: false, error: `Pause gate error: ${gateErr.message}` };
  }
}

async function _sendSmtpEmailInner(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  category?: import("./sender-policy").MessageCategory;
  from?: string;
  replyTo?: string;
  unsubscribeMailto?: string;
  unsubscribeUrl?: string;
  contactId?: number;
  commercialPurpose?: "marketing_outreach" | "transactional_response";
}, complianceConfig?: Awaited<ReturnType<typeof getCommercialComplianceConfig>>): Promise<SmtpSendResult> {
  const transport = getTransporter();
  if (!transport) {
    return { success: false, error: "SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)" };
  }

  let fromAddress: string;
  let replyToAddress: string | undefined;

  if (params.category) {
    const policy = resolvePolicy(params.category);
    fromAddress = policy.from;
    replyToAddress = policy.replyTo;
  } else {
    // Legacy path — warn and fall back
    console.warn(
      `[SMTP] sendSmtpEmail called without 'category' for subject=${redactToken(params.subject)} to=${redactToken(params.to)}. ` +
      "Pass a MessageCategory so From/Reply-To are resolved from the sender policy. " +
      "This fallback will be removed in a future release.",
    );
    fromAddress = params.from || process.env.SMTP_FROM || process.env.SMTP_USER || "support@libertybancard.com";
    replyToAddress = params.replyTo;
  }

  // Prohibition guard — fail closed, never silently substitute
  try {
    assertNotProhibitedSync(fromAddress, `SMTP sendSmtpEmail From (subject="${params.subject}")`);
    if (replyToAddress) {
      assertNotProhibitedSync(replyToAddress, `SMTP sendSmtpEmail Reply-To (subject="${params.subject}")`);
    }
  } catch (prohibitErr: any) {
    console.error(`[SMTP] ${prohibitErr.message}`);
    return { success: false, error: prohibitErr.message };
  }

  const isCommercial = params.category === "cold_outreach" || params.commercialPurpose === "marketing_outreach";
  const listUnsubscribeParts: string[] = [];
  if (isCommercial && complianceConfig?.ok) {
    listUnsubscribeParts.push(`<${complianceConfig.unsubscribeUrl}>`);
  } else {
    if (params.unsubscribeMailto) listUnsubscribeParts.push(`<mailto:${params.unsubscribeMailto}>`);
    if (params.unsubscribeUrl) listUnsubscribeParts.push(`<${params.unsubscribeUrl}>`);
  }

  const headers: Record<string, string> = {};
  if (listUnsubscribeParts.length > 0) {
    headers["List-Unsubscribe"] = listUnsubscribeParts.join(", ");
  }
  if ((isCommercial && complianceConfig?.ok) || params.unsubscribeUrl) {
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  // Test-mode recipient override — set EMAIL_OVERRIDE_TO to redirect all mail to one address
  const overrideTo = process.env.EMAIL_OVERRIDE_TO?.trim();
  const effectiveTo = overrideTo || params.to;
  const effectiveSubject = overrideTo
    ? `[TEST → ${params.to}] ${params.subject}`
    : params.subject;
  if (overrideTo) {
    console.log(`[SMTP] EMAIL_OVERRIDE_TO active — redirecting to ${redactToken(overrideTo)} (original: ${redactToken(params.to)})`);
  }

  try {
    const info = await transport.sendMail({
      from: fromAddress,
      to: effectiveTo,
      subject: effectiveSubject,
      html: params.html,
      text: params.text,
      ...(replyToAddress ? { replyTo: replyToAddress } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });

    console.log(`[SMTP] Email sent to ${redactToken(effectiveTo)} from ${fromAddress} — messageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId, outcome: "sent" };
  } catch (err: any) {
    console.error(`[SMTP] Failed to send email to ${redactToken(params.to)}:`, err.message);
    return { success: false, error: err.message, outcome: classifySmtpFailure(err) };
  }
}
