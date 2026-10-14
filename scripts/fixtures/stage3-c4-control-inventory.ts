import {readFile,writeFile} from "node:fs/promises";

/** Fixture-only inventory. A mounted control is NEVER an accepted action. */
export async function c4InventoryCases(){
  const source=JSON.parse(await readFile("docs/certification/stage3-c4/source-inventory.json","utf8"));
  const cases:Array<{id:string;url:string;kind:string;click?:string}>=[
    ...source.routes.map((r:any)=>({id:r.id,url:r.pattern,kind:"route"})),
    ...source.panels.map((p:any)=>({id:p.id,url:p.url,kind:"historical-panel"})),
  ];
  const revenue=["dashboard","by-partner","reconcile","history","payouts"];
  const health=["alerts","churn-risk","nps","signal-settings"];
  const metrics=["deals","revenue","proposals","calls","closeRate","contacts"];
  for(const c of cases){
    const n=Number(c.id.slice(2));
    if(c.kind==="historical-panel"&&n>=125&&n<=129)c.url+=`&revenueView=${revenue[n-125]}`;
    if(c.kind==="historical-panel"&&n>=133&&n<=136)c.url+=`&healthView=${health[n-133]}`;
    if(c.kind==="historical-panel"&&n>=218&&n<=220)c.url+=`?underwritingView=${["queue","approved","config"][n-218]}`;
    if(c.kind==="historical-panel"&&n>=130&&n<=132)c.click=`[data-testid="tab-${["campaigns","ab-testing","messages"][n-130]}"]`;
    if(c.kind==="historical-panel"&&n>=195&&n<=200)c.click=`[data-testid="tab-metric-${metrics[n-195]}"]`;
    if(c.kind==="historical-panel"&&n>=221&&n<=226)c.click=`[role="tab"][data-testid="tab-status-${["all","submitted","under_review","approved","declined","draft"][n-221]}"]`;
    if(c.kind==="historical-panel"&&n>=227&&n<=232)c.click=`[role="tab"][data-testid="tab-boarding-${["all","submitted","under_review","more_info_needed","approved","declined"][n-227]}"]`;
    if(c.kind==="historical-panel"&&n>=252&&n<=255)c.click=`[role="tab"][data-testid="tab-${["pending","approved","rejected","all"][n-252]}"]`;
    if(c.kind==="historical-panel"&&n>=256&&n<=258)c.click=`[role="tab"][data-testid="tab-${["pending","approved","all"][n-256]}"]`;
  }
  return cases;
}

export const c4ControlSnapshotExpression=`(()=>{
 const root=document.querySelector("main")||document.body;
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"};
 const controls=[...root.querySelectorAll('button,input,select,textarea,a[href],[role="tab"],[role="switch"],[role="checkbox"],[role="combobox"]')].filter(visible).map((e,index)=>{
   const r=e.getBoundingClientRect();
   const referenced=(e.getAttribute("aria-labelledby")||"").split(/\\s+/).map(id=>document.getElementById(id)?.textContent||"").join(" ").trim();
   const label=e.getAttribute("aria-label")||referenced||[...(e.labels||[])].map(l=>l.textContent).join(" ").trim()||e.getAttribute("title")||e.textContent?.trim()||e.getAttribute("placeholder")||"";
   return {index,testId:e.getAttribute("data-testid"),id:e.id,tag:e.tagName,role:e.getAttribute("role"),type:e.getAttribute("type"),label:label.slice(0,300),
     disabled:!!e.disabled||e.getAttribute("aria-disabled")==="true",href:e.getAttribute("href"),expanded:e.getAttribute("aria-expanded"),selected:e.getAttribute("aria-selected"),
     width:r.width,height:r.height,inViewport:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth};
 });
 return {url:location.pathname+location.search+location.hash,title:document.title,h1:[...document.querySelectorAll("h1")].map(e=>e.textContent),
   scopeRoot:root.tagName,states:[...root.querySelectorAll('[data-crm-state],[data-testid="dashboard-error-state"]')].map(e=>({
     state:e.getAttribute("data-crm-state")||"read_error_unadjudicated",sourceTestId:e.getAttribute("data-testid"),text:e.textContent?.trim().slice(0,500)})),
   text:root.innerText.slice(0,4000),controls,viewport:{width:innerWidth,height:innerHeight},theme:document.documentElement.classList.contains("dark")?"dark":"light"};
})()`;

export async function writeC4ControlInventory(surfaces:any[],identity:any,fixtureId:string){
  const base="docs/certification/stage3-c4";
  const columns=["sourceClaimIds","repairGroup","routePattern","currentUrl","area","section","controlId","label","role","fixtureId","fixtureClass","handler","prestate","expectedRequest","expectedResult","actualResult","readbackReceipt","refreshResult","retryResult","cancelEffects","unauthorizedEffects","providerEffects","queueEffects","auditReceipt","viewport","theme","keyboardResult","sourceSha","servingBuildId","verdict","remainingOwner"];
  const rows=surfaces.flatMap(s=>s.snapshot.controls.map((c:any)=>({
    sourceClaimIds:s.case.id,repairGroup:"C4 actual mounted inventory; parent repair-group adjudication pending",
    routePattern:s.case.url,currentUrl:s.snapshot.url,area:s.snapshot.url.includes("report")||s.snapshot.url.includes("financial")?"Reports":"Merchant/portal/standalone destination",
    section:s.case.id,controlId:c.testId||c.id||`${c.tag}:${c.role||c.type||""}:${c.index}`,label:c.label,
     role:s.role==="other"?"agent (non-owner fixture)":s.role,fixtureId:`${fixtureId}:${s.role}`,
     fixtureClass:"owned disposable synthetic records; production-class where required by the reader",
    handler:"Not exercised by inventory; see separate registered-handler receipt",
    prestate:JSON.stringify({disabled:c.disabled,selected:c.selected,expanded:c.expanded,inViewport:c.inViewport}),
    expectedRequest:"UNVERIFIED",expectedResult:"UNVERIFIED",actualResult:"Rendered control snapshot only; no action acceptance",
    readbackReceipt:"control-inventory.json",refreshResult:"UNVERIFIED",retryResult:"UNVERIFIED",cancelEffects:"UNVERIFIED",
    unauthorizedEffects:"UNVERIFIED per control; route request journal retained",providerEffects:"No real egress; no per-action proof",queueEffects:"UNVERIFIED",
    auditReceipt:"UNVERIFIED",viewport:`${s.snapshot.viewport.width}x${s.snapshot.viewport.height}`,theme:s.snapshot.theme,
    keyboardResult:"UNVERIFIED",sourceSha:identity.sourceHead,servingBuildId:`private compiled client ${identity.outputHash}; not published`,
    verdict:"UNTESTED",remainingOwner:"C4 presentation; shared authority/composition owner adjudication pending",
  })));
  const quote=(v:unknown)=>`"${String(v??"").replaceAll('"','""')}"`;
  await writeFile(`${base}/actions.csv`,columns.join(",")+"\n"+rows.map(r=>columns.map(c=>quote((r as any)[c])).join(",")).join("\n")+"\n");
  await writeFile(`${base}/control-inventory.json`,JSON.stringify({identity,qualification:"Actual mounted snapshots, NOT complete action/state acceptance, keyboard/a11y or useful-record timing. Only captured states; absent overlays/failed selections remain unverified.",surfaces,counts:{total:rows.length,pass:0,defect:0,blocked:0,untested:rows.length}},null,2)+"\n");
}
