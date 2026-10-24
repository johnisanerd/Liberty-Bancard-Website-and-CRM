/**
 * Partner/affiliate crash-boundary certification (disposable PostgreSQL; no provider, no network, no sends).
 *
 * Exercises the real account transaction, the real recovery sweep and the real occurrence authority at each point where
 * a process can stop, with no browser replay: after claim, inside the account transaction, after the account, after the
 * contact, and with a missing credential. Also proves concurrent recovery creates nothing twice, an unrelated
 * pre-existing account is never adopted, and a reused contact keeps this occurrence's source evidence.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Partner application crash-boundary certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const auth = await import("../../server/services/inbound-request-authority");
const intake = await import("../../server/services/partner-application-intake");
const accounts = await import("../../server/services/partner-account");
const { isDefinitiveSubmissionOutcome } = await import("../../client/src/lib/submission-key");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [CB-${String(checks).padStart(2, "0")}] ${message}`); };
const id = randomUUID().slice(0, 8);
let phoneSeq = Number.parseInt(id, 16) % 9000;
const nextPhone = () => `+1555${String(1000 + (phoneSeq++ % 9000)).padStart(7, "0")}`.slice(0, 12);
const later = () => new Date(Date.now() + 10 * 60_000);

const claim = async (label: string) => {
  const c = await auth.claimInboundRequest({ idempotencyKey: randomUUID(), sourceCategory: "website_form", sourceType: "partner_application", callerScope: "public:cert", actorType: "public", payload: { label, id } });
  assert.equal(c.outcome, "claimed");
  return (c as any).request;
};
const reload = async (rid: string) => (await auth.getInboundRequestById(rid))!;
const account = (email: string, requestId: string | undefined, role: "partner" | "affiliate" = "partner") => accounts.createPartnerAccount({
  companyName: `CB ${id}`, contactName: "Crash Fixture", email, phone: nextPhone(), passwordHash: "hash-not-a-password",
  partnerType: role === "affiliate" ? "affiliate" : "referral", affiliateCode: `cb${id}${Math.floor(Math.random() * 1e7)}`,
  status: role === "affiliate" ? "active" : "pending", commissionPercent: 10,
} as any, { role, inboundRequestId: requestId });
const n = async (sql: string, params: unknown[]) => Number((await pool.query(sql, params)).rows[0].n);
const contactsFor = (email: string) => n(`SELECT count(*)::int n FROM contacts WHERE lower(email)=$1`, [email]);
const notesFor = (rid: string) => n(`SELECT count(*)::int n FROM notifications WHERE inbound_request_id=$1`, [rid]);
const partnersFor = (email: string) => n(`SELECT count(*)::int n FROM partners WHERE lower(email)=$1`, [email]);
const usersFor = (email: string) => n(`SELECT count(*)::int n FROM users WHERE lower(email)=$1`, [email]);

// 1. Crash after claim, before the account transaction: nothing bound, nothing created.
const e1 = `cb1-${id}@fixture.invalid`;
const r1 = await claim("after-claim");
const fresh = await intake.resumePartnerApplication(await reload(r1.id), "partner");
check(!fresh.failed && (await reload(r1.id)).lifecycleState === "claimed", "A replay inside the grace period reports in-progress and does not fail an occurrence that may still be executing");
const stale = await intake.resumePartnerApplication(await reload(r1.id), "partner", later());
check(stale.failed === "PARTIAL_INTAKE_NO_ACCOUNT" && (await partnersFor(e1)) === 0, "After the grace period an occurrence that never created an account fails truthfully");

// 2. Fault inside the account transaction: the account, its credential and the binding commit together or not at all.
const e2 = `cb2-${id}@fixture.invalid`;
let faulted = false;
try { await account(e2, randomUUID()); } catch (err: any) { faulted = /INBOUND_ACCOUNT_BINDING_CONFLICT/.test(err.message); }
check(faulted && (await partnersFor(e2)) === 0 && (await usersFor(e2)) === 0, "A fault at the binding step rolls back the partner row and its credential: no orphan account");
const r2 = await claim("binding");
await account(e2, r2.id);
check((await reload(r2.id)).submittedEmail === e2 && (await partnersFor(e2)) === 1 && (await usersFor(e2)) === 1, "A committed account always comes with its credential and the occurrence's captured mailbox");

// 3. Crash after the account commit (the audited gap): recovery with no browser replay creates contact and review once.
check((await contactsFor(e2)) === 0 && (await notesFor(r2.id)) === 0, "Fixture: account committed, contact and review notification do not exist");
const sweep1 = await intake.recoverPartnerApplications({ now: later() });
check(sweep1.resumed >= 1 && (await contactsFor(e2)) === 1 && (await notesFor(r2.id)) === 1, "The ordinary recovery sweep finishes the missing local work from the occurrence alone");
const sweep2 = await intake.recoverPartnerApplications({ now: later() });
const st2 = await reload(r2.id);
check(st2.terminalReason !== "REVIEW_NOTIFICATION_FAILED" && st2.terminalReason !== "CONTACT_RECORD_FAILED", "A repeated pass does not mark a healthy occurrence as failed (the command-keyed notification is reused, not re-inserted)");
check((await contactsFor(e2)) === 1 && (await notesFor(r2.id)) === 1, "A second sweep creates nothing more");

// 4. Crash after the contact, before the notification.
const e4 = `cb4-${id}@fixture.invalid`;
const r4 = await claim("after-contact");
await account(e4, r4.id);
await (await import("../../server/services/contact-writer")).createContactLocalFirst(
  { firstName: "Crash", lastName: "Fixture", email: e4, phone: nextPhone(), status: "Active" } as any, undefined,
  { sourceCategory: "website_form", sourceType: "partner_application", eventKey: `form:partner_application:${r4.id}` });
await intake.recoverPartnerApplications({ now: later() });
check((await contactsFor(e4)) === 1 && (await notesFor(r4.id)) === 1, "Crash after the contact: recovery adds only the notification, no second contact");

// 5. Missing credential (account row exists, login user does not): recreated once from the stored hash; roles protected.
const e5 = `cb5-${id}@fixture.invalid`;
const r5 = await claim("credential");
await account(e5, r5.id, "affiliate");
await pool.query(`DELETE FROM users WHERE lower(email)=$1`, [e5]);
await intake.recoverPartnerApplications({ now: later() });
const u5 = (await pool.query(`SELECT role FROM users WHERE lower(email)=$1`, [e5])).rows;
check(u5.length === 1 && u5[0].role === "affiliate", "A missing affiliate login is recreated once with the affiliate role");
await intake.recoverPartnerApplications({ now: later() });
check((await usersFor(e5)) === 1, "Repeated recovery does not duplicate the credential");
const e5b = `cb5b-${id}@fixture.invalid`;
const p5b = await storage.createPartner({ companyName: "x", contactName: "x", email: e5b, phone: nextPhone(), passwordHash: "h", partnerType: "referral", affiliateCode: `cb5b${id}`, status: "pending", commissionPercent: 10 } as any);
await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,'admin')`, [randomUUID(), e5b]);
check((await accounts.ensurePartnerCredential(p5b, "partner")) === "role_conflict" && (await usersFor(e5b)) === 1, "An existing user of another role is reported and never modified");
let affiliateConflict = false;
try { await account(e5b + ".x", undefined, "affiliate"); await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,'partner')`, [randomUUID(), `cb5c-${id}@fixture.invalid`]); await account(`cb5c-${id}@fixture.invalid`, undefined, "affiliate"); } catch { affiliateConflict = true; }
check(affiliateConflict, "Affiliate account creation refuses an email that already has a login");

// 6. Concurrent recovery: four parallel passes over the same occurrence.
const e6 = `cb6-${id}@fixture.invalid`;
const r6 = await claim("concurrent");
await account(e6, r6.id);
await Promise.all([1, 2, 3, 4].map(() => intake.recoverPartnerApplications({ now: later() })));
check((await partnersFor(e6)) === 1 && (await contactsFor(e6)) === 1 && (await notesFor(r6.id)) === 1, "Concurrent recovery creates exactly one account, one contact and one notification");

// 7. An unrelated pre-existing account is never adopted: an unbound occurrence cannot claim it.
const e7 = `cb7-${id}@fixture.invalid`;
await storage.createPartner({ companyName: "Other", contactName: "Other", email: e7, phone: nextPhone(), passwordHash: "h", partnerType: "referral", affiliateCode: `cb7${id}`, status: "active", commissionPercent: 10 } as any);
const r7 = await claim("unrelated");
await intake.recoverPartnerApplications({ now: later() });
check((await reload(r7.id)).lifecycleState === "failed" && (await contactsFor(e7)) === 0 && (await notesFor(r7.id)) === 0, "An unbound occurrence does not adopt a same-mailbox account that it did not create");

// 8. Reused contact keeps this occurrence's source evidence.
const e8 = `cb8-${id}@fixture.invalid`;
await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone) VALUES('Pre','Existing',$1,$2)`, [e8, nextPhone()]);
const r8 = await claim("reused");
await account(e8, r8.id);
await intake.recoverPartnerApplications({ now: later() });
const ev8 = (await pool.query(`SELECT source_category, source_type FROM contact_source_events WHERE event_key=$1`, [`form:partner_application:${r8.id}`])).rows;
check((await contactsFor(e8)) === 1 && ev8.length === 1 && ev8[0].source_type === "partner_application", "A reused contact is linked and gains this occurrence's partner source event (no duplicate contact)");
await intake.recoverPartnerApplications({ now: later() });
check((await n(`SELECT count(*)::int n FROM contact_source_events WHERE event_key=$1`, [`form:partner_application:${r8.id}`])) === 1, "Recovery repeated: still exactly one source event for the occurrence");

// 9. Occurrences waiting on a human for another reason are left alone.
const r9 = await claim("human-review");
await auth.setInboundRequestLifecycle(r9.id, "review_required", "UNASSIGNED_POLICY_MISSING");
await pool.query(`UPDATE inbound_requests SET updated_at = now() - interval '1 hour' WHERE id=$1`, [r9.id]);
await intake.recoverPartnerApplications({ now: later() });
check((await reload(r9.id)).lifecycleState === "review_required" && (await reload(r9.id)).terminalReason === "UNASSIGNED_POLICY_MISSING", "A request waiting on a human for a non-local reason is not touched by recovery");

// 10. Client retry contract: unreadable or failed responses keep the key; settled answers release it.
check(!isDefinitiveSubmissionOutcome(200, null) && !isDefinitiveSubmissionOutcome(500, { error: "x" }) && !isDefinitiveSubmissionOutcome(502, null), "An unreadable body or a server error keeps the key so the retry replays the same occurrence");
check(isDefinitiveSubmissionOutcome(201, {}) && isDefinitiveSubmissionOutcome(409, { error: "PREVIOUS_ATTEMPT_NOT_RECORDED" }) && isDefinitiveSubmissionOutcome(400, {}), "A settled answer releases the key");

console.log(`PARTNER_APPLICATION_CRASH_BOUNDARIES_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
