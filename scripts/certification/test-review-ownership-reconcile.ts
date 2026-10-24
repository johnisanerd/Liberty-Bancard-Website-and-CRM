/**
 * Review ownership status and reconcile certification (disposable PostgreSQL; no provider, no send).
 * Old outstanding work gets a review notice and, only from a recorded policy, an owner and due time; a valid existing
 * assignment is preserved; a deactivated owner is surfaced and replaced; request status is never changed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Review ownership reconcile certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const policy = await import("../../server/services/inbound-review-policy");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [ROR-${String(checks).padStart(2, "0")}] ${message}`); };
const id = randomUUID().slice(0, 8);
await pool.query(`DELETE FROM system_settings WHERE key=$1`, [policy.INBOUND_REVIEW_POLICY_KEY]);

const mkAdmin = async (label: string, role = "admin") => {
  const uid = randomUUID();
  await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,$3)`, [uid, `ror-${label}-${id}@fixture.invalid`, role]);
  return uid;
};
const adminA = await mkAdmin("a");
const adminB = await mkAdmin("b", "manager");

// Old pending records with no review notice (as before the review queue existed).
const oldCreated = new Date(Date.now() - 5 * 24 * 3600_000);
const partner = await storage.createPartner({ companyName: `ROR ${id}`, contactName: "R", email: `ror-p-${id}@fixture.invalid`, phone: "+15550001111", partnerType: "referral", affiliateCode: `ror${id}`, status: "pending", commissionPercent: 10 } as any);
await pool.query(`UPDATE partners SET created_at=$2 WHERE id=$1`, [partner.id, oldCreated]);
const priv = (await pool.query(`INSERT INTO data_delete_requests(email,full_name,request_type,status,created_at) VALUES($1,'R P','delete','pending',$2) RETURNING id`, [`ror-d-${id}@fixture.invalid`, oldCreated])).rows[0].id;
const notice = async (key: string, recordId: number) => (await pool.query(`SELECT id, metadata FROM notifications WHERE metadata->>'${key}'=$1`, [String(recordId)])).rows;

let st = await policy.getReviewQueueStatus();
check(st.partner_application_request.outstanding === 1 && st.partner_application_request.withoutNotification === 1 && st.privacy_request.withoutNotification === 1 && st.privacy_request.ownerState === "not_configured", "Status shows outstanding items with no review notice and no recorded owner");

// No policy: notices are added, nothing is invented.
let r = await policy.reconcileReviewAssignments("cert");
const n1 = (await notice("partnerId", partner.id))[0];
check(r.created === 2 && r.stillUnassigned === 2 && n1.metadata.reviewPolicy === "not_configured" && n1.metadata.reviewOwnerUserId === null && n1.metadata.reviewDueAt === null, "With no policy, reconcile adds the missing notices and leaves owner and due time empty");
r = await policy.reconcileReviewAssignments("cert");
check(r.created === 0 && (await notice("partnerId", partner.id)).length === 1 && (await notice("dataRequestId", priv)).length === 1, "A repeat reconcile creates no duplicate notices");

// Recorded policy: owner and due time derive from the policy and the record's own receipt time.
await policy.setReviewPolicy({ partner_application_request: { ownerUserId: adminA, dueHours: 48 }, privacy_request: { ownerUserId: adminA, dueHours: 72 } }, "cert");
r = await policy.reconcileReviewAssignments("cert");
const n2 = (await notice("partnerId", partner.id))[0];
check(r.assigned === 2 && n2.metadata.reviewOwnerUserId === adminA && n2.metadata.reviewDueAt === new Date(oldCreated.getTime() + 48 * 3600_000).toISOString(), "Outstanding items receive the recorded owner and a due time counted from their own receipt");
const pn = (await notice("dataRequestId", priv))[0];
check(pn.metadata.reviewDueAt === new Date(oldCreated.getTime() + 72 * 3600_000).toISOString(), "The privacy item uses its own policy hours");
st = await policy.getReviewQueueStatus();
check(st.partner_application_request.overdue === 1 && st.partner_application_request.unassigned === 0, "Items past their recorded due time are reported as overdue");
check((await pool.query(`SELECT count(*)::int n FROM contacts WHERE lower(email) IN ($1,$2)`, [`ror-d-${id}@fixture.invalid`, `ror-p-${id}@fixture.invalid`])).rows[0].n === 0, "The privacy request stays contactless; reconcile creates no contact");

// A valid existing assignment is a recorded decision: preserved.
await pool.query(`UPDATE notifications SET metadata = metadata || $2::jsonb WHERE id=$1`, [n2.id, JSON.stringify({ reviewOwnerUserId: adminB })]);
r = await policy.reconcileReviewAssignments("cert");
check(r.preserved >= 1 && (await notice("partnerId", partner.id))[0].metadata.reviewOwnerUserId === adminB, "An assignment naming a valid reviewer is preserved");

// Deactivated owner is surfaced, then replaced from the policy.
await pool.query(`UPDATE users SET account_state='deactivated' WHERE id=$1`, [adminA]);
st = await policy.getReviewQueueStatus();
check(st.privacy_request.ownerState === "deactivated" && st.privacy_request.ownerNoLongerValid === 1, "A deactivated recorded owner is surfaced, with the count of items it leaves orphaned");
let rejected = false;
try { await policy.setReviewPolicy({ privacy_request: { ownerUserId: adminA, dueHours: 72 } }, "cert"); } catch { rejected = true; }
check(rejected, "A deactivated account cannot be recorded as owner");
const stillPolicyAssignment = await policy.resolveReviewAssignment("privacy_request", new Date());
check(stillPolicyAssignment.policy === "not_configured" && stillPolicyAssignment.reason === "owner_not_a_reviewer", "New items do not name a deactivated owner");
await policy.setReviewPolicy({ partner_application_request: { ownerUserId: adminB, dueHours: 48 }, privacy_request: { ownerUserId: adminB, dueHours: 72 } }, "cert");
r = await policy.reconcileReviewAssignments("cert");
const pn2 = (await notice("dataRequestId", priv))[0];
check(r.reassigned === 1 && pn2.metadata.reviewOwnerUserId === adminB && pn2.metadata.reviewPreviousOwnerUserId === adminA, "Reconcile replaces the deactivated owner and records who it replaced");

// Statuses untouched.
check((await pool.query(`SELECT status FROM partners WHERE id=$1`, [partner.id])).rows[0].status === "pending" && (await pool.query(`SELECT status FROM data_delete_requests WHERE id=$1`, [priv])).rows[0].status === "pending", "No request or application status was changed");
check((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action='inbound_review_reconcile'`)).rows[0].n === 5, "Every reconcile run is audited");

await pool.query(`DELETE FROM system_settings WHERE key=$1`, [policy.INBOUND_REVIEW_POLICY_KEY]);
console.log(`REVIEW_OWNERSHIP_RECONCILE_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
