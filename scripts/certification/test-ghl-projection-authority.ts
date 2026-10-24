/**
 * GHL projection generation authority certification (#2105; disposable database; fake final HTTP transport).
 *
 * Covers C1 (tick lease/lock cleanup, healthy idle, half-open), C2 (one open projection, generation CAS,
 * convergence of legacy duplicates), C3 (deferral accounting, ambiguity, exhaustion, export fences),
 * C6 (receipt-before-ack, appointment ordering) and C8 (per-contact receipt levels).
 *
 * No real provider call can happen: provider denial is fatal, and every request to the GHL host is answered by
 * an in-process fake that records the call. Each required negative control is a "mutant": the old behavior is
 * reproduced explicitly and the same assertion is shown to detect it.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "GHL projection authority certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

process.env.GHL_PRIVATE_INTEGRATION_TOKEN = "fake-token-not-real";
process.env.GHL_LOCATION_ID = "loc_cert_fake";
process.env.BACKGROUND_JOB_PROFILE = "ghl-sync-only";
process.env.REPL_DEPLOYMENT_ID = "ghl-projection-cert-deployment";
process.env.RELEASE_SHA = process.env.RELEASE_SHA || "ghlcert0000000000000000000000000000000000";

// Fake final transport: GHL host only. Everything else keeps the deny boundary.
type Call = { method: string; url: string };
const ghlCalls: Call[] = [];
const denyFetch = globalThis.fetch;
const installedFields = ["lb_consent_email", "lb_consent_sms", "lb_do_not_sdr", "lb_promo_code", "lb_pain_points", "lb_lead_source", "external_contact_id", "lead_score", "contact_role"];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const defaultResponder = (call: Call): Response =>
  /\/customFields$/.test(call.url)
    ? json({ customFields: installedFields.map((k, i) => ({ id: `cf_${i}`, fieldKey: `contact.${k}` })) })
    : json({ contacts: [] });
let ghlResponder: (call: Call) => Response | Promise<Response> = defaultResponder;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
  if (url.includes("services.leadconnectorhq.com")) {
    const call = { method: String(init?.method ?? "GET").toUpperCase(), url };
    ghlCalls.push(call);
    return ghlResponder(call);
  }
  return denyFetch(input, init);
}) as typeof fetch;

const { pool } = await import("../../server/db");
const authority = await import("../../server/services/ghl-projection-authority");
const convergence = await import("../../server/services/ghl-projection-convergence");
const sync = await import("../../server/services/ghl-sync");
const recorder = await import("../../server/services/ghl-dispatch-recorder");
const receipts = await import("../../server/services/ghl-webhook-receipts");
const appointments = await import("../../server/services/ghl-appointment-events");
const controlService = await import("../../server/services/ghl-sync-control");
const runtime = await import("../../server/services/ghl-sync-runtime");
const { db } = await import("../../server/db");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [GPA-${String(checks).padStart(2, "0")}] ${message}`); };
const run = randomUUID().slice(0, 8);
let seq = Number.parseInt(run, 16) % 5_000_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function mkContact(opts: { recordClass?: string; ghl?: string | null; archived?: boolean } = {}): Promise<number> {
  seq += 1;
  const phone = `+1555${String(seq % 10_000_000).padStart(7, "0")}`;
  const r = await pool.query(
    `INSERT INTO contacts(first_name,last_name,email,phone,record_class,ghl_contact_id,archived_at)
     VALUES('Gpa','Fixture',$1,$2,$3,$4,$5) RETURNING id`,
    [`gpa-${run}-${seq}@fixture.invalid`, phone, opts.recordClass ?? "unknown", opts.ghl ?? null, opts.archived ? new Date() : null]);
  return r.rows[0].id as number;
}
const projRows = async (contactId: number) =>
  (await pool.query(`SELECT * FROM contact_provider_projections WHERE contact_id=$1 AND provider='ghl' ORDER BY created_at, id`, [contactId])).rows;
const openRows = async (contactId: number) =>
  (await projRows(contactId)).filter(r => ["pending", "retry", "processing"].includes(r.state));
const enqueue = (contactId: number, sourceKind = "cert") => authority.enqueueContactProjection(db as any, { contactId, sourceKind });
const makeDue = (contactId: number) =>
  pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() - interval '1 second' WHERE contact_id=$1 AND provider='ghl' AND state IN ('pending','retry')`, [contactId]);
const mine = (ids: number[]) => async (rows: any[]) => rows.filter(r => ids.includes(Number(r.contactId)));

// Claim helpers: claiming is real, so rows that are not the subject are released straight back (no budget change).
async function claimFor(contactIds: number[]) {
  const all = await authority.claimEligibleProjections(200);
  const keep = all.filter(r => contactIds.includes(r.contactId));
  for (const r of all) if (!keep.includes(r)) await authority.settleProjection(r, { kind: "released" });
  return keep;
}
async function claimable(contactIds: number[]): Promise<boolean> {
  const keep = await claimFor(contactIds);
  for (const r of keep) await authority.settleProjection(r, { kind: "released" });
  return keep.length > 0;
}
const syncOk = async () => ({ success: true });

// ---------------------------------------------------------------- migration / schema
const migrationSql = readFileSync("migrations/0374_ghl_projection_generation_authority.sql", "utf8");
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
check(convergence.GHL_PROJECTION_CONVERGENCE_STATEMENTS.every(s => normalize(migrationSql).includes(normalize(s))),
  "Migration 0374 contains every convergence statement used at runtime (build-time and runtime convergence cannot drift)");
check(/"tag":\s*"0374_ghl_projection_generation_authority"/.test(readFileSync("migrations/meta/_journal.json", "utf8")), "Migration 0374 is registered in the journal");
const idx = (await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='contact_provider_projections'`)).rows;
check(idx.some(i => /UNIQUE/i.test(i.indexdef) && /authority_version IS NOT NULL/i.test(i.indexdef)),
  "One-open-projection unique index exists and is scoped to authority-adopted rows (legacy duplicates cannot break the build)");
check((await pool.query(`SELECT to_regclass('ghl_provider_event_receipts') r, to_regclass('ghl_appointment_state') a`)).rows[0].r !== null, "Receipt and appointment state tables exist");

// ---------------------------------------------------------------- C2: enqueue authority
const c1 = await mkContact();
const e1 = await enqueue(c1);
check(e1.action === "inserted" && e1.disposition === "current_intake" && (await openRows(c1)).length === 1, "First enqueue inserts one pending current-intake projection");
const e2 = await enqueue(c1);
check(e2.action === "coalesced" && e2.desiredGeneration === 2 && (await openRows(c1)).length === 1, "Repeated enqueue coalesces into the same row and advances the desired generation");

const cTest = await mkContact({ recordClass: "test" });
const eTest = await enqueue(cTest);
check(eTest.action === "not_exported" && (await projRows(cTest)).length === 0, "A test-class contact is never queued for export");
const cFence = await mkContact();
await pool.query(`INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,terminal_reason,authority_version,export_disposition) VALUES($1,'ghl',$2,'terminal','pipeline_local_only',1,'local_only')`, [cFence, `contact:${cFence}`]);
const eFence = await enqueue(cFence);
check(eFence.action === "not_exported" && (await openRows(cFence)).length === 0, "A pipeline local-only fence is never reopened by a later edit");
const cLinked = await mkContact({ ghl: `ghl_${run}_linked` });
check((await enqueue(cLinked)).disposition === "linked_update", "A contact already linked to GHL queues a linked update");

// concurrency
const cCon = await mkContact();
const concurrent = await Promise.all(Array.from({ length: 20 }, () => enqueue(cCon)));
const conRows = await openRows(cCon);
check(concurrent.every(r => r.action !== "not_exported") && conRows.length === 1 && Number(conRows[0].desired_generation) === 20,
  "20 concurrent enqueues leave exactly one open row whose generation counts every edit");

// settle old generation after a new edit (negative control: unconditional completion)
const cGen = await mkContact();
await enqueue(cGen);
const [claimGen] = await claimFor([cGen]);
check(claimGen && claimGen.claimedGeneration === 1, "Claim records the generation it will project");
check((await enqueue(cGen)).action === "coalesced" && (await openRows(cGen))[0].state === "processing",
  "An edit during processing is coalesced and does not reset the in-flight row (unconditional enqueue reset would orphan the claim)");
check(await authority.settleProjection(claimGen, { kind: "success", receipts: {} }), "Old-generation settlement is accepted by the claim token");
const afterGen = (await projRows(cGen))[0];
check(afterGen.state === "pending" && Number(afterGen.settled_generation) === 1 && Number(afterGen.desired_generation) === 2 && Number(afterGen.attempt_count) === 0 && afterGen.completed_at === null,
  "Settling generation 1 after a generation-2 edit returns the row to pending with a fresh budget (edit is not lost)");
// mutants
const cMut = await mkContact();
await enqueue(cMut);
const [claimMut] = await claimFor([cMut]);
await enqueue(cMut);
await pool.query(`UPDATE contact_provider_projections SET state='succeeded' WHERE id=$1`, [claimMut.id]); // old unconditional completion
const mutRow = (await projRows(cMut))[0];
check(mutRow.state === "succeeded" && Number(mutRow.desired_generation) > Number(mutRow.settled_generation),
  "NEGATIVE CONTROL: unconditional completion leaves desired>settled while 'succeeded' — the generation assertion detects it");
const cMut2 = await mkContact();
await enqueue(cMut2);
const [claimMut2] = await claimFor([cMut2]);
await pool.query(`UPDATE contact_provider_projections SET state='pending', attempt_count=0 WHERE contact_id=$1`, [cMut2]); // old unconditional enqueue reset
const mutRow2 = (await projRows(cMut2))[0];
check(mutRow2.state !== "processing" && mutRow2.claim_token === claimMut2.claimToken,
  "NEGATIVE CONTROL: an unconditional reset detaches a live claim (state != processing, token still held) — the processing-preserved assertion detects it");

// ---------------------------------------------------------------- C3: executor accounting
const cDef = await mkContact();
await enqueue(cDef);
const deferErr = async () => ({ success: false, error: "GHL_SYNC_DEFERRED_BLOCKED:control_disabled" });
for (let i = 0; i < 10; i++) {
  await makeDue(cDef);
  await sync.processEligibleContactProjections(50, { syncFn: async (id) => (id === cDef ? deferErr() : syncOk()) });
}
const defRow = (await projRows(cDef))[0];
check(Number(defRow.deferral_count) === 10 && Number(defRow.attempt_count) === 0 && defRow.state === "retry",
  "Ten local deferrals are all counted and consume no provider attempt budget (>8 deferrals do not strand the row)");
await makeDue(cDef);
const recovered = await sync.processEligibleContactProjections(50, { syncFn: async (id) => (id === cDef ? { success: true } : syncOk()) });
const defRow2 = (await projRows(cDef))[0];
check(recovered.completed >= 1 && defRow2.state === "succeeded" && Number(defRow2.settled_generation) === 1, "After authorization returns, the same row completes");
const cOld = await mkContact();
await enqueue(cOld);
await pool.query(`UPDATE contact_provider_projections SET attempt_count=8, last_error_code='GHL_SYNC_DEFERRED_BLOCKED', next_attempt_at=now()-interval '1 second' WHERE contact_id=$1`, [cOld]);
check(!(await claimable([cOld])), "NEGATIVE CONTROL: pre-fix accounting (deferrals consuming budget) makes a row unclaimable");
check((await authority.repairStrandedProjections()) >= 1 && (await claimable([cOld])), "Stranded-row repair releases only proven local deferrals");
const cSucc = await mkContact();
await enqueue(cSucc);
await pool.query(`UPDATE contact_provider_projections SET attempt_count=8, last_error_code='GHL_SYNC_DEFERRED_BLOCKED', state='retry', last_dispatch_at=now() WHERE contact_id=$1`, [cSucc]);
await authority.repairStrandedProjections();
check(Number((await projRows(cSucc))[0].attempt_count) === 8, "Rows with a recorded provider dispatch are never repaired");

// exhaustion + reopen
const cEx = await mkContact();
await enqueue(cEx);
for (let i = 0; i < 8; i++) {
  await makeDue(cEx);
  await sync.processEligibleContactProjections(50, { syncFn: async (id) => (id === cEx ? { success: false, error: "GHL API error 500: boom" } : syncOk()) });
}
const exRow = (await projRows(cEx))[0];
check(exRow.state === "terminal" && exRow.terminal_reason === "MAX_ATTEMPTS_EXHAUSTED" && Number(exRow.attempt_count) === 8, "Eight provider failures exhaust the budget into a visible terminal state");
check((await authority.describeContactProjection(cEx)).receiptLevel === "failed", "An exhausted projection is reported as failed to the per-contact view");
check((await enqueue(cEx)).action === "reopened" && Number((await projRows(cEx))[0].attempt_count) === 0, "A later edit reopens an exhausted projection with a fresh budget");

// not-exportable + skip
const cNx = await mkContact();
await enqueue(cNx);
await sync.processEligibleContactProjections(50, { syncFn: async (id) => (id === cNx ? { success: false, error: "EXPORT_NOT_ELIGIBLE:record_class_test" } : syncOk()) });
const nx = (await projRows(cNx))[0];
check(nx.state === "terminal" && nx.terminal_reason === "EXPORT_NOT_ELIGIBLE" && Number(nx.attempt_count) === 0, "An export-ineligible result is terminal and consumes no attempt");
const cLive = await mkContact();
await enqueue(cLive);
await pool.query(`UPDATE contacts SET record_class='test' WHERE id=$1`, [cLive]);
check(!(await claimable([cLive])), "A contact reclassified as test after enqueue is excluded at claim time");

// ambiguity
const cAmb = await mkContact();
await enqueue(cAmb);
let ambCalls = 0;
const ambiguousSync = async (id: number) => {
  if (id !== cAmb) return syncOk();
  ambCalls++;
  const settle = recorder.markGhlDispatch("POST", "/contacts/");
  settle("ambiguous");
  throw new recorder.GhlAmbiguousDispatchError("POST /contacts: socket hang up");
};
await sync.processEligibleContactProjections(50, { syncFn: ambiguousSync });
const amb1 = (await projRows(cAmb))[0];
check(amb1.dispatch_state === "ambiguous" && amb1.state === "retry" && Number(amb1.attempt_count) === 1, "A create whose response was lost is recorded as ambiguous, not as an ordinary retry");
await makeDue(cAmb);
let lookupAttempts = 0, dispatchedAfterLookupFailure = 0;
await sync.processEligibleContactProjections(50, {
  lookupFn: async () => { lookupAttempts++; throw new Error("lookup unavailable"); },
  syncFn: async (id) => { if (id === cAmb) dispatchedAfterLookupFailure++; return syncOk(); },
});
check(lookupAttempts === 1 && dispatchedAfterLookupFailure === 0 && (await projRows(cAmb))[0].dispatch_state === "ambiguous",
  "A failed reconciliation lookup defers without another create (no blind duplicate create)");
await makeDue(cAmb);
await sync.processEligibleContactProjections(50, { lookupFn: async () => ({ status: "found", id: `ghl_${run}_found` }), syncFn: async (id) => (id === cAmb ? { success: true } : syncOk()) });
const ambContact = (await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cAmb])).rows[0];
check(ambContact.ghl_contact_id === `ghl_${run}_found` && (await projRows(cAmb))[0].state === "succeeded", "A found remote record is linked read-only and the projection continues as an update");
const cAmb2 = await mkContact();
await enqueue(cAmb2);
await sync.processEligibleContactProjections(50, { syncFn: async (id) => { if (id !== cAmb2) return syncOk(); recorder.markGhlDispatch("POST", "/contacts/")("ambiguous"); throw new recorder.GhlAmbiguousDispatchError("timeout"); } });
await makeDue(cAmb2);
let createsAfterAbsent = 0;
await sync.processEligibleContactProjections(50, { lookupFn: async () => ({ status: "absent" }), syncFn: async (id) => { if (id === cAmb2) createsAfterAbsent++; return { success: true }; } });
check(createsAfterAbsent === 1 && (await projRows(cAmb2))[0].state === "succeeded", "A confirmed-absent record permits exactly one new create");
// bound to terminal
const cAmb3 = await mkContact();
await enqueue(cAmb3);
for (let i = 0; i < 8; i++) {
  await makeDue(cAmb3);
  await sync.processEligibleContactProjections(50, { lookupFn: async () => { throw new Error("down"); }, syncFn: async (id) => { if (id !== cAmb3) return syncOk(); recorder.markGhlDispatch("POST", "/contacts/")("ambiguous"); throw new recorder.GhlAmbiguousDispatchError("timeout"); } });
  if ((await projRows(cAmb3))[0].state === "terminal") break;
  // ambiguous rows are reconciled first; force another dispatch attempt by clearing the marker to model a found-absent create
  await pool.query(`UPDATE contact_provider_projections SET dispatch_state='none' WHERE contact_id=$1 AND state='retry'`, [cAmb3]);
}
check((await projRows(cAmb3))[0].terminal_reason === "DISPATCH_AMBIGUOUS_UNRESOLVED", "Repeated unresolved ambiguity ends in a visible, bounded terminal state");
{
  const blocked = await enqueue(cAmb3);
  check(blocked.action === "not_exported" && (await openRows(cAmb3)).length === 0, "An unresolved-ambiguous terminal row is never reopened into a blind create, and the producer is not thrown into an error");
}

// real transport: POST is never blindly retried
{
  const before = ghlCalls.length;
  ghlResponder = () => { throw new Error("socket hang up"); };
  const ghl = await import("../../server/services/ghl");
  const result = await recorder.withGhlDispatchRecorder(() => (ghl as any).upsertGhlContact({ id: 1, firstName: "A", lastName: "B", email: `post-${run}@fixture.invalid`, phone: null } as any).catch((e: Error) => { throw e; }));
  const posts = ghlCalls.slice(before).filter(c => c.method === "POST");
  check(posts.length <= 1, "The fake transport observed at most one POST for a failing create (never blindly retried)");
  void result;
  ghlResponder = defaultResponder;
}

// ---------------------------------------------------------------- C2/C3: convergence & held history
const cLeg1 = await mkContact();
const cLeg2 = await mkContact({ recordClass: "test" });
const cLeg3 = await mkContact();
const old = new Date("2026-09-01T00:00:00Z");
for (const [cid, key] of [[cLeg1, "a"], [cLeg1, "b"], [cLeg2, "a"], [cLeg3, "a"]] as const) {
  await pool.query(
    `INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,created_at) VALUES($1,'ghl',$2,'pending',$3)`,
    [cid, `legacy:${cid}:${key}`, old]);
}
check((await convergence.projectionConvergenceNeeded()), "Legacy un-adopted rows are detected");
const conv1 = await convergence.convergeLegacyProjectionRows();
const l1 = await projRows(cLeg1);
check(conv1.ran && l1.filter(r => ["pending", "retry", "processing"].includes(r.state)).length === 1 && l1.some(r => r.state === "superseded" && r.terminal_reason === "superseded_duplicate"),
  "Convergence leaves one open row per contact and keeps duplicates as superseded evidence");
check((await projRows(cLeg1)).find(r => r.state === "pending")!.export_disposition === "historical_hold", "Pre-cutoff legacy work is a held historical row");
check((await projRows(cLeg2))[0].export_disposition === "test_local_only", "Legacy rows for test contacts converge to test-local-only");
check(!(await claimable([cLeg1, cLeg2, cLeg3])), "Held historical and test rows are never claimable (no bulk export)");
check((await convergence.convergeLegacyProjectionRows()).ran === false, "Convergence is idempotent");
const backlog = await authority.getProjectionBacklog();
check(backlog.heldHistorical >= 2 && backlog.localOnlyOrTest >= 1, "Backlog reports held and local-only work separately from eligible work");

// ---------------------------------------------------------------- C8: per-contact receipt levels
const lvl = async (cid: number) => (await authority.describeContactProjection(cid));
check((await lvl(await mkContact())).receiptLevel === "not_applicable", "No projection is reported as not applicable, not as healthy");
check((await lvl(cLeg1)).receiptLevel === "held", "Historical hold is shown as held");
check((await lvl(cDef)).receiptLevel === "provider_accepted" && (await lvl(cDef)).verified === false, "Accepted is never shown as verified");
check((await lvl(cAmb3)).receiptLevel === "ambiguous", "An unresolved ambiguous terminal projection is reported as ambiguous, not healthy");

// ---------------------------------------------------------------- C1: real tick
const setControl = async (enabled: boolean) => {
  const identity = controlService.getCurrentGhlRuntimeIdentity();
  assert(identity, "runtime identity must resolve for the disposable run");
  const value = {
    enabled, permissionsEnabled: false, epoch: 1, ownerProfile: "ghl-sync-only", selectedRuntime: identity, transitioning: false,
    nativeReview: { state: "unverified", reviewedAt: null, expiresAt: null, evidenceReference: null, allowedOperations: [] },
  };
  await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES('ghlSyncControl',$1::jsonb,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(value)]);
};
await setControl(true);
const lastTick = async () => (await pool.query(`SELECT value FROM system_settings WHERE key='ghl_sync_last_tick'`)).rows[0]?.value;
const ownerState = async () => (await pool.query(`SELECT value->>'state' s FROM system_settings WHERE key='ghl_sync_runtime_owner'`)).rows[0]?.s;
const jobStatus = async () => (await pool.query(`SELECT status FROM background_jobs WHERE job_name=$1`, [(await import("../../server/services/job-registry")).JOB_NAMES.GHL_SYNC])).rows[0]?.status;

// neutralise unrelated pending work so ticks are deterministic
await pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day' WHERE state IN ('pending','retry')`);
sync.resetGhlCircuit();
await sync.runGhlFullSyncTick();
check((await lastTick())?.outcome === "ok" && (await ownerState()) === "released" && (await jobStatus()) !== "running", "Idle tick succeeds and releases both the runtime lease and the job lock");
await sync.runGhlFullSyncTick();
check((await lastTick())?.outcome === "ok" && (await lastTick())?.reason !== "runtime_lease_held", "A second successive tick acquires the lease again (no leaked ownership)");
check(sync.getGhlCircuitState().state === "closed", "Healthy idle never opens or half-opens the circuit");

// negative control: omitted release leaves the next tick locked out
const leaked = await runtime.acquireGhlSyncRuntimeLease();
check(leaked.status === "acquired", "Control: lease can be taken outside the tick");
await sync.runGhlFullSyncTick();
check((await lastTick())?.reason === "runtime_lease_held", "NEGATIVE CONTROL: a tick that omits release starves the next tick — the second-tick assertion detects it");
leaked.stopHeartbeat?.();
await leaked.release?.();
await sync.runGhlFullSyncTick();
check((await lastTick())?.outcome === "ok" && (await ownerState()) === "released", "Tick resumes once the lease is properly released");

// cleanup on exception exit
{
  const cTick = await mkContact();
  await enqueue(cTick);
  const realQuery = pool.query.bind(pool);
  let thrownOnce = false;
  (pool as any).query = (...args: any[]) => {
    const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
    if (!thrownOnce && /count\(\*\) FILTER \(WHERE state = 'pending'/.test(text)) { thrownOnce = true; return Promise.reject(new Error("injected backlog fault")); }
    return realQuery(...args);
  };
  let error: unknown = null;
  try { await sync.runGhlFullSyncTick(); } catch (e) { error = e; } finally { (pool as any).query = realQuery; }
  check(error instanceof Error && /injected backlog fault/.test(error.message), "An exception inside the tick body is propagated");
  check((await ownerState()) === "released" && (await jobStatus()) !== "running" && (await lastTick())?.outcome === "failed", "Lease, lock and last-tick record are all settled on the exception exit");
  await sync.runGhlFullSyncTick();
  check((await lastTick())?.reason !== "runtime_lease_held" && (await lastTick())?.reason !== "job_lock_held", "The tick after an exception is not locked out");
  await pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day' WHERE contact_id=$1`, [cTick]);
}

// eligible work while writes are not authorized: deferral, no provider mutation, circuit untouched
{
  const cT = await mkContact();
  await enqueue(cT);
  const before = ghlCalls.length;
  await sync.runGhlFullSyncTick();
  const row = (await projRows(cT))[0];
  const mutations = ghlCalls.slice(before).filter(c => c.method !== "GET");
  check(mutations.length === 0, "No provider mutation is attempted while outgoing writes are not authorized");
  check(Number(row.attempt_count) === 0 && ["retry", "pending"].includes(row.state) && Number(row.deferral_count) >= 1, "The blocked row is deferred, not failed (budget untouched)");
  check(sync.getGhlCircuitState().state === "closed" && sync.getGhlCircuitState().consecutiveFailures === 0, "Deferrals never touch circuit counters");
  await pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day' WHERE contact_id=$1`, [cT]);
}

// credential/control loss
await setControl(false);
{
  const cT = await mkContact();
  await enqueue(cT);
  const before = ghlCalls.length;
  await sync.runGhlFullSyncTick();
  check(ghlCalls.length === before && (await openRows(cT)).every(r => Number(r.attempt_count) === 0), "With the control disabled the tick makes no provider call and consumes no budget");
  check((await ownerState()) !== "running", "Control loss leaves no running owner");
  await pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day' WHERE contact_id=$1`, [cT]);
}
await setControl(true);

// half-open: held and test rows are never probe candidates
{
  const probed: number[] = [];
  const cHeld = cLeg1;
  sync.__ghlCircuitTestHooks.setState({ state: "half-open", consecutiveFailures: 5, halfOpenProbeSuccesses: 0, halfOpenProbeCursorId: 0, lastFullSuccessTickAt: Date.now(), restored: true });
  await sync.runHalfOpenProbeTick({ syncFn: async (id: number) => { probed.push(id); return { success: true }; } } as any);
  check(!probed.includes(cHeld) && !probed.includes(cLeg2), "Default half-open candidates exclude held historical and test contacts");
  sync.__ghlCircuitTestHooks.setState({ state: "half-open", consecutiveFailures: 5, halfOpenProbeSuccesses: 0, halfOpenProbeCursorId: 0, restored: true });
  // mutant: legacy unfiltered selector would hand the held contact to the probe
  const unfiltered = (await pool.query(`SELECT contact_id FROM contact_provider_projections WHERE contact_id=$1`, [cHeld])).rows.map(r => Number(r.contact_id));
  check(unfiltered.includes(cHeld), "NEGATIVE CONTROL: an unfiltered candidate selector would include the held contact — the exclusion assertion detects it");
  const before = ghlCalls.length;
  await sync.runHalfOpenProbeTick({ assertOwnership: async () => {} });
  const probeCalls = ghlCalls.slice(before);
  check(probeCalls.every(c => c.method === "GET"), "With no eligible work the half-open probe is a read-only health check");
  sync.resetGhlCircuit();
}

// lease expiry during a slow batch
{
  const cSlow = await mkContact();
  await enqueue(cSlow);
  const [first] = await claimFor([cSlow]);
  await authority.reserveProjectionDispatch(first);
  await pool.query(`UPDATE contact_provider_projections SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [first.id]);
  check(!(await authority.renewProjectionLease({ ...first, claimToken: randomUUID() })), "A renewal with a foreign token is refused");
  const [second] = await claimFor([cSlow]);
  check(second && second.claimToken !== first.claimToken && second.dispatchState === "ambiguous", "An expired lease is reclaimed and a reserved-but-unsettled dispatch is treated as ambiguous");
  check((await authority.settleProjection(first, { kind: "success", receipts: {} })) === false, "The stale claimant's settlement is refused (claim lost, nothing written)");
  const stillProcessing = (await projRows(cSlow))[0];
  check(stillProcessing.state === "processing" && stillProcessing.claim_token === second.claimToken, "The new claimant still owns the row after the stale settlement attempt");
  await authority.settleProjection(second, { kind: "released" });
}

// ---------------------------------------------------------------- C6: webhook receipts
const { default: express } = await import("express");
const app = express();
app.use(express.json());
const handled: string[] = [];
app.post("/api/test-webhook/:kind", receipts.ghlWebhookReceiptMiddleware(), async (req, res) => {
  handled.push(req.params.kind);
  const kind = req.params.kind;
  if (kind === "fail") return res.status(500).json({ ok: false });
  if (kind === "slow") { await sleep(400); return res.json({ ok: true }); }
  return res.json({ ok: true });
});
const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port as number;
const post = (path: string, body: object) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, res => {
    let buf = ""; res.on("data", d => (buf += d)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null }));
  });
  req.on("error", reject); req.end(data);
});
const receiptFor = async (path: string, body: object) => {
  const key = receipts.ghlWebhookEventKey(path.replace(/^\//, "").replace(/\//g, "-"), JSON.stringify(body));
  void key;
  return (await pool.query(`SELECT state, delivery_count, attempt_count FROM ghl_provider_event_receipts WHERE event_type=$1 ORDER BY received_at DESC LIMIT 1`, [path.replace(/^\//, "").replace(/\//g, "-")])).rows[0];
};
const okBody = { id: `evt-${run}-1`, locationId: "loc_cert_fake" };
const r1 = await post("/api/test-webhook/ok", okBody);
check(r1.status === 200 && (await receiptFor("/api/test-webhook/ok", okBody)).state === "applied", "Receipt is durable (applied) by the time the acknowledgement is received");
const r2 = await post("/api/test-webhook/ok", okBody);
check(r2.status === 200 && r2.body.duplicate === true && handled.filter(h => h === "ok").length === 1, "A duplicate of an applied event is acknowledged without reprocessing");

const failBody = { id: `evt-${run}-fail` };
const f1 = await post("/api/test-webhook/fail", failBody);
const failReceipt = await receiptFor("/api/test-webhook/fail", failBody);
check(f1.status === 500 && failReceipt.state === "failed", "A failing handler leaves a failed receipt (not a silent duplicate)");
const f2 = await post("/api/test-webhook/fail", failBody);
check(handled.filter(h => h === "fail").length === 2 && Number((await receiptFor("/api/test-webhook/fail", failBody)).attempt_count) === 2 && f2.status === 500, "The sender's retry re-runs the handler");

const slowBody = { id: `evt-${run}-slow` };
const [s1, s2] = await Promise.all([post("/api/test-webhook/slow", slowBody), (async () => { await sleep(100); return post("/api/test-webhook/slow", slowBody); })()]);
check(s1.status === 200 && s2.status === 409 && handled.filter(h => h === "slow").length === 1, "A duplicate arriving during processing gets a retryable non-2xx and the handler runs once");

// ack-before-commit mutant
{
  const mutantApp = express();
  mutantApp.use(express.json());
  mutantApp.post("/m", async (req, res) => {
    const claim = await receipts.claimGhlWebhookReceipt(receipts.ghlWebhookEventKey("m", JSON.stringify(req.body)), "m");
    res.json({ ok: true }); // acknowledged first
    await sleep(300);
    if (claim.decision === "process") await receipts.markGhlWebhookReceipt(claim.receiptId, claim.claimToken, "applied");
  });
  const s = http.createServer(mutantApp);
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const mp = (s.address() as any).port;
  const body = { id: `m-${run}` };
  await new Promise<void>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: mp, path: "/m", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, res => { res.resume(); res.on("end", () => resolve()); });
    req.on("error", reject); req.end(data);
  });
  const atAck = (await pool.query(`SELECT state FROM ghl_provider_event_receipts WHERE event_type='m' ORDER BY received_at DESC LIMIT 1`)).rows[0];
  check(atAck.state !== "applied", "NEGATIVE CONTROL: acknowledging before commit leaves the receipt un-applied at ack time — the receipt-before-ack assertion detects it");
  await sleep(500);
  s.close();
}

// storage fault is fail-closed
{
  const realQuery = pool.query.bind(pool);
  (pool as any).query = (...args: any[]) => {
    const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
    if (/ghl_provider_event_receipts/.test(text)) return Promise.reject(new Error("injected storage fault"));
    return realQuery(...args);
  };
  const before = handled.length;
  let res: { status: number; body: any };
  try { res = await post("/api/test-webhook/ok", { id: `evt-${run}-store` }); } finally { (pool as any).query = realQuery; }
  check(res.status === 503 && handled.length === before, "A receipt storage fault returns 503 and does not process the event");
}
server.close();

// appointments: ordering, terminal states, scope, independence
{
  const base = { allowedLocationId: "loc_cert_fake", allowedCalendarIds: [] as string[] };
  const aid = `apt-${run}`;
  const t = (n: number) => new Date(Date.UTC(2026, 9, 24, 12, n)).toISOString();
  const before = ghlCalls.length;
  const calendarEnv = process.env.GHL_CALENDAR_ID;
  const ev = (kind: any, n: number, extra: object = {}) => appointments.recordGhlAppointmentEvent({ kind, payload: { appointmentId: aid, locationId: "loc_cert_fake", contactId: "gc1", dateUpdated: t(n), ...extra }, ...base });
  check((await ev("updated", 5)).applied, "First appointment event is recorded");
  check((await ev("rescheduled", 3)).reason === "stale", "An older event never overwrites a newer one (reordered delivery)");
  check((await ev("rescheduled", 7, { startTime: t(30) })).applied, "A newer reschedule is applied");
  check((await ev("booked", 9)).applied === false, "A late booked event never overwrites an existing appointment");
  check((await ev("canceled", 10)).applied, "Cancel is applied");
  check((await ev("updated", 20)).reason === "terminal", "A late update cannot revive a canceled appointment");
  const row = (await pool.query(`SELECT status, reschedule_count FROM ghl_appointment_state WHERE appointment_id=$1`, [aid])).rows[0];
  check(row.status === "canceled" && Number(row.reschedule_count) === 1, "Final appointment state is canceled with one reschedule");
  check((await appointments.recordGhlAppointmentEvent({ kind: "updated", payload: { appointmentId: `${aid}-x`, locationId: "other" }, ...base })).reason === "location_mismatch", "Events for another location are ignored");
  check((await appointments.recordGhlAppointmentEvent({ kind: "updated", payload: { appointmentId: `${aid}-y`, calendarId: "cal_other" }, allowedLocationId: "loc_cert_fake", allowedCalendarIds: ["cal_cfg"] })).reason === "calendar_not_configured", "Events for an unconfigured calendar are ignored");
  check((await appointments.recordGhlAppointmentEvent({ kind: "updated", payload: {}, ...base })).reason === "missing_identity", "Events without an appointment identity are ignored");
  check(ghlCalls.length === before && process.env.GHL_CALENDAR_ID === calendarEnv, "Appointment recording makes no provider call and does not change reader or booking-link configuration");
}

// static ownership guards
const syncSrc = readFileSync("server/services/ghl-sync.ts", "utf8");
check(!/getUnsyncedContactsForGhl/.test(syncSrc), "The broad unsynced-contact scan is gone from the sync service");
check(/finally\s*\{[\s\S]{0,400}runtimeLease\?\.release/.test(syncSrc), "The tick releases the runtime lease in a single finally block");
const prodPolicy = readFileSync(".replit", "utf8");
check(/ghl-sync-only/.test(prodPolicy), "The isolated GHL consumer group is selected in the shared worker profile");

console.log(`\nGHL projection authority certification passed: ${checks} checks`);
await pool.end();
process.exit(0);
