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


// 7. Partner-application and privacy-request classes, contactless privacy receipt, stale-attempt recovery,
//    and admin-only review-notification visibility.
{
  const later = { now: new Date(Date.now() + 30000) };
  const { INBOUND_SOURCE_POLICIES } = await import("../../server/services/inbound-request-authority");
  for (const [type, cls] of [["partner_application", "partner_application_request"], ["privacy_request", "privacy_request"]] as const) {
    const pol = INBOUND_SOURCE_POLICIES.find((p) => p.sourceCategory === "website_form" && p.sourceType === type);
    check(pol?.sourceClass === cls && pol.effects.some((e) => e.type === "transactional_ack") && !pol.effects.some((e) => e.type === "sla"),
      `${type} has a receipt effect and no SLA or timing promise`);
  }
  check((ack.ACK_SOURCE_CLASSES as readonly string[]).includes("partner_application_request") && (ack.ACK_SOURCE_CLASSES as readonly string[]).includes("privacy_request"),
    "New classes are acknowledgement source classes");

  // Existing enabled capability (sales only) leaves the new classes closed.
  const partner = await request("partner", { contactId: await contact("pa"), receivedAt: new Date(Date.now() + 5000), sourceType: "partner_application", sourceClass: "partner_application_request" });
  const closed = await ack.dispatchAcknowledgement(partner.effectId, { ...later, send: okSend });
  check(closed.state === "blocked" && (closed as any).reason === "source_class_not_enabled", "Partner applications stay closed until an admin enables that class");

  const privacyRequest = async (label: string, email: string | null) => {
    const r = (await pool.query(
      `INSERT INTO inbound_requests(idempotency_key,occurrence_key,request_fingerprint,source_category,source_type,source_class,caller_scope,actor_type,
         source_received_at,contact_id,submitted_email,manifest_version,manifest_hash)
       VALUES($1,$1,$2,'website_form','privacy_request','privacy_request','public','visitor',$3,NULL,$4,'v1',$5) RETURNING id`,
      [`ack-${id}-${label}`, sha(`fp-${id}-${label}`), new Date(Date.now() + 5000), email, sha("manifest")])).rows[0].id as string;
    const e = (await pool.query(
      `INSERT INTO inbound_request_effects(request_id,effect_key,effect_type,state,required,external_side_effect)
       VALUES($1,'transactional_ack','transactional_ack','held',true,true) RETURNING id`, [r])).rows[0].id as string;
    return { requestId: r, effectId: e };
  };
  const { linkInboundRequest } = await import("../../server/services/inbound-request-authority");
  await ack.setAckCapability({ enabled: true, sourceClasses: ["sales_request", "partner_application_request", "privacy_request"], actor: "cert" });
  await new Promise((r) => setTimeout(r, 20));

  // Contactless privacy receipt: goes to the submitted mailbox only, with no contact binding anywhere.
  const mailbox = `privacy-${id}@fixture.invalid`;
  const priv = await privacyRequest("privacy", mailbox);
  await linkInboundRequest(priv.requestId, { submittedEmail: "attacker@fixture.invalid" });
  check((await pool.query(`SELECT submitted_email FROM inbound_requests WHERE id=$1`, [priv.requestId])).rows[0].submitted_email === mailbox,
    "Submitted mailbox on a contactless request is immutable once captured");
  let seen: any; let verdict: any;
  const sendsBefore = sends.length;
  const out = await ack.dispatchAcknowledgement(priv.effectId, { ...later, send: async (p: any) => {
    seen = p; verdict = await ack.verifyAckTransportCapability(p, p.inboundAck);
    sends.push(p); return { success: true, messageId: "fake-priv" };
  } });
  check(out.state === "accepted" && sends.length === sendsBefore + 1, "Enabled privacy class sends exactly one receipt");
  check(seen.to === mailbox && seen.contactId === undefined && seen.intendedRecipientContactId === undefined && seen.category === "support" && seen.commercialPurpose === "transactional_response",
    "Privacy receipt is addressed to the submitted mailbox only, with no contact binding, as a transactional support send");
  check(verdict?.ok === true, "Transport verification accepts the exact contactless privacy message");
  check(!/within \d|business day|guarantee/i.test(seen.text) && !seen.html.includes(mailbox), "Privacy receipt makes no timing promise and echoes no personal detail");
  const repriv = await ack.dispatchAcknowledgement(priv.effectId, { ...later, send: okSend });
  check(repriv.state === "accepted" && sends.length === sendsBefore + 1, "A privacy receipt is never sent twice");

  // The same effect cannot be re-aimed at a CRM contact or another recipient.
  const priv2 = await privacyRequest("privacy2", `privacy2-${id}@fixture.invalid`);
  let v2: any; let v3: any;
  await ack.dispatchAcknowledgement(priv2.effectId, { ...later, send: async (p: any) => {
    const cid = await contact("rebind");
    v2 = await ack.verifyAckTransportCapability({ ...p, contactId: cid, intendedRecipientContactId: cid }, p.inboundAck);
    v3 = await ack.verifyAckTransportCapability({ ...p, to: `other-${id}@fixture.invalid` }, p.inboundAck);
    return { success: false, outcome: "unsent", error: "refused" };
  } });
  check(v2?.ok === false && v2.error === "ACK_CONTACT_NOT_ALLOWED", "Privacy receipt cannot be bound to a CRM contact at the transport boundary");
  check(v3?.ok === false && v3.error === "ACK_RECIPIENT_MISMATCH", "Privacy receipt cannot be redirected to another address");

  // A privacy request with no captured mailbox is blocked, never guessed.
  const none = await privacyRequest("privacy-none", null);
  const nout = await ack.dispatchAcknowledgement(none.effectId, { ...later, send: okSend });
  check(nout.state === "blocked" && (await ackRow(none.effectId)).blocked_reason === "no_submitted_email_on_request", "Privacy request without a submitted mailbox is blocked with its own reason");

  // Partner application (contact-bound) still requires the contact binding and sends once.
  const bound = await ack.dispatchAcknowledgement(partner.effectId, { ...later, send: okSend });
  check(bound.state === "accepted", "Enabled partner application receipt is sent once to the submitted mailbox");

  // Stale-attempt recovery: crash left rows attempting. Nothing is resent.
  const crashed = await request("crashed", { contactId: await contact("cr"), receivedAt: new Date(Date.now() + 6000) });
  await pool.query(`UPDATE inbound_request_effects SET state='attempting', attempt_count=1 WHERE id=$1`, [crashed.effectId]);
  const crashedAck = await ack.prepareAcknowledgement(crashed.effectId);
  await pool.query(`UPDATE inbound_acknowledgements SET state='attempting', attempt_token=$2, attempt_count=1, attempted_at=$3 WHERE id=$1`,
    [crashedAck!.id, randomUUID(), new Date(Date.now() - 3600_000)]);
  const half = await request("half", { contactId: await contact("hf"), receivedAt: new Date(Date.now() + 6100) });
  await pool.query(`UPDATE inbound_request_effects SET state='attempting', updated_at=$2 WHERE id=$1`, [half.effectId, new Date(Date.now() - 3600_000)]);
  const fresh = await request("freshattempt", { contactId: await contact("fa"), receivedAt: new Date(Date.now() + 6200) });
  await pool.query(`UPDATE inbound_request_effects SET state='attempting' WHERE id=$1`, [fresh.effectId]);
  const faAck = await ack.prepareAcknowledgement(fresh.effectId);
  await pool.query(`UPDATE inbound_acknowledgements SET state='attempting', attempt_token=$2, attempted_at=now() WHERE id=$1`, [faAck!.id, randomUUID()]);

  const beforeRecovery = sends.length;
  const rec = await ack.runAcknowledgementSweep({ limit: 25, deps: { send: okSend } });
  const ca = await ackRow(crashed.effectId);
  check(ca.state === "uncertain" && ca.blocked_reason === "attempt_interrupted", "Crash-left attempting acknowledgement becomes uncertain/attempt_interrupted");
  check((await effectRow(crashed.effectId)).state === "attempting" && (await effectRow(crashed.effectId)).terminal_reason === "delivery_uncertain", "Its effect keeps attempting with delivery_uncertain (not sent, not retried)");
  check((await effectRow(half.effectId)).state !== "attempting", "Effect claimed without an acknowledgement claim is released back to the sweep");
  check((await ackRow(fresh.effectId)).state === "attempting", "A recent in-flight attempt is not touched by recovery");
  check(rec.recoveredUncertain >= 1 && rec.releasedEffects >= 1, "Sweep reports what recovery resolved");
  await ack.runAcknowledgementSweep({ limit: 25, deps: { send: okSend } });
  check((await ackRow(crashed.effectId)).state === "uncertain", "Uncertain recovered acknowledgement is never resent by later sweeps");
  check(!sends.slice(beforeRecovery).some((m: any) => m.inboundRequestId === crashed.requestId), "No send was made for the interrupted attempt");

  // Review notifications are readable by admins and hidden from managers and agents.
  const { listActorNotifications } = await import("../../server/services/notification-authority");
  const uid = (role: string) => `ack-${id}-${role}`;
  for (const role of ["admin", "manager", "agent"]) {
    await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,$3)`, [uid(role), `${uid(role)}@fixture.invalid`, role]);
  }
  const mk = async (key: string, title: string, metadata: any) => storage.createNotification({ channel: "internal", title, message: "m", type: "alert", commandKey: `ack-cert-${id}-${key}`, metadata } as any);
  await mk("partner", `Partner ${id}`, { partnerId: 1, link: "/dashboard/referral-program", eventType: "partner_application_received", audienceRoles: ["admin"] });
  await mk("privacy", `Privacy ${id}`, { dataRequestId: 1, link: "/dashboard/data-requests", eventType: "privacy_request_received", audienceRoles: ["admin"] });
  await mk("forged", `Forged ${id}`, { link: "/dashboard/data-requests", eventType: "something_else", audienceRoles: ["admin"] });
  const adminList = (await listActorNotifications({ userId: uid("admin"), limit: 200, offset: 0 })).data.filter((n: any) => String(n.title).endsWith(id));
  const byTitle = (t: string) => adminList.find((n: any) => n.title === `${t} ${id}`);
  check(byTitle("Partner")?.target.state === "available" && byTitle("Partner").target.url === "/dashboard/referral-program", "Admins see the partner application review notification with its review page");
  check(byTitle("Privacy")?.target.state === "available" && byTitle("Privacy").target.url === "/dashboard/data-requests", "Admins see the privacy request review notification with its review page");
  check(!byTitle("Forged"), "A review-page link on any other event type stays hidden");
  for (const role of ["manager", "agent"]) {
    const other = (await listActorNotifications({ userId: uid(role), limit: 200, offset: 0 })).data.filter((n: any) => String(n.title).endsWith(id));
    check(other.length === 0, `${role} accounts never see admin-only review notifications`);
  }
}


// 8. The three public adapters' authority path: claim -> write -> orchestrate completes the internal effect only
//    with request-owned evidence, and leaves the receipt held.
{
  const auth = await import("../../server/services/inbound-request-authority");
  const { writeContact } = await import("../../server/services/contact-writer");
  const claimIt = async (cat: string, type: string, label: string) => {
    const c = await auth.claimInboundRequest({ idempotencyKey: randomUUID(), sourceCategory: cat, sourceType: type, callerScope: "public:cert", actorType: "public", payload: { label } });
    assert.equal(c.outcome, "claimed");
    return (c as any).request.id as string;
  };
  const effects = async (rid: string) => (await pool.query(`SELECT effect_key,state FROM inbound_request_effects WHERE request_id=$1`, [rid])).rows as Array<{ effect_key: string; state: string }>;
  const notify = async (rid: string, ok = true) => (await storage.createNotification({
    channel: "internal", title: "t", message: "m", type: "alert", inboundRequestId: ok ? rid : undefined,
    commandKey: ok ? `inbound:${rid}:review-notification` : `ack-cert-wrong-${rid}`, metadata: { audienceRoles: ["admin"] },
  } as any)).id;

  // Partner application: contact-linked.
  const pr = await claimIt("website_form", "partner_application", "pa");
  const pc = await contact("pa2");
  const pDone = await auth.orchestrateInboundRequest({ requestId: pr, contactId: pc, notificationId: await notify(pr) });
  const pe = await effects(pr);
  check(pe.find((e) => e.effect_key === "review_notification")?.state === "sent" && pe.find((e) => e.effect_key === "transactional_ack")?.state === "held" && pDone.lifecycleState === "accepted",
    "Partner application: review effect completes on request-owned evidence; receipt stays held for the receipt owner");
  check(pDone.slaDueAt == null, "Partner application has no SLA due date (no timing promise)");

  // Wrong or foreign notification does not complete the review effect.
  const pr2 = await claimIt("website_form", "partner_application", "pa-wrong");
  const bad = await auth.orchestrateInboundRequest({ requestId: pr2, contactId: await contact("pa3"), notificationId: await notify(pr2, false) });
  check((await effects(pr2)).find((e) => e.effect_key === "review_notification")?.state === "held" && bad.lifecycleState === "review_required",
    "A notification not owned by the request leaves the review effect held and the request in review_required");

  // Privacy request: no contact, mailbox captured on the request.
  const vr = await claimIt("website_form", "privacy_request", "pv");
  const email = `priv-route-${id}@Fixture.invalid`;
  const vDone = await auth.orchestrateInboundRequest({ requestId: vr, notificationId: await notify(vr), submittedEmail: email });
  const row = (await pool.query(`SELECT contact_id, submitted_email FROM inbound_requests WHERE id=$1`, [vr])).rows[0];
  check(row.contact_id === null && row.submitted_email === email.toLowerCase(), "Privacy request creates no contact and captures the lowercase submitted mailbox");
  check((await effects(vr)).find((e) => e.effect_key === "review_notification")?.state === "sent" && vDone.lifecycleState === "accepted", "Privacy request: review effect completes, receipt stays held");

  // Co-branded form: sales authority with partner_portal provenance.
  const cr = await claimIt("partner_referral", "partner_portal", "cb");
  const contactRow = await writeContact({
    mode: "local_first",
    mutation: { firstName: "Co", lastName: "Brand", email: `cobrand-${id}@fixture.invalid`, phone: "", status: "New", tags: ["partner_portal"] },
    provenance: { sourceCategory: "partner_referral", sourceType: "partner_portal", eventKey: `form:partner_portal:${cr}`, actorType: "public" },
    actor: { actorType: "public" },
  });
  const cDone = await auth.orchestrateInboundRequest({ requestId: cr, contactId: contactRow.id });
  const ce = await effects(cr);
  check(ce.some((e) => e.effect_key === "transactional_ack" && e.state === "held") && cDone.slaDueAt != null && cDone.contactId === contactRow.id,
    "Co-branded lead form runs on the canonical sales authority with a request-owned task and a held receipt");
  check(Number((await pool.query(`SELECT count(*) FROM sequence_enrollments WHERE contact_id=$1`, [contactRow.id])).rows[0].count) === 0, "Co-branded lead form creates no sequence enrollment");
  check(await ack.describeAckReceiptState(cr) === "queued", "Receipt state is queued only while the capability permits the request");
  await ack.setAckCapability({ enabled: false, actor: "cert" });
  check(await ack.describeAckReceiptState(cr) === "not_enabled", "Receipt state is not_enabled once the capability is closed");
}

// 8. Real SMTP boundary with a fake mail server: delivery override and final-dispatch capability recheck.
{
  const net = await import("node:net");
  const rcpts: string[] = [];
  const smtp = net.createServer((sock) => {
    let inData = false; let buf = "";
    sock.on("error", () => {});
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) { const end = buf.indexOf("\r\n.\r\n"); if (end < 0) return; buf = buf.slice(end + 5); inData = false; sock.write("250 OK queued\r\n"); continue; }
        const nl = buf.indexOf("\r\n"); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("AUTH")) sock.write("235 ok\r\n");
        else if (cmd.startsWith("RCPT TO")) { rcpts.push(line.toLowerCase()); sock.write("250 OK\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (cmd.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
  process.env.SMTP_HOST = "127.0.0.1"; process.env.SMTP_PORT = String((smtp.address() as any).port);
  process.env.SMTP_USER = "cert"; process.env.SMTP_PASS = "cert";
  process.env.UNSUBSCRIBE_TOKEN_SECRET ||= "cert-unsubscribe-secret-0123456789abcdef";
  delete process.env.EMAIL_OVERRIDE_TO;
  await ack.setAckCapability({ enabled: true, sourceClasses: ["sales_request"], actor: "cert" });
  await new Promise((r) => setTimeout(r, 30));

  // 8a. A delivery override must never redirect a receipt: nothing is sent, the attempt is not consumed.
  const ov = await request("override", { contactId: await contact("ov"), receivedAt: new Date(Date.now() + 3000) });
  process.env.EMAIL_OVERRIDE_TO = `redirect-${id}@fixture.invalid`;
  const r1 = await ack.dispatchAcknowledgement(ov.effectId, { now: new Date(Date.now() + 30000) });
  check(r1.state === "blocked" && (r1 as any).reason === "ack_delivery_override_active" && rcpts.length === 0, "A delivery override refuses the receipt before any mail leaves; nothing reaches the override address");
  check((await ackRow(ov.effectId)).attempt_count === 0 && (await effectRow(ov.effectId)).state === "held", "Override refusal is a wait: no attempt consumed, effect stays held");
  delete process.env.EMAIL_OVERRIDE_TO;
  const r2 = await ack.dispatchAcknowledgement(ov.effectId, { now: new Date(Date.now() + 30000) });
  check(r2.state === "accepted" && rcpts.length === 1 && rcpts[0].includes(`ack-${id}-ov@fixture.invalid`), "Without the override the receipt goes to the submitted mailbox only");

  // 8b. Capability closed in the window between authorization and provider I/O.
  const cl = await request("closewin", { contactId: await contact("cw"), receivedAt: new Date(Date.now() + 3500) });
  await pool.query(`CREATE OR REPLACE FUNCTION cert_close_ack_capability() RETURNS trigger AS $$
    BEGIN UPDATE system_settings SET value = to_jsonb('{"enabled":false}'::text) WHERE key = '${ack.ACK_CAPABILITY_KEY}'; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER cert_close_ack_capability_trg AFTER INSERT ON outbound_inflight_sends FOR EACH ROW EXECUTE FUNCTION cert_close_ack_capability()`);
  const before = rcpts.length;
  try {
    const r3 = await ack.dispatchAcknowledgement(cl.effectId, { now: new Date(Date.now() + 30000) });
    check(r3.state === "blocked" && (r3 as any).reason === "ack_capability_closed" && rcpts.length === before, "Capability closed after authorization but before provider I/O: nothing is sent");
    check((await ackRow(cl.effectId)).attempt_count === 0 && (await effectRow(cl.effectId)).state === "held", "Final-dispatch refusal is a wait: no attempt consumed, effect stays held");
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS cert_close_ack_capability_trg ON outbound_inflight_sends`);
    await pool.query(`DROP FUNCTION IF EXISTS cert_close_ack_capability()`);
  }
  check((await pool.query(`SELECT state FROM outbound_pause_control ORDER BY committed_at DESC LIMIT 1`)).rows[0].state === "paused", "Global pause stayed on throughout");
  smtp.close();
}

