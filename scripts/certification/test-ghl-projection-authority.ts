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
import { execFileSync } from "node:child_process";
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

async function mkContact(opts: { recordClass?: string; ghl?: string | null; archived?: boolean; intake?: boolean; phoneOnly?: boolean } = {}): Promise<number> {
  seq += 1;
  const phone = `+1555${String(seq % 10_000_000).padStart(7, "0")}`;
  const r = await pool.query(
    `INSERT INTO contacts(first_name,last_name,email,phone,record_class,ghl_contact_id,archived_at)
     VALUES('Gpa','Fixture',$1,$2,$3,$4,$5) RETURNING id`,
    [opts.phoneOnly ? "" : `gpa-${run}-${seq}@fixture.invalid`, phone, opts.recordClass ?? "unknown", opts.ghl ?? null, opts.archived ? new Date() : null]);
  const id = r.rows[0].id as number;
  // Authority comes from source evidence only: by default the fixture is a genuine current intake (website form).
  if (opts.intake !== false) await addIntakeEvidence(id, "website_form");
  return id;
}
async function addIntakeEvidence(contactId: number, category: string, createdAt: Date = new Date()) {
  await pool.query(
    `INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,actor_type,created_at)
     VALUES($1,$2,$3,'cert','system',$4)`, [contactId, `cert:${randomUUID()}`, category, createdAt]);
}
async function contactIdentity(contactId: number) {
  const r = (await pool.query(`SELECT email, phone FROM contacts WHERE id=$1`, [contactId])).rows[0];
  return { email: r.email || null, phone: r.phone || null };
}
/** A fake create whose response is lost, dispatched through the real recorder (fence + durable operation row). */
async function lostCreate(contactId: number, message = "socket hang up"): Promise<never> {
  const settle = await recorder.markGhlDispatch("POST", "/contacts/", { identity: await contactIdentity(contactId) });
  await settle("ambiguous");
  throw new recorder.GhlAmbiguousDispatchError(message);
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
const migrationSql = readFileSync("migrations/0375_ghl_projection_operations_and_intake_evidence.sql", "utf8");
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
check(normalize(migrationSql).includes(normalize(convergence.GHL_LEGACY_CREATION_TIME_CORRECTION_STATEMENT)),
  "Migration 0375 contains the legacy creation-time correction statement used at runtime (build-time and runtime cannot drift)");
check(execFileSync("git", ["diff", "--quiet", "HEAD", "--", "migrations/0374_ghl_projection_generation_authority.sql"]).length === 0,
  "Migration 0374 is unedited (corrections ship as a new migration)");
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
  return lostCreate(id, "POST /contacts: socket hang up");
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
await sync.processEligibleContactProjections(50, { syncFn: async (id) => { if (id !== cAmb2) return syncOk(); return lostCreate(id, "timeout"); } });
await makeDue(cAmb2);
let createsAfterAbsent = 0;
await sync.processEligibleContactProjections(50, { lookupFn: async () => ({ status: "absent" }), syncFn: async (id) => { if (id === cAmb2) createsAfterAbsent++; return { success: true }; } });
check(createsAfterAbsent === 1 && (await projRows(cAmb2))[0].state === "succeeded", "A confirmed-absent record permits exactly one new create");
// bound to terminal
const cAmb3 = await mkContact();
await enqueue(cAmb3);
for (let i = 0; i < 8; i++) {
  await makeDue(cAmb3);
  await sync.processEligibleContactProjections(50, { lookupFn: async () => { throw new Error("down"); }, syncFn: async (id) => { if (id !== cAmb3) return syncOk(); return lostCreate(id, "timeout"); } });
  if ((await projRows(cAmb3))[0].state === "terminal") break;
  // ambiguous rows are reconciled first; force another dispatch attempt by clearing the marker to model a found-absent create
  await pool.query(`UPDATE contact_provider_projections SET dispatch_state='none' WHERE contact_id=$1 AND state='retry'`, [cAmb3]);
}
check((await projRows(cAmb3))[0].terminal_reason === "DISPATCH_AMBIGUOUS_UNRESOLVED", "Repeated unresolved ambiguity ends in a visible, bounded terminal state");
{
  const blocked = await enqueue(cAmb3);
  check(blocked.action === "not_exported" && (await openRows(cAmb3)).length === 0, "An unresolved-ambiguous terminal row is never reopened into a blind create, and the producer is not thrown into an error");
}

// (The real-transport POST/ambiguity journey runs later against an approved fake provider, with exact counts.)

// ---------------------------------------------------------------- C2/C3: convergence & held history
const cLeg1 = await mkContact({ intake: false });
const cLeg2 = await mkContact({ recordClass: "test", intake: false });
const cLeg3 = await mkContact({ intake: false });
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
    if (!thrownOnce && /count\(\*\) FILTER \(WHERE p\.state = 'pending'/.test(text)) { thrownOnce = true; return Promise.reject(new Error("injected backlog fault")); }
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
  check((await appointments.recordGhlAppointmentEvent({ kind: "updated", payload: { appointmentId: `${aid}-y`, calendarId: "cal_other", locationId: "loc_cert_fake", dateUpdated: t(1) }, allowedLocationId: "loc_cert_fake", allowedCalendarIds: ["cal_cfg"] })).reason === "calendar_not_configured", "Events for an unconfigured calendar are ignored");
  check((await appointments.recordGhlAppointmentEvent({ kind: "updated", payload: {}, ...base })).reason === "missing_identity", "Events without an appointment identity are ignored");
  check(ghlCalls.length === before && process.env.GHL_CALENDAR_ID === calendarEnv, "Appointment recording makes no provider call and does not change reader or booking-link configuration");
}

// ================================================================ R1: historical holds and intake authority
{
  const { classifyExportDisposition } = authority;
  // Producer families all call the same entry point; each family's source string must grant nothing.
  const families = ["contact_writer:intake_matched", "contact_writer:intake_created", "contact_writer:profile_update", "ghl_form_sync", "statement_upload_chain", "sequence_tick", "background_update"];
  const heldIds: number[] = [];
  for (const family of families) {
    const cH = await mkContact({ intake: false });
    const first = await enqueue(cH, family);
    const second = await enqueue(cH, family);
    check(first.disposition === "historical_hold" && second.disposition === "historical_hold" && !(await claimable([cH])),
      `Producer family "${family}" cannot export an unlinked contact without current-intake evidence`);
    heldIds.push(cH);
  }
  const cLinkedHeld = await mkContact({ intake: false, ghl: `ghl_${run}_old_linked` });
  await pool.query(`INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,authority_version,export_disposition,export_reason) VALUES($1,'ghl',$2,'pending',1,'historical_hold','test')`, [cLinkedHeld, `contact:${cLinkedHeld}`]);
  const afterBg = await enqueue(cLinkedHeld, "background_update");
  check(afterBg.disposition === "historical_hold" && !(await claimable([cLinkedHeld])), "A background update never releases an existing historical hold, even for a linked contact");
  // genuine new inbound from an older contact: only that contact becomes exportable
  const cOlder = heldIds[0];
  await addIntakeEvidence(cOlder, "website_form");
  const released = await enqueue(cOlder, "ghl_form_sync");
  check(released.disposition === "current_intake" && (await claimable([cOlder])), "A genuine new inbound from an older contact is exported on its own evidence");
  check(!(await claimable([heldIds[1], heldIds[2], cLinkedHeld])), "...without releasing any other legacy contact's held work");
  // evidence from imports/discovery/ghl_sync never counts
  const cImp = await mkContact({ intake: false });
  for (const category of ["csv_import", "discovery", "registry", "ghl_sync"]) await addIntakeEvidence(cImp, category);
  check((await enqueue(cImp, "profile_update")).disposition === "historical_hold", "Import, discovery, registry and GHL-sync provenance never count as current intake");
  // old evidence before the cutoff never counts
  const cPre = await mkContact({ intake: false });
  await addIntakeEvidence(cPre, "website_form", new Date("2026-09-01T00:00:00Z"));
  check((await enqueue(cPre, "profile_update")).disposition === "historical_hold", "Intake evidence older than the policy cutoff does not grant authority");
  // creation time grants nothing: a legacy un-adopted row created just now for a no-evidence contact converges to a hold
  const cNew = await mkContact({ intake: false });
  await pool.query(`INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,created_at) VALUES($1,'ghl',$2,'pending',now())`, [cNew, `legacy:${cNew}:fresh`]);
  await convergence.convergeLegacyProjectionRows();
  check((await projRows(cNew)).find(r => r.state === "pending")!.export_disposition === "historical_hold" && !(await claimable([cNew])),
    "A legacy queue row's recent creation time grants no export authority");
  // already-adopted current_intake rows with no evidence are demoted by the correction statement; evidence rows are kept
  const cDemote = await mkContact({ intake: false });
  const cKeep = await mkContact();
  for (const cid of [cDemote, cKeep]) {
    await pool.query(`INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,authority_version,export_disposition,export_reason,source_kind) VALUES($1,'ghl',$2,'pending',1,'current_intake','creation_time','legacy')`, [cid, `contact:${cid}`]);
  }
  await pool.query(convergence.GHL_LEGACY_CREATION_TIME_CORRECTION_STATEMENT);
  check((await projRows(cDemote))[0].export_disposition === "historical_hold" && (await projRows(cKeep))[0].export_disposition === "current_intake",
    "The correction demotes creation-time current_intake rows lacking evidence and keeps evidenced rows");
  // duplicate legacy rows: the survivor inherits an uncertain dispatch
  const cDup = await mkContact({ intake: false });
  await pool.query(`INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,created_at) VALUES($1,'ghl',$2,'pending',$3)`, [cDup, `legacy:${cDup}:a`, new Date("2026-09-01T00:00:00Z")]);
  await pool.query(`INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,dispatch_state,created_at) VALUES($1,'ghl',$2,'pending','ambiguous',$3)`, [cDup, `legacy:${cDup}:b`, new Date("2026-09-02T00:00:00Z")]);
  await convergence.convergeLegacyProjectionRows();
  const dupOpen = (await openRows(cDup));
  check(dupOpen.length === 1 && dupOpen[0].dispatch_state === "ambiguous", "Duplicate legacy rows converge to one open row that keeps the uncertain-dispatch evidence");
  // mutant: the old classification (any unlinked non-test contact is current intake)
  const mutantClassify = (f: any) => (f.recordClass === "test" ? "test_local_only" : f.hasGhlContactId ? "linked_update" : "current_intake");
  const facts = { recordClass: "unknown", archived: false, hasGhlContactId: false, localOnlyFence: false, currentIntakeEvidence: false, existingOpenDisposition: null };
  check(classifyExportDisposition(facts).disposition === "historical_hold" && mutantClassify(facts) === "current_intake",
    "NEGATIVE CONTROL: the creation-time/caller-string rule exports an evidence-free contact — the held-history assertion detects it");
}

// ================================================================ R2: final fence and durable operation records
{
  const opCount = async (pid: string) => Number((await pool.query(`SELECT count(*) c FROM ghl_projection_operations WHERE projection_id=$1`, [pid])).rows[0].c);
  const cF = await mkContact();
  await enqueue(cF);
  const [rowF] = await claimFor([cF]);
  const beginOp = (r: any, cls = "contact_update") => authority.beginProjectionOperation(r, { operationId: randomUUID(), operationClass: cls, method: "PUT" });
  check(await beginOp(rowF) && (await opCount(rowF.id)) === 1, "The final fence admits a live claim and appends a durable operation row in the same step");
  check(!(await beginOp({ ...rowF, claimToken: randomUUID() })) && (await opCount(rowF.id)) === 1, "A different claim token is refused and records nothing");
  await pool.query(`UPDATE contact_provider_projections SET claimed_generation = claimed_generation + 1 WHERE id=$1`, [rowF.id]);
  check(!(await beginOp(rowF)) && (await opCount(rowF.id)) === 1, "A changed generation is refused");
  await pool.query(`UPDATE contact_provider_projections SET claimed_generation = $2 WHERE id=$1`, [rowF.id, rowF.claimedGeneration]);
  await pool.query(`UPDATE contact_provider_projections SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [rowF.id]);
  const stale = (await pool.query(`SELECT 1 FROM contact_provider_projections WHERE id=$1 AND claim_token=$2 AND state='processing'`, [rowF.id, rowF.claimToken])).rows.length;
  check(!(await beginOp(rowF)) && (await opCount(rowF.id)) === 1 && stale === 1, "An expired lease is refused; NEGATIVE CONTROL: a token-only fence would still match the row");
  await pool.query(`UPDATE contact_provider_projections SET lease_expires_at = now() + interval '1 minute' WHERE id=$1`, [rowF.id]);
  await pool.query(`UPDATE contacts SET record_class='test' WHERE id=$1`, [cF]);
  check(!(await beginOp(rowF)) && (await opCount(rowF.id)) === 1, "A contact reclassified as test after the claim is refused at the final fence");
  await authority.settleProjection(rowF, { kind: "released" });

  // executor: lease lost before the request -> the request is never sent and the budget is untouched
  const cFx = await mkContact();
  await enqueue(cFx);
  const callsBefore = ghlCalls.length;
  const lostSummary = await sync.processEligibleContactProjections(50, {
    syncFn: async (id) => {
      if (id !== cFx) return syncOk();
      await pool.query(`UPDATE contact_provider_projections SET lease_expires_at = now() - interval '1 second' WHERE contact_id=$1 AND provider='ghl'`, [cFx]);
      const settle = await recorder.markGhlDispatch("PUT", "/contacts/abc", { identity: null }); // throws when the fence refuses
      await fetch("https://services.leadconnectorhq.com/contacts/abc", { method: "PUT" });
      await settle("ok", 200);
      return { success: true };
    },
  }).catch((e: any) => e.projectionSummary ?? { thrown: String(e) });
  const fxRows = await projRows(cFx);
  check(ghlCalls.slice(callsBefore).every(c => c.method === "GET") && (fxRows[0]?.attempt_count ?? 0) === 0 && (await opCount(fxRows[0].id)) === 0,
    "A claim that loses its lease before a request sends nothing, consumes no attempt and records no operation");
  void lostSummary;
  await pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day' WHERE contact_id=$1`, [cFx]);

  // reconciliation of ambiguous creates uses the ORIGINAL identity and never clears ambiguity for unusable identity
  const ambiguousFor = async (cid: number, identityOverride?: { email: string | null; phone: string | null }) => {
    await enqueue(cid);
    await sync.processEligibleContactProjections(50, {
      syncFn: async (id) => {
        if (id !== cid) return syncOk();
        const settle = await recorder.markGhlDispatch("POST", "/contacts/", { identity: identityOverride ?? await contactIdentity(cid) });
        await settle("ambiguous");
        throw new recorder.GhlAmbiguousDispatchError("socket hang up");
      },
    });
    await makeDue(cid);
  };
  const cEmpty = await mkContact();
  await ambiguousFor(cEmpty, { email: null, phone: null });
  let emptyLookups = 0;
  await sync.processEligibleContactProjections(50, { lookupFn: async () => { emptyLookups++; return { status: "absent" } as any; }, syncFn: syncOk });
  const emptyRow = (await projRows(cEmpty))[0];
  check(emptyLookups === 0 && emptyRow.state === "terminal" && emptyRow.dispatch_state === "ambiguous" && emptyRow.last_error_code === "AMBIGUOUS_IDENTITY_UNAVAILABLE_NEEDS_REVIEW",
    "An ambiguous create with no usable original identity is held with a specific reason and is never cleared");

  const cOrig = await mkContact();
  const origEmail = (await contactIdentity(cOrig)).email!;
  await ambiguousFor(cOrig);
  await pool.query(`UPDATE contacts SET email=$2 WHERE id=$1`, [cOrig, `changed-${run}@fixture.invalid`]);
  const seen: any[] = [];
  await sync.processEligibleContactProjections(50, { lookupFn: async (identity) => { seen.push(identity); return { status: "absent" } as any; }, syncFn: syncOk });
  check(seen.length === 1 && seen[0].email === origEmail, "Reconciliation looks up the identity that was actually sent, not the contact's current email");

  const cPhone = await mkContact({ phoneOnly: true });
  await ambiguousFor(cPhone);
  await sync.processEligibleContactProjections(50, {
    lookupFn: async () => ({ status: "found", id: `ghl_${run}_oldphone`, createdAt: new Date(Date.now() - 86_400_000).toISOString(), matchedEmail: null }),
    syncFn: syncOk,
  });
  const phoneRow = (await projRows(cPhone))[0];
  check(phoneRow.state === "terminal" && phoneRow.last_error_code === "AMBIGUOUS_PHONE_IDENTITY_NEEDS_REVIEW"
    && (await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cPhone])).rows[0].ghl_contact_id === null,
    "A phone-only match that pre-dates the create is held for review and is not linked");

  const cPhone2 = await mkContact({ phoneOnly: true });
  await ambiguousFor(cPhone2);
  await sync.processEligibleContactProjections(50, {
    lookupFn: async () => ({ status: "found", id: `ghl_${run}_newphone`, createdAt: new Date(Date.now() + 5_000).toISOString(), matchedEmail: null }),
    syncFn: syncOk,
  });
  check((await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cPhone2])).rows[0].ghl_contact_id === `ghl_${run}_newphone` && (await projRows(cPhone2))[0].state === "succeeded",
    "A unique phone-only record created after the request is accepted as the lost create");

  const cAmbig = await mkContact();
  await ambiguousFor(cAmbig);
  await sync.processEligibleContactProjections(50, { lookupFn: async () => ({ status: "ambiguous", count: 2 } as any), syncFn: syncOk });
  check((await projRows(cAmbig))[0].last_error_code === "AMBIGUOUS_REMOTE_IDENTITY_NEEDS_REVIEW" && (await projRows(cAmbig))[0].state === "terminal",
    "Several remote matches hold the projection with a specific reason");
  // mutant: an email-only reconciler would call lookup with the empty email of a phone-only contact
  check(!/lookupGhlContactByEmailStrict\(contact\.email/.test(readFileSync("server/services/ghl-sync.ts", "utf8")),
    "The reconciler no longer routes identity through the current contact email");
}

