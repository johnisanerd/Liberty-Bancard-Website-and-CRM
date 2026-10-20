import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "upload-cohort preparation and path-cost certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool } = await import("../../server/db");
const pg = (await import("pg")).default;
const { prepareCanonicalRecipient } = await import("../../server/services/canonical-recipient-preparation");
const { previewContactBusinessSystemLinks, applyContactBusinessSystemLink } =
  await import("../../server/services/contact-business-system-links");
const { processCanonicalRecipientPreparationTick } =
  await import("../../server/services/canonical-recipient-preparation-worker");
const prefix = `cert_upload_cohort_${randomUUID().replaceAll("-", "")}`;
const actor = { role: "admin" as const, actorId: `system:${prefix}`, email: null };
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };

// ---- Round-trip counter: every statement sent to the database while a block runs. ----
const stat = { n: 0, ms: 0 };
(globalThis as any).__preparationQueryCounter = stat;
const originalQuery = (pg.Client.prototype as any).query;
(pg.Client.prototype as any).query = function patched(this: any, ...args: any[]) {
  stat.n++;
  const startedAt = Date.now();
  const result = originalQuery.apply(this, args);
  if (result && typeof result.then === "function") {
    return result.then((value: any) => { stat.ms += Date.now() - startedAt; return value; },
      (error: any) => { stat.ms += Date.now() - startedAt; throw error; });
  }
  return result;
};
async function measured<T>(work: () => Promise<T>) {
  stat.n = 0; stat.ms = 0;
  const startedAt = Date.now();
  const value = await work();
  return { value, queries: stat.n, dbMs: stat.ms, wallMs: Date.now() - startedAt };
}

