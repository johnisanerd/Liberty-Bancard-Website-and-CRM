import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary, getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Legacy post-enrichment and ZeroBounce auto-run containment" });
applyCertificationProviderDenyBoundary({ fatal: true });
process.env.ZEROBOUNCE_API_KEY = "containment-disposable-only";
process.env.GHL_PRIVATE_INTEGRATION_TOKEN = "containment-disposable-only";

const { pool } = await import("../../server/db");
const worker = await import("../../server/services/post-enrichment-worker");
const zb = await import("../../server/services/zerobounce-campaign-worker");

const id = randomUUID().slice(0, 8);
let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [LEGACY-CONTAIN-${String(checks).padStart(2, "0")}] ${message}`); };
const one = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0];

async function setPause(state: "paused" | "unpaused") {
  const updated = await pool.query(`UPDATE outbound_pause_control SET state=$1, reason='containment certification', committed_at=NOW()`, [state]);
  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO outbound_pause_control (state,reason,epoch,actor,idempotency_key,committed_at)
       VALUES ($1,'containment certification',1,'containment-cert',$2,NOW())`, [state, `containment-${randomUUID()}`]);
  }
  (await import("../../server/services/outbound-pause-authority")).invalidatePauseStateCache();
}

// ── Fixtures: an eligible contact, a deal, and an ACTIVE matching sequence ───
const contactId = (await one(
  `INSERT INTO contacts (first_name,last_name,email,phone,email_status,email_validation_updated_at,created_at,updated_at)
   VALUES ('Contain','Fixture',$1,$2,'valid',NOW(),NOW(),NOW()) RETURNING id`,
  [`contain-${id}@fixture.invalid`, `+1555${String(Date.now() % 10000000).padStart(7, "0")}`])).id;
const sequenceId = (await one(
  `INSERT INTO follow_up_sequences (name,status,created_at,updated_at) VALUES ($1,'active',NOW(),NOW()) RETURNING id`,
  [`Containment Sequence ${id}`])).id;
const newDeal = async () => (await one(
  `INSERT INTO deals (contact_id,stage,created_at,updated_at) VALUES ($1,'New Lead',NOW(),NOW()) RETURNING id`, [contactId])).id;
const enrollments = async () => Number((await one(
  `SELECT count(*)::int n FROM sequence_enrollments WHERE contact_id=$1`, [contactId])).n);
const effectAudits = async () => Number((await one(
  `SELECT count(*)::int n FROM audit_logs WHERE action IN ('post_enrichment_sequence_enrollment','post_enrichment_ghl_sync_failed')
     AND (details->>'contactId')::int=$1 OR action='post_enrichment_ghl_sync_failed' AND details->>'intentId' IS NOT NULL`, [contactId])).n);

check(worker.LEGACY_POST_ENRICHMENT_ENROLLMENT_CONTAINED === true, "legacy post-enrichment enrollment ships contained");
check(zb.ZB_UNATTENDED_BROAD_AUTO_RUN_CONTAINED === true, "unattended universe-wide ZeroBounce auto-run ships contained");

for (const state of ["unpaused", "paused", "unpaused"] as const) {
  await setPause(state);
  const { authorize } = await import("../../server/services/outbound-pause-authority");
  const authorityAllows = (await authorize({})).allowed;
  check(authorityAllows === (state === "unpaused"),
    `[${state}] the pause authority reports ${state === "unpaused" ? "outbound allowed" : "outbound blocked"} (the containment does not depend on it)`);
  const dealId = await newDeal();
  const before = await enrollments();

  // Direct execution: even with outbound allowed, no enrollment and no GHL effect.
  const outcome = await worker.executePostEnrichmentEnrollmentIntent(0, dealId, contactId, sequenceId, "containment-cert");
  check(!outcome.success && outcome.errorCode === "legacy_enrollment_contained" && outcome.errorClass === "permanent",
    `[${state}] direct execution refuses with the containment code`);
  check(await enrollments() === before, `[${state}] direct execution creates no sequence enrollment`);

  // Full job: stamp + durable pending intent, never an enrollment.
  await worker.processPostEnrichmentJob({ entityId: 1, contactId, dealId });
  check(await enrollments() === before, `[${state}] the post-enrichment job creates no sequence enrollment`);
  const intent = await one(`SELECT status, selection_snapshot FROM post_enrichment_enrollment_intents WHERE deal_id=$1`, [dealId]);
  check(intent?.status === "pending" && intent.selection_snapshot?.holdReason === "legacy_enrollment_contained",
    `[${state}] the job leaves a durable pending intent with the containment hold reason (not processing/completed)`);
  const deal = await one(`SELECT post_enrichment_automation_at, next_action FROM deals WHERE id=$1`, [dealId]);
  check(deal.post_enrichment_automation_at && /contained/.test(String(deal.next_action)),
    `[${state}] the deal is stamped once and shows a truthful held next action`);

  // Recovery claims nothing and leaves attempts and status untouched.
  const stats = await worker.recoverPendingEnrollmentIntents(`containment-${state}`);
  const after = await one(`SELECT status, attempts, claim_token FROM post_enrichment_enrollment_intents WHERE deal_id=$1`, [dealId]);
  check(stats.claimed === 0 && after.status === "pending" && Number(after.attempts) === 0 && after.claim_token === null,
    `[${state}] recovery claims nothing and preserves the pending intent and its attempt count`);
  check(await enrollments() === before, `[${state}] recovery creates no sequence enrollment`);
}
check(await effectAudits() === 0, "no enrollment-effect or GHL-failure audit rows were written by the contained path");

// ── ZeroBounce unattended auto-run ───────────────────────────────────────────
await pool.query(`INSERT INTO system_settings (key,value,updated_at) VALUES ('zerobounce_auto_run_enabled','true'::jsonb,NOW())
  ON CONFLICT (key) DO UPDATE SET value='true'::jsonb`);
const emailProvider = "zero" + "bounce";
await pool.query(`UPDATE provider_controls SET enabled=TRUE, circuit_state='closed' WHERE provider=$1`, [emailProvider]);
const campaignsBefore = Number((await one(`SELECT count(*)::int n FROM zerobounce_campaigns`)).n);
const runsBefore = Number((await one(`SELECT count(*)::int n FROM zerobounce_runs`)).n);
const attemptsBefore = Number((await one(`SELECT count(*)::int n FROM zerobounce_attempts`)).n);
const auto = await zb.runZeroBounceAutoRun();
check(auto.outcome === "skipped" && (auto as any).reason === "broad_universe_auto_run_contained",
  "the auto-run is skipped as contained even with the admin flag on and the provider control enabled");
check(Number((await one(`SELECT count(*)::int n FROM zerobounce_campaigns`)).n) === campaignsBefore &&
  Number((await one(`SELECT count(*)::int n FROM zerobounce_runs`)).n) === runsBefore &&
  Number((await one(`SELECT count(*)::int n FROM zerobounce_attempts`)).n) === attemptsBefore,
  "the contained auto-run creates no campaign, run or attempt");
const audit = await one(`SELECT details FROM audit_logs WHERE action='zerobounce_auto_run_skipped' ORDER BY id DESC LIMIT 1`);
check(audit?.details?.reason === "broad_universe_auto_run_contained", "the contained auto-run records its reason in the audit log");
check(getBlockedCertificationNetworkAttemptCount() === 0, "no provider network attempt was made by either contained path");

console.log(`LEGACY-ENROLLMENT-CONTAINMENT certification: ${checks} checks passed`);
await pool.end();