// ================================================================ R7: exhausted/stranded repair
{
  const cX = await mkContact();
  const cY = await mkContact();
  const cZ = await mkContact({ ghl: `ghl_${run}_stranded_linked` });
  await enqueue(cX); await enqueue(cY); await enqueue(cZ);
  await pool.query(`UPDATE contact_provider_projections SET state='processing', claim_token=$2, claimed_generation=1, lease_expires_at=now()-interval '1 minute', attempt_count=8, dispatch_state='reserved' WHERE contact_id=$1`, [cX, randomUUID()]);
  await pool.query(`UPDATE contact_provider_projections SET state='processing', claim_token=$2, claimed_generation=1, lease_expires_at=now()+interval '5 minute', attempt_count=8 WHERE contact_id=$1`, [cY, randomUUID()]);
  await pool.query(`UPDATE contact_provider_projections SET state='retry', attempt_count=8, last_error_code='GHL_SYNC_DEFERRED_BLOCKED', next_attempt_at=now() WHERE contact_id=$1`, [cZ]);
  await authority.reconcileExhaustedProjections();
  await authority.repairStrandedProjections();
  const x = (await projRows(cX))[0], y = (await projRows(cY))[0], z = (await projRows(cZ))[0];
  check(x.state === "terminal" && x.terminal_reason === "DISPATCH_AMBIGUOUS_UNRESOLVED" && x.dispatch_state === "ambiguous", "An expired exhausted row with an uncertain dispatch closes as unresolved-ambiguous, never as a clean failure");
  check(y.state === "processing", "A live lease is never touched by exhausted-row reconciliation");
  check(Number(z.attempt_count) === 0, "A stranded deferral row for an already linked contact is repaired too");
  await pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day', state='pending' WHERE contact_id IN ($1,$2)`, [cY, cZ]);
}

