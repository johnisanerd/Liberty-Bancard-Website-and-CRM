import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "governed Data Health reconcile certification", requireRedis: false });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool } = await import("../../server/db");
const svc = await import("../../server/services/data-health-reconcile");
const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
const adminId = `dh-admin-${nonce}`;
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };
const q = async (text: string, v: any[] = []) => (await pool.query(text, v)).rows;

async function contact(label: string, o: { email?: string; archived?: boolean; cls?: string; } = {}) {
  const r = await q(`INSERT INTO contacts (first_name,last_name,phone,email,company_name,record_class,archived_at)
    VALUES('Dh','Fixture','',$1,$2,$3,$4) RETURNING id`,
  [o.email ?? `${label}.${nonce}@dh.example.test`, `Dh ${label} ${nonce}`, o.cls ?? "production", o.archived ? new Date() : null]);
  return Number(r[0].id);
}
async function orphanDeal(notes: string | null) {
  return Number((await q(`INSERT INTO deals (notes,pipeline,stage,record_class) VALUES($1,'sales','New Lead','production') RETURNING id`, [notes]))[0].id);
}
async function orphanEnrollments(ownerId: number, statuses: string[]) {
  const seqs: number[] = [], ids: number[] = [];
  for (const [i, status] of statuses.entries()) {
    seqs.push(Number((await q(`INSERT INTO follow_up_sequences (name,trigger_type,status) VALUES($1,'manual','paused') RETURNING id`, [`dh-${nonce}-${seqCounter++}`]))[0].id));
    ids.push(Number((await q(`INSERT INTO sequence_enrollments (contact_id,sequence_id,status,next_action_at) VALUES($1,$2,$3,NULL) RETURNING id`, [ownerId, seqs[i], status]))[0].id));
  }
  const raw = await pool.connect();
  try { await raw.query(`SET session_replication_role = replica`); await raw.query(`DELETE FROM follow_up_sequences WHERE id=ANY($1::int[])`, [seqs]); }
  finally { await raw.query(`SET session_replication_role = DEFAULT`).catch(() => undefined); raw.release(); }
  return ids;
}
let seqCounter = 0;
const statusOf = async (id: number) => (await q(`SELECT status FROM sequence_enrollments WHERE id=$1`, [id]))[0].status;
const dealContact = async (id: number) => (await q(`SELECT contact_id FROM deals WHERE id=$1`, [id]))[0].contact_id;
const auditCount = async (action: string, op?: string) => Number((await q(
  `SELECT count(*)::int n FROM audit_logs WHERE action=$1 AND ($2::text IS NULL OR entity_key=$2)`, [action, op ? `data_health_reconcile:${op}` : null]))[0].n);

