/**
 * Final template preview certification (disposable database; no provider, no network, no sends).
 * F6: the preview returns the message as the send path assembles it (footer, plain text, sender facts) and says so
 * truthfully when the compliance prerequisites are missing.
 */
import assert from "node:assert/strict";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Template final preview certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const versions = await import("../../server/services/message-template-versions");
const { renderEmailPartsForPurpose } = await import("../../server/services/can-spam-footer");
const { buildGhlEmailPayload } = await import("../../server/services/ghl");
const { getEmailSignatureHtml } = await import("../../server/services/email-signatures");
const { inspectPresentation } = await import("../../server/services/email-presentation");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [TFP-${String(checks).padStart(2, "0")}] ${message}`); };

const body = `<p>Hi {{contact.firstName}},</p><img src="https://libertybancard.com/logo.png" alt="Liberty Bancard logo" width="140"/><p>Thanks.</p>`;

await pool.query(`DELETE FROM system_settings WHERE key='compliance_mailing_address'`);
const missing = await versions.previewTemplateFinal({ subject: "Hello", body, channel: "email" });
check(missing.final?.footer.state === "unavailable" && /COMPLIANCE_MAILING_ADDRESS_MISSING/.test(missing.final.footer.reason ?? ""), "Without a mailing address the preview says the footer cannot be built (a send would fail the same way)");

await storage.setSystemSetting("compliance_mailing_address", "1 Test Way, Testville, FL 00000");
const ok = await versions.previewTemplateFinal({ subject: "Hello", body, channel: "email" });
const f = ok.final!;
check(f.footer.state === "applied" && (f.html.match(/data-can-spam-footer/g) ?? []).length === 1, "The compliance footer is applied exactly once");
check((f.text.match(/\[CAN-SPAM-FOOTER\]/g) ?? []).length === 1 && /1 Test Way/.test(f.text), "The plain-text part carries the footer exactly once");
const direct = await renderEmailPartsForPurpose({ html: ok.html, purpose: "marketing_outreach", complianceLoader: async () => ({ ok: true, mailingAddress: "1 Test Way, Testville, FL 00000", unsubscribeUrl: "https://libertybancard.com/unsubscribe?t=SAMPLE-TOKEN" }) });
check(direct.html === f.html && direct.text === f.text, "The preview equals what the send-path renderer produces for the same inputs");
check(f.logoCount === 1 && !/<img/i.test(f.htmlImagesOff) && /\[image: Liberty Bancard logo\]/.test(f.htmlImagesOff), "Logo is counted once and the images-off view shows the alt text");
check(f.sender.mode === "unknown" && f.sender.address === null && f.replyTo.mode === "unknown" && f.replyTo.address === null, "Sender and Reply-To are shown as unknown rather than invented (the stored-template path does not choose them)");
check(f.transport.textTransmitted === false && f.transport.payloadFields.join(",") === "type,contactId,subject,html" && /HTML body only/.test(f.transport.note), "The text part is labelled generated reference text; the transport payload has no text field");
const payload = buildGhlEmailPayload({ ghlContactId: "G1", subject: "Hello", html: f.html });
check(payload.html === f.html && !("text" in payload) && !("emailFrom" in payload) && !("emailReplyTo" in payload), "The payload builder the transport uses carries exactly the previewed HTML and nothing else");
const withSender = buildGhlEmailPayload({ ghlContactId: "G1", subject: "Hello", html: "x", fromEmail: "a@x.test", fromName: "A", replyTo: "r@x.test" });
check(withSender.emailFrom === "A <a@x.test>" && withSender.emailReplyTo === "r@x.test", "Sender and Reply-To reach the payload only when the sending path supplies them");

// One signature, one logo, one footer even when the body arrives with a repeated signature block.
const sig = getEmailSignatureHtml("partners");
const dup = await versions.previewTemplateFinal({ subject: "Hello", body: `<p>Hello,</p>${sig}${sig}`, channel: "email" });
check(dup.final!.signatureCount === 1 && dup.final!.logoCount <= 1 && dup.final!.footerCount === 1, "A repeated signature collapses to one signature, at most one logo and one footer");
const marked = inspectPresentation(sig);
check(marked.signatureCount === 1 && marked.signatureKind === "marked", "The signature owner marks its block so it can be counted");

// Greeting: role mailbox inside an HTML paragraph reads "Hello,", a named person keeps their name.
const { renderMessage } = await import("../../server/services/message-token-registry");
const src = (firstName: string, email: string) => ({ contact: { firstName, lastName: "", email, phone: "5550100", companyName: "Orders Co", vertical: "retail" }, deal: { stage: "Proposal" }, calendarLink: "https://example.test/book" }) as any;
const roleCtx = src("", "orders@x.test");
const roleHtml = renderMessage("workflow", "<p>Hi {{contact.firstName}},</p><p>Body</p>", roleCtx, "html").output;
const namedHtml = renderMessage("workflow", "<p>Hi {{contact.firstName}},</p>", src("Dana", "dana@x.test"), "html").output;
check(roleHtml.startsWith("<p>Hello,</p>") && namedHtml === "<p>Hi Dana,</p>", "Role mailbox greeting is Hello, inside an HTML paragraph; a named person keeps their name");
const rolePlain = renderMessage("workflow", "Hi {{contact.firstName}},\nBody", roleCtx, "text").output;
check(rolePlain.startsWith("Hello,"), "Role mailbox greeting is Hello, in plain text");

// Workflow email steps get the same final view.
const wf = await (await import("../../server/services/workflow-email-wording")).previewWorkflowEmail({ subject: "S", body: "<p>Hi {{contact.firstName}},</p>" });
check(wf.final?.footer.state === "applied" && wf.final.footerCount === 1 && wf.final.transport.textTransmitted === false, "Workflow email preview returns the same final view (footer once, text labelled)");
const wfBad = await (await import("../../server/services/workflow-email-wording")).previewWorkflowEmail({ subject: "S", body: "<p>{{bogus.thing}}</p>" });
check(wfBad.final === null && wfBad.unresolved.length > 0, "A workflow step with an unsupported merge field has no final view and still reports the field");

const sms = await versions.previewTemplateFinal({ body: "Hi {{contact.firstName}}", channel: "sms" });
check(sms.final === null, "SMS has no email-final view");

await pool.query(`DELETE FROM system_settings WHERE key='compliance_mailing_address'`);
console.log(`TEMPLATE_FINAL_PREVIEW_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
