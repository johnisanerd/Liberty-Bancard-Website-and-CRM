import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "recipient preparation lane reservation certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool } = await import("../../server/db");
const { prepareCanonicalRecipient } = await import("../../server/services/canonical-recipient-preparation");
const { processValidationIntent } = await import("../../server/services/provider-readiness-control");
const { previewContactBusinessSystemLinks, applyContactBusinessSystemLink } =
  await import("../../server/services/contact-business-system-links");
const { processCanonicalRecipientPreparationTick, preparationLaneDeadline, PREPARATION_LANE_RESERVES } =
  await import("../../server/services/canonical-recipient-preparation-worker");
const prefix = `cert_lane_reserve_${randomUUID().replaceAll("-", "")}`;
const actor = { role: "admin" as const, actorId: `system:${prefix}`, email: null };
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };

// ---- Pure scheduling rule: every overrun shape still leaves both fair-share lanes their window. ----
const T = 1_000_000;
const reserves = { priorityReserveMs: 25_000, populationReserveMs: 15_000 };
const passDeadline = T + 90_000 + reserves.priorityReserveMs + reserves.populationReserveMs;
const lane = (name: any, now: number, capMs: number, deadline = passDeadline) =>
  preparationLaneDeadline(name, { now, passDeadline: deadline, capMs, ...reserves });
check(lane("completion", T, 30_000) === T + 30_000, "Completion keeps its ordinary 30s cap when time is plentiful");
check(lane("stale", T + 30_000, 90_000) === passDeadline - 40_000, "Stale lane stops where the reserved lanes begin");
check(lane("population", T + 100_000, 45_000) === T + 100_000 + 15_000 && lane("population", T + 100_000, 45_000) >= T + 115_000,
  "A lane that starts after a stale overrun still gets its population reserve");
check(lane("priority", passDeadline + 60_000, 50_000) === passDeadline + 60_000 + 25_000,
  "Priority keeps its full reserve even when earlier lanes ran past the entire pass");
check(lane("completion", passDeadline + 5_000, 30_000) < passDeadline + 5_000,
  "Completion/stale never start new work once only the reserved time remains");
check(lane("priority", T + 40_000, 50_000) === T + 90_000, "Priority uses its normal cap when the pass is on schedule");
check(PREPARATION_LANE_RESERVES.priorityMs > 0 && PREPARATION_LANE_RESERVES.populationMs > 0, "Production reserves are non-zero");

