import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";

// C5 data-bearing panels on a disposable, migrated database with the REAL route handlers for the
// Administration/Resources readers (permissions inventory, queue holds, readiness, knowledge). GHL Settings is mounted
// against owned stubs for the incoming-sync endpoint so ready/previewing/running/error/timeout can be driven.
// Measures compiled style, responsive overflow, labels and timing on the candidate. No write is submitted to a
// real handler, no provider is called, nothing is sent.
const identity=await verifyCandidateIdentity();
const dir="docs/certification/stage3-c5/browser";
const clientRoot=path.resolve("dist/public");
let inbound:{mode:"ready"|"previewing"|"running"|"error"|"timeout"}={mode:"ready"};
const counts={status:0,step:0};
const run=(state:string,nextAction:string|null)=>({runId:"c5-stub-run",state,createdAt:"2026-10-20T00:00:00.000Z",updatedAt:new Date().toISOString(),
  counts:{scanned:4,matched:3,wouldUpdate:1,wouldCreate:1,unchanged:2,conflicts:0,skipped:0,updated:0,created:0},previewHash:"h",nextAction,lastError:null,issues:[]});
const h=await stage3BHttpFixture(async app=>{
  const base="/api/admin/ghl/inbound-contact-sync";
  app.get(base,(_req,res)=>{counts.status++;
    if(inbound.mode==="error")return res.status(500).json({message:"stub failure"});
    if(inbound.mode==="timeout")return;// never answers
    const state=inbound.mode==="previewing"?"previewing":inbound.mode==="running"?"running":"ready";
    const next=inbound.mode==="previewing"?"scan":inbound.mode==="running"?"apply":null;
    res.json({environment:"development",configured:true,inboundEnabled:true,outboundPaused:true,run:run(state,next),
      runtime:{asOf:new Date().toISOString(),mode:"not_observed",owner:"not_observed",checkpoint:null,lastUpdatedAt:null,backlog:"unavailable",heartbeat:"not_observed",connectionProbe:"not_observed",freshness:"not_observed",freshnessThresholdMs:1000}});});
  app.post(`${base}/:id/step`,(_req,res)=>{counts.step++;res.json({run:run(inbound.mode==="running"?"running":"previewing",inbound.mode==="running"?"apply":"scan")});});
  app.get("/api/ghl/status",(_req,res)=>res.json({configured:true,hasApiKey:false,hasPrivateToken:true,hasLocationId:true,hasCalendarId:true}));
  app.get("/api/ghl/circuit-status",(_req,res)=>res.json({state:"closed",failures:0}));
  for(const [file,fn] of [["admin","registerAdminRoutes"],["knowledge-admin","registerKnowledgeAdminRoutes"],["documents","registerDocumentsRoutes"],["permissions-audit","registerPermissionsAuditRoutes"]]){
    const module=await import(`../server/routes/${file}.ts`);module[fn](app);
  }
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C5 fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
const checks:string[]=[];
const measurements:Record<string,unknown>={};
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);};
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
let b:Awaited<ReturnType<typeof privateStage3Browser>>|undefined;
try{
  await mkdir(dir,{recursive:true});
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);

  // ── Readiness on the migrated schema (real handler, real database) ──
  const rr=await h.request("admin","GET","/api/admin/launch-readiness-full");
  check(rr.status===200,`launch-readiness-full responds 200 (got ${rr.status})`);
  const rbody=rr.body as any;
  const subs:any[]=rbody.subsystems??[];
  measurements.readiness={total:subs.length,byStatus:subs.reduce((a:any,s:any)=>(a[s.status]=(a[s.status]??0)+1,a),{}),
    summary:rbody.summary??null};
  check(subs.length>=26,`readiness runs every registered probe (${subs.length})`);
  const schemaErrors=subs.filter(s=>/does not exist|undefined column|undefined table/i.test(JSON.stringify(s)));
  check(schemaErrors.length===0,`no probe fails on a missing column/table in the migrated schema (${schemaErrors.map(s=>s.name).join(", ")})`);
  const queryFailed=subs.filter(s=>/query (failed|error)|evidence unavailable/i.test(JSON.stringify(s))&&s.status==="pass");
  check(queryFailed.length===0,"no probe reports pass while its evidence query failed");

  const browser=async(role:string,width=1280)=>{
    const x=await privateStage3Browser(h.base,h.sessions.get(role)!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
    await x.call("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    return x;
  };
  const count=(s:string)=>b!.evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`) as Promise<number>;
  const until=async(fn:()=>Promise<boolean>,label:string,tries=80)=>{for(let i=0;i<tries;i++){if(await fn())return;await settle(250);}throw new Error(`Timed out: ${label}`);};
  const text=()=>b!.evaluate("document.body.innerText") as Promise<string>;
  const search=()=>b!.evaluate("location.search") as Promise<string>;

  b=await browser("admin");
  // ── Permissions: real registered inventory ──
  await b.navigate("/dashboard/permissions");
  await until(async()=>await count('[data-testid="page-permissions"]')>0,"permissions page");
  await until(async()=>await count('[data-testid^="row-route-"]')>0||await count('[data-testid="permissions-error"]')>0,"permissions rows or error");
  const permRows=await count('[data-testid^="row-route-"]');
  const permText=await b.evaluate(`document.querySelector('[data-testid="text-route-count"]')?.innerText||document.querySelector('[data-testid="text-permissions-summary"]')?.innerText||''`) as string;
  measurements.permissions={rows:permRows,summary:permText};
  check(permRows>0&&!/\b0 of 0\b/.test(permText),`permissions lists real registered routes (${permRows} rows; "${permText}")`);
  check(await count('[data-testid="permissions-error"]')===0,"permissions shows no error state when the census succeeds");
  const methods=await b.evaluate(`[...document.querySelectorAll('[data-testid^="text-method-"]')].map(e=>e.innerText.trim())`) as string[];
  check(methods.some(m=>/QUEUE|GET/.test(m)),"permissions shows methods");

  // ── Queue Holds: real DTO from the real handler ──
  await b.navigate("/dashboard/queue-holds");
  await until(async()=>(await count('[data-testid="card-hold-ledger"]'))>0||/Something went wrong|error details/i.test(await text()),"queue holds");
  check(!/Show error details|Something went wrong|is not a function/i.test(await text()),"Queue Holds renders without the application error boundary");
  await until(async()=>await count('[data-testid="outbound-pause-facts"]')>0,"pause facts",40).catch(async()=>{throw new Error("pause facts absent; page text: "+(await text()).slice(0,600).replace(/\s+/g," "));});
  check(await count('[data-testid="outbound-pause-facts"]')>0,"Queue Holds shows canonical pause facts");
  check(await count('[data-testid="physical-queues"]')>0||await count('[data-testid="hold-ledger-empty"]')>0||await count('[data-testid^="hold-"]')>0,"Queue Holds renders a ledger state");
  const holdPosts=b.requests.filter(r=>r.method!=="GET"&&r.url.startsWith("/api/admin/queue-holds")).length;
  check(holdPosts===0,"Queue Holds issued no write while rendering");

  // ── Knowledge Base / Admin: URL-addressable tabs, JSON receipts, labelled dialog, editor height ──
  await b.navigate("/dashboard/knowledge-base");
  await until(async()=>await count('[data-testid="page-knowledge-base"]')>0,"knowledge base");
  await b.navigate("/dashboard/knowledge-admin?tab=feedback");
  await until(async()=>await count('[data-testid="knowledge-admin-page"]')>0,"knowledge admin");
  const sel=await b.evaluate(`document.querySelector('[data-testid="tab-feedback"]')?.getAttribute('data-state')`);
  check(sel==="active","Knowledge Admin honours ?tab=feedback on entry");
  await b.click('[data-testid="tab-unanswered"]');
  await until(async()=>(await search()).includes("tab=unanswered"),"URL follows tab");
  check(true,"Knowledge Admin tab selection is written to the URL");
  await b.navigate("/dashboard/knowledge-admin?tab=unanswered");
  await until(async()=>await count('[data-testid="knowledge-admin-page"]')>0,"knowledge admin reload");
  check(await b.evaluate(`document.querySelector('[data-testid="tab-unanswered"]')?.getAttribute('data-state')`)==="active","reload restores the selected Knowledge Admin tab");
  await b.click('[data-testid="tab-sources"]');
  await until(async()=>await count('[data-testid="button-add-source"]')>0,"add source button");
  await b.click('[data-testid="button-add-source"]');
  await until(async()=>await count('[data-testid="textarea-source-content"]')>0,"source dialog");
  const dialog=await b.evaluate(`(()=>{
    const d=document.querySelector('[role=dialog]');const fields=[...d.querySelectorAll('input,textarea,select,[role=combobox]')];
    const unlabeled=fields.filter(f=>{if(f.type==='hidden')return false;const id=f.id;
      const byFor=id&&d.querySelector('label[for="'+CSS.escape(id)+'"]');const wrapped=f.closest('label');
      return !(byFor||wrapped||f.getAttribute('aria-label')||f.getAttribute('aria-labelledby'));}).map(f=>f.getAttribute('data-testid')||f.tagName);
    const ta=d.querySelector('[data-testid="textarea-source-content"]');const r=ta.getBoundingClientRect();
    const cs=getComputedStyle(ta);return {unlabeled,fieldCount:fields.length,editorHeight:r.height,editorFont:cs.fontFamily,editorFontSize:cs.fontSize};})()`) as any;
  measurements.knowledgeDialog=dialog;
  check(dialog.unlabeled.length===0,`every Knowledge dialog field has a programmatic label (unlabeled: ${dialog.unlabeled.join(",")})`);
  check(dialog.editorHeight>=160,`editor height is a measured usable height (${dialog.editorHeight}px, was 58px)`);
  await b.evaluate(`document.querySelector('[role=dialog] button[aria-label="Close"], [role=dialog] [data-testid="button-cancel-source"]')?.click()`);

  // ── Training and Settings Integrations selectors ──
  await b.navigate("/dashboard/training?tab=practice");
  await until(async()=>(await b!.evaluate(`document.querySelector('[role=tab][data-state=active]')?.innerText||''`) as string).length>0,"training tab");
  const trainingActive=await b.evaluate(`document.querySelector('[role=tab][data-state=active]')?.innerText`) as string;
  check(/practice/i.test(trainingActive),`Training honours ?tab=practice on entry (active: ${trainingActive})`);

  // ── Compiled style, responsive overflow and a11y facts per page ──
  const pages=["/dashboard/admin-hub?tab=users","/dashboard/permissions","/dashboard/queue-holds","/dashboard/knowledge-base","/dashboard/knowledge-admin","/dashboard/training"];
  const style:Record<string,unknown>[]=[];
  for(const width of [1280,768,390]){
    await b.call("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    await b.evaluate(`localStorage.setItem("prefer_desktop","true")`);
    for(const url of pages){
      const t0=Date.now();
      await b.navigate(url);
      await until(async()=>(await count("main h1, h1"))>0||(await count('[role=tab]'))>0,`${url} content @${width}`);
      const ms=Date.now()-t0;
      const m=await b.evaluate(`(()=>{
        const body=getComputedStyle(document.body);const tabs=[...document.querySelectorAll('[role=tab]')].map(t=>t.getBoundingClientRect().height);
        const h1s=document.querySelectorAll('h1').length;const imgs=[...document.querySelectorAll('img:not([alt])')].length;
        const unnamed=[...document.querySelectorAll('button')].filter(x=>x.getClientRects().length>0&&!(x.textContent.trim()||(x.labels&&x.labels.length)||x.getAttribute('aria-label')||x.getAttribute('aria-labelledby')||x.title));const btnNoName=unnamed.length;const unnamedWhich=unnamed.slice(0,6).map(x=>(x.getAttribute('data-testid')||'')+'|'+x.className.slice(0,60)+'|'+(x.closest('[data-testid]')?.getAttribute('data-testid')||'')+'|'+x.parentElement.outerHTML.replace(/class="[^"]*"/g,'').slice(0,420));
        return {unnamedWhich,font:body.fontFamily,overflow:document.documentElement.scrollWidth>innerWidth+1,minTab:tabs.length?Math.min(...tabs):null,h1s,imgs,btnNoName,
          mainLandmarks:document.querySelectorAll('main,[role=main]').length};})()`) as any;
      style.push({url,width,ms,...m});
      check(m.h1s===1,`${url} @${width}px exposes exactly one h1 (${m.h1s})`);
      check(!m.overflow,`${url} @${width}px has no horizontal page overflow`);
      check(/IBM Plex/i.test(m.font),`${url} @${width}px uses IBM Plex Sans (${m.font.slice(0,40)})`);
      check(m.imgs===0,`${url} @${width}px has no images without alt`);
      check(m.btnNoName===0,`${url} @${width}px has no unnamed buttons (${m.btnNoName}: ${(m.unnamedWhich||[]).join(' ; ')})`);
      if(m.minTab!==null&&url.includes("admin-hub"))check(m.minTab>=44||width<768,`${url} tab targets measure ≥44px (${m.minTab})`);
    }
  }
  measurements.style=style;
  check(b.exceptions.length===0,`no uncaught exceptions in the admin panel walk (${b.exceptions.slice(0,2).join(" || ")})`);
  await b.close();b=undefined;

  // ── GHL Settings: mounted, isolated, five server states; page must stay responsive and request-bounded ──
  const ghl:Record<string,unknown>={};
  for(const mode of ["ready","previewing","running","error","timeout"] as const){
    inbound.mode=mode;counts.status=0;counts.step=0;
    b=await browser("admin");
    const t0=Date.now();
    await b.navigate("/dashboard/ghl-integration?tab=settings");
    const reached=await (async()=>{for(let i=0;i<60;i++){if(await count('[data-testid="card-ghl-inbound-sync"]')>0)return Date.now()-t0;await settle(250);}return null;})();
    check(reached!==null,`GHL Settings (${mode}) mounts the incoming-sync card (${reached}ms)`);
    // responsiveness: main-thread frames + eval round-trips for 6 seconds
    const frames=await b.evaluate(`new Promise(res=>{let n=0;const end=performance.now()+6000;let worst=0,last=performance.now();
      const tick=()=>{const t=performance.now();worst=Math.max(worst,t-last);last=t;n++;if(t<end)requestAnimationFrame(tick);else res({n,worst});};requestAnimationFrame(tick);})`) as {n:number,worst:number};
    const rt0=Date.now();await b.evaluate("1+1");const roundTrip=Date.now()-rt0;
    const statusReqs=b.requests.filter(r=>r.url.startsWith("/api/admin/ghl/inbound-contact-sync")).length;
    const totalReqs=b.requests.filter(r=>r.url.startsWith("/api/")).length;
    ghl[mode]={reachedMs:reached,frames:frames.n,worstFrameGapMs:Math.round(frames.worst),roundTripMs:roundTrip,statusRequests:statusReqs,totalApiRequests:totalReqs,stepCalls:counts.step,bodyHasError:/unavailable|could not|failed/i.test(await text())};
    check(frames.worst<1500,`GHL Settings (${mode}) main thread stays responsive (worst frame gap ${Math.round(frames.worst)}ms)`);
    check(roundTrip<1500,`GHL Settings (${mode}) responds to script evaluation (${roundTrip}ms)`);
    check(totalReqs<400,`GHL Settings (${mode}) makes a bounded number of API requests (${totalReqs} over ~8s)`);
    check(b.exceptions.length===0,`GHL Settings (${mode}) throws no uncaught exceptions (${b.exceptions.slice(0,2).join(" || ")})`);
    await b.close();b=undefined;
  }
  measurements.ghlSettings=ghl;
  inbound.mode="ready";
  check(h.externalCalls()===0,"no external provider egress");
  await writeFile(`${dir}/panels-receipt.json`,JSON.stringify({status:"passed",identity:{sourceHead:(identity as any)?.sourceHead??null},fixture:h.prefix,checks,measurements,
    scope:"candidate build on disposable migrated DB; real handlers for permissions/queue-holds/readiness/knowledge; GHL incoming-sync endpoint is an owned stub; no baseline comparison"},null,2));
  console.log(`Stage 3 C5 panels: PASS (${checks.length} checks)`);
} finally { if(b)await b.close().catch(()=>{}); await h.close(); }
