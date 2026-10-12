import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {writeFileSync} from "node:fs";
import pg from "pg";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount} from "../certification-provider-deny";

const certificationEnvironment=Object.freeze({...process.env});
await assertDisposableTestInfrastructure({operation:"retained canonical recovery",requireRedis:false,
  env:certificationEnvironment});
applyCertificationProviderDenyBoundary({fatal:true});
process.env.NODE_ENV="production";process.env.REPLIT_DEPLOYMENT="1";
// Install before the app instruments physical clients. Its per-connection
// observer saves query methods, so changing the prototype later misses cached
// pooled clients and would NOT actually simulate lost commit acknowledgements.
const originalQuery=pg.Client.prototype.query;
let afterCommit:(()=>Promise<void>)|null=null;
(pg.Client.prototype.query as any)=function(...args:any[]){
  const response=(originalQuery as any).apply(this,args);
  const text=typeof args[0]==="string" ? args[0] : args[0]?.text;
  if(!response?.then || !/\bCOMMIT\b/i.test(text ?? ""))return response;
  return response.then(async(value:any)=>{await afterCommit?.();return value;});
};
const {pool,db}=await import("../../server/db");
const {sql}=await import("drizzle-orm");
const {claimSfpRuntimeDeploymentOwner,renewSfpRuntimeDeploymentOwner}=await import("../../server/services/cro03/sfp-provider-operations");
const {processCanonicalImportRecoveryTick}=await import("../../server/services/canonical-import-recovery-worker");
const {providerImportEmails,materializeCanonicalProviderImportRow}=await import("../../server/services/canonical-provider-import");
const {LADDER_BUDGET_LOCK_KEY}=await import("../../server/services/cro03/shared-paid-budget-ledger");
const {CanonicalImportRecoveryFailure}=await import("../../server/services/canonical-import-recovery-outcomes");
const {CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION}=await import("../../server/services/canonical-import-recovery-contract");
const {claimCsvExecution,completeImportExecution}=await import("../../server/services/import-execution");
const {inputRows,seedExecution,syntheticRows,dispatchStoppedAfterBudget}=await import("./retained-recovery-fixtures");
const {seedNativeRetainedTopology,retainedNativeExecutionId,verifyRetainedBusinessRelationships}=await import("./retained-native-topology");
const phase=process.argv[2];
const probe=new pg.Client({connectionString:process.env.DATABASE_URL});await probe.connect();
let checks=0;
const check=(value:unknown,label:string)=>{assert(value,label);checks++;console.log(`PASS ${label}`);};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const items=async(execution:string)=>(await probe.query(`SELECT item.*,split_part(batch.idempotency_key,':',3)::int row_number,
  EXISTS(SELECT 1 FROM audit_logs receipt WHERE receipt.entity_type='cro03_enrichment_item'
    AND receipt.entity_key=item.id::text AND receipt.action='canonical_import_row_fulfilled'
    AND receipt.details->>'qualificationVersion'=$2) qualified
  FROM cro03_enrichment_items item JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id
  WHERE batch.idempotency_key LIKE $1 ORDER BY row_number`,
  [`csv-source:${execution}:%`,CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION])).rows;
const executions=async(kind:string)=>kind==="retained_original"
  ? (await probe.query("SELECT id,metadata FROM import_executions WHERE id=$1",
    [retainedNativeExecutionId()])).rows
  : (await probe.query("SELECT id,metadata FROM import_executions WHERE metadata->>'certificationKind'=$1",[kind])).rows;
const baseline=async()=>(await probe.query(`SELECT
  (SELECT count(*)::int FROM contacts) contacts,(SELECT count(*)::int FROM businesses) businesses,
  (SELECT count(*)::int FROM contact_source_events) provenance,
  (SELECT count(*)::int FROM provider_operations) provider_operations,
  (SELECT count(*)::int FROM communication_events) communications,
  (SELECT count(*)::int FROM validation_intents) validation_intents`)).rows[0];
