import assert from "node:assert/strict";
import {build} from "esbuild";
import {PgDialect} from "drizzle-orm/pg-core";

// Execute the actual worker with process-local injected boundaries. No database,
// lease, owner or native writer is mocked in the separate PostgreSQL certification.
const state:any={};
let pages:any[]=[],failId:number|null=null,processed:number[]=[],checks=0;
let changeOwner=false,expire=false;
const dialect=new PgDialect();
const owner={ownerEpoch:1,ownerToken:"owner"};
const tx={execute:async(q:any)=>{
  const compiled=dialect.sqlToQuery(q);
  if(compiled.sql.includes("RETURNING value")) {
    state.leaseToken=compiled.params[0]; state.leaseUntil="2099-01-01";
    return {rows:[{value:structuredClone(state),scan_time:"2026-10-15 01:00:00.000001+00"}]};
  }
  return {rows:[{value:structuredClone(state),live:!expire}]};
}};
const deps:any={
  db:{transaction:async(fn:any)=>fn(tx)},
  pool:{query:async(query:string,args:any[])=>{
    if(query.startsWith("SELECT value"))return {rows:[{value:structuredClone(state)}],rowCount:1};
    if(query.includes("SET value=$2")) {
      if(args[2]!==state.leaseToken || expire)return {rowCount:0};
      Object.assign(state,JSON.parse(args[1]));return {rowCount:1};
    }
    return {rows:[],rowCount:0};
  }},
  assertSystemLinkDatabaseGuard:async()=>{},
  claimSfpRuntimeDeploymentOwner:async()=>owner,
  lockCurrentSfpRuntimeOwner:async()=>changeOwner ? {...owner,ownerEpoch:2}:owner,
  runCanonicalTransaction:async(_name:any,fn:any)=>fn(),
  previewContactBusinessSystemLinks:async()=>pages.shift(),
  applyContactBusinessSystemLink:async(candidate:any,authority:any)=>{
    await authority(tx);
    if(candidate.contactId===failId)throw Error("INJECTED_WRITER_INTERRUPTION");
    processed.push(candidate.contactId);return {status:"applied"};
  },
  initializeImportedLinkedContactClass:async()=>{},
  materializeSupportedContactBusiness:async()=>{throw Error("UNEXPECTED_MATERIALIZATION");},
  loadEvidenceRelationshipPage:async()=>{throw Error("UNEXPECTED_POINT_READ");},
  readContactLinkAssignmentPopulation:async()=>({state:"unavailable"}),
};
(globalThis as any).__incrementalTest=deps;
const result=await build({
  entryPoints:["server/services/contact-link-automation.ts"],bundle:true,platform:"node",format:"esm",write:false,
  plugins:[{name:"boundary-injection",setup(builder){
    builder.onResolve({filter:/^\./},args=>{
      if(args.importer.endsWith("contact-link-automation.ts"))return {path:args.path,namespace:"injected"};
    });
    builder.onLoad({filter:/.*/,namespace:"injected"},()=>({
      contents:Object.keys(deps).map(name=>`export const ${name}=globalThis.__incrementalTest.${name};`).join("\n"),
      loader:"js",
    }));
  }}],
});
const {processContactLinkAutomationTick}=await import("data:text/javascript;base64,"+
  Buffer.from(result.outputFiles[0].text).toString("base64"));
const reset=()=>{
  for(const key of Object.keys(state))delete state[key];
  Object.assign(state,{version:1,rule:"independent_guarded_system_links_v2",runId:"existing",
    enabled:true,authorizedBy:"operator",cursor:10,scanned:100,committed:2,replayed:0,held:98,
    reasons:{},leaseToken:null,leaseUntil:null,complete:false,backfillComplete:true,
    changedSince:"2026-10-03 13:06:25.56618+00",scanStartedAt:"2026-10-14 23:22:29.253717+00"});
  processed=[];failId=null;changeOwner=false;expire=false;
};
const page=(ids:number[],through:number,exhausted=false)=>({
  schemaReady:true,rows:ids.map(contactId=>({contactId,eligible:true})),
  inspectedThroughContactId:through,passExhausted:exhausted,nextCursor:exhausted?null:through,
});
const check=(x:unknown,label:string)=>{assert(x,label);checks++;};
reset();pages=[page([],35)];
await processContactLinkAutomationTick({maxPages:1});
check(state.cursor===35 && !state.complete && state.scanned===100,"Unchanged inspected checkpoint");
check(state.changedSince==="2026-10-03 13:06:25.56618+00" && state.runId==="existing","Window/run preserved");
pages=[page([40,50],60)];failId=50;
await assert.rejects(processContactLinkAutomationTick({maxPages:1}),/WRITER_INTERRUPTION/);checks++;
check(state.cursor===40 && !state.complete && state.leaseToken===null,"Crash cannot skip changed tail");
failId=null;pages=[page([50],60)];
await processContactLinkAutomationTick({maxPages:1});
check(state.cursor===60 && processed.join(",")==="40,50","Restart processes unfinished row once");
pages=[page([],75,true)];await processContactLinkAutomationTick({maxPages:1});
check(state.complete && state.cursor===75,"True exhaustion completes");
const previousStart=state.scanStartedAt;
pages=[page([],25)];await processContactLinkAutomationTick({maxPages:1});
check(state.changedSince===previousStart && state.backfillComplete && !state.complete,"Only next pass rolls window");
reset();pages=[page([20],35)];changeOwner=true;
await assert.rejects(processContactLinkAutomationTick({maxPages:1}),/RUNTIME_OWNER_CHANGED/);checks++;
check(state.cursor===10 && state.leaseToken===null,"Owner loss cannot advance unfinished contact");
reset();pages=[page([20],35)];expire=true;
await assert.rejects(processContactLinkAutomationTick({maxPages:1}),/LEASE_LOST/);checks++;
check(state.cursor===10,"Expired lease cannot checkpoint or clear another claim");
reset();pages=[page([20],35)];
// Inject a slow preview via its rows getter, not via a different worker copy.
pages=[{...page([20],35),get rows(){
  const end=Date.now()+20;while(Date.now()<end){};return [{contactId:20,eligible:true}];
}}];
await processContactLinkAutomationTick({maxPages:1,maxDurationMs:10});
check(state.cursor===10 && !state.complete,"Deadline retains unfinished changed contact");
console.log(JSON.stringify({checks,scope:"actual worker injected interruption/deadline/owner boundaries",productionAcceptance:false}));
delete (globalThis as any).__incrementalTest;