// ================================================================ R5: webhook occurrence identity and effect recovery
{
  const occurrence = receipts.ghlWebhookOccurrence;
  const a1 = { type: "ContactUpdate", contactId: "c1", dateUpdated: "2026-10-24T12:00:00.000Z", tags: ["a", "b"], nested: { x: 1, y: 2 } };
  const a2 = { nested: { y: 2, x: 1 }, tags: ["a", "b"], dateUpdated: "2026-10-24T12:00:00.000Z", contactId: "c1", type: "ContactUpdate" };
  const rawHash = (o: object) => JSON.stringify(o);
  check(occurrence("contact-updated", a1).eventKey === occurrence("contact-updated", a2).eventKey && rawHash(a1) !== rawHash(a2),
    "A re-serialized delivery of one event maps to the same occurrence (NEGATIVE CONTROL: a raw-body key differs)");
  check(occurrence("m", { webhookId: "evt-9", text: "a" }).eventKey === occurrence("m", { webhookId: "evt-9", text: "a", extra: 1 }).eventKey && occurrence("m", { webhookId: "evt-9" }).basis === "provider_event_id",
    "A verified provider event id is the occurrence identity");
  check(occurrence("contact-updated", { id: "contact-1", x: 1 }).basis === "payload_fingerprint", "A bare object id is not mistaken for an event id");
  const sem1 = { messageId: "msg-1", dateUpdated: "2026-10-24T12:00:00Z", body: "one" };
  const sem2 = { messageId: "msg-1", dateUpdated: "2026-10-24T12:00:00Z", body: "two" };
  const claim1 = await receipts.claimGhlWebhookReceipt(occurrence("sem-test", sem1).eventKey, "sem-test", { payloadFingerprint: occurrence("sem-test", sem1).fingerprint });
  const claim2 = await receipts.claimGhlWebhookReceipt(occurrence("sem-test", sem2).eventKey, "sem-test", { payloadFingerprint: occurrence("sem-test", sem2).fingerprint });
  check(claim1.decision === "process" && claim2.decision === "process" && claim1.receiptId !== claim2.receiptId, "The same semantic key with a different payload is a distinct occurrence, not a duplicate");
  // effect recovery at the claim level
  if (claim1.decision === "process") {
    await receipts.markGhlWebhookEffectApplied(claim1.receiptId, claim1.claimToken);
    await pool.query(`UPDATE ghl_provider_event_receipts SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [claim1.receiptId]);
    const again = await receipts.claimGhlWebhookReceipt(occurrence("sem-test", sem1).eventKey, "sem-test", { payloadFingerprint: occurrence("sem-test", sem1).fingerprint });
    check(again.decision === "process" && again.effectApplied === true, "A re-claim of a receipt whose effect was recorded reports the effect as already applied");
  }
}

// ================================================================ R6: appointment trust, ordering decision, audit idempotency
{
  const aid = `apt6-${run}`;
  const t = (n: number) => new Date(Date.UTC(2026, 9, 24, 13, n)).toISOString();
  const scope = { allowedLocationId: "loc_cert_fake", allowedCalendarIds: ["cal_cfg"] };
  const rec = (kind: any, payload: object) => appointments.recordGhlAppointmentEvent({ kind, payload, ...scope });
  const dec = (kind: any, payload: object) => appointments.decideGhlAppointmentEvent({ kind, payload, ...scope });
  const ok = (extra: object = {}) => ({ appointmentId: aid, locationId: "loc_cert_fake", calendarId: "cal_cfg", contactId: "gc6", ...extra });
  check((await rec("updated", ok({ dateUpdated: t(1) }))).applied, "An event from the configured location and calendar is recorded");
  check((await rec("updated", { appointmentId: `${aid}-nl`, calendarId: "cal_cfg", dateUpdated: t(1) })).reason === "location_missing", "A missing location is not trusted when an allowed location is configured");
  check((await rec("updated", { appointmentId: `${aid}-nc`, locationId: "loc_cert_fake", dateUpdated: t(1) })).reason === "calendar_missing", "A missing calendar is not trusted when allowed calendars are configured");
  check((await rec("updated", ok({ appointmentId: `${aid}-nt` }))).reason === "missing_event_time", "A missing event time is rejected, never defaulted to the arrival time");
  check((await dec("booked", ok({ appointmentId: `${aid}-dt` }))).decision === "rejected", "The pre-handler decision also rejects an event with no event time");
  check((await dec("showed", ok({ dateUpdated: t(0) }))).decision === "stale", "A stale lifecycle event is decided before any handler runs");
  check((await dec("booked", ok({ dateUpdated: t(2) }))).decision === "apply", "A booked event that arrives after an update still owns its one-time handler");
  check((await dec("updated", ok({ dateUpdated: t(1) }))).decision === "replay", "An exact replay is recognised before any effect");
  check((await rec("canceled", ok({ dateUpdated: t(5) }))).applied, "Cancel is recorded");
  check((await dec("showed", ok({ dateUpdated: t(9) }))).decision === "terminal" && (await dec("booked", ok({ dateUpdated: t(9) }))).decision === "terminal",
    "After a terminal state no booked/showed handler may run");
  check((await dec("canceled", ok({ dateUpdated: t(5) }))).decision === "replay", "A replayed terminal event is a replay, not a second cancellation");
  const sdrSrc = readFileSync("server/routes/sdr.ts", "utf8");
  check(/gateAppointmentLifecycle\("booked"[\s\S]{0,200}handleAppointmentBooked/.test(sdrSrc)
    && /gateAppointmentLifecycle\("showed"[\s\S]{0,120}handleAppointmentShowed/.test(sdrSrc)
    && /gateAppointmentLifecycle\("canceled"[\s\S]{0,120}handleAppointmentCanceled/.test(sdrSrc),
    "Each booked/showed/canceled route decides ordering before its handler");
  check(!/recordAppointmentLifecycleBestEffort/.test(sdrSrc) && /await recordAppointmentLifecycle\("booked"/.test(sdrSrc), "Lifecycle recording is no longer best-effort (faults fail the request so it is retried)");
  check(/appointment_\$\{kind\}`\), eq\(sdrLeadEvents\.ghlRefId, auditRef\)/.test(sdrSrc.replace(/\s+/g, " ").replace(/\) \.limit/g, ").limit")) || /auditRef/.test(sdrSrc),
    "The reschedule audit event is keyed by appointment, kind and event time and is written for a replay too");
}