const safetyBefore=await baseline();
const diagnostics:string[]=[];
const originalWarn=console.warn;
console.warn=(...args:any[])=>{diagnostics.push(args.join(" "));originalWarn(...args);};
let status=0;
try {
  if(phase==="faults"){
    const rows=syntheticRows(),execution=await seedExecution(rows,"faults");
    const target=(await items(execution))[0];
    await probe.query(`CREATE FUNCTION fixture_recovery_claim_notification() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='${target.id}'::uuid AND NEW.state='running' AND OLD.state<>'running'
        THEN PERFORM pg_notify('fixture_recovery_claim',NEW.id::text); END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_recovery_claim_notification AFTER UPDATE ON cro03_enrichment_items
      FOR EACH ROW EXECUTE FUNCTION fixture_recovery_claim_notification()`);
    const locker=new pg.Client({connectionString:process.env.DATABASE_URL});await locker.connect();
    const listener=new pg.Client({connectionString:process.env.DATABASE_URL});await listener.connect();
    let heldResolve:()=>void;const held=new Promise<void>(resolve=>{heldResolve=resolve;});
    listener.on("notification",()=>{
      void (async()=>{await locker.query("BEGIN");await locker.query("SELECT id FROM cro03_enrichment_items WHERE id=$1 FOR UPDATE",[target.id]);heldResolve();})()
        .catch(error=>{status=1;console.error("FIXTURE_LOCKER_FAILED",error.code);});
    });
    await listener.query("LISTEN fixture_recovery_claim");
    const tick=processCanonicalImportRecoveryTick({maxItems:2});
    await Promise.race([held,delay(5000).then(()=>{throw new Error("FIXTURE_CLAIM_NOTIFICATION_TIMEOUT");})]);
    const result=await tick;
    check(result.fulfilled===1 && result.failed===1 && result.cleanupFailed===1 && result.abandoned===1,
      "Native row/cleanup lock timeouts yield to a different eligible row under healthy authority");
    const retained=(await items(execution))[0];
    check(retained.state==="running" && retained.claim_token && retained.current_provider==="canonical_local_import",
      "Failed cleanup leaves the original claim intact, not an unfenced release");
    const errors=diagnostics.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const first=errors.find(e=>e.event==="canonical_import_recovery_original_error");
    const cleanup=errors.find(e=>e.event==="canonical_import_recovery_cleanup_error");
    check(first?.failureId===cleanup?.failureId && first?.sourceRowNumber===1,
      "Original and cleanup failures retain the same failure identity");
    await locker.query("ROLLBACK");await locker.end();await listener.end();
    await probe.query("DROP TRIGGER fixture_recovery_claim_notification ON cro03_enrichment_items; DROP FUNCTION fixture_recovery_claim_notification()");
    await probe.query("UPDATE cro03_enrichment_items SET lease_expires_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[target.id]);
    const {hasCanonicalImportRecoveryClaim}=await import("../../server/services/canonical-import-recovery-contract");
    check(!await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,{executionId:execution,sourceRowNumber:1,
      rowFingerprint:rows[0].rowFingerprint,recoveryClaim:{itemId:target.id,claimToken:retained.claim_token},renew:true})),
      "The native expiry predicate refuses to renew the expired original claim");
    await assert.rejects(()=>materializeCanonicalProviderImportRow({executionId:execution,sourceRowNumber:1,
      sourceFormat:rows[0].sourceFormat,rawRow:rows[0].rawRow,actorId:"fixture:stale",
      recoveryClaim:{itemId:target.id,claimToken:retained.claim_token}}),(error:any)=>{
        for(let current=error,depth=0;current && depth<6;current=current.cause,depth++)
          if(/LEASE_LOST|AUTHORITY_REJECTED|AUTHORITY_FENCE_LOST/.test(current.message ?? ""))return true;
        return false;
      });
    check(true,"An expired original token cannot materialize or revive the abandoned row");

    // Lose the reply AFTER a real native mailbox transaction commits.
    const partialRows=syntheticRows(1),partial=await seedExecution(partialRows,"commit_reply_loss");
    let loseReply=true;
    afterCommit=async()=>{
        if(!loseReply)return;
        const count=(await (originalQuery as any).call(probe,
          "SELECT count(*)::int n FROM contact_source_events WHERE import_execution_id=$1",[partial])).rows[0].n;
        if(count>0){loseReply=false;const error=new Error("FIXTURE_COMMIT_REPLY_LOST");Object.assign(error,{code:"ECONNRESET"});throw error;}
    };
    await assert.rejects(()=>processCanonicalImportRecoveryTick({maxItems:1}),
      (error:any)=>{
        if(!(error instanceof CanonicalImportRecoveryFailure))return false;
        for(let current:any=error,depth=0;current && depth<6;current=current.cause,depth++)
          if(current.code==="ECONNRESET")return true;
        return false;
      });
    afterCommit=null;
    check(!loseReply,"A genuinely committed mailbox with a lost reply is an explicit fatal outcome, never retried in-tick");
    const partialContacts=(await probe.query("SELECT count(DISTINCT contact_id)::int n FROM contact_source_events WHERE import_execution_id=$1",[partial])).rows[0].n;
    check(partialContacts===1 && (await items(partial))[0].state!=="completed",
      "One committed mailbox is not reported as a completed multi-mailbox row");
    await probe.query(`UPDATE cro03_enrichment_items item SET next_attempt_at=clock_timestamp()-interval '1 second'
      FROM cro03_enrichment_batches batch WHERE batch.id=item.batch_id AND batch.idempotency_key LIKE $1`,
    [`csv-source:${partial}:%`]);
  }else if(phase==="restart"){
    const result=await processCanonicalImportRecoveryTick({maxItems:4});
    check(result.fulfilled===2,"A fresh process reclaims abandoned work and resumes partial mailbox materialization");
    for(const kind of ["faults","commit_reply_loss"]){
      for(const execution of await executions(kind)){
        const count=(await probe.query("SELECT count(DISTINCT contact_id)::int n FROM contact_source_events WHERE import_execution_id=$1",[execution.id])).rows[0].n;
        const rowCount=(await items(execution.id)).length;
        check(count===rowCount*3 && (await items(execution.id)).every(item=>item.state==="completed"),
          `${kind}: every mailbox, not merely row accounting, survives restart`);
      }
    }
    const before=await baseline();await processCanonicalImportRecoveryTick();
    assert.deepEqual(await baseline(),before);check(true,"Restart replay creates no duplicate contacts, businesses or provenance");
  }else if(phase==="legacy"){
    const execution=await seedExecution(syntheticRows(1),"legacy_certificate");
    await processCanonicalImportRecoveryTick({maxItems:1});
    const before=await baseline(),item=(await items(execution))[0];
    await probe.query("UPDATE audit_logs SET details=details-'qualificationVersion' WHERE entity_key=$1 AND action='canonical_import_row_fulfilled'",[item.id]);
    await probe.query("UPDATE cro03_enrichment_items SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[item.id]);
    const verified=await processCanonicalImportRecoveryTick({maxItems:1});
    check(verified.fulfilled===1,"Previously completed rows lacking business-link qualification are reverified through the real source claim");
    assert.deepEqual(await baseline(),before);
    check(!(await processCanonicalImportRecoveryTick()).ran,"A qualified certificate stops repeated legacy reconciliation without duplicates");
    const conflictRows=syntheticRows(2);
    conflictRows[0].rawRow.name=`North Clinic ${randomUUID()}`;
    conflictRows[1].rawRow.name=`South Retail ${randomUUID()}`;
    for(const key of ["email_1","email_2","additional_emails"]){
      conflictRows[1].rawRow[key]=conflictRows[0].rawRow[key];
    }
    for(const row of conflictRows)row.rowFingerprint=createHash("sha256").update(JSON.stringify(row.rawRow)).digest("hex");
    const conflicting=await seedExecution(conflictRows,"shared_mailbox_conflict");
    await processCanonicalImportRecoveryTick({maxItems:2});
    const conflictingItems=await items(conflicting);
    assert(conflictingItems.every(item=>item.state==="completed"&&item.qualified));
    const shared=(await probe.query(`SELECT event.source_row_number,event.row_fingerprint,
      contact.id,contact.email,contact.business_id,business.canonical_name
      FROM contact_source_events event JOIN contacts contact ON contact.id=event.contact_id
      JOIN businesses business ON business.id=contact.business_id
      WHERE event.import_execution_id=$1`,[conflicting])).rows;
    assert.equal(shared.length,6);assert.equal(new Set(shared.map(contact=>contact.id)).size,6);
    assert.equal(new Set(shared.map(contact=>contact.business_id)).size,2);
    for(const row of conflictRows){
      const recipients=shared.filter(contact=>contact.source_row_number===row.sourceRowNumber);
      assert.deepEqual(recipients.map(contact=>contact.email).sort(),providerImportEmails(row.rawRow));
      assert(recipients.every(contact=>contact.row_fingerprint===row.rowFingerprint
        &&contact.canonical_name===row.rawRow.name));
    }
    check(true,"Distinct supported business identities sharing addresses keep separate people and exact provenance without transferring the first relationship");
  }else if(phase==="budget"){
    const rows=syntheticRows(1),execution=await seedExecution(rows,"held_budget");
    const owner=await claimSfpRuntimeDeploymentOwner();
    await probe.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[LADDER_BUDGET_LOCK_KEY]);
    const dispatch=dispatchStoppedAfterBudget()({operationId:randomUUID(),claimToken:randomUUID(),
      provider:"openai_classification",runtimeOwnerEpoch:owner.ownerEpoch,runtimeOwnerToken:owner.ownerToken})
      .then(()=>null,(error:any)=>error);
    let blocked=false;
    for(let n=0;n<100 && !blocked;n++){
      blocked=(await probe.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) blocked",[(probe as any).processID])).rows[0].blocked;
      if(!blocked)await delay(10);
    }
    check(blocked,"Actual dispatch transaction is held behind the real shared paid-budget lock");
    const leaseBefore=(await probe.query("SELECT lease_expires_at::text lease FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp'")).rows[0].lease;
    const claim=await claimSfpRuntimeDeploymentOwner();
    check(claim.ownerEpoch===owner.ownerEpoch && claim.ownerToken===owner.ownerToken,
      "Actual routine recovery claim verifies the live owner without exclusive handoff or token change");
    assert.equal((await probe.query("SELECT lease_expires_at::text lease FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp'")).rows[0].lease,leaseBefore);
    check(true,"Routine verification neither renews the lease nor mutates authority");
    const result=await processCanonicalImportRecoveryTick({maxItems:1});
    check(result.fulfilled===1 && result.failed===0 && (await items(execution))[0].state==="completed",
      "Actual recovery tick and real mailbox/business materialization commit while dispatch remains budget-blocked");
    check(result.authorityAcquisitionMs>=0 && result.rowProcessingMs>0,
      "Authority acquisition and row processing have separate truthful timings");
    await probe.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[LADDER_BUDGET_LOCK_KEY]);
    check((await dispatch)?.message==="FIXTURE_STOP_BEFORE_PROVIDER","Budget fixture ends before any provider dispatch");
    await probe.query("BEGIN");
    await probe.query("SELECT authority_key FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp' FOR UPDATE");
    await assert.rejects(()=>processCanonicalImportRecoveryTick({maxDurationMs:1}));
    const acquisition=diagnostics.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}})
      .filter(event=>event.event==="canonical_import_recovery_tick").at(-1);
    check(acquisition?.outcome==="authority_acquisition_failed" && acquisition.attempted===0 &&
      acquisition.fulfilled===0 && acquisition.rowProcessingMs===0 && acquisition.authorityAcquisitionMs>=900,
      "Bounded initial acquisition failure reports zero row work and its own wait duration");
    await probe.query("ROLLBACK");
    const excluded=syntheticRows(1);excluded[0].disposition="failed";excluded[0].reasonCode="IMPORT_ROW_FAILED";
    const excludedExecution=await seedExecution(excluded,"excluded_original_failure");
    const noWork=await processCanonicalImportRecoveryTick();
    check(!noWork.ran && (await items(excludedExecution))[0].state==="blocked",
      "Unrelated originally failed rows do not acquire the narrow staging-infrastructure retry authority");
    await assert.rejects(()=>renewSfpRuntimeDeploymentOwner({expectedOwner:{ownerEpoch:owner.ownerEpoch+1,ownerToken:owner.ownerToken}}),/FENCE_LOST/);
    await assert.rejects(()=>renewSfpRuntimeDeploymentOwner({expectedOwner:{ownerEpoch:owner.ownerEpoch,ownerToken:randomUUID()}}),/FENCE_LOST/);
    check(true,"The separate renewal path rejects stale epochs and tokens");
    await probe.query("UPDATE sfp_runtime_owner_authority SET lease_expires_at=clock_timestamp()+interval '20 seconds' WHERE authority_key='routine_sfp'");
    await processCanonicalImportRecoveryTick();
    const renewed=(await probe.query("SELECT owner_epoch,owner_token,lease_expires_at>clock_timestamp()+interval '90 seconds' live FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp'")).rows[0];
    check(Number(renewed.owner_epoch)===owner.ownerEpoch && renewed.owner_token===owner.ownerToken && renewed.live,
      "A near-expiry lease is legitimately renewed in a separate short fenced transition");
    await probe.query("UPDATE sfp_runtime_owner_authority SET revoked_at=clock_timestamp() WHERE authority_key='routine_sfp'");
    await assert.rejects(()=>processCanonicalImportRecoveryTick(),/OWNER_REVOKED/);
    check(true,"Actual initial recovery acquisition rejects a revoked owner");
    await probe.query("UPDATE sfp_runtime_owner_authority SET revoked_at=NULL,lease_expires_at=clock_timestamp()-interval '1 second' WHERE authority_key='routine_sfp'");
    await assert.rejects(()=>renewSfpRuntimeDeploymentOwner({expectedOwner:owner}),/FENCE_LOST/);
    const reclaimed=await claimSfpRuntimeDeploymentOwner();
    check(reclaimed.ownerEpoch>owner.ownerEpoch && reclaimed.ownerToken!==owner.ownerToken,
      "Expired authority cannot renew; legitimate reclamation rotates epoch and token");
  }else if(phase==="upload_interrupt"){
    // The actual September corpus has at most one mailbox per row. Exercise
    // future multi-mailbox upload with an explicitly controlled NEW input in
    // the exact restored native graph; never rewrite a historical source row.
    const native=syntheticRows(1)[0];
    const before=await baseline(),sourcePayload=[native.rawRow];
    const claim=await claimCsvExecution({fileHash:createHash("sha256").update(JSON.stringify(sourcePayload)).digest("hex"),
      totalRows:1,actorType:"import",actorId:"system:native-ordinary-upload",
      sourcePayload,metadata:{certificationKind:"native_ordinary_upload",sourceFormat:native.sourceFormat,
        controlledNewUpload:true,nativeOrdinaryBaseline:before}});
    assert(claim.claimed&&claim.claimToken);
    let loseReply=true;
    afterCommit=async()=>{
      if(!loseReply)return;
      const count=(await (originalQuery as any).call(probe,
        "SELECT count(*)::int n FROM contact_source_events WHERE import_execution_id=$1",[claim.execution.id])).rows[0].n;
      if(count===1){loseReply=false;throw Object.assign(new Error("FIXTURE_NATIVE_UPLOAD_COMMIT_REPLY_LOST"),{code:"ECONNRESET"});}
    };
    await assert.rejects(()=>materializeCanonicalProviderImportRow({executionId:claim.execution.id,
      claimToken:claim.claimToken!,sourceRowNumber:1,sourceFormat:native.sourceFormat,
      rawRow:native.rawRow,actorId:"system:native-ordinary-upload"}));
    afterCommit=null;
    check(!loseReply,"Ordinary native upload loses confirmation after exactly one real mailbox commit");
    const incomplete=await completeImportExecution({executionId:claim.execution.id,
      claimToken:claim.claimToken!,expectedRows:1});
    check(!incomplete.completed,"Original row accounting cannot complete an ordinary upload with an unfinished mailbox");
    assert((await baseline()).contacts<=before.contacts+1);
    assert.equal((await baseline()).businesses,before.businesses+1);
    await probe.query(`UPDATE import_executions SET lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE id=$1`,[claim.execution.id]);
  }else if(phase==="upload_restart"){
    const execution=(await probe.query(`SELECT * FROM import_executions
      WHERE metadata->>'certificationKind'='native_ordinary_upload'`)).rows[0];
    assert(execution);
    const raw=execution.source_payload[0],expected=providerImportEmails(raw),before=await baseline();
    const claim=await claimCsvExecution({fileHash:execution.file_hash,totalRows:1,
      actorType:"import",actorId:"system:native-ordinary-upload",sourcePayload:execution.source_payload,
      metadata:execution.metadata});
    assert.equal(claim.execution.id,execution.id);assert(claim.claimed&&claim.claimToken);
    const result=await materializeCanonicalProviderImportRow({executionId:execution.id,
      claimToken:claim.claimToken!,sourceRowNumber:1,sourceFormat:execution.metadata.sourceFormat,
      rawRow:raw,actorId:"system:native-ordinary-upload"});
    assert.equal(result.fulfillmentState,"completed");
    await completeImportExecution({executionId:execution.id,claimToken:claim.claimToken!,expectedRows:1});
    const proven=(await probe.query(`SELECT DISTINCT contact.id,contact.email,contact.business_id FROM contact_source_events event
      JOIN contacts contact ON contact.id=event.contact_id WHERE event.import_execution_id=$1`,[execution.id])).rows;
    assert.deepEqual(proven.map(contact=>contact.email.toLowerCase()).sort(),expected);
    assert(proven.every(contact=>contact.business_id===result.businessId));
    const created=(await probe.query("SELECT count(*)::int rows FROM contacts WHERE import_batch_id=$1",
      [execution.id])).rows[0].rows;
    assert(created<=expected.length);
    assert.equal((await baseline()).contacts,execution.metadata.nativeOrdinaryBaseline.contacts+created);
    assert.equal((await probe.query("SELECT count(*)::int rows FROM contact_source_events WHERE import_execution_id=$1",
      [execution.id])).rows[0].rows,expected.length);
    assert.equal((await baseline()).businesses,before.businesses);
    assert((await claimCsvExecution({fileHash:execution.file_hash,totalRows:1,
      actorType:"import",actorId:"system:native-ordinary-upload"})).replay);
    check(true,"A fresh ordinary process resumes every actual native mailbox and business link without duplicate people or businesses");
    const protectedRelationships=await verifyRetainedBusinessRelationships(probe);
    writeFileSync("/tmp/retained-native-upload-restart-report.json",JSON.stringify({
      phase:"ordinary_native_fresh_process_restart",expectedMailboxes:expected.length,
      provenMailboxes:proven.length,controlledNewUpload:true,
      ...protectedRelationships,providerCalls:0,outboundEffects:0},null,2));
  }else if(phase==="seed"){
    const rows=inputRows();
    const execution=await seedNativeRetainedTopology(rows,certificationEnvironment);
    check((await items(execution)).length===1472,"All original retained raw rows have one indexed source work item");
    check(rows.filter(row=>row.disposition==="failed" && row.reasonCode==="RECOVERY_PROVIDER_STAGING_FAILED").length===1,
      "The original infrastructure-failed row is preserved rather than rewritten as deferred");
  }else if(phase==="recover" || phase==="replay"){
    const original=(await executions("retained_original"))[0];assert(original);
    const rows=inputRows(),before=await baseline();
    const accountingBefore=(await probe.query("SELECT source_row_number,disposition,reason_code,row_fingerprint FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[original.id])).rows;
    if(phase==="replay")await probe.query(`UPDATE cro03_enrichment_items item SET state='blocked',
      terminal_code='STAGING_RECIPE_DISABLED',next_attempt_at=clock_timestamp()-interval '1 hour'
      FROM cro03_enrichment_batches batch WHERE batch.id=item.batch_id AND batch.idempotency_key LIKE $1`,
    [`csv-source:${original.id}:%`]);
    let transientFailures=0,cycles=0;
    for(;cycles<100;cycles++){
      const results=await Promise.allSettled([processCanonicalImportRecoveryTick(),processCanonicalImportRecoveryTick()]);
      for(const result of results)if(result.status==="rejected"){
        // No arbitrary error becomes acceptable just because another worker
        // happened to reclaim the owner before this result was observed.
        let authorityLoss=false;
        for(let error:any=result.reason,depth=0;error && depth<6;error=error.cause,depth++){
          if(/SFP_RUNTIME_OWNER_FENCE_LOST|CANONICAL_IMPORT_RECOVERY_RUNTIME_OWNER_CHANGED/.test(error.message ?? "")){
            authorityLoss=true;break;
          }
        }
        if(!authorityLoss)throw result.reason;
        transientFailures++;
      }
      const state=await items(original.id);
      console.log(JSON.stringify({event:"retained_fixture_cycle",phase,cycle:cycles+1,
         completed:state.filter(item=>item.state==="completed"&&item.qualified).length,
        running:state.filter(item=>item.state==="running").length}));
      const retry=state.filter(item=>item.state==="running" || item.terminal_code==="CANONICAL_IMPORT_RECOVERY_RETRY_REQUIRED");
      if(retry.length)await probe.query(`UPDATE cro03_enrichment_items SET
        lease_expires_at=CASE WHEN state='running' THEN clock_timestamp()-interval '1 second' ELSE lease_expires_at END,
        next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])`,[retry.map(item=>item.id)]);
       const eligible=state.filter(item=>(item.state==="completed"&&!item.qualified) ||
         item.terminal_code==="STAGING_RECIPE_DISABLED" || item.state==="running" ||
        item.terminal_code==="CANONICAL_IMPORT_RECOVERY_RETRY_REQUIRED");
      if(!eligible.length)break;
    }
    check(cycles<100,"Concurrent real recovery workers converge without unresolved retry/running work");
    const final=await items(original.id);
    const contacts=(await probe.query("SELECT id,email,business_id FROM contacts")).rows;
    const byId=new Map(contacts.map(contact=>[contact.id,contact]));
    const provenance=(await probe.query("SELECT contact_id,source_row_number,row_fingerprint FROM contact_source_events WHERE import_execution_id=$1",[original.id])).rows;
    const evidence=new Set(provenance.map(event=>`${event.source_row_number}:${event.row_fingerprint}:${event.contact_id}`));
    const audits=(await probe.query(`SELECT DISTINCT ON(entity_key) entity_key,details FROM audit_logs
      WHERE action='canonical_import_row_fulfilled' AND details->>'executionId'=$1 ORDER BY entity_key,created_at DESC`,[original.id])).rows;
    const receipts=new Map(audits.map(audit=>[audit.entity_key,audit.details]));
    const heldAudits=(await probe.query(`SELECT DISTINCT ON(entity_key) entity_key,details FROM audit_logs
      WHERE action='canonical_import_row_held' AND details->>'executionId'=$1 ORDER BY entity_key,created_at DESC`,[original.id])).rows;
    const holdEvidence=new Map(heldAudits.map(audit=>[audit.entity_key,audit.details]));
    const businessIds=new Set((await probe.query("SELECT id FROM businesses")).rows.map(row=>row.id));
    let mailboxes=0;const held:Record<string,number>={};
    const rowOutcomes=final.map(item=>{
      const raw=rows[item.row_number-1],expected=providerImportEmails(raw.rawRow);
      if(item.state==="completed"){
        assert.equal(item.terminal_code,"CANONICAL_LOCAL_IMPORT_FULFILLED");
        const receipt=receipts.get(item.id);assert(receipt && businessIds.has(receipt.businessId));
        const found=(receipt.contactIds as number[]).map(id=>byId.get(id)!);
        assert.deepEqual(found.map(contact=>contact.email.toLowerCase()).sort(),expected);
        for(const contact of found){assert.equal(contact.business_id,receipt.businessId,`LINKAGE_GAP_ROW_${item.row_number}`);
          assert(evidence.has(`${item.row_number}:${raw.rowFingerprint}:${contact.id}`));}
        mailboxes+=expected.length;
        return {row:item.row_number,outcome:"fulfilled",expectedMailboxes:expected.length,provenMailboxes:found.length};
      }
      assert.equal(item.state,"blocked");
      assert(/^CANONICAL_IMPORT_(AMBIGUOUS_ORGANIZATION_MATCH|BUSINESS_IDENTITY_MISSING|STABLE_SOURCE_CONFLICT|INSUFFICIENT|CONTACT_AFFILIATION_HELD|CONTACT_IDENTITY_AMBIGUOUS)/.test(item.terminal_code),
        `Unexplained retained-row hold ${item.row_number}: ${item.terminal_code}`);
      const heldReceipt=holdEvidence.get(item.id);
      assert(heldReceipt?.reasonCode===item.terminal_code && heldReceipt.rowFingerprint===raw.rowFingerprint);
      if(item.terminal_code==="CANONICAL_IMPORT_CONTACT_IDENTITY_AMBIGUOUS"){
        const candidates=heldReceipt.diagnostic.candidateContactIds;
        assert(Array.isArray(candidates)&&new Set(candidates).size>=2&&candidates.every((id:number)=>byId.has(id)),
          "Ambiguous-contact hold must retain the actual competing contact identities");
      }
      if(item.terminal_code==="CANONICAL_IMPORT_CONTACT_AFFILIATION_HELD"){
        const diagnostic=heldReceipt.diagnostic;
        assert(businessIds.has(diagnostic.businessId) && diagnostic.incomplete.length>0);
        assert(diagnostic.incomplete.every((contact:any)=>contact.business_id!==diagnostic.businessId));
      }
      held[item.terminal_code]=(held[item.terminal_code] ?? 0)+1;
      return {row:item.row_number,outcome:"held",reason:item.terminal_code,expectedMailboxes:expected.length,provenMailboxes:0};
    });
    assert.deepEqual((await probe.query("SELECT source_row_number,disposition,reason_code,row_fingerprint FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[original.id])).rows,accountingBefore);
    const protectedRelationships=await verifyRetainedBusinessRelationships(probe);
    check(true,"Every original projected relationship, decision and evidence row is preserved");
    check(true,"Every original row, expected mailbox, business link and fingerprint-bound provenance is reconciled; immutable dispositions unchanged");
    if(phase==="replay"){assert.deepEqual(await baseline(),before);check(true,"Full retained-workload materialization replay creates no contact, business or provenance duplicates");}
    const report={phase,rows:1472,fulfilled:final.filter(item=>item.state==="completed").length,
      held,provenMailboxes:mailboxes,cycles:cycles+1,explicitLeaseExpiryFailures:transientFailures,
      ...protectedRelationships,
      inputDigest:original.metadata.inputDigest,providerCalls:0,outboundEffects:0,rowOutcomes};
    writeFileSync(`/tmp/retained-recovery-${phase}-report.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify({...report,rowOutcomes:undefined}));
  }else throw new Error("RETAINED_CERTIFICATION_UNKNOWN_PHASE");
  const safetyAfter=await baseline();
  for(const key of ["provider_operations","communications","validation_intents"] as const)assert.equal(safetyAfter[key],safetyBefore[key]);
  check(getBlockedCertificationNetworkAttemptCount()===0,"Zero provider, outbound or nonselective validation admission attempts");
  console.log(`RETAINED_RECOVERY_PHASE_PASS ${phase} checks=${checks}`);
}catch(error:any){
  status=1;
  const {safeDatabaseFailure}=await import("../../server/lib/lock-trace");
  console.error("RETAINED_RECOVERY_PHASE_FAILED",phase,error?.message?.startsWith("Unexplained") ? error.message : error?.name,
    JSON.stringify(safeDatabaseFailure(error)),
    /^[A-Z0-9_:]+$/.test(error?.message ?? "") ? error.message : null,
    String(error?.stack).split("\n").find(line=>line.includes("retained-native-topology.ts")) ?? "",
    String(error?.stack).split("\n")
      .find(line=>line.includes("test-retained-canonical-import-recovery.ts")) ?? "");
}finally{
  afterCommit=null;
  pg.Client.prototype.query=originalQuery;console.warn=originalWarn;
  await probe.query("SELECT pg_advisory_unlock_all()");await probe.end();await pool.end();
}
// This is also the deliberate process boundary used to test restart. An
// optional read-only observer must not keep a finished disposable child alive.
process.exit(status);
