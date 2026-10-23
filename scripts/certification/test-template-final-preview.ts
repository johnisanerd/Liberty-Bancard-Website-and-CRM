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
check(/does not choose a From/.test(f.sender.note) && f.replyTo.mode === "not_forwarded", "Sender and Reply-To state what the stored-template path really does");
const sms = await versions.previewTemplateFinal({ body: "Hi {{contact.firstName}}", channel: "sms" });
check(sms.final === null, "SMS has no email-final view");

await pool.query(`DELETE FROM system_settings WHERE key='compliance_mailing_address'`);
console.log(`TEMPLATE_FINAL_PREVIEW_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
