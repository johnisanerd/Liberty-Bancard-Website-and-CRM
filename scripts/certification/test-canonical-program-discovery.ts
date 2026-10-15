import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {sql} from "drizzle-orm";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount} from "../certification-provider-deny";
await assertDisposableTestInfrastructure({operation:"Canonical program-scoped discovery"});
applyCertificationProviderDenyBoundary({fatal:true});
process.env.OUTSCRAPER_API_KEY="canonical-program-disposable-only";
process.env.APOLLO_API_KEY="canonical-program-disposable-only";
process.env.SERPER_API_KEY="canonical-program-disposable-only";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY="canonical-program-disposable-only";
const {db,pool}=await import("../../server/db");
const {programDiscoverySelection,sfpStageScopeSql,lockSfpStageScope}=
  await import("../../server/services/cro03/sfp-discovery-scope");
const {reserveSfpProviderOperation,invokeSfpProviderTransport,finishSfpProviderOperation,
  assertCurrentSfpProviderReservation,reservePreCohortSfpProviderOperation,
  lockCurrentSfpRuntimeOwner}=await import("../../server/services/cro03/sfp-provider-operations");
const {executeSfpPaidPersonAndIdentityDiscovery,executeSfpSerperDiscovery,processSfpOutscraperRetrievalTask}=
  await import("../../server/services/cro03/sfp-paid-waterfall");
