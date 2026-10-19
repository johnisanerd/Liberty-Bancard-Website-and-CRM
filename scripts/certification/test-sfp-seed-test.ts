/**
 * SFP operator seed-test certification (disposable PostgreSQL + local fake SMTP server only).
 *
 * Proves the seed send path end to end without any real message: the real renderer, the real SMTP service and the
 * real compliance footer/headers, against a fake mail server. Nothing leaves the machine and no provider is called.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary, getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "SFP seed test certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });

interface Captured { rcpt: string[]; data: string }
const captured: Captured[] = [];
let smtpMode: "ok" | "reject" | "drop" = "ok";
const smtp = net.createServer((sock) => {
  let inData = false; let buf = ""; let cur: Captured = { rcpt: [], data: "" };
  sock.on("error", () => {});
  sock.write("220 fake ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        cur.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
        if (smtpMode === "reject") { sock.write("554 rejected\r\n"); cur = { rcpt: [], data: "" }; continue; }
        if (smtpMode === "drop") { captured.push(cur); sock.destroy(); return; }
        captured.push(cur); cur = { rcpt: [], data: "" };
        sock.write("250 OK queued\r\n"); continue;
      }
      const nl = buf.indexOf("\r\n"); if (nl < 0) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO")) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
      else if (cmd.startsWith("AUTH")) sock.write("235 ok\r\n");
      else if (cmd.startsWith("RCPT TO")) { cur.rcpt.push(line.toLowerCase()); sock.write("250 OK\r\n"); }
      else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
      else if (cmd.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 OK\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
process.env.SMTP_HOST = "127.0.0.1"; process.env.SMTP_PORT = String((smtp.address() as net.AddressInfo).port);
process.env.SMTP_USER = "cert"; process.env.SMTP_PASS = "cert";
process.env.APP_URL = "https://liberty.example.test";
process.env.UNSUBSCRIBE_TOKEN_SECRET ||= "cert-unsubscribe-secret-0123456789abcdef";
delete process.env.EMAIL_OVERRIDE_TO;

const { pool, db } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const seed = await import("../../server/services/sfp-seed-test");
const authority = await import("../../server/services/sfp-seed-authority");
const { sendSmtpEmail } = await import("../../server/services/smtp-email");
const content = await import("../../server/services/cro03/sfp-launch-content");
const { computeLivePackageContentHash } = await import("../../server/services/cro03/sfp-campaign-packages");
const tokens = await import("../../server/services/unsubscribe-token");
const { COLD_OUTREACH_FROM } = await import("../../server/services/sender-policy");
const pauseAuthority = await import("../../server/services/outbound-pause-authority");

const prefix = `cert_seed_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };
const one = async (q: string, p: unknown[] = []) => (await pool.query(q, p)).rows[0];
const count = async (table: string) => Number((await one(`SELECT count(*) c FROM ${table}`)).c);
const expectError = async (work: () => Promise<unknown>, code: string, message: string) => {
  try { await work(); } catch (error: any) { check(error?.code === code, `${message} (got ${error?.code ?? error?.message})`); return; }
  assert.fail(`${message}: expected ${code}`);
};

async function setPause(state: "paused" | "unpaused") {
  await pool.query(`DELETE FROM outbound_pause_control`);
  await pool.query(`INSERT INTO outbound_pause_control(state,reason,epoch,actor) VALUES($1,'cert',1,'cert')`, [state]);
  pauseAuthority.invalidatePauseStateCache();
}

// ── Decode the captured MIME so the assertions read what a recipient's client would show ──────────────────────
function decodeBody(headers: string, body: string): string {
  const cte = /content-transfer-encoding:\s*(\S+)/i.exec(headers)?.[1]?.toLowerCase();
  if (cte === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (cte === "quoted-printable") {
    const unfolded = body.replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < unfolded.length; i++) {
      if (unfolded[i] === "=" && /^[0-9A-F]{2}$/i.test(unfolded.slice(i + 1, i + 3))) { bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(...Buffer.from(unfolded[i], "utf8"));
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return body;
}
function parseMessage(raw: string) {
  const split = raw.indexOf("\r\n\r\n");
  const headerText = raw.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const bodyText = raw.slice(split + 4);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(headerText)?.[1];
  const texts: string[] = [];
  if (boundary) {
    for (const part of bodyText.split(`--${boundary}`)) {
      const at = part.indexOf("\r\n\r\n"); if (at < 0) continue;
      texts.push(decodeBody(part.slice(0, at), part.slice(at + 4)));
    }
  } else texts.push(decodeBody(headerText, bodyText));
  const header = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(headerText)?.[1]?.trim() ?? null;
  return { headerText, header, all: texts.join("\n") };
}

await setPause("paused");
// ── Fixture: a current launch package, plus one real-looking prospect that must stay untouched ─────────────
const packageKey = "sfp.automotive.v2";
const sequenceId = Number((await pool.query(`INSERT INTO follow_up_sequences
  (name,status,trigger_type,trigger_config,sequence_family,total_steps) VALUES($1,'paused','contact_created','{}'::jsonb,'sfp-v2-cold-automotive',3) RETURNING id`,
  [`${prefix}_seq`])).rows[0].id);
const campaignId = Number((await pool.query(`INSERT INTO campaigns (name,status,total_steps,created_by) VALUES($1,'draft',3,'cert') RETURNING id`, [`${prefix}_campaign`])).rows[0].id);
for (const d of content.buildLaunchStepDrafts(packageKey)) {
  await pool.query(`INSERT INTO sequence_steps (sequence_id,step_order,action_type,delay_days,delay_hours,subject,body,config)
    VALUES($1,$2,'email',$3,0,$4,$5,'{"format":"plain_text"}'::jsonb)`, [sequenceId, d.stepOrder, d.delayDays, d.subject, d.body]);
  await pool.query(`INSERT INTO campaign_steps (campaign_id,step_order,step_type,delay_days,subject,body_template,channel)
    VALUES($1,$2,'follow_up',$3,$4,$5,'email')`, [campaignId, d.stepOrder, d.delayDays, d.subject, d.body]);
}
const hash = await computeLivePackageContentHash(db, campaignId, sequenceId);
await pool.query(`INSERT INTO sfp_campaign_package_versions
  (package_key,vertical,campaign_id,campaign_name,sequence_id,sequence_name,sequence_family,content_hash,lifecycle_state,effective_at,actor_id)
  SELECT $1,'Automotive',$2,c.name,$3,s.name,s.sequence_family,$4,'current',NOW(),'cert' FROM campaigns c, follow_up_sequences s WHERE c.id=$2 AND s.id=$3`,
  [packageKey, campaignId, sequenceId, hash]);
await storage.setSystemSetting("compliance_mailing_address", "100 Test Way, Miami, FL 33130");
const prospectEmail = `${prefix}.prospect@example.test`;
const prospectId = Number((await pool.query(`INSERT INTO contacts (first_name,last_name,email,phone,record_class,company_name) VALUES('Pat','Prospect',$1,$2,'production',$3) RETURNING id`,
  [prospectEmail, `+1305${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`, `${prefix} Prospect Co`])).rows[0].id);

const mailbox = `${prefix}.seedbox@example.test`;
for (const key of ["emailChannelPaused", "coldEmailChannelPaused", "smsChannelPaused"]) await storage.setSystemSetting(key, true);
// A parked enrollment exactly like the ones a global unpause would reactivate. It must stay parked.
const parkedId = Number((await pool.query(`INSERT INTO sequence_enrollments (contact_id,sequence_id,status,current_step,metadata)
  VALUES($1,$2,'paused',0,'{"_globalPauseBlockReason":"global_paused","_globalPauseBlockStep":1}'::jsonb) RETURNING id`, [prospectId, sequenceId])).rows[0].id);
const snapshot = async () => ({
  contacts: await count("contacts"), enrollments: await count("sequence_enrollments"), intents: await count("cr04_enrollment_intents"),
  sendLog: await count("outbound_send_log"), counters: await count("outbound_send_counters"),
  consent: await one(`SELECT count(*) c FROM audit_logs WHERE action LIKE 'contact_email_unsubscribed%'`).then(r => Number(r.c)),
  prospect: (await one(`SELECT email_status, opted_out_email, do_not_contact FROM contacts WHERE id=$1`, [prospectId])),
  pause: await one(`SELECT state, reason, epoch::text, actor FROM outbound_pause_control`),
  pauseAudit: await count("outbound_pause_audit"),
  channelFlags: (await pool.query(`SELECT key, value FROM system_settings WHERE key IN ('emailChannelPaused','coldEmailChannelPaused','smsChannelPaused') ORDER BY key`)).rows,
  sequenceStatus: await one(`SELECT status FROM follow_up_sequences WHERE id=$1`, [sequenceId]),
  parked: await one(`SELECT status, metadata FROM sequence_enrollments WHERE id=$1`, [parkedId]),
  holds: await count("logical_job_control_holds"),
});
const before = await snapshot();

// ═══ 1. Authorization rules ═══════════════════════════════════════════════════════════════════════════════
await expectError(() => seed.authorizeSeedMailbox({ mailbox: "not-an-email", actorId: "cert" }), "SEED_MAILBOX_INVALID", "A malformed mailbox is refused");
await expectError(() => seed.authorizeSeedMailbox({ mailbox: prospectEmail.toUpperCase(), actorId: "cert" }), "SEED_MAILBOX_IS_A_CONTACT", "An existing prospect's address can never be a seed mailbox");
await expectError(() => seed.authorizeSeedMailbox({ mailbox, expiresInHours: 99, actorId: "cert" }), "SEED_EXPIRY_OUT_OF_RANGE", "The authorization window is bounded");
await expectError(() => seed.authorizeSeedMailbox({ mailbox, maxMessages: 10, actorId: "cert" }), "SEED_MESSAGE_LIMIT_OUT_OF_RANGE", "The message count is bounded");
await expectError(() => seed.previewSeedSend({ packageKey, stepOrder: 1 }), "SEED_NOT_AUTHORIZED", "Nothing can be previewed or sent before an explicit authorization");

// Transport-level refusal with no authorization: a forged capability cannot send, whatever the caller says.
const forged = await sendSmtpEmail({ to: mailbox, subject: "x", html: "<p>x</p>", category: "cold_outreach",
  seedTest: { receiptKey: "sfp_seed_test_receipt:forged", occurrenceId: randomUUID() } });
check(!forged.success && forged.error === "SEED_NOT_AUTHORIZED" && captured.length === 0, "The transport refuses a seed capability when nothing is authorized");
const plain = await sendSmtpEmail({ to: mailbox, subject: "x", html: "<p>x</p>", category: "cold_outreach" });
check(!plain.success && /COMMERCIAL_(CONTACT_REQUIRED|CLASS_UNKNOWN)/.test(plain.error ?? "") && captured.length === 0, "Ordinary cold outreach with no contact is still refused by the transport");

const auth = await seed.authorizeSeedMailbox({ mailbox: mailbox.toUpperCase(), maxMessages: 2, expiresInHours: 2, actorId: "cert" });
check(auth.mailbox === mailbox && auth.maxMessages === 2 && !auth.revokedAt, "The mailbox is normalized and authorized with its own message limit");

// ═══ 2. The global pause is on: ordinary senders stay blocked ═════════════════════════════════════════════
let preview = await seed.previewSeedSend({ packageKey, stepOrder: 1 });
check(preview.outboundPause.allowed === false && preview.outboundPause.seedLease.eligible === true && preview.mailbox === mailbox
  && preview.fromAddress.toLowerCase() === COLD_OUTREACH_FROM.toLowerCase(), "The preview names the mailbox and cold sender, and shows ordinary sending blocked with a seed lease available");
check(preview.unresolvedPlaceholders.length === 0 && preview.subject.length > 0, "The preview renders every placeholder");
const ordinaryOps = await sendSmtpEmail({ to: mailbox, subject: "x", html: "<p>x</p>", category: "internal_ops" });
check(!ordinaryOps.success && /Outbound paused: global_paused/.test(ordinaryOps.error ?? "") && captured.length === 0, "An ordinary operational send is blocked by the global pause");
const ordinaryContact = await sendSmtpEmail({ to: prospectEmail, subject: "x", html: "<p>x</p>", category: "cold_outreach", contactId: prospectId });
check(!ordinaryContact.success && captured.length === 0, "An ordinary cold send to a prospect is blocked");
const ordinaryAuthorize = await pauseAuthority.authorize({ exceptionKey: "sfp_seed_test" });
check(!ordinaryAuthorize.allowed && pauseAuthority.resolveException("sfp_seed_test") === null, "The ordinary authority has no seed exception: a category, key or parameter cannot acquire seed authority");

// Direct lease tests with a hand-made claimed receipt (the seed service is the only writer of real ones).
const directKey = authority.seedReceiptKey("direct");
const directOccurrence = randomUUID();
const msgX = { subject: "x", html: "<p>x</p>" };
const claimDirect = async (over: Record<string, unknown> = {}) => {
  await pool.query(`DELETE FROM system_settings WHERE key=$1`, [directKey]);
  await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())`, [directKey, JSON.stringify({
    state: "claimed", mailboxHash: auth.mailboxHash, occurrenceId: directOccurrence, requestFingerprint: "x", packageKey, stepOrder: 1,
    subjectHash: "x", bodyHash: "x", messageHash: authority.seedMessageHash(msgX.subject, msgX.html), previewHash: "x",
    claimedAt: new Date().toISOString(), finishedAt: null, messageId: null, error: null, actorId: "cert", ...over })]);
};
const leaseReq = (over: Record<string, unknown> = {}) => ({ to: mailbox, ...msgX, category: "cold_outreach", receiptKey: directKey, occurrenceId: directOccurrence, ...over });
const receiptState = async () => (await one(`SELECT value->>'state' s FROM system_settings WHERE key=$1`, [directKey])).s;
await claimDirect();
check((await pauseAuthority.authorizeSeedSend(leaseReq({ to: "someone.else@example.test" }))).error === "SEED_RECIPIENT_NOT_THE_AUTHORIZED_MAILBOX", "The lease is refused for any other recipient");
check((await pauseAuthority.authorizeSeedSend(leaseReq({ subject: "changed" }))).error === "SEED_MESSAGE_NOT_THE_APPROVED_MESSAGE", "The lease is refused for a different subject");
check((await pauseAuthority.authorizeSeedSend(leaseReq({ html: "<p>x</p><p>extra</p>" }))).error === "SEED_MESSAGE_NOT_THE_APPROVED_MESSAGE", "The lease is refused for a different body");
check((await pauseAuthority.authorizeSeedSend(leaseReq({ text: "plain" }))).error === "SEED_MESSAGE_NOT_THE_APPROVED_MESSAGE", "The lease is refused when extra content is added");
check((await pauseAuthority.authorizeSeedSend(leaseReq({ contactId: prospectId }))).error === "SEED_MUST_NOT_REFERENCE_A_CONTACT", "The lease is refused when a contact is attached");
check((await pauseAuthority.authorizeSeedSend(leaseReq({ category: "support" }))).error === "SEED_CATEGORY_MUST_BE_COLD_OUTREACH", "The lease is refused for any other sender category");
check((await receiptState()) === "claimed", "Refused lease requests do not consume the claim");
// Pause-state edge cases: mid-activation and unreadable pause state never grant a lease.
const pauseRow = await one(`SELECT state, reason, epoch::text, actor FROM outbound_pause_control`);
await pool.query(`UPDATE outbound_pause_control SET state='activating'`); pauseAuthority.invalidatePauseStateCache();
const activating = await pauseAuthority.authorizeSeedSend(leaseReq());
check(!activating.allowed && activating.reasonCode === "activating" && (await receiptState()) === "claimed", "No lease is granted while the pause is activating");
await expectError(() => seed.executeSeedSend({ packageKey, stepOrder: 1, previewHash: preview.previewHash, idempotencyKey: randomUUID(), actorId: "cert" }),
  "SEED_PAUSE_STATE_UNAVAILABLE", "The seed service refuses before claiming when the pause state cannot back a lease");
await pool.query(`DELETE FROM outbound_pause_control`); pauseAuthority.invalidatePauseStateCache();
const unreadable = await pauseAuthority.authorizeSeedSend(leaseReq());
check(!unreadable.allowed && unreadable.reasonCode === "safe_default", "No lease is granted when the pause row is missing (fail closed)");
await pool.query(`INSERT INTO outbound_pause_control(state,reason,epoch,actor) VALUES($1,$2,$3,$4)`, [pauseRow.state, pauseRow.reason, pauseRow.epoch, pauseRow.actor]);
pauseAuthority.invalidatePauseStateCache();
check(Number((await one(`SELECT count(*) c FROM system_settings WHERE key LIKE 'sfp_seed_test_receipt:%' AND key<>$1`, [directKey])).c) === 0, "Refused attempts left no real receipt");
// Claim lease expiry and single use.
await claimDirect({ claimedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
check((await pauseAuthority.authorizeSeedSend(leaseReq())).error === "SEED_CLAIM_EXPIRED", "A claim that was never used expires");
await claimDirect();
const racers = await Promise.all([pauseAuthority.authorizeSeedSend(leaseReq()), pauseAuthority.authorizeSeedSend(leaseReq()), pauseAuthority.authorizeSeedSend(leaseReq())]);
check(racers.filter(r => r.allowed).length === 1 && racers.find(r => r.allowed)?.reasonCode === "seed_lease", "Three concurrent requests for one claim grant exactly one seed lease, under the global pause");
check((await receiptState()) === "sending" && !(await pauseAuthority.authorizeSeedSend(leaseReq())).allowed, "A consumed claim can never authorize another send");
check(captured.length === 0, "Lease decisions alone sent nothing");
await pool.query(`DELETE FROM system_settings WHERE key=$1`, [directKey]);

// ═══ 3. Transport refuses misuse of a valid capability ════════════════════════════════════════════════════
await claimDirect();
const cap = { receiptKey: directKey, occurrenceId: directOccurrence };
const base = { ...msgX, category: "cold_outreach" as const, seedTest: cap };
check((await sendSmtpEmail({ ...base, to: "someone.else@example.test" })).error === "SEED_RECIPIENT_NOT_THE_AUTHORIZED_MAILBOX", "The transport refuses a different recipient");
check((await sendSmtpEmail({ ...base, to: prospectEmail })).error === "SEED_RECIPIENT_NOT_THE_AUTHORIZED_MAILBOX", "The transport refuses a real prospect's address");
check((await sendSmtpEmail({ ...base, to: mailbox, contactId: prospectId })).error === "SEED_MUST_NOT_REFERENCE_A_CONTACT", "A seed can never be attached to a contact");
check((await sendSmtpEmail({ ...base, to: mailbox, category: "support" })).error === "SEED_CATEGORY_MUST_BE_COLD_OUTREACH", "Only the cold-outreach sender is used");
check((await sendSmtpEmail({ ...base, to: mailbox, subject: "other" })).error === "SEED_MESSAGE_NOT_THE_APPROVED_MESSAGE", "The transport refuses a message that is not the approved one");
check((await sendSmtpEmail({ ...base, to: mailbox, seedTest: { ...cap, occurrenceId: randomUUID() } })).error === "SEED_RECEIPT_MISMATCH", "A receipt for a different occurrence is refused");
check((await sendSmtpEmail({ ...base, to: mailbox, seedTest: { ...cap, receiptKey: authority.seedReceiptKey("missing") } })).error === "SEED_RECEIPT_NOT_CLAIMED", "An unclaimed receipt is refused");
process.env.EMAIL_OVERRIDE_TO = "redirect@example.test";
check((await sendSmtpEmail({ ...base, to: mailbox })).error === "SEED_REFUSED_WHILE_DELIVERY_REDIRECT_ACTIVE", "A seed is never silently redirected by the global delivery override");
delete process.env.EMAIL_OVERRIDE_TO;
check(captured.length === 0 && (await receiptState()) === "claimed", "None of the refused misuse attempts reached the mail server or consumed the claim");
await pool.query(`DELETE FROM system_settings WHERE key=$1`, [directKey]);
// Revocation after a claim still stops the lease.
const revokedAuth = await seed.authorizeSeedMailbox({ mailbox, actorId: "cert" });
await claimDirect({ mailboxHash: revokedAuth.mailboxHash });
await seed.revokeSeedMailbox();
check((await pauseAuthority.authorizeSeedSend(leaseReq())).error === "SEED_AUTHORIZATION_REVOKED", "Revoking the authorization ends a claimed but unused lease");
await pool.query(`DELETE FROM system_settings WHERE key=$1`, [directKey]);
const authAfterRevoke = await seed.authorizeSeedMailbox({ mailbox: mailbox.toUpperCase(), maxMessages: 2, expiresInHours: 2, actorId: "cert" });
check(authAfterRevoke.mailboxHash === auth.mailboxHash && authAfterRevoke.nonce !== auth.nonce, "A fresh authorization replaces the revoked one");
preview = await seed.previewSeedSend({ packageKey, stepOrder: 1 });
const key1 = randomUUID();

// ═══ 4. The real seed send ════════════════════════════════════════════════════════════════════════════════
await expectError(() => seed.executeSeedSend({ packageKey, stepOrder: 1, previewHash: "0".repeat(64), idempotencyKey: randomUUID(), actorId: "cert" }),
  "SEED_PREVIEW_CHANGED", "A send must carry the hash of the exact message that was previewed");
await expectError(() => seed.executeSeedSend({ packageKey, stepOrder: 1, previewHash: preview.previewHash, idempotencyKey: "not-a-uuid", actorId: "cert" }),
  "SEED_IDEMPOTENCY_KEY_REQUIRED", "A send requires an idempotency key");
const sent = await seed.executeSeedSend({ packageKey, stepOrder: 1, previewHash: preview.previewHash, idempotencyKey: key1, actorId: "cert" });
check(sent.receipt.state === "sent" && !sent.replayed && captured.length === 1, "The seed message is accepted by the (fake) mail server exactly once");
const msg = parseMessage(captured[0].data);
check(captured[0].rcpt.length === 1 && captured[0].rcpt[0].includes(mailbox), "Its only recipient is the authorized mailbox");
check(msg.header("From")?.toLowerCase().includes(COLD_OUTREACH_FROM.toLowerCase()), "It is sent from the actual cold sender");
check(msg.all.includes(preview.subject) || msg.header("Subject")?.includes(preview.subject.slice(0, 12)), "It carries the rendered subject");
const plainBody = preview.html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
check(msg.all.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").includes(plainBody), "It carries the same rendered body the sequence worker would send");
check(/data-can-spam-footer/.test(msg.all) && msg.all.includes("100 Test Way, Miami, FL 33130") && msg.all.includes("Commercial message from Liberty Bancard"), "The transport added the compliance footer and mailing address");
// Finished customer format: exactly the sequence worker's rendering, through the real transport.
const norm = msg.all.replace(/\r\n/g, "\n");
const occurs = (re: RegExp) => (norm.match(re) ?? []).length;
check(/^"?Scott Stevenson"?\s*</.test(msg.header("From") ?? ""), "The From display name is Scott Stevenson");
check(occurs(/data-sfp-signature/g) === 1 && occurs(/data-can-spam-footer/g) === 1, "The HTML part has one signature and one transport footer");
check(occurs(/\[CAN-SPAM-FOOTER\]/g) === 1 && occurs(/Scott Stevenson\nLiberty Bancard\n954-266-8214 \| libertybancard\.com/g) === 1, "The plain-text part has one signature and one transport footer");
check(occurs(/<img\b/g) === 1 && msg.all.includes('src="https://libertybancard.com/logo-blue.png"') && msg.all.includes('alt="Liberty Bancard logo"'), "One small existing logo with descriptive alt text");
check(msg.all.indexOf("<img") > msg.all.indexOf("data-sfp-signature") && msg.all.indexOf("<img") < msg.all.indexOf("data-can-spam-footer"), "The logo sits beneath the signature and above the transport footer");
check(!/\{\{|\}\}|undefined|\[object/.test(msg.all), "No unresolved placeholders reach the recipient");
check(msg.all.includes('<a href="https://libertybancard.com"'), "The signature website link is present");
const unsubUrl = /https:\/\/liberty\.example\.test\/unsubscribe\?t=([^"\s<>]+)/.exec(msg.all);
check(!!unsubUrl && decodeURIComponent(unsubUrl[1]).startsWith("seed."), "The footer's unsubscribe link is a seed link, not a contact link");
check(/<https:\/\/liberty\.example\.test\/unsubscribe\?t=seed\./.test(msg.header("List-Unsubscribe") ?? ""), "The List-Unsubscribe header carries the same seed link");
check(/One-Click/i.test(msg.header("List-Unsubscribe-Post") ?? ""), "The one-click unsubscribe header is present");
const consumed = await sendSmtpEmail({ to: mailbox, subject: preview.subject, html: preview.html, category: "cold_outreach",
  seedTest: { receiptKey: authority.seedReceiptKey(key1), occurrenceId: sent.receipt.occurrenceId } });
check(!consumed.success && consumed.error === "SEED_RECEIPT_NOT_CLAIMED" && captured.length === 1, "A used claim cannot be replayed at the transport");
const ordinaryAfter = await sendSmtpEmail({ to: mailbox, subject: "x", html: "<p>x</p>", category: "internal_ops" });
check(!ordinaryAfter.success && /Outbound paused: global_paused/.test(ordinaryAfter.error ?? "") && captured.length === 1, "After a seed send the global pause still blocks every ordinary sender");
const after1 = await snapshot();
check(JSON.stringify(after1) === JSON.stringify(before), "A seed send under the global pause changed no pause state, channel pause, sequence status, parked enrollment, hold, contact, intent, send-log row, capacity count or consent event");
check((await seed.readSeedStatus()).authorization?.sentCount === 1, "The seed authorization counts the message");

// ═══ 5. Replay, limit, expiry, revocation ═════════════════════════════════════════════════════════════════
const replay = await seed.executeSeedSend({ packageKey, stepOrder: 1, previewHash: preview.previewHash, idempotencyKey: key1, actorId: "cert" });
check(replay.replayed && captured.length === 1, "Repeating the same request returns the stored receipt and sends nothing");
await expectError(() => seed.executeSeedSend({ packageKey, stepOrder: 2, previewHash: preview.previewHash, idempotencyKey: key1, actorId: "cert" }),
  "SEED_IDEMPOTENCY_KEY_REUSED", "Reusing a key for a different message is refused");

// Proven-unsent failure returns the message to the allowance; an uncertain failure stays counted.
const preview2 = await seed.previewSeedSend({ packageKey, stepOrder: 2 });
smtpMode = "reject";
const rejected = await seed.executeSeedSend({ packageKey, stepOrder: 2, previewHash: preview2.previewHash, idempotencyKey: randomUUID(), actorId: "cert" });
check(rejected.receipt.state === "unsent" && (await seed.readSeedStatus()).authorization?.sentCount === 1, "A message the server declined is recorded unsent and not counted");
smtpMode = "drop";
const dropped = await seed.executeSeedSend({ packageKey, stepOrder: 2, previewHash: preview2.previewHash, idempotencyKey: randomUUID(), actorId: "cert" });
check(dropped.receipt.state === "uncertain" && (await seed.readSeedStatus()).authorization?.sentCount === 2, "A connection lost after the body was sent is recorded uncertain and stays counted");
smtpMode = "ok";
const captured2 = captured.length;
const preview3 = await seed.previewSeedSend({ packageKey, stepOrder: 3 });
await expectError(() => seed.executeSeedSend({ packageKey, stepOrder: 3, previewHash: preview3.previewHash, idempotencyKey: randomUUID(), actorId: "cert" }),
  "SEED_MESSAGE_LIMIT_REACHED", "The authorization's message limit is enforced");
check(captured.length === captured2, "Nothing is sent past the limit");

// ═══ 6. Seed unsubscribe stays out of the prospect world ══════════════════════════════════════════════════
const seedToken = decodeURIComponent(unsubUrl![1]);
check(!tokens.verifyUnsubscribeToken(seedToken).valid, "A seed token never verifies as a contact token");
check(!tokens.verifySeedUnsubscribeToken(tokens.generateUnsubscribeToken(prospectId)).valid, "A contact token never verifies as a seed token");
check(!tokens.verifySeedUnsubscribeToken(seedToken.slice(0, -2) + "00").valid, "A tampered seed token is invalid");
const verified = tokens.verifySeedUnsubscribeToken(seedToken);
check(verified.valid, "The emailed seed token verifies");
const applied = await authority.applySeedUnsubscribe((verified as any).occurrenceId);
check(applied.known && applied.recorded, "The seed unsubscribe is recorded");
const appliedAgain = await authority.applySeedUnsubscribe((verified as any).occurrenceId);
check(appliedAgain.known && !appliedAgain.recorded, "A repeated seed unsubscribe is idempotent");
check((await authority.applySeedUnsubscribe(randomUUID())).known === false, "An unknown occurrence records nothing");
const after2 = await snapshot();
check(JSON.stringify({ ...after2 }) === JSON.stringify(before), "The seed unsubscribe changed no contact, consent record, suppression or enrollment");
check((await seed.readSeedStatus()).blockedBecause === "SEED_MAILBOX_UNSUBSCRIBED", "An unsubscribed seed mailbox is not sent to again");
await expectError(async () => seed.executeSeedSend({ packageKey, stepOrder: 3, previewHash: "x", idempotencyKey: randomUUID(), actorId: "cert" }),
  "SEED_MAILBOX_UNSUBSCRIBED", "A further seed send is refused after unsubscribe");

// Expiry and revocation.
const auth2 = await seed.authorizeSeedMailbox({ mailbox, actorId: "cert" });
check(auth2.nonce !== auth.nonce && auth2.sentCount === 0 && auth2.maxMessages === 1, "A fresh authorization starts clean with the default single message");
await pool.query(`UPDATE system_settings SET value=jsonb_set(value,'{expiresAt}',to_jsonb($2::text)) WHERE key=$1`, [authority.SEED_AUTHORIZATION_KEY, new Date(Date.now() - 1000).toISOString()]);
check((await seed.readSeedStatus()).blockedBecause === "SEED_AUTHORIZATION_EXPIRED", "An expired authorization blocks sending");
const auth3 = await seed.authorizeSeedMailbox({ mailbox, actorId: "cert" });
check((await seed.revokeSeedMailbox()).revoked && (await seed.readSeedStatus()).blockedBecause === "SEED_AUTHORIZATION_REVOKED" && !!auth3, "Revocation blocks sending");

// Static census: only the seed service may present a seed capability, and only the mail service may ask the authority for a lease.
const { execSync } = await import("node:child_process");
const grep = (pattern: string) => execSync(`grep -rlE "${pattern}" server --include=*.ts || true`, { encoding: "utf8" }).split("\n").filter(Boolean).sort();
check(JSON.stringify(grep("seedTest[?]?:")) === JSON.stringify(["server/services/sfp-seed-test.ts", "server/services/smtp-email.ts"]), "Only the seed service and the mail service reference a seed capability");
check(JSON.stringify(grep("authorizeSeedSend")) === JSON.stringify(["server/services/outbound-pause-authority.ts", "server/services/smtp-email.ts"]), "Only the mail service asks the pause authority for a seed lease");
check(JSON.stringify(grep("consumeSeedClaim")) === JSON.stringify(["server/services/outbound-pause-authority.ts", "server/services/sfp-seed-authority.ts"]), "Only the pause authority consumes seed claims");

check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider or external network call was attempted");
console.log(`PASS SFP seed test (${checks} checks)`);
smtp.close();
await pool.end().catch(() => {});
