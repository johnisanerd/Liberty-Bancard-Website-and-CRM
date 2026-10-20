import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";

// C5 live negative-request proof. REAL route modules and REAL guards on a disposable migrated database; real
// persisted admin, manager and agent sessions over HTTP. Every registered /api route whose effective guard is
// admin-only is requested as manager and as agent and must answer 403 from the role guard (not 404/500, and
// never the handler's own response). Unauthenticated requests must never reach a handler (401, or 403 from CSRF
// on mutations). Admin-only reads are requested as admin to prove the 403 is role-specific. Nothing is sent and
// no provider is called; fixture fetch denial is asserted.
const dir="docs/certification/stage3-c5/browser";
const sampleId="00000000-0000-4000-8000-000000000001";
const h=await stage3BHttpFixture(async app=>{
  for(const [file,fn] of [["admin","registerAdminRoutes"],["knowledge-admin","registerKnowledgeAdminRoutes"],["documents","registerDocumentsRoutes"],
    ["permissions-audit","registerPermissionsAuditRoutes"],["integrations","registerIntegrationsRoutes"],["content","registerContentRoutes"],
    ["information-flow","registerInformationFlowRoutes"],["sdr","registerSdrRoutes"],["ghl-inbound-sync","registerGhlInboundSyncRoutes"]]){
    const module=await import(`../server/routes/${file}.ts`);module[fn](app);
  }
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C5 fixture"}));
},undefined,{backgroundProfile:"off"});
const checks:string[]=[];
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);};
try{
  await mkdir(dir,{recursive:true});
  const inv=await h.request("admin","GET","/api/admin/route-permissions");
  check(inv.status===200,`admin reads the registered route inventory (${inv.status})`);
  const routes=(inv.body as any).routes as Array<{method:string;path:string;access:string;roles:string[];unresolved?:string}>;
  const adminOnly=routes.filter(r=>r.access==="role"&&r.roles.length===1&&r.roles[0]==="admin"&&["GET","POST","PUT","PATCH","DELETE"].includes(r.method));
  const adminManager=routes.filter(r=>r.access==="role"&&r.roles.length===2&&r.roles.includes("admin")&&r.roles.includes("manager")&&r.method==="GET");
  check(adminOnly.length>=40,`inventory exposes admin-only routes to exercise (${adminOnly.length})`);
  const concrete=(p:string)=>p.replace(/:[A-Za-z0-9_]+\??/g,sampleId);
  const bodyFor=(m:string)=>m==="GET"||m==="DELETE"?undefined:{};
  const results:Array<Record<string,unknown>>=[];
  const bad:string[]=[];
  for(const r of adminOnly){
    const url=concrete(r.path);
    for(const role of ["manager","agent"] as const){
      const res=await h.request(role,r.method,url,bodyFor(r.method));
      const message=String((res.body as any)?.message??"");
      const ok=res.status===403&&/Requires role|Admin access required/.test(message);
      results.push({role,method:r.method,path:r.path,status:res.status});
      if(!ok)bad.push(`${role} ${r.method} ${r.path} -> ${res.status} ${message.slice(0,60)}`);
    }
    // unauthenticated: the handler must never answer
    const anon=await h.request("anonymous",r.method,url,bodyFor(r.method),false);
    results.push({role:"unauthenticated",method:r.method,path:r.path,status:anon.status});
    if(![401,403].includes(anon.status))bad.push(`unauthenticated ${r.method} ${r.path} -> ${anon.status}`);
  }
  check(bad.length===0,`every admin-only route denies manager (403 from the role guard), agent (403) and unauthenticated (401/403): ${bad.slice(0,8).join(" | ")}`);
  check(results.filter(x=>x.role==="manager").every(x=>x.status===403),`manager received 403 on all ${adminOnly.length} admin-only routes`);
  check(results.filter(x=>x.role==="agent").every(x=>x.status===403),`agent received 403 on all ${adminOnly.length} admin-only routes`);
  // admin and manager read routes: manager allowed on admin+manager GETs, agent denied
  const roleBad:string[]=[];
  for(const r of adminManager){
    const url=concrete(r.path);
    const m=await h.request("manager","GET",url);
    const a=await h.request("agent","GET",url);
    results.push({role:"manager",method:"GET",path:r.path,status:m.status,tier:"admin+manager"},{role:"agent",method:"GET",path:r.path,status:a.status,tier:"admin+manager"});
    if(m.status===401||m.status===403)roleBad.push(`manager GET ${r.path} -> ${m.status}`);
    if(a.status!==403)roleBad.push(`agent GET ${r.path} -> ${a.status}`);
  }
  check(roleBad.length===0,`admin+manager reads admit manager and deny agent (${adminManager.length} routes): ${roleBad.slice(0,6).join(" | ")}`);
  // role-specificity: admin is admitted by the same guards on a named safe read set
  const adminReads=["/api/admin/route-permissions","/api/admin/queue-holds","/api/admin/queue-holds/backlog-preview","/api/admin/ghl/inbound-contact-sync","/api/admin/processor-activation-snapshots","/api/sdr/sending-identities"];
  const adminResults:Record<string,number>={};
  for(const p of adminReads){
    const a=await h.request("admin","GET",p);const m=await h.request("manager","GET",p);const g=await h.request("agent","GET",p);
    adminResults[p]=a.status;
    check(a.status!==401&&a.status!==403,`admin is admitted to ${p} (${a.status})`);
    check(m.status===403&&g.status===403,`manager and agent are denied ${p} (${m.status}/${g.status})`);
  }
  // The incoming-sync control and step endpoints named by the GHL recheck
  for(const [method,p,body] of [["PATCH","/api/admin/ghl/inbound-contact-sync/control",{enabled:false}],["POST","/api/admin/ghl/inbound-contact-sync/preview",{}],
      ["POST",`/api/admin/ghl/inbound-contact-sync/${sampleId}/step`,{}],["POST",`/api/admin/ghl/inbound-contact-sync/${sampleId}/execute`,{previewHash:"a".repeat(64)}]] as const){
    for(const role of ["manager","agent"]){
      const res=await h.request(role,method,p,body);
      check(res.status===403,`${role} ${method} ${p.replace(sampleId,":runId")} -> 403 (${res.status})`);
    }
  }
  check(h.externalCalls()===0,"no external provider egress");
  await writeFile(`${dir}/role-negative-receipt.json`,JSON.stringify({status:"passed",fixture:h.prefix,checks,
    adminOnlyRoutes:adminOnly.length,adminManagerReads:adminManager.length,adminReadStatuses:adminResults,
    summary:{managerDenied:results.filter(x=>x.role==="manager"&&!x.tier).length,agentDenied:results.filter(x=>x.role==="agent"&&!x.tier).length,unauthenticated:results.filter(x=>x.role==="unauthenticated").length},
    results,
    scope:"real route modules and guards on a disposable migrated database over HTTP with persisted sessions; routes in modules not registered in this fixture are not covered"},null,2));
  console.log(`Stage 3 C5 role negative requests: PASS (${checks.length} checks; ${adminOnly.length} admin-only routes)`);
} finally { await h.close(); }