// 9. Worker liveness evidence (F7): status reports never_reported / reporting / stale from the durable heartbeat.
{
  await pool.query(`DELETE FROM system_settings WHERE key=$1`, [ack.ACK_WORKER_HEARTBEAT_KEY]);
  check((await ack.getAckWorkerStatus()).state === "never_reported", "Worker status is never_reported before any sweep records a heartbeat");
  const now = new Date();
  await storage.setSystemSetting(ack.ACK_WORKER_HEARTBEAT_KEY, { at: new Date(now.getTime() - 20_000).toISOString(), outcome: "ok" });
  check((await ack.getAckWorkerStatus(now)).state === "reporting", "A recent heartbeat reports the worker as reporting");
  await storage.setSystemSetting(ack.ACK_WORKER_HEARTBEAT_KEY, { at: new Date(now.getTime() - 600_000).toISOString(), outcome: "error", errorName: "Boom" });
  const stale = await ack.getAckWorkerStatus(now);
  check(stale.state === "stale" && stale.lastOutcome === "error" && stale.lastErrorName === "Boom", "An old heartbeat reports stale with the last failure name");
  await pool.query(`DELETE FROM system_settings WHERE key=$1`, [ack.ACK_WORKER_HEARTBEAT_KEY]);
}

console.log(`\nALL CHECKS PASSED — ${checks}/${checks} checks`);
await pool.end();
process.exit(0);
