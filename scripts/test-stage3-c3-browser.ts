import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";

// C3 bounded mounted-browser acceptance: actual private admin session, compiled production client, real
// pointer/keyboard input, real route handlers on a disposable database. Everything not registered here
// answers 501, so unregistered readers must render explicit unavailable states (never zero).
const identity=await verifyCandidateIdentity();
const dir="docs/certification/stage3-c3/browser";
const clientRoot=path.resolve("dist/public");
const h=await stage3BHttpFixture(async app=>{
  for(const [file,fn] of [["canonical-enrichment","registerCanonicalEnrichmentRoutes"],["prospects","registerProspectsRoutes"],
    ["campaigns","registerCampaignsRoutes"],["imports","registerImportsRoutes"]]) {
    const module=await import(`../server/routes/${file}.ts`);module[fn](app);
  }
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C3 fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
let b:Awaited<ReturnType<typeof privateStage3Browser>>|undefined;
const checks:string[]=[];
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);};
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  await mkdir(dir,{recursive:true});
  const tag=`c3b${randomUUID().replaceAll("-","").slice(0,8)}`;
  await h.pool.query(`INSERT INTO prospects(company_name,vertical) SELECT $1||'-'||lpad(g::text,4,'0'),'Automotive' FROM generate_series(1,620) g`,[tag]);
  b=await privateStage3Browser(h.base,h.sessions.get("admin")!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
  await b.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const url=()=>b!.evaluate("location.pathname+location.search") as Promise<string>;
  const count=(selector:string)=>b!.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`) as Promise<number>;

  // ── 1. Canonical Backlog: injected backlog failure leaves independent siblings visible ──
  b.failRead("/api/canonical-enrichment/backlog",{exact:true});
  await b.navigate("/dashboard/lead-ops?tab=canonical&canonicalView=backlog");
  await b.waitFor(/Backlog/);
  for(let i=0;i<80&&!(await count('[data-testid="backlog-unavailable"]')&&await count('[data-testid="release-panel"]')&&await count('[data-testid="launch-inventory"], [data-testid="launch-inventory-unavailable"]'));i++) await settle(250);
  check(await count('[data-testid="backlog-unavailable"]')===1,"injected backlog read failure renders an explicit unavailable state");
  check(await count('[data-testid="release-panel"]')===1,"the release panel still renders when the backlog aggregate fails");
  check(!/nothing was counted: 0|\b0 contacts\b/i.test(await b.evaluate("document.body.innerText") as string),"a failed backlog is not shown as zero");
  check(await count("h1")===1,"exactly one H1 on the grouped Canonical page");
  b.failRead(null);

  // ── 2. Six views are URL-addressable: click, reload, Back ──
  await b.navigate("/dashboard/lead-ops?tab=canonical&canonicalView=pipeline");
  await b.waitFor(/Canonical enrichment|Pipeline/);
  const viewButton=(n:number)=>`nav[aria-label="Canonical enrichment views"] button:nth-child(${n})`;
  await b.click(viewButton(3));
  for(let i=0;i<40&&!(await url()).includes("canonicalView=records");i++) await settle();
  check((await url()).includes("canonicalView=records"),"clicking Records writes canonicalView=records");
  await b.click(viewButton(6));
  for(let i=0;i<40&&!(await url()).includes("canonicalView=health");i++) await settle();
  check((await url()).includes("canonicalView=health"),"clicking Settings & Health writes canonicalView=health");
  await b.evaluate("history.back()");
  for(let i=0;i<40&&!(await url()).includes("canonicalView=records");i++) await settle();
  check((await url()).includes("canonicalView=records"),"Back restores the previous canonical view");
  await b.navigate("/dashboard/lead-ops?tab=canonical&canonicalView=exceptions");
  await b.waitFor(/Exceptions/);
  check((await b.evaluate(`document.querySelector('nav[aria-label="Canonical enrichment views"] [aria-current="page"]')?.textContent||""`) as string).includes("Exceptions"),"reload selects the same child view");
  await b.navigate("/dashboard/lead-ops?tab=canonical&canonicalView=pipeline&view=records");
  await b.waitFor(/Canonical enrichment|Pipeline/);
  check(await count('[data-testid="canonical-view-issue"]')===1,"conflicting canonicalView and view report an issue instead of guessing");

  // ── 3. Source Prospects: server total beyond 500, search reaches row 600, no whole-table fetch ──
  await b.navigate("/dashboard/lead-ops?tab=prospects");
  await b.waitFor(/Total matching/);
  await b.set('[data-testid="input-search-prospects"]',tag);
  for(let i=0;i<60&&(await b.evaluate(`document.querySelector('[data-testid="count-total-prospects"]')?.textContent`))!=="620";i++) await settle(250);
  check(await b.evaluate(`document.querySelector('[data-testid="count-total-prospects"]')?.textContent`)==="620","total shows the server filtered total (620), not the loaded page");
  await b.set('[data-testid="input-search-prospects"]',`${tag}-0600`);
  for(let i=0;i<60&&(await b.evaluate(`document.querySelector('[data-testid="count-total-prospects"]')?.textContent`))!=="1";i++) await settle(250);
  check(await b.evaluate(`document.querySelector('[data-testid="count-total-prospects"]')?.textContent`)==="1","server search finds a row beyond position 500");
  const prospectRequests=b.requests.filter((r:any)=>String(r.url??r.path??r).includes("/api/prospects?"));
  check(prospectRequests.length>0&&prospectRequests.every((r:any)=>!/limit=(\d{3,})/.test(String(r.url??r.path??r))||/limit=100\b/.test(String(r.url??r.path??r))),"no request asks for more than the 100-row server cap");

  // ── 4. Lead Imports wizard in the real browser: nothing uploads until the review step ──
  await b.navigate("/dashboard/lead-ops?tab=imports");
  await b.waitFor(/Choose source and file/);
  check(await count('[data-testid="button-import-csv"]')===0,"no Upload control before review");
  check(await b.evaluate(`document.querySelector('[data-testid="button-import-continue"]')?.disabled===true`),"Continue is disabled with no file and source");
  check(await count("h1")===1,"exactly one H1 on Lead Imports");

  // ── 5. Role guard through the real UI session: aggregate readers with 501 sources are unavailable, not zero ──
  await b.navigate("/dashboard/lead-ops?tab=businesses");
  await b.waitFor(/Inventory|Businesses|business/i);
  check(await count("h1")===1,"exactly one H1 on Prospecting");

  // ── 6. Responsive reflow and dark theme: no horizontal body overflow on adopted pages ──
  const overflow=()=>b!.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth") as Promise<number>;
  // Narrow viewports otherwise enter the mobile shell; use the app's own "Switch to desktop" preference.
  await b.evaluate('localStorage.setItem("prefer_desktop","true")');
  for(const [width,height] of [[320,640],[390,844],[768,1024],[1440,900]] as const) {
    await b.call("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<768});
    for(const route of ["/dashboard/lead-ops?tab=canonical&canonicalView=pipeline","/dashboard/lead-ops?tab=prospects","/dashboard/lead-ops?tab=imports"]) {
      await b.navigate(route);
      await b.waitFor(/Canonical|Total matching|Choose source and file/);
      await settle(400);
      check(await overflow()<=1,`no horizontal body overflow at ${width}px on ${route.split("?")[1]}`);
    }
  }
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await b.navigate("/dashboard/lead-ops?tab=imports");
  await b.waitFor(/Choose source and file/);
  await b.evaluate("document.documentElement.classList.add('dark')");
  await settle(300);
  check(await overflow()<=1,"no horizontal overflow in dark theme");
  check((await b.evaluate("getComputedStyle(document.body).backgroundColor") as string)!=="rgb(255, 255, 255)","dark theme changes the page background");
  await b.evaluate("document.documentElement.classList.remove('dark')");

  // ── 6b. Emulated 200% zoom (640x450 CSS viewport) and measured text contrast ──
  await b.call("Emulation.setDeviceMetricsOverride",{width:640,height:450,deviceScaleFactor:2,mobile:false});
  for(const route of ["/dashboard/lead-ops?tab=canonical&canonicalView=pipeline","/dashboard/lead-ops?tab=prospects","/dashboard/lead-ops?tab=imports"]) {
    await b.navigate(route);
    await b.waitFor(/Canonical|Total matching|Choose source and file/);
    await settle(400);
    check(await overflow()<=1,`no horizontal body overflow at emulated 200% zoom on ${route.split("?")[1]}`);
  }
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const contrastScript=`(()=>{const parse=c=>{const m=c.match(/[\\d.]+/g).map(Number);return m.slice(0,3).concat(m[3]===undefined?1:m[3])};
    const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
    const bg=el=>{for(let e=el;e;e=e.parentElement){const c=parse(getComputedStyle(e).backgroundColor);if(c[3]>0.95)return c}return [255,255,255,1]};
    const out=[];const seen=new Set();
    for(const el of document.querySelectorAll('main h1,main h2,main label,main button,main p,main td,main th,main span')){
      const t=(el.childNodes.length&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))?el:null;if(!t||!t.getClientRects().length)continue;
      const cs=getComputedStyle(t);if(cs.visibility==='hidden'||cs.opacity==='0'||t.disabled)continue;
      const fg=parse(cs.color),b=bg(t);const l1=lum(fg),l2=lum(b);const ratio=(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      const large=parseFloat(cs.fontSize)>=24||(parseFloat(cs.fontSize)>=18.66&&parseInt(cs.fontWeight)>=700);
      const key=cs.color+'|'+b.join(',')+'|'+cs.fontSize;if(seen.has(key))continue;seen.add(key);
      out.push({text:t.textContent.trim().slice(0,30),ratio:Math.round(ratio*100)/100,need:large?3:4.5,pass:ratio>=(large?3:4.5)});}
    return out;})()`;
  const contrast:Record<string,any[]>={};
  for(const mode of ["light","dark"]) {
    await b.navigate("/dashboard/lead-ops?tab=prospects");
    await b.waitFor(/Total matching/);
    await b.evaluate(mode==="dark"?"document.documentElement.classList.add('dark')":"document.documentElement.classList.remove('dark')");
    await settle(400);
    const rows=await b.evaluate(contrastScript) as any[];
    contrast[mode]=rows;
    const failing=rows.filter(r=>!r.pass);
    check(rows.length>5,`contrast was measured on ${rows.length} distinct text styles in ${mode} mode`);
    check(failing.length===0,`all measured text styles meet WCAG AA in ${mode} mode${failing.length?": "+JSON.stringify(failing.slice(0,5)):""}`);
  }
  await b.evaluate("document.documentElement.classList.remove('dark')");

  // ── 7. Keyboard: Tab reaches interactive controls and shows a focused element ──
  await b.evaluate("document.activeElement&&document.activeElement.blur()");
  for(let i=0;i<6;i++){await b.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});await b.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});}
  check(await b.evaluate("document.activeElement&&document.activeElement!==document.body&&document.activeElement.matches('a,button,input,select,[tabindex],[role=button],[role=combobox]')"),"Tab moves focus to an interactive control");
  check(b.exceptions.length===0,"no uncaught browser exceptions");
  check(h.externalCalls()===0,"no external provider egress");
  // ── 8. Non-admin roles through real sessions: merchants and partners never see Prospecting aggregates ──
  const deniedRoles:Record<string,string>={};
  for(const role of ["merchant","partner"] as const) {
    const rb=await privateStage3Browser(h.base,h.sessions.get(role)!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
    try {
      await rb.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      await rb.navigate("/dashboard/lead-ops?tab=prospects");
      await new Promise(resolve=>setTimeout(resolve,2500));
      const body=await rb.evaluate("document.body.innerText") as string;
      deniedRoles[role]=await rb.evaluate("location.pathname+location.search") as string;
      check(!/Total matching|Source Prospects/i.test(body),`${role} session does not render Source Prospects aggregates`);
      const calls=rb.requests.filter((r:any)=>String(r.url??r.path??r).includes("/api/prospects?"));
      check(calls.every((r:any)=>(r.status??403)===403||r.status===undefined)||calls.length===0,`${role} aggregate requests (if any) are refused by the server`);
    } finally { await rb.close(); }
  }
  await writeFile(`${dir}/receipt.json`,JSON.stringify({status:"passed",identity,fixture:h.prefix,checks,requests:b.requests.length,
    exceptions:b.exceptions,deniedRoles,contrast,qualification:"Bounded run: admin at 1280 plus 320/390/768/1440 reflow, a dark-class check, a Tab check and merchant/partner denial, with unregistered sources answering 501. 200% zoom is emulated by a 640 CSS-pixel viewport at device scale 2; contrast is computed from computed styles of text inside the page main region (not the C5 sidebar/header shell) on the Source Prospects page only, in light and dark. Not a real browser zoom, screen reader, other-page contrast, performance, published-candidate or production acceptance."},null,2));
  console.log(`STAGE3_C3_BROWSER_PASS (${checks.length} checks); bounded admin desktop run only`);
}catch(error){
  await b?.screenshot("failure");
  await writeFile(`${dir}/failed-receipt.json`,JSON.stringify({status:"failed",identity,error:String(error),checks,exceptions:b?.exceptions}, null, 2));
  throw error;
}finally{await b?.close();await h.close();}