try {
  await q(`INSERT INTO users (id,email,role) VALUES($1,$2,'admin')`, [adminId, `${nonce}@admin.example.test`]);
  // Fixtures.
  const cUnique = await contact("unique");
  const dUnique = await orphanDeal(`Callback requested by ${`unique.${nonce}@dh.example.test`.toUpperCase()} today`);
  const cDupA = await contact("dup", { email: `dup.${nonce}@dh.example.test` });
  await contact("dup2", { email: `dup.${nonce}@dh.example.test` });
  const dAmbiguous = await orphanDeal(`email dup.${nonce}@dh.example.test`);
  await contact("arch", { email: `arch.${nonce}@dh.example.test`, archived: true });
  const dArchived = await orphanDeal(`email arch.${nonce}@dh.example.test`);
  await contact("test", { email: `tst.${nonce}@dh.example.test`, cls: "test" });
  const dNonprod = await orphanDeal(`email tst.${nonce}@dh.example.test`);
  const dNoEmail = await orphanDeal("walk-in, no address");
  const dNoMatch = await orphanDeal(`email nobody.${nonce}@dh.example.test`);

  // Orphan enrollments (parent sequence removed under replica mode), plus one healthy enrollment.
  const owner = await contact("enroll");
  const [eActive, ePaused, eX1, eX2, eA, eB, eR1, eR2] = await orphanEnrollments(owner, ["active", "paused", "active", "active", "active", "active", "active", "active"]);
  const healthySeq = Number((await q(`INSERT INTO follow_up_sequences (name,trigger_type,status) VALUES($1,'manual','paused') RETURNING id`, [`dh-${nonce}-healthy`]))[0].id);
  const eHealthy = Number((await q(`INSERT INTO sequence_enrollments (contact_id,sequence_id,status,next_action_at) VALUES($1,$2,'active',NULL) RETURNING id`, [owner, healthySeq]))[0].id);


  // ── Plan is read only and classifies exactly ──
  const snapshot = async () => JSON.stringify([
    await q(`SELECT id,contact_id,notes,updated_at FROM deals WHERE id=ANY($1::int[]) ORDER BY id`, [[dUnique, dAmbiguous, dArchived, dNonprod, dNoEmail, dNoMatch]]),
    await q(`SELECT id,status,next_action_at,updated_at FROM sequence_enrollments WHERE contact_id=$1 ORDER BY id`, [owner]),
    await q(`SELECT id,status FROM sequence_enrollments WHERE id=ANY($1::int[]) ORDER BY id`, [[eX1, eX2]])]);
  const enrollBefore = Number((await q(`SELECT count(*)::int n FROM sequence_enrollments`))[0].n);
  const before = await snapshot();
  const auditBefore = Number((await q(`SELECT count(*)::int n FROM audit_logs`))[0].n);
  const plan = await svc.readDataHealthReconcilePlan();
  check(before === await snapshot() && auditBefore === Number((await q(`SELECT count(*)::int n FROM audit_logs`))[0].n), "Plan writes nothing, including audit rows");
  const keys = plan.actions.map(a => a.key);
  check(keys.includes(`deal_link:${dUnique}:${cUnique}`), "Unique exact (case-insensitive) email match is actionable");
  check(!keys.some(k => k.startsWith(`deal_link:${dAmbiguous}:`) || k.startsWith(`deal_link:${dArchived}:`) || k.startsWith(`deal_link:${dNonprod}:`) ||
    k.startsWith(`deal_link:${dNoEmail}:`) || k.startsWith(`deal_link:${dNoMatch}:`)), "Ambiguous, archived-only, non-production, no-email and no-match deals produce no action");
  const reasons = Object.fromEntries(plan.unresolvedDeals.map(u => [u.dealId, u.reason]));
  check(reasons[dAmbiguous] === "ambiguous_multiple_contacts" && reasons[dArchived] === "ineligible_contact" && reasons[dNonprod] === "ineligible_contact"
    && reasons[dNoEmail] === "no_email_in_notes" && reasons[dNoMatch] === "no_contact_match", "Each unresolved deal carries its exact reason");
  check(plan.unresolvedDeals.find(u => u.dealId === dAmbiguous)?.candidateContactIds.includes(cDupA), "Ambiguity lists the competing contacts");
  check(keys.includes(`enrollment_cancel:${eActive}`) && keys.includes(`enrollment_cancel:${ePaused}`) && !keys.includes(`enrollment_cancel:${eHealthy}`),
    "Active and paused orphan enrollments are actionable; a healthy enrollment is not");
  check(plan.populations.activeEnrollmentsNoNextAction.total >= 3 && (plan.populations.activeEnrollmentsNoNextAction as any).changedByThisTool === false,
    "Missing next_action_at is reported but marked as not changed by this tool");
  check(!keys.some(k => k.includes("next_action")), "No action reschedules enrollments");

  // ── Validation ──
  const op1 = randomUUID();
  for (const bad of [[], ["bogus:1"], ["deal_link:5"], ["enrollment_cancel:5:6"], Array.from({ length: 101 }, (_, i) => `enrollment_cancel:${i + 1}`)]) {
    await assert.rejects(() => svc.applyDataHealthReconcile({ operationId: op1, actionKeys: bad as string[], actorId: adminId }), svc.ReconcileError);
    checks++;
  }
  await assert.rejects(() => svc.applyDataHealthReconcile({ operationId: "not-a-uuid", actionKeys: [`enrollment_cancel:${eX1}`], actorId: adminId }), /UUID/);
  checks++;
  check((await svc.readDataHealthReconcileReceipt(op1)) === null, "Rejected requests leave no operation record");

  // ── Apply: explicit selection only, forged and stale keys are refused ──
  const forged = `deal_link:${dAmbiguous}:${cDupA}`;
  const chosen = [`deal_link:${dUnique}:${cUnique}`, `enrollment_cancel:${eActive}`, `enrollment_cancel:${eX1}`, forged];
  const op2 = randomUUID();
  // Direct-SQL invariants: apply may change only deals.contact_id / enrollment status+metadata (and write audit/receipt rows).
  const invariantSnapshot = async () => ({
    contacts: (await q(`SELECT md5(string_agg(to_jsonb(c)::text, '|' ORDER BY id)) h, count(*)::int n, count(*) FILTER (WHERE lifecycle_state IS NULL)::int nl FROM contacts c WHERE email LIKE $1`, [`%.${nonce}@dh.example.test`]))[0],
    dealsOther: (await q(`SELECT md5(string_agg((to_jsonb(d) - 'contact_id' - 'updated_at')::text, '|' ORDER BY id)) h, count(*)::int n FROM deals d WHERE notes LIKE $1 OR notes IS NULL`, [`%${nonce}%`]))[0],
    enrollOther: (await q(`SELECT md5(string_agg((to_jsonb(e) - 'status' - 'metadata' - 'updated_at')::text, '|' ORDER BY id)) h FROM sequence_enrollments e`))[0].h,
    commEvents: (await q(`SELECT CASE WHEN to_regclass('public.communication_events') IS NULL THEN -1 ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) n FROM communication_events', false, true, '')))[1]::text::int END n`))[0].n,
    pause: (await q(`SELECT md5(string_agg(key||value::text, '|' ORDER BY key)) h FROM system_settings WHERE key ILIKE '%pause%'`))[0].h,
  });
  const invBefore = await invariantSnapshot();
  const run = await svc.applyDataHealthReconcile({ operationId: op2, actionKeys: chosen, actorId: adminId });
  const byKey = Object.fromEntries(run.receipt.outcomes.map(o => [o.key, o.status]));
  check(!run.replayed && run.receipt.status === "complete", "First request completes");
  const invAfter = await invariantSnapshot();
  check(invAfter.contacts.h === invBefore.contacts.h && invAfter.contacts.nl === 0, "Lifecycle and every other contact field are unchanged by apply (no lifecycle transition, no null lifecycle)");
  check(invAfter.dealsOther.h === invBefore.dealsOther.h && invAfter.enrollOther === invBefore.enrollOther, "Apply changes no deal stage/owner/value and no enrollment schedule field (next_action_at, step, sequence)");
  check(invAfter.commEvents === invBefore.commEvents, "Apply records no communication event and sends nothing");
  check(invAfter.pause === invBefore.pause, "Apply leaves every pause setting unchanged");
  check(byKey[chosen[0]] === "applied" && byKey[chosen[1]] === "applied" && byKey[chosen[2]] === "applied", "Selected actions apply");
  check(byKey[forged] === "not_current" && await dealContact(dAmbiguous) == null, "A forged link to an ambiguous identity is refused and nothing changes");
  check(Number(await dealContact(dUnique)) === cUnique, "Deal link read back from the database");
  check((await q(`SELECT status,metadata->>'operationId' op FROM sequence_enrollments WHERE id=$1`, [eActive]))[0].status === "cancelled", "Orphan enrollment cancelled and read back");
  check((await q(`SELECT status FROM sequence_enrollments WHERE id=$1`, [ePaused]))[0].status === "paused", "Unselected paused enrollment is untouched");
  check((await q(`SELECT status FROM sequence_enrollments WHERE id=$1`, [eHealthy]))[0].status === "active", "Healthy enrollment untouched");
  check((await q(`SELECT next_action_at FROM sequence_enrollments WHERE id=$1`, [eHealthy]))[0].next_action_at === null, "next_action_at is never invented");
  check(await statusOf(eX1) === "cancelled", "Third selected enrollment cancelled");
  check(await statusOf(eX2) === "active", "Unselected enrollment untouched");
  check(await auditCount("DATA_HEALTH_DEAL_LINKED", op2) === 1 && await auditCount("DATA_HEALTH_ENROLLMENT_CANCELLED", op2) === 2, "Exactly one audit row per applied action, tied to the operation and actor");
  check((await q(`SELECT user_id FROM audit_logs WHERE action='DATA_HEALTH_DEAL_LINKED' AND entity_key=$1`, [`data_health_reconcile:${op2}`]))[0].user_id === adminId, "Audit retains the acting administrator");

  // ── Replay, lost response, conflict, concurrency ──
  const replay = await svc.applyDataHealthReconcile({ operationId: op2, actionKeys: [...chosen].reverse(), actorId: adminId });
  check(replay.replayed && replay.receipt.completedAt === run.receipt.completedAt && await auditCount("DATA_HEALTH_DEAL_LINKED", op2) === 1,
    "Replay (even reordered) returns the stored receipt and writes nothing new");
  const stored = await svc.readDataHealthReconcileReceipt(op2);
  check(stored?.status === "complete" && stored.counts.applied === 3 && stored.counts.not_current === 1, "Receipt is durably readable after the response is lost");
  await assert.rejects(() => svc.applyDataHealthReconcile({ operationId: op2, actionKeys: [`enrollment_cancel:${eX2}`], actorId: adminId }), /different selection/);
  checks++;
  await assert.rejects(() => svc.applyDataHealthReconcile({ operationId: op2, actionKeys: chosen, actorId: "someone-else" }), /different selection or administrator/);
  checks++;
  check(await statusOf(eX2) === "active", "A conflicting reuse of an operation id changes nothing");

  const op3 = randomUUID();
  const raced = await Promise.all([1, 2, 3].map(() => svc.applyDataHealthReconcile({ operationId: op3, actionKeys: [`enrollment_cancel:${ePaused}`, `enrollment_cancel:${eX2}`], actorId: adminId })));
  check(raced.filter(r => !r.replayed).length === 1, "Concurrent identical requests: exactly one executes");
  check(await auditCount("DATA_HEALTH_ENROLLMENT_CANCELLED", op3) === 2, "Concurrent requests write one audit row per action");

  // Same action under a different operation is idempotent, not duplicated.
  const op4 = randomUUID();
  const again = await svc.applyDataHealthReconcile({ operationId: op4, actionKeys: [`enrollment_cancel:${ePaused}`, `enrollment_cancel:${eX1}`, `deal_link:${dUnique}:${cUnique}`], actorId: adminId });
  check(again.receipt.counts.already_applied === 3 && again.receipt.counts.applied === 0 && await auditCount("DATA_HEALTH_DEAL_LINKED") === 1, "A new operation over already-repaired items reports already_applied");

  // ── Archive / wrong-owner changes between plan and apply ──
  const cLate = await contact("late");
  const dLate = await orphanDeal(`email late.${nonce}@dh.example.test`);
  const lateKey = `deal_link:${dLate}:${cLate}`;
  check((await svc.readDataHealthReconcilePlan()).actions.some(a => a.key === lateKey), "Plan offers the late deal");
  await q(`UPDATE contacts SET archived_at=NOW() WHERE id=$1`, [cLate]);
  const late = await svc.applyDataHealthReconcile({ operationId: randomUUID(), actionKeys: [lateKey], actorId: adminId });
  check(late.receipt.outcomes[0].status === "not_current" && await dealContact(dLate) == null, "Contact archived after planning: link refused");
  await q(`UPDATE contacts SET archived_at=NULL WHERE id=$1`, [cLate]);
  await contact("late2", { email: `late.${nonce}@dh.example.test` });
  const late2 = await svc.applyDataHealthReconcile({ operationId: randomUUID(), actionKeys: [lateKey], actorId: adminId });
  check(late2.receipt.outcomes[0].status === "not_current" && await dealContact(dLate) == null, "Second contact appears after planning: link refused as ambiguous");

  // ── Audit failure and partial process failure roll back only the affected action ──
  await q(`CREATE OR REPLACE FUNCTION dh_fail_audit_${nonce}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.entity_id = ${eA} AND NEW.action='DATA_HEALTH_ENROLLMENT_CANCELLED' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$`);
  await q(`CREATE TRIGGER dh_fail_audit_trg_${nonce} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION dh_fail_audit_${nonce}()`);
  try {
    const op5 = randomUUID();
    const partial = await svc.applyDataHealthReconcile({ operationId: op5, actionKeys: [`enrollment_cancel:${eA}`, `enrollment_cancel:${eB}`], actorId: adminId });
    const st = Object.fromEntries(partial.receipt.outcomes.map(o => [o.key, o.status]));
    check(st[`enrollment_cancel:${eA}`] === "failed" && st[`enrollment_cancel:${eB}`] === "applied", "Audit failure fails that action and the rest continue");
    check(await statusOf(eA) === "active" && await statusOf(eB) === "cancelled", "Audit failure leaves no business change for that action (atomic) and the other commits");
    check(partial.receipt.counts.failed === 1 && partial.receipt.counts.applied === 1 && partial.receipt.status === "complete", "Receipt states partial failure honestly");
  } finally {
    await q(`DROP TRIGGER IF EXISTS dh_fail_audit_trg_${nonce} ON audit_logs`);
    await q(`DROP FUNCTION IF EXISTS dh_fail_audit_${nonce}()`);
  }
  // A failed action can be retried under a new operation once the cause is gone.
  const retry = await svc.applyDataHealthReconcile({ operationId: randomUUID(), actionKeys: [`enrollment_cancel:${eA}`], actorId: adminId });
  check(retry.receipt.outcomes[0].status === "applied", "Failed action succeeds on a fresh operation after the cause is removed");

  // ── Interrupted operation resumes without repeating finished work ──
  const op6 = randomUUID();
  const keys6 = [`enrollment_cancel:${eR1}`, `enrollment_cancel:${eR2}`].sort();
  const crypto = await import("node:crypto");
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  await q(`INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb)`, [`data_health_reconcile_op:${op6}`, JSON.stringify({
    operationId: op6, status: "in_progress", requestHash: crypto.createHash("sha256").update(JSON.stringify(keys6)).digest("hex"), actorId: adminId,
    startedAt: stale, heartbeatAt: stale, completedAt: null, requested: 2,
    outcomes: [{ key: keys6[0], status: "applied", detail: "done before crash" }], counts: { applied: 1, already_applied: 0, not_current: 0, failed: 0 } })]);
  const fresh6 = new Date().toISOString();
  const resumed = await svc.applyDataHealthReconcile({ operationId: op6, actionKeys: keys6, actorId: adminId });
  check(resumed.receipt.status === "complete" && resumed.receipt.outcomes.length === 2 && resumed.receipt.outcomes[0].detail === "done before crash",
    "A stale in-progress operation resumes and keeps the earlier outcome");
  // A live (fresh heartbeat) operation is not taken over.
  const op7 = randomUUID();
  const keys7 = [`enrollment_cancel:${eX2}`];
  await q(`INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb)`, [`data_health_reconcile_op:${op7}`, JSON.stringify({
    operationId: op7, status: "in_progress", requestHash: crypto.createHash("sha256").update(JSON.stringify(keys7)).digest("hex"), actorId: adminId,
    startedAt: fresh6, heartbeatAt: fresh6, completedAt: null, requested: 1, outcomes: [], counts: { applied: 0, already_applied: 0, not_current: 0, failed: 0 } })]);
  const live = await svc.applyDataHealthReconcile({ operationId: op7, actionKeys: keys7, actorId: adminId });
  check(live.replayed && live.receipt.status === "in_progress" && live.receipt.outcomes.length === 0, "A live in-progress operation is reported, not duplicated");

  // ── Boundaries ──
  check(Number((await q(`SELECT count(*)::int n FROM sequence_enrollments`))[0].n) === enrollBefore, "No enrollment was created by reconciliation");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider network attempt");
  console.log(`Governed Data Health reconcile: ${checks} checks passed`);
} finally { await pool.end(); }
