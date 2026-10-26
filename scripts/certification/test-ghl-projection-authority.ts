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
type Call = { method: string; url: string; body?: any };
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
const scopeModule = await import("../../server/services/ghl-scope-rules");
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
/** The existing-population scope is a policy switch (default on). The R1/H7 sections certify the evidence-only authority
 *  rule, so they run with the scope off; the dedicated scope section below runs with it on. */
let resealControlForScope: (() => Promise<void>) | null = null;
const setScope = async (enabled: boolean, extra: object = {}) => {
  await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES('ghl_export_policy',$1::jsonb,NOW())
              ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [JSON.stringify({ existingPopulation: { enabled, ...extra } })]);
  // Scope rules are part of the approval contract; this fixture re-approves under the rules it just saved so the
  // surrounding sections keep exercising the write path. The dedicated persistent-approval section proves that a
  // rules change without a new review blocks.
  if (resealControlForScope) await resealControlForScope();
};
await setScope(false);

// ---------------------------------------------------------------- migration / schema
const migrationSql = readFileSync("migrations/0375_ghl_projection_operations_and_intake_evidence.sql", "utf8");
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
check(normalize(migrationSql).includes(normalize(convergence.GHL_LEGACY_CREATION_TIME_CORRECTION_STATEMENT)),
  "Migration 0375 carries the one-time legacy creation-time correction verbatim; at runtime the broader authority reconcile (not this statement) keeps every open exportable row evidence-backed");
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
await sync.processEligibleContactProjections(50, { lookupFn: async (identity: any) => ({ status: "found", id: `ghl_${run}_found`, createdAt: null, matchedEmail: identity.email }), syncFn: async (id) => (id === cAmb ? { success: true } : syncOk()) });
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
    nativeReview: { state: "unverified", reviewedAt: null, evidenceReference: null, allowedOperations: [] },
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
  check((await ev("booked", 9)).applied === true && (await ev("booked", 9)).reason === "replay",
    "A booked event after updates owns the one-time booked effect exactly once; a repeat is a replay");
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
  check((await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cPhone2])).rows[0].ghl_contact_id === null
    && (await projRows(cPhone2))[0].state === "terminal" && (await projRows(cPhone2))[0].last_error_code === "AMBIGUOUS_PHONE_IDENTITY_NEEDS_REVIEW",
    "A phone-only match is held for review even when the remote record is newer than the request: recency is not identity proof");

  const cNoEmail = await mkContact();
  await ambiguousFor(cNoEmail);
  await sync.processEligibleContactProjections(50, {
    lookupFn: async () => ({ status: "found", id: `ghl_${run}_noemail`, createdAt: null, matchedEmail: null }),
    syncFn: syncOk,
  });
  check((await projRows(cNoEmail))[0].last_error_code === "AMBIGUOUS_REMOTE_IDENTITY_NEEDS_REVIEW"
    && (await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [cNoEmail])).rows[0].ghl_contact_id === null,
    "An email-bearing create is not linked to a remote record that states no email");

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
  check(occurrence("m", { eventId: "evt-9", text: "a" }).eventKey === occurrence("m", { eventId: "evt-9", text: "a", extra: 1 }).eventKey && occurrence("m", { eventId: "evt-9" }).basis === "provider_event_id",
    "A verified provider event id is the occurrence identity");
  check(occurrence("m", { webhookId: "wh-1", x: 1 }).basis === "payload_fingerprint" && occurrence("m", { webhookId: "wh-1", x: 2 }).eventKey !== occurrence("m", { webhookId: "wh-1", x: 1 }).eventKey,
    "A bare webhookId is not assumed to be a delivery id and never identifies an occurrence by itself");
  check(occurrence("m", { eventId: "evt-9", locationId: "loc_a" }).eventKey !== occurrence("m", { eventId: "evt-9", locationId: "loc_b" }).eventKey
    && occurrence("m", { eventId: "evt-9", locationId: "loc_a" }).legacyEventKey === "m:evt:evt-9",
    "The same provider event id in two locations is two occurrences; the pre-scoping key is still honored");
  check(occurrence("contact-updated", { id: "contact-1", x: 1 }).basis === "payload_fingerprint", "A bare object id is not mistaken for an event id");
  const sem1 = { messageId: "msg-1", dateUpdated: "2026-10-24T12:00:00Z", body: "one" };
  const sem2 = { messageId: "msg-1", dateUpdated: "2026-10-24T12:00:00Z", body: "two" };
  const claim1 = await receipts.claimGhlWebhookReceipt(occurrence("sem-test", sem1).eventKey, "sem-test", { payloadFingerprint: occurrence("sem-test", sem1).fingerprint });
  const claim2 = await receipts.claimGhlWebhookReceipt(occurrence("sem-test", sem2).eventKey, "sem-test", { payloadFingerprint: occurrence("sem-test", sem2).fingerprint });
  const collided = (await pool.query(`SELECT collision_count FROM ghl_provider_event_receipts WHERE event_key=$1`, [occurrence("sem-test", sem1).eventKey])).rows[0];
  check(claim1.decision === "process" && claim2.decision === "collision" && Number(collided.collision_count) === 1,
    "The same occurrence key with a different payload is a held collision, never a new occurrence and never a duplicate");
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
    "Each booked/showed/canceled route accepts the transition (one transaction, one appointment lock) before its handler");
}

