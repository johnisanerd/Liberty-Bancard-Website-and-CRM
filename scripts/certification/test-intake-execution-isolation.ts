import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"intake-execution-isolation",requireRedis:false});
const {pool}=await import("../../server/db");
const {claimCsvExecution,failCsvImportProjection,recordImportRowDisposition,completeImportExecution}=
  await import("../../server/services/import-execution");
const {resumeExpiredCsvImports}=await import("../../server/services/csv-import-recovery");
let checks=0;
try {
  const claims=[];
  for(let i=0;i<3;i++){
    const claim=await claimCsvExecution({fileHash:randomUUID(),totalRows:1,
      actorType:"system",actorId:"isolation-test",sourcePayload:[{row:String(i)}],
      metadata:{sourceFormat:"custom",fileName:`isolation-${i}.csv`}});
    claims.push(claim);
    await pool.query(`INSERT INTO csv_imports(execution_id,file_name,source_format,total_rows,status)
      VALUES($1,$2,'custom',1,'processing')`,[claim.execution.id,`isolation-${i}.csv`]);
  }
  assert(!await failCsvImportProjection({...claims[2],claimed:false,claimToken:null}));checks++;
   assert(await failCsvImportProjection(claims[2],new Error("CERT_FAILURE")));checks++;
   const recorded=(await pool.query(`SELECT metadata->'canonicalRecoveryLastFailure' failure
     FROM import_executions WHERE id=$1`,[claims[2].execution.id])).rows[0].failure;
   assert.equal(recorded.version,1);assert(recorded.observedAt);checks+=2;
  assert.equal((await pool.query("SELECT count(*)::int n FROM csv_imports WHERE status='processing'")).rows[0].n,2);checks++;
  assert(!await failCsvImportProjection({...claims[0],claimToken:randomUUID()}));checks++;
  // Expire the first two; a real confirmed constraint abort in one must not
  // suppress the next execution's durable accounting commit.
  await pool.query(`UPDATE import_executions SET lease_expires_at=now()-INTERVAL '1 minute'
    WHERE id IN($1,$2)`,[claims[0].execution.id,claims[1].execution.id]);
  let committed=0;
  const resumed=await resumeExpiredCsvImports(async ({executionClaim})=>{
    if(executionClaim.execution.id===claims[0].execution.id){
      await pool.query("INSERT INTO import_executions(id,import_type,execution_key) VALUES($1,'csv_contact',$2)",
        [executionClaim.execution.id,randomUUID()]);
    } else {
      await recordImportRowDisposition({executionId:executionClaim.execution.id,
        claimToken:executionClaim.claimToken!,sourceRowNumber:1,rowFingerprint:"isolated-row",
        disposition:"matched_noop",reasonCode:"ISOLATED_TEST_COMMIT"});
      assert((await completeImportExecution({executionId:executionClaim.execution.id,
        claimToken:executionClaim.claimToken!,expectedRows:1})).completed);
      committed++;
    }
  });
  assert.equal(resumed,1);assert.equal(committed,1);checks+=2;
  // A fatal authority error still stops the affected boundary, not retryable.
  await pool.query("UPDATE import_executions SET lease_expires_at=now()-INTERVAL '1 minute' WHERE id=$1",[claims[0].execution.id]);
  await assert.rejects(()=>resumeExpiredCsvImports(async()=>{throw new Error("IMPORT_EXECUTION_LEASE_LOST");}),
    /LEASE_LOST/);checks++;
   const {getImportLedgerSummary}=await import("../../server/services/import-execution");
   const failureSummary=await getImportLedgerSummary(claims[0].execution.id);
   assert(failureSummary.recovery?.lastFailure);
   assert.equal(failureSummary.recovery?.nextAutomaticAction,"claim_expired_persisted_execution");
   assert.equal(failureSummary.recovery?.executionStatus,"running");checks+=3;
   await pool.query("UPDATE import_executions SET source_payload=NULL WHERE id=$1",[claims[2].execution.id]);
   const missingSource=await getImportLedgerSummary(claims[2].execution.id);
   assert.equal(missingSource.recovery?.persistedSourceAvailable,false);
   assert.equal(missingSource.recovery?.nextAutomaticAction,null);
   assert.equal(missingSource.recovery?.nextEligibleAt,null);checks+=3;
  // Execute the shipped queue case with controlled dependencies. This proves
  // scheduling/error isolation, separately from the real native commits above.
  const queueSource=readFileSync("server/services/queue-manager.ts","utf8");
  const queueBody=queueSource.match(/case QUEUE_NAMES\.CANONICAL_IMPORT_RECOVERY:\s*\{([\s\S]*?)\n\s*break;/)?.[1];
  assert(queueBody,"Actual serial recovery queue case must exist");
   const executable=ts.transpile(queueBody.replace(/await import\("([^"]+)"\)/g,
     (_,path)=>`deps[${JSON.stringify(path)}]`),{target:ts.ScriptTarget.ES2022});
  const invoke=new Function("deps","console",`return (async()=>{${executable}})()`);
  const calls:string[]=[];
  const fallback=async()=>{};
  const dependencies={
    "./canonical-import-recovery-worker":{processCanonicalImportRecoveryTick:async()=>{
      calls.push("canonical");return {ran:true};
    }},
    "./csv-import-processor":{processPersistedCsvImport:fallback},
    "./csv-import-recovery":{resumeExpiredCsvImports:async(processor:unknown)=>{
      assert.equal(processor,fallback);calls.push("upload");throw new Error("CSV_UNKNOWN_COMMIT");
    }},
  };
  await assert.rejects(()=>invoke(dependencies,{log:()=>{}}),/CSV_UNKNOWN_COMMIT/);checks++;
  assert.deepEqual(calls,["canonical","upload"]);checks++;
  calls.length=0;
  dependencies["./canonical-import-recovery-worker"].processCanonicalImportRecoveryTick=async()=>{
    calls.push("canonical");throw new Error("CANONICAL_OWNER_LOST");
  };
   await assert.rejects(()=>invoke(dependencies,{log:()=>{}}),(error:any)=>{
     assert.equal(error.message,"CANONICAL_IMPORT_INDEPENDENT_BOUNDARIES_FAILED");
     assert.equal(error.cause.originalError.message,"CANONICAL_OWNER_LOST");
     assert.equal(error.cause.cleanupError.message,"CSV_UNKNOWN_COMMIT");return true;
   });
   assert.deepEqual(calls,["canonical","upload"]);checks+=3;
   calls.length=0;
   dependencies["./csv-import-recovery"].resumeExpiredCsvImports=async()=>{
     calls.push("upload");return 1;
   };
   await assert.rejects(()=>invoke(dependencies,{log:()=>{}}),/CANONICAL_OWNER_LOST/);
   assert.deepEqual(calls,["canonical","upload"]);checks+=2;
   calls.length=0;
   dependencies["./canonical-import-recovery-worker"].processCanonicalImportRecoveryTick=async()=>{
     calls.push("canonical");throw null;
   };
   let rejected=false;
   try {await invoke(dependencies,{log:()=>{}});}
   catch(error){rejected=true;assert.equal(error,null);}
   assert(rejected,"Falsy thrown failures must not report success");
   assert.deepEqual(calls,["canonical","upload"]);checks+=2;
  console.log(`Intake execution isolation: ${checks} checks passed`);
} finally {await pool.end();}
