import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";
import {employeeSidebarFor, EMPLOYEE_SIDEBAR_ORDER} from "../client/src/lib/employee-sidebar";
import {adminAreas,adminAreaTabs,adminPermittedFor} from "../client/src/lib/crm-destination-state";

// C5 real-browser cutover smoke: real sessions for admin, manager and agent, compiled client, disposable database.
// Navigation and read-only observation only. Every /api route except the session/CSRF fixture answers 501, so
// this proves shell, routing, role-filtered sidebar and role fallback, not data-bearing panels. No writes, sends or providers.
const identity=await verifyCandidateIdentity();
const dir="docs/certification/stage3-c5/browser";
const clientRoot=path.resolve("dist/public");
const h=await stage3BHttpFixture(async app=>{
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C5 fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
const checks:string[]=[];
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);};
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
const results:Array<Record<string,unknown>>=[];
try{
  await mkdir(dir,{recursive:true});
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);
  for(const role of ["admin","manager","agent"] as const){
    const b=await privateStage3Browser(h.base,h.sessions.get(role)!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
    try{
      await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      const count=(s:string)=>b.evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`) as Promise<number>;
      const until=async(fn:()=>Promise<boolean>,label:string,tries=60)=>{for(let i=0;i<tries;i++){if(await fn())return;await settle(250);}throw new Error(`Timed out (${role}): ${label}`);};
      const expected=employeeSidebarFor(role);
      for(const item of expected){
        await b.navigate(item.href);
        await until(async()=>await count('[data-testid="nav-employee-sidebar"]')>0,`${item.entry.id} sidebar present`);
        const ids=await b.evaluate(`[...document.querySelectorAll('[data-testid="nav-employee-sidebar"] a')].map(a=>a.getAttribute('href'))`) as string[];
        if(item===expected[0]){
          check(JSON.stringify(ids)===JSON.stringify(expected.map(e=>e.href)),`${role}: sidebar lists ${expected.length} entries in exact order with role hrefs`);
          if(role!=="agent")check(expected.map(e=>e.entry.label).join()===[...EMPLOYEE_SIDEBAR_ORDER].join(),`${role}: all eleven labels in order`);
          else check(!expected.some(e=>e.entry.id==="campaigns"||e.entry.id==="administration"),"agent: no Campaigns or Administration");
        }
        const here=await b.evaluate("location.pathname") as string;
        check(here===item.href.split("?")[0],`${role}: ${item.entry.id} stays on ${item.href.split("?")[0]} (no redirect to login or forbidden) — now ${here}`);
        const active=await b.evaluate(`document.querySelector('[data-testid="nav-employee-sidebar"] a[aria-current="page"]')?.getAttribute('data-testid')??null`) as string|null;
        check(active===`link-sidebar-${item.entry.id}`,`${role}: ${item.entry.id} is the highlighted destination (got ${active})`);
        results.push({role,target:item.href,path:here,activeAria:active});
      }
      if(role!=="agent"){
        // All five Administration areas, per role: children mounted must equal the role's permitted children for
        // that area; an area with no permitted child must say so and fall back instead of mounting admin-only children.
        const permitted=adminPermittedFor(role) as readonly string[];
        for(const area of adminAreas){
          await b.navigate(`/dashboard/admin-hub?area=${area}`);
          await until(async()=>await count('[data-testid="page-administration"]')>0,`${role}: administration page for ${area}`);
          const tabs=(await b.evaluate(`[...document.querySelectorAll('[data-testid^="tab-admin-"]')].map(e=>e.getAttribute('data-testid').replace('tab-admin-',''))`) as string[]).sort();
          const issue=await count('[data-testid="admin-selection-issue"]')>0;
          const expected=(adminAreaTabs[area] as readonly string[]).filter(t=>permitted.includes(t)).sort();
          results.push({role,administrationArea:area,tabs,selectionIssue:issue,expectedChildren:expected,path:await b.evaluate("location.pathname+location.search")});
          if(expected.length){
            check(!issue&&JSON.stringify(tabs)===JSON.stringify(expected),`${role}: Administration area ${area} mounts exactly its permitted children [${expected}] (got [${tabs}], issue ${issue})`);
          } else {
            check(issue,`${role}: Administration area ${area} has no permitted child, explains the fallback`);
            check(tabs.every(t=>permitted.includes(t)),`${role}: Administration area ${area} fallback mounts only permitted children (got [${tabs}])`);
          }
        }
        if(role==="manager")check(await count('[data-testid="tab-admin-automations"]')===0,"manager: admin-only automations child is not mounted");
      } else {
        await b.navigate("/dashboard/admin-hub");
        await settle(1500);
        const here=await b.evaluate("location.pathname") as string;
        const mounted=await count('[data-testid="page-administration"]');
        results.push({role,administrationDirect:{path:here,administrationMounted:mounted}});
        check(mounted===0,`agent: Administration is not mounted on /dashboard/admin-hub (landed on ${here})`);
      }
      await b.navigate("/dashboard/knowledge-base");
      await until(async()=>await count('[data-testid="nav-employee-sidebar"]')>0,"resources sidebar");
      check(b.exceptions.length===0,`${role}: no uncaught browser exceptions (${b.exceptions.slice(0,2).join(" || ")})`);
    } finally { await b.close(); }
  }
  check(h.externalCalls()===0,"no external provider egress");
  await writeFile(`${dir}/receipt.json`,JSON.stringify({status:"passed",identity,fixture:h.prefix,checks,results,scope:"navigation/role/shell only; /api answered 501; no data-bearing panel proof"},null,2));
  console.log(`Stage 3 C5 browser smoke: PASS (${checks.length} checks)`);
} finally { await h.close(); }
