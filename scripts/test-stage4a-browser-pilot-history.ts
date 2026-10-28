import assert from "node:assert/strict";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";

// Stage 4A F01: the pilot tab is a read-only history. Real session, compiled client, disposable database, private Chromium.
// States: loading / error / denied / empty / populated; viewports 1280, 768, 390; light and dark.
// Also the paid-provider emergency stop route: anonymous 401, wrong role 403. The stop is NEVER clicked or sent here.
await verifyCandidateIdentity();
const dir="generated-artifacts/stage4a-browser-pilot-history";
const clientRoot=path.resolve("dist/public");
const h=await stage3BHttpFixture(async app=>{
  (await import("../server/routes/lead-ops.ts")).registerLeadOpsRoutes(app);
  (await import("../server/routes/admin.ts")).registerAdminRoutes(app);
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated 4A fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
const checks:string[]=[];
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);};
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn:()=>Promise<boolean>,label:string,tries=80)=>{for(let i=0;i<tries;i++){if(await fn())return;await settle(250);}throw new Error(`Timed out: ${label}`);};
type B=Awaited<ReturnType<typeof privateStage3Browser>>;
const route="/dashboard/lead-ops?tab=pilot";
const SCHEDULE_KEY="candidate_backfill"; // allowed logical key; the fixture database starts with no schedule definitions
const viewports=[{w:1280,h:900,m:false},{w:768,h:1024,m:false},{w:390,h:844,m:true}];
let b:B|undefined;
try{
  await mkdir(dir,{recursive:true});
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);

  // ── Emergency stop route authority (request level only; never sent with an admin session) ──
  const anon=await fetch(`${h.base}/api/lead-ops/pilot/emergency-stop-paid`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  check(anon.status===401,`anonymous emergency stop is 401 (${anon.status})`);
  for(const role of ["manager","agent","merchant"]){
    const r=await h.request(role,"POST","/api/lead-ops/pilot/emergency-stop-paid",{reason:"fixture role check"});
    check(r.status===403,`${role} emergency stop is 403 (${r.status})`);
  }
  const stoppedAudit=(await h.pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action='paid_provider_emergency_stop'`)).rows[0].n;
  check(stoppedAudit===0,"the denied attempts stopped nothing and wrote no stop audit row");

  const count=(s:string)=>b!.evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`) as Promise<number>;
  const open=async(role:string,vp=viewports[0],dark=false)=>{
    b=await privateStage3Browser(h.base,h.sessions.get(role)!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
    await b.call("Emulation.setDeviceMetricsOverride",{width:vp.w,height:vp.h,deviceScaleFactor:1,mobile:vp.m});
    await b.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:dark?"dark":"light"}]});
    // Narrow viewports otherwise redirect to the mobile shell; this suite certifies the desktop-shell tab at narrow widths.
    await b.navigate("/login");
    await b.evaluate("localStorage.setItem('prefer_desktop','true');localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true')");
    return b;
  };
  const noControls=async(label:string)=>{
    const n=await b!.evaluate(`document.querySelector('[data-testid="pilot-history-panel"]').querySelectorAll('button,input,textarea,select,[role="switch"],[role="checkbox"]').length`);
    check(n===0,`${label}: the history panel has no buttons, inputs or switches`);
  };
  const noMutations=(label:string)=>{
    const bad=b!.requests.filter(r=>r.method!=="GET"&&/\/api\/(lead-ops\/pilot|admin\/cro08a)/.test(r.url));
    check(bad.length===0,`${label}: no non-GET request reached a pilot or CRO-08A route`);
  };

  // ── Empty (disposable DB has no pilot history) at all three viewports, light and dark ──
  for(const vp of viewports) for(const dark of [false,true]){
    const tag=`${vp.w}px ${dark?"dark":"light"}`;
    await open("admin",vp,dark);
    if(dark)await b!.evaluate(`document.documentElement.classList.add("dark")`);
    await b!.navigate(route);
    if(dark)await b!.evaluate(`document.documentElement.classList.add("dark")`);
    try{await until(async()=>await count('[data-testid="pilot-history-runs-empty"]')>0,`${tag} empty runs`);}
    catch(e){
      console.log("DIAG url:",await b!.evaluate("location.pathname+location.search"),"text:",String(await b!.evaluate("document.body.innerText")).slice(0,600).replace(/\s+/g," "),
        "panel:",await count('[data-testid="pilot-history-panel"]'),"loading:",await count('[data-testid$="-loading"]'),"errors:",await count('[data-testid$="-error"]'));
      await b!.screenshot(`diag-${vp.w}`);throw e;
    }
    check(await count('[data-testid="pilot-history-definitions-empty"]')===1&&await count('[data-testid="pilot-history-schedules-empty"]')===1,`${tag}: empty sections say none recorded`);
    check(await count('[data-testid="pilot-history-runs-error"]')===0,`${tag}: empty is not shown as an error`);
    await noControls(tag);
    const overflow=await b!.evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`);
    check(overflow===true,`${tag}: no horizontal overflow`);
    await b!.screenshot(`pilot-history-empty-${vp.w}-${dark?"dark":"light"}`);
    noMutations(tag);
    await b!.close();b=undefined;
  }

  // ── Populated (a recorded schedule definition) ──
  await h.pool.query(`INSERT INTO cro08a_schedule_definitions(logical_key,definition_version,purpose,cadence_cron,window_seconds,batch_size,concurrency_limit,timeout_ms,lease_ms,heartbeat_ms,downstream_owner,definition_hash,created_by)
    VALUES($1,1,'fixture history row','0 6 * * *',3600,10,1,1000,1000,1000,'fixture','${h.prefix}-hash','fixture')`,[SCHEDULE_KEY]);
  await open("admin");
  await b!.navigate(route);
  await until(async()=>(await b!.evaluate(`document.querySelector('[data-testid="pilot-history-schedules"]')?.innerText||""`) as string).includes(SCHEDULE_KEY),"populated schedule row");
  check(await count('[data-testid="pilot-history-schedules-empty"]')===0,"populated: the schedule section lists the recorded definition");
  await noControls("populated");noMutations("populated");
  const defs=(await h.pool.query(`SELECT active FROM cro08a_schedule_definitions WHERE logical_key=$1`,[SCHEDULE_KEY])).rows[0];
  check(defs.active===false,"viewing history did not activate or change the schedule definition");

  // ── Loading (delayed read) then Back/Forward/reload keep the same read-only state ──
  b.delayRead("/api/lead-ops/pilot/runs",3000);
  await b.navigate(route);
  await until(async()=>await count('[data-testid="pilot-history-runs-loading"]')>0,"loading indicator");
  check(true,"loading: the runs section shows a loading state while the read is slow");
  b.delayRead(null);
  await until(async()=>await count('[data-testid="pilot-history-runs-empty"]')>0,"loaded after delay");
  await b.navigate("/dashboard/lead-ops?tab=health");
  await until(async()=>await count('[data-testid="button-paid-provider-emergency-stop"]')>0,"emergency stop in Program Health");
  check(await count('[data-testid="button-paid-provider-emergency-stop"]')===1,"the emergency stop control is reachable from Program Health (not clicked)");
  check(b.requests.filter(r=>r.method==="POST"&&r.url.includes("emergency-stop-paid")).length===0,"nothing posted to the emergency stop route");
  await b.call("Page.navigateToHistoryEntry",{entryId:(await b.call("Page.getNavigationHistory")).entries.slice(-2)[0].id});
  await until(async()=>await count('[data-testid="pilot-history-panel"]')>0,"Back returns to history");
  await noControls("after Back");
  await b.navigate(route);
  await until(async()=>await count('[data-testid="pilot-history-panel"]')>0,"reload");
  await noControls("after reload");

  // ── Error: a failed read is unavailable, not empty ──
  b.failRead("/api/lead-ops/pilot/runs");
  await b.navigate(route);
  await until(async()=>await count('[data-testid="pilot-history-runs-error"]')>0,"error state");
  const errText=await b.evaluate(`document.querySelector('[data-testid="pilot-history-runs-error"]').innerText`) as string;
  check(/unavailable, not empty/.test(errText),"error: a failed read says unavailable, not empty");
  check(await count('[data-testid="pilot-history-runs-empty"]')===0,"error: the empty message is not shown for a failed read");
  b.failRead(null);
  await b.close();b=undefined;

  // ── Denied: a manager session gets 403 from the admin-only readers ──
  await open("manager");
  await b!.navigate(route);
  await until(async()=>(await count('[data-testid$="-error"]'))>0||(await count('[data-testid="pilot-history-panel"]'))===0,"denied or hidden");
  const deniedText=await b!.evaluate(`document.body.innerText`) as string;
  check(!(await count('[data-testid="pilot-history-runs-empty"]')),"denied: a manager never sees a false 'No pilot runs recorded'");
  check(/Access denied|administrator|not authorized|forbidden/i.test(deniedText)||(await count('[data-testid="pilot-history-panel"]'))===0,"denied: access is refused visibly or the panel is not mounted");
  noMutations("denied");
  await b!.close();b=undefined;

  check(h.externalCalls()===0,"no external provider call was made");
  console.log(`\n${checks.length} browser checks passed`);
  for(const c of checks)console.log("  ✅ "+c);
}finally{
  await h.pool.query(`DELETE FROM cro08a_schedule_definitions WHERE logical_key=$1`,[SCHEDULE_KEY]).catch(()=>{});
  await b?.close().catch(()=>{});
  await h.close();
}
