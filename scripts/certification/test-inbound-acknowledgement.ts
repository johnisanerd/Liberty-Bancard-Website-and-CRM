/**
 * Inbound acknowledgement owner certification (disposable database, fake transport, no external network).
 * Proves: closed-by-default capability, recipient/purpose/content/claim binding at the transport boundary,
 * single dispatch under concurrency, truthful settlement, uncertain-never-resent, revocation, and no historical
 * catch-up. A seed is never used as delivery proof.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Inbound acknowledgement owner certification" });
applyCertificationProviderDenyBoundary({ fatal: true });
process.env.APP_URL = "https://libertybancard.com";

const { pool } = await import("../../server/db");
const ack = await import("../../server/services/inbound-acknowledgement");
const { storage } = await import("../../server/storage");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [ACK-${String(checks).padStart(2, "0")}] ${message}`); };
const id = randomUUID().slice(0, 8);
const T = (s: string) => new Date(Date.parse(s));

// Real pause state: global outbound stays PAUSED for the whole certification.
{
  const updated = await pool.query(`UPDATE outbound_pause_control SET state='paused', reason='ack certification', committed_at=NOW()`);
  if (updated.rowCount === 0) {
    await pool.query(`INSERT INTO outbound_pause_control (state,reason,epoch,actor,idempotency_key,committed_at)
      VALUES ('paused','ack certification',1,'ack-cert',$1,NOW())`, [`ack-cert-${randomUUID()}`]);
  }
  (await import("../../server/services/outbound-pause-authority")).invalidatePauseStateCache();
}

// ── Pure capability checks ──────────────────────────────────────────────────
{
  const started = T("2026-10-23T12:00:00Z");
  const base = { sourceClass: "sales_request", sourceReceivedAt: T("2026-10-23T13:00:00Z"), ownerStartedAt: started, now: T("2026-10-23T14:00:00Z") };
  const open = { enabled: true, eligibleFrom: "2026-10-23T12:30:00Z", expiresAt: null, sourceClasses: ["sales_request"], activatedBy: "a", activatedAt: "2026-10-23T12:30:00Z" };
  check(ack.ackCapabilityAllows(open, base).ok === true, "Open capability allows an eligible new request");
  check((ack.ackCapabilityAllows({ ...open, enabled: false }, base) as any).reason === "capability_closed", "Closed capability blocks");
  check((ack.ackCapabilityAllows({ ...open, sourceClasses: ["support_request"] }, base) as any).reason === "source_class_not_enabled", "Capability is scoped to the enabled request type");
  check((ack.ackCapabilityAllows({ ...open, expiresAt: "2026-10-23T13:30:00Z" }, base) as any).reason === "capability_expired", "Expired capability blocks");
  check((ack.ackCapabilityAllows(open, { ...base, sourceReceivedAt: T("2026-10-23T11:00:00Z") }) as any).reason === "request_before_eligibility_window", "Requests before the window never get catch-up email");
  check((ack.ackCapabilityAllows({ ...open, eligibleFrom: null }, base) as any).reason === "eligibility_window_missing", "Missing eligibility window blocks");
}

// ── Content ─────────────────────────────────────────────────────────────────
{
  const c = await ack.buildAckContent({ sourceClass: "sales_request", sourceType: "estimate_form", requestId: randomUUID(), firstName: `<b>Ann</b>` });
  const all = `${c.subject}\n${c.html}\n${c.text}`;
  check(!/\{\{|\[[A-Z_]{4,}\]|href="#"/.test(all), "No unresolved tokens, bracket placeholders or href=#");
  check((c.html.match(/<img /g) ?? []).length === 1, "Exactly one logo (signature owner); receipt adds none");
  check(!c.html.includes("<b>Ann</b>") && c.html.includes("&lt;b&gt;Ann"), "Submitted values are escaped");
  check(!/business day|within \d|guarantee|approved|quote|savings/i.test(c.text.split("\n\n").slice(0, 3).join(" ")), "Receipt body makes no timing, approval or savings claim");
  check(c.text.length > 40 && c.subject.includes("ref "), "Plain text and reference present");
}

// ── Fixtures ────────────────────────────────────────────────────────────────
let phoneSeq = 0;
const contact = async (label: string) => (await pool.query(
  `INSERT INTO contacts(first_name,last_name,email,phone) VALUES($1,'Fixture',$2,$3) RETURNING id`,
  [`Ack${label}`, `ack-${id}-${label}@fixture.invalid`, `+1555${String(Number.parseInt(id, 16) % 1000).padStart(3, "0")}${String(++phoneSeq).padStart(4, "0")}`])).rows[0].id as number;
const request = async (label: string, opts: { contactId: number | null; receivedAt: Date; sourceType?: string; sourceClass?: string }) => {
  const r = (await pool.query(
    `INSERT INTO inbound_requests(idempotency_key,occurrence_key,request_fingerprint,source_category,source_type,source_class,caller_scope,actor_type,
       source_received_at,contact_id,submitted_email,manifest_version,manifest_hash)
     VALUES($1,$1,$6,'website_form',$2,$3,'public','visitor',$4,$5,(SELECT lower(email) FROM contacts WHERE id=$5),'v1',$7) RETURNING id`,
    [`ack-${id}-${label}`, opts.sourceType ?? "estimate_form", opts.sourceClass ?? "sales_request", opts.receivedAt, opts.contactId, sha(`fp-${id}-${label}`), sha("manifest")])).rows[0].id as string;
  const e = (await pool.query(
    `INSERT INTO inbound_request_effects(request_id,effect_key,effect_type,state,required,external_side_effect)
     VALUES($1,'transactional_ack','transactional_ack','held',true,true) RETURNING id`, [r])).rows[0].id as string;
  return { requestId: r, effectId: e };
};
const ackRow = async (effectId: string) => (await pool.query(`SELECT * FROM inbound_acknowledgements WHERE effect_id=$1`, [effectId])).rows[0];
const effectRow = async (effectId: string) => (await pool.query(`SELECT * FROM inbound_request_effects WHERE id=$1`, [effectId])).rows[0];

// Pin the owner start, then create requests after it. Historical = before the pin.
await pool.query(`DELETE FROM system_settings WHERE key IN ($1,$2)`, [ack.ACK_CAPABILITY_KEY, ack.ACK_OWNER_STARTED_KEY]);
const historic = await request("historic", { contactId: await contact("h"), receivedAt: new Date(Date.now() - 3 * 86400_000) });
await new Promise((r) => setTimeout(r, 25));
await ack.runAcknowledgementSweep({ limit: 1, deps: { send: async () => { throw new Error("must not send"); } } }); // pins owner start
await new Promise((r) => setTimeout(r, 25));

let sends: any[] = [];
const okSend = async (p: any) => { sends.push(p); return { success: true, messageId: `fake-${sends.length}` }; };
const sales = await request("sales", { contactId: await contact("s"), receivedAt: new Date() });
const support = await request("support", { contactId: await contact("p"), receivedAt: new Date(), sourceType: "support_form", sourceClass: "support_request" });
const noContact = await request("nocontact", { contactId: null, receivedAt: new Date() });

// 1. Capability closed (default): truthful blocked, nothing sent, effect still held.
{
  const sweep = await ack.runAcknowledgementSweep({ deps: { send: okSend } });
  check(sends.length === 0, "Closed capability: no send attempted");
  const a = await ackRow(sales.effectId);
  check(a?.state === "blocked" && a.blocked_reason === "capability_closed", "Closed capability: acknowledgement recorded as blocked/capability_closed");
  check((await effectRow(sales.effectId)).state === "held", "Closed capability: effect remains held (not sent)");
  check((await ackRow(noContact.effectId))?.blocked_reason === "no_recipient_on_request", "No-recipient request is blocked with its own reason");
  check(!(await ackRow(historic.effectId)), "Historical request was never prepared (no recipient binding to an edited contact)");
  check(sweep.examined >= 3, "Sweep examined only post-start requests");
}

// 2. Open the capability for sales only.
await ack.setAckCapability({ enabled: true, sourceClasses: ["sales_request"], actor: "cert" });
const late = await request("late", { contactId: await contact("l"), receivedAt: new Date(Date.now() + 1000) });
{
  // Requests that arrived while closed (before eligibleFrom) stay blocked: no catch-up.
  await ack.runAcknowledgementSweep({ deps: { send: okSend, now: new Date(Date.now() + 5000) } });
  const a = await ackRow(sales.effectId);
  check(sends.length === 1 && sends[0].to.includes(`-${id}-l@`), "Only the request inside the eligibility window was sent");
  check(a.blocked_reason === "capability_closed" || a.blocked_reason === "request_before_eligibility_window", "Request received while closed is not caught up");
  const p = sends[0];
  check(p.category === "support" && p.commercialPurpose === "transactional_response" && p.inboundRequestId === late.requestId
    && p.contactId === p.intendedRecipientContactId && !!p.inboundAck?.attemptToken, "Send carries category, purpose, request, recipient and claim binding");
  check(["capability_closed","source_class_not_enabled","request_before_eligibility_window"].includes((await ackRow(support.effectId)).blocked_reason) && (await ackRow(support.effectId)).state === "blocked", "Support request stays blocked (never emailed)");
  const settled = await ackRow(late.effectId);
  check(settled.state === "accepted" && settled.transport_message_id === "fake-1", "Accepted by transport recorded with receipt");
  const eff = await effectRow(late.effectId);
  check(eff.state === "sent" && eff.provider_receipt === "fake-1", "Effect settled sent with transport receipt");
  await ack.runAcknowledgementSweep({ deps: { send: okSend, now: new Date(Date.now() + 5000) } });
  check(sends.length === 1, "Replay sweep sends nothing more (one acknowledgement per occurrence)");
}

// 3. Transport-boundary verification: tamper checks happen inside the send.
{
  const r = await request("verify", { contactId: await contact("v"), receivedAt: new Date(Date.now() + 2000) });
  let verdicts: Record<string, boolean> = {};
  await ack.dispatchAcknowledgement(r.effectId, {
    now: new Date(Date.now() + 5000),
    send: async (p: any) => {
      const claim = p.inboundAck;
      const v = async (m: any, c = claim) => (await ack.verifyAckTransportCapability(m, c)).ok;
      verdicts.exact = await v(p);
      verdicts.wrongRecipient = await v({ ...p, to: "someone-else@fixture.invalid" });
      verdicts.wrongContent = await v({ ...p, html: p.html + "<p>extra</p>" });
      verdicts.wrongPurpose = await v({ ...p, commercialPurpose: "marketing_outreach" });
      verdicts.wrongCategory = await v({ ...p, category: "cold_outreach" });
      verdicts.wrongRequest = await v({ ...p, inboundRequestId: randomUUID() });
      verdicts.wrongToken = await v(p, { effectId: claim.effectId, attemptToken: randomUUID() });
      verdicts.unboundRecipient = await v({ ...p, intendedRecipientContactId: p.contactId + 1 });
      return { success: true, messageId: "fake-verify" };
    },
  });
  check(verdicts.exact === true, "Transport verification accepts the exact prepared message");
  check(!verdicts.wrongRecipient && !verdicts.wrongContent && !verdicts.wrongPurpose && !verdicts.wrongCategory
    && !verdicts.wrongRequest && !verdicts.wrongToken && !verdicts.unboundRecipient, "Wrong recipient, content, purpose, category, request, token and unbound recipient are all refused");
  const after = await ack.verifyAckTransportCapability({ to: "x@fixture.invalid", subject: "s", html: "h", category: "support", commercialPurpose: "transactional_response", contactId: 1, intendedRecipientContactId: 1, inboundRequestId: r.requestId }, { effectId: r.effectId, attemptToken: randomUUID() });
  check(after.ok === false, "A settled acknowledgement cannot be reused to authorize another send");

  // The real SMTP boundary refuses an unprepared claim before any network I/O.
  const { sendSmtpEmail } = await import("../../server/services/smtp-email");
  const res: any = await sendSmtpEmail({ to: "nobody@fixture.invalid", subject: "x", html: "<p>x</p>", category: "support", contactId: 1, commercialPurpose: "transactional_response", inboundRequestId: randomUUID(), intendedRecipientContactId: 1, inboundAck: { effectId: randomUUID(), attemptToken: randomUUID() } } as any);
  check(res.success === false, "Real SMTP boundary refuses a forged acknowledgement claim before any network I/O");
  const mixed: any = await sendSmtpEmail({ to: "nobody@fixture.invalid", subject: "x", html: "<p>x</p>", category: "cold_outreach", inboundAck: { effectId: randomUUID(), attemptToken: randomUUID() } } as any);
  check(mixed.success === false, "Acknowledgement claim cannot ride a marketing send");
}

// 4. Settlement: pause wait, uncertain, concurrency, suppression, revocation.
{
  const w = await request("wait", { contactId: await contact("w"), receivedAt: new Date(Date.now() + 3000) });
  const later = { now: new Date(Date.now() + 6000) };
  let r1 = await ack.dispatchAcknowledgement(w.effectId, { ...later, send: async () => ({ success: false, error: "Outbound paused: global_paused", outcome: "unsent" }) });
  const a1 = await ackRow(w.effectId);
  check(r1.state === "blocked" && a1.blocked_reason === "outbound_paused" && a1.attempt_count === 0, "Pause is a wait that consumes no attempt");
  check((await effectRow(w.effectId)).state === "held", "Paused attempt returns the effect to held");
  const r2 = await ack.dispatchAcknowledgement(w.effectId, { ...later, send: okSend });
  check(r2.state === "accepted", "After the wait the same acknowledgement is sent");

  const u = await request("unc", { contactId: await contact("u"), receivedAt: new Date(Date.now() + 3100) });
  const before = sends.length;
  const ru = await ack.dispatchAcknowledgement(u.effectId, { ...later, send: async () => ({ success: false, outcome: "uncertain", error: "x" }) });
  await ack.runAcknowledgementSweep({ deps: { ...later, send: okSend } });
  check(ru.state === "uncertain" && (await ackRow(u.effectId)).state === "uncertain" && sends.length === before, "Uncertain outcome is never resent automatically");
  check((await effectRow(u.effectId)).state === "attempting" && (await effectRow(u.effectId)).terminal_reason === "delivery_uncertain", "Uncertain effect is not reported as sent");

  const c = await request("conc", { contactId: await contact("c"), receivedAt: new Date(Date.now() + 3200) });
  let calls = 0;
  const slow = async (p: any) => { calls++; await new Promise((r) => setTimeout(r, 50)); return { success: true, messageId: "fake-conc" }; };
  await Promise.all([ack.dispatchAcknowledgement(c.effectId, { ...later, send: slow }), ack.dispatchAcknowledgement(c.effectId, { ...later, send: slow }), ack.dispatchAcknowledgement(c.effectId, { ...later, send: slow })]);
  check(calls === 1, "Concurrent dispatch sends exactly once");

  const s = await request("supp", { contactId: await contact("x"), receivedAt: new Date(Date.now() + 3300) });
  const rs = await ack.dispatchAcknowledgement(s.effectId, { ...later, send: async () => ({ success: false, error: "CONTACT_SUPPRESSED", outcome: "unsent" }) });
  check(rs.state === "suppressed" && (await effectRow(s.effectId)).state === "suppressed", "Contactability refusal settles as suppressed");

  const f = await request("fail", { contactId: await contact("f"), receivedAt: new Date(Date.now() + 3400) });
  let last: any;
  for (let i = 0; i < ack.ACK_MAX_SEND_ATTEMPTS; i++) last = await ack.dispatchAcknowledgement(f.effectId, { ...later, send: async () => ({ success: false, error: "smtp_rejected", outcome: "unsent" }) });
  check(last.state === "failed" && (await effectRow(f.effectId)).state === "failed", "Bounded retries end in failed, not an endless loop");

  const rv = await request("revoke", { contactId: await contact("r"), receivedAt: new Date(Date.now() + 3500) });
  await ack.setAckCapability({ enabled: false, actor: "cert" });
  const before2 = sends.length;
  const rr = await ack.dispatchAcknowledgement(rv.effectId, { ...later, send: okSend });
  check(rr.state === "blocked" && sends.length === before2, "Revoking the capability stops further sends immediately");
  const audits = (await pool.query(`SELECT action FROM audit_logs WHERE action LIKE 'inbound_ack_capability_%'`)).rows.map((x: any) => x.action);
  check(audits.includes("inbound_ack_capability_enabled") && audits.includes("inbound_ack_capability_closed"), "Enable and close are audit-logged");
}

// 5. Delivery capability does not touch pauses or enrollment.
{
  const stillPaused = (await pool.query(`SELECT state FROM outbound_pause_control ORDER BY id LIMIT 1`)).rows[0]?.state;
  check(stillPaused === "paused", "Global outbound pause is still paused after the capability was opened and closed");
  const enrollments = Number((await pool.query(`SELECT count(*) FROM sequence_enrollments WHERE created_at > now() - interval '1 hour'`)).rows[0].count);
  check(enrollments === 0, "No sequence enrollment was created by acknowledgements");
}

// 6. Backlog fairness and immutable recipient.
{
  // 30 ineligible requests (arrived before this activation) must not starve a later eligible one.
  for (let i = 0; i < 30; i++) await request(`backlog${i}`, { contactId: await contact(`b${i}`), receivedAt: new Date() });
  await new Promise((r) => setTimeout(r, 20));
  await ack.setAckCapability({ enabled: true, sourceClasses: ["sales_request"], actor: "cert" });
  const fresh = await request("fresh", { contactId: await contact("fr"), receivedAt: new Date(Date.now() + 4000) });
  const fairSends = sends.length;
  const later = { now: new Date(Date.now() + 8000) };
  for (let i = 0; i < 3; i++) await ack.runAcknowledgementSweep({ limit: 25, deps: { send: okSend, ...later } });
  check(sends.length === fairSends + 1 && (await ackRow(fresh.effectId)).state === "accepted", "A backlog of >25 ineligible requests does not starve a new eligible request");
  const terminal = Number((await pool.query(`SELECT count(*) FROM inbound_acknowledgements WHERE blocked_reason IN ('capability_closed','request_before_eligibility_window') AND request_id IN (SELECT id FROM inbound_requests WHERE idempotency_key LIKE $1)`, [`ack-${id}-backlog%`])).rows[0].count);
  check(terminal === 30, "Every ineligible backlog request holds an explicit terminal blocked disposition");
  const again = await ack.runAcknowledgementSweep({ limit: 25, deps: { send: okSend, ...later } });
  check(again.examined === 0, "Terminal blocked rows are not revisited by the sweep");

  // Contact email edited after submission but before preparation: nothing is sent to either address.
  const moved = await request("moved", { contactId: await contact("m"), receivedAt: new Date(Date.now() + 4100) });
  await pool.query(`UPDATE contacts SET email=$1 WHERE id=(SELECT contact_id FROM inbound_requests WHERE id=$2)`, [`changed-${id}@fixture.invalid`, moved.requestId]);
  const beforeMoved = sends.length;
  const mv = await ack.dispatchAcknowledgement(moved.effectId, { ...later, send: okSend });
  check(mv.state === "blocked" && (await ackRow(moved.effectId)).blocked_reason === "recipient_changed_since_submission" && sends.length === beforeMoved, "Email changed before preparation: no receipt to the old or the new address");
  check((await ackRow(moved.effectId)).recipient_email == null, "No recipient is bound for a changed address");

  // Contact email edited after preparation, before the transport lease: the transport refuses.
  const swap = await request("swap", { contactId: await contact("sw"), receivedAt: new Date(Date.now() + 4200) });
  let swapVerdict: any;
  await ack.dispatchAcknowledgement(swap.effectId, {
    ...later,
    send: async (p: any) => {
      await pool.query(`UPDATE contacts SET email=$1 WHERE id=$2`, [`swapped-${id}@fixture.invalid`, p.contactId]);
      swapVerdict = await ack.verifyAckTransportCapability(p, p.inboundAck);
      return { success: false, outcome: "unsent", error: "refused" };
    },
  });
  check(swapVerdict?.ok === false && swapVerdict.error === "ACK_RECIPIENT_CHANGED", "Transport refuses when the contact address changed after preparation");
  // The snapshot itself is immutable across later links.
  const { linkInboundRequest } = await import("../../server/services/inbound-request-authority");
  const cid = (await pool.query(`SELECT contact_id FROM inbound_requests WHERE id=$1`, [swap.requestId])).rows[0].contact_id;
  await linkInboundRequest(swap.requestId, { contactId: cid });
  const snap = (await pool.query(`SELECT submitted_email FROM inbound_requests WHERE id=$1`, [swap.requestId])).rows[0].submitted_email;
  check(snap === `ack-${id}-sw@fixture.invalid`, "Submitted-mailbox snapshot is not overwritten by a later link after an edit");
}

console.log(`\nALL CHECKS PASSED — ${checks}/${checks} checks`);
await pool.end();
process.exit(0);
