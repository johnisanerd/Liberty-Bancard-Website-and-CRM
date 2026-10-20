import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";

// C5 remaining-panel walk on a disposable, migrated database with real persisted sessions for admin, manager, agent,
// affiliate, merchant and partner. Real handlers: admin, knowledge-admin, documents, permissions-audit, integrations,
// content, information-flow, sdr. Every other /api source answers 501 ("source not registered"), so views that depend on
// it must show an unavailable state, never crash. Covers: all 46 Operator views, five Settings Integrations selectors,
// Content children (including Blaze) and Playbooks/Training children, role boundaries for the non-employee roles,
// dark theme, WCAG contrast, real 200% browser zoom, keyboard operation and the browser accessibility tree.
// Not a real screen reader or assistive-technology run. No write is submitted, no provider is called, nothing is sent.
const identity=await verifyCandidateIdentity();
const dir="docs/certification/stage3-c5/browser";
const clientRoot=path.resolve("dist/public");
const h=await stage3BHttpFixture(async app=>{
  for(const [file,fn] of [["admin","registerAdminRoutes"],["knowledge-admin","registerKnowledgeAdminRoutes"],["documents","registerDocumentsRoutes"],
    ["permissions-audit","registerPermissionsAuditRoutes"],["integrations","registerIntegrationsRoutes"],["content","registerContentRoutes"],
    ["information-flow","registerInformationFlowRoutes"],["sdr","registerSdrRoutes"]]){
    const module=await import(`../server/routes/${file}.ts`);module[fn](app);
  }
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C5 fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
const checks:string[]=[];
const findings:Record<string,unknown>={};
const failures:string[]=[];
// Soft checks: collect every failure in one pass so a walk reports all defects, then fail at the end.
const check=(ok:unknown,label:string)=>{if(ok)checks.push(label);else{failures.push(label);console.log(`FAIL: ${label}`);}};
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
type Browser=Awaited<ReturnType<typeof privateStage3Browser>>;
const open=async(role:string,options:{zoom?:number}={})=>{
  const b=await privateStage3Browser(h.base,h.sessions.get(role)!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000,...options});
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  return b;
};
const ERROR_BOUNDARY=/Show error details|Something went wrong|is not a function|Cannot read prop/i;
const facts=`(()=>{
  const unnamed=[...document.querySelectorAll('button,[role=tab],[role=combobox],input:not([type=hidden]),textarea,select,a[href]')].filter(x=>x.getClientRects().length>0
    &&!(x.textContent.trim()||(x.labels&&x.labels.length)||x.getAttribute('aria-label')||x.getAttribute('aria-labelledby')||x.title||x.getAttribute('placeholder')||x.getAttribute('alt')||x.querySelector('img[alt]:not([alt=""])')));
  return {h1s:document.querySelectorAll('h1').length,overflow:document.documentElement.scrollWidth>innerWidth+1,unnamed:unnamed.length,
    unnamedWhich:unnamed.slice(0,4).map(x=>(x.getAttribute('data-testid')||x.tagName)+'|'+x.outerHTML.replace(/class="[^"]*"/g,'').slice(0,140)),
    text:document.body.innerText.length};})()`;
// WCAG 2.x contrast of rendered text against its effective opaque background. Elements whose background is an image or
// gradient, and disabled controls, are not measured (counted separately).
const contrastProbe=`(()=>{
  const parse=c=>{const m=c.match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const p=m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]};};
  const lum=({r,g,b})=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);};
  const over=(top,bottom)=>({r:top.r*top.a+bottom.r*(1-top.a),g:top.g*top.a+bottom.g*(1-top.a),b:top.b*top.a+bottom.b*(1-top.a),a:1});
  const bgOf=el=>{const stack=[];let n=el,imageBg=false;while(n&&n.nodeType===1){const cs=getComputedStyle(n);if(cs.backgroundImage&&cs.backgroundImage!=='none')imageBg=true;
      const c=parse(cs.backgroundColor);if(c&&c.a>0)stack.push(c);if(c&&c.a>=1)break;n=n.parentElement;}
    let base={r:255,g:255,b:255,a:1};if(!stack.length||stack[stack.length-1].a<1)base=document.documentElement.classList.contains('dark')?{r:15,g:23,b:42,a:1}:base;
    for(let i=stack.length-1;i>=0;i--)base=over(stack[i],base);return {base,imageBg};};
  const out={measured:0,failures:[],skipped:0};const seen=new Set();
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){const t=walker.currentNode;if(!t.textContent.trim())continue;const el=t.parentElement;if(!el||seen.has(el))continue;seen.add(el);
    if(!el.getClientRects().length||el.closest('[disabled],[aria-disabled=true],script,style,[hidden],[aria-hidden=true]'))continue;
    const cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.opacity==='0')continue;
    const fg=parse(cs.color);if(!fg)continue;const {base,imageBg}=bgOf(el);if(imageBg){out.skipped++;continue;}
    const fgc=over({...fg,a:fg.a*Number(cs.opacity||1)},base);const L1=lum(fgc),L2=lum(base);const ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
    const size=parseFloat(cs.fontSize),bold=parseInt(cs.fontWeight)>=700;const large=size>=24||(size>=18.66&&bold);const need=large?3:4.5;out.measured++;
    if(ratio<need)out.failures.push({ratio:Math.round(ratio*100)/100,need,text:t.textContent.trim().slice(0,40),where:(el.closest('[data-testid]')?.getAttribute('data-testid'))||el.tagName});}
  out.failures=out.failures.slice(0,200);return out;})()`;
let b:Browser|undefined;
try{
  await mkdir(dir,{recursive:true});
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);
  const count=(s:string)=>b!.evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`) as Promise<number>;
  const text=()=>b!.evaluate("document.body.innerText") as Promise<string>;
  const until=async(fn:()=>Promise<boolean>,label:string,tries=60)=>{for(let i=0;i<tries;i++){if(await fn())return;await settle(250);}throw new Error(`Timed out: ${label}`);};
  const visit=async(url:string)=>{await b!.navigate(url);await until(async()=>(await b!.evaluate("document.body.innerText.length") as number)>40,`${url} content`);await settle(700);
    return {path:await b!.evaluate("location.pathname") as string,search:await b!.evaluate("location.search") as string,body:await text(),...(await b!.evaluate(facts) as any)};};

  // ── 1. Operator: all 46 views, real admin session ────────────────────────────────────────────────
  b=await open("admin");
  const src=await (await import("node:fs/promises")).readFile("client/src/pages/dashboard/OperatorDashboard.tsx","utf8");
  const navBlock=src.slice(src.indexOf("const OPERATOR_NAV_GROUPS"),src.indexOf("const ALL_OPERATOR_VIEWS"));
  const views=["command-center",...[...navBlock.matchAll(/value:\s*"([a-z0-9-]+)"/g)].map(m=>m[1])];
  check(views.length===46&&new Set(views).size===46,`Operator exposes 46 distinct selectable views (${views.length})`);
  const operator:Record<string,unknown>[]=[];
  for(const view of views){
    const exceptionsBefore=b.exceptions.length;
    const r=await visit(`/dashboard/system-health?tab=monitor&view=${view}`);
    const row={view,path:r.path,search:r.search,h1s:r.h1s,unnamed:r.unnamed,overflow:r.overflow,crashed:ERROR_BOUNDARY.test(r.body),exceptions:b.exceptions.length-exceptionsBefore,textLength:r.text};
    operator.push(row);
    check(r.path==="/dashboard/system-health",`Operator view ${view} stays on the Operator route (${r.path})`);
    check(!ERROR_BOUNDARY.test(r.body),`Operator view ${view} renders without the application error boundary`);
    check(r.search.includes(`view=${view}`)||view==="command-center",`Operator view ${view} keeps its view key in the URL (${r.search})`);
    check(r.h1s===1,`Operator view ${view} exposes exactly one h1 (${r.h1s})`);
    check(!r.overflow,`Operator view ${view} has no horizontal page overflow`);
    check(r.unnamed===0,`Operator view ${view} has no unnamed controls (${r.unnamed}: ${(r.unnamedWhich||[]).join(" ; ")})`);
    check(b.exceptions.length===exceptionsBefore,`Operator view ${view} throws no uncaught exception (${b.exceptions.slice(exceptionsBefore,exceptionsBefore+1).join("")})`);
    check(!/Show error details/.test(r.body)&&r.text>120,`Operator view ${view} shows a useful state, not a blank page (${r.text} chars)`);
  }
  findings.operator=operator;
  // legacy entrances and the hidden view
  const legacy=await visit("/dashboard/operator?tab=lifecycle");
  check(legacy.path==="/dashboard/system-health"&&legacy.search.includes("tab=monitor")&&legacy.search.includes("view=lifecycle"),`legacy /operator?tab=lifecycle resolves to the monitor view (${legacy.path}${legacy.search})`);
  const hidden=await visit("/dashboard/system-health?tab=monitor&view=bulk-enroll");
  check(!ERROR_BOUNDARY.test(hidden.body)&&await count('[data-testid*="bulk-enroll"]')===0,"hidden bulk-enroll view shows no bulk renderer and does not crash");
  check(b.requests.filter(r=>r.method!=="GET").length===0,"Operator walk issued no non-GET request");

  // ── 2. Settings Integrations (standalone + inside Administration): five selectors, URL round trip, real handlers ──
  const integrationViews=["ghl-workflows","sending-identities","processor-adapters","linkedin","zerobounce"];
  const integrations:Record<string,unknown>[]=[];
  for(const base of ["/dashboard/settings/integrations","/dashboard/admin-hub?tab=integrations"]){
    await visit(base);
    for(const view of integrationViews){
      const selector=`[data-testid="tab-${view==="linkedin"?"linkedin-enrichment":view}"]`;
      await b.click(selector);
      // The retained default selector is the absence of a key; every other selector must be written to the URL.
      if(view!=="ghl-workflows")await until(async()=>(await b!.evaluate("location.search") as string).includes(`integrationsView=${view}`),`${base} URL follows ${view}`,20);
      else await settle(400);
      const sel=await b.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-state')`);
      const body=await text();
      check(sel==="active",`${base}: ${view} selector is active after click`);
      check(!ERROR_BOUNDARY.test(body),`${base}: ${view} renders without the error boundary`);
      // reload restores
      const url=(await b.evaluate("location.pathname+location.search")) as string;
      await visit(url);
      const restored=await b.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('data-state')`);
      check(restored==="active",`${base}: reload restores ${view}`);
      integrations.push({base,view,url,unnamed:(await b.evaluate(facts) as any).unnamed});
    }
  }
  findings.integrations=integrations;
  check(b.requests.filter(r=>r.method!=="GET").length===0,"Settings Integrations walk issued no non-GET request (no ping, save, seed or auto-run)");

  // ── 3. Content children (admin and manager), Playbooks, Training ─────────────────────────────────
  const content:Record<string,unknown>[]=[];
  for(const tab of ["content","blog","linkedin","blaze"]){
    const r=await visit(`/dashboard/content-hub?tab=${tab}`);
    const active=await b.evaluate(`document.querySelector('[role=tab][data-state=active]')?.getAttribute('data-testid')`) as string;
    content.push({role:"admin",tab,active,path:r.path,search:r.search,crashed:ERROR_BOUNDARY.test(r.body),h1s:r.h1s,unnamed:r.unnamed,overflow:r.overflow,sample:r.body.replace(/\s+/g," ").slice(0,200)});
    check(!ERROR_BOUNDARY.test(r.body),`Content ${tab} renders without the error boundary`);
    check(active===`tab-content-${tab==="content"?"engine":tab}`,`Content ?tab=${tab} selects that child (${active})`);
    check(!r.overflow&&r.unnamed===0,`Content ${tab} has no overflow or unnamed controls (${r.unnamed}: ${(r.unnamedWhich||[]).join(" ; ")})`);
  }
  const blaze=await visit("/dashboard/content-hub?tab=blaze");
  check(/unavailable|could not|try again|retry|not connected|not configured/i.test(blaze.body),`Blaze with an unregistered source says unavailable/not configured, not an empty list (${blaze.body.replace(/\s+/g," ").slice(0,160)})`);
  for(const tab of ["marketing","growth"]){
    const r=await visit(`/dashboard/playbooks?tab=${tab}`);
    content.push({role:"admin",page:"playbooks",tab,crashed:ERROR_BOUNDARY.test(r.body),h1s:r.h1s});
    check(!ERROR_BOUNDARY.test(r.body),`Playbooks ${tab} renders without the error boundary`);
    check(r.h1s===1,`Playbooks ${tab} exposes exactly one h1 (${r.h1s})`);
  }
  for(const tab of ["docs","practice","coaching"]){
    const r=await visit(`/dashboard/training?tab=${tab}`);
    const active=await b.evaluate(`document.querySelector('[role=tab][data-state=active]')?.getAttribute('data-testid')`) as string;
    check(active===`tab-${tab}`,`Training ?tab=${tab} selects that child (${active})`);
    check(!ERROR_BOUNDARY.test(r.body),`Training ${tab} renders without the error boundary`);
  }
  findings.content=content;
  check(b.requests.filter(r=>r.method!=="GET").length===0,"Content/Playbooks/Training walk issued no non-GET request (no publish, generate, AI session or save)");
  await b.close();b=undefined;

  // Manager: Content blog child is admin-only; manager-visible controls must not call admin-only endpoints.
  b=await open("manager");
  const mgr=await visit("/dashboard/content-hub?tab=blog");
  const mgrTabs=await b.evaluate(`[...document.querySelectorAll('[role=tab]')].map(e=>e.getAttribute('data-testid'))`) as string[];
  check(!mgrTabs.includes("tab-content-blog"),`manager Content has no admin-only Blog Generator tab (${mgrTabs.join(",")})`);
  check(!ERROR_BOUNDARY.test(mgr.body),"manager Content falls back from an admin-only child without crashing");
  for(const url of ["/dashboard/settings/integrations?integrationsView=sending-identities","/dashboard/knowledge-admin?tab=sources","/dashboard/content-hub?tab=linkedin","/dashboard/playbooks?tab=marketing"]){
    const before=b.requests.length;await visit(url);
    const calls=b.requests.slice(before).filter(r=>/^\/api\/(admin|sdr\/sending-identities)/.test(r.url));
    const denied=calls.filter(r=>r.status===401||r.status===403);
    check(denied.length===0,`manager ${url}: no admin-only endpoint answers 401/403 from a visible control (${denied.map(r=>r.url).join(",")})`);
  }
  await b.close();b=undefined;

  // ── 4. Non-employee roles and agent: C5 destinations never render or fetch C5 data ───────────────
  const c5Routes=["/dashboard/admin-hub","/dashboard/permissions","/dashboard/queue-holds","/dashboard/knowledge-admin","/dashboard/content-hub",
    "/dashboard/settings/integrations","/dashboard/system-health","/dashboard/ghl-integration","/dashboard/playbooks","/dashboard/training","/dashboard/knowledge-base"];
  const adminOnlyRoutes=c5Routes.filter(r=>!/playbooks|training|knowledge-base/.test(r));
  const roleResults:Record<string,unknown[]>={};
  for(const role of ["agent","affiliate","merchant","partner"] as const){
    b=await open(role);roleResults[role]=[];
    for(const route of c5Routes){
      const before=b.requests.length;
      await b.navigate(route);await settle(1200);
      const here=await b.evaluate("location.pathname") as string;const body=await text();
      const dataCalls=b.requests.slice(before).filter(r=>/^\/api\/(admin|knowledge\/(sources|stats|unanswered|feedback|reindex)|sdr\/sending-identities|ghl\/workflow-env-ids|integrations|content)/.test(r.url));
      roleResults[role].push({route,landed:here,dataCalls:dataCalls.map(c=>`${c.method} ${c.url} ${c.status??""}`).slice(0,6)});
      const marker=await count('[data-testid="page-administration"],[data-testid="page-permissions"],[data-testid="card-hold-ledger"],[data-testid="knowledge-admin-page"],[data-testid="page-settings-integrations"],[data-testid="tab-content-engine"]');
      if(adminOnlyRoutes.includes(route)||role==="merchant"||role==="partner"){
        check(marker===0,`${role}: ${route} renders no admin/manager C5 workspace (landed ${here})`);
        check(dataCalls.length===0,`${role}: ${route} issues no admin/manager data request (${dataCalls.map(c=>c.url).join(",")})`);
      }
      if(role==="merchant")check(here==="/dashboard/merchant-portal",`merchant: ${route} lands on the merchant portal (${here})`);
      if(role==="partner")check(here==="/partner-portal"||here==="/partner-login",`partner: ${route} lands on the partner portal (${here})`);
      check(!ERROR_BOUNDARY.test(body),`${role}: ${route} shows no application error (landed ${here})`);
    }
    // portal shells must not carry the employee sidebar
    if(role==="merchant"||role==="partner")check(await count('[data-testid="nav-employee-sidebar"]')===0,`${role}: portal shell has no employee sidebar`);
    check(b.requests.filter(r=>r.method!=="GET").length===0,`${role}: boundary walk issued no non-GET request`);
    await b.close();b=undefined;
  }
  findings.roleBoundaries=roleResults;

  // ── 5. Dark theme + contrast, light and dark, key pages as admin ─────────────────────────────────
  const pages=["/dashboard/admin-hub?tab=users","/dashboard/admin-hub?tab=permissions","/dashboard/queue-holds","/dashboard/knowledge-base","/dashboard/knowledge-admin",
    "/dashboard/training","/dashboard/content-hub?tab=content","/dashboard/settings/integrations","/dashboard/system-health?tab=monitor&view=command-center"];
  b=await open("admin");
  const contrast:Record<string,Record<string,unknown>>={light:{},dark:{}};
  for(const theme of ["light","dark"]){
    await b.navigate("/dashboard/knowledge-base");
    await b.evaluate(`localStorage.setItem("liberty-theme",${JSON.stringify(theme)})`);
    for(const url of pages){
      const r=await visit(url);
      const applied=await b.evaluate("document.documentElement.classList.contains('dark')") as boolean;
      check(applied===(theme==="dark"),`${theme} theme is applied on ${url}`);
      check(!r.overflow,`${theme}: ${url} has no horizontal overflow`);
      const c=await b.evaluate(contrastProbe) as {measured:number;failures:Array<{ratio:number;need:number;text:string;where:string}>;skipped:number};
      contrast[theme][url]={measured:c.measured,failures:c.failures.length,skippedImageBackground:c.skipped,worst:c.failures.slice(0,6)};
      check(c.measured>20,`${theme}: ${url} contrast measured on ${c.measured} text elements`);
      // C5-owned structure must meet WCAG AA in both themes: page headings, area/tab navigation and table headers
      const owned=c.failures.filter(f=>/^(H1|H2|TH)$/.test(f.where)||/heading|title|tab|area-nav|page-header/i.test(f.where));
      check(owned.length===0,`${theme}: ${url} headings, tabs and area navigation meet WCAG AA contrast (${owned.slice(0,3).map(f=>`${f.where}:${f.text}:${f.ratio}`).join(" | ")})`);
    }
  }
  findings.contrast=contrast;
  await b.evaluate(`localStorage.setItem("liberty-theme","light")`);

  // ── 6. Keyboard operation and browser accessibility tree (not a screen reader) ───────────────────
  await visit("/dashboard/admin-hub?tab=users");
  const key=async(k:string,code:string,vk:number)=>{await b!.call("Input.dispatchKeyEvent",{type:"keyDown",key:k,code,windowsVirtualKeyCode:vk});await b!.call("Input.dispatchKeyEvent",{type:"keyUp",key:k,code,windowsVirtualKeyCode:vk});};
  const tabState=()=>b!.evaluate(`[...document.querySelectorAll('[role=tab]')].map(t=>t.getAttribute('aria-selected'))`) as Promise<string[]>;
  // keyboard focus on the first area/child tab, then arrow
  await b.evaluate(`(()=>{const t=document.querySelector('[role=tab][aria-selected=true]')||document.querySelector('[role=tab]');t.focus();})()`);
  const before=await tabState();await key("ArrowRight","ArrowRight",39);await settle(500);const after=await tabState();
  check(JSON.stringify(before)!==JSON.stringify(after),"keyboard ArrowRight moves the selected Administration tab");
  const ring=await b.evaluate(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return {tag:e.tagName,outline:cs.outlineStyle,outlineWidth:cs.outlineWidth,shadow:cs.boxShadow};})()`) as any;
  check(ring.outline!=="none"||ring.shadow!=="none",`keyboard focus shows a visible focus indicator (${JSON.stringify(ring)})`);
  await key("Tab","Tab",9);await key("Tab","Tab",9);
  check(await b.evaluate("document.activeElement!==document.body"),"keyboard Tab keeps focus on a control (no focus loss to body)");
  const ax:Record<string,unknown>={};
  for(const url of ["/dashboard/admin-hub?tab=users","/dashboard/admin-hub?tab=permissions","/dashboard/queue-holds","/dashboard/knowledge-admin","/dashboard/content-hub?tab=content","/dashboard/settings/integrations","/dashboard/training"]){
    await visit(url);
    await b.call("Accessibility.enable");
    const {nodes}=await b.call("Accessibility.getFullAXTree");
    const live=nodes.filter((n:any)=>!n.ignored);
    const role=(n:any)=>n.role?.value;const name=(n:any)=>String(n.name?.value??"").trim();
    const interactive=live.filter((n:any)=>["button","tab","textbox","combobox","checkbox","switch","link","menuitem","searchbox","spinbutton","radio","slider"].includes(role(n)));
    const unnamed=interactive.filter((n:any)=>!name(n)&&!n.properties?.some((p:any)=>p.name==="disabled"&&p.value?.value));
    const headings=live.filter((n:any)=>role(n)==="heading").map((n:any)=>Number(n.properties?.find((p:any)=>p.name==="level")?.value?.value));
    const landmarks=live.filter((n:any)=>["main","navigation","banner"].includes(role(n))).map(role);
    const tablist=live.filter((n:any)=>role(n)==="tablist").length,selectedTabs=live.filter((n:any)=>role(n)==="tab"&&n.properties?.some((p:any)=>p.name==="selected"&&p.value?.value)).length;
    const skips=headings.some((lvl,i)=>i>0&&lvl-headings[i-1]>1);
    ax[url]={interactive:interactive.length,unnamed:unnamed.length,headings,landmarks:[...new Set(landmarks)],tablist,selectedTabs};
    check(unnamed.length===0,`accessibility tree: ${url} has no unnamed interactive element (${unnamed.slice(0,3).map((n:any)=>role(n)+"|"+(n.backendDOMNodeId)).join(",")})`);
    check(headings.filter(l=>l===1).length===1,`accessibility tree: ${url} has exactly one level-1 heading (${headings.join(",")})`);
    check(!skips,`accessibility tree: ${url} heading levels do not skip (${headings.join(",")})`);
    check(landmarks.includes("main"),`accessibility tree: ${url} exposes a main landmark`);
    if(tablist>0)check(selectedTabs>=1,`accessibility tree: ${url} exposes a selected tab`);
  }
  findings.accessibilityTree=ax;
  await b.close();b=undefined;

  // ── 7. Real 200% browser zoom (Chromium zoom preference, not an emulated viewport) ───────────────
  b=await open("admin",{zoom:2});
  const zoom:Record<string,unknown>={};
  for(const url of ["/dashboard/admin-hub?tab=users","/dashboard/permissions","/dashboard/knowledge-admin","/dashboard/content-hub?tab=content","/dashboard/settings/integrations","/dashboard/training"]){
    await b.call("Emulation.clearDeviceMetricsOverride").catch(()=>{});
    const r=await visit(url);
    const dpr=await b.evaluate("devicePixelRatio") as number,width=await b.evaluate("innerWidth") as number;
    const clipped=await b.evaluate(`(()=>{const t=document.querySelector('[role=tablist]');if(!t)return null;return {scrollable:t.scrollWidth>t.clientWidth,clipsPage:t.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(t).overflowX==='visible'};})()`) as any;
    zoom[url]={dpr,innerWidth:width,overflow:r.overflow,tablist:clipped};
    check(dpr>=1.9||width<=800,`200% browser zoom is in effect on ${url} (dpr ${dpr}, innerWidth ${width})`);
    check(!r.overflow,`200% zoom: ${url} has no horizontal page overflow (innerWidth ${width})`);
    check(!clipped||!clipped.clipsPage,`200% zoom: ${url} tab list is not clipped outside the page`);
  }
  findings.zoom=zoom;
  check(h.externalCalls()===0,"no external provider egress during the whole walk");
  await b.close();b=undefined;
  assert.equal(failures.length,0,`${failures.length} walk checks failed:\n${failures.join("\n")}`);
  await writeFile(`${dir}/walk-receipt.json`,JSON.stringify({status:"passed",identity:{sourceHead:(identity as any)?.sourceHead??null},fixture:h.prefix,checks,findings,
    scope:"candidate build, disposable migrated DB, real sessions for six roles; real handlers for admin/knowledge/documents/permissions/integrations/content/information-flow/sdr, every other source answers 501; read-only; browser accessibility tree and keyboard, not a screen reader; contrast excludes image/gradient backgrounds and disabled controls"},null,2));
  console.log(`Stage 3 C5 walk: PASS (${checks.length} checks)`);
} finally { if(b)await b.close().catch(()=>{}); await h.close(); }