// ---- Real worker: completion backlog must not consume the priority lane. ----
async function fixture() {
  const label = randomUUID().replaceAll("-", "");
  const place = `${prefix}_${label}_place`;
  const business = (await pool.query(`INSERT INTO businesses
    (canonical_name,normalized_name,record_class,google_place_id,vertical,city,state,postal_code)
    VALUES($1,$2,'canonical',$3,'Automotive','Miami','FL','33130') RETURNING *`,
    [`${prefix} ${label}`, `${prefix}${label}`, place])).rows[0];
  await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key)
    VALUES($1,'google_maps','place',$2)`, [business.id, place]);
  const contact = (await pool.query(`INSERT INTO contacts
    (first_name,last_name,email,phone,company_name,record_class)
    VALUES('Lane','Fixture',$1,'',$2,'production') RETURNING id`,
    [`${prefix.slice(0, 30)}.${label.slice(0, 24)}@gmail.com`, `${business.canonical_name} LLC`])).rows[0];
  await pool.query(`INSERT INTO contact_source_events
    (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
    VALUES($1,$2,'import','google_maps_outscraper',$2,'system',$3,$4::jsonb)`,
    [contact.id, `${prefix}_${label}_event`, actor.actorId, JSON.stringify({ place_id: place })]);
  const preview = await previewContactBusinessSystemLinks({ afterContactId: Number(contact.id) - 1, limit: 1 });
  const candidate = preview.rows[0];
  check(candidate?.eligible, "Fixture has independent stable evidence");
  const outcome = await applyContactBusinessSystemLink({
    contactId: Number(contact.id), businessId: Number(business.id),
    sourceLinkId: candidate.sourceLinkId!, sourceEntityId: candidate.sourceEntityId, snapshotHash: candidate.snapshotHash,
  });
  check(outcome.status === "applied", "Real reviewed relationship writer");
  return Number(contact.id);
}
const { claimSfpRuntimeDeploymentOwner } = await import("../../server/services/cro03/sfp-provider-operations");
try {
  // Private disposable published identity; never touches workspace environment or deployed data.
  process.env.NODE_ENV = "production";
  process.env.REPLIT_DEPLOYMENT = "1";
  process.env.RELEASE_SHA = "f".repeat(40);
  process.env.SFP_PUBLISH_ARTIFACT_SHA = process.env.RELEASE_SHA;
  process.env.SFP_PUBLISH_BUILD_ID = randomUUID();
  process.env.SFP_PUBLISH_BUILT_AT = new Date().toISOString();
  await claimSfpRuntimeDeploymentOwner();
  const programId = randomUUID();
  await pool.query(`INSERT INTO sfp_programs(id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
    VALUES($1,$2,ARRAY['12086'],ARRAY['Automotive'],2,TRUE,$3)`, [programId, prefix, actor.actorId]);
  const sequenceId = Number((await pool.query(`INSERT INTO follow_up_sequences
    (name,status,trigger_type,trigger_config) VALUES($1,'paused','contact_created',$2::jsonb) RETURNING id`,
    [prefix, JSON.stringify({ canonicalProgramId: programId, canonicalVerticals: ["Automotive"] })])).rows[0].id);
  await pool.query("UPDATE provider_controls SET enabled=TRUE,circuit_state='closed' WHERE provider='zerobounce'");
  const BACKLOG = Number(process.env.LANE_RESERVE_BACKLOG ?? 40);
  const answered: number[] = [];
  for (let i = 0; i < BACKLOG; i++) {
    const contactId = await fixture();
    await prepareCanonicalRecipient({ contactId, sequenceId, programId, actor, source: prefix });
    const intent = (await pool.query("SELECT id FROM validation_intents WHERE contact_id=$1", [contactId])).rows[0];
    check(await processValidationIntent(intent.id, { verifyEmail: async () => ({
      provider: "zerobounce", status: "valid", verifiedAt: new Date().toISOString(), outcome: "completed" }) }) === "completed",
      "Injected receipt stores a definite answer against the pending recipient");
    answered.push(contactId);
  }
  const pendingAnswered = async () => Number((await pool.query(`SELECT count(DISTINCT i.contact_id)::int n
    FROM cr04_enrollment_intents i JOIN provider_observations po ON po.provider='zerobounce'
      AND po.email_token_hash=i.normalized_email_hash AND po.retryable=FALSE AND po.outcome IN ('valid','invalid')
    WHERE i.program_id=$1 AND i.preparation_state='pending_validation'`, [programId])).rows[0].n);
  const priorityScanned = async () => Number((await pool.query(`SELECT value->'priority'->>'scanned' v
    FROM system_settings WHERE key='canonical_recipient_preparation_cursor'`)).rows[0]?.v ?? 0);
  // Late-ID recipients (bound, never prepared) that only a priority/population pass can reach.
  const late: number[] = [];
  for (let i = 0; i < 6; i++) late.push(await fixture());
  check(await pendingAnswered() === BACKLOG, "Completion lane starts with a real backlog of answered recipients");

  // Control: the previous behaviour (no reserve) lets the completion lane spend the whole short pass.
  const control = await processCanonicalRecipientPreparationTick(
    { passBaseMs: 1_000, priorityReserveMs: 0, populationReserveMs: 0, maxPopulationPages: 1 });
  const remainingAfterControl = await pendingAnswered();
  check(control.ran && (control as any).completion?.examined > 0 && remainingAfterControl > 0,
    "Control pass worked the completion lane and left it backlogged");
  check((control as any).priority?.examined === 0 && await priorityScanned() === 0,
    "Without a reservation the priority lane receives no window while completion is backlogged (the observed starvation)");

  // Fix: same pass length and same backlog, but the priority lane keeps its reserved window.
  const fixed = await processCanonicalRecipientPreparationTick(
    { passBaseMs: 1_000, priorityReserveMs: 6_000, populationReserveMs: 1_000, maxPopulationPages: 1 });
  const remainingAfterFixed = await pendingAnswered();
  check(fixed.ran && (fixed as any).priority?.examined > 0 && await priorityScanned() > 0,
    "With the reservation the priority lane examines contacts and advances its scanned/cursor state in the same backlogged pass");
  check((fixed as any).completion?.examined < remainingAfterControl,
    "The completion lane alone could not drain its backlog in its window: priority advanced while that lane was backlogged");
  check(remainingAfterFixed < remainingAfterControl, "Backlogged recipients still progressed (priority/population also revisit them)");
  check((fixed as any).completion?.examined > 0, "The completion lane still made its own progress (no lane lost its share)");
  check((fixed as any).examined > 0, "The population lane still made progress");

  // Everything converges and no lane's work is skipped permanently.
  for (let tick = 0; tick < 40 && (await pendingAnswered()) > 0; tick++) {
    await processCanonicalRecipientPreparationTick({ passBaseMs: 1_000, priorityReserveMs: 6_000, populationReserveMs: 1_000 });
  }
  check(await pendingAnswered() === 0, "Completion backlog drains to ready_held across passes");
  const lateStates = (await pool.query(`SELECT count(DISTINCT contact_id)::int n FROM cr04_enrollment_intents
    WHERE contact_id=ANY($1::int[])`, [late])).rows[0].n;
  check(lateStates === late.length, "Late-ID recipients were all reached and prepared");
  const unsafe = (await pool.query(`SELECT
    (SELECT count(*) FROM sequence_enrollments WHERE metadata->>'canonicalPreparationId' IS NOT NULL
       AND (status<>'paused' OR next_action_at IS NOT NULL))::int active,
    (SELECT count(*) FROM communication_events)::int comms`)).rows[0];
  check(unsafe.active === 0 && unsafe.comms === 0, "Reservation grants no sending authority and creates no communications");
  await assert.rejects(processCanonicalRecipientPreparationTick({ priorityReserveMs: -1 }), /INVALID_LANE_RESERVE/);
  checks++;
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider or network attempts");
  console.log(`PASS: ${checks} recipient-preparation lane reservation checks`);
} finally { await pool.end(); }
