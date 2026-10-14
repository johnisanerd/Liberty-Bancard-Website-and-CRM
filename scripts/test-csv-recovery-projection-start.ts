import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {transform} from "esbuild";

const source=readFileSync("server/services/import-execution.ts","utf8");
const start=source.indexOf("export async function startCsvImportProjection");
const end=source.indexOf("\n}",start)+2;
assert(start>=0 && end>start);
const {code}=await transform(source.slice(start,end).replace("export ",""),{loader:"ts",target:"node22"});
const run=new Function("db","sql",`${code};return startCsvImportProjection;`);
let calls=0;let rows:any[]=[{id:7}],captured:any;
const sql=(parts:TemplateStringsArray,...values:unknown[])=>({text:parts.join("?"),values});
const db={transaction:async(callback:(tx:any)=>Promise<unknown>)=>{
  calls++;return callback({execute:async(query:any)=>{captured=query;return {rows};}});
}};
const reopen=run(db,sql);
const claim={claimed:true,claimToken:"same-token",execution:{id:"same-execution"}};
assert.equal(await reopen({...claim,claimed:false}),false);
assert.equal(await reopen({...claim,claimToken:null}),false);assert.equal(calls,0);
assert.equal(await reopen(claim),true);
assert.deepEqual(captured.values,["same-execution","same-token"]);
assert.match(captured.text,/claim_token=.*status|status='running'[\s\S]*claim_token=/);
assert.match(captured.text,/projection.execution_id=pinned.id/);
assert.match(captured.text,/pinned.lease_expires_at>clock_timestamp\(\)/);
assert.match(captured.text,/status='processing'/);
assert.doesNotMatch(captured.text,/processed_rows\s*=|new_records\s*=/);
rows=[];assert.equal(await reopen(claim),false,"Expired/replaced claim cannot reopen a projection");
const recovery=readFileSync("server/services/csv-import-recovery.ts","utf8");
assert(recovery.indexOf("if (!await startCsvImportProjection(claim))")<recovery.indexOf("await process({"));
assert.match(source,/orderBy\(sql`[\s\S]*ASC NULLS FIRST`[\s\S]*asc\(importExecutions.startedAt\)[\s\S]*asc\(importExecutions.id\)/);
console.log(JSON.stringify({event:"CSV_RECOVERY_PROJECTION_START_PASS",checks:5,
  exactExecutionAndToken:true,liveLeaseRequired:true,countsNotReset:true,
  stableOldestFirst:true,databaseWrites:0}));
