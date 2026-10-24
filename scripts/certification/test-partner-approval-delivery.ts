/**
 * Partner approval / affiliate welcome durability certification (disposable PostgreSQL; fake transports, no provider,
 * no network, no real send).
 *
 * The intent commits with the approval, survives a crash before any worker runs, waits (without spending attempts) on a
 * missing prerequisite, never re-sends an unconfirmed invite automatically, reclaims crashed claims correctly and is
 * executed once under concurrent workers.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Partner approval delivery certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const svc = await import("../../server/services/partner-approval-delivery");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [PAD-${String(checks).padStart(2, "0")}] ${message}`); };
const id = randomUUID().slice(0, 8);
let phoneSeq = Number.parseInt(id, 16) % 9000;
const nextPhone = () => `+1555${String(1000 + (phoneSeq++ % 9000)).padStart(7, "0")}`.slice(0, 12);
const mkPartner = (label: string, extra: Record<string, unknown> = {}) => storage.createPartner({
  companyName: `PAD ${label} ${id}`, contactName: "Pad Fixture", email: `pad-${label}-${id}@fixture.invalid`, phone: nextPhone(),
  passwordHash: "hash", partnerType: "referral", affiliateCode: `pad${label}${id}${Math.floor(Math.random() * 1e5)}`, status: "pending", commissionPercent: 10, ...extra,
} as any);
const deliveries = async (pid: number) => (await pool.query(`SELECT * FROM partner_approval_deliveries WHERE partner_id=$1 ORDER BY generation`, [pid])).rows;
const T0 = () => new Date();
const plus = (m: number) => new Date(Date.now() + m * 60_000);
const calls = { welcome: 0, invite: 0, enroll: 0 };
const ok = { pauseAllows: async () => true };

// 1. Approval commits status and intent together.
const p1 = await mkPartner("a");
const r1 = await svc.updatePartnerWithApproval(p1.id, { status: "active" });
const d1 = await deliveries(p1.id);
check(r1?.approved && d1.length === 1 && d1[0].kind === "welcome" && d1[0].state === "pending" && r1.updated.status === "active", "Approval writes the status change and a pending welcome in one transaction");
const again = await svc.updatePartnerWithApproval(p1.id, { status: "active", notes: "x" });
check(!again?.approved && (await deliveries(p1.id)).length === 1, "Updating an already-active partner creates no second intent");
const pInv = await mkPartner("inv", { passwordHash: null });
await svc.updatePartnerWithApproval(pInv.id, { status: "active" });
check((await deliveries(pInv.id))[0].kind === "invite", "A partner with no credential gets an invite intent");

// 2. Crash after approval, no request alive: the sweep executes it exactly once.
const sendWelcome = async () => { calls.welcome++; return "sent" as const; };
const s1 = await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(1), sendWelcome, sendInvite: async () => { calls.invite++; return "sent"; } } });
check((await deliveries(p1.id))[0].state === "sent" && calls.welcome === 1 && (await deliveries(pInv.id))[0].state === "sent" && calls.invite === 1, "The sweep sends the welcome and the invite once, with no browser or request");
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(2), sendWelcome, sendInvite: async () => { calls.invite++; return "sent"; } } });
check(calls.welcome === 1 && calls.invite === 1, "A second sweep sends nothing more");

// 3. Prerequisite waits do not spend attempts and never become sent/skipped.
const p3 = await mkPartner("wait");
await svc.updatePartnerWithApproval(p3.id, { status: "active" });
await svc.processPartnerApprovalDeliveries({ deps: { pauseAllows: async () => false, now: plus(1), sendWelcome } });
let d3 = (await deliveries(p3.id))[0];
check(d3.state === "waiting" && d3.wait_reason === "outbound_paused" && d3.attempts === 0, "Outbound pause is a wait: no attempt consumed, nothing sent");
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(10), sendWelcome: async () => "no_provider_contact" } });
d3 = (await deliveries(p3.id))[0];
check(d3.state === "waiting" && d3.wait_reason === "ghl_contact_pending" && d3.attempts === 0, "A missing provider contact is a wait, not a completed or skipped welcome");
const before = calls.welcome;
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(20), sendWelcome } });
check((await deliveries(p3.id))[0].state === "sent" && calls.welcome === before + 1, "When the prerequisite appears the same work completes");

// 4. Retry budget, failure, and operator resend.
const p4 = await mkPartner("retry");
await svc.updatePartnerWithApproval(p4.id, { status: "active" });
let minutes = 100;
for (let i = 0; i < 4; i++) {
  await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(minutes), sendWelcome: async () => { throw new Error("provider down"); } } });
  minutes += 60;
}
const d4 = (await deliveries(p4.id))[0];
check(d4.state === "failed" && d4.attempts === 4, "Genuine failures spend the attempt budget and end visibly failed");
const resent = await svc.resendPartnerDelivery(p4.id, d4.id, "cert-admin");
check(resent?.state === "pending" && (await pool.query(`SELECT 1 FROM audit_logs WHERE action='partner_approval_delivery_resend' AND entity_id=$1`, [String(p4.id)])).rowCount === 1, "An operator resend re-queues it and is audited");
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(minutes), sendWelcome } });
check((await deliveries(p4.id))[0].state === "sent", "The resent welcome completes");
check((await svc.resendPartnerDelivery(p4.id, d4.id, "cert-admin")) === null, "A delivered welcome cannot be resent through the operator route");

// 5. Invite ambiguity.
const p5 = await mkPartner("amb", { passwordHash: null });
await svc.updatePartnerWithApproval(p5.id, { status: "active" });
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(300), sendInvite: async () => "ambiguous" } });
const d5 = (await deliveries(p5.id))[0];
const act5 = (await pool.query(`SELECT delivery_disposition FROM auth_actions WHERE id=$1`, [d5.auth_action_id])).rows[0];
check(d5.state === "ambiguous" && act5.delivery_disposition === "ambiguous", "An invite with an unknown outcome is ambiguous (not sent, not failed) and the link records that");
let reSent = 0;
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(400), sendInvite: async () => { reSent++; return "sent"; } } });
check(reSent === 0 && (await deliveries(p5.id))[0].state === "ambiguous", "An ambiguous invite is never re-sent automatically");
await svc.resendPartnerDelivery(p5.id, d5.id, "cert-admin");
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(500), sendInvite: async () => { reSent++; return "sent"; } } });
const d5b = (await deliveries(p5.id))[0];
check(reSent === 1 && d5b.state === "sent" && d5b.auth_action_id !== d5.auth_action_id, "After the operator decision a fresh single-use link is issued and sent once");
const oldAct = (await pool.query(`SELECT revoked_at FROM auth_actions WHERE id=$1`, [d5.auth_action_id])).rows[0];
check(oldAct.revoked_at !== null, "The earlier link is revoked when the new one is issued");
const p5u = await mkPartner("unsent", { passwordHash: null });
await svc.updatePartnerWithApproval(p5u.id, { status: "active" });
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(600), sendInvite: async () => "unsent" } });
const d5u = (await deliveries(p5u.id))[0];
const act5u = (await pool.query(`SELECT revoked_at, delivery_disposition FROM auth_actions WHERE id=$1`, [d5u.auth_action_id])).rows[0];
check(d5u.state === "pending" && d5u.attempts === 1 && act5u.delivery_disposition === "definite_failure" && act5u.revoked_at, "A definitely-unsent invite is retried later and its unused link is revoked");

// 6. Crash reclaim.
const p6a = await mkPartner("crash-before");
const p6b = await mkPartner("crash-after");
for (const p of [p6a, p6b]) await svc.updatePartnerWithApproval(p.id, { status: "active" });
await pool.query(`UPDATE partner_approval_deliveries SET state='attempting', attempts=1, locked_at=now() - interval '30 minutes' WHERE partner_id=$1`, [p6a.id]);
await pool.query(`UPDATE partner_approval_deliveries SET state='attempting', attempts=1, locked_at=now() - interval '30 minutes', dispatch_started_at=now() - interval '29 minutes' WHERE partner_id=$1`, [p6b.id]);
const rc = await svc.reclaimStalePartnerDeliveries(new Date());
check(rc.retried === 1 && rc.ambiguous === 1 && (await deliveries(p6a.id))[0].state === "pending" && (await deliveries(p6b.id))[0].state === "ambiguous", "A claim that crashed before dispatch is retried; one that crashed after dispatch is ambiguous");

// 7. Concurrent workers send once.
const p7 = await mkPartner("conc");
await svc.updatePartnerWithApproval(p7.id, { status: "active" });
const concCalls: number[] = [];
const slow = async (partner: { id: number }) => { concCalls.push(partner.id); await new Promise((r) => setTimeout(r, 150)); return "sent" as const; };
await Promise.all([1, 2, 3].map(() => svc.processPartnerApprovalDeliveries({ limit: 50, deps: { ...ok, now: plus(700), sendWelcome: slow, sendInvite: async () => "sent" } })));
check((await deliveries(p7.id))[0].state === "sent" && (await deliveries(p7.id)).length === 1, "Parallel workers complete the welcome");
check(concCalls.filter((x) => x === p7.id).length === 1, "Three parallel workers invoked the transport once for that welcome");
check(new Set(concCalls).size === concCalls.length, "No partner was handed to the transport twice across the parallel workers");

// 8. Superseded / no recipient.
const p8 = await mkPartner("susp");
await svc.updatePartnerWithApproval(p8.id, { status: "active" });
await svc.updatePartnerWithApproval(p8.id, { status: "suspended" });
let sentToSuspended = 0;
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(800), sendWelcome: async () => { sentToSuspended++; return "sent"; } } });
check((await deliveries(p8.id))[0].state === "superseded" && sentToSuspended === 0, "A partner suspended before the send gets nothing and the intent says why");
const p8b = await mkPartner("noemail");
await svc.updatePartnerWithApproval(p8b.id, { status: "active" });
await pool.query(`UPDATE partners SET email='' WHERE id=$1`, [p8b.id]);
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(900), sendWelcome } });
check((await deliveries(p8b.id))[0].state === "no_recipient", "A partner with no email is reported as no_recipient, terminally and truthfully");

// 9. Affiliate welcome: committed with the account, waits for the provider contact id, then hands off once.
const accounts = await import("../../server/services/partner-account");
const aff = await accounts.createPartnerAccount({
  companyName: "Aff", contactName: "Aff Fixture", email: `pad-aff-${id}@fixture.invalid`, phone: nextPhone(), passwordHash: "h",
  partnerType: "affiliate", affiliateCode: `padaff${id}`, status: "active", commissionPercent: 10,
} as any, { role: "affiliate" });
check((await deliveries(aff.id))[0]?.kind === "affiliate_welcome", "The affiliate welcome intent commits with the account");
const enroll = async () => { calls.enroll++; return { success: true }; };
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(1000), enrollAffiliateWelcome: enroll } });
const da = (await deliveries(aff.id))[0];
check(da.state === "waiting" && da.wait_reason === "ghl_contact_pending" && calls.enroll === 0 && da.attempts === 0, "With no provider contact id the welcome is a durable wait, not a note in the audit log");
await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,ghl_contact_id) VALUES('Aff','Fixture',$1,$2,$3)`, [`pad-aff-${id}@fixture.invalid`, nextPhone(), `ghl-${id}`]);
await svc.processPartnerApprovalDeliveries({ deps: { ...ok, now: plus(1100), enrollAffiliateWelcome: enroll } });
check((await deliveries(aff.id))[0].state === "sent" && calls.enroll === 1, "Once the provider contact id exists the welcome is handed off once");

console.log(`PARTNER_APPROVAL_DELIVERY_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
