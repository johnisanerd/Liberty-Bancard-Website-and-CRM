/**
 * Cohort-independent local linking against real migrated disposable PostgreSQL.
 * No HTTP provider fixtures are needed: all external transport is denied.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import {
  applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount,
} from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "crm automatic relationship certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool,db } = await import("../../server/db");
const {
  processContactLinkAutomationTick,
  getContactLinkAutomationStatus,
  setContactLinkAutomation,
} = await import("../../server/services/contact-link-automation");
const prefix = `cert_crm_links_${randomUUID().replaceAll("-", "")}`;
const KEY = "contact_link_automation_v1";
const actorId = `${prefix}_admin`;
let checks = 0;
const check = (value: unknown, label: string) => { assert(value, label); checks++; };
const {ORIGINAL_ADDRESS_RECEIPT_CLAUSE,CANONICAL_ADDRESS_RECEIPT_CLAUSE}=await import("../../server/services/canonical-address-receipt-contract");
const {assertSystemLinkDatabaseGuard}=await import("../../server/services/commercial-link-authority");
// Verify the complete approved upstream bodies using the exact inverse address
// transform, then ALSO require the current runtime guard. Never bless a live hash.
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
const verify = fs.readFileSync("docs/certification/canonical-enrichment-native-verify.sql", "utf8")
  .replaceAll("md5(p.prosrc)",`md5(replace(replace(p.prosrc,'crm_evidence_identity_v3','crm_evidence_identity_v2'),${quote(CANONICAL_ADDRESS_RECEIPT_CLAUSE)},${quote(ORIGINAL_ADDRESS_RECEIPT_CLAUSE)}))`)
  .replaceAll("6868a6d639a3fd0af7a10346821dad19","3ee7b8798d9dce2f2c6e92ef91c51c7e");
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV, REPLIT_DEPLOYMENT: process.env.REPLIT_DEPLOYMENT,
  RELEASE_SHA: process.env.RELEASE_SHA, SFP_PUBLISH_ARTIFACT_SHA: process.env.SFP_PUBLISH_ARTIFACT_SHA,
  SFP_PUBLISH_BUILD_ID: process.env.SFP_PUBLISH_BUILD_ID, SFP_PUBLISH_BUILT_AT: process.env.SFP_PUBLISH_BUILT_AT,
};
const base = Date.now() - 120_000;
const first = { sha: "c".repeat(40), id: randomUUID(), at: new Date(base).toISOString() };
const second = { sha: "d".repeat(40), id: randomUUID(), at: new Date(base + 1000).toISOString() };
function deploy(build: typeof first) {
  // Private disposable-process fixtures, never workspace environment changes.
  process.env.NODE_ENV = "production";
  process.env.REPLIT_DEPLOYMENT = "1";
  process.env.RELEASE_SHA = build.sha;
  process.env.SFP_PUBLISH_ARTIFACT_SHA = build.sha;
  process.env.SFP_PUBLISH_BUILD_ID = build.id;
  process.env.SFP_PUBLISH_BUILT_AT = build.at;
}
async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM provider_operations) provider_operations,
    (SELECT count(*) FROM sequence_enrollments) enrollments,
    (SELECT count(*) FROM communication_events) communications,
    (SELECT count(*) FROM sfp_cohort_runs) cohort_runs,
    (SELECT count(*) FROM sfp_cohort_members) cohort_members,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY provider) FROM provider_controls p) provider_controls`)).rows[0];
}
async function fixture(label: string) {
  const name = `${prefix} ${label}`;
  const place = `${prefix}_${label}_place`;
  const contact = (await pool.query(`INSERT INTO contacts
    (first_name,last_name,email,phone,company_name,record_class)
    VALUES('Automatic','Fixture',$1,'',$2,'production') RETURNING id`,
    [`${prefix}.${label}@example.invalid`, `${name} LLC`])).rows[0];
  const business = (await pool.query(`INSERT INTO businesses
    (canonical_name,normalized_name,record_class,google_place_id)
    VALUES($1,$2,'canonical',$3) RETURNING id`, [name, name.replaceAll(" ", ""), place])).rows[0];
  await pool.query(`INSERT INTO canonical_source_links
    (business_id,source_system,source_type,stable_key) VALUES($1,'google_maps','place',$2)`,
    [business.id, place]);
  await pool.query(`INSERT INTO contact_source_events
    (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
    VALUES($1,$2,'import','google_maps_outscraper',$2,'system',$3,$4::jsonb)`,
    [contact.id, `${prefix}_${label}_event`, prefix, JSON.stringify({ place_id: place })]);
  return { contactId: Number(contact.id), businessId: Number(business.id) };
}
async function decisionCount(contactId: number) {
  return Number((await pool.query(`SELECT count(*) n FROM contact_business_link_decisions
    WHERE contact_id=$1 AND decision='verified' AND superseded_at IS NULL`, [contactId])).rows[0].n);
}
try {
  // The shared disposable launcher supplies a build identity for the other
  // cases. This case deliberately starts without one before selecting first.
  for(const key of ["RELEASE_SHA","SFP_PUBLISH_ARTIFACT_SHA","SFP_PUBLISH_BUILD_ID","SFP_PUBLISH_BUILT_AT"])
    delete process.env[key];
  const guard = (await pool.query(verify)).rows[0];
  check(Object.values(guard).every(v => v === true), "Real migrated native guards required");
  await assertSystemLinkDatabaseGuard(db);
  check(await getContactLinkAutomationStatus() === null, "Fresh database has no operator program");
  const baseline = await counts();
  check(baseline.cohort_runs === "0" && baseline.cohort_members === "0", "No historical/frozen cohort fixture");
  await assert.rejects(processContactLinkAutomationTick(), /DEPLOYMENT_IDENTITY_UNVERIFIED/); checks++;
  check(await getContactLinkAutomationStatus() === null, "Unverified deployment cannot initialize work");
  await pool.query("INSERT INTO users(id,email,first_name,last_name,role) VALUES($1,$2,'Automatic','Admin','admin')",
    [actorId, `${actorId}@example.invalid`]);
  const supported = await fixture("supported");
  deploy(first);
  // Missing native authority fails before creating an automatic program.
  await pool.query("ALTER TABLE contact_business_link_decisions DISABLE TRIGGER contact_business_link_review_contract");
  await assert.rejects(processContactLinkAutomationTick(), /DATABASE_GUARD_MISSING/); checks++;
  check(await getContactLinkAutomationStatus() === null, "Native repair automatically unblocks, not initializes while missing");
  await pool.query("ALTER TABLE contact_business_link_decisions ENABLE TRIGGER contact_business_link_review_contract");
  const applied = await processContactLinkAutomationTick();
  check(applied.ran === true, "Routine tick initializes without manual approval or a cohort");
  check(await decisionCount(supported.contactId) === 1, "Supported no-website identity commits through the real native trigger");
  const state = await getContactLinkAutomationStatus();
  check(state?.enabled === true && state.committed === 1, "Committed outcomes, not cursor-only progress");
  check(state.leaseToken === null && state.leaseUntil === null, "Lease released after commit");
  check(state.authorizedBy.startsWith("system:canonical_contact_links_owner_epoch_"), "Not a fabricated human review");
  const replay = await processContactLinkAutomationTick();
  check(replay.ran === true && await decisionCount(supported.contactId) === 1, "Incremental replay has no duplicate decision");
  check((await getContactLinkAutomationStatus())?.committed === 1, "Replay does not inflate committed count");
  const disabled = await setContactLinkAutomation(false, actorId);
  const ownerBeforeOff = (await pool.query("SELECT owner_epoch,owner_token,lease_expires_at FROM sfp_runtime_owner_authority")).rows;
  assert.deepEqual(await processContactLinkAutomationTick(), { ran: false }); checks++;
  assert.deepEqual((await pool.query("SELECT owner_epoch,owner_token,lease_expires_at FROM sfp_runtime_owner_authority")).rows,
    ownerBeforeOff); checks++;
  check((await getContactLinkAutomationStatus())?.enabled === false, "Explicit off survives routine ticks");
  // Existing disabled programs cannot be overwritten by default initialization.
  await pool.query(`UPDATE system_settings SET value=jsonb_set(value,'{rule}','"independent_guarded_system_links_v1"')
    WHERE key=$1`, [KEY]);
  assert.deepEqual(await processContactLinkAutomationTick(), { ran: false }); checks++;
  const upgraded = await getContactLinkAutomationStatus();
  check(upgraded?.enabled === false && upgraded.authorizedBy === disabled.authorizedBy, "Rule migration preserves operator hold");
  await setContactLinkAutomation(true, actorId);
  // A live worker lease cannot be stolen, even by another routine tick.
  const leaseToken = randomUUID();
  await pool.query(`UPDATE system_settings SET value=value ||
    jsonb_build_object('leaseToken',$2::text,'leaseUntil',(NOW()+INTERVAL '1 minute')::text) WHERE key=$1`,
    [KEY, leaseToken]);
  assert.deepEqual(await processContactLinkAutomationTick(), { ran: false }); checks++;
  check((await getContactLinkAutomationStatus())?.leaseToken === leaseToken, "Live token-fenced lease preserved");
  await pool.query(`UPDATE system_settings SET value=value ||
    jsonb_build_object('leaseUntil',(NOW()-INTERVAL '1 second')::text) WHERE key=$1`, [KEY]);
  check((await processContactLinkAutomationTick()).ran === true, "Expired local claim recovers automatically");
  check((await getContactLinkAutomationStatus())?.leaseToken === null, "Recovery releases only current claim");
  const unbound=(await pool.query(`INSERT INTO contacts
    (first_name,last_name,email,phone,company_name,record_class)
    SELECT 'Unresolved','Batch',$1||n::text||'@example.invalid','','','production'
      FROM generate_series(1,51) n RETURNING id`,[`${prefix}.batch.`])).rows;
  // This assertion is about a full changed page, not the preceding unchanged
  // raw IDs from an earlier pass.
  await pool.query(`UPDATE system_settings SET value=value ||
    jsonb_build_object('cursor',$2::int,'complete',false) WHERE key=$1`,
    [KEY,Number(unbound[0].id)-1]);
  const beforeBatch=(await getContactLinkAutomationStatus())!;
  await assert.rejects(processContactLinkAutomationTick({maxPages:201}),
    /CONTACT_LINK_AUTOMATION_INVALID_TICK_BUDGET/);checks++;
  const bounded=await processContactLinkAutomationTick({maxPages:1});
  const firstPage=(await getContactLinkAutomationStatus())!;
  check(bounded.ran && firstPage.scanned-beforeBatch.scanned===25 && !firstPage.complete,
    "A reduced execution budget preserves the exact unprocessed keyset tail");
  await processContactLinkAutomationTick();
  const drained=(await getContactLinkAutomationStatus())!;
  check(drained.scanned-firstPage.scanned===26 && drained.complete,
    "Default tick processes multiple real pages without waiting for another schedule");
  check(drained.cursor===Number(unbound.at(-1).id),"Multi-page linking records the real final contact, not a fabricated cursor");
  check(drained.committed===1,"Read-only unresolved coverage does not fabricate relationships");

  // Continue the saved completed-backfill program across unchanged pages.
  // Exact window and run identity survive process/tick boundaries.
  const window=(await pool.query("SELECT clock_timestamp()::text value")).rows[0].value;
  await pool.query(`UPDATE system_settings SET value=value || jsonb_build_object(
    'cursor',$2::int,'complete',false,'backfillComplete',true,'changedSince',$3::text,
    'scanStartedAt',$3::text) WHERE key=$1`,[KEY,Number(unbound[0].id)-1,window]);
  const incrementalBefore=(await getContactLinkAutomationStatus())!;
  await processContactLinkAutomationTick({maxPages:1});
  const unchangedPage=(await getContactLinkAutomationStatus())!;
  check(unchangedPage.cursor===Number(unbound[24].id) && !unchangedPage.complete,
    "Actual worker advances unchanged IDs without premature completion");
  check(unchangedPage.scanned===incrementalBefore.scanned && unchangedPage.held===incrementalBefore.held,
    "Inspected IDs are neither assignment attempts nor holds");
  check(unchangedPage.changedSince===window && unchangedPage.runId===incrementalBefore.runId &&
    unchangedPage.backfillComplete===true,"Saved incremental identity/window/backfill preserved");
  const late=await fixture("incremental_late");
  await processContactLinkAutomationTick({maxPages:1});
  const resumed=(await getContactLinkAutomationStatus())!;
  check(resumed.cursor===Number(unbound[49].id) && !resumed.complete && resumed.changedSince===window,
    "A new tick resumes the exact raw-ID checkpoint and change window");
  await processContactLinkAutomationTick();
  check(await decisionCount(late.contactId)===1,"Later changed contact commits after unchanged pages");
  check((await getContactLinkAutomationStatus())!.complete,"Only exhausted population completes");

  // Real graph contention and queued owner renewal. The automatic writer must
  // pin owner authority BEFORE waiting for the commercial graph, then retain
  // its fresh snapshot recheck after acquiring that graph.
  const ordered=await fixture("owner_order");
  const {previewContactBusinessSystemLinks,applyContactBusinessSystemLink}=
    await import("../../server/services/contact-business-system-links");
  const {lockCurrentSfpRuntimeOwner,renewSfpRuntimeDeploymentOwner}=
    await import("../../server/services/cro03/sfp-provider-operations");
  const orderedPreview=await previewContactBusinessSystemLinks({afterContactId:ordered.contactId-1,limit:1});
  const orderedCandidate=orderedPreview.rows.find(row=>row.contactId===ordered.contactId)!;
  check(orderedCandidate?.eligible,"Concurrent lock-order fixture has genuine independent source evidence");
  const peer=await pool.connect();
  let signalOwner!:()=>void;
  const ownerPinned=new Promise<void>(resolve=>{signalOwner=resolve;});
  let applying:ReturnType<typeof applyContactBusinessSystemLink>|undefined;
  let renewing:ReturnType<typeof renewSfpRuntimeDeploymentOwner>|undefined;
  let guardCalls=0;
  try {
    await peer.query("BEGIN");
    await peer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1700))",
      [`cro02:v1:node:contact:${ordered.contactId}`]);
    applying=applyContactBusinessSystemLink({
      ...orderedCandidate,actorId,role:"admin",
    },async tx=>{
      await lockCurrentSfpRuntimeOwner(tx);
      guardCalls++;signalOwner();return true;
    });
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([ownerPinned,applying.then(result=>{
        throw new Error(`OWNER_PIN_APPLY_ENDED:${result.status}:${"code" in result ? result.code : ""}`);
      }),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error("OWNER_NOT_PINNED_BEFORE_GRAPH_WAIT")),10000);
      })]);
    } finally {if (timer) clearTimeout(timer);}
    renewing=renewSfpRuntimeDeploymentOwner();
    let renewalQueued=false;
    for (let attempt=0;attempt<100;attempt++) {
      // Use a fresh autocommit stats snapshot, not the graph-holder's cached
      // transaction snapshot taken before renewal entered the wait queue.
      const waiting=(await pool.query(`SELECT count(*)::int n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%UPDATE sfp_runtime_owner_authority%'`)).rows[0].n;
      if (waiting>0) {renewalQueued=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    check(renewalQueued,"Actual renewal is waiting on the owner pinned by the graph-blocked native writer");
    await peer.query("COMMIT");
    const [linked]=await Promise.all([applying,renewing]);
    check(linked.status==="applied" && guardCalls>=2,
      "Owner-before-graph ordering completes with a queued renewal and preserves the final authority recheck");
    check(await decisionCount(ordered.contactId)===1,"Concurrent owner/graph test commits exactly one native relationship");
  } finally {
    await peer.query("ROLLBACK").catch(()=>undefined);
    peer.release();
    await Promise.allSettled([applying,renewing].filter(Boolean));
  }
  // Each consecutive eligible ordinary cycle must commit its own newly
  // supported relationship, not just repeat a heartbeat or drain one batch.
  for(let cycle=0;cycle<3;cycle++){
    const next=await fixture(`ordinary_cycle_${cycle}`);
    const before=(await getContactLinkAutomationStatus(false))!;
    check((await processContactLinkAutomationTick()).ran===true,"Eligible ordinary cycle ran");
    check(await decisionCount(next.contactId)===1,"Each ordinary cycle committed its supported contact");
    check((await getContactLinkAutomationStatus(false))!.committed===before.committed+1,
      "Cycle progress measures a new committed decision");
  }
  // Execute the real existing serial processor, without starting unrelated
  // workers or changing production schedules, controls or provider transports.
  const {QueueManager,QUEUE_NAMES}=await import("../../server/services/queue-manager");
  const serialSupported=await fixture("serial_local_continuation");
  const serialProcessor=(new QueueManager() as any).buildProcessor(QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY,{});
  await serialProcessor({id:`${prefix}.serial`,name:"tick",data:{}});
  check(await decisionCount(serialSupported.contactId)===1,
    "The existing serial local recovery processor commits its supported relationship");
  check((await getContactLinkAutomationStatus(false))!.leaseToken===null,
    "The serial continuation releases only its own linking lease");
  const {readContactLinkAssignmentPopulation}=await import("../../server/services/contact-link-population");
  const population=await readContactLinkAssignmentPopulation();
  check(population.state==="current" && population.currentVerified===7,
    "Current audited population is separate from cumulative attempts");
  await pool.query("ALTER FUNCTION crm_source_family_relationship_reasons(integer,integer,uuid) RENAME TO cert_missing_source_family");
  try {
    const unavailable=await readContactLinkAssignmentPopulation();
    check(unavailable.state==="unavailable" && unavailable.currentVerified===null && unavailable.totalActiveProduction===null,
      "Missing native authority is unavailable, never a healthy zero");
  } finally {
    await pool.query("ALTER FUNCTION cert_missing_source_family(integer,integer,uuid) RENAME TO crm_source_family_relationship_reasons");
  }
  deploy(second);
  check((await processContactLinkAutomationTick()).ran === true, "Published successor takes over existing program");
  const afterTransfer = await getContactLinkAutomationStatus(false);
  deploy(first);
  await assert.rejects(processContactLinkAutomationTick(), /RETIRED_BUILD/); checks++;
  assert.deepEqual(await getContactLinkAutomationStatus(false), afterTransfer); checks++;
  deploy(second);
  await pool.query("UPDATE sfp_runtime_owner_authority SET revoked_at=clock_timestamp()");
  await assert.rejects(processContactLinkAutomationTick(), /OWNER_REVOKED/); checks++;
  assert.deepEqual(await getContactLinkAutomationStatus(false), afterTransfer); checks++;
  assert.deepEqual(await counts(), baseline); checks++;
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider/network attempts");
  check(Object.values((await pool.query(verify)).rows[0]).every(v => v === true), "Native fingerprints unchanged");
  const receipt = {
    observedAt: new Date().toISOString(), checks, scope: "Disposable real-DB automatic relationship linking only",
    cohortIndependent: true, automaticNativeRepairRecovery: true, noWebsiteIdentityCommitted: true,
    explicitOffPreserved: true, ruleUpgradePreservesOff: true, claimAndReplaySafe: true,
    currentPublishedOwnerRequired: true, retiredBuildDenied: true, revokedOwnerDenied: true,
    boundedMultiPageTraversal: true, exactUnprocessedTailPreserved: true,
    ownerBeforeGraphWithQueuedRenewal: true,
    threeConsecutiveEligibleOrdinaryCycles: true,
    currentPopulationSeparateFromAttempts:true,unavailableNativeIsNotZero:true,
    providerEnrollmentCommunicationAndCohortCountsUnchanged: true, externalNetworkAttempts: 0,
    nativeFingerprintsUnchanged: true, productionExecution: false, taskComplete: false,
  };
  fs.writeFileSync("docs/certification/canonical-enrichment-contact-link-automation-test.json",
    JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await pool.end();
}