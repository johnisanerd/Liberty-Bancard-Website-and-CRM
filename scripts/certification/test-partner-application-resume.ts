/**
 * Partner/affiliate application resume certification (disposable database; no provider, no network, no sends).
 *
 * F4: a replay of a partially completed occurrence finishes the missing local work exactly once; the contact carries the
 * partner source contract and the occurrence's event key; review items carry a recorded owner and due time or say they
 * have none; a replay with no durable account fails truthfully instead of reporting success.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Partner application resume certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const auth = await import("../../server/services/inbound-request-authority");
const intake = await import("../../server/services/partner-application-intake");
const policy = await import("../../server/services/inbound-review-policy");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [PAR-${String(checks).padStart(2, "0")}] ${message}`); };
const id = randomUUID().slice(0, 8);
let phoneSeq = Number.parseInt(id, 16) % 9000;
const nextPhone = () => `+1555${String(1000 + (phoneSeq++ % 9000)).padStart(7, "0")}`.slice(0, 12);

const claim = async (label: string) => {
  const c = await auth.claimInboundRequest({ idempotencyKey: randomUUID(), sourceCategory: "website_form", sourceType: "partner_application", callerScope: "public:cert", actorType: "public", payload: { label } });
  assert.equal(c.outcome, "claimed");
  return (c as any).request;
};
const accounts = await import("../../server/services/partner-account");
// The same account transaction the routes use: it binds the occurrence's mailbox atomically with the account.
const partnerRow = async (email: string, requestId: string) => accounts.createPartnerAccount({
  companyName: `Par ${id}`, contactName: "Par Fixture", email, phone: nextPhone(), passwordHash: "x", partnerType: "referral",
  affiliateCode: `par${id}${Math.floor(Math.random() * 1e6)}`, status: "pending", commissionPercent: 10,
} as any, { role: "partner", inboundRequestId: requestId });
const notifications = async (rid: string) => (await pool.query(`SELECT metadata FROM notifications WHERE inbound_request_id=$1`, [rid])).rows;
const contactsFor = async (email: string) => (await pool.query(`SELECT id FROM contacts WHERE lower(email)=$1`, [email])).rows;
const reload = async (rid: string) => (await auth.getInboundRequestById(rid))!;

await pool.query(`DELETE FROM system_settings WHERE key=$1`, [policy.INBOUND_REVIEW_POLICY_KEY]);

// 1. Crash after the account was created: only the partner row exists. Replay resumes the rest once.
const emailA = `par-a-${id}@fixture.invalid`;
const reqA = await claim("a");
await partnerRow(emailA, reqA.id);
check((await contactsFor(emailA)).length === 0 && (await notifications(reqA.id)).length === 0, "Fixture: account exists, contact and review notification do not");
const r1 = await intake.resumePartnerApplication(await reload(reqA.id), "partner");
check(!r1.failed, "Replay of the partial occurrence resumes instead of failing");
check((await contactsFor(emailA)).length === 1, "The missing contact is created once");
check((await notifications(reqA.id)).length === 1, "The missing review notification is created once");
const ev = (await pool.query(`SELECT source_category, source_type, event_key FROM contact_source_events WHERE event_key=$1`, [`form:partner_application:${reqA.id}`])).rows;
check(ev.length === 1 && ev[0].source_category === "website_form" && ev[0].source_type === "partner_application", "The contact carries the partner source contract and the occurrence event key");
await intake.resumePartnerApplication(await reload(reqA.id), "partner");
check((await contactsFor(emailA)).length === 1 && (await notifications(reqA.id)).length === 1, "A second replay creates no duplicate contact or notification");
const metaA = (await notifications(reqA.id))[0].metadata;
check(metaA.reviewPolicy === "not_configured" && metaA.reviewOwnerUserId === null && metaA.reviewDueAt === null, "With no recorded policy the review item states it has no owner or due time (nothing invented)");

// 2. Nothing durable to resume from: truthful failure.
const reqB = await claim("b");
const r2 = await intake.resumePartnerApplication(await reload(reqB.id), "partner", new Date(Date.now() + 10 * 60_000));
check(r2.failed === "PARTIAL_INTAKE_NO_ACCOUNT" && (await reload(reqB.id)).lifecycleState === "failed", "A replay with no durable account fails truthfully so the applicant can resubmit");

// 3. Existing CRM contact with the same mailbox is linked, never duplicated.
const emailC = `par-c-${id}@fixture.invalid`;
await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone) VALUES('Pre','Existing',$1,$2)`, [emailC, nextPhone()]);
const reqC = await claim("c");
await partnerRow(emailC, reqC.id);
await intake.resumePartnerApplication(await reload(reqC.id), "partner");
check((await contactsFor(emailC)).length === 1, "An existing contact with the same mailbox is linked, not duplicated");

// 4. Recorded policy: owner and due time derive from the receipt time.
const adminId = randomUUID();
await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,'admin')`, [adminId, `par-admin-${id}@fixture.invalid`]);
let rejected = false;
try { await policy.setReviewPolicy({ partner_application_request: { ownerUserId: randomUUID(), dueHours: 24 } }, "cert"); } catch { rejected = true; }
check(rejected, "A policy owner that is not an existing reviewer is rejected");
await policy.setReviewPolicy({ partner_application_request: { ownerUserId: adminId, dueHours: 48 }, privacy_request: { ownerUserId: adminId, dueHours: 72 } }, "cert");
const emailD = `par-d-${id}@fixture.invalid`;
const reqD = await claim("d");
await partnerRow(emailD, reqD.id);
await intake.resumePartnerApplication(await reload(reqD.id), "partner");
const metaD = (await notifications(reqD.id))[0].metadata;
const expectedDue = new Date((await reload(reqD.id)).sourceReceivedAt.getTime() + 48 * 3600_000).toISOString();
check(metaD.reviewPolicy === "configured" && metaD.reviewOwnerUserId === adminId && metaD.reviewDueAt === expectedDue, "With a recorded policy the review item carries the named owner and the due time (receipt + policy hours)");
const privacy = await policy.resolveReviewAssignment("privacy_request", new Date("2026-01-01T00:00:00Z"));
check(privacy.dueAt === "2026-01-04T00:00:00.000Z" && privacy.ownerUserId === adminId, "Privacy review assignment derives from its own policy entry");

// 5. Source wiring.
const adminSrc = fs.readFileSync("server/routes/admin.ts", "utf8");
const importsSrc = fs.readFileSync("server/routes/imports.ts", "utf8");
const partnersSrc = fs.readFileSync("server/routes/partners.ts", "utf8");
check(/resolveReviewAssignment\("privacy_request"/.test(adminSrc), "The privacy request notification is stamped with the recorded owner and due time");
check(/claimPublicInbound\(req, res, \["website_form", "partner_application"\]/.test(importsSrc) && /completePartnerApplicationLocal\(inbound, partner as any, "affiliate"\)/.test(importsSrc) && !/\.catch\(\(\) => null\)/.test(importsSrc.slice(importsSrc.indexOf('"/api/affiliate/signup"'), importsSrc.indexOf('"/api/affiliate/login"'))),
  "Affiliate signup claims the occurrence, uses the shared local completion and no longer swallows the contact failure");
check(/onReplay/.test(partnersSrc) && /completePartnerApplicationLocal\(inbound, partner as any, "partner"\)/.test(partnersSrc), "Partner application uses the same repeatable completion and resumes on replay");

await pool.query(`DELETE FROM system_settings WHERE key=$1`, [policy.INBOUND_REVIEW_POLICY_KEY]);
console.log(`PARTNER_APPLICATION_RESUME_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
