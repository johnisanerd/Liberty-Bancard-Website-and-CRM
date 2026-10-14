import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {transform} from "esbuild";
import {isRecoverableImportRowFailure} from "../server/services/canonical-import-recovery-outcomes";

const source=readFileSync("server/services/csv-import-processor.ts","utf8");
const marker="} catch (error: any) {";
const starts=[source.indexOf(marker),source.indexOf(marker,source.indexOf("async function recoverProviderCsvImport"))];
let checks=0;
for(const start of starts){
  assert(start>=0);
  const end=source.indexOf("\n  }\n",start);
  const block=source.slice(start,end);
  const {code}=await transform(`async function run(error,isRecoverableImportRowFailure,recordImportRowDisposition){
    const executionId="same-execution",claimToken="same-token",sourceRowNumber=3,rowFingerprint="same-fingerprint";
    try{throw error;${block}
  }`,{loader:"ts",target:"node22"});
  const run=new Function(`${code};return run;`)();
  for(const failure of [
    Object.assign(new Error("idle session terminated"),{code:"25P03"}),
    Object.assign(new Error("connection lost"),{code:"ECONNRESET"}),
    new Error("IMPORT_EXECUTION_LEASE_LOST"),
    new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING"),
    new Error("unknown confirmation"),
  ]){
    let writes=0;
    await assert.rejects(run(failure,isRecoverableImportRowFailure,async()=>{writes++;}),
      error=>error===failure);
    assert.equal(writes,0,"No irreversible failure receipt for an uncertain outcome");
    checks++;
  }
  const confirmed=Object.assign(new Error("lock aborted"),{code:"55P03"});
  let writes=0;
  await run(confirmed,isRecoverableImportRowFailure,async(input:any)=>{
    writes++;assert.equal(input.executionId,"same-execution");
    assert.equal(input.claimToken,"same-token");assert.equal(input.sourceRowNumber,3);
  });
  assert.equal(writes,1);checks++;
  const cleanup=Object.assign(new Error("failure-write connection lost"),{code:"ECONNRESET"});
  await assert.rejects(run(confirmed,isRecoverableImportRowFailure,async()=>{throw cleanup;}),
    (error:any)=>error.cause.originalError===confirmed && error.cause.cleanupError===cleanup &&
      !isRecoverableImportRowFailure(error));
  checks++;
}
console.log(JSON.stringify({event:"CSV_RECOVERY_FAILURE_BOUNDARY_PASS",checks,
  uncertainFailureWrites:0,exactClaim:true,originalAndCleanupPreserved:true,
  databaseWrites:0,providerCalls:0,outboundEffects:0}));
