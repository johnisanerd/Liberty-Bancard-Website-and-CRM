/**
 * Merchant application outbox handoff certification (disposable database; no provider, no network, no sends).
 *
 * F3: the GHL projection handoff is recorded as a durable consumable command while the email/outbound pause is ON;
 * a missing GHL contact id is a durable wait (no attempt consumed, row not delivered, no skipped evidence) for
 * approval/decline messages; the statement-upload step 7 writes the same consumable pending projection. Handoff,
 * provider completion and message completion stay separate facts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Merchant outbox handoff certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const worker = await import("../../server/services/merchant-application-outbox-worker");
const pauseAuthority = await import("../../server/services/outbound-pause-authority");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [MOH-${String(checks).padStart(2, "0")}] ${message}`); };
const id = randomUUID().slice(0, 8);

const setPause = async (state: "paused" | "unpaused") => {
  const updated = await pool.query(`UPDATE outbound_pause_control SET state=$1, reason='outbox handoff certification', committed_at=NOW()`, [state]);
  if (updated.rowCount === 0) {
    await pool.query(`INSERT INTO outbound_pause_control (state,reason,epoch,actor,idempotency_key,committed_at) VALUES ($1,'outbox handoff certification',1,'moh-cert',$2,NOW())`, [state, `moh-${randomUUID()}`]);
  }
  pauseAuthority.invalidatePauseStateCache();
};
await setPause("paused");

const phone = `+1555${String(Number.parseInt(id, 16) % 1000).padStart(3, "0")}0${String(Math.floor(Math.random() * 900) + 100)}`;
const contactId = (await pool.query(
  `INSERT INTO contacts(first_name,last_name,email,phone) VALUES('Moh','Fixture',$1,$2) RETURNING id`,
  [`moh-${id}@fixture.invalid`, phone])).rows[0].id as number;
const appId = (await pool.query(
  `INSERT INTO merchant_applications(contact_id, owner_email, owner_first_name, owner_last_name, legal_business_name) VALUES($1,$2,'Moh','Fixture','Moh Fixture LLC') RETURNING id`,
  [contactId, `moh-${id}@fixture.invalid`])).rows[0].id as number;
await pool.query(`DELETE FROM merchant_application_protected_outbox WHERE status IN ('pending','failed','processing')`);
const enqueue = async (eventType: string, key: string) => (await pool.query(
  `INSERT INTO merchant_application_protected_outbox(application_id,event_type,idempotency_key,payload) VALUES($1,$2,$3,'{}'::jsonb) RETURNING id`,
  [appId, eventType, `moh-${id}-${key}`])).rows[0].id as string;
const row = async (rid: string) => (await pool.query(`SELECT status, attempts, last_error FROM merchant_application_protected_outbox WHERE id=$1`, [rid])).rows[0];
const projections = async () => (await pool.query(`SELECT state FROM contact_provider_projections WHERE contact_id=$1 AND provider='ghl'`, [contactId])).rows;
const pauseState = async () => (await pool.query(`SELECT state FROM outbound_pause_control ORDER BY committed_at DESC LIMIT 1`)).rows[0].state;

// 1. Pause ON: the handoff is still recorded as a durable consumable command.
const sync1 = await enqueue("ghl_sync", "sync1");
await worker.__test__.tick();
const s1 = await row(sync1);
check(s1.status === "delivered", "ghl_sync completes its handoff while the outbound pause is on");
const p1 = await projections();
check(p1.length === 1 && p1[0].state === "pending", "A consumable pending projection exists for the contact (not an audit-only record)");
const sync2 = await enqueue("ghl_sync", "sync2");
await worker.__test__.tick();
check((await row(sync2)).status === "delivered" && (await projections()).length === 1, "A repeated handoff reuses the one projection (idempotent)");
check(await pauseState() === "paused", "The pause stayed on; nothing was sent");

// 2. Statement-upload step 7 writes the same consumable command.
await pool.query(`DELETE FROM contact_provider_projections WHERE contact_id=$1`, [contactId]);
const { enqueueGhlContactProjection } = await import("../../server/services/ghl-form-sync");
await enqueueGhlContactProjection(contactId);
await enqueueGhlContactProjection(contactId);
check((await projections()).length === 1 && (await projections())[0].state === "pending", "The shared handoff helper is idempotent and leaves a pending projection");
const chainSrc = (await import("node:fs")).readFileSync("server/services/statement-upload-chain.ts", "utf8");
check(/enqueueGhlContactProjection\(input\.contactId\)/.test(chainSrc) && !/handed_off_not_enqueued/.test(chainSrc), "Statement-upload step 7 enqueues the consumable projection instead of an audit-only note");

// 3. Missing GHL contact id: durable wait, not a lost message.
await setPause("unpaused");
for (const [event, skipAction] of [["approval_email", "merchant_application_approved_email_skipped"], ["decline_email", "merchant_application_declined_email_skipped"]] as const) {
  const rid = await enqueue(event, event);
  await worker.__test__.tick();
  const r = await row(rid);
  const skipped = Number((await pool.query(`SELECT count(*) c FROM audit_logs WHERE action=$1 AND entity_id=$2`, [skipAction, appId])).rows[0].c);
  check(r.status === "pending" && r.last_error === "waiting:ghl_contact_pending", `${event} with no GHL contact id waits durably instead of completing`);
  check(r.attempts === 0 && skipped === 0, `${event} wait consumes no attempt and records no skipped evidence`);
}
await setPause("paused");

await pool.query(`DELETE FROM merchant_application_protected_outbox WHERE application_id=$1`, [appId]);
await pool.query(`DELETE FROM contact_provider_projections WHERE contact_id=$1`, [contactId]);
console.log(`MERCHANT_OUTBOX_HANDOFF_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
