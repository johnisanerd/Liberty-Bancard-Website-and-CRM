import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {transform} from "esbuild";

// Executes the actual route's lease-check block with a simulated slow-row
// clock. This is a guard-unit regression, not native or production acceptance.
const route=readFileSync("server/routes/imports.ts","utf8");
const loop=route.indexOf("for (const [rowIndex, record] of records.entries()) {");
assert(loop>=0);
const prefix=route.slice(loop,route.indexOf("// Logical CSV rows",loop));
assert.match(prefix,/isProviderExport \|\| rowIndex % batchSize === 0/);
const guard=prefix.slice(prefix.indexOf("if ("),prefix.lastIndexOf("\n"));
const {code}=await transform(`async function run(isProviderExport,heartbeatImportExecution,onRow) {
 const batchSize=100,importExecution={id:"execution"},executionClaim={claimToken:"token"};
 for(let rowIndex=0;rowIndex<101;rowIndex++){
 ${guard}
 await onRow(rowIndex);
 }
}`,{loader:"ts",target:"node22"});
const run=new Function(`${code}; return run;`)() as
  (provider:boolean,renew:(id:string,token:string)=>Promise<boolean>,row:(i:number)=>Promise<void>)=>Promise<void>;
let now=0,until=300_000,calls=0,rows=0;
await run(true,async(id,token)=>{
  assert.equal(id,"execution");assert.equal(token,"token");calls++;
  if(now>=until)return false;
  until=now+300_000;return true;
},async()=>{now+=4_000;rows++;});
assert.equal(rows,101);assert.equal(calls,101);assert(now>300_000);

calls=0;rows=0;
await assert.rejects(run(true,async()=>++calls<3,async()=>{rows++;}),
  /IMPORT_EXECUTION_LEASE_LOST:execution/);
assert.equal(calls,3);assert.equal(rows,2,"No row work after denied renewal");
calls=0;
await run(false,async()=>{calls++;return true;},async()=>{});
assert.equal(calls,2,"Generic mapping retains its existing batch cadence");
console.log(JSON.stringify({event:"PROVIDER_UPLOAD_HEARTBEAT_GUARD_PASS",
  checks:3,slowRows:101,simulatedDurationMs:404_000,expiredOrReplacedTokenStops:true,
  databaseWrites:0,providerCalls:0,outboundEffects:0}));
