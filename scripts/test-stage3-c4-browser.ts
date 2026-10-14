import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";
import {c4InventoryCases,c4ControlSnapshotExpression,writeC4ControlInventory} from "./fixtures/stage3-c4-control-inventory";
import {runC4HealthReadCase} from "./fixtures/stage3-c4-health-read-case";
import path from "node:path";
import {runC4MatchedPerformance} from "./fixtures/stage3-c4-matched-performance";

const identity=await verifyCandidateIdentity();
let browserPreparationFault=false;
let browserPreparationFaultExecuted=false;
let clientRoot=path.resolve("dist/public");
const h=await stage3BHttpFixture(async app=>{
  for(const [file,fn] of [
    ["contacts","registerContactsRoutes"],["deals","registerDealsRoutes"],
    ["chargebacks","registerChargebacksRoutes"],["portfolio","registerPortfolioRoutes"],
    ["routes-revenue","registerRevenueRoutes"],["crm-operations","registerCrmOperationsRoutes"],
    ["tickets-tasks","registerTicketsTasksRoutes"],["my-day","registerMyDayRoutes"],
    ["notifications","registerNotificationsRoutes"],
    ["acquisition","registerAcquisitionRoutes"],
    ["lifecycle","registerLifecycleRoutes"],
    ["activity","registerActivityRoutes"],
    ["analytics","registerAnalyticsRoutes"],
    ["residuals","registerResidualsRoutes"],
    ["review-queue","registerReviewQueueRoutes"],
    ["boarding","registerBoardingRoutes"],["documents","registerDocumentsRoutes"],
    ["statement-review","registerStatementReviewRoutes"],
    ["testimonials","registerTestimonialRoutes"],
    ["workflows","registerWorkflowsRoutes"],
    ["churn","registerChurnRoutes"],
    ["campaigns","registerCampaignsRoutes"],
  ]) {const module=await import(`../server/routes/${file}.ts`);module[fn](app,file==="crm-operations" ? {
    onboardingPreparationAfterStep:async(step:string)=>{
      if(browserPreparationFault && step==="Submit application to processor"){
        browserPreparationFault=false;browserPreparationFaultExecuted=true;
        throw new Error("Owned mounted preparation post-task fault");
      }
    },
  }:undefined);}
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C4 fixture"}));
  const {static:serveStatic}=await import("express");
   app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
   app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
let b:Awaited<ReturnType<typeof privateStage3Browser>>|undefined;
const rows:Array<Record<string,unknown>>=[];
let browserRole="admin";
const finishedContexts:Array<{role:string,requests:unknown[],exceptions:unknown[]}>=[];
const browserContexts=()=>[...finishedContexts,{
  role:browserRole,requests:b?.requests??[],exceptions:b?.exceptions??[],
}];
async function settleStaffTour(role:string) {
  assert.ok(b);
  const before=await h.request(role,"GET","/api/auth/user");
  assert.equal(before.status,200);
  if(before.body.tourCompletedAt)return;
  await b.waitFor(/Welcome to Liberty Bancard/);
  await b.click('[data-testid="button-tour-skip-text"]');
  let readback=before;
  for(let n=0;n<50;n++){
    readback=await h.request(role,"GET","/api/auth/user");
    if(readback.body.tourCompletedAt)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(readback.body.tourCompletedAt,"Actual current actor tour completion persisted");
  for(let n=0;n<50&&await b.evaluate('!!document.querySelector("[data-testid=button-tour-skip]")');n++)
    await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=button-tour-skip]")'),false,
    "First-login modal actually unmounted before measuring destinations");
  rows.push({phase:"Current staff tour prerequisite",role,
    qualification:"Shipped Skip control, own persisted preference and actual authenticated readback; not report/merchant/native action acceptance."});
}
try {
  await mkdir("docs/certification/stage3-c4/browser/failures",{recursive:true});
  const {contacts,merchantMids,merchantResiduals,deals,auditLogs,tasks}=await import("../shared/schema");
  const {eq,and}=await import("drizzle-orm");
  let preparationContactId=0;
  for(let n=0;n<110;n++) {
    const contact=(await h.db.insert(contacts).values({firstName:"C4 Hydrated",lastName:`Merchant ${n}`,
      email:`${h.prefix}-browser-${n}@example.test`,phone:"",
      companyName:`C4 Useful Business ${n}`,assignedTo:h.email("agent"),recordClass:"production"}).returning())[0];
    await h.db.insert(merchantMids).values({contactId:contact.id,mid:`${h.prefix}-${n}`,status:"active",activatedAt:new Date()});
    if(n===0)preparationContactId=contact.id;
    if(n===0)await h.db.insert(merchantResiduals).values({contactId:contact.id,merchantMid:`${h.prefix}-${n}`,
      merchantName:"C4 Captured Financial Observation",month:"2026-10",revenue:"10.10"});
  }
  const {partnerOrganizations,residualImports}=await import("../shared/schema");
  const capturedPartner=(await h.db.insert(partnerOrganizations).values({
    name:"C4 captured partner organization",slug:`${h.prefix}-captured-partner`,
  }).returning())[0];
  const confirmedImport=(await h.db.insert(residualImports).values({
    month:"2026-10",fileName:"Owned browser locally confirmed record",status:"confirmed",
  }).returning())[0];
  const capturedPartnerDeal=(await h.db.insert(deals).values({
    title:"C4 captured financial deal",contactId:preparationContactId,pipeline:"Sales",stage:"Closed Won",
    owner:h.email("agent"),recordClass:"production",partnerOrgId:capturedPartner.id,
  }).returning())[0];
  await h.db.update(merchantResiduals).set({importId:confirmedImport.id,dealId:capturedPartnerDeal.id,netRevenue:null,partnerCommission:null})
    .where(eq(merchantResiduals.merchantMid,`${h.prefix}-0`));
  b=await privateStage3Browser(h.base,h.sessions.get("admin")!.cookie,h.originalFetch,
    "docs/certification/stage3-c4/browser",{realInput:true});
  await b.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  // Exercise the existing product control; don't rewrite the dedicated mobile
  // redirect or confuse its intentionally separate branding with employee C4.
  await b.navigate("/mobile");
  await b.waitFor(/Switch to desktop view/);
  // The denied appointment read replaces the loading region and moves this
  // footer control. Wait for that independent source to settle before pointer
  // measurement rather than clicking a coordinate during hydration.
  await b.waitFor(/Native appointments are unavailable/);
  await b.waitFor(/110/);
  await b.evaluate("document.fonts.ready.then(()=>true)");
  await b.click('[data-testid="button-switch-to-desktop"]');
  for(let n=0;n<50 && !await b.evaluate('localStorage.getItem("prefer_desktop")==="true"');n++)
    await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await b.evaluate('localStorage.getItem("prefer_desktop")'),"true","real existing desktop-preference control executed");
  for(let n=0;n<50 && !await b.evaluate('location.pathname.startsWith("/dashboard") && !!document.querySelector("main")');n++)
    await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await b.evaluate('location.pathname.startsWith("/dashboard")'),true,"desktop-control navigation settled before viewport change");
  await settleStaffTour("admin");
  for(const [route,ready] of [
    ["/dashboard/onboarding",/Onboarding Pipeline/],
    ["/dashboard/onboarding?tab=board",/Onboarding Operations Board/],
    ["/dashboard/onboarding-kickoff",/Closed Won Sales → linked Onboarding preparation/],
  ] as const){
    await b.navigate(route);await b.waitFor(ready);
    const headings=await b.evaluate('Array.from(document.querySelectorAll("main h1")).map(e=>e.textContent.trim())');
    assert.equal(headings.length,1,`Persistent unique Onboarding page identity: ${route}`);
    rows.push({phase:"Onboarding unique H1",role:"admin",route,headings});
  }
  for(const [route,control,parameter,value,ready] of [
    ["/dashboard/merchant-applications","tab-status-approved","status","approved",/Merchant Applications/],
    ["/dashboard/boarding","tab-boarding-approved","status","approved",/Boarding/],
    ["/dashboard/reporting?tab=outreach-analytics","tab-ab-testing","outreachView","ab-testing",/Outreach Analytics/],
    ["/dashboard/leaderboard","tab-metric-calls","metric","calls",/Leaderboard/],
  ] as const){
    await b.navigate(route);await b.waitFor(ready);
    const originalUrl=await b.evaluate("location.href");
    await b.click(`[data-testid="${control}"]`);
    assert.equal(await b.evaluate(`new URLSearchParams(location.search).get(${JSON.stringify(parameter)})`),value);
    await b.call("Page.reload");await b.waitFor(ready);
    assert.equal(await b.evaluate(`document.querySelector('[data-testid="${control}"]').getAttribute("data-state")`),"active");
    await b.evaluate("history.back()");
    for(let attempt=0;attempt<60 && await b.evaluate("location.href")!==originalUrl;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await b.evaluate("location.href"),originalUrl,"Back restores original retained selector");
    await b.evaluate("history.forward()");
    for(let attempt=0;attempt<60 && await b.evaluate(`new URLSearchParams(location.search).get(${JSON.stringify(parameter)})`)!==value;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await b.evaluate(`new URLSearchParams(location.search).get(${JSON.stringify(parameter)})`),value,"Forward restores selection");
    rows.push({phase:"Retained URL state reload/Back/Forward",role:"admin",route,parameter,value});
  }
  for(const theme of ["light","dark"]) for(const width of [320,390,768,1280,1440]) {
    await b.call("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});
    const started=performance.now();
    await b.call("Page.navigate",{url:`${h.base}/dashboard/portfolio`});
    await b.waitFor(/C4 Useful Business/);
    const visibleRecord=`Array.from(document.querySelectorAll('main a[href*="/dashboard/contacts/"]')).some(e=>{
      const r=e.getBoundingClientRect();return /C4 Useful Business/.test(e.textContent||"") && r.width>0 && r.height>0 && r.top<innerHeight && r.bottom>0;
    })`;
    if(!await b.evaluate(visibleRecord)){
      await b.evaluate(`Array.from(document.querySelectorAll('main a[href*="/dashboard/contacts/"]')).find(e=>/C4 Useful Business/.test(e.textContent||"")&&e.getBoundingClientRect().width>0)?.scrollIntoView({block:"center"})`);
    }
    assert.equal(await b.evaluate(visibleRecord),true,"actually visible hydrated business, not shell/offscreen text");
    const hydratedMs=performance.now()-started;
    await b.evaluate(`document.documentElement.classList.toggle("dark",${theme==="dark"})`);
    const geometry=await b.evaluate(`(()=>{const panel=document.querySelector(".crm-merchant-ops-content");
      const rail=document.querySelector(".crm-merchant-ops-rail"),select=document.querySelector(".crm-merchant-ops-mobile select");
      const r=panel.getBoundingClientRect();
      return {allocatedWidth:r.width,h1:document.querySelectorAll("main h1").length,
        overflow:document.documentElement.scrollWidth>innerWidth+1,
        railVisible:!!rail&&getComputedStyle(rail).display!=="none",
        railWidth:rail?.getBoundingClientRect().width,selectVisible:!!select&&select.getBoundingClientRect().height>0,
      usefulRows:Array.from(document.querySelectorAll('main a[href*="/dashboard/contacts/"]')).filter(e=>{
        const r=e.getBoundingClientRect();return /C4 Useful Business/.test(e.textContent||"")&&r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0;
      }).length,
        measuredSelectHeight:select?.getBoundingClientRect().height,
        context:document.querySelector(".crm-merchant-ops-layout")?.getBoundingClientRect().width};})()`);
    assert.equal(geometry.h1,1,"one main page H1");
    assert.equal(geometry.overflow,false,JSON.stringify(geometry));
    assert.ok(geometry.railVisible || geometry.selectVisible,"a usable allocated-container navigation alternative");
    if(geometry.railVisible)assert.equal(Math.round(geometry.railWidth),200);
    if(geometry.selectVisible)assert.ok(geometry.measuredSelectHeight>=44);
    rows.push({phase:"Portfolio hydrated browser",theme,width,hydratedMs,geometry,
      timingCondition:"110 eligible disposable merchants; environment Chromium; cold browser HTTP cache; loopback; reduced motion; no production latency claim"});
    await b.screenshot(`portfolio-${theme}-${width}`);
  }
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  b.failRead("/api/deal-competitors");
  await b.call("Page.navigate",{url:`${h.base}/dashboard/reporting?tab=win-loss`});
  await b.waitFor(/Sales & Growth/);
  assert.equal(await b.evaluate("document.querySelectorAll('main h1').length"),1);
  assert.equal(await b.evaluate("document.querySelectorAll('nav[aria-label=\"Report areas\"] button').length"),4);
  await b.waitFor(/Win\/Loss observations are unavailable/);
  assert.ok(b.readFaults.some(f=>f.path==="/api/deal-competitors"&&f.status===503),"the Win/Loss read fault actually executed");
  assert.equal(await b.evaluate("document.body.innerText.includes('No competitor entries yet')"),false,"failed observations are not empty results");
  assert.equal(await b.evaluate("document.body.innerText.includes('Total Tracked Deals')"),false,"failed observations do not render zero KPI cards");
  await b.screenshot("reports-four-areas");
  b.failRead(null);
  await b.click('[data-testid="button-retry"]');
  await b.waitFor(/No competitor entries yet/);
  rows.push({phase:"Reports four-area rendering and Win/Loss read fault/retry",
    fault:{path:"/api/deal-competitors",status:503,executed:true},
    readback:"real authorized reader returned200 with empty fixture population",
    scope:"mounted shell, retained Win/Loss URL and intercepted read-fault recovery; not aggregate/action/native certification"});
  await b.call("Page.navigate",{url:`${h.base}/dashboard/reporting?tab=financial&financialTab=revenue&revenuePeriod=2026-10`});
  await b.waitFor(/C4 Captured Financial Observation/);
  await b.waitFor(/Stored Agent Attribution/);
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="row-agent-unattributed"]\').textContent.includes("$10.10")'),true,
    "Captured financial attribution does not depend on a legacy agent roster");
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="text-total-revenue"]\')?.textContent'),"$10.10");
  assert.equal(await b.evaluate('!!document.querySelector(\'table[aria-label="Recorded period chart data alternative"]\')'),true);
  await b.screenshot("financial-observed-scope");
  await b.click('[data-testid="tab-by-partner"]');
  await b.waitFor(/C4 captured partner organization/);
  const partnerSelector=`[data-testid="row-partner-${capturedPartner.id}"]`;
  assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(partnerSelector)}).textContent.includes("$10.10")`),true);
  assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(partnerSelector)}).textContent.includes("Unavailable")`),true,
    "Missing captured net/commission is not a zero payout");
  await b.evaluate(`document.querySelector(${JSON.stringify(partnerSelector)}).scrollIntoView({block:"center"})`);
  const partnerRect=await b.evaluate(`(()=>{
    const r=document.querySelector(${JSON.stringify(partnerSelector)}).getBoundingClientRect();
    return {top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewportHeight:innerHeight};
  })()`);
  assert.ok(partnerRect.height>0&&partnerRect.width>0&&partnerRect.top>=0&&partnerRect.bottom<=partnerRect.viewportHeight,
    "Actual partner record is visibly rendered, not merely an offscreen DOM assertion");
  await b.screenshot("financial-partner-exact-scope");
  assert.equal(b.requests.filter(r=>r.url.startsWith("/api/residuals/by-partner")).length,0,
    "Reports does not start a competing unfiltered partner read");
  rows.push({phase:"Financial partner exact-snapshot presentation",orgId:capturedPartner.id,
    period:"2026-10",observedGross:10.10,missingNetAndCommission:"unavailable",renderedContainer:partnerRect,
    scope:"Shared A parent/search/recorded-period projection; local confirmation is not native settlement; no useful-list timing claim"});
  b.failRead("/api/revenue/residual-group-scope");
  await b.call("Page.navigate",{url:`${h.base}/dashboard/reporting?tab=financial&financialTab=revenue&revenuePeriod=2026-09`});
  await b.waitFor(/Scoped observation data is unavailable/);
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="text-total-revenue"]\')?.textContent'),"Unavailable");
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="button-export-revenue"]\')?.disabled'),true);
  b.failRead(null);
  rows.push({phase:"One compiled Financial recorded-period observation and executed503 scope fault",
    rowVolume:1,knownStoredRevenue:10.10,sourceCurrency:"not_recorded",USD:"display assumption",
    chartTable:true,fault:{path:"/api/revenue/residual-group-scope",status:503,executed:true},
    outcome:"Unavailable, not zero; export disabled",qualification:"Not all financial children/payee/native or action proof"});
  const [source]=await h.db.insert(deals).values({contactId:preparationContactId,pipeline:"sales",
    stage:"Closed Won",owner:h.email("agent"),recordClass:"production",updatedAt:new Date("2026-10-01T13:14:15Z")}).returning();
  const kickoff=`/dashboard/onboarding-kickoff?contactId=${preparationContactId}&dealId=${source.id}`;
  await b.navigate(kickoff);
  await b.waitFor(/Prepare linked Onboarding locally/);
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=button-tour-skip]")'),false,
    "Completed current actor tour must not cover kickoff controls");
  await b.click('[data-testid="button-cancel-preparation"]');
  assert.equal((await h.db.select().from(auditLogs).where(and(eq(auditLogs.entityId,source.id),
    eq(auditLogs.action,"onboarding_local_prepare_accepted")))).length,0,"Cancel must not accept an intent");
  await b.navigate(kickoff);
  await b.waitFor(/Prepare linked Onboarding locally/);
  await b.click('[data-testid="select-terminal-needed"]');
  await b.click('[data-testid="select-terminal-yes"]');
  // Mounted date-only value via native DOM setter/events, not a claim that the
  // date-picker's physical keyboard/touch interaction has been certified.
  assert.equal(await b.evaluate(`(()=>{const e=document.querySelector('[data-testid="input-go-live-date"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'2026-11-15');
    e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
    return e.value})()`),"2026-11-15");
  await b.set('[data-testid="input-funding-notes"]',"Owned mounted planning notes");
  browserPreparationFault=true;
  await b.click('[data-testid="button-submit-onboarding"]');
  await b.waitFor(/Acceptance outcome unknown/);
  // Captured-intent notice appears before the HTTP response. Readback is
  // correctly disabled while the command is pending; await the real failure.
  await b.waitFor(/Preparation not confirmed/);
  await b.click('[data-testid="button-read-preparation"]');
  await b.waitFor(/Local preparation: partial/);
  assert.equal(browserPreparationFaultExecuted,true,"Actual post-task fault executed");
  const [accepted]=await h.db.select().from(auditLogs).where(and(eq(auditLogs.entityId,source.id),
    eq(auditLogs.action,"onboarding_local_prepare_accepted")));
  const plan=accepted.details as {commandId:string;onboardingDealId:number};
  const before=await h.db.select().from(tasks).where(eq(tasks.dealId,plan.onboardingDealId));
  assert.equal(before.length,1);
  assert.equal(await b.evaluate(`(async()=>{
    for(let attempt=0;attempt<50;attempt++){
      const button=document.querySelector('[data-testid="button-retry-preparation"]');
      if(button&&!button.disabled&&getComputedStyle(button).pointerEvents!=="none")return true;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return false;
  })()`),true,"Readback must settle before an unfinished-step retry is enabled");
  await b.click('[data-testid="button-retry-preparation"]');
  await b.waitFor(/Local preparation: prepared/);
  assert.equal(await b.evaluate('!!document.querySelector(\'[data-testid="button-tour-skip"]\')'),false,"Delayed tour must not cover the accepted-state evidence");
  const after=await h.db.select().from(tasks).where(eq(tasks.dealId,plan.onboardingDealId));
  assert.equal(after.length,5);assert.ok(after.some(t=>t.id===before[0].id));
  assert.equal((await h.db.select().from(deals).where(eq(deals.id,source.id)))[0].pipeline,"sales");
  assert.equal((await h.db.select().from(auditLogs).where(and(eq(auditLogs.entityId,source.id),
    eq(auditLogs.action,"onboarding_local_prepare_accepted")))).length,1);
  await b.screenshot("onboarding-local-prepared");
  rows.push({phase:"Compiled mounted linked preparation Cancel/post-task fault/readback/retry",
    acceptedCommandId:plan.commandId,onboardingDealId:plan.onboardingDealId,
    taskIds:after.map(t=>t.id),faultExecuted:browserPreparationFaultExecuted,
    outcome:"One accepted intent; retained first task, five tasks after retry; Sales unchanged; no native effects",
    dateInput:"mounted native setter/events; physical date-picker interaction remains unverified"});
  await b.call("Page.navigate",{url:`${h.base}/dashboard/reporting?tab=operations`});
  await b.waitFor(/Estimated Cost Per Lead/);
  assert.equal(await b.evaluate("document.querySelectorAll('main h1').length"),1);
  assert.equal(await b.evaluate("document.body.innerText.includes('UTC window:')"),true);
  await b.set('[data-testid="input-operations-spend"]',"-10");
  const beforeInvalid=b.requests.filter(request=>request.url.includes("/api/reporting/operations")).length;
  await b.click('[data-testid="button-apply-operations"]');
  await b.waitFor(/non-negative USD estimate/);
  assert.equal(b.requests.filter(request=>request.url.includes("/api/reporting/operations")).length,beforeInvalid,"invalid spend makes no report request");
  await b.set('[data-testid="input-operations-spend"]',"10.01");
  await b.click('[data-testid="button-apply-operations"]');
  await b.waitFor(/10.01 user-entered spend/);
  const exported=await b.evaluate(`(()=>{
    const a=document.createElement("a");const old=a.constructor.prototype.click;
    window.__operationExportPromise=null;
    const create=URL.createObjectURL;
    URL.createObjectURL=function(blob){window.__operationExportPromise=blob.text();return create.call(URL,blob);};
    window.__restoreOperationExport=function(){a.constructor.prototype.click=old;URL.createObjectURL=create;};
    a.constructor.prototype.click=function(){
      if(this.download!=="cpl-by-source.csv")old.call(this);
    };
    return true;
  })()`);
  assert.equal(exported,true,"capture the actual generated download Blob without external transport");
  let exportedCsv:string;
  try {
    await b.click('[data-testid="button-export-operations-cpl"]');
    exportedCsv=await b.evaluate("window.__operationExportPromise");
  } finally {await b.evaluate("window.__restoreOperationExport()");}
  assert.ok(exportedCsv.includes('"Currency (model assumption)"'));
  assert.ok(exportedCsv.includes('"UTC"'));
  assert.ok(exportedCsv.includes('"10.01"'));
  assert.ok(exportedCsv.includes('"estimate"'));
  await b.screenshot("operations-model-provenance");
  b.failRead("/api/reporting/operations");
  // Explicit unchanged-filter refresh proves the failure even when the reader is cached.
  await b.click('[data-testid="button-apply-operations"]');
  await b.waitFor(/Operations report unavailable/);
  assert.equal(await b.evaluate('Array.from(document.querySelectorAll("main button")).some(button=>button.textContent.trim()==="CSV")'),false);
  assert.ok(b.readFaults.some(f=>f.path==="/api/reporting/operations"&&f.status===503));
  await b.screenshot("operations-unavailable");
  b.failRead(null);
  await b.click('[data-testid="button-retry-operations"]');
  await b.waitFor(/Estimated Cost Per Lead/);
  rows.push({phase:"Operations compiled model input/CSV/read fault/retry",
    modelInput:"10.01 user-supplied USD, not observed spend",invalidInput:"physical -10 input denied before request",
    export:"actual mounted handler; UTC/period/model/source/precision metadata retained",
    fault:{path:"/api/reporting/operations",status:503,executed:true},
    retry:"registered source reader; no monetary zero or export while unavailable"});
  const {contacts:npsContacts,npsResponses}=await import("../shared/schema");
  const [npsContact]=await h.db.insert(npsContacts).values({
    firstName:"C4",lastName:"NPS browser sample",email:`${h.prefix}-nps-browser@example.test`,phone:"",recordClass:"production",
  }).returning();
  const npsDate=new Date(Date.now()-86_400_000);
  for(const [index,score] of [[0,10],[1,0],[2,null]] as const) await h.db.insert(npsResponses).values({
    token:`${h.prefix}-nps-browser-${index}`,contactId:npsContact.id,score,dayTrigger:30,createdAt:npsDate,submittedAt:npsDate,
  });
  b.failRead("/api/churn-scores/summary",{exact:true});
  await b.navigate(`/dashboard/merchant-health?healthView=nps&contactId=${npsContact.id}#nps`);
  await b.waitFor(/2 valid scored submissions/);
  assert.equal(await b.evaluate('document.querySelectorAll("h1").length'),1,"Health NPS retains one employee page heading");
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="text-churn-risk-count"]\').textContent.trim()'),"Unavailable",
    "The independently unavailable churn source must not become zero");
  assert.ok(b.readFaults.some(f=>f.path==="/api/churn-scores/summary"&&f.status===503));
  b.failRead(null);
  assert.equal(await b.evaluate('new URLSearchParams(location.search).get("healthView")'),"nps");
  assert.equal(await b.evaluate('location.pathname'),"/dashboard/merchant-risk");
  assert.equal(await b.evaluate('new URLSearchParams(location.search).get("contactId")'),String(npsContact.id));
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="card-nps-net-promoter-score"]\').innerText.includes("Unassessed")'),false);
  assert.ok((await b.text()).includes("1 submitted records have no valid score"));
  await b.screenshot("health-nps-scored-sample");
  await b.click('[data-testid="tab-alerts"]');
  assert.equal(await b.evaluate('new URLSearchParams(location.search).get("healthView")'),"alerts");
  await b.call("Page.reload");
  await b.waitFor(/Health Alerts/);
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="tab-alerts"]\').getAttribute("data-state")'),"active");
  b.failRead("/api/nps/stats");
  await b.navigate(`/dashboard/merchant-risk?tab=health&healthView=nps`);
  await b.waitFor(/NPS aggregate unavailable/);
  await b.waitFor(/NPS by record-created month/);
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="card-nps-net-promoter-score"]\')===null'),true);
  assert.ok(b.readFaults.some(f=>f.path==="/api/nps/stats"&&f.status===503));
  await b.screenshot("health-nps-independent-read-fault");
  b.failRead(null);
  await b.click('[data-testid="tab-content-nps"] button');
  await b.waitFor(/2 valid scored submissions/);
  await b.navigate(`/dashboard/merchant-success?tab=nps`);
  await b.waitFor(/1 submitted records lack a valid score/);
  assert.equal(await b.evaluate('document.querySelectorAll("h1").length'),1,"Success NPS retains one employee page heading");
  b.failRead("/api/nps",{exact:true});
  await b.call("Page.reload");
  await b.waitFor(/Independent NPS records unavailable/);
  assert.equal(await b.evaluate(`(async()=>{
    for(let i=0;i<120;i++){
      if(document.querySelector('[data-testid="text-nps-score"]')?.textContent.trim()==="0")return true;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return false;
  })()`),true,"Independent NPS statistics must finish loading before checking their value");
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="text-nps-score"]\').textContent.trim()'),"0");
  b.failRead(null);
  await b.click('[data-testid="card-recent-responses"] button');
  await b.waitFor(/Day 30 survey/);
  rows.push({phase:"NPS scoped observed sample and independent fault/retry",
    sample:"two valid scored submissions balance at observed zero; one submitted missing score is unassessed, not a detractor",
    views:"Health child URL and legacy context/fragment alias; real selection/reload; Success same read contract",
    faults:[{path:"/api/nps/stats",status:503,executed:true},{path:"/api/nps",status:503,executed:true}],
    siblings:"successful trend survives unavailable aggregate; successful aggregate survives unavailable records"});
  await b.call("Emulation.setTimezoneOverride",{timezoneId:"America/Bogota"});
  const calendarWindow=await b.evaluate(`(()=>{
    const now=new Date(),year=now.getFullYear(),month=now.getMonth();
    const end=new Date(year,month+1,1),last=new Date(year,month+1,0);
    return {start:new Date(year,month,1).toISOString(),end:end.toISOString(),
      lastDate:year+"-"+String(month+1).padStart(2,"0")+"-"+String(last.getDate()).padStart(2,"0")};
  })()`);
  const {calendarEvents}=await import("../shared/schema");
  const [calendarLast,calendarBoundary]=await h.db.insert(calendarEvents).values([
    {title:"C4 month last local day",startTime:new Date(Date.parse(calendarWindow.end)-3600000),
      endTime:new Date(Date.parse(calendarWindow.end)-1800000),ownerId:h.userId("admin")},
    {title:"C4 exact next month boundary",startTime:new Date(calendarWindow.end),
      endTime:new Date(Date.parse(calendarWindow.end)+3600000),ownerId:h.userId("admin")},
  ]).returning();
  await b.navigate("/dashboard/tasks-appointments?tab=calendar");
  await b.waitFor(/Calendar source coverage/);
  const calendarRequest=b.requests.find(r=>r.url.startsWith("/api/calendar-events?"));
  assert.ok(calendarRequest && calendarRequest.status===200,"Actual authorized Calendar reader was used");
  const requestedWindow=new URL(calendarRequest.url,h.base).searchParams;
  assert.equal(requestedWindow.get("start"),calendarWindow.start);
  assert.equal(requestedWindow.get("end"),calendarWindow.end);
  await b.click(`[data-testid="calendar-day-${calendarWindow.lastDate}"]`);
  await b.waitFor(/C4 month last local day/);
  assert.equal(await b.evaluate('document.body.innerText.includes("C4 exact next month boundary")'),false);
  await b.screenshot("calendar-bogota-last-local-day");
  rows.push({phase:"Calendar mounted local month boundary",timezone:"America/Bogota",
    requestedWindow:calendarWindow,lastEventId:calendarLast.id,excludedBoundaryEventId:calendarBoundary.id,
    scope:"Real local-event reader and selected last-day control; independent provider appointments remain unavailable; duration editor unchanged"});
  const {agentPayouts}=await import("../shared/schema");
  await h.db.insert(agentPayouts).values([
    {agentUserId:h.userId("agent"),periodMonth:"2026-10",grossResidual:"0.50",agentShare:"0.30",partnerShare:"0.10",status:"paid"},
    {agentUserId:h.userId("other"),periodMonth:"2026-10",grossResidual:"9999",agentShare:"9999",partnerShare:"0",status:"paid"},
  ]);
  const {agents:scoreAgents}=await import("../shared/schema");
  const [scoreAgent]=await h.db.insert(scoreAgents).values({
    firstName:h.prefix,lastName:"Scoreboard fixture",email:`${h.prefix}-score@example.test`,userId:h.userId("agent"),
  }).returning();
  await h.db.insert(deals).values({
    title:`${h.prefix} observed processing volume`,contactId:preparationContactId,pipeline:"sales",stage:"Closed Won",
    owner:`${scoreAgent.firstName} ${scoreAgent.lastName}`,recordClass:"production",totalVolume:"10.10",
  });
  await h.pool.query(`INSERT INTO agent_payouts(agent_user_id,period_month,agent_share,gross_residual,status)
    VALUES($1,$2,'','','pending')`,[h.userId("manager"),new Date().toISOString().slice(0,7)]);
  await b.navigate("/dashboard/reporting?tab=financial&financialTab=revenue&revenueView=payouts");
  await b.waitFor(/Stored allocations and recorded statuses, not native transfer/);
  assert.match(await b.evaluate('document.querySelector("[data-testid^=card-payout-period-]").innerText'),/Gross: Unavailable/);
  b.failRead("/api/payouts",{exact:true});await b.call("Page.reload");
  await b.waitFor(/Payout ledger unavailable/);
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=text-no-payouts]")'),false,"Failed ledger is not an empty/zero-income result");
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid^=card-payout-period-]")'),false,"Failed read cannot display stale allocation totals");
  b.failRead(null);await b.click('[data-testid="tab-content-payouts"] [data-testid="button-retry"]');
  await b.waitFor(/Stored allocations and recorded statuses, not native transfer/);
  await b.screenshot("payout-recorded-not-native-receipt");
  b.failRead("/api/campaigns",{exact:true});
  await b.navigate("/dashboard/reporting?tab=outreach-analytics");
  await b.waitFor(/Campaign reporting is unavailable/);
  for(const child of ["campaigns","ab-testing","messages"])
    assert.equal(await b.evaluate(`!!document.querySelector('[data-testid="tab-${child}"]')`),true);
  await b.click('[data-testid="tab-ab-testing"]');await b.waitFor(/No A\/B tests configured/);
  b.failRead("/api/sequences/ab-test-results",{exact:true});
  await b.call("Page.reload");await b.waitFor(/A\/B results unavailable/);
  await b.click('[data-testid="tab-messages"]');
  b.failRead("/api/outbound-messages",{exact:true});
  await b.call("Page.reload");await b.waitFor(/Message source unavailable/);
  await b.screenshot("outreach-independent-unavailable-children");
  b.failRead(null);
  rows.push({phase:"Payout observed/unknown scope and Outreach independent child failure states",mutationRequests:0,
    qualification:"Real payout reader/read-only retry and local report selections. No generate/approve/paid/A-B evaluation command invoked."});
  const acquisitionRequestsBefore=b.requests.length;
  for(const [route,path,message] of [
    ["/dashboard/document-vault","/api/merchant-documents","Document records unavailable; this is not an empty vault."],
    ["/dashboard/boarding","/api/boarding/submissions","Boarding submissions unavailable"],
    ["/dashboard/statement-review","/api/statement-reviews","Statement reviews unavailable; this is not a no-reviews result."],
  ]){
    b.failRead(path,{exact:true});
    await b.navigate(route);await b.waitFor(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.ok(b.readFaults.some(f=>f.path===path&&f.status===503),"The named acquisition/delivery fault executed");
    if(route==="/dashboard/document-vault"){
      assert.match(await b.evaluate('document.querySelector("[data-testid=text-doc-count]").innerText'),/unavailable/);
      assert.match(await b.evaluate('document.querySelector("[data-testid=count-pending-kyc]").innerText'),/Unavailable/);
      assert.equal(await b.evaluate(
        'Array.from(document.querySelectorAll("[data-testid^=count-category-]")).every(e=>e.innerText==="Unavailable")'),true,
        "A failed document source never becomes zero category counts");
    }
    if(route==="/dashboard/boarding")assert.equal(await b.evaluate(
      'Array.from(document.querySelectorAll("[data-testid^=kpi-]")).every(e=>e.innerText.includes("Unavailable"))'),true);
    await b.screenshot(route.split("/").pop()+"-read-unavailable");
    b.failRead(null);
  }
  assert.equal(b.requests.slice(acquisitionRequestsBefore).filter(r=>["POST","PATCH","DELETE","PUT"].includes(r.method)).length,0);
  rows.push({phase:"Documents, Boarding and Statements named source failure states",mutationRequests:0,
    qualification:"Actual registered readers, compiled mounted failure screens with executed 503 faults. Not parsing, deletion, transition or processor command acceptance."});
  const storyRequestsBefore=b.requests.length;
  const {testimonialSubmissions}=await import("../shared/schema");
  const stories=await h.db.insert(testimonialSubmissions).values(["pending","approved","rejected"].map(status=>({
    name:`${h.prefix} ${status} story read`,email:"story-browser@c4.example.test",
    story:"Owned isolated status reader",status,publish:false,contactId:preparationContactId,
  }))).returning();
  await b.navigate(`/dashboard/testimonial-submissions?testimonialView=approved&contactId=${preparationContactId}#proof`);
  await b.waitFor(new RegExp(`${h.prefix} approved story read`));
  assert.equal(await b.evaluate('location.pathname'),"/dashboard/merchant-success");
  assert.equal(await b.evaluate('new URLSearchParams(location.search).get("testimonialView")'),"approved");
  assert.equal(await b.evaluate('new URLSearchParams(location.search).get("contactId")'),String(preparationContactId));
  assert.equal(await b.evaluate('location.hash'),"#proof");
  assert.equal(await b.evaluate('document.querySelectorAll("h1").length'),1);
  await b.click('[data-testid="page-testimonial-submissions"] [data-testid="tab-rejected"]');
  await b.waitFor(new RegExp(`${h.prefix} rejected story read`));
  const storyHistory=await b.call("Page.getNavigationHistory");
  await b.click('[data-testid="page-testimonial-submissions"] [data-testid="tab-all"]');
  await b.waitFor(new RegExp(`${h.prefix} pending story read`));
  const allStoryHistory=await b.call("Page.getNavigationHistory");
  await b.call("Page.navigateToHistoryEntry",{entryId:storyHistory.entries[storyHistory.currentIndex].id});
  await b.waitFor(new RegExp(`${h.prefix} rejected story read`));
  await b.call("Page.navigateToHistoryEntry",{entryId:allStoryHistory.entries[allStoryHistory.currentIndex].id});
  await b.waitFor(new RegExp(`${h.prefix} pending story read`));
  await b.call("Page.reload");await b.waitFor(new RegExp(`${h.prefix} pending story read`));
  await b.screenshot("testimonials-retained-status-context");
  b.failRead("/api/testimonial-submissions",{exact:true});
  await b.call("Page.reload");
  await b.waitFor(/Story records unavailable; this is not a no-submissions result/);
  assert.ok(b.readFaults.some(f=>f.path==="/api/testimonial-submissions"&&f.status===503));
  assert.equal(await b.evaluate(`Array.from(document.querySelectorAll(
    '[data-testid="page-testimonial-submissions"] [data-testid^="text-count-"]')).filter(e=>e.innerText==="Unavailable").length`),4);
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=text-no-submissions]")'),false);
  await b.screenshot("testimonials-read-unavailable");
  b.failRead(null);
  await b.click('[data-testid="page-testimonial-submissions"] [data-testid="button-retry"]');
  await b.waitFor(new RegExp(`${h.prefix} pending story read`));
  const beforeInvalidStory=b.requests.length;
  await b.navigate("/dashboard/merchant-success?tab=testimonials&testimonialView=pending&testimonialView=approved");
  await b.waitFor(/Invalid\/conflicting testimonial view; no default story read was requested/);
  assert.equal(b.requests.slice(beforeInvalidStory).filter(r=>r.url.startsWith("/api/testimonial-submissions")).length,0);
  assert.equal(b.requests.slice(storyRequestsBefore).filter(r=>["POST","PATCH","DELETE","PUT"].includes(r.method)).length,0);
  rows.push({phase:"Testimonials typed status, context/history and named read failure",storyIds:stories.map(row=>row.id),
    mutationRequests:0,qualification:"Actual staff reader; no moderation, publication, command concurrency/version or native receipt acceptance."});

  const rfiRequestsBefore=b.requests.length;
  const {rfis}=await import("../shared/schema");
  const rfiRecords=await h.db.insert(rfis).values(["Open","Waiting on Merchant","Closed"].map(status=>({
    subject:`${h.prefix} ${status} retained RFI`,contactId:preparationContactId,status,
  }))).returning();
  await b.navigate(`/dashboard/rfis?rfiView=Waiting%20on%20Merchant&contactId=${preparationContactId}#rfi`);
  await b.waitFor(new RegExp(`${h.prefix} Waiting on Merchant retained RFI`));
  assert.equal(await b.evaluate('location.pathname'),"/dashboard/support-hub");
  assert.equal(await b.evaluate('location.hash'),"#rfi");
  assert.equal(await b.evaluate('document.querySelectorAll("h1").length'),1);
  await b.click('[data-testid="button-filter-open"]');
  await b.waitFor(new RegExp(`${h.prefix} Open retained RFI`));
  const openRfiHistory=await b.call("Page.getNavigationHistory");
  await b.click('[data-testid="button-filter-closed"]');
  await b.waitFor(new RegExp(`${h.prefix} Closed retained RFI`));
  const closedRfiHistory=await b.call("Page.getNavigationHistory");
  await b.call("Page.navigateToHistoryEntry",{entryId:openRfiHistory.entries[openRfiHistory.currentIndex].id});
  await b.waitFor(new RegExp(`${h.prefix} Open retained RFI`));
  await b.call("Page.navigateToHistoryEntry",{entryId:closedRfiHistory.entries[closedRfiHistory.currentIndex].id});
  await b.waitFor(new RegExp(`${h.prefix} Closed retained RFI`));
  await b.call("Page.reload");await b.waitFor(new RegExp(`${h.prefix} Closed retained RFI`));
  await b.navigate(`/dashboard/support-hub?tab=rfis&rfiView=Closed&id=${rfiRecords[2].id}&contactId=${preparationContactId}#rfi`);
  await b.waitFor(/Authorized record context. No reply or workflow was executed/);
  await b.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await b.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  for(let attempt=0;attempt<60;attempt++){
    if(await b.evaluate('!new URLSearchParams(location.search).has("id")'))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(await b.evaluate('new URLSearchParams(location.search).has("id")'),false);
  assert.equal(await b.evaluate('new URLSearchParams(location.search).get("rfiView")'),"Closed");
  assert.equal(await b.evaluate('new URLSearchParams(location.search).get("contactId")'),String(preparationContactId));
  assert.equal(await b.evaluate('location.hash'),"#rfi");
  b.failRead("/api/rfis",{exact:true});
  await b.call("Page.reload");
  await b.waitFor(/RFI records unavailable; this is not an empty queue/);
  assert.ok(b.readFaults.some(f=>f.path==="/api/rfis"&&f.status===503));
  assert.equal(await b.evaluate(`Array.from(document.querySelectorAll('[data-testid^="text-rfi-"][data-testid$="-count"]')).filter(e=>e.innerText==="Unavailable").length`),3);
  assert.equal(await b.evaluate('document.querySelector("[data-testid=button-create-rfi]").disabled'),true);
  assert.match(await b.evaluate('document.querySelector("[data-testid=button-filter-all]").innerText'),/Unavailable/);
  await b.screenshot("rfis-read-unavailable");
  b.failRead(null);
  await b.click('[data-testid="page-rfis"] [data-testid="button-retry"]');
  await b.waitFor(new RegExp(`${h.prefix} Closed retained RFI`));
  const beforeInvalidRfi=b.requests.length;
  await b.navigate("/dashboard/support-hub?tab=rfis&rfiView=Open&rfiView=Closed");
  await b.waitFor(/Invalid\/conflicting RFI view; no default collection read was requested/);
  assert.equal(b.requests.slice(beforeInvalidRfi).filter(r=>r.url.startsWith("/api/rfis")).length,0);
  assert.equal(b.requests.slice(rfiRequestsBefore).filter(r=>["POST","PATCH","DELETE","PUT"].includes(r.method)).length,0);
  rows.push({phase:"RFI typed status/context/history, exact selected close and named collection failure",rfiIds:rfiRecords.map(row=>row.id),
    mutationRequests:0,qualification:"Actual A collection/exact readers with compiled UI. Not legacy RFI write, durable B command, focus-return or native acceptance."});

  // Separate mutation phase: do not promote the preceding reader-only phase.
  await b.navigate("/dashboard/support-hub?tab=rfis");
  await b.waitFor(new RegExp(`${h.prefix} Open retained RFI`));
  const rfiCommandRequests=b.requests.length;
  await b.click('[data-testid="button-create-rfi"]');
  await b.set('[data-testid="input-rfi-subject"]',`${h.prefix} cancelled RFI`);
  async function closeCommandDialog(errorToastTitle?:string){
    async function escape(){
      await b.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await b.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    }
    if(errorToastTitle){
      const errorToastOpen=()=>b.evaluate(`Array.from(document.querySelectorAll('li[data-state="open"]'))
        .some(e=>e.innerText.includes(${JSON.stringify(errorToastTitle)}))`);
      assert.equal(await errorToastOpen(),true,"The open error toast is the highest dismissal owner");
      await escape();
      for(let attempt=0;attempt<40&&await errorToastOpen();attempt++)await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(await errorToastOpen(),false,"First native Escape dismisses the toast");
      assert.equal(await b.evaluate('!!document.querySelector("[role=dialog]")'),true,
        "First Escape must not dismiss two owners at once");
      // Closed state precedes Presence unmount. The closing toast still owns
      // its DismissableLayer until the actual exit animation has completed.
      const closingToastPresent=()=>b.evaluate(`Array.from(document.querySelectorAll('li[role="status"]'))
        .some(e=>e.innerText.includes(${JSON.stringify(errorToastTitle)}))`);
      for(let attempt=0;attempt<80&&await closingToastPresent();attempt++)await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(await closingToastPresent(),false,"Closing toast actually unmounts before the next owner's Escape");
    }
    await escape();
    for(let attempt=0;attempt<40;attempt++){
      if(await b.evaluate('!document.querySelector("[role=dialog]")'))break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(await b.evaluate('!!document.querySelector("[role=dialog]")'),false);
  }
  await closeCommandDialog();
  assert.equal(b.requests.slice(rfiCommandRequests).filter(r=>r.method==="POST"&&r.url==="/api/rfis").length,0,"RFI Cancel has no request");
  const uiRfiSubject=`${h.prefix} UI RFI lost confirmation`;
  await b.click('[data-testid="button-create-rfi"]');
  await b.set('[data-testid="input-rfi-subject"]',uiRfiSubject);
  const rfiFaultStart=h.responseFaultEvents.length;
  h.loseNextSuccessfulResponse("POST","/api/rfis","truncate");
  await b.click('[data-testid="button-submit-rfi"]');
  await b.waitFor(/Local RFI creation failed or unconfirmed/);
  assert.ok(h.responseFaultEvents.slice(rfiFaultStart).some(event=>event.event==="executed"&&event.status===201),
    "Mounted RFI post-commit confirmation loss actually executed");
  await closeCommandDialog("Local RFI creation failed or unconfirmed");
  await b.waitFor(/Local RFI intent create is unconfirmed/);
  await b.screenshot("rfi-command-unconfirmed");
  const uiRfis=(await h.pool.query("SELECT id,authority_fence,status FROM rfis WHERE subject=$1",[uiRfiSubject])).rows;
  assert.equal(uiRfis.length,1);
  const uiRfiId=uiRfis[0].id;
  const uiReceipts=(await h.pool.query("SELECT command_id FROM rfi_command_receipts WHERE rfi_id=$1",[uiRfiId])).rows;
  assert.equal(uiReceipts.length,1);
  await b.click('[data-testid="button-retry-rfi-create"]');
  await b.waitFor(/Captured local RFI intent confirmed/);
  await b.waitFor(new RegExp(uiRfiSubject));
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=rfi-uncertain-create]")'),false);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM rfi_command_receipts WHERE rfi_id=$1",[uiRfiId])).rows[0].n,1);
  assert.equal(b.requests.slice(rfiCommandRequests).filter(r=>r.method==="POST"&&r.url==="/api/rfis").length,2,
    "One initial creation and unchanged frozen replay, not a second durable intent");
  await b.click(`[data-testid="button-start-rfi-${uiRfiId}"]`);
  await b.waitFor(/RFI updated/);
  await b.call("Page.reload");await b.waitFor(new RegExp(uiRfiSubject));
  const uiRfiReadback=(await h.pool.query("SELECT authority_fence,status FROM rfis WHERE id=$1",[uiRfiId])).rows[0];
  assert.deepEqual(uiRfiReadback,{authority_fence:1,status:"In Progress"});
  assert.equal(h.externalCalls(),0);
  rows.push({phase:"Mounted local RFI Cancel, executed confirmation loss, frozen replay and fenced edit/reload",
    rfiId:uiRfiId,commandId:uiReceipts[0].command_id,faultExecuted:true,
    outcome:"One local creation intent and one versioned edit; no native transport",
    qualification:"Actual admin UI/source handlers. Not Contact-tab mutation, assignment UI, every status/actor/mobile/keyboard/restart or native delivery acceptance."});

  await b.navigate("/dashboard/support-hub?tab=tickets");
  await b.waitFor(/Tickets/);
  const ticketCommandRequests=b.requests.length;
  await b.click('[data-testid="button-new-ticket"]');
  await b.set('[data-testid="input-ticket-subject"]',`${h.prefix} cancelled ticket`);
  await b.set('[data-testid="input-ticket-description"]',"Cancelled local intent");
  await closeCommandDialog();
  assert.equal(b.requests.slice(ticketCommandRequests).filter(r=>r.method==="POST"&&r.url==="/api/tickets").length,0,"Ticket Cancel has no write");
  const uiTicketSubject=`${h.prefix} UI ticket lost confirmation`;
  await b.click('[data-testid="button-new-ticket"]');
  await b.set('[data-testid="input-ticket-subject"]',uiTicketSubject);
  await b.set('[data-testid="input-ticket-description"]',"Local-only ticket description");
  const ticketFaultStart=h.responseFaultEvents.length;
  h.loseNextSuccessfulResponse("POST","/api/tickets","truncate");
  await b.click('[data-testid="button-submit-ticket"]');
  await b.waitFor(/Failed to create ticket/);
  assert.ok(h.responseFaultEvents.slice(ticketFaultStart).some(event=>event.event==="executed"&&event.status===201),
    "Mounted ticket post-commit reply loss actually executed");
  await closeCommandDialog("Failed to create ticket");
  await b.waitFor(/Local ticket intent is unconfirmed/);
  const uiTickets=(await h.pool.query("SELECT id,authority_fence FROM tickets WHERE subject=$1",[uiTicketSubject])).rows;
  assert.equal(uiTickets.length,1);
  const uiTicketId=uiTickets[0].id;
  await b.screenshot("ticket-command-unconfirmed");
  await b.click('[data-testid="button-retry-ticket-create"]');
  await b.waitFor(/Local ticket creation confirmed/);
  await b.waitFor(new RegExp(uiTicketSubject));
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=ticket-create-unconfirmed]")'),false);
  await b.call("Page.reload");await b.waitFor(new RegExp(uiTicketSubject));
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM tickets WHERE subject=$1",[uiTicketSubject])).rows[0].n,1);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM ticket_authority_events WHERE ticket_id=$1 AND event_type='creation_intent_accepted'",[uiTicketId])).rows[0].n,1);
  assert.equal(b.requests.slice(ticketCommandRequests).filter(r=>r.method==="POST"&&r.url==="/api/tickets").length,2);
  assert.equal(h.externalCalls(),0);
  rows.push({phase:"Mounted employee ticket Cancel, executed confirmation loss, frozen replay and reload",
    ticketId:uiTicketId,faultExecuted:true,outcome:"One local creation intent through existing ticket issue/generation authority",
    qualification:"Admin compiled UI/source handlers; not Contact caller, all existing ticket edits/reassignments/duplicates/actor/keyboard/mobile/restart, inbound producer or native acceptance."});

  const [dueContact]=await h.db.insert(contacts).values({firstName:h.prefix,lastName:"RFI Due Interior",
    email:`${h.prefix}-rfi-due@example.test`,phone:"",recordClass:"production",assignedTo:h.email("admin")}).returning();
  const dueSubject=`${h.prefix} precise due interior`;
  const [dueRow]=(await h.pool.query(`INSERT INTO rfis(contact_id,subject,description,status,category,priority,due_date)
    VALUES($1,$2,'Local deadline preservation','Open','General','Normal','2026-10-09 04:22:33.123456+00') RETURNING id`,
    [dueContact.id,dueSubject])).rows;
  const dueBefore=(await h.pool.query("SELECT due_date::text AS value FROM rfis WHERE id=$1",[dueRow.id])).rows[0].value;
  const originalBrowserZone=await b.evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone");
  await b.call("Emulation.setTimezoneOverride",{timezoneId:"America/Bogota"});
  await b.navigate(`/dashboard/contacts/${dueContact.id}?area=lifecycle&section=rfis`);
  await b.waitFor(new RegExp(dueSubject));
  await b.click(`[data-testid="button-edit-rfi-${dueRow.id}"]`);
  await b.waitFor(/Due day · browser local/);
  assert.equal(await b.evaluate('document.querySelector("[data-testid=input-rfi-due-date]").value'),"2026-10-08");
  const changedDueSubject=`${h.prefix} precise due subject changed`;
  const dueRequestsStart=b.requests.length;
  await b.set('[data-testid="input-rfi-subject"]',changedDueSubject);
  await b.click('[data-testid="button-save-rfi"]');
  await b.waitFor(/Local RFI updated/);
  await b.waitFor(new RegExp(changedDueSubject));
  assert.equal((await h.pool.query("SELECT due_date::text AS value FROM rfis WHERE id=$1",[dueRow.id])).rows[0].value,dueBefore,
    "Mounted Bogota subject edit preserves full recorded instant/native microseconds");
  assert.equal((await h.pool.query("SELECT authority_fence FROM rfis WHERE id=$1",[dueRow.id])).rows[0].authority_fence,1);
  assert.equal(b.requests.slice(dueRequestsStart).filter(r=>r.method==="PUT"&&r.url===`/api/rfis/${dueRow.id}`).length,1);
  await b.call("Page.reload");await b.waitFor(new RegExp(changedDueSubject));
  await b.screenshot("contact-rfi-due-preserved");
  await b.call("Emulation.setTimezoneOverride",{timezoneId:originalBrowserZone});
  rows.push({phase:"Mounted C2 Lifecycle RFI interior preserves unchanged due instant",
    contactId:dueContact.id,rfiId:dueRow.id,timezone:"America/Bogota",outcome:"One versioned subject edit; recorded microseconds retained through reload",
    qualification:"Actual selected interior in unchanged C2 shell; not date-picker replacement/clear, every status/actor/overlay/focus/native or whole-Contact acceptance."});

  rows.push(await runC4HealthReadCase(h,b));

  const reviewFixtures=(await h.pool.query(`INSERT INTO review_queue(source_type,source_id,status,metadata)
    VALUES('quiz',101,'pending',$1::jsonb),('quiz',102,'approved',$2::jsonb) RETURNING id`,
    [JSON.stringify({contactName:`${h.prefix} pending review read`}),JSON.stringify({contactName:`${h.prefix} approved review read`})])).rows;
  const reviewRequestsBefore=b.requests.length;
  const reviewAggregate=await h.request("admin","GET","/api/review-queue/pending-count");
  assert.equal(reviewAggregate.status,200);
  const expectedReviewPending=String(reviewAggregate.body.pending);
  await b.navigate(`/dashboard/review-queue?reviewView=approved&dealId=${source.id}#review`);
  await b.waitFor(new RegExp(`${h.prefix} approved review read`));
  assert.equal(await b.evaluate('document.querySelector("[data-testid=tab-approved]").getAttribute("aria-selected")'),"true");
  assert.match(await b.evaluate('location.search'),new RegExp(`dealId=${source.id}`));
  assert.equal(await b.evaluate('location.hash'),"#review");
  const reviewHistory=await b.call("Page.getNavigationHistory");
  await b.click('[data-testid="tab-pending"]');await b.waitFor(new RegExp(`${h.prefix} pending review read`));
  assert.match(await b.evaluate('location.search'),/reviewView=pending/);
  const pendingHistory=await b.call("Page.getNavigationHistory");
  await b.call("Page.navigateToHistoryEntry",{entryId:reviewHistory.entries[reviewHistory.currentIndex].id});
  await b.waitFor(new RegExp(`${h.prefix} approved review read`));
  await b.call("Page.navigateToHistoryEntry",{entryId:pendingHistory.entries[pendingHistory.currentIndex].id});
  await b.waitFor(new RegExp(`${h.prefix} pending review read`));
  b.failRead("/api/review-queue",{exact:true});await b.call("Page.reload");
  await b.waitFor(/Review records unavailable; this is not an empty or caught-up queue/);
  assert.equal(await b.evaluate('document.querySelector("[data-testid=page-review-queue]").innerText.includes("All caught up")'),false);
  // The failed collection and successful aggregate settle independently.
  for(let attempt=0;attempt<40&&await b.evaluate(
      'document.querySelector("[data-testid=text-pending-count]")?.innerText')!==expectedReviewPending;attempt++)
    await new Promise(resolve=>setTimeout(resolve,100));
   assert.equal(await b.evaluate('document.querySelector("[data-testid=text-pending-count]").innerText'),expectedReviewPending);
  b.failRead(null);await b.click('[data-testid="page-review-queue"] [data-testid="button-retry"]');
  await b.waitFor(new RegExp(`${h.prefix} pending review read`));
  b.failRead(`/api/review-queue/${reviewFixtures[0].id}`,{exact:true});
  await b.click(`[data-testid="row-queue-item-${reviewFixtures[0].id}"]`);
  await b.waitFor(/Selected review item has no current authorized read/);
  for(let attempt=0;attempt<40&&!b.requests.some(r=>r.url===`/api/review-queue/${reviewFixtures[0].id}`&&r.status===503);attempt++)
    await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(b.requests.some(r=>r.url===`/api/review-queue/${reviewFixtures[0].id}`&&r.status===503),"Selected-record fault actually returned 503");
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=button-approve]")'),false);
  await b.click('[data-testid="button-cancel-review-read"]');b.failRead(null);
  const invalidReviewRequestsBefore=b.requests.length;
  await b.navigate("/dashboard/support-hub?tab=review-queue&reviewView=pending&reviewView=approved");
  await b.waitFor(/Invalid\/conflicting Review Queue view/);
  assert.equal(b.requests.slice(invalidReviewRequestsBefore).filter(r=>new URL(r.url,h.base).pathname==="/api/review-queue").length,0,
    "Conflicting nested views do not request a silently defaulted record population");
  // Owned fixture preparation only: this is NOT a checklist command receipt.
  const checklistResponse=await h.originalFetch(`${h.base}/api/review-queue/checklist-items`,{headers:{cookie:h.sessions.get("admin")!.cookie}});
  assert.equal(checklistResponse.status,200);
  const checklistDefinition=await checklistResponse.json() as Array<{key:string}>;
  await h.pool.query("UPDATE review_queue SET checklist_state=$1::jsonb WHERE id=$2",
    [JSON.stringify(Object.fromEntries(checklistDefinition.map(item=>[item.key,true]))),reviewFixtures[0].id]);
  await b.navigate("/dashboard/support-hub?tab=review-queue&reviewView=pending");
  await b.waitFor(new RegExp(`${h.prefix} pending review read`));
  const reviewTrigger=`[data-testid="button-open-review-${reviewFixtures[0].id}"]`;
  await b.click(reviewTrigger);await b.waitFor(new RegExp(`Quiz Lead — ${h.prefix} pending review read`));
  async function reviewKey(key:"Escape"|"Enter"){
    const code=key==="Escape"?27:13;
    for(const type of ["keyDown","keyUp"])await b.call("Input.dispatchKeyEvent",{type,key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,
      ...(key==="Enter"&&type==="keyDown"?{text:"\r",unmodifiedText:"\r"}:{})});
  }
  await reviewKey("Escape");
  for(let attempt=0;attempt<30;attempt++){
    if(await b.evaluate(`!document.querySelector("[data-testid=sheet-review-record]") &&
      document.activeElement?.getAttribute("data-testid")===${JSON.stringify(`button-open-review-${reviewFixtures[0].id}`)} &&
      document.activeElement?.isConnected`))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(await b.evaluate(`document.activeElement?.getAttribute("data-testid")`),`button-open-review-${reviewFixtures[0].id}`);
  await reviewKey("Enter");await b.waitFor(new RegExp(`Quiz Lead — ${h.prefix} pending review read`));
  await b.click('[data-testid="button-approve"]');await b.waitFor(/Confirm Approval/);
  assert.equal(await b.evaluate(`(async()=>{
    for(let i=0;i<100;i++){
      const modal=Array.from(document.querySelectorAll('[role="dialog"]')).find(e=>
        e.getAttribute("data-state")==="open"&&e.textContent.includes("Confirm Approval"));
      if(modal?.contains(document.activeElement)){
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        return true;
      }
      await new Promise(r=>setTimeout(r,25));
    }
    return false;
  })()`),true,"Nested modal opening focus must settle before its single Escape");
  await reviewKey("Escape");
  for(let attempt=0;attempt<30&&await b.evaluate('Array.from(document.querySelectorAll("[role=dialog]")).some(el=>el.textContent.includes("Confirm Approval"))');attempt++)
    await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=sheet-review-record]")'),true,"First Escape closes only nested confirmation");
  assert.equal(await b.evaluate('document.activeElement?.getAttribute("data-testid")'),"button-approve");
  await reviewKey("Escape");
  for(let attempt=0;attempt<30;attempt++){
    if(await b.evaluate(`!document.querySelector("[data-testid=sheet-review-record]") &&
      document.activeElement?.getAttribute("data-testid")===${JSON.stringify(`button-open-review-${reviewFixtures[0].id}`)} &&
      document.activeElement?.isConnected`))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(await b.evaluate('document.activeElement?.getAttribute("data-testid")'),`button-open-review-${reviewFixtures[0].id}`);
  const reviewMutations=b.requests.slice(reviewRequestsBefore).filter(r=>!["GET","HEAD","OPTIONS"].includes(r.method));
  assert.equal(reviewMutations.length,0,"View/Back/Forward/fault/retry/Cancel are read-only");
  await b.screenshot("review-independent-read-failure-no-snapshot-authority");
  rows.push({phase:"Review Queue typed status, alias/context/history and independent read errors",
    qualification:"Registered read-only sources; record and selected-item faults executed, successful aggregate retained; keyboard open/Escape/connected return and nested confirmation dismissal; no approval/checklist/workflow command proof",mutationRequests:reviewMutations.length});
  await b.close();
  finishedContexts.push({role:browserRole,requests:b.requests,exceptions:b.exceptions});
  browserRole="agent";
  b=await privateStage3Browser(h.base,h.sessions.get("agent")!.cookie,h.originalFetch,
    "docs/certification/stage3-c4/browser",{realInput:true});
  await b.navigate("/dashboard/my-earnings");
  await settleStaffTour("agent");
  await b.waitFor(/My Earnings/);
  await b.waitFor(/\$0.30/);
  assert.equal(await b.evaluate('document.body.innerText.includes("$9,999")'),false,"Own earnings never include another agent's ledger");
  assert.equal(await b.evaluate('document.querySelectorAll("h1").length'),1);
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="text-pending-earnings"]\').textContent.trim()'),"Unavailable",
    "No pending amount observations is not a zero pending-payment claim");
  const agentLinks=await b.evaluate('Array.from(document.querySelectorAll(\'[data-testid="agent-reports-navigation"] a\')).map(a=>({href:a.getAttribute("href"),height:a.getBoundingClientRect().height}))');
  assert.deepEqual(agentLinks.map((a:any)=>a.href),["/dashboard/my-earnings","/dashboard/leaderboard"]);
  assert.ok(agentLinks.every((a:any)=>a.height>=44));
  await b.screenshot("agent-earnings-scoped-links");
  await b.click('[data-testid="agent-reports-navigation"] a[href="/dashboard/leaderboard"]');
  await b.waitFor(/Team Leaderboard/);
  await b.waitFor(/complete_returned_deal_population/);
  assert.equal(await b.evaluate('document.querySelectorAll("h1").length'),1);
  assert.equal(await b.evaluate('document.querySelector(\'[data-testid="agent-reports-navigation"] a[aria-current="page"]\').getAttribute("href")'),"/dashboard/leaderboard");
  await b.click('[data-testid="tab-metric-revenue"]');
  await b.waitFor(/\$10.10/);
  assert.equal(await b.evaluate('document.body.innerText.includes("not observed revenue or native receipts")'),true);
  await b.screenshot("agent-leaderboard-recorded-volume");
  b.failRead("/api/leaderboard",{status:503,message:"Owned scoreboard read unavailable",exact:true});
  await b.click('[data-testid="select-time-period"]');
  await b.waitFor(/Last 7 Days/);
  await b.click('[role="option"][data-state="unchecked"]');
  await b.waitFor(/Complete leaderboard population unavailable/);
  assert.equal(await b.evaluate('!!document.querySelector(\'[data-testid="agent-reports-navigation"]\')'),true);
  b.failRead(null);
  await b.click('[data-testid="agent-reports-navigation"] a[href="/dashboard/my-earnings"]');
  await b.waitFor(/\$0.30/);
  assert.equal(b.requests.filter(r=>r.url.startsWith("/api/revenue/residual-group-scope")||r.url.startsWith("/api/reporting/operations")).length,0,
    "Agent local navigation does not mount privileged hub readers");
  rows.push({phase:"Agent Reports scoped local wrappers",role:"agent",ownStoredPaidShare:0.30,
    links:agentLinks,foreignLedgerAbsent:true,privilegedHubReads:0,
    qualification:"Actual Earnings and Leaderboard readers; stored processing volume distinguished from revenue, source fault retains local links; not settings-action, complete population or same-document account-switch proof"});
  const surfaces:any[]=[];
  const inventoryCases=await c4InventoryCases();
  for(const role of ["admin","manager","agent","other","merchant","partner"]){
    await b.close();finishedContexts.push({role:browserRole,requests:b.requests,exceptions:b.exceptions});
    browserRole=role;
    b=await privateStage3Browser(h.base,h.sessions.get(role as any)!.cookie,h.originalFetch,
      "docs/certification/stage3-c4/browser",{realInput:true});
    await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    if(["admin","manager","agent"].includes(role)){
      await b.navigate(role==="agent"?"/dashboard/my-earnings":"/dashboard/portfolio");
      await settleStaffTour(role);
    }
    for(const c of inventoryCases.filter(c=>c.kind==="route"||role==="admin")){
      const before=b.requests.length;
      await b.navigate(c.url);await new Promise(resolve=>setTimeout(resolve,450));
      // Authentication/lazy-route hydration can still leave an empty main at
      // this point. Wait for mounted content, NOT a claimed useful-list time.
      for(let attempt=0;attempt<40;attempt++){
        if(await b.evaluate('!!(document.querySelector("main")||document.body)?.innerText.trim()'))break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      let selection="not requested";
      if(c.click){
        if(await b.evaluate(`!!document.querySelector(${JSON.stringify(c.click)})`)){
          await b.click(c.click);await new Promise(resolve=>setTimeout(resolve,200));selection="actual local control clicked; not command acceptance";
        }else selection="UNVERIFIED: expected nested selector not rendered";
      }
      surfaces.push({case:c,role,selection,snapshot:await b.evaluate(c4ControlSnapshotExpression),requests:b.requests.slice(before)});
    }
  }
  await writeC4ControlInventory(surfaces,identity,h.prefix);
  await b.close();
  finishedContexts.push({role:browserRole,requests:b.requests,exceptions:b.exceptions});
  b=undefined;
  await runC4MatchedPerformance(h,identity,root=>{clientRoot=root;});
  rows.push({phase:"Actual retained route/panel mounted inventory",surfaces:surfaces.length,
    qualification:"39 route references across six fixture roles plus 70 historical panels in admin context; nested selector absent/denied/loading explicitly retained; no action acceptance or full state-space proof"});
  assert.equal(h.externalCalls(),0);
  await mkdir("docs/certification/stage3-c4",{recursive:true});
  await writeFile("docs/certification/stage3-c4/browser-receipt.json",JSON.stringify({status:"passed",identity,rows,
    contexts:browserContexts(),exceptions:browserContexts().flatMap(c=>c.exceptions),
    requests:browserContexts().flatMap(c=>c.requests.map(request=>({role:c.role,...(request as Record<string,unknown>)}))),externalEgress:0,
    qualification:"Actual compiled client, authenticated private disposable fixture, registered source readers; unregistered independent sources return501. Named native200%/matched Portfolio performance and reader/client rollback evidence is separate. Not all-actions/full keyboard or published-server acceptance."},null,2)+"\n");
  console.log("C4 bounded mounted browser PASS");
  if(process.argv.includes("--snapshot-hold")){
    console.log(`C4_PUBLIC_SIGNED_OUT_SNAPSHOT_PORT=${new URL(h.base).port}`);
    await new Promise(resolve=>setTimeout(resolve,120000));
  }
} catch(error) {
  if(b){
    await writeFile("docs/certification/stage3-c4/browser/failed-receipt.json",JSON.stringify({
      status:"failed",identity,rows,contexts:browserContexts(),
      exceptions:browserContexts().flatMap(c=>c.exceptions),requests:browserContexts().flatMap(c=>c.requests),
      location:await b.evaluate("location.pathname"),
      desktopPreference:await b.evaluate('localStorage.getItem("prefer_desktop")==="true"'),
      error:error instanceof Error?error.message:"Unknown fixture failure",externalServerTransportAttempts:h.externalCalls(),
    },null,2)+"\n");
    await b.screenshot("candidate-failure");
    if(process.argv.includes("--snapshot-hold")){
      console.log(`C4_PUBLIC_SIGNED_OUT_SNAPSHOT_PORT=${new URL(h.base).port}`);
      await new Promise(resolve=>setTimeout(resolve,120000));
    }
  }
  throw error;
} finally {await b?.close();await h.close();}