// ================================================================ R3/R4/R8: approved fake-provider journey (real worker, executor, transport, control)
{
  let tagOpsReviewed = true;
  let lastPermissionsEnabled = true;
  const controlRow = async (permissionsEnabled: boolean) => {
    lastPermissionsEnabled = permissionsEnabled;
    controlService.resetGhlEvidenceCache();
    const identity = controlService.getCurrentGhlRuntimeIdentity();
    assert(identity, "runtime identity must resolve for the disposable run");
    const fields = installedFields.map((k, i) => ({ id: `cf_${i}`, key: k }));
    const workflows: any[] = [];
    const now = Date.now();
    const identityFields = ["firstName", "lastName", "email", "phone", "companyName", "customFields"];
    const value = {
      enabled: true, permissionsEnabled, epoch: 1, ownerProfile: "ghl-sync-only", selectedRuntime: identity, transitioning: false,
      nativeReview: controlService.sealGhlApprovedReview({
        state: "approved", reviewedAt: null,
        evidenceReference: "disposable-cert-fixture", locationId: "loc_cert_fake",
        inventoryRevision: controlService.hashNativeWorkflowInventory(workflows), workflows, workflowActionEvidence: [],
        customFields: fields, customFieldInventoryRevision: controlService.hashGhlCustomFieldInventory(fields),
        allowedOperations: [
          { method: "POST", path: "/contacts", fields: identityFields, tags: [], stageIds: [], customFieldIds: fields.map(f => f.id), purpose: "cert identity create", safetyEvidence: "fixture" },
          { method: "PUT", path: "/contacts/:contactId", fields: identityFields, tags: [], stageIds: [], customFieldIds: fields.map(f => f.id), purpose: "cert identity update", safetyEvidence: "fixture" },
          ...(tagOpsReviewed ? [
            { method: "POST", path: "/contacts/:contactId/tags", fields: ["tags"], tags: ["LB-ACTIVE-PIPELINE", "lb_parent_account"], stageIds: [], customFieldIds: [], purpose: "cert owned-tag add", safetyEvidence: "fixture" },
            { method: "DELETE", path: "/contacts/:contactId/tags", fields: ["tags"], tags: ["LB-ACTIVE-PIPELINE", "lb_parent_account"], stageIds: [], customFieldIds: [], purpose: "cert owned-tag remove", safetyEvidence: "fixture" },
          ] : []),
        ],
      }, { reviewerId: "cert-owner", reviewedAt: new Date(now - 60_000), scopeRules: await scopeModule.readGhlScopeRules() }),
    };
    await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES('ghlSyncControl',$1::jsonb,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(value)]);
  };
  const controlRowFn = controlRow;
  await controlRow(true);
  resealControlForScope = async () => { await controlRow(lastPermissionsEnabled); };
  // Global outbound pause stays PAUSED; CRM projections join the pause barrier but may run while paused.
  if ((await pool.query(`UPDATE outbound_pause_control SET state='paused', reason='ghl projection certification', committed_at=NOW()`)).rowCount === 0) {
    await pool.query(`INSERT INTO outbound_pause_control (state,reason,epoch,actor,idempotency_key,committed_at) VALUES ('paused','ghl projection certification',1,'ghl-cert',$1,NOW())`, [`ghl-cert-${randomUUID()}`]);
  }
  (await import("../../server/services/outbound-pause-authority")).invalidatePauseStateCache();

  type Remote = { id: string; email: string | null; phone: string | null; dateAdded: string };
  const remote = new Map<string, Remote>();
  let remoteSeq = 0;
  const behaviour = {
    fuzzyEmail: false, loseNextPost: false, failCustomFieldPut: false, duplicate400For: null as string | null, failPutFor: null as string | null,
    lookupMode: "normal" as "normal" | "noEmail" | "unsupported", dupRemoteEmail: null as string | null, duplicate400Phone: null as string | null,
    failTagPut: false, tagStatus: 0, inventoryDown: false, extraWorkflows: [] as any[],
  };
  const remoteTags = new Map<string, Set<string>>();
  const journeyResponder = (call: Call, body: any): Response => {
    const u = new URL(call.url);
    const path = u.pathname;
    if (behaviour.inventoryDown && (/\/customFields$/.test(path) || /^\/workflows\/?$/.test(path))) return json({ message: "provider outage" }, 503);
    if (/\/customFields$/.test(path)) return json({ customFields: installedFields.map((k, i) => ({ id: `cf_${i}`, fieldKey: `contact.${k}` })) });
    if (/^\/workflows\/?$/.test(path)) return json({ workflows: behaviour.extraWorkflows });
    if (call.method === "GET" && /^\/contacts\/remote_dup_1$/.test(path)) {
      return json({ contact: { id: "remote_dup_1", email: behaviour.dupRemoteEmail } });
    }
    if (path === "/contacts/search/duplicate" && behaviour.lookupMode === "unsupported") return json({ ok: true });
    if (path === "/contacts/search/duplicate" && behaviour.lookupMode === "noEmail") {
      return json({ contacts: [{ id: "remote_noemail", email: null, phone: null }] });
    }
    if (path === "/contacts/search/duplicate") {
      const email = u.searchParams.get("email"); const number = u.searchParams.get("number");
      const hits = behaviour.fuzzyEmail && email ? [remote.get("remote_other_mailbox")!] : [...remote.values()].filter(r => (email && r.email?.toLowerCase() === email.toLowerCase()) || (number && r.phone === number));
      return json({ contacts: hits });
    }
    if (call.method === "POST" && /^\/contacts\/?$/.test(path)) {
      if ((behaviour.duplicate400For && body?.email === behaviour.duplicate400For)
        || (behaviour.duplicate400Phone && body?.phone === behaviour.duplicate400Phone)) {
        return json({ message: "This location does not allow duplicated contacts.", meta: { contactId: "remote_dup_1" } }, 400);
      }
      const created: Remote = { id: `remote_${run}_${++remoteSeq}`, email: body?.email || null, phone: body?.phone || null, dateAdded: new Date().toISOString() };
      remote.set(created.id, created);
      if (behaviour.loseNextPost) { behaviour.loseNextPost = false; throw new Error("socket hang up"); }
      return json({ contact: { id: created.id } });
    }
    const tagPath = path.match(/^\/contacts\/([^/]+)\/tags$/);
    if (tagPath && (call.method === "POST" || call.method === "DELETE")) {
      if (behaviour.failTagPut) return json({ message: "tag boom" }, 500);
      if (behaviour.tagStatus) return json({ message: "tag rejected" }, behaviour.tagStatus);
      const set = remoteTags.get(tagPath[1]) ?? new Set<string>();
      for (const tag of body?.tags ?? []) { if (call.method === "POST") set.add(tag); else set.delete(tag); }
      remoteTags.set(tagPath[1], set);
      return json({ tags: [...set] });
    }
    if (call.method === "PUT" && /^\/contacts\/[^/]+$/.test(path)) {
      if (behaviour.failPutFor && path.endsWith(behaviour.failPutFor)) return json({ message: "boom" }, 500);
      if (behaviour.failCustomFieldPut && Array.isArray(body?.customFields)) return json({ message: "perm boom" }, 500);
      if (behaviour.failTagPut && Array.isArray(body?.tags)) return json({ message: "tag boom" }, 500);
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
      const call = { method: String(init?.method ?? "GET").toUpperCase(), url, body: parsed };
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
  check(mutationsSince(mark).length === 0 && mRow.state === "terminal" && /GHL_IDENTITY_AMBIGUOUS:(remote_match_on_other_identifier|match_on_other_email)/.test(String(mRow.last_error_code)),
    "Journey: a provider match on a different mailbox is held for review, never merged, with no provider write");
  behaviour.fuzzyEmail = false;

  // 5. duplicate-400 recovery whose follow-up PUT fails must fail the projection, not report success
  const cD = await mkContact();
  const emailD = (await contactIdentity(cD)).email!;
  behaviour.duplicate400For = emailD; behaviour.dupRemoteEmail = emailD;
  behaviour.failPutFor = "/remote_dup_1";
  await enqueue(cD);
  await runWorker();
  const dRow = (await projRows(cD))[0];
  check(dRow.state === "retry" && Number(dRow.attempt_count) === 1 && dRow.last_error_code !== null,
    "Journey: a duplicate-400 recovery whose update fails is a failed attempt, never a success");
  behaviour.duplicate400For = null; behaviour.failPutFor = null; behaviour.dupRemoteEmail = null;

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


  // ---- H1/H3/H4: strict identity proof, suppression on the first write, durable tag outcomes (reproduced cases 1,2,3,4,7)
  const bodiesSince = (n: number) => ghlCalls.slice(n).filter(c => c.method !== "GET").map(c => c.body ?? {});
  const linkedOf = async (id: number) => (await pool.query(`SELECT ghl_contact_id, tags FROM contacts WHERE id=$1`, [id])).rows[0];
  // case 4: an unrecognized lookup body is not proof of absence: no create, no link
  const cU = await mkContact();
  behaviour.lookupMode = "unsupported";
  await enqueue(cU);
  mark = ghlCalls.length;
  await runWorker();
  const uRow = (await projRows(cU))[0];
  check(mutationsSince(mark).length === 0 && uRow.state !== "succeeded" && (await linkedOf(cU)).ghl_contact_id === null,
    "H1 case 4: an unsupported duplicate-lookup response is never read as 'absent' (no create, no link)");
  // case 1: a found record that states no email is not an exact-email match
  const cN = await mkContact();
  behaviour.lookupMode = "noEmail";
  await enqueue(cN);
  mark = ghlCalls.length;
  await runWorker();
  const nRow = (await projRows(cN))[0];
  check(mutationsSince(mark).length === 0 && nRow.state === "terminal" && /GHL_IDENTITY_AMBIGUOUS:match_without_email/.test(String(nRow.last_error_code)) && (await linkedOf(cN)).ghl_contact_id === null,
    "H1 case 1: a remote record with no email is held for review, not accepted as the exact-email match");
  behaviour.lookupMode = "normal";
  // case 2: duplicate-400 recovery proves the exact remote record before linking
  const cD2 = await mkContact();
  behaviour.duplicate400For = (await contactIdentity(cD2)).email; behaviour.dupRemoteEmail = null;
  await enqueue(cD2);
  mark = ghlCalls.length;
  await runWorker();
  const d2 = (await projRows(cD2))[0];
  check(!ghlCalls.slice(mark).some(c => c.method === "PUT") && d2.state === "terminal" && /duplicate_remote_without_email/.test(String(d2.last_error_code)) && (await linkedOf(cD2)).ghl_contact_id === null,
    "H1 case 2: a duplicate-400 whose remote record states no email is held: no link and no update of the named record");
  const cD3 = await mkContact();
  behaviour.duplicate400For = (await contactIdentity(cD3)).email; behaviour.dupRemoteEmail = "someone-else@fixture.invalid";
  await enqueue(cD3);
  mark = ghlCalls.length;
  await runWorker();
  check(!ghlCalls.slice(mark).some(c => c.method === "PUT") && (await linkedOf(cD3)).ghl_contact_id === null && /duplicate_remote_other_identifier/.test(String((await projRows(cD3))[0].last_error_code)),
    "H1 case 2: a duplicate-400 naming a record with a different email is held");
  const cD4 = await mkContact({ phoneOnly: true });
  behaviour.duplicate400For = null; behaviour.duplicate400Phone = (await contactIdentity(cD4)).phone;
  await enqueue(cD4);
  mark = ghlCalls.length;
  await runWorker();
  check(!ghlCalls.slice(mark).some(c => c.method === "PUT") && (await linkedOf(cD4)).ghl_contact_id === null && /duplicate_phone_requires_review/.test(String((await projRows(cD4))[0].last_error_code)),
    "H1 case 2: a phone-only duplicate-400 is never linked");
  await pool.query(`UPDATE contacts SET ghl_contact_id = NULL WHERE ghl_contact_id = 'remote_dup_1'`);
  const cD5 = await mkContact();
  behaviour.duplicate400Phone = null; behaviour.duplicate400For = (await contactIdentity(cD5)).email; behaviour.dupRemoteEmail = behaviour.duplicate400For!.toUpperCase();
  await enqueue(cD5);
  mark = ghlCalls.length;
  await runWorker();
  check((await linkedOf(cD5)).ghl_contact_id === "remote_dup_1", "H1: a duplicate-400 whose remote record states the same email (case-insensitively) is linked and updated");
  await pool.query(`UPDATE contacts SET ghl_contact_id = NULL WHERE id=$1`, [cD5]);
  behaviour.duplicate400For = null; behaviour.dupRemoteEmail = null;

  // case 3: a true suppression travels in the first write
  installedFields.push("lb_do_not_contact", "lb_do_not_autocontact");
  await controlRowFn(true);
  const cSup = await mkContact();
  await pool.query(`UPDATE contacts SET do_not_contact=true, is_parent_account=true, tags=ARRAY['promo_tag'] WHERE id=$1`, [cSup]);
  await enqueue(cSup);
  mark = ghlCalls.length;
  await runWorker();
  const firstWrites = ghlCalls.slice(mark).filter(c => c.method === "POST" || c.method === "PUT");
  const firstCreate = firstWrites.find(c => c.method === "POST");
  check(!!firstCreate && (firstCreate.body.customFields ?? []).some((f: any) => f.id === `cf_${installedFields.indexOf("lb_do_not_contact")}` && f.field_value === "true") && !("tags" in firstCreate.body),
    "H3 case 3: the first create carries lb_do_not_contact=true and no tags");
  const isTagCall = (c: any) => /\/contacts\/[^/]+\/tags$/.test(new URL(c.url).pathname);
  const firstTagIdx = firstWrites.findIndex(isTagCall);
  const lastPermIdx = firstWrites.reduce((acc, c, i) => (Array.isArray(c.body?.customFields) && !isTagCall(c) && c.method === "PUT" ? i : acc), -1);
  check(firstTagIdx > lastPermIdx && firstTagIdx > 0 && firstWrites[firstTagIdx].method === "POST"
    && JSON.stringify(firstWrites[firstTagIdx].body.tags) === JSON.stringify(["lb_parent_account"]),
    "H3/B: owned tags (which can start a workflow) are added only after identity, suppression and permission writes, as an add-tags delta with only the owned tag");
  check(!firstWrites.some(c => c.method === "PUT" && "tags" in (c.body ?? {})) && !firstWrites.some(c => JSON.stringify(c.body ?? {}).includes("promo_tag")),
    "B: no profile write ever carries a tags array, and a non-owned local tag is never sent");
  // suppression present but permissions disabled: the whole first write is refused before any mutation
  await controlRowFn(false);
  const cSup2 = await mkContact();
  await pool.query(`UPDATE contacts SET do_not_auto_contact=true WHERE id=$1`, [cSup2]);
  await enqueue(cSup2);
  mark = ghlCalls.length;
  await runWorker();
  check(mutationsSince(mark).length === 0 && (await linkedOf(cSup2)).ghl_contact_id === null && (await projRows(cSup2))[0].state !== "succeeded",
    "H3: with permission writes disabled a suppressed contact is not created at all (no record exists without its suppression)");
  await controlRowFn(true);
  // case 7: a failed tag write fails the projection, local tags do not move, retry re-sends the full tag set
  const cT = await mkContact();
  await pool.query(`UPDATE contacts SET is_parent_account=true, tags=ARRAY['keep_me'] WHERE id=$1`, [cT]);
  behaviour.failTagPut = true;
  await enqueue(cT);
  mark = ghlCalls.length;
  await runWorker();
  const tRow = (await projRows(cT))[0];
  check(tRow.state === "retry" && /^GHL_COMPONENT_FAILED:tags/.test(String(tRow.last_error_code)) && !(await linkedOf(cT)).tags.includes("lb_parent_account")
    && ghlCalls.slice(mark).some(c => c.method === "POST" && isTagCall(c) && c.body.tags.includes("lb_parent_account")),
    "H4 case 7: a failed tag write is a failed component and the local tag set is not changed");
  behaviour.failTagPut = false;
  await makeDue(cT);
  mark = ghlCalls.length;
  await runWorker();
  const tagCalls = ghlCalls.slice(mark).filter(isTagCall);
  check((await projRows(cT))[0].state === "succeeded" && tagCalls.length === 1 && tagCalls[0].method === "POST"
    && JSON.stringify(tagCalls[0].body.tags) === JSON.stringify(["lb_parent_account"])
    && (await linkedOf(cT)).tags.includes("lb_parent_account") && (await linkedOf(cT)).tags.includes("keep_me") && postsSince(mark).length === 0,
    "H4/B: the retry sends only the owned-tag delta (never keep_me), then updates local tags, with no second create");

  // B: native GHL tags are preserved; removing the owned tag is a DELETE of only that tag; no delta means no tag request
  const remoteIdT = (await linkedOf(cT)).ghl_contact_id as string;
  remoteTags.set(remoteIdT, new Set(["outreach.paused", "opted-out", "lb_parent_account", "native_source"]));
  await pool.query(`UPDATE contacts SET is_parent_account=false WHERE id=$1`, [cT]);
  await enqueue(cT);
  mark = ghlCalls.length;
  await runWorker();
  const delCalls = ghlCalls.slice(mark).filter(isTagCall);
  check(delCalls.length === 1 && delCalls[0].method === "DELETE" && JSON.stringify(delCalls[0].body.tags) === JSON.stringify(["lb_parent_account"])
    && JSON.stringify([...remoteTags.get(remoteIdT)!].sort()) === JSON.stringify(["native_source", "opted-out", "outreach.paused"])
    && !(await linkedOf(cT)).tags.includes("lb_parent_account") && (await linkedOf(cT)).tags.includes("keep_me"),
    "B: removing the owned tag deletes only that tag; native GHL tags (outreach.paused, opted-out, native_source) are untouched");
  await makeDue(cT);
  await enqueue(cT);
  mark = ghlCalls.length;
  await runWorker();
  check(ghlCalls.slice(mark).filter(isTagCall).length === 0 && ghlCalls.slice(mark).filter(c => c.method === "PUT" && "tags" in (c.body ?? {})).length === 0,
    "B: with no owned-tag delta no tag request is made");

  // B: provider rejection / unreviewed operation is a held outcome, not an infinite retry, and local tags do not move
  const cTh = await mkContact();
  await pool.query(`UPDATE contacts SET is_parent_account=true, tags=ARRAY['keep_me'] WHERE id=$1`, [cTh]);
  behaviour.tagStatus = 422;
  await enqueue(cTh);
  await runWorker();
  const thRow = (await projRows(cTh))[0];
  check(thRow.state === "succeeded" && (thRow.component_receipts?.components?.tags?.heldKeys ?? []).includes("tags:provider_rejected_422")
    && !(await linkedOf(cTh)).tags.includes("lb_parent_account"),
    "B: a provider rejection of the tag endpoint is a held component (reported), the projection completes and local tags are unchanged");
  behaviour.tagStatus = 0;
  const cTu = await mkContact();
  await pool.query(`UPDATE contacts SET is_parent_account=true WHERE id=$1`, [cTu]);
  tagOpsReviewed = false; await controlRowFn(true);
  mark = ghlCalls.length;
  await enqueue(cTu);
  await runWorker();
  const tuRow = (await projRows(cTu))[0];
  check(tuRow.state === "succeeded" && (tuRow.component_receipts?.components?.tags?.heldKeys ?? []).includes("tags:operation_not_reviewed")
    && ghlCalls.slice(mark).filter(isTagCall).length === 0,
    "B: when the tag-delta operations are not in the approved review the tag component is held and no tag request is sent");
  tagOpsReviewed = true; await controlRowFn(true);
  // missing lb_location_of is reported as a held component, not silently dropped
  const cLoc = await mkContact();
  await pool.query(`UPDATE contacts SET parent_contact_id=$2 WHERE id=$1`, [cLoc, cT]);
  await enqueue(cLoc);
  await runWorker();
  const locReceipts = (await projRows(cLoc))[0].component_receipts;
  check(locReceipts?.components?.tags?.state === "held" && (locReceipts.components.tags.heldKeys ?? []).includes("lb_location_of"),
    "H4: a parent link whose lb_location_of field is not installed is reported as a held component");
  installedFields.splice(installedFields.indexOf("lb_do_not_contact"), 2);
  await controlRowFn(true);

  // 8. backlog mirrors the claimant: held and exhausted rows are not reported eligible
  await pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day' WHERE state IN ('pending','retry')`);
  const cB = await mkContact();
  await enqueue(cB);
  const bl1 = await authority.getProjectionBacklog();
  await pool.query(`UPDATE contacts SET archived_at=now() WHERE id=$1`, [cB]);
  const bl2 = await authority.getProjectionBacklog();
  check(bl1.eligiblePending - bl2.eligiblePending === 1 && !(await claimable([cB])), "Backlog eligibility mirrors the claimant (an archived contact is neither claimable nor eligible)");


  // ---- 7A: persistent approval (no calendar expiry; hold on outage; block on change; revocation; legacy gets no authority)
  {
    let virtualNow = Date.now();
    controlService.setGhlEvidenceClockForTest(() => virtualNow);
    const tick = (ms: number) => { virtualNow += ms; };
    const auditCount = async () => Number((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'ghl_native_review%'`)).rows[0].n);
    const writeArgs = { method: "POST", path: "/contacts", locationId: "loc_cert_fake", body: { email: "persist-approval@example.test" } };
    await controlRowFn(true);
    const before = (await controlService.getGhlSyncControl()).nativeReview;
    const auditBefore = await auditCount();
    check((await controlService.authorizeGhlCrmOperation(writeArgs)).allowed, "7A: a fresh approval authorizes the reviewed write");
    for (const [label, ms] of [["25 hours", 25 * 3600_000], ["7 days", 7 * 24 * 3600_000]] as const) {
      tick(ms);
      const d = await controlService.authorizeGhlCrmOperation(writeArgs);
      check(d.allowed, `7A: the unchanged approval is still usable after ${label} with no renewal`);
    }
    const after = (await controlService.getGhlSyncControl()).nativeReview;
    check(after.state === "approved" && after.reviewedAt === before.reviewedAt && after.contractRevision === before.contractRevision
      && (await auditCount()) === auditBefore, "7A: elapsed time re-approves nothing and writes no approval audit row");
    controlService.resetGhlEvidenceCache();
    check((await controlService.authorizeGhlCrmOperation(writeArgs)).allowed, "7A: an unchanged restart (empty cache, fresh read) preserves the approval");

    // outage: hold (not a failure), then automatic resume when the same configuration is re-verified
    behaviour.inventoryDown = true; tick(30_000); controlService.resetGhlEvidenceCache();
    const held = await controlService.authorizeGhlCrmOperation(writeArgs);
    check(!held.allowed && held.reasonCode === "native_verification_unavailable", "7A: unavailable provider evidence holds the write before dispatch");
    const cOut = await mkContact();
    await enqueue(cOut);
    let mark7 = ghlCalls.length;
    await runWorker();
    const outRow = (await projRows(cOut))[0];
    check(mutationsSince(mark7).length === 0 && outRow.state !== "failed" && outRow.state !== "dead_letter" && outRow.state !== "succeeded",
      "7A: during the outage nothing is sent and the projection is held, not failed");
    behaviour.inventoryDown = false; tick(30_000); controlService.resetGhlEvidenceCache();
    check((await controlService.authorizeGhlCrmOperation(writeArgs)).allowed, "7A: the write resumes automatically once the same configuration is verified again");

    // proven change blocks and reports facts; no automatic approval
    const expectBlocked = async (label: string, mutate: () => Promise<void>, restore: () => Promise<void>, factRe: RegExp) => {
      await mutate(); tick(30_000); controlService.resetGhlEvidenceCache();
      const d = await controlService.authorizeGhlCrmOperation(writeArgs);
      const v = await controlService.verifyGhlNativeReview(await controlService.getGhlSyncControl(), "loc_cert_fake", { persist: false });
      check(!d.allowed && d.reasonCode === "native_review_changed" && v.status === "changed" && v.changedFacts.some(f => factRe.test(f)),
        `7A: ${label} blocks the first affected write and names the changed fact`);
      const stored = (await controlService.getGhlSyncControl()).nativeReview;
      check(stored.state === "approved" && stored.contractRevision === before.contractRevision, `7A: ${label} never approves or rewrites the review`);
      await restore(); tick(30_000); controlService.resetGhlEvidenceCache();
    };
    await expectBlocked("a new native workflow", async () => { behaviour.extraWorkflows = [{ id: "wf_new", locationId: "loc_cert_fake", status: "published", updatedAt: "2026-10-25T00:00:00.000Z", version: 1 }]; },
      async () => { behaviour.extraWorkflows = []; }, /workflow wf_new added/);
    await expectBlocked("a changed custom-field map", async () => { installedFields.push("lb_unreviewed_field"); },
      async () => { installedFields.splice(installedFields.indexOf("lb_unreviewed_field"), 1); }, /lb_unreviewed_field/);
    const priorPolicy = (await pool.query(`SELECT value FROM system_settings WHERE key='ghl_export_policy'`)).rows[0]?.value;
    await expectBlocked("a changed export-scope rule", async () => {
      await pool.query(`UPDATE system_settings SET value = jsonb_set(value, '{existingPopulation,sourceLessLegacy}', 'false') WHERE key='ghl_export_policy'`);
    }, async () => {
      await pool.query(`UPDATE system_settings SET value=$1::jsonb WHERE key='ghl_export_policy'`, [JSON.stringify(priorPolicy)]);
    }, /sourceLessLegacy/);
    check((await controlService.authorizeGhlCrmOperation(writeArgs)).allowed, "7A: when the reviewed configuration is restored the same approval is verified again");

    // changed operations / location / tags / fields are bound by the approval itself
    const raw = (await controlService.getGhlSyncControl()).nativeReview;
    const tamper = async (label: string, mutate: (r: any) => any) => {
      const row = (await pool.query(`SELECT value FROM system_settings WHERE key='ghlSyncControl'`)).rows[0].value;
      const copy = JSON.parse(JSON.stringify(row)); mutate(copy.nativeReview);
      await pool.query(`UPDATE system_settings SET value=$1::jsonb WHERE key='ghlSyncControl'`, [JSON.stringify(copy)]);
      const d = await controlService.authorizeGhlCrmOperation(writeArgs);
      check(!d.allowed && d.reasonCode === "native_review_unverified", `7A: ${label} invalidates the approval (new review required)`);
      await pool.query(`UPDATE system_settings SET value=$1::jsonb WHERE key='ghlSyncControl'`, [JSON.stringify(row)]);
    };
    await tamper("a changed operation field allow-list", r => { r.allowedOperations[0].fields.push("tags"); });
    await tamper("a changed tag allow-list", r => { r.allowedOperations[3].tags.push("another_tag"); });
    await tamper("a changed location", r => { r.locationId = "loc_other"; });
    await tamper("a changed reviewer", r => { r.reviewerId = "someone_else"; });
    check((await controlService.authorizeGhlCrmOperation(writeArgs)).allowed, "7A: restoring the exact reviewed record restores the verified approval");

    // revocation: blocks later writes and retries; in-flight decision fails its recheck
    const inflightDecision = await controlService.authorizeGhlCrmOperation(writeArgs);
    const current = await controlService.getGhlSyncControl();
    await controlService.revokeGhlNativeReview("certification revocation check", "cert-owner", current.epoch);
    check(!(await controlService.recheckGhlCrmOperation(inflightDecision)), "7A: revocation blocks an already-authorized in-flight write at its final recheck");
    check((await controlService.authorizeGhlCrmOperation(writeArgs)).reasonCode === "native_review_revoked", "7A: revocation blocks later writes and retries");
    const revoked = (await controlService.getGhlSyncControl()).nativeReview;
    check(revoked.state === "revoked" && !!revoked.revokedAt && revoked.revokedBy === "cert-owner" && revoked.reviewerId === raw.reviewerId,
      "7A: revocation is recorded with who/when/why and keeps the reviewed evidence");
    check((await auditCount()) === auditBefore + 1, "7A: revocation writes one audit row");

    // legacy 24-hour review (no contract version, with expiresAt) never gains authority
    const legacy = { ...JSON.parse(JSON.stringify(raw)), contractVersion: undefined, contractRevision: undefined, scopeRules: undefined, scopeRulesRevision: undefined, reviewerId: undefined, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const ctl = JSON.parse(JSON.stringify((await pool.query(`SELECT value FROM system_settings WHERE key='ghlSyncControl'`)).rows[0].value));
    ctl.nativeReview = legacy;
    await pool.query(`UPDATE system_settings SET value=$1::jsonb WHERE key='ghlSyncControl'`, [JSON.stringify(ctl)]);
    const legacyRead = (await controlService.getGhlSyncControl()).nativeReview;
    check(legacyRead.state === "unverified" && (await controlService.authorizeGhlCrmOperation(writeArgs)).reasonCode === "native_review_unverified",
      "7A: a legacy time-limited review is not converted and carries no authority");
    // a revoked approval never regains authority by itself
    controlService.setGhlEvidenceClockForTest(null);
    controlService.resetGhlEvidenceCache();
    await controlRowFn(true);
    check((await controlService.authorizeGhlCrmOperation(writeArgs)).allowed, "7A: only a new sealed review restores authority after revocation or legacy state");
    const pending = await projRows(cOut);
    void pending;
  }
  // restore the unauthorized control for any later assertions
  globalThis.fetch = wrapped;
  ghlResponder = defaultResponder;
  await setControl(true);
}

// ================================================================ H2: final fences at every mutation boundary
{
  const pushAway = (cid: number) => pool.query(`UPDATE contact_provider_projections SET next_attempt_at = now() + interval '1 day' WHERE state IN ('pending','retry') AND contact_id <> $1`, [cid]);
  const opCount = async (cid: number) => Number((await pool.query(`SELECT count(*)::int n FROM ghl_projection_operations WHERE contact_id=$1`, [cid])).rows[0].n);
  const c1 = await mkContact();
  await enqueue(c1);
  await pushAway(c1);
  const row1 = (await authority.claimEligibleProjections(5)).find(r => r.contactId === c1)!;
  await enqueue(c1);
  const gens = (await projRows(c1))[0];
  check(BigInt(gens.desired_generation) > BigInt(gens.claimed_generation), "H2: an edit committed after the claim raises desired_generation above the claimed generation");
  check(!await authority.beginProjectionOperation(row1, { operationId: randomUUID(), operationClass: "contact_update", method: "PUT" }) && (await opCount(c1)) === 0,
    "H2: a claim for a stale generation is refused before any new mutation and records no operation");
  await pool.query(`UPDATE contact_provider_projections SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [row1.id]);
  check(!await authority.settleProjection(row1, { kind: "success", receipts: {} }) && (await projRows(c1))[0].state === "processing",
    "H2: a worker whose lease expired cannot settle the row");
  check(!await authority.clearProjectionAmbiguity(row1), "H2: an expired claim cannot clear an ambiguity");
  check(!await authority.linkReconciledIdentity(row1, `ghl_${run}_late_link`) && (await pool.query(`SELECT ghl_contact_id FROM contacts WHERE id=$1`, [c1])).rows[0].ghl_contact_id === null,
    "H2: a reconciled identity is not linked by an expired claim");
  await pool.query(`UPDATE contact_provider_projections SET state='retry', claim_token=NULL, lease_expires_at=NULL, claimed_generation=NULL, next_attempt_at = now() + interval '1 day' WHERE id=$1`, [row1.id]);

  // runtime ownership lost between two mutations of one row: the second request is never sent
  const c2 = await mkContact();
  await enqueue(c2);
  await pushAway(c2);
  let asserts = 0, requests = 0;
  let thrown: any = null;
  await sync.processEligibleContactProjections(5, {
    assertOwnership: async () => { asserts++; if (asserts >= 3) throw new Error("GHL_SYNC_RUNTIME_LEASE_LOST"); },
    syncFn: async (id) => {
      if (id !== c2) return syncOk();
      for (let i = 0; i < 2; i++) { const settle = await recorder.markGhlDispatch("PUT", "/contacts/abc", {}); requests++; await settle("ok"); }
      return { success: true };
    },
  }).catch(e => { thrown = e; });
  const r2 = (await projRows(c2))[0];
  check(thrown?.message === "GHL_SYNC_RUNTIME_LEASE_LOST" && requests === 1 && r2.state === "retry" && Number(r2.attempt_count) === 0 && r2.last_error_code === "GHL_RUNTIME_OWNERSHIP_LOST_PARTIAL",
    "H2: runtime ownership is re-verified before every mutation; losing it mid-row sends nothing further, spends no attempt and stops the batch");

  // a recorded operation that never reported an outcome blocks a success claim
  const c3 = await mkContact();
  await enqueue(c3);
  await pushAway(c3);
  await sync.processEligibleContactProjections(5, {
    syncFn: async (id) => {
      if (id !== c3) return syncOk();
      await recorder.markGhlDispatch("PUT", "/contacts/abc", {});
      return { success: true };
    },
  });
  const r3 = (await projRows(c3))[0];
  check(r3.state !== "succeeded" && r3.dispatch_state === "ambiguous", "H2: an unsettled provider operation is read as ambiguous, never as success");
}

// ================================================================ H7: one authority rule for linked contacts, drift and convergence
{
  const { classifyExportDisposition } = authority;
  const base = { recordClass: "unknown", archived: false, hasGhlContactId: true, localOnlyFence: false, currentIntakeEvidence: false };
  check(classifyExportDisposition({ ...base, existingOpenDisposition: null }).disposition === "historical_hold"
    && classifyExportDisposition({ ...base, existingOpenDisposition: "linked_update" }).disposition === "historical_hold"
    && classifyExportDisposition({ ...base, currentIntakeEvidence: true, existingOpenDisposition: null }).disposition === "linked_update",
    "H7: a linked contact is exportable only with current-intake evidence, independent of whether an open row exists");
  const cLink = await mkContact({ intake: false, ghl: `ghl_${run}_hist` });
  const eLink = await enqueue(cLink);
  check(eLink.disposition === "historical_hold" && !(await claimable([cLink])), "H7: an edit to a linked historical contact is held, not exported");
  const cLink2 = await mkContact({ ghl: `ghl_${run}_cur` });
  check((await enqueue(cLink2)).disposition === "linked_update" && await claimable([cLink2]), "H7: a linked contact with current-intake evidence is a linked update and is claimable");

  // a pre-fix producer changed source_kind / dispatch history of an evidence-free exportable row
  const cDrift = await mkContact({ intake: false });
  await pool.query(
    `INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,authority_version,export_disposition,source_kind,dispatch_count,next_attempt_at)
     VALUES($1,'ghl',$2,'pending',1,'current_intake','background_update',3, now() - interval '1 second')`, [cDrift, `drift:${cDrift}`]);
  check(!(await claimable([cDrift])), "H7: final eligibility proves authority: an exportable disposition without evidence is not claimable");
  check(await convergence.projectionConvergenceNeeded(), "H7: evidence-free exportable rows are detected as convergence work");
  await convergence.convergeLegacyProjectionRows();
  const drift = (await projRows(cDrift))[0];
  check(drift.export_disposition === "historical_hold" && drift.state === "pending" && Number(drift.dispatch_count) === 3,
    "H7: the reconcile returns the row to the hold whatever its source_kind/dispatch history, preserving the row");

  // runtime dedupe: a live lease outranks an authoritative row; operation linkage follows the survivor; other providers untouched
  const cDup = await mkContact();
  const legacyId = (await pool.query(
    `INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,claim_token,lease_expires_at,created_at)
     VALUES($1,'ghl',$2,'processing',$3,now() + interval '10 minutes', now() - interval '2 days') RETURNING id`, [cDup, `legacy:${cDup}:live`, randomUUID()])).rows[0].id;
  const authId = (await pool.query(
    `INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state,authority_version,export_disposition,dispatch_state,next_attempt_at)
     VALUES($1,'ghl',$2,'retry',1,'current_intake','ambiguous', now() + interval '1 day') RETURNING id`, [cDup, `contact:${cDup}:auth`])).rows[0].id;
  const opId = randomUUID();
  await pool.query(`INSERT INTO ghl_projection_operations(id,projection_id,contact_id,operation_class,method,state,identity) VALUES($1,$2,$3,'contact_create','POST','ambiguous',$4::jsonb)`,
    [opId, authId, cDup, JSON.stringify({ email: "orig@fixture.invalid", phone: null })]);
  const otherId = (await pool.query(
    `INSERT INTO contact_provider_projections(contact_id,provider,projection_key,state) VALUES($1,'other_cert',$2,'pending') RETURNING id`, [cDup, `other:${cDup}`])).rows[0].id;
  await convergence.convergeLegacyProjectionRows();
  const live = (await pool.query(`SELECT state, authority_version, claim_token, lease_expires_at, dispatch_state FROM contact_provider_projections WHERE id=$1`, [legacyId])).rows[0];
  const sup = (await pool.query(`SELECT state, superseded_by FROM contact_provider_projections WHERE id=$1`, [authId])).rows[0];
  const opRow = (await pool.query(`SELECT projection_id, identity FROM ghl_projection_operations WHERE id=$1`, [opId])).rows[0];
  const other = (await pool.query(`SELECT state, authority_version FROM contact_provider_projections WHERE id=$1`, [otherId])).rows[0];
  check(live.state === "processing" && live.claim_token !== null && live.authority_version === 1 && live.dispatch_state === "ambiguous"
    && sup.state === "superseded" && sup.superseded_by === legacyId,
    "H7: a live lease is never superseded by adoption; the survivor inherits the uncertainty");
  check(opRow.projection_id === legacyId && opRow.identity.email === "orig@fixture.invalid", "H7: an unresolved operation keeps its original identity and follows the surviving row");
  check(other.state === "pending" && other.authority_version === null, "H7: convergence never touches another provider's rows");
}

// ================================================================ H5/H6: durable webhook effects and appointment serialization
{
  const effects = await import("../../server/services/ghl-webhook-effects");
  const { sql } = await import("drizzle-orm");
  const handlers = await import("../../server/services/sdr/scheduling");
  await pool.query(`CREATE TABLE IF NOT EXISTS cert_h5_effects(id serial primary key, receipt_id uuid, tag text)`);
  const effectRows = async (tag: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM cert_h5_effects WHERE tag=$1`, [tag])).rows[0].n);
  const happ = express();
  happ.use(express.json());
  happ.use("/api/h5", receipts.ghlWebhookReceiptMiddleware());
  const steps = { a: 0, b: 0, failB: true };
  happ.post("/api/h5/x", async (req, res) => {
    try {
      const b = req.body;
      if (b.behave === "fail0") return res.status(500).json({ error: "boom" });
      if (b.behave === "multi") {
        await effects.runReceiptStep("a", async () => { steps.a++; return { ok: true }; });
        await effects.runReceiptStep("b", async () => { steps.b++; if (steps.failB) throw new Error("provider_down"); return { ok: true }; });
        return res.json({ ok: true });
      }
      if (b.behave === "slow") {
        await pool.query(`UPDATE ghl_provider_event_receipts SET lease_expires_at = now() + interval '1 second' WHERE id=$1`, [effects.currentReceiptId()]);
        await effects.runReceiptTxStep("effect", tx => tx.execute(sql`INSERT INTO cert_h5_effects(receipt_id, tag) VALUES (${effects.currentReceiptId()}::uuid, ${b.tag})`));
        await sleep(1600);
        const held = await pool.query(`SELECT (lease_expires_at > now() + interval '30 seconds') AS renewed FROM ghl_provider_event_receipts WHERE id=$1`, [effects.currentReceiptId()]);
        return res.json({ ok: true, renewed: held.rows[0].renewed });
      }
      await effects.runReceiptTxStep("effect", tx => tx.execute(sql`INSERT INTO cert_h5_effects(receipt_id, tag) VALUES (${effects.currentReceiptId()}::uuid, ${b.tag})`));
      if (b.behave === "tx-fail") return res.status(500).json({ error: "after_effect" });
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String((e as Error).message) }); }
  });
  const hserver = http.createServer(happ);
  await new Promise<void>(r => hserver.listen(0, "127.0.0.1", r));
  const hport = (hserver.address() as any).port;
  const hpost = (body: object) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({ host: "127.0.0.1", port: hport, path: "/api/h5/x", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, rs => {
      let buf = ""; rs.on("data", d => (buf += d)); rs.on("end", () => resolve({ status: rs.statusCode ?? 0, body: buf ? JSON.parse(buf) : null }));
    });
    rq.on("error", reject); rq.end(data);
  });
  const receiptOf = async (eventId: string, loc = "loc_h5") =>
    (await pool.query(`SELECT * FROM ghl_provider_event_receipts WHERE event_key=$1`, [`x:${loc}:evt:${eventId}`])).rows[0];
  const expireLease = (eventId: string) => pool.query(`UPDATE ghl_provider_event_receipts SET lease_expires_at = now() - interval '1 second' WHERE event_key=$1`, [`x:loc_h5:evt:${eventId}`]);

  // Reproduced case 6: the effect commits, the settlement write fails, the sender retries.
  {
    const eid = `h5-marker-${run}`, tag = `m-${run}`;
    const realQuery = pool.query.bind(pool);
    let faulted = 0;
    (pool as any).query = (...args: any[]) => {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      if (/UPDATE ghl_provider_event_receipts\s+SET state = \$3/.test(text) && faulted === 0) { faulted++; return Promise.reject(new Error("injected settlement fault")); }
      return realQuery(...args);
    };
    let first: { status: number; body: any };
    try { first = await hpost({ eventId: eid, locationId: "loc_h5", tag, behave: "tx" }); } finally { (pool as any).query = realQuery; }
    check(first.status === 503 && faulted === 1 && (await effectRows(tag)) === 1 && (await receiptOf(eid)).state === "claimed",
      "Case 6: the effect committed, the settlement failed, the sender sees a retryable 503 and the receipt is not applied");
    const dup = await hpost({ eventId: eid, locationId: "loc_h5", tag, behave: "tx" });
    check(dup.status === 409, "A retry while the lease is still live is refused, not run in parallel");
    await expireLease(eid);
    const retry = await hpost({ eventId: eid, locationId: "loc_h5", tag, behave: "tx" });
    check(retry.status === 200 && (await effectRows(tag)) === 1 && (await receiptOf(eid)).state === "applied",
      "Retry after the settlement fault completes the receipt and the persisted effect count stays exactly one");
    const stepRow = (await pool.query(`SELECT state FROM ghl_webhook_effect_steps WHERE receipt_id=$1`, [(await receiptOf(eid)).id])).rows;
    check(stepRow.length === 1 && stepRow[0].state === "done", "The effect step is recorded as done in the same transaction as the effect");
  }

  // Partial multi-effect: the first external effect is never repeated when the second fails.
  {
    const eid = `h5-multi-${run}`;
    steps.a = 0; steps.b = 0; steps.failB = true;
    const first = await hpost({ eventId: eid, locationId: "loc_h5", behave: "multi" });
    check(first.status === 500 && steps.a === 1 && steps.b === 1, "A failing second effect fails the receipt after the first effect ran once");
    steps.failB = false;
    const retry = await hpost({ eventId: eid, locationId: "loc_h5", behave: "multi" });
    check(retry.status === 200 && steps.a === 1 && steps.b === 2, "The retry skips the completed effect and re-runs only the failed one");
    const again = await hpost({ eventId: eid, locationId: "loc_h5", behave: "multi" });
    check(again.body?.duplicate === true && steps.a === 1 && steps.b === 2, "An applied multi-effect receipt is a harmless duplicate");
  }

  // Crash window: an external effect whose completion never recorded is re-run once (documented), a live one is not.
  {
    const eid = `h5-crash-${run}`;
    steps.a = 0; steps.b = 0; steps.failB = false;
    await hpost({ eventId: eid, locationId: "loc_h5", behave: "fail0" });
    const rec = await receiptOf(eid);
    await pool.query(`INSERT INTO ghl_webhook_effect_steps(receipt_id, step_key, state, step_token, lease_expires_at) VALUES ($1,'a','running',$2, now() + interval '5 minutes')`, [rec.id, randomUUID()]);
    // payload unchanged so the fingerprint matches; use the same body
    const live = await hpost({ eventId: eid, locationId: "loc_h5", behave: "fail0" });
    check(live.status === 500, "Fixture: failing receipt re-runs");
    await pool.query(`DELETE FROM ghl_webhook_effect_steps WHERE receipt_id=$1`, [rec.id]);
    await pool.query(`INSERT INTO ghl_webhook_effect_steps(receipt_id, step_key, state, step_token, lease_expires_at) VALUES ($1,'a','running',$2, now() + interval '5 minutes')`, [rec.id, randomUUID()]);
    await pool.query(`UPDATE ghl_provider_event_receipts SET state='failed', lease_expires_at=NULL, claim_token=NULL WHERE id=$1`, [rec.id]);
    // different behave would be a collision (step row exists); use the multi handler through a direct context instead
    const claim = await receipts.claimGhlWebhookReceipt(rec.event_key, "x", { payloadFingerprint: rec.payload_fingerprint });
    assert(claim.decision === "process");
    const ctx = { receiptId: claim.receiptId, claimToken: claim.claimToken, lost: false };
    let inFlight = false;
    await effects.receiptStepContext.run(ctx, async () => { try { await effects.runReceiptStep("a", async () => { steps.a++; }); } catch (e) { inFlight = e instanceof effects.ReceiptStepInFlightError; } });
    check(inFlight && steps.a === 0, "An external effect with a live lease held by an earlier attempt is not started a second time");
    await pool.query(`UPDATE ghl_webhook_effect_steps SET lease_expires_at = now() - interval '1 second' WHERE receipt_id=$1`, [rec.id]);
    await effects.receiptStepContext.run(ctx, () => effects.runReceiptStep("a", async () => { steps.a++; }));
    check(steps.a === 1 && Number((await pool.query(`SELECT attempt_count FROM ghl_webhook_effect_steps WHERE receipt_id=$1 AND step_key='a'`, [rec.id])).rows[0].attempt_count) === 2,
      "After a crash (lease expired, completion never recorded) only that one effect is re-run and the attempt is counted");
  }

  // Expired-lease overlap: the stale delivery cannot start or finish an effect.
  {
    const eid = `h5-overlap-${run}`, tag = `o-${run}`;
    const occ = receipts.ghlWebhookOccurrence("x", { eventId: eid, locationId: "loc_h5" });
    const claimA = await receipts.claimGhlWebhookReceipt(occ.eventKey, "x", { payloadFingerprint: occ.fingerprint });
    assert(claimA.decision === "process");
    await pool.query(`UPDATE ghl_provider_event_receipts SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [claimA.receiptId]);
    const claimB = await receipts.claimGhlWebhookReceipt(occ.eventKey, "x", { payloadFingerprint: occ.fingerprint });
    assert(claimB.decision === "process");
    const ctxA = { receiptId: claimA.receiptId, claimToken: claimA.claimToken, lost: false };
    const ctxB = { receiptId: claimB.receiptId, claimToken: claimB.claimToken, lost: false };
    const insert = (t: string) => (tx: any) => tx.execute(sql`INSERT INTO cert_h5_effects(receipt_id, tag) VALUES (${claimA.receiptId}::uuid, ${t})`);
    let lost = false;
    try { await effects.receiptStepContext.run(ctxA, () => effects.runReceiptTxStep("effect", insert(tag))); } catch (e) { lost = e instanceof effects.ReceiptClaimLostError; }
    check(lost && (await effectRows(tag)) === 0 && ctxA.lost === true, "A delivery whose lease was taken over cannot start an effect");
    await effects.receiptStepContext.run(ctxB, () => effects.runReceiptTxStep("effect", insert(tag)));
    let lateLost = false;
    try { await effects.receiptStepContext.run(ctxA, () => effects.runReceiptStep("ext", async () => 1)); } catch (e) { lateLost = e instanceof effects.ReceiptClaimLostError; }
    check(lateLost && (await effectRows(tag)) === 1, "The stale delivery stays fenced after the new claimant ran the effect (exactly one persisted effect)");
    check(await receipts.markGhlWebhookReceipt(claimA.receiptId, claimA.claimToken, "applied") === false
      && await receipts.markGhlWebhookReceipt(claimB.receiptId, claimB.claimToken, "applied") === true, "Only the current claimant can settle the receipt");
  }

  // C: completion fenced by the receipt claim; a takeover mid-flight re-runs the step with the same identity and attempt + 1.
  {
    const eid = `h5-fence-${run}`;
    const occ = receipts.ghlWebhookOccurrence("x", { eventId: eid, locationId: "loc_h5" });
    const claimA = await receipts.claimGhlWebhookReceipt(occ.eventKey, "x", { payloadFingerprint: occ.fingerprint });
    assert(claimA.decision === "process");
    const ctxA = { receiptId: claimA.receiptId, claimToken: claimA.claimToken, lost: false };
    const seen: Array<{ receiptId: string | null; stepKey: string; attempt: number }> = [];
    let claimB: any = null;
    let aLost = false;
    try {
      await effects.receiptStepContext.run(ctxA, () => effects.runReceiptStep("ext-fence", async info => {
        seen.push(info);
        // while the external call is in flight the lease lapses and another delivery takes the receipt over
        await pool.query(`UPDATE ghl_provider_event_receipts SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [claimA.receiptId]);
        claimB = await receipts.claimGhlWebhookReceipt(occ.eventKey, "x", { payloadFingerprint: occ.fingerprint });
        return "provider_accepted";
      }));
    } catch (e) { aLost = e instanceof effects.ReceiptClaimLostError; }
    const stepRow = (await pool.query(`SELECT state FROM ghl_webhook_effect_steps WHERE receipt_id=$1 AND step_key='ext-fence'`, [claimA.receiptId])).rows[0];
    check(aLost && ctxA.lost === true && stepRow.state === "running",
      "C: a delivery that lost its receipt claim while the external call was in flight cannot record the step as done (completion is fenced by the claim)");
    assert(claimB?.decision === "process");
    const ctxB = { receiptId: claimB.receiptId, claimToken: claimB.claimToken, lost: false };
    await effects.receiptStepContext.run(ctxB, () => effects.runReceiptStep("ext-fence", async info => { seen.push(info); return "provider_accepted"; }));
    check(seen.length === 2 && seen[0].receiptId === seen[1].receiptId && seen[0].stepKey === seen[1].stepKey && seen[0].attempt === 1 && seen[1].attempt === 2,
      "C: the takeover re-runs the step immediately with the same {receiptId, stepKey} identity and attempt + 1");
  }
  // C: runReceiptTxStep overlap — a concurrent takeover cannot interleave with an in-flight local effect.
  {
    const eid = `h5-race-${run}`, tag = `r-${run}`;
    const occ = receipts.ghlWebhookOccurrence("x", { eventId: eid, locationId: "loc_h5" });
    const claimA = await receipts.claimGhlWebhookReceipt(occ.eventKey, "x", { payloadFingerprint: occ.fingerprint });
    assert(claimA.decision === "process");
    const ctxA = { receiptId: claimA.receiptId, claimToken: claimA.claimToken, lost: false };
    const insert = (tx: any) => tx.execute(sql`INSERT INTO cert_h5_effects(receipt_id, tag) VALUES (${claimA.receiptId}::uuid, ${tag})`);
    let aFinished = false;
    const aPromise = effects.receiptStepContext.run(ctxA, () => effects.runReceiptTxStep("effect", async tx => { await insert(tx); await sleep(700); aFinished = true; }));
    await sleep(250);
    let takeoverSawFinished: boolean | null = null;
    const takeover = (async () => {
      await pool.query(`UPDATE ghl_provider_event_receipts SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [claimA.receiptId]);
      const b = await receipts.claimGhlWebhookReceipt(occ.eventKey, "x", { payloadFingerprint: occ.fingerprint });
      takeoverSawFinished = aFinished;
      return b;
    })();
    const [aResult, claimB] = await Promise.all([aPromise, takeover]);
    assert(claimB.decision === "process");
    check(aResult.replayed === false && takeoverSawFinished === true && (await effectRows(tag)) === 1,
      "C: a takeover racing an in-flight local effect waits for it to commit (the effect and its step record are never interleaved with the takeover)");
    const ctxB = { receiptId: claimB.receiptId, claimToken: claimB.claimToken, lost: false };
    const replay = await effects.receiptStepContext.run(ctxB, () => effects.runReceiptTxStep("effect", insert));
    check(replay.replayed === true && (await effectRows(tag)) === 1, "C: the new claimant replays the committed step instead of repeating the effect");
  }

  // Changed payload under one occurrence key.
  {
    const eid = `h5-changed-${run}`, tag = `c-${run}`;
    const a = await hpost({ eventId: eid, locationId: "loc_h5", tag, behave: "fail0" });
    const b = await hpost({ eventId: eid, locationId: "loc_h5", tag, behave: "tx" });
    check(a.status === 500 && b.status === 200 && (await effectRows(tag)) === 1,
      "A changed payload after a failure that did nothing durable is adopted as the same occurrence and applied once");
    const eid2 = `h5-changed2-${run}`, tag2 = `c2-${run}`;
    const c = await hpost({ eventId: eid2, locationId: "loc_h5", tag: tag2, behave: "tx-fail" });
    const d = await hpost({ eventId: eid2, locationId: "loc_h5", tag: tag2, behave: "tx" });
    const rec2 = await receiptOf(eid2);
    check(c.status === 500 && d.status === 409 && d.body.error === "occurrence_payload_conflict" && (await effectRows(tag2)) === 1 && Number(rec2.collision_count) === 1,
      "A changed payload after an effect was committed is a held collision: no second effect, counted on the receipt");
  }

  // Occurrence identity: location scope and legacy keys.
  {
    const eid = `h5-loc-${run}`, tag = `l-${run}`;
    await hpost({ eventId: eid, locationId: "loc_h5", tag, behave: "tx" });
    await hpost({ eventId: eid, locationId: "loc_h5b", tag, behave: "tx" });
    check((await effectRows(tag)) === 2 && (await receiptOf(eid, "loc_h5b")) !== undefined, "The same provider event id in a different location is a separate occurrence");
    const lid = `h5-legacy-${run}`, ltag = `lg-${run}`;
    await pool.query(`INSERT INTO ghl_provider_event_receipts(event_key, event_type, state, applied_at) VALUES ($1,'x','applied',now())`, [`x:evt:${lid}`]);
    const dup = await hpost({ eventId: lid, locationId: "loc_h5", tag: ltag, behave: "tx" });
    check(dup.body?.duplicate === true && (await effectRows(ltag)) === 0, "A receipt written under the pre-scoping key still deduplicates the same event");
  }

  // Long handler keeps its claim.
  {
    process.env.GHL_WEBHOOK_HEARTBEAT_MS = "200";
    const eid = `h5-slow-${run}`, tag = `s-${run}`;
    const [first, second] = await Promise.all([
      hpost({ eventId: eid, locationId: "loc_h5", tag, behave: "slow" }),
      (async () => { await sleep(1300); return hpost({ eventId: eid, locationId: "loc_h5", tag, behave: "slow" }); })(),
    ]);
    delete process.env.GHL_WEBHOOK_HEARTBEAT_MS;
    check(first.status === 200 && first.body.renewed === true && second.status === 409 && (await effectRows(tag)) === 1,
      "A handler that outlives its original lease keeps the claim, and a second delivery is refused while it runs");
  }
  hserver.close();

  // H6: appointment transitions serialize before effects (real handlers, real database, real receipts).
  {
    const before = ghlCalls.length;
    const t = (n: number) => new Date(Date.UTC(2026, 9, 24, 15, n)).toISOString();
    let evSeq = 0;
    const delivery = async (kind: "booked" | "updated" | "canceled", payload: Record<string, unknown>, handler?: (p: any) => Promise<void>) => {
      const body = { eventId: `h6-${run}-${++evSeq}`, locationId: "loc_cert_fake", ...payload };
      const occ = receipts.ghlWebhookOccurrence(`appointment-${kind}`, body);
      const claim = await receipts.claimGhlWebhookReceipt(occ.eventKey, `appointment-${kind}`, { ...receipts.extractReceiptMeta(body), payloadFingerprint: occ.fingerprint }, occ.legacyEventKey);
      assert(claim.decision === "process", `delivery claim ${claim.decision}`);
      const ctx = { receiptId: claim.receiptId, claimToken: claim.claimToken, lost: false };
      return effects.receiptStepContext.run(ctx, async () => {
        const verdict = await appointments.acceptGhlAppointmentTransition({ kind, payload: body, allowedLocationId: "loc_cert_fake", allowedCalendarIds: [] });
        if (verdict.decision === "apply" && handler) await handler(body);
        await receipts.markGhlWebhookReceipt(claim.receiptId, claim.claimToken, "applied");
        return verdict.decision;
      });
    };
    const mkMerchant = async () => {
      const ghl = `ghl_h6_${run}_${++evSeq}`;
      const m = (await pool.query(`INSERT INTO sdr_merchants(business_name, ghl_contact_id) VALUES ('H6 Merchant', $1) RETURNING id`, [ghl])).rows[0];
      return { id: Number(m.id), ghl };
    };
    const events = async (merchantId: number, type: string) =>
      Number((await pool.query(`SELECT count(*)::int AS n FROM sdr_lead_events WHERE merchant_id=$1 AND event_type=$2`, [merchantId, type])).rows[0].n);
    const stage = async (merchantId: number) => (await pool.query(`SELECT current_stage FROM sdr_lead_state WHERE merchant_id=$1`, [merchantId])).rows[0]?.current_stage ?? null;

    // Reproduced case 5: a booked event that arrives after an update, then repeats.
    {
      const m = await mkMerchant(); const aid = `h6a-${run}`;
      const base = { appointmentId: aid, contactId: m.ghl, calendarId: "cal_x" };
      await delivery("updated", { ...base, dateUpdated: t(5) });
      const v1 = await delivery("booked", { ...base, dateUpdated: t(3) }, handlers.handleAppointmentBooked);
      const v2 = await delivery("booked", { ...base, dateUpdated: t(3) }, handlers.handleAppointmentBooked);
      const v3 = await delivery("booked", { ...base, dateUpdated: t(4) }, handlers.handleAppointmentBooked);
      check(v1 === "apply" && v2 === "replay" && v3 === "replay" && (await events(m.id, "appointment_booked")) === 1 && (await stage(m.id)) === "MEETING_SET",
        "Case 5: a booked event after an update runs its effects once; repeated booked deliveries are replays with one persisted effect");
      const st = (await pool.query(`SELECT status, last_event_at FROM ghl_appointment_state WHERE appointment_id=$1`, [aid])).rows[0];
      check(st.status === "updated" && new Date(st.last_event_at).toISOString() === t(5), "The older booked event did not regress the newer recorded state");
    }

    // Concurrent cancel/book for one appointment, repeated to exercise both orders.
    {
      let bookedEffects = 0, order = { cancelFirst: 0, bookFirst: 0 };
      for (let i = 0; i < 10; i++) {
        const m = await mkMerchant(); const aid = `h6b-${run}-${i}`;
        const base = { appointmentId: aid, contactId: m.ghl, calendarId: "cal_x" };
        const [vb, vc] = await Promise.all([
          delivery("booked", { ...base, dateUpdated: t(1) }, handlers.handleAppointmentBooked),
          delivery("canceled", { ...base, dateUpdated: t(2) }, handlers.handleAppointmentCanceled),
        ]);
        const st = (await pool.query(`SELECT status FROM ghl_appointment_state WHERE appointment_id=$1`, [aid])).rows[0];
        const booked = await events(m.id, "appointment_booked");
        bookedEffects += booked;
        if (vb === "terminal") order.cancelFirst++; else order.bookFirst++;
        assert(st.status === "canceled", `final state must be canceled (${vb}/${vc})`);
        assert((await stage(m.id)) !== "MEETING_SET", `a canceled appointment must not leave MEETING_SET (${vb}/${vc})`);
        assert((await events(m.id, "appointment_canceled")) === 1, "exactly one cancel effect");
        assert(booked <= 1 && (vb === "terminal" ? booked === 0 : true), "a terminal booked event ran no effect");
      }
      check(true, `Concurrent book/cancel over 10 appointments: every final state is canceled, no stale MEETING_SET, one cancel effect each (cancel-first ${order.cancelFirst}, book-first ${order.bookFirst}, booked effects ${bookedEffects})`);
    }

    // A booked effect superseded between acceptance and the local step does not run.
    {
      const m = await mkMerchant(); const aid = `h6c-${run}`;
      const base = { appointmentId: aid, contactId: m.ghl, calendarId: "cal_x" };
      const claimBody = { eventId: `h6c-${run}`, locationId: "loc_cert_fake", ...base, dateUpdated: t(1) };
      const occ = receipts.ghlWebhookOccurrence("appointment-booked", claimBody);
      const claim = await receipts.claimGhlWebhookReceipt(occ.eventKey, "appointment-booked", { payloadFingerprint: occ.fingerprint });
      assert(claim.decision === "process");
      const ctx = { receiptId: claim.receiptId, claimToken: claim.claimToken, lost: false };
      await effects.receiptStepContext.run(ctx, () => appointments.acceptGhlAppointmentTransition({ kind: "booked", payload: claimBody, allowedLocationId: "loc_cert_fake", allowedCalendarIds: [] }));
      await delivery("canceled", { ...base, dateUpdated: t(2) }, handlers.handleAppointmentCanceled);
      await effects.receiptStepContext.run(ctx, () => handlers.handleAppointmentBooked(claimBody));
      check((await events(m.id, "appointment_booked")) === 0 && (await stage(m.id)) !== "MEETING_SET",
        "A booked effect accepted before a cancel is superseded: it runs no local, outreach or enrollment effect");
    }

    // Held enrollment is visible, never silent.
    {
      const m = await mkMerchant(); const aid = `h6d-${run}`;
      await delivery("booked", { appointmentId: aid, contactId: m.ghl, calendarId: "cal_x", dateUpdated: t(1) }, handlers.handleAppointmentBooked);
      check((await events(m.id, "workflow_enrollment_held")) === 1, "A workflow enrollment that could not be performed is recorded as a visible held event, not dropped");
    }
    check(ghlCalls.slice(before).every(c => c.method === "GET"), `The appointment delivery paths made no provider write in the disposable run (read-only requests: ${ghlCalls.length - before})`);

    // C: structured appointment handoff outcomes. Every fixture creates BOTH the SDR merchant and the CRM contact that
    // share one GHL contact id; the provider is a fake host behind the real transport, pause authority and receipts.
    {
      const webhookHandlers = await import("../../server/services/sdr/webhook-handlers");
      const { retryDeferredEnrollments } = await import("../../server/services/ghl-enrollment-recovery");
      const pauseAuth = await import("../../server/services/outbound-pause-authority");
      const savedEnv = { wf: process.env.GHL_WORKFLOW_BOOKING_CONFIRM, ch: process.env.GHL_WORKFLOW_VERIFIED_CHANNELS_BOOKING_CONFIRMATION, tok: process.env.GHL_PRIVATE_INTEGRATION_TOKEN, loc: process.env.GHL_LOCATION_ID, sms: process.env.SMS_ENABLED };
      process.env.SMS_ENABLED = "true"; // the native booking workflow is verified for email and SMS; the local gate still requires consent evidence
      process.env.GHL_WORKFLOW_BOOKING_CONFIRM = "wf_book_cert";
      process.env.GHL_WORKFLOW_VERIFIED_CHANNELS_BOOKING_CONFIRMATION = "email,sms";
      process.env.GHL_PRIVATE_INTEGRATION_TOKEN ||= "cert-token";
      process.env.GHL_LOCATION_ID ||= "loc_cert_fake";
      type Wf = { url: string; body: any };
      const wf: Wf[] = [];
      const mode = { value: "ok" as "ok" | "lose" | "bad400" | "rate429" };
      const prevFetch = globalThis.fetch;
      const prevResponder = ghlResponder;
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
        if (/\/workflow\//.test(url) && String(init?.method ?? "GET").toUpperCase() === "POST") {
          let body: any = null; try { body = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { body = null; }
          wf.push({ url, body });
        }
        return prevFetch(input, init);
      }) as typeof fetch;
      ghlResponder = call => {
        if (/\/workflow\//.test(call.url) && call.method === "POST") {
          if (mode.value === "lose") throw new Error("socket hang up");
          if (mode.value === "bad400") return json({ message: "bad workflow" }, 400);
          if (mode.value === "rate429") return new Response("{}", { status: 429, headers: { "retry-after": "0", "content-type": "application/json" } });
          return json({ success: true });
        }
        return prevResponder(call);
      };
      const setPause = async (paused: boolean) => {
        await pool.query(`UPDATE outbound_pause_control SET state=$1, committed_at=NOW()`, [paused ? "paused" : "unpaused"]);
        pauseAuth.invalidatePauseStateCache();
      };
      const mkPair = async (merchant = true) => {
        const m = merchant ? await mkMerchant() : null;
        const ghl = m?.ghl ?? `ghl_h6c_${run}_${++evSeq}`;
        const cid = await mkContact({ ghl });
        // transactional booking confirmation: the address only needs to be a deliverable, non-blocked status
        await pool.query(`UPDATE contacts SET email_status='valid' WHERE id=$1`, [cid]);
        await pool.query(`INSERT INTO consent_audit_logs(contact_id, channel, action, consented, consent_type, disclosure_version, consented_phone, source)
                          SELECT id, 'sms', 'opt_in', true, 'express_written', 'cert-v1', phone, 'cert' FROM contacts WHERE id=$1`, [cid]);
        return { m, ghl, cid };
      };
      const deferredRow = async (ghl: string) =>
        (await pool.query(`SELECT status, retry_count FROM deferred_ghl_enrollments WHERE ghl_contact_id=$1 AND workflow_key='booking_confirmation'`, [ghl])).rows[0];
      const heldEvent = async (merchantId: number) =>
        (await pool.query(`SELECT payload_json FROM sdr_lead_events WHERE merchant_id=$1 AND event_type='workflow_enrollment_held' AND payload_json->>'workflowKey'='booking_confirmation' ORDER BY id DESC LIMIT 1`, [merchantId])).rows[0]?.payload_json;
      const stepKeys = async (receiptId: string) =>
        (await pool.query(`SELECT step_key, state, attempt_count FROM ghl_webhook_effect_steps WHERE receipt_id=$1 ORDER BY step_key`, [receiptId])).rows;
      type Delivered = { decision: string; error?: string; receiptId?: string };
      const deliverFixed = async (kind: "booked" | "canceled", body: Record<string, unknown>, handler: (p: any) => Promise<void>, opts: { accept?: boolean } = {}): Promise<Delivered> => {
        const occ = receipts.ghlWebhookOccurrence(`appointment-${kind}`, body);
        const claim = await receipts.claimGhlWebhookReceipt(occ.eventKey, `appointment-${kind}`, { ...receipts.extractReceiptMeta(body), payloadFingerprint: occ.fingerprint }, occ.legacyEventKey);
        if (claim.decision !== "process") return { decision: claim.decision };
        const ctx = { receiptId: claim.receiptId, claimToken: claim.claimToken, lost: false };
        try {
          await effects.receiptStepContext.run(ctx, async () => {
            if (opts.accept !== false) {
              const verdict = await appointments.acceptGhlAppointmentTransition({ kind, payload: body, allowedLocationId: "loc_cert_fake", allowedCalendarIds: [] });
              if (verdict.decision !== "apply") return;
            }
            await handler(body);
          });
          await receipts.markGhlWebhookReceipt(claim.receiptId, claim.claimToken, "applied");
          return { decision: "applied", receiptId: claim.receiptId };
        } catch (error) {
          await receipts.markGhlWebhookReceipt(claim.receiptId, claim.claimToken, "failed", String((error as Error).message));
          return { decision: "failed", error: String((error as Error).message), receiptId: claim.receiptId };
        }
      };
      const bookedBody = (ghl: string, tag: string) => ({ eventId: `h6c3-${run}-${tag}`, locationId: "loc_cert_fake", appointmentId: `apt-${run}-${tag}`, contactId: ghl, calendarId: "cal_x", dateUpdated: t(1), startTime: new Date(Date.now() + 86_400_000).toISOString() });
      const mutationsBefore = ghlCalls.length;
      // The SMS compliance gate depends on local business hours (no weekends); fix "now" for argument-less Date
      // construction to a Tuesday 14:00 in America/New_York so the fixture is deterministic on any day.
      const RealDate = Date;
      class FixedClockDate extends RealDate {
        constructor(...args: any[]) { if (args.length === 0) super("2026-10-27T18:00:00Z"); else super(...(args as [any])); }
        static now() { return RealDate.now(); }
      }
      globalThis.Date = FixedClockDate as unknown as DateConstructor;
      try {
        // 1. paused: nothing reaches the provider, the handoff is held with a durable owner, the CRM step does not enrol twice.
        await setPause(true);
        const p1 = await mkPair();
        const b1 = bookedBody(p1.ghl, "paused");
        const d1 = await deliverFixed("booked", b1, webhookHandlers.handleAppointmentBooked);
        const ev1 = await heldEvent(p1.m!.id);
        const def1 = await deferredRow(p1.ghl);
        // (the unrelated inbox-tag step cannot run during the pause, so the receipt itself may be left for the sender to retry)
        check((d1.decision === "applied" || /inbox_tag_failed/.test(d1.error ?? "")) && wf.length === 0 && ev1?.state === "held" && ev1?.durable === true && def1?.status === "pending",
          "C: with the outbound pause active the booking handoff is a structured held outcome with a durable deferred enrollment, and nothing is sent");
        const steps1 = await stepKeys(d1.receiptId!);
        check(steps1.some(r => r.step_key === "booked:enroll_booking_confirmation" && r.state === "done") && !steps1.some(r => r.step_key === "booked:crm_appointment_workflow"),
          "C: the SDR merchant step and the CRM contact step address one GHL contact, so the CRM step does not enrol a second time");
        // cancellation while the handoff is only owed: the deferred confirmation is withdrawn with the cancellation
        const c1 = await deliverFixed("canceled", { eventId: `h6c3-${run}-paused-cancel`, locationId: "loc_cert_fake", appointmentId: b1.appointmentId, contactId: p1.ghl, calendarId: "cal_x", dateUpdated: t(5) }, webhookHandlers.handleAppointmentCanceled);
        check(c1.decision === "applied" && !(await deferredRow(p1.ghl)), "C: cancelling an appointment withdraws its still-owed booking confirmation (no confirmation for a canceled booking)");

        // 2. a held handoff survives the pause: after unpause the recovery owner delivers it exactly once.
        const p2 = await mkPair();
        await deliverFixed("booked", bookedBody(p2.ghl, "recover"), webhookHandlers.handleAppointmentBooked);
        check((await deferredRow(p2.ghl))?.status === "pending", "C: a handoff refused during the pause is retained, not discarded");
        await setPause(false);
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p2.ghl]);
        const wfBefore = wf.length;
        await retryDeferredEnrollments();
        check(wf.length === wfBefore + 1 && wf[wf.length - 1].url.includes(p2.ghl) && !(await deferredRow(p2.ghl) && (await deferredRow(p2.ghl)).status === "pending"),
          "C: after the pause is lifted the deferred-enrollment recovery performs the retained handoff once");

        // 3. provider accepts: one request carrying the stable identity; no deferral; CRM-only contact uses the CRM step.
        const p3 = await mkPair();
        const b3 = bookedBody(p3.ghl, "accepted");
        const w3 = wf.length;
        const d3 = await deliverFixed("booked", b3, webhookHandlers.handleAppointmentBooked);
        check(d3.decision === "applied" && wf.length === w3 + 1 && wf[w3].body.idempotencyKey === `${d3.receiptId}:booked:enroll_booking_confirmation` && wf[w3].body.attempt === 1
          && !(await deferredRow(p3.ghl)) && !(await heldEvent(p3.m!.id)),
          "C: an accepted handoff is one provider request carrying the stable {receiptId, stepKey, attempt} identity, with no deferral and no held event");
        const p3b = await mkPair(false);
        const w3b = wf.length;
        const d3b = await deliverFixed("booked", bookedBody(p3b.ghl, "crm-only"), webhookHandlers.handleAppointmentBooked);
        check(d3b.decision === "applied" && wf.length === w3b + 1 && wf[w3b].body.idempotencyKey === `${d3b.receiptId}:booked:crm_appointment_workflow`,
          "C: a CRM contact with no SDR merchant is handed off by the CRM step under its own stable identity");
        // cancellation after acceptance: the accepted enrollment is not repeated and nothing is owed
        const w3c = wf.length;
        const c3 = await deliverFixed("canceled", { eventId: `h6c3-${run}-accepted-cancel`, locationId: "loc_cert_fake", appointmentId: b3.appointmentId, contactId: p3.ghl, calendarId: "cal_x", dateUpdated: t(6) }, webhookHandlers.handleAppointmentCanceled);
        check(c3.decision === "applied" && wf.filter((w, i) => i >= w3c && w.body?.idempotencyKey?.includes("booked:")).length === 0 && !(await deferredRow(p3.ghl)),
          "C: a cancellation after the provider accepted the booking handoff repeats nothing and leaves nothing owed");

        // 4. lost response: unknown outcome, owned by the recovery job, not an error and not a silent success.
        mode.value = "lose";
        const p4 = await mkPair();
        const d4 = await deliverFixed("booked", bookedBody(p4.ghl, "lost"), webhookHandlers.handleAppointmentBooked);
        const ev4 = await heldEvent(p4.m!.id);
        check(d4.decision === "applied" && ev4?.state === "unknown" && ev4?.durable === false && !(await deferredRow(p4.ghl)) && wf.length >= 1,
          "C: a lost provider response is an explicit unknown hold recorded visibly: nothing is deferred for re-assertion and the receipt is not failed");
        mode.value = "ok";
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute'`);
        const w4 = wf.length;
        await retryDeferredEnrollments();
        check(wf.filter((w, i) => i >= w4 && w.url.includes(p4.ghl)).length === 0, "C: an unknown outcome is never re-sent by the recovery job");
        const d4b = await deliverFixed("booked", bookedBody(p4.ghl, "lost"), webhookHandlers.handleAppointmentBooked, { accept: false });
        check(wf.filter((w, i) => i >= w4 && w.url.includes(p4.ghl)).length === 0 && ((await pool.query(`SELECT state FROM ghl_workflow_handoff_dispatches WHERE ghl_contact_id=$1`, [p4.ghl])).rows[0]?.state === "started"),
          "C: a repeat delivery after a lost response finds the started dispatch and does not send a second enrollment");
        void d4b;

        // 5. provider refusal with no durable owner fails the receipt; the retry runs the same step with the same identity.
        mode.value = "bad400";
        const p5 = await mkPair();
        const b5 = bookedBody(p5.ghl, "refused");
        const d5 = await deliverFixed("booked", b5, webhookHandlers.handleAppointmentBooked);
        check(d5.decision === "failed" && /workflow_enrollment_failed/.test(d5.error ?? "") && !(await deferredRow(p5.ghl)),
          "C: a refused handoff with no durable owner fails the receipt so the sender's retry recovers it");
        mode.value = "ok";
        const w5 = wf.length;
        const r5 = await deliverFixed("booked", b5, webhookHandlers.handleAppointmentBooked, { accept: false });
        check(r5.decision === "applied" && wf.length === w5 + 1 && wf[w5].body.idempotencyKey === `${d5.receiptId}:booked:enroll_booking_confirmation` && wf[w5].body.attempt === 2,
          "C: the retry re-runs only the failed step under the same identity with the attempt counted");

        // 6. local completion failure after provider acceptance: retry repeats the call under the SAME identity (provider-idempotent).
        const p6 = await mkPair();
        const b6 = bookedBody(p6.ghl, "completion");
        const realQuery = pool.query.bind(pool);
        let injected = 0;
        (pool as any).query = (...args: any[]) => {
          const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
          if (/UPDATE ghl_webhook_effect_steps SET state = 'done'/.test(text) && args[1]?.[1] === "booked:enroll_booking_confirmation" && injected === 0) { injected++; return Promise.reject(new Error("injected completion failure")); }
          return realQuery(...(args as [any]));
        };
        const w6 = wf.length;
        let d6: Delivered;
        try { d6 = await deliverFixed("booked", b6, webhookHandlers.handleAppointmentBooked); } finally { (pool as any).query = realQuery; }
        check(d6.decision === "failed" && /injected completion failure/.test(d6.error ?? "") && wf.length === w6 + 1, "C: a local completion failure after provider acceptance fails the receipt");
        const r6 = await deliverFixed("booked", b6, webhookHandlers.handleAppointmentBooked, { accept: false });
        const sameKey = wf.slice(w6).every(w => w.body.idempotencyKey === `${d6.receiptId}:booked:enroll_booking_confirmation`);
        check(r6.decision === "applied" && wf.length === w6 + 1 && sameKey,
          "C: the retry after a local completion failure does not send a second enrollment (the dispatch ledger holds the accepted handoff)");

        // 7. two bookings of one contact are two obligations; cancelling one withdraws only that one.
        await setPause(true);
        const p7 = await mkPair();
        const b7a = bookedBody(p7.ghl, "two-a"); const b7b = bookedBody(p7.ghl, "two-b");
        await deliverFixed("booked", b7a, webhookHandlers.handleAppointmentBooked);
        await deliverFixed("booked", b7b, webhookHandlers.handleAppointmentBooked);
        const pending7 = async () => (await pool.query(`SELECT id FROM deferred_ghl_enrollments WHERE ghl_contact_id=$1 AND status='pending'`, [p7.ghl])).rows.map((r: any) => r.id as string);
        check((await pending7()).length === 2, "C: two bookings of one contact own two separate deferred obligations");
        await deliverFixed("canceled", { eventId: `h6c3-${run}-two-a-cancel`, locationId: "loc_cert_fake", appointmentId: b7a.appointmentId, contactId: p7.ghl, calendarId: "cal_x", dateUpdated: t(9) }, webhookHandlers.handleAppointmentCanceled);
        const left7 = await pending7();
        check(left7.length === 1 && left7[0].endsWith(`::${b7b.appointmentId}`), "C: cancelling one appointment withdraws only that appointment's obligation");
        await setPause(false);
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p7.ghl]);
        const w7 = wf.length;
        await retryDeferredEnrollments();
        check(wf.slice(w7).filter(w => w.url.includes(p7.ghl)).length === 1 && (await pending7()).length === 0, "C: the remaining booking is delivered exactly once");

        // 8. cancel after the worker claimed the item but before final dispatch: the cancel wins, nothing is sent.
        await setPause(true);
        const p8 = await mkPair();
        const b8 = bookedBody(p8.ghl, "claimed");
        await deliverFixed("booked", b8, webhookHandlers.handleAppointmentBooked);
        await setPause(false);
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p8.ghl]);
        const recovery = await import("../../server/services/ghl-enrollment-recovery");
        const realQuery8 = pool.query.bind(pool);
        let cancelledAfterClaim = -1;
        (pool as any).query = async (...args: any[]) => {
          const out = await realQuery8(...(args as [any]));
          const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
          if (cancelledAfterClaim === -1 && /UPDATE\s+deferred_ghl_enrollments/.test(text) && (out.rows ?? []).some((r: any) => r.ghl_contact_id === p8.ghl)) {
            cancelledAfterClaim = -2;
            cancelledAfterClaim = (await recovery.cancelDeferredEnrollmentsForOccurrence({ ghlContactId: p8.ghl, occurrenceKey: b8.appointmentId })).cancelled;
          }
          return out;
        };
        const w8 = wf.length;
        try { await retryDeferredEnrollments(); } finally { (pool as any).query = realQuery8; }
        check(cancelledAfterClaim === 1 && wf.slice(w8).filter(w => w.url.includes(p8.ghl)).length === 0
          && !(await deferredRow(p8.ghl)), "C: a cancel that lands after the worker claimed the item still wins: the recheck at final dispatch finds it gone and nothing is sent");

        // 9. suppression changes between deferral and retry: final dispatch re-runs the gate and retires the obligation.
        await setPause(true);
        const p9 = await mkPair();
        await deliverFixed("booked", bookedBody(p9.ghl, "suppressed"), webhookHandlers.handleAppointmentBooked);
        await setPause(false);
        await pool.query(`UPDATE contacts SET do_not_contact=true WHERE id=$1`, [p9.cid]);
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p9.ghl]);
        const w9 = wf.length;
        await retryDeferredEnrollments();
        const denied9 = (await pool.query(`SELECT 1 FROM audit_logs WHERE action='ghl_enrollment_recovery_denied' AND entity_key=$1`, [p9.ghl])).rowCount;
        check(wf.slice(w9).filter(w => w.url.includes(p9.ghl)).length === 0 && !(await deferredRow(p9.ghl)) && denied9 === 1,
          "C: a contact suppressed after deferral is not enrolled by the retry; the obligation is retired with an audit row");

        // 10. lost response during recovery: parked as an explicit unknown outcome, never re-sent.
        await setPause(true);
        const p10 = await mkPair();
        await deliverFixed("booked", bookedBody(p10.ghl, "recover-lost"), webhookHandlers.handleAppointmentBooked);
        await setPause(false);
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p10.ghl]);
        mode.value = "lose";
        const w10 = wf.length;
        await retryDeferredEnrollments();
        const parked = (await pool.query(`SELECT status, last_error FROM deferred_ghl_enrollments WHERE ghl_contact_id=$1`, [p10.ghl])).rows[0];
        mode.value = "ok";
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p10.ghl]);
        await retryDeferredEnrollments();
        check(wf.slice(w10).filter(w => w.url.includes(p10.ghl)).length === 1 && parked?.status === "failed" && /^unknown_outcome:/.test(parked?.last_error ?? ""),
          "C: a lost response during recovery is parked as an unknown outcome and the later tick does not send a second enrollment");

        // 11. a deferral that cannot be verified is not durable: the receipt fails so the sender's retry recovers it.
        await setPause(true);
        const p11 = await mkPair();
        const b11 = bookedBody(p11.ghl, "no-owner");
        await pool.query(`INSERT INTO deferred_ghl_enrollments (id, ghl_contact_id, workflow_key, metadata, enqueued_at, retry_count, next_retry_at, last_error, status, failed_at)
                          VALUES ($1,$2,'booking_confirmation',NULL,now(),9,now(),'prior terminal failure','failed',now())`, [`${p11.ghl}::booking_confirmation::${b11.appointmentId}`, p11.ghl]);
        const d11 = await deliverFixed("booked", b11, webhookHandlers.handleAppointmentBooked);
        check(d11.decision === "failed" && /deferral_not_persisted|workflow_enrollment_failed/.test(d11.error ?? "") && !(await heldEvent(p11.m!.id)),
          "C: when the deferral write changes no row the handoff is not reported durable and the receipt fails instead of completing");

        // 12. a transient first failure (429) leaves exactly ONE occurrence-scoped obligation, which the occurrence cancels.
        await setPause(false);
        mode.value = "rate429";
        const p12 = await mkPair();
        const b12 = bookedBody(p12.ghl, "c2-429");
        await deliverFixed("booked", b12, webhookHandlers.handleAppointmentBooked);
        mode.value = "ok";
        const rows12 = (await pool.query(`SELECT id, status FROM deferred_ghl_enrollments WHERE ghl_contact_id=$1 AND workflow_key='booking_confirmation'`, [p12.ghl])).rows;
        check(rows12.length === 1 && rows12[0].id === `${p12.ghl}::booking_confirmation::${b12.appointmentId}` && rows12[0].status === "pending",
          "C: a transient provider failure during the handoff creates exactly one pending obligation, scoped to the appointment occurrence (no second unscoped row)");
        const c12 = await deliverFixed("canceled", { eventId: `h6c3-${run}-c2-cancel`, locationId: "loc_cert_fake", appointmentId: b12.appointmentId, contactId: p12.ghl, calendarId: "cal_x", dateUpdated: t(7) }, webhookHandlers.handleAppointmentCanceled);
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p12.ghl]);
        const w12 = wf.length;
        await retryDeferredEnrollments();
        check(c12.decision === "applied" && (await pool.query(`SELECT 1 FROM deferred_ghl_enrollments WHERE ghl_contact_id=$1`, [p12.ghl])).rowCount === 0
          && wf.slice(w12).filter(w => w.url.includes(p12.ghl)).length === 0,
          "C: cancelling that occurrence leaves zero owed booking confirmations and recovery sends nothing for it");

        // 13. recovery: provider accepts, then the local retirement fails. The retry must not send again.
        await setPause(true);
        const p13 = await mkPair();
        await deliverFixed("booked", bookedBody(p13.ghl, "c1-retire"), webhookHandlers.handleAppointmentBooked);
        await setPause(false);
        const due13 = () => pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p13.ghl]);
        await due13();
        const realConnect = pool.connect.bind(pool);
        let retirementFailures = 0;
        (pool as any).connect = async (...a: any[]) => {
          if (typeof a[0] === "function") return (realConnect as any)(...a);
          const c = await (realConnect as any)(...a);
          const q = c.query.bind(c);
          c.query = (...qa: any[]) => {
            const text = typeof qa[0] === "string" ? qa[0] : qa[0]?.text ?? "";
            if (/^\s*DELETE FROM deferred_ghl_enrollments/.test(text) && retirementFailures === 0) { retirementFailures++; return Promise.reject(new Error("injected retirement failure")); }
            return q(...qa);
          };
          return c;
        };
        const w13 = wf.length;
        try { await retryDeferredEnrollments(); } finally { (pool as any).connect = realConnect; }
        const ledger13 = (await pool.query(`SELECT state FROM ghl_workflow_handoff_dispatches WHERE ghl_contact_id=$1`, [p13.ghl])).rows[0]?.state;
        check(retirementFailures === 1 && wf.slice(w13).filter(w => w.url.includes(p13.ghl)).length === 1 && ledger13 === "accepted" && (await deferredRow(p13.ghl))?.status === "pending",
          "C: a provider acceptance followed by a failed local retirement is recorded as accepted in the dispatch ledger while the obligation stays pending");
        await due13();
        await retryDeferredEnrollments();
        check(wf.slice(w13).filter(w => w.url.includes(p13.ghl)).length === 1 && !(await deferredRow(p13.ghl))
          && (await pool.query(`SELECT 1 FROM audit_logs WHERE action='ghl_enrollment_recovery_already_accepted' AND entity_key=$1`, [p13.ghl])).rowCount === 1,
          "C: the next recovery attempt retires the obligation from the ledger and sends no second enrollment");

        // 14. recovery: provider accepts, then the process stops before settling or retiring. Never re-sent; parked as unknown.
        await setPause(true);
        const p14 = await mkPair();
        await deliverFixed("booked", bookedBody(p14.ghl, "c1-crash"), webhookHandlers.handleAppointmentBooked);
        await setPause(false);
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p14.ghl]);
        const realQuery14 = pool.query.bind(pool);
        const realConnect14 = pool.connect.bind(pool);
        (pool as any).query = (...args: any[]) => {
          const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
          if (/UPDATE ghl_workflow_handoff_dispatches SET state = \$2/.test(text) && args[1]?.[1] === "accepted") return Promise.reject(new Error("injected stop before settle"));
          return realQuery14(...(args as [any]));
        };
        (pool as any).connect = async (...a: any[]) => {
          if (typeof a[0] === "function") return (realConnect14 as any)(...a);
          const c = await (realConnect14 as any)(...a);
          const q = c.query.bind(c);
          c.query = (...qa: any[]) => {
            const text = typeof qa[0] === "string" ? qa[0] : qa[0]?.text ?? "";
            if (/^\s*DELETE FROM deferred_ghl_enrollments/.test(text)) return Promise.reject(new Error("injected stop before retirement"));
            return q(...qa);
          };
          return c;
        };
        const w14 = wf.length;
        try { await retryDeferredEnrollments(); } finally { (pool as any).query = realQuery14; (pool as any).connect = realConnect14; }
        check(wf.slice(w14).filter(w => w.url.includes(p14.ghl)).length === 1
          && (await pool.query(`SELECT state FROM ghl_workflow_handoff_dispatches WHERE ghl_contact_id=$1`, [p14.ghl])).rows[0]?.state === "started"
          && (await deferredRow(p14.ghl))?.status === "pending",
          "C: an interruption after provider acceptance leaves the dispatch ledger started and the obligation pending");
        await pool.query(`UPDATE deferred_ghl_enrollments SET next_retry_at = now() - interval '1 minute' WHERE ghl_contact_id=$1`, [p14.ghl]);
        await retryDeferredEnrollments();
        const parked14 = (await pool.query(`SELECT status, last_error FROM deferred_ghl_enrollments WHERE ghl_contact_id=$1`, [p14.ghl])).rows[0];
        check(wf.slice(w14).filter(w => w.url.includes(p14.ghl)).length === 1 && parked14?.status === "failed" && /^unknown_outcome:/.test(parked14?.last_error ?? ""),
          "C: the next recovery attempt after that interruption parks an unknown outcome and never sends a second enrollment");
      } finally {
        globalThis.Date = RealDate;
        await setPause(true);
        globalThis.fetch = prevFetch; ghlResponder = prevResponder;
        for (const [k, v] of [["GHL_WORKFLOW_BOOKING_CONFIRM", savedEnv.wf], ["GHL_WORKFLOW_VERIFIED_CHANNELS_BOOKING_CONFIRMATION", savedEnv.ch], ["GHL_PRIVATE_INTEGRATION_TOKEN", savedEnv.tok], ["GHL_LOCATION_ID", savedEnv.loc], ["SMS_ENABLED", savedEnv.sms]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
      void mutationsBefore;
      const enrollSrc = readFileSync("server/services/ghl-workflow-enrollment.ts", "utf8");
      const fnSrc = enrollSrc.slice(enrollSrc.indexOf("export async function enrollInAppointmentWorkflow"), enrollSrc.indexOf("export async function tagContactForInboxOrganization"));
      check(!/setTimeout|unifiedSendEmail|unifiedUpsertContact|addTag\(/.test(fnSrc),
        "C: the appointment handoff has no in-memory reminder timer, no direct email, no contact upsert and no tag write (confirmations and reminders belong to the native workflows)");
    }
  }
}

// ================================================================ A: durable existing-population scope (#2105)
{
  const dispo = async (cid: number) => { const r = (await projRows(cid)).find(x => ["pending", "retry", "processing"].includes(x.state)) ?? (await projRows(cid))[0]; return r ? `${r.export_disposition}/${r.export_reason}` : "none"; };
  await setScope(true);
  const old = new Date("2025-01-01T00:00:00Z");
  const cLinked = await mkContact({ intake: false, recordClass: "production", ghl: `ghl_${run}_scope_linked` });
  const cOldCrm = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cOldCrm, "manual_crm", old);
  const cOldForm = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cOldForm, "website_form", old);
  const cNoSource = await mkContact({ intake: false, recordClass: "production" });
  const cCsv = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cCsv, "csv_import", old);
  const cDisc = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cDisc, "discovery", old);
  const cReg = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cReg, "registry", old); await addIntakeEvidence(cReg, "sunbiz", old); await addIntakeEvidence(cReg, "dbpr", old);
  const cTestLinked = await mkContact({ intake: false, recordClass: "test", ghl: `ghl_${run}_scope_test` });
  const cArchLinked = await mkContact({ intake: false, recordClass: "production", archived: true, ghl: `ghl_${run}_scope_arch` });
  const cDnc = await mkContact({ intake: false, recordClass: "production", ghl: `ghl_${run}_scope_dnc` });
  await pool.query(`UPDATE contacts SET do_not_contact=true WHERE id=$1`, [cDnc]);

  // Classification at enqueue: age grants nothing, source policy does.
  check(await dispo(cLinked) === "none" && (await enqueue(cLinked)).disposition === "linked_update" && await claimable([cLinked]),
    "A: a production contact that already has a GHL id is in scope for updates without any intake evidence");
  check((await enqueue(cOldCrm)).disposition === "current_intake" && (await enqueue(cOldForm)).disposition === "current_intake",
    "A: an unlinked CRM-source contact (manual_crm, website_form) is in scope for a create whatever the date of its source event");
  check((await enqueue(cCsv)).disposition === "current_intake" && (await enqueue(cDisc)).disposition === "current_intake",
    "A: an unlinked production contact from a CSV import or discovery is in scope for a create (created categories, no date condition)");
  check((await enqueue(cNoSource)).disposition === "historical_hold" && (await enqueue(cReg)).disposition === "historical_hold",
    "A: a source-less contact with no lead label and registry/Sunbiz/DBPR contacts stay held");
  check((await enqueue(cTestLinked)).disposition === "test_local_only" && !(await claimable([cTestLinked])),
    "A: a test contact is never exportable, scope or not");
  check((await enqueue(cArchLinked)).disposition !== "linked_update" && !(await claimable([cArchLinked])), "A: an archived contact is never in scope");

  // Sweep: in-scope contacts that have no projection row get one (ordinary worker input); excluded contacts never do; idempotent.
  const cSwLinked = await mkContact({ intake: false, recordClass: "production", ghl: `ghl_${run}_sweep_linked` });
  const cSwCrm = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cSwCrm, "partner_referral", old);
  const cSwCsv = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cSwCsv, "csv_import", old);
  const cSwReg = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cSwReg, "sunbiz", old);
  const cSwNone = await mkContact({ intake: false, recordClass: "production" });
  const cSwTest = await mkContact({ intake: false, recordClass: "demo", ghl: `ghl_${run}_sweep_demo` });
  const blBefore = await authority.getProjectionBacklog();
  check(await convergence.projectionConvergenceNeeded(), "A: un-enrolled in-scope contacts are detected as convergence work");
  await convergence.convergeLegacyProjectionRows();
  const sw = async (cid: number) => (await projRows(cid)).filter(r => r.source_kind === "existing_population").length;
  check(await sw(cSwLinked) === 1 && await sw(cSwCrm) === 1 && await sw(cSwCsv) === 1 && await sw(cSwReg) === 0 && await sw(cSwNone) === 0 && await sw(cSwTest) === 0,
    "A: the sweep enrols exactly the in-scope contacts (linked update, old CRM-source and CSV-import creates) and no registry/source-less/test contact");
  const swRow = (await projRows(cSwLinked))[0]; const swCreate = (await projRows(cSwCrm))[0];
  check(swRow.export_disposition === "linked_update" && swRow.export_reason === "existing_linked_identity"
    && swCreate.export_disposition === "current_intake" && swCreate.export_reason === "existing_crm_source",
    "A: swept rows are persisted as known-GHL-id updates and missing-id creates with their reason");
  const blAfter = await authority.getProjectionBacklog();
  check(blAfter.eligibleLinkedUpdates >= blBefore.eligibleLinkedUpdates && blAfter.eligibleCreates >= blBefore.eligibleCreates + 1,
    "A: the backlog reports eligible linked updates and eligible creates separately");
  await convergence.convergeLegacyProjectionRows();
  check(await sw(cSwLinked) === 1 && await sw(cSwCrm) === 1, "A: a second sweep creates no duplicate rows (idempotent)");
  check(await claimable([cSwLinked]) && await claimable([cSwCrm]), "A: swept rows are claimed by the ordinary worker path");

  // A release of a pre-existing hold for contacts the scope now covers; excluded holds stay.
  await setScope(false);
  const cHold = await mkContact({ intake: false, recordClass: "production", ghl: `ghl_${run}_hold_linked` });
  await enqueue(cHold);
  const cHoldCsv = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cHoldCsv, "csv_import", old); await enqueue(cHoldCsv);
  check((await projRows(cHold))[0].export_disposition === "historical_hold" && !(await claimable([cHold])), "A: with the scope off a linked contact's work is held");
  await setScope(true);
  await convergence.convergeLegacyProjectionRows();
  check((await projRows(cHold))[0].export_disposition === "linked_update" && (await projRows(cHold))[0].export_reason === "existing_linked_identity"
    && (await projRows(cHoldCsv))[0].export_disposition === "current_intake",
    "A: switching the scope on releases the held linked update and the held CSV-import create (both covered by the default categories)");

  // Policy narrowing is by source category, never by age; registry categories cannot be named; switching off demotes open rows.
  await setScope(true, { createSourceCategories: ["website_form", "sunbiz", "registry"] });
  const cNarrow = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cNarrow, "manual_crm", old);
  const cNarrowReg = await mkContact({ intake: false, recordClass: "production" }); await addIntakeEvidence(cNarrowReg, "sunbiz", old);
  check((await enqueue(cNarrow)).disposition === "historical_hold" && (await enqueue(cNarrowReg)).disposition === "historical_hold",
    "A: createSourceCategories narrows the create scope by source, and a registry category can never be named into scope");
  await setScope(false);
  await convergence.convergeLegacyProjectionRows();
  check((await projRows(cSwLinked))[0].export_disposition === "historical_hold" && !(await claimable([cSwLinked])),
    "A: switching the scope off returns open, undispatched exportable rows to the hold without deleting them");
  await setScope(true);
  await convergence.convergeLegacyProjectionRows();
  check((await projRows(cSwLinked))[0].export_disposition === "linked_update", "A: switching it back on releases them again");
  // suppression is not cleared by scope: the contact flagged do_not_contact stays flagged and in the queue under the same dispatch guards
  check((await pool.query(`SELECT do_not_contact FROM contacts WHERE id=$1`, [cDnc])).rows[0].do_not_contact === true,
    "A: scope never clears a contact's suppression flag");
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
