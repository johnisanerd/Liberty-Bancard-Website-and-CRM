import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {transform} from "esbuild";

// Actual route handoff block, dependency-isolated. No native/persistence claim.
const route=readFileSync("server/routes/imports.ts","utf8");
const start=route.indexOf('if (sourceFormat === "google_maps_outscraper" || sourceFormat === "apollo_lead_list") {');
const end=route.indexOf("const response = await processPersistedCsvImport(processingArgs);",start);
assert(start>=0 && end>start);
const {code}=await transform(`async function run(sourceFormat, processPersistedCsvImport,
 processingArgs, failCsvImportProjection, res, executionClaim, csvHash, importRecord, records, console) {
 ${route.slice(start,end)}
}`,{loader:"ts",target:"node22"});
const run=new Function(`${code};return run;`)() as (...args:any[])=>Promise<unknown>;
const records=[{name:"Guard-only input"}],claim={execution:{id:"same-execution"},claimToken:"same-token"};
const projection={id:9,executionId:"same-execution",status:"processing"};
const args={records,executionClaim:claim,importRecord:projection};
const errors:any[]=[];const logger={error:(...values:any[])=>errors.push(values)};
let response:any,status=0,processorCalls=0,cleanupClaim:any;
const res={status:(value:number)=>{status=value;return res;},json:(value:any)=>{response=value;return value;}};
let rejectWork!:(error:Error)=>void;
const work=new Promise((_resolve,reject)=>{rejectWork=reject;});
await run("google_maps_outscraper",(passed:any)=>{
  assert.equal(passed,args);processorCalls++;return work;
},args,async(passed:any)=>{cleanupClaim=passed;},res,claim,"original-hash",projection,records,logger);
assert.equal(processorCalls,1);assert.equal(status,202);
assert.equal(response.status,"processing");assert.equal(response.executionId,claim.execution.id);
assert.equal(response.fileHash,"original-hash");assert.equal(response.totalRows,1);
assert.equal(response.import,projection);
assert(!response.completed,"Accepted is never completed before processor settlement");

rejectWork(new Error("PROCESSOR_DENIED"));
await new Promise(resolve=>setImmediate(resolve));
assert.equal(cleanupClaim,claim,"Cleanup is fenced to this exact claim");
assert.equal(errors[0][1].message,"PROCESSOR_DENIED");

status=0;processorCalls=0;
await run("custom",()=>{processorCalls++;return Promise.resolve();},args,async()=>{},res,
  claim,"original-hash",projection,records,logger);
assert.equal(status,0);assert.equal(processorCalls,0,"Generic imports retain their awaited route");
const ui=readFileSync("client/src/pages/dashboard/LeadImports.tsx","utf8");
assert.match(ui,/if \(data.status === "processing"\)[\s\S]*?title: "Import Processing"[\s\S]*?return;/);
assert.match(ui,/refetchInterval:[^\n]*imp.status === "processing"/);
const liveStart=route.indexOf("const liveExecutions = new Set(executionStates.filter");
const liveEnd=route.indexOf("// Auto-mark",liveStart);
const branchStart=route.indexOf("if (imp.executionId && liveExecutions.has(imp.executionId))");
const branchEnd=route.indexOf('if (imp.status !== "processing") continue;',branchStart);
assert(liveStart>=0 && liveEnd>liveStart && branchEnd>branchStart);
const states=[
  {id:"healthy",status:"running",leaseExpiresAt:new Date(Date.now()+60_000)},
  {id:"expired",status:"running",leaseExpiresAt:new Date(Date.now()-60_000)},
  {id:"completed",status:"completed",leaseExpiresAt:new Date(Date.now()+60_000)},
];
const projections=[
  {executionId:"healthy",status:"interrupted"},
  {executionId:"expired",status:"processing"},
  {executionId:"completed",status:"completed"},
];
const derive=new Function("executionStates","imports",`
 ${route.slice(liveStart,liveEnd)}
 let staleChecks=0;
 for(const imp of imports){${route.slice(branchStart,branchEnd)}staleChecks++;}
 return {liveExecutions,staleChecks};
`);
const derived=derive(states,projections);
assert.deepEqual([...derived.liveExecutions],["healthy"]);
assert.equal(projections[0].status,"processing");
assert.equal(derived.staleChecks,2,"Only live native leases skip stale-projection interruption");
console.log(JSON.stringify({event:"PROVIDER_UPLOAD_HANDOFF_PASS",checks:5,
  acceptanceBeforeCompletion:true,exactClaimFailureCleanup:true,existingProcessor:true,
  pendingUiAndPolling:true,liveNativeLeaseOverridesStaleProjection:true,
  databaseWrites:0,providerCalls:0,outboundEffects:0}));