type Kind = "eligible" | "geography_held" | "unbound";
async function fixture(kind: Kind, executionId: string | null) {
  const label = randomUUID().replaceAll("-", "");
  const place = `${prefix}_${label}_place`;
  const [city, state, zip, vertical] = kind === "geography_held" ? ["Dallas", "TX", "75201", "Automotive"]
    : kind === "unbound" ? ["Miami", "FL", "33130", "Unmapped Heavy Industry"] : ["Miami", "FL", "33130", "Automotive"];
  const business = (await pool.query(`INSERT INTO businesses
    (canonical_name,normalized_name,record_class,google_place_id,vertical,city,state,postal_code)
    VALUES($1,$2,'canonical',$3,$4,$5,$6,$7) RETURNING *`,
    [`${prefix} ${label}`, `${prefix}${label}`, place, vertical, city, state, zip])).rows[0];
  await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key)
    VALUES($1,'google_maps','place',$2)`, [business.id, place]);
  const contact = (await pool.query(`INSERT INTO contacts
    (first_name,last_name,email,phone,company_name,record_class)
    VALUES('Cohort','Fixture',$1,'',$2,'production') RETURNING id`,
    [`${prefix.slice(0, 30)}.${label.slice(0, 24)}@gmail.com`, `${business.canonical_name} LLC`])).rows[0];
  await pool.query(`INSERT INTO contact_source_events
    (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata,import_execution_id)
    VALUES($1,$2,'import','google_maps_outscraper',$2,'system',$3,$4::jsonb,$5)`,
    [contact.id, `${prefix}_${label}_event`, actor.actorId, JSON.stringify({ place_id: place }), executionId]);
  const preview = await previewContactBusinessSystemLinks({ afterContactId: Number(contact.id) - 1, limit: 1 });
  const candidate = preview.rows[0];
  check(candidate?.eligible, `Fixture (${kind}) has independent stable evidence`);
  const outcome = await applyContactBusinessSystemLink({
    contactId: Number(contact.id), businessId: Number(business.id),
    sourceLinkId: candidate.sourceLinkId!, sourceEntityId: candidate.sourceEntityId, snapshotHash: candidate.snapshotHash,
  });
  check(outcome.status === "applied", `Real reviewed relationship writer (${kind})`);
  return Number(contact.id);
}
async function importExecution(status = "completed", completedAt = "NOW()") {
  const id = randomUUID();
  await pool.query(`INSERT INTO import_executions(id,import_type,file_hash,status,total_rows,execution_key,actor_type,actor_id,started_at,completed_at)
    VALUES($1,'csv_contact',$2,$3,10,$4,'system',$5,NOW(),${completedAt})`,
    [id, `${prefix}${id}`.slice(0, 64), status, `${prefix}:${id}`, actor.actorId]);
  return id;
}
const cursorValue = async () => (await pool.query(
  `SELECT value FROM system_settings WHERE key='canonical_recipient_preparation_cursor'`)).rows[0]?.value;
const intentsFor = async (ids: number[]) => Number((await pool.query(
  `SELECT count(*)::int n FROM cr04_enrollment_intents WHERE contact_id=ANY($1::int[])`, [ids])).rows[0].n);
const holdReasons = async (ids: number[]) => Object.fromEntries((await pool.query(
  `SELECT entity_key,count(DISTINCT entity_id)::int n FROM audit_logs
    WHERE action='canonical_preparation.upload_cohort_hold' AND entity_id=ANY($1::int[]) GROUP BY 1`, [ids])).rows
  .map((row: any) => [row.entity_key, row.n]));

const { claimSfpRuntimeDeploymentOwner } = await import("../../server/services/cro03/sfp-provider-operations");
try {
  process.env.NODE_ENV = "production";
  process.env.REPLIT_DEPLOYMENT = "1";
  process.env.RELEASE_SHA = "e".repeat(40);
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

  // ---- Cohort membership is by completed contact upload within the window, nothing else. ----
  const execA = await importExecution();
  const oldExec = await importExecution("completed", "NOW() - INTERVAL '90 days'");
  const failedExec = await importExecution("failed");
  const outsiders = [await fixture("eligible", oldExec), await fixture("eligible", failedExec), await fixture("eligible", null)];

  // Phase A: only no-write holds in the cohort (the shape of most of the outstanding upload).
  const geoHeld = [] as number[], unbound = [] as number[];
  for (let i = 0; i < 6; i++) geoHeld.push(await fixture("geography_held", execA));
  for (let i = 0; i < 4; i++) unbound.push(await fixture("unbound", execA));
  // Control: the same kind of contact through the writer directly (no page pre-screen), outside the cohort.
  const control = [] as number[];
  for (let i = 0; i < 6; i++) control.push(await fixture("geography_held", null));

  const before = await cursorValue();
  const controlRun = await measured(async () => {
    const reasons = [] as string[];
    for (const contactId of control) {
      const result: any = await prepareCanonicalRecipient({ contactId, sequenceId, programId, actor, source: prefix });
      reasons.push(result.reasonCode);
    }
    return reasons;
  });
  check(controlRun.value.every(reason => reason === "CURRENT_GEOGRAPHY_UNRESOLVED_OR_EXCLUDED"),
    "The writer itself holds out-of-territory contacts with CURRENT_GEOGRAPHY_UNRESOLVED_OR_EXCLUDED (parity with the page screen)");

  const phaseA = await measured(() => processCanonicalRecipientPreparationTick({ uploadCohortOnly: true, cohortBudgetMs: 120_000 }));
  const a: any = phaseA.value;
  check(a.ran && a.uploadCohortOnly, "Cohort-only run claims the shared lease and runs");
  check(a.uploadCohort.examined === 10 && a.uploadCohort.prepared === 0 && a.uploadCohort.held === 10,
    "Cohort examined exactly its ten contacts and prepared none; outsiders (old, failed or no upload) were not touched");
  check(await intentsFor(outsiders) === 0, "Contacts outside the completed recent upload window were not examined");
  check(await intentsFor([...geoHeld, ...unbound]) === 0, "No-write holds create no preparation rows");
  const reasonsA = await holdReasons([...geoHeld, ...unbound]);
  check(reasonsA.CURRENT_GEOGRAPHY_UNRESOLVED_OR_EXCLUDED === geoHeld.length,
    "Every out-of-territory contact has a durable hold record naming geography");
  check(reasonsA.NO_CURRENT_PROGRAM_BINDING_OR_AVAILABLE_EMAIL === unbound.length,
    "Every unbound contact has a durable hold record naming the missing program binding");
  const afterA = await cursorValue();
  check((afterA.afterContactId ?? 0) === (before?.afterContactId ?? 0) && (afterA.cycles ?? 0) === (before?.cycles ?? 0)
    && (afterA.priority?.afterContactId ?? 0) === (before?.priority?.afterContactId ?? 0)
    && (afterA.priority?.scanned ?? 0) === (before?.priority?.scanned ?? 0),
    "The population and priority cursors did not move");
  check(a.cohortCycles === 1 && afterA.cohort.afterContactId === 0, "The cohort cursor completed one cycle and reset");
  const perHoldScreened = phaseA.queries / 10;
  const perHoldWriter = controlRun.queries / control.length;
  console.log(JSON.stringify({ profile: "no-write hold, per contact", writerOnly: { queries: perHoldWriter, dbMs: controlRun.dbMs / control.length, wallMs: controlRun.wallMs / control.length },
    pageScreened: { queries: perHoldScreened, dbMs: phaseA.dbMs / 10, wallMs: phaseA.wallMs / 10 } }));
  check(perHoldScreened * 4 < perHoldWriter, `The page screen needs far fewer round trips per held contact (${perHoldScreened.toFixed(1)} vs ${perHoldWriter.toFixed(1)})`);

  // Revisit cooldown: an immediate rerun reads nothing and does not rewrite hold records.
  const holdRowsBefore = Number((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action='canonical_preparation.upload_cohort_hold'`)).rows[0].n);
  const again: any = await processCanonicalRecipientPreparationTick({ uploadCohortOnly: true, cohortBudgetMs: 30_000 });
  check(again.uploadCohort.cooldown === true && again.uploadCohort.examined === 0, "A finished cohort cycle is not re-read inside the revisit window");
  check(Number((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action='canonical_preparation.upload_cohort_hold'`)).rows[0].n) === holdRowsBefore,
    "The cooldown run wrote no hold records");

  // Phase B: a later upload with eligible recipients; open the revisit window explicitly (disposable cursor edit).
  const execB = await importExecution();
  const eligible = [] as number[];
  for (let i = 0; i < 3; i++) eligible.push(await fixture("eligible", execB));
  await pool.query(`UPDATE system_settings SET value=jsonb_set(value,'{cohort,lastCycleAt}','"2020-01-01T00:00:00Z"'::jsonb)
    WHERE key='canonical_recipient_preparation_cursor'`);
  const phaseB = await measured(() => processCanonicalRecipientPreparationTick({ uploadCohortOnly: true, cohortBudgetMs: 120_000 }));
  const b: any = phaseB.value;
  check(b.uploadCohort.prepared === eligible.length, "Eligible cohort recipients commit through the canonical preparation writer");
  check(await intentsFor(eligible) === eligible.length, "Each prepared recipient has its preparation row");
  check(b.uploadCohort.examined === 13 && b.uploadCohort.held === 10,
    "Only never-examined contacts were selected (three new plus the ten no-write holds); none with a row was re-qualified");
  check(Number((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action='canonical_preparation.upload_cohort_hold'
    AND entity_id=ANY($1::int[])`, [[...geoHeld, ...unbound]])).rows[0].n) === 10, "Repeated holds inside 24 hours are recorded once");
  const states = (await pool.query(`SELECT preparation_state,count(*)::int n FROM cr04_enrollment_intents WHERE contact_id=ANY($1::int[]) GROUP BY 1`, [eligible])).rows;
  check(states.length === 1 && states[0].preparation_state === "pending_validation", "Prepared recipients wait for validation; none is ready or sendable");
  check(Number((await pool.query(`SELECT count(*)::int n FROM sequence_enrollments WHERE contact_id=ANY($1::int[])
    AND (status<>'paused' OR next_action_at IS NOT NULL)`, [eligible])).rows[0].n) === 0, "Preparation grants no sending authority");
  console.log(JSON.stringify({ profile: "eligible recipient, per contact", queries: phaseB.queries / eligible.length,
    dbMs: phaseB.dbMs / eligible.length, wallMs: phaseB.wallMs / eligible.length, laneTimingsMs: b.timingsMs?.cohort }));

  {
    const { evaluateCr04ChannelQualification } = await import("../../server/services/cr04-cohort-ready-authority");
    const probe = await fixture("eligible", null);
    const q = await measured(() => evaluateCr04ChannelQualification(probe, { channel: "email", sequenceId, scope: actor, persist: true } as any));
    console.log(JSON.stringify({ profile: "qualification alone (persist)", queries: q.queries, dbMs: q.dbMs, wallMs: q.wallMs }));
  }
  // Ordinary tick still runs and still carries the cohort lane without moving it backwards.
  const ordinary: any = await processCanonicalRecipientPreparationTick({ passBaseMs: 2_000, priorityReserveMs: 3_000, populationReserveMs: 1_000, maxPopulationPages: 1 });
  check(ordinary.ran && ordinary.uploadCohort && typeof ordinary.uploadCohort.examined === "number", "The ordinary tick reports the upload-cohort lane");
  await assert.rejects(processCanonicalRecipientPreparationTick({ uploadCohortOnly: true, cohortBudgetMs: 10 }), /INVALID_COHORT_BUDGET/);
  checks++;
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider or network attempts");
  console.log(`PASS: ${checks} upload-cohort preparation checks`);
} finally { (pg.Client.prototype as any).query = originalQuery; await pool.end(); }