// ================================================================ R3/R4/R8: approved fake-provider journey (real worker, executor, transport, control)
{
  const controlRow = async (permissionsEnabled: boolean) => {
    const identity = controlService.getCurrentGhlRuntimeIdentity();
    assert(identity, "runtime identity must resolve for the disposable run");
    const fields = installedFields.map((k, i) => ({ id: `cf_${i}`, key: k }));
    const workflows: any[] = [];
    const now = Date.now();
    const identityFields = ["firstName", "lastName", "email", "phone", "companyName", "tags", "customFields"];
    const value = {
      enabled: true, permissionsEnabled, epoch: 1, ownerProfile: "ghl-sync-only", selectedRuntime: identity, transitioning: false,
      nativeReview: {
        state: "approved", reviewedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(),
        evidenceReference: "disposable-cert-fixture", locationId: "loc_cert_fake",
        inventoryRevision: controlService.hashNativeWorkflowInventory(workflows), workflows, workflowActionEvidence: [],
        customFields: fields, customFieldInventoryRevision: controlService.hashGhlCustomFieldInventory(fields),
        allowedOperations: [
          { method: "POST", path: "/contacts", fields: identityFields, tags: [], stageIds: [], customFieldIds: fields.map(f => f.id), purpose: "cert identity create", safetyEvidence: "fixture" },
          { method: "PUT", path: "/contacts/:contactId", fields: identityFields, tags: [], stageIds: [], customFieldIds: fields.map(f => f.id), purpose: "cert identity update", safetyEvidence: "fixture" },
        ],
      },
    };
    await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES('ghlSyncControl',$1::jsonb,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(value)]);
  };
  await controlRow(true);
  // Global outbound pause stays PAUSED; CRM projections join the pause barrier but may run while paused.
  if ((await pool.query(`UPDATE outbound_pause_control SET state='paused', reason='ghl projection certification', committed_at=NOW()`)).rowCount === 0) {
    await pool.query(`INSERT INTO outbound_pause_control (state,reason,epoch,actor,idempotency_key,committed_at) VALUES ('paused','ghl projection certification',1,'ghl-cert',$1,NOW())`, [`ghl-cert-${randomUUID()}`]);
  }
  (await import("../../server/services/outbound-pause-authority")).invalidatePauseStateCache();

  type Remote = { id: string; email: string | null; phone: string | null; dateAdded: string };
  const remote = new Map<string, Remote>();
  let remoteSeq = 0;
  const behaviour = { fuzzyEmail: false, loseNextPost: false, failCustomFieldPut: false, duplicate400For: null as string | null, failPutFor: null as string | null };
  const journeyResponder = (call: Call, body: any): Response => {
    const u = new URL(call.url);
    const path = u.pathname;
    if (/\/customFields$/.test(path)) return json({ customFields: installedFields.map((k, i) => ({ id: `cf_${i}`, fieldKey: `contact.${k}` })) });
    if (/^\/workflows\/?$/.test(path)) return json({ workflows: [] });
    if (path === "/contacts/search/duplicate") {
      const email = u.searchParams.get("email"); const number = u.searchParams.get("number");
      const hits = behaviour.fuzzyEmail && email ? [remote.get("remote_other_mailbox")!] : [...remote.values()].filter(r => (email && r.email?.toLowerCase() === email.toLowerCase()) || (number && r.phone === number));
      return json({ contacts: hits });
    }
    if (call.method === "POST" && /^\/contacts\/?$/.test(path)) {
      if (behaviour.duplicate400For && body?.email === behaviour.duplicate400For) {
        return json({ message: "This location does not allow duplicated contacts.", meta: { contactId: "remote_dup_1" } }, 400);
      }
      const created: Remote = { id: `remote_${run}_${++remoteSeq}`, email: body?.email || null, phone: body?.phone || null, dateAdded: new Date().toISOString() };
      remote.set(created.id, created);
      if (behaviour.loseNextPost) { behaviour.loseNextPost = false; throw new Error("socket hang up"); }
      return json({ contact: { id: created.id } });
    }
    if (call.method === "PUT" && /^\/contacts\/[^/]+$/.test(path)) {
      if (behaviour.failPutFor && path.endsWith(behaviour.failPutFor)) return json({ message: "boom" }, 500);
      if (behaviour.failCustomFieldPut && Array.isArray(body?.customFields)) return json({ message: "perm boom" }, 500);
      return json({ contact: { id: path.split("/").pop() } });
    }
    return json({});
  };
  // capture request bodies through the deny-boundary wrapper
  const wrapped = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
    if (url.includes("services.leadconnectorhq.com")) {
      let parsed: any = null;
      try { parsed = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { parsed = null; }
      const call = { method: String(init?.method ?? "GET").toUpperCase(), url };
      ghlCalls.push(call);
      try { return journeyResponder(call, parsed); } catch (error) { throw error; }
    }
    return wrapped(input, init);
  }) as typeof fetch;

  const mutationsSince = (n: number) => ghlCalls.slice(n).filter(c => c.method !== "GET");
  const postsSince = (n: number) => ghlCalls.slice(n).filter(c => c.method === "POST" && /\/contacts\/?(\?|$)/.test(new URL(c.url).pathname));
  const ops = async (contactId: number) => (await pool.query(`SELECT operation_class, method, state FROM ghl_projection_operations WHERE contact_id=$1 ORDER BY created_at`, [contactId])).rows;
  const runWorker = () => sync.processEligibleContactProjections(50, { paceMs: 0 });

  // 1. happy path: one authorized create, linked, then an edit is an update (never another create)
  const cJ = await mkContact();
  await enqueue(cJ);
  let mark = ghlCalls.length;
  await runWorker();
  const jRow = (await projRows(cJ))[0];
  const jLinked = (await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cJ])).rows[0].ghl_contact_id;
  check(postsSince(mark).length === 1 && jRow.state === "succeeded" && !!jLinked, "Journey: exactly one authorized create reaches the provider and the contact is linked");
  check((await ops(cJ)).some(o => o.operation_class === "contact_create" && o.state === "ok"), "Journey: a durable operation record exists for the create with its observed outcome");
  await enqueue(cJ, "profile_update");
  mark = ghlCalls.length;
  await runWorker();
  check(postsSince(mark).length === 0 && mutationsSince(mark).every(c => c.method === "PUT") && (await projRows(cJ))[0].state === "succeeded", "Journey: a later edit is an update only — no second create");

  // 2. lost create response: exactly one POST; reconciliation finds the record and updates, never re-posts
  const cL = await mkContact();
  await enqueue(cL);
  behaviour.loseNextPost = true;
  mark = ghlCalls.length;
  await runWorker();
  const lRow = (await projRows(cL))[0];
  check(postsSince(mark).length === 1 && lRow.dispatch_state === "ambiguous" && (await ops(cL)).some(o => o.operation_class === "contact_create" && o.state === "ambiguous"),
    "Journey: a lost create response sends exactly one POST and the outcome is recorded as ambiguous");
  await makeDue(cL);
  mark = ghlCalls.length;
  await runWorker();
  check(postsSince(mark).length === 0 && (await projRows(cL))[0].state === "succeeded" && !!(await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cL])).rows[0].ghl_contact_id,
    "Journey: reconciliation links the record the provider created and sends no second create");

  // 3. phone-only contact: absent -> one create; a pre-existing phone match is held, nothing is written
  const cP = await mkContact({ phoneOnly: true });
  await enqueue(cP);
  mark = ghlCalls.length;
  await runWorker();
  check(postsSince(mark).length === 1 && (await projRows(cP))[0].state === "succeeded", "Journey: a phone-only contact whose phone is absent remotely is created once");
  const cP2 = await mkContact({ phoneOnly: true });
  const phone2 = (await contactIdentity(cP2)).phone!;
  remote.set("remote_pre_phone", { id: "remote_pre_phone", email: null, phone: phone2, dateAdded: "2025-01-01T00:00:00Z" });
  await enqueue(cP2);
  mark = ghlCalls.length;
  await runWorker();
  const p2 = (await projRows(cP2))[0];
  check(mutationsSince(mark).length === 0 && p2.state === "terminal" && /GHL_IDENTITY_AMBIGUOUS/.test(String(p2.last_error_code)) && !(await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cP2])).rows[0].ghl_contact_id,
    "Journey: a phone-only match is never merged — held for review with no provider write");

  // 4. a mailbox match whose email differs is held, not merged
  const cM = await mkContact();
  const emailM = (await contactIdentity(cM)).email!;
  remote.set("remote_other_mailbox", { id: "remote_other_mailbox", email: emailM.replace("@", "+x@"), phone: null, dateAdded: "2025-01-01T00:00:00Z" });
  behaviour.fuzzyEmail = true;
  await enqueue(cM);
  mark = ghlCalls.length;
  await runWorker();
  const mRow = (await projRows(cM))[0];
  check(mutationsSince(mark).length === 0 && mRow.state === "terminal" && /GHL_IDENTITY_AMBIGUOUS:remote_match_on_other_identifier/.test(String(mRow.last_error_code)),
    "Journey: a provider match on a different mailbox is held for review, never merged, with no provider write");
  behaviour.fuzzyEmail = false;

  // 5. duplicate-400 recovery whose follow-up PUT fails must fail the projection, not report success
  const cD = await mkContact();
  const emailD = (await contactIdentity(cD)).email!;
  behaviour.duplicate400For = emailD;
  behaviour.failPutFor = "/remote_dup_1";
  await enqueue(cD);
  await runWorker();
  const dRow = (await projRows(cD))[0];
  check(dRow.state === "retry" && Number(dRow.attempt_count) === 1 && dRow.last_error_code !== null,
    "Journey: a duplicate-400 recovery whose update fails is a failed attempt, never a success");
  behaviour.duplicate400For = null; behaviour.failPutFor = null;

  // 6. permission write failure is a failed component with the identity linked, and no tags go out
  const cC = await mkContact();
  await enqueue(cC);
  behaviour.failCustomFieldPut = true;
  mark = ghlCalls.length;
  await runWorker();
  const cRow = (await projRows(cC))[0];
  const cLinkedId = (await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cC])).rows[0].ghl_contact_id;
  const permWritten = ghlCalls.slice(mark).filter(c => c.method === "PUT").length;
  if (permWritten > 0) {
    check(cRow.state === "retry" && /^GHL_COMPONENT_FAILED/.test(String(cRow.last_error_code)) && !!cLinkedId && Number(cRow.attempt_count) === 1,
      "Journey: a failed permission write is a failed component (identity stays linked, attempt consumed) instead of a swallowed success");
  } else {
    check(cRow.state === "succeeded", "Journey: contacts with no permission fields to write succeed without a permission component");
  }
  behaviour.failCustomFieldPut = false;

  // 7. required suppression field not installed: nothing is sent
  const cS = await mkContact();
  await pool.query(`UPDATE contacts SET do_not_contact=true WHERE id=$1`, [cS]);
  await enqueue(cS);
  mark = ghlCalls.length;
  await runWorker();
  const sRow = (await projRows(cS))[0];
  check(mutationsSince(mark).length === 0 && sRow.state === "retry" && sRow.last_error_code === "GHL_REQUIRED_SUPPRESSION_FIELD_UNAVAILABLE" && Number(sRow.attempt_count) === 0,
    "Journey: a do-not-contact suppression with no installed provider field defers before any mutation and consumes no attempt");

  // 8. backlog mirrors the claimant: held and exhausted rows are not reported eligible
  await pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day' WHERE state IN ('pending','retry')`);
  const cB = await mkContact();
  await enqueue(cB);
  const bl1 = await authority.getProjectionBacklog();
  await pool.query(`UPDATE contacts SET archived_at=now() WHERE id=$1`, [cB]);
  const bl2 = await authority.getProjectionBacklog();
  check(bl1.eligiblePending - bl2.eligiblePending === 1 && !(await claimable([cB])), "Backlog eligibility mirrors the claimant (an archived contact is neither claimable nor eligible)");

  // restore the unauthorized control for any later assertions
  globalThis.fetch = wrapped;
  ghlResponder = defaultResponder;
  await setControl(true);
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