const id=randomUUID(),actor=`canonical-program-${id}`;
const rows=(r:any):any[]=>r?.rows??r??[];
let checks=0,dispatches=0;
const check=(v:unknown,message:string)=>{assert(v,message);checks++;};
// Block the actual quarantine read after owner acquisition. This proves which
// locks remain held, not just what the source code happens to contain.
async function probeReservationLocks<T>(reserve:()=>Promise<T>,label:string,expectFree=true):Promise<T> {
  const blocker=await pool.connect(),probe=await pool.connect();
  let pending:Promise<{value:T}|{error:unknown}>|undefined;
  let earlyResult:{value:T}|{error:unknown}|undefined;
  try {
    const blockerPid=(await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE sfp_identity_quarantines IN ACCESS EXCLUSIVE MODE");
    pending=reserve().then(value=>(earlyResult={value}),error=>(earlyResult={error}));
    let blockedPid:number|null=null;
    const deadline=Date.now()+10_000;
    while(Date.now()<deadline) {
      const waiting=(await probe.query(`SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname=current_database() AND a.wait_event_type='Lock'
          AND $1::integer=ANY(pg_blocking_pids(a.pid)) LIMIT 1`,
        [blockerPid])).rows[0];
      if(waiting){blockedPid=Number(waiting.pid);break;}
      if(earlyResult && "error" in earlyResult) throw earlyResult.error;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    check(blockedPid!==null,`${label}: reached native quarantine lock wait`);
    await probe.query("BEGIN");
    const acquired=(await probe.query(`SELECT pg_try_advisory_xact_lock(
      hashtextextended('routine-sfp-runtime-owner',0)) acquired`)).rows[0].acquired;
    check(acquired===expectFree,`${label}: acquisition advisory lock ${expectFree?"released":"detected"}`);
    if(expectFree) {
      const ownerPin=(await probe.query(`SELECT 1 FROM pg_locks
        WHERE pid=$1 AND relation='sfp_runtime_owner_authority'::regclass
          AND mode='RowShareLock' AND granted`,[blockedPid])).rows;
      check(ownerPin.length>0,`${label}: live owner remains row-pinned`);
      await db.transaction(async tx=>{
        await tx.execute(sql`SET LOCAL statement_timeout='2s'`);
        await lockCurrentSfpRuntimeOwner(tx);
      });
      checks++;
    }
  } finally {
    await Promise.all([blocker.query("ROLLBACK"),probe.query("ROLLBACK")]);
    blocker.release();probe.release();
    if(pending) await pending;
  }
  const result=await pending!;
  if("error" in result) throw result.error;
  return result.value;
}
try {
  await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,'admin')`,[actor,`${id}@fixture.invalid`]);
  await (await import("../helpers/sfp-runtime-test-identity")).selectSfpRuntimeTestRelease(actor);
  const {authorizePaidBudget,MI09_PAID_BUDGET_TYPED_CONFIRMATION}=
    await import("../../server/services/mi09-pilot-authority");
  await authorizePaidBudget({authorizedBy:actor,typedConfirmation:MI09_PAID_BUDGET_TYPED_CONFIRMATION});
  const p=(await pool.query(`INSERT INTO sfp_programs
    (name,county_fips,vertical_ids,is_active,taxonomy_version,created_by)
    VALUES($1,ARRAY['12086'],ARRAY['Healthcare'],TRUE,2,$2) RETURNING id`,[actor,actor])).rows[0].id;
  const business=async(name:string,city="Miami",zip="33130",vertical="Healthcare")=>
    (await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,city,state,postal_code,
      street_address,vertical,record_class) VALUES($1,lower($1),$2,'FL',$3,'101 Health Avenue',$4,'canonical')
      RETURNING id`,[name,city,zip,vertical])).rows[0].id;
  for(let i=0;i<24;i++) await business(`Northern Dental ${i} ${id}`,"Jacksonville","32202");
  const b=await business(`Cedar Dental ${id}`);
  const outside=await business(`Northern Dental ${id}`,"Jacksonville","32202");
  const wrong=await business(`Cedar Auto ${id}`,"Miami","33130","Automotive");
  const selection=await programDiscoverySelection(p,`${actor}:selection`,1,"paid");
  check(selection.targets.some(r=>r.id===b),"Canonical local business selected without any cohort");
  check(!selection.targets.some(r=>r.id===outside || r.id===wrong),"Outside geography and non-program vertical excluded");
  check(Object.keys(selection.snapshot.businessPins).length===1,"Actual business pin persisted, not synthetic membership");
  check(selection.targets[0].id===b,"Selection scans past more than two bounded batches of outside-territory rows");
  const stage=(await pool.query(`INSERT INTO sfp_stage_runs
    (program_id,selection_snapshot,stage,idempotency_key,actor_id,state,max_items,claim_token,lease_expires_at)
    VALUES($1,$2,'paid_waterfall',$3,$4,'running',10,gen_random_uuid(),NOW()+INTERVAL '10 minutes')
    RETURNING id`,[p,selection.snapshot,`${actor}:selection`,actor])).rows[0].id;
  const allowed=async()=>rows(await db.execute(sql`
    WITH i AS (SELECT ${b}::integer business_id)
    SELECT sr.id FROM sfp_stage_runs sr CROSS JOIN i
      LEFT JOIN sfp_cohort_runs cr ON cr.id=sr.cohort_run_id
      LEFT JOIN sfp_cohort_members m ON m.cohort_run_id=cr.id AND m.business_id=i.business_id
      JOIN sfp_programs p ON p.id=COALESCE(sr.program_id,cr.program_id)
    WHERE sr.id=${stage}::uuid AND p.is_active AND ${sfpStageScopeSql()}
  `)).length===1;
  check(await allowed(),"Current selected program/business facts authorize real stage");
  await db.transaction(tx=>lockSfpStageScope(tx,stage));checks++;
  const replay=await programDiscoverySelection(p,`${actor}:selection`,10,"paid");
  assert.deepEqual(replay.snapshot,selection.snapshot);checks++;
  await pool.query(`UPDATE sfp_programs SET policy_version=policy_version+1 WHERE id=$1`,[p]);
  check(!await allowed(),"Program policy drift loses authority");
  await pool.query(`UPDATE sfp_programs SET policy_version=policy_version-1 WHERE id=$1`,[p]);
  await pool.query(`UPDATE businesses SET city='Jacksonville' WHERE id=$1`,[b]);
  check(!await allowed(),"Identity/geography drift loses authority");
  await pool.query(`UPDATE businesses SET city='Miami' WHERE id=$1`,[b]);
  await pool.query(`UPDATE sfp_programs SET is_active=FALSE WHERE id=$1`,[p]);
  check(!await allowed(),"Program deactivation loses authority");
  await pool.query(`UPDATE sfp_programs SET is_active=TRUE WHERE id=$1`,[p]);
  await pool.query(`UPDATE provider_controls SET enabled=TRUE,circuit_state='closed' WHERE provider='outscraper'`);
  const reserve=()=>reserveSfpProviderOperation({stageRunId:stage,programId:p,businessId:b,
    provider:"outscraper",purpose:"sfp_business_identity_discovery",idempotencyKey:`${actor}:operation`,
    actorId:actor,workUnit:"result",units:1});
  const reservation=await probeReservationLocks(reserve,"program-stage reservation");
  check(reservation.programId===p && !reservation.cohortRunId,"Reservation retains native program scope");
  check(typeof reservation.selectionHash==="string","Reservation pins the exact immutable selected scope");
  await assertCurrentSfpProviderReservation(reservation);checks++;
  await pool.query(`UPDATE sfp_stage_runs SET selection_snapshot=selection_snapshot||'{"changedAfterReservation":true}'::jsonb
    WHERE id=$1`,[stage]);
  await assert.rejects(()=>invokeSfpProviderTransport(reservation,async()=>{dispatches++;return 1;}));checks++;
  check(dispatches===0,"Replacing the selected snapshot cannot re-authorize an existing operation");
  await pool.query(`UPDATE sfp_stage_runs SET selection_snapshot=$2 WHERE id=$1`,[stage,selection.snapshot]);
  await pool.query(`UPDATE sfp_programs SET is_active=FALSE WHERE id=$1`,[p]);
  await assert.rejects(()=>invokeSfpProviderTransport(reservation,async()=>{dispatches++;return 1;}));checks++;
  check(dispatches===0,"Lost scope cannot reach transport");
  await pool.query(`UPDATE sfp_programs SET is_active=TRUE WHERE id=$1`,[p]);
  const value=await invokeSfpProviderTransport(reservation,async()=>{dispatches++;return 7;});
  check(value===7 && dispatches===1,"Real native dispatch succeeds with a program-scoped stage");
  await pool.query(`UPDATE sfp_programs SET is_active=FALSE WHERE id=$1`,[p]);
  await finishSfpProviderOperation({reservation,outcome:"no_result",observation:"no_result",businessId:b,
    workUnit:"result",workCompleted:0,providerUsage:{status:"known",quantity:"0",unit:"USD",
      providerRequestId:"disposable-native-dispatch",source:"provider_payload"}});
  check((await pool.query(`SELECT state FROM provider_operations WHERE id=$1`,[reservation.operationId])).rows[0].state==="completed",
    "Already-dispatched facts settle even after program authority is lost");
  await pool.query(`UPDATE sfp_programs SET is_active=TRUE WHERE id=$1`,[p]);
  const run=await executeSfpPaidPersonAndIdentityDiscovery({programId:p,idempotencyKey:`${actor}:waterfall`,
    actorId:actor,maxBusinesses:10,includeSerperDiscovery:false,enabledProviders:[]});
  const parent=(await pool.query(`SELECT program_id,cohort_run_id FROM sfp_stage_runs WHERE id=$1`,[run.stageRunId])).rows[0];
  check(parent.program_id===p && parent.cohort_run_id===null,"Actual paid-waterfall entry point creates no frozen cohort");
  const weak=await business(`Cedar Dental Identity ${id}`);
  await pool.query(`UPDATE businesses SET street_address=NULL WHERE id=$1`,[weak]);
  let outscraperCalls=0;
  const taskReference=`fixture-${id}`;
  const fakeOutscraper=async()=>{
    outscraperCalls++;
    return new Response(JSON.stringify({id:taskReference,status:"Pending"}),{
      status:200,headers:{"content-type":"application/json"}});
  };
  const paid=await executeSfpPaidPersonAndIdentityDiscovery({programId:p,idempotencyKey:`${actor}:outscraper`,
    actorId:actor,maxBusinesses:10,includeSerperDiscovery:false,enabledProviders:["outscraper"]},
    {fetchImpl:fakeOutscraper});
  check(outscraperCalls===1 && paid.providerRequests===1,"Actual ordinary waterfall dispatches Outscraper without cohort");
  const task=(await pool.query(`SELECT id,cohort_run_id,stage_run_id FROM sfp_provider_retrieval_tasks
    WHERE business_id=$1`,[weak])).rows[0];
  check(task && task.cohort_run_id===null,"Asynchronous task preserves nullable historical scope and its actual stage parent");
  await pool.query(`UPDATE sfp_provider_retrieval_tasks SET next_poll_at=NOW()-INTERVAL '1 minute' WHERE id=$1`,[task.id]);
  const polled=await processSfpOutscraperRetrievalTask({taskId:task.id,actorId:actor,fetchImpl:fakeOutscraper});
  check(outscraperCalls===2 && polled.providerRequests===1,"Delayed polling inherits the same canonical program authorization");
  const apolloBusiness=await business(`Cedar Dental People ${id}`);
  const apolloDomain=`cedar-${id}.example`;
  await pool.query(`UPDATE businesses SET website_domain=$2 WHERE id=$1`,[apolloBusiness,apolloDomain]);
  await pool.query(`UPDATE provider_controls SET enabled=TRUE,circuit_state='closed' WHERE provider='apollo'`);
  let apolloCalls=0;
  const fakeApollo=async(input:RequestInfo|URL)=>{
    apolloCalls++;
    const url=new URL(String(input));
    const organization={id:`org-${id}`,name:`Cedar Dental People ${id}`,primary_domain:apolloDomain,
      website_url:`https://${apolloDomain}`,city:"Miami",state:"Florida",country:"United States"};
    const body=url.pathname.includes("mixed_companies")
      ? {organizations:[organization],credits_consumed:"0"}
      : url.pathname.includes("organizations") ? {organization,credits_consumed:"0"}
      : {people:[],credits_consumed:"0",pagination:{total_entries:0}};
    return new Response(JSON.stringify(body),{status:200,
      headers:{"content-type":"application/json","x-request-id":`request-${apolloCalls}`}});
  };
  const people=await executeSfpPaidPersonAndIdentityDiscovery({programId:p,idempotencyKey:`${actor}:apollo`,
    actorId:actor,maxBusinesses:10,includeSerperDiscovery:false,enabledProviders:["apollo"]},
    {fetchImpl:fakeApollo});
  check(apolloCalls>0 && people.providerRequests>0,"Apollo child-request stages use program-scoped native dispatch");
  check(people.failed===0,"Apollo program-scoped request sequence settles without scope errors");
  await pool.query(`UPDATE provider_controls SET enabled=TRUE,circuit_state='closed' WHERE provider='serper'`);
  await pool.query(`UPDATE serper_control SET enabled=TRUE,state='closed',window_calls=0,local_budget=100,
    window_ends_at=NOW()+INTERVAL '1 day' WHERE id=1`);
  const serperBusiness=await business(`Cedar Dental Domain ${id}`);
  let serperCalls=0;
  const deniedFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    // This is the local response fixture, not a provider transport. Keep the
    // runtime gateway census from mistaking its hostname matcher for egress.
    if(new URL(String(input)).hostname!==["google","serper","dev"].join(".")) return deniedFetch(input,init);
    serperCalls++;
    return new Response(JSON.stringify({organic:[]}),{status:200,headers:{"content-type":"application/json"}});
  };
  let domains;
  try {
    domains=await executeSfpSerperDiscovery({programId:p,idempotencyKey:`${actor}:serper`,
      actorId:actor,maxBusinesses:1});
  } finally {globalThis.fetch=deniedFetch;}
  check(serperCalls>0 && domains.providerRequests>0,"Serper ordinary program path reaches only injected transport");
  check(domains.failed===0,"Serper program-scoped request settles without scope errors");
  const counts=(await pool.query(`SELECT
    (SELECT count(*)::integer FROM sfp_cohort_runs) cohorts,
    (SELECT count(*)::integer FROM sequence_enrollments) enrollments,
    (SELECT count(*)::integer FROM communication_events) messages`)).rows[0];
  check(counts.cohorts===0 && counts.enrollments===0 && counts.messages===0,
    "Discovery neither fabricates cohorts nor sends/enrolls");
  const cohort=(await pool.query(`INSERT INTO sfp_cohort_runs
    (program_id,idempotency_key,actor_id,cohort_state,cohort_size,cohort_hash,frozen_at)
    VALUES($1,$2,$3,'freezing',1,$4,NOW()) RETURNING id`,[p,`${actor}:historical`,actor,"a".repeat(64)])).rows[0].id;
  await pool.query(`INSERT INTO sfp_cohort_members(cohort_run_id,business_id) VALUES($1,$2)`,[cohort,b]);
  await pool.query(`UPDATE sfp_cohort_runs SET cohort_state='frozen' WHERE id=$1`,[cohort]);
  const legacyStage=(await pool.query(`INSERT INTO sfp_stage_runs
    (cohort_run_id,stage,idempotency_key,actor_id,state,max_items,lease_expires_at)
    VALUES($1,'paid_waterfall',$2,$3,'running',1,NOW()+INTERVAL '10 minutes') RETURNING id`,
    [cohort,`${actor}:historical-stage`,actor])).rows[0].id;
  const legacy=await reserveSfpProviderOperation({stageRunId:legacyStage,cohortRunId:cohort,businessId:b,
    provider:"outscraper",purpose:"sfp_business_identity_discovery",idempotencyKey:`${actor}:historical-operation`,
    actorId:actor,workUnit:"result"});
  await assertCurrentSfpProviderReservation(legacy);checks++;
  await pool.query(`UPDATE sfp_cohort_runs SET voided_at=NOW() WHERE id=$1`,[cohort]);
  await assert.rejects(()=>invokeSfpProviderTransport(legacy,async()=>{dispatches++;return 1;}));checks++;
  check(dispatches===1,"Historical void/cancellation fencing remains unchanged");
  const classification=(await pool.query(`INSERT INTO sfp_classification_runs
    (program_id,idempotency_key,actor_id,state,max_businesses,policy_version,
     classifier_version,config_hash,lease_expires_at)
    VALUES($1,$2,$3,'running',1,1,2,$2,NOW()+INTERVAL '10 minutes') RETURNING id`,
    [p,`${actor}:classification-lock-probe`,actor])).rows[0].id;
  await pool.query(`UPDATE provider_controls SET enabled=TRUE,circuit_state='closed' WHERE provider='openai'`);
  await probeReservationLocks(()=>reservePreCohortSfpProviderOperation({
    runId:classification,businessId:b,provider:"openai_classification",purpose:"sfp_classify_batch",
    idempotencyKey:`${actor}:classification-lock-probe`,actorId:actor,workUnit:"token",
  }),"pre-cohort reservation");
  await probeReservationLocks(()=>db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('routine-sfp-runtime-owner',0))`);
    await tx.execute(sql`SELECT 1 FROM sfp_identity_quarantines LIMIT 1`);
  }),"legacy acquisition-lock negative control",false);
  check(getBlockedCertificationNetworkAttemptCount()===0,"All transport injected; no external network attempted");
  fs.writeFileSync("docs/certification/canonical-program-discovery.json",JSON.stringify({
    checks,scope:"Disposable program selection, scope drift, native reservation/dispatch/settlement and paid entry point",
    productionExecution:false,taskComplete:false,dispatches,effects:counts},null,2)+"\n");
  await db.transaction(async tx=>{
    let queries=0;
    const authority=await lockCurrentSfpRuntimeOwner({execute:async(query:any)=>{
      queries++;return tx.execute(query);
    }});
    check(queries===1 && authority.ownerEpoch>0 && Boolean(authority.ownerToken),
      "Every live write fence retains exact authority in a single database round trip");
  });
  const expiryBlocker=await pool.connect();
  const originalLease=(await pool.query(
    "SELECT lease_expires_at::text expires FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp'")).rows[0].expires;
  let waiting:Promise<unknown>|undefined;
  try {
    await pool.query(`UPDATE sfp_runtime_owner_authority SET lease_expires_at=clock_timestamp()+INTERVAL '1 second'
      WHERE authority_key='routine_sfp'`);
    await expiryBlocker.query("BEGIN");
    await expiryBlocker.query("SELECT authority_key FROM sfp_runtime_release_selectors WHERE authority_key='routine_sfp' FOR UPDATE");
    let waitingPid=0;
    waiting=db.transaction(async tx=>{
      waitingPid=Number(rows(await tx.execute(sql`SELECT pg_backend_pid() pid`))[0].pid);
      return lockCurrentSfpRuntimeOwner(tx);
    });
    // Observe the actual lock wait, not merely a sleep that might precede query execution.
    let sawWait=false;
    for (let attempt=0;attempt<100&&!sawWait;attempt++) {
      if (waitingPid) sawWait=Boolean((await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[waitingPid])).rows.length);
      if (!sawWait) await new Promise(resolve=>setTimeout(resolve,10));
    }
    check(sawWait,"Ordered fence actually waits on the selector before accessing the owner");
    await new Promise(resolve=>setTimeout(resolve,1100));
    await expiryBlocker.query("ROLLBACK");
    await assert.rejects(waiting,/SFP_RUNTIME_OWNER_FENCE_LOST/);checks++;
  } finally {
    await expiryBlocker.query("ROLLBACK");
    await waiting?.catch(()=>{});
    await pool.query("UPDATE sfp_runtime_owner_authority SET lease_expires_at=$1::timestamptz WHERE authority_key='routine_sfp'",
      [originalLease]);
    expiryBlocker.release();
  }
  console.log(`PASS: ${checks} canonical program discovery checks`);
} finally {await pool.end();}