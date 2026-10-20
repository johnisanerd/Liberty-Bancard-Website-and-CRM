import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";
import {financialState,financialUrl,financialViews,systemState,systemUrl,operatorAliasUrl,
  operatorViews,parseLocalEntityId,contactSections,leadOpsSections,stagingSections,canonicalSections,
  recordSectionState,prospectingState,safeFragment,peopleState,peopleHubState} from "../client/src/lib/crm-destination-state";
import {crmRoutes,buildCrmDestination} from "../client/src/lib/crm-route-registry";
let checks=0;
const lockedLayers=Object.entries(JSON.parse(fs.readFileSync("package-lock.json","utf8")).packages)
  .filter(([key])=>key.endsWith("/@radix-ui/react-dismissable-layer"))
  .map(([,value])=>(value as {version:string}).version);
assert.deepEqual(lockedLayers,["1.1.11"],"nested portals must share one dismissal context");checks++;
// Execute the actual shipped worker against a retained URL-only response.
const events:Record<string,Function>={};
const cached=new Map<string,Response>();
let clientPath="/mobile",offline=false;
const workerCache={put:async(request:Request,response:Response)=>{cached.set(request.url,response);}};
const workerSelf={registration:{scope:"http://candidate.test/"},clients:{get:async()=>({url:"http://candidate.test"+clientPath})},
  addEventListener:(name:string,handler:Function)=>{events[name]=handler;}};
vm.runInNewContext(fs.readFileSync("client/public/sw.js","utf8"),{
  self:workerSelf,URL,Response,Date,
  caches:{open:async()=>workerCache,match:async(request:Request)=>cached.get(request.url)?.clone()},
  fetch:async()=>{if(offline)throw new Error("isolated offline");return Response.json({owner:"current"});},
});
async function workerRead(){
  let response!:Promise<Response>;
  events.fetch({clientId:"isolated",request:new Request("http://candidate.test/api/contacts"),
    respondWith:(value:Promise<Response>)=>{response=value;}});
  return response;
}
await workerRead();
offline=true;
assert.deepEqual(await (await workerRead()).json(),{owner:"current"},"retained mobile behavior unchanged");
clientPath="/dashboard/contacts";
assert.equal((await workerRead()).status,503,"employee never resurrects URL-only protected cache");
offline=false;
assert.deepEqual(await (await workerRead()).json(),{owner:"current"},"employee reads current network");
assert.equal(peopleHubState("tab=leads").value,"leads");
assert.equal(peopleHubState("tab=leads&tab=people").value,"people");
assert.equal(peopleHubState("tab=leads&tab=people").issues[0].kind,"conflict");
assert.equal(peopleHubState("tab=unknown").value,"people");
assert.equal(peopleHubState("tab=prospect-staging").value,"prospect-staging");
assert.deepEqual(crmRoutes.find(row=>row.pattern==="/dashboard/contacts")!.wrapperRoles,["admin","manager","agent"]);
assert.equal(peopleState("archived=true",false).params.get("archived"),null);
assert.equal(peopleState("archived=true",false).issues[0].kind,"forbidden");
assert.equal(peopleState("archived=true",true).params.get("archived"),"true");
assert.equal(peopleState("limit=25&limit=100&offset=70",true).params.get("limit"),"50");
assert.equal(peopleState("limit=25&limit=25&offset=70",true).params.get("offset"),"50");
assert.equal(peopleState("sort=unsupported&recordClass=not-real",true).params.get("recordClass"),"production");
checks+=6;
assert.equal(peopleState("assignedToMe=true",true).params.has("assignedToMe"),false);
assert.equal(peopleState("assignedToMe=true",true).issues[0].kind,"forbidden");
assert.equal(peopleState("assignedToMe=true",false,true).params.get("assignedToMe"),"true");
assert.equal(peopleState("assignedToMe=true&assignedToMe=false",false,true).params.has("assignedToMe"),false);
checks+=4;
const check=(value:unknown,message:string)=>{assert.ok(value,message);checks++;};
const app=fs.readFileSync("client/src/App.tsx","utf8");
const patterns=[...new Set([...app.matchAll(/path="(\/dashboard[^"]*)"/g)].map(m=>m[1]))].sort();
assert.deepEqual(crmRoutes.map(r=>r.pattern).sort(),patterns);checks++;
check(crmRoutes.length===147 && new Set(crmRoutes.map(r=>r.id)).size===147,"complete single-owner registry");
assert.deepEqual(["C2","C3","C4","C5"].map(owner=>crmRoutes.filter(r=>r.owner===owner).length),[25,24,39,59]);checks++;
for(const r of crmRoutes) {
  check(r.sourceDeclarations.length>0 && r.outcomes.forbidden && r.futureTarget && r.guard,`contracts ${r.id}`);
}
const panels=JSON.parse(fs.readFileSync("docs/certification/stage3-c1/panel-dispositions.json","utf8"));
check(panels.length===309 && new Set(panels.map((p:any)=>p.id)).size===309,"historical panel census");
assert.deepEqual(["C2","C3","C4","C5"].map(owner=>panels.filter((p:any)=>p.owner===owner).length),[30,28,70,181]);checks++;
const provenance=JSON.parse(fs.readFileSync("docs/certification/stage3-c1/provenance.json","utf8"));
for(const input of provenance.inputs) {
  const hash=crypto.createHash("sha256").update(fs.readFileSync(`docs/certification/stage3-c1/${input.portable}`)).digest("hex");
  check(hash===input.sha256,`exact portable hash ${input.portable}`);
}
for(const child of financialViews) {
  const url=financialUrl(`tab=${child}&dealId=42&unknown=secret`,"#history");
  check(url===`/dashboard/reporting?dealId=42&tab=financial&financialTab=${child}#history`,"financial alias context");
  check(financialState(new URL(url,"http://candidate.test").search).value===child,"financial roundtrip");
  check(financialState(`financialTab=${child}&financialTab=${child}`).issues.length===0,"equal duplicates collapse");
  check(financialState(`tab=revenue&financialTab=${child}`).value===child,"explicit child wins legacy");
}
for(const query of ["financialTab=bad","financialTab=forecasting&financialTab=terminal-roi","tab=forecasting&tab=revenue"]) {
  check(financialState(query).issues.length===1 && financialUrl(query).includes("selectionIssue="),"financial explicit invalid/conflict");
}
for(const view of operatorViews) {
  const url=operatorAliasUrl(`tab=${view}&contactId=12`,"#history");
  const params=new URL(url,"http://candidate.test").searchParams;
  check(params.getAll("tab").length===1 && params.get("tab")==="monitor" && params.get("view")===view,"operator parent retained");
  check(systemState(params.toString(),true).view===view,"operator roundtrip");
}
check(systemState("tab=monitor&view=score-all",false).tab==="readiness","manager monitor does not mount");
check(systemState("tab=incidents",false).issues[0].kind==="forbidden","explicit child denial");
check(systemState("tab=monitor&tab=seo",true).issues[0].kind==="conflict","parent conflict");
check(!systemUrl("tab=monitor&view=lifecycle&contactId=12","#history","seo").includes("view="),"departure clears incompatible child only");
check(parseLocalEntityId("contactId","12") && !parseLocalEntityId("contactId","Jane"),"no name resolution");
check(!parseLocalEntityId("contactId","1.5") && !parseLocalEntityId("contactId","1e1"),"no numeric partial/alternate identity resolution");
check(parseLocalEntityId("businessId","12") && !parseLocalEntityId("businessId","0"),"business local integer namespace");
check(buildCrmDestination("R-008",{kind:"contactId",value:"12"},new URLSearchParams(),"#history")==="/dashboard/contacts/12#history","typed record anchor");
assert.throws(()=>buildCrmDestination("R-008",{kind:"contactId",value:"Jane"}));checks++;
assert.throws(()=>buildCrmDestination("R-008",{kind:"businessId",value:"12"}));checks++;
check(!safeFragment("#../../external") && !safeFragment("#"+ "a".repeat(100)),"fragment policy");
check(contactSections.length===25 && leadOpsSections.length===13 && stagingSections.length===2 && canonicalSections.length===6,"published section denominations");
for(const section of contactSections)check(recordSectionState(`section=${section}`).value===section,"Contact25 codec");
for(const tab of leadOpsSections)check(prospectingState(`tab=${tab}`).tab.value===tab,"LeadOps13 codec");
for(const staging of stagingSections)check(prospectingState(`stagingView=${staging}`).staging.value===staging,"staging2 codec");
for(const canonical of canonicalSections)check(prospectingState(`canonicalView=${canonical}`).canonical.value===canonical,"Canonical6 codec");
check(!fs.readFileSync("client/index.html","utf8").includes("maximum-scale"),"CSR zoom");
check(!fs.readFileSync("server/ssrShared.ts","utf8").includes("maximum-scale"),"SSR zoom");
check(fs.readFileSync("client/src/styles/crm-theme.css","utf8").includes("container-name: crm-page"),"named worklist container query has a real container");
const workflowConfig=fs.readFileSync(".replit","utf8");
const projectWorkflow=workflowConfig.split("[[workflows.workflow]]").find(block=>/name = "Project"/.test(block))!;
check(projectWorkflow.includes('args = "Start application"')&&!projectWorkflow.includes('args = "C1 isolated cloud preview"'),"default run retains normal app without competing synthetic preview");
check(workflowConfig.includes('name = "C1 isolated cloud preview"'),"isolated preview remains separately invokable");
console.log(`PASS ${checks} C1 registry, portable hashes, codecs and namespaces; source/unit proof only, not mounted acceptance.`);
