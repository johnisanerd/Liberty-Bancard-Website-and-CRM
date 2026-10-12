import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import pg from "pg";
import {sql} from "drizzle-orm";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {applyCertificationProviderDenyBoundary} from "../certification-provider-deny";
await assertDisposableTestInfrastructure({operation:"canonical transaction and lease certification"});
applyCertificationProviderDenyBoundary();
// This suite certifies recycling and contention on one application connection,
// not the release server's pool configuration. Pin the child before db import
// so standalone and release executions exercise the same stronger boundary.
process.env.DB_POOL_MAX="1";
const {db,pool}=await import("../../server/db");
const {observeTransactionConnections,withTransactionPhase}=await import("../../server/lib/transaction-observability");
const {runWithDbContext}=await import("../../server/lib/db-context");
const {assertCanonicalPreparationLease,checkpointCanonicalPreparationLease}=await import("../../server/services/canonical-preparation-lease");
const {boundCanonicalWriteTransaction}=await import("../../server/services/canonical-transaction-retry");
const events:Record<string,any>[]=[];
const tracePool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:400});
const stop=observeTransactionConnections(tracePool,{emit:event=>events.push(event),slowMs:1,sampleMs:10});
const blocker=new pg.Client({connectionString:process.env.DATABASE_URL});
await blocker.connect();
let checks=0;
const check=(value:unknown,message:string)=>{assert(value,message);checks++;};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  // Real pg-pool recycling, callback release identity, callbacks and promises.
  let pid:number|undefined;
  for (let i=0;i<30;i++) {
    const client=await tracePool.connect();
    if (pid===undefined) pid=client.processID;
    assert.equal(client.processID,pid);
    await withTransactionPhase("test_recycled",()=>client.query("BEGIN"));
    await withTransactionPhase("test_recycled",()=>client.query("SELECT pg_sleep(0.002)"));
    await client.query("SELECT $1::text AS value",["private-contact@example.test"]);
    await client.query("COMMIT");
    client.release();
    await new Promise<void>((resolve,reject)=>tracePool.connect((error,callbackClient,release)=>{
      if (error) return reject(error);
      assert.equal(release,callbackClient.release);
      callbackClient.query("SELECT $1::int n",[i],(error,result)=>{
        release();
        if (error) return reject(error);
        assert.equal(result.rows[0].n,i);resolve();
      });
    }));
  }
  checks+=60;
  const queryClient=await tracePool.connect();
  const config={text:"SELECT 1 n",callback:(error:any,result:any)=>{assert.ifError(error);assert.equal(result.rows[0].n,1);}};
  await new Promise<void>(resolve=>{
    const callback=config.callback;
    queryClient.query({...config,callback:(error:any,result:any)=>{callback(error,result);resolve();}} as any);
  });checks++;
  await new Promise<void>(resolve=>{
    const query=new pg.Query("SELECT 1 n",[],(error:any,result:any)=>{
      assert.ifError(error);assert.equal(result.rows[0].n,1);resolve();
    });
    queryClient.query(query);
  });checks++;
  await assert.rejects(queryClient.query("SELECT 1/0"),(error:any)=>error.code==="22012");checks++;
  queryClient.release();
  await new Promise<void>((resolve,reject)=>pool.query("SELECT 1 n",(error:any,result:any)=>{
    if (error) return reject(error);
    assert.equal(result.rows[0].n,1);resolve();
  }));checks++;
  await runWithDbContext({correlationId:"lease-contention-test",normalizedRoute:"certification"},async()=>{
    const client=await tracePool.connect();
    await client.query("BEGIN");
    const queued=tracePool.connect();
    await sleep(30);
    await client.query("ROLLBACK");client.release();
    const next=await queued;next.release();
  });
  check(events.some(event=>event.event==="db:acquired" && event.acquireWaitMs>=20),
    "Connection acquisition measured independently from query execution");
  check(events.some(event=>event.event==="db:long_checkout" && event.transactionOpen && event.inFlight===0),
    "Idle open transaction is identified with backend and connection IDs");
  check(events.some(event=>event.event==="db:connection_release" && event.checkoutDurationMs>=20
    && event.executionMs<event.checkoutDurationMs && event.backendId===pid),
    "Release reports independent acquisition/execution/checkout durations");
  check(!JSON.stringify(events).includes("private-contact@example.test") && !JSON.stringify(events).includes("SELECT"),
    "Connection tracing contains no SQL literals or contact data");
  check(events.some(event=>event.phase==="test_recycled"),"Transaction phase follows async context");
  const failureClient=await tracePool.connect();
  await assert.rejects(tracePool.connect(),/timeout/);checks++;
  failureClient.release();
  check(events.some(event=>event.event==="db:acquire_error"),"Failed acquisition is observable without a checkout leak");
  const broken=await tracePool.connect();broken.release(new Error("discard fixture connection"));
  const replacement=await tracePool.connect();check(replacement.processID!==pid,"Error release discards physical connection");
  replacement.release();
  const idleClient=await tracePool.connect();
  await idleClient.query("BEGIN");
  await idleClient.query("SET LOCAL idle_in_transaction_session_timeout='100ms'");
  await sleep(200);
  await assert.rejects(idleClient.query("SELECT 1"));checks++;
  idleClient.release();
  check(events.some(event=>event.event==="db:checked_out_connection_error" && event.transactionOpen),
    "Native idle-transaction termination is traced without crashing the application");
  const healthy=await tracePool.query("SELECT 1 n");
  check(healthy.rows[0].n===1,"Pool remains healthy after a terminated checked-out transaction");

  const key=`canonical_lease_cert_${randomUUID()}`,token=randomUUID();
  const state={afterContactId:0,cycles:0,scanned:0,prepared:0,held:0,reasons:{},
    leaseToken:token,leaseUntil:new Date(Date.now()+120000).toISOString()};
  await pool.query("INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb)",[key,JSON.stringify(state)]);
  const checkpoint=(release=false)=>db.transaction(tx=>checkpointCanonicalPreparationLease(tx,key,token,state,release));
  await checkpoint();state.scanned=1;await checkpoint();checks+=2;
  await assert.rejects(db.transaction(tx=>checkpointCanonicalPreparationLease(tx,key,randomUUID(),state)),
    /LEASE_LOST/);checks++;
  check((await pool.query("SELECT (value->>'scanned')::int n FROM system_settings WHERE key=$1",[key])).rows[0].n===1,
    "Competing token cannot change checkpointed progress");
  await pool.query(`UPDATE system_settings SET value=jsonb_set(value,'{leaseUntil}',
    to_jsonb((clock_timestamp()+INTERVAL '150 milliseconds')::text)) WHERE key=$1`,[key]);
  await blocker.query("BEGIN");
  await blocker.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE",[key]);
  const expiredWhileWaiting=db.transaction(tx=>assertCanonicalPreparationLease(tx,key,token));
  // Attach rejection handling before releasing the lock.
  const expiredResult=assert.rejects(expiredWhileWaiting,/LEASE_LOST/);
  await sleep(250);await blocker.query("ROLLBACK");await expiredResult;checks++;
  await assert.rejects(checkpoint(),/LEASE_LOST/);checks++;
  await assert.rejects(checkpoint(true),/LEASE_LOST/);checks++;
  const successor=randomUUID();
  await pool.query(`UPDATE system_settings SET value=jsonb_set(jsonb_set(value,'{leaseToken}',to_jsonb($2::text)),
    '{leaseUntil}',to_jsonb((clock_timestamp()+INTERVAL '2 minutes')::text)) WHERE key=$1`,[key,successor]);
  await assert.rejects(checkpoint(true),/LEASE_LOST/);checks++;
  check((await pool.query("SELECT value->>'leaseToken' token FROM system_settings WHERE key=$1",[key])).rows[0].token===successor,
    "Expired predecessor cannot overwrite successor's token or progress");

  // Bound a real advisory-lock wait while authority would otherwise be pinned.
  await blocker.query("SELECT pg_advisory_lock(20632063)");
  const waitStarted=Date.now();
  await assert.rejects(db.transaction(async tx=>{
    await boundCanonicalWriteTransaction(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20632063)`);
  }),(error:any)=>error.code==="55P03" || error.cause?.code==="55P03");checks++;
  check(Date.now()-waitStarted<3000,"Contended transaction releases locks within the native lock bound");
  await blocker.query("SELECT pg_advisory_unlock(20632063)");
  await pool.query("DELETE FROM system_settings WHERE key=$1",[key]);

  const {claimCsvExecution,recordImportRowDisposition,completeImportExecution}=await import("../../server/services/import-execution");
  const {retainProviderImportRow}=await import("../../server/services/provider-import-evidence");
  const {materializeCanonicalProviderImportRow}=await import("../../server/services/canonical-provider-import");
  const {hasCanonicalImportRecoveryClaim}=await import("../../server/services/canonical-import-recovery-contract");
  const {processCanonicalImportRecoveryTick}=await import("../../server/services/canonical-import-recovery-worker");
  const {lockCurrentSfpRuntimeOwner}=await import("../../server/services/cro03/sfp-provider-operations");
  process.env.NODE_ENV="production";process.env.REPLIT_DEPLOYMENT="1";
  process.env.RELEASE_SHA="e".repeat(40);process.env.SFP_PUBLISH_ARTIFACT_SHA=process.env.RELEASE_SHA;
  process.env.SFP_PUBLISH_BUILD_ID=randomUUID();process.env.SFP_PUBLISH_BUILT_AT=new Date().toISOString();
  await processCanonicalImportRecoveryTick(); // Genuine native fixture owner; empty backlog.
  const suffix=randomUUID().replaceAll("-","");
  const raw={name:`Lease recovery ${suffix}`,place_id:`lease_place_${suffix}`,category:"Automotive",
    city:"Miami",state:"FL",email_1:`lease.first.${suffix}@gmail.com`,email_2:`lease.second.${suffix}@gmail.com`};
  const fingerprint=createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  const actorId="system:canonical-lease-certification";
  const imported=await claimCsvExecution({fileHash:createHash("sha256").update(randomUUID()).digest("hex"),
    totalRows:1,actorType:"import",actorId,sourcePayload:[raw]});
  await retainProviderImportRow({executionId:imported.execution.id,sourceRowNumber:1,
    sourceFormat:"google_maps_outscraper",actorId,rawRow:raw});
  await recordImportRowDisposition({executionId:imported.execution.id,claimToken:imported.claimToken!,
    sourceRowNumber:1,rowFingerprint:fingerprint,disposition:"deferred",reasonCode:"cro03_staging_review_required"});
  await completeImportExecution({executionId:imported.execution.id,claimToken:imported.claimToken!,expectedRows:1});
  const item=(await pool.query(`SELECT item.id FROM cro03_enrichment_items item
    JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id WHERE batch.idempotency_key=$1`,
    [`csv-source:${imported.execution.id}:1`])).rows[0];
  const claimToken=randomUUID();
  const recoveryClaim={itemId:item.id,claimToken};
  const claimInput={executionId:imported.execution.id,sourceRowNumber:1,rowFingerprint:fingerprint,recoveryClaim,renew:true};
  await pool.query(`UPDATE cro03_enrichment_items SET state='running',claim_token=$2,current_provider='canonical_local_import',
    lease_expires_at=clock_timestamp()+INTERVAL '150 milliseconds' WHERE id=$1`,[item.id,claimToken]);
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM cro03_enrichment_items WHERE id=$1 FOR UPDATE",[item.id]);
  const lateRenewal=db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,claimInput));
  await sleep(250);await blocker.query("ROLLBACK");
  check(!await lateRenewal,"Import renewal rejects expiry during an actual row-lock wait");
  check(!await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,claimInput)),
    "Import checkpoint cannot revive an expired claim");
  await pool.query(`UPDATE cro03_enrichment_items SET lease_expires_at=clock_timestamp()+INTERVAL '2 minutes' WHERE id=$1`,[item.id]);
  check(!await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,{
    ...claimInput,recoveryClaim:{itemId:item.id,claimToken:randomUUID()}})),
    "Competing import token cannot renew another owner's claim");
  check(await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,claimInput)),
    "Exact live original-source claim renews at a bounded-unit checkpoint");
  const counters=(await pool.query(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`)).rows[0];
  await assert.rejects(materializeCanonicalProviderImportRow({
    executionId:imported.execution.id,sourceRowNumber:1,sourceFormat:"google_maps_outscraper",
    rawRow:raw,actorId,recoveryClaim,
    ownerAuthorityCheck:async tx=>{
      await lockCurrentSfpRuntimeOwner(tx);
      const committed=(await blocker.query("SELECT id FROM contacts WHERE email=$1",[raw.email_1])).rows[0];
      if (committed) throw new Error("CERT_CRASH_AFTER_MAILBOX_COMMIT");
    },
  }),/CERT_CRASH_AFTER_MAILBOX_COMMIT/);checks++;
  const firstContact=(await pool.query("SELECT id FROM contacts WHERE email=$1",[raw.email_1])).rows[0];
  check(Boolean(firstContact),"Fault occurs after the first atomic mailbox/provenance commit");
  check((await pool.query("SELECT count(*)::int n FROM contacts WHERE email=$1",[raw.email_2])).rows[0].n===0,
    "Remaining mailbox is not fabricated or marked fulfilled by partial success");
  check((await pool.query("SELECT state FROM cro03_enrichment_items WHERE id=$1",[item.id])).rows[0].state==="running",
    "Partial commits do not mark the original row complete");
  await pool.query(`UPDATE cro03_enrichment_items SET lease_expires_at=clock_timestamp()-INTERVAL '1 second',
    next_attempt_at=clock_timestamp() WHERE id=$1`,[item.id]);
  check(!await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,claimInput)),
    "Crashed actor cannot revive its expired partially committed claim");
  const recovered=await processCanonicalImportRecoveryTick();
  check(recovered.fulfilled===1,"The one existing recovery worker resumes the genuine partially committed source row");
  const contacts=(await pool.query("SELECT id FROM contacts WHERE email=ANY($1::text[])",
    [[raw.email_1,raw.email_2]])).rows;
  check(contacts.length===2 && contacts.some(contact=>contact.id===firstContact.id),
    "Replay reuses the committed contact and adds exactly one missing mailbox");
  check((await pool.query("SELECT disposition FROM import_row_dispositions WHERE execution_id=$1",
    [imported.execution.id])).rows[0].disposition==="deferred","Immutable original import accounting is unchanged");
  check((await pool.query("SELECT terminal_code FROM cro03_enrichment_items WHERE id=$1",[item.id])).rows[0].terminal_code===
    "CANONICAL_LOCAL_IMPORT_FULFILLED","Only committed outcomes fulfill the original source item");
  check(!(await processCanonicalImportRecoveryTick()).ran,"Post-crash replay is a no-op after genuine completion");
  await assert.rejects(materializeCanonicalProviderImportRow({
    executionId:imported.execution.id,sourceRowNumber:1,sourceFormat:"google_maps_outscraper",
    rawRow:raw,actorId,recoveryClaim,
  }),/LEASE_LOST|AUTHORITY/);checks++;
  assert.deepEqual((await pool.query(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`)).rows[0],counters);checks++;
  const {heartbeatImportExecution}=await import("../../server/services/import-execution");
  const {processPersistedCsvImport}=await import("../../server/services/csv-import-processor");
  const {storage}=await import("../../server/storage");
  for (const matched of [false,true]) {
    const ordinarySuffix=randomUUID().replaceAll("-","");
    const ordinaryRaw={name:`Ordinary restart ${ordinarySuffix}`,place_id:`ordinary_${ordinarySuffix}`,
      category:"Automotive",city:"Miami",state:"FL",phone:"3055550100",email_1:`ordinary.first.${ordinarySuffix}@gmail.com`,
      email_2:`ordinary.second.${ordinarySuffix}@gmail.com`,opted_out_email:"yes"};
    const fileHash=createHash("sha256").update(randomUUID()).digest("hex");
    const originalMetadata={fileName:"ordinary.csv",originalMarker:randomUUID()};
    const ordinaryInput={fileHash,totalRows:1,actorType:"import",actorId,metadata:originalMetadata,sourcePayload:[ordinaryRaw]};
    const ordinary=await claimCsvExecution(ordinaryInput);
    const csvImport=await storage.createCsvImport({executionId:ordinary.execution.id,fileName:"ordinary.csv",
      sourceFormat:"google_maps_outscraper",importSource:"google_maps_outscraper",totalRows:1,
      status:"processing",importedBy:actorId});
    const preexisting=matched ? (await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,city,state,record_class)
      VALUES('','',$1,$2,$3,'Miami','FL','production') RETURNING id`,
    [ordinaryRaw.email_1,ordinaryRaw.phone,ordinaryRaw.name])).rows[0] : null;
    await assert.rejects(materializeCanonicalProviderImportRow({
      executionId:ordinary.execution.id,claimToken:ordinary.claimToken!,
      sourceRowNumber:1,sourceFormat:"google_maps_outscraper",rawRow:ordinaryRaw,actorId,fileName:"ordinary.csv",
      ownerAuthorityCheck:async tx=>{
        await lockCurrentSfpRuntimeOwner(tx);
        const committed=(await blocker.query(`SELECT id FROM contact_source_events
          WHERE import_execution_id=$1 AND source_row_number=1`,[ordinary.execution.id])).rows[0];
        if (committed) throw new Error("CERT_ORDINARY_CRASH_AFTER_MAILBOX_COMMIT");
      },
    }),/CERT_ORDINARY_CRASH_AFTER_MAILBOX_COMMIT/);checks++;
    const first=(await pool.query("SELECT id,opted_out_email FROM contacts WHERE email=$1",[ordinaryRaw.email_1])).rows[0];
    check(Boolean(first) && first.opted_out_email,"Ordinary partial commit includes contact, provenance and restrictive consent");
    if (preexisting) check(first.id===preexisting.id,"Ordinary matched-row crash retains the existing contact");
    check((await pool.query("SELECT count(*)::int n FROM contacts WHERE email=$1",[ordinaryRaw.email_2])).rows[0].n===0,
      "Ordinary crash occurs before the remaining mailbox commits");
    const accounting=(await pool.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",
      [ordinary.execution.id])).rows;
    check(accounting.length===1 && accounting[0].disposition===(matched ? "matched_noop" : "created"),
      "Original first-mailbox accounting remains truthful but is not whole-row fulfillment");
    const prematurelyCompleted=await completeImportExecution({
      executionId:ordinary.execution.id,claimToken:ordinary.claimToken!,expectedRows:1});
    check(!prematurelyCompleted.completed && prematurelyCompleted.total===1,
      "Complete execution refuses partial mailbox fulfillment even when original accounting totals one row");
    const pending=(await pool.query("SELECT status,metadata FROM import_executions WHERE id=$1",
      [ordinary.execution.id])).rows[0];
    check(pending.status==="running" && Boolean(pending.metadata.canonicalProviderPendingRows["1"]),
      "Crash leaves durable claim-fenced pending work for the existing persisted-upload recovery path");
    await pool.query(`UPDATE import_executions SET lease_expires_at=clock_timestamp()+INTERVAL '150 milliseconds'
      WHERE id=$1`,[ordinary.execution.id]);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM import_executions WHERE id=$1 FOR UPDATE",[ordinary.execution.id]);
    const ordinaryRenewal=heartbeatImportExecution(ordinary.execution.id,ordinary.claimToken!);
    await sleep(250);await blocker.query("ROLLBACK");
    check(!await ordinaryRenewal,"Ordinary heartbeat cannot revive a lease expired during a row-lock wait");
    const successor=await claimCsvExecution(ordinaryInput);
    check(successor.claimed && successor.claimToken!==ordinary.claimToken,
      "Existing CSV execution is reclaimed under a fresh token, not a parallel recovery job");
    check(!await heartbeatImportExecution(ordinary.execution.id,ordinary.claimToken!),
      "Crashed ordinary actor cannot renew the successor's execution");
    await processPersistedCsvImport({records:[ordinaryRaw],executionClaim:successor,importRecord:csvImport,
      sourceFormat:"google_maps_outscraper",actor:{actorType:"import",actorId},filename:"ordinary.csv"});
    const resumed=(await pool.query("SELECT id,opted_out_email FROM contacts WHERE email=ANY($1::text[])",
      [[ordinaryRaw.email_1,ordinaryRaw.email_2]])).rows;
    check(resumed.length===2 && resumed.some(contact=>contact.id===first.id) && resumed.every(contact=>contact.opted_out_email),
      "Actual persisted ordinary-upload recovery resumes missing mailboxes once with original consent facts");
    check((await pool.query("SELECT count(*)::int n FROM contact_source_events WHERE import_execution_id=$1",
      [ordinary.execution.id])).rows[0].n===2,"Restart commits exactly one source event for each retained mailbox");
    assert.deepEqual((await pool.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",
      [ordinary.execution.id])).rows,accounting);checks++;
    const finished=(await pool.query("SELECT status,metadata FROM import_executions WHERE id=$1",
      [ordinary.execution.id])).rows[0];
    check(finished.status==="completed" && Object.keys(finished.metadata.canonicalProviderPendingRows).length===0
      && finished.metadata.originalMarker===originalMetadata.originalMarker,
      "Execution completes only after mailbox fulfillment; original metadata is preserved");
    const csvFinished=(await pool.query("SELECT status,processed_rows FROM csv_imports WHERE id=$1",
      [csvImport.id])).rows[0];
    check(csvFinished.status==="completed" && csvFinished.processed_rows===1,
      "User-facing import reports completion only after the full original row is committed");
    const ordinaryReplay=await claimCsvExecution(ordinaryInput);
    check(ordinaryReplay.replay && !ordinaryReplay.claimed && !ordinaryReplay.claimToken,
      "Completed ordinary upload is an idempotent replay without another processor");
  }
  assert.deepEqual((await pool.query(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`)).rows[0],counters);checks++;
  check(pool.options.max===1,"Application transaction certification uses one pooled connection");
  console.log(`Canonical transaction/lease certification PASS (${checks} checks; real pg callbacks/reuse, contention, expiry and fencing).`);
} finally {
  stop();await blocker.end();await tracePool.end();await pool.end();
}
