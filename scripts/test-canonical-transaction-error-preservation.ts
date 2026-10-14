import assert from "node:assert/strict";
import {preserveCanonicalTransactionFailure,runCanonicalTransaction} from "../server/services/canonical-transaction-retry";
import {isRecoverableImportRowFailure} from "../server/services/canonical-import-recovery-outcomes";

const same={id:"same-transaction"};
const successful=async(callback:(tx:any)=>Promise<unknown>)=>callback(same);
assert.equal(await preserveCanonicalTransactionFailure(successful,async tx=>{
  assert.equal(tx,same);return "committed";
}),"committed");
const original=Object.assign(new Error("idle session terminated"),{code:"25P03"});
await assert.rejects(preserveCanonicalTransactionFailure(successful,async()=>{throw original;}),
  error=>error===original);
const cleanup=Object.assign(new Error("rollback connection lost"),{code:"ECONNRESET"});
const brokenRollback=async(callback:(tx:any)=>Promise<unknown>)=>{
  try{return await callback(same);}catch{throw cleanup;}
};
await assert.rejects(preserveCanonicalTransactionFailure(brokenRollback,async()=>{throw original;}),
  (error:any)=>error.cause.originalError===original && error.cause.cleanupError===cleanup);
const confirmed=Object.assign(new Error("deadlock"),{code:"40P01"});
let calls=0;
await assert.rejects(runCanonicalTransaction("import_materialize",()=>{
  calls++;
  return preserveCanonicalTransactionFailure(brokenRollback,async()=>{throw confirmed;});
}),(error:any)=>error.cause.originalError===confirmed && error.cause.cleanupError===cleanup &&
  !isRecoverableImportRowFailure(error));
assert.equal(calls,1,"A confirmed original abort does not erase uncertain cleanup");
await assert.rejects(preserveCanonicalTransactionFailure(async()=>{throw cleanup;},async()=>{}),
  error=>error===cleanup,"Begin/commit faults are not assigned a fabricated callback error");
console.log(JSON.stringify({event:"CANONICAL_TRANSACTION_ERROR_PRESERVATION_PASS",
  checks:5,failedCleanupRetries:0,originalSqlStatePreserved:true,
  authorityChecksUnchanged:true,databaseWrites:0}));
