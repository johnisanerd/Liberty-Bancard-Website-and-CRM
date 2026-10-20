import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {monitorEventLoopDelay} from "node:perf_hooks";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";

// GHL Integration Hub -> GHL Settings against the REAL incoming-sync handlers and service, with REAL persisted
// runs in system_settings sized like the stored production run (3,994 contacts). Compiled client in a private
// Chromium with a real admin session on a disposable migrated database. GHL contact pages come from an
// in-process fake (provider egress stays denied). Outbound stays paused. Measures main-thread frame gaps and
// long tasks, a CPU profile, server event-loop delay and the latency of an unrelated fast endpoint while the
// page mounts and while preview and apply steps run. Findings are recorded, not assumed.
const identity=await verifyCandidateIdentity();
const dir="docs/certification/stage3-c5/browser";
const clientRoot=path.resolve("dist/public");
const PROD_SIZE=3994;
const KEY="ghl_inbound_contact_sync";
const h=await stage3BHttpFixture(async app=>{
  const mod=await import("../server/routes/ghl-inbound-sync.ts");mod.registerGhlInboundSyncRoutes(app);
  app.get("/api/ghl/status",(_req,res)=>res.json({configured:true,hasApiKey:false,hasPrivateToken:true,hasLocationId:true,hasCalendarId:true}));
  app.get("/api/ghl/circuit-status",(_req,res)=>res.json({state:"closed",failures:0}));
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C5 fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
process.env.GHL_PRIVATE_INTEGRATION_TOKEN="fixture-token";process.env.GHL_LOCATION_ID="fixture-location";
// In-process fake of the GHL contacts list. Anything else still goes to the fixture's denying fetch.
const guarded=globalThis.fetch;let fakeGhlCalls=0;
globalThis.fetch=(async(input:any,init:any)=>{
  const url=String(input);
  if(!url.startsWith("https://services.leadconnectorhq.com/contacts/?"))return guarded(input,init);
  fakeGhlCalls++;
  const q=new URL(url).searchParams;const after=q.get("startAfterId");const from=after?Number(after.slice(2))+1:0;
  const to=Math.min(from+100,PROD_SIZE);
  const contacts=Array.from({length:to-from},(_,k)=>{const i=from+k;return {id:`ghl-fx-${i}`,locationId:"fixture-location",firstName:`First${i}`,lastName:`Last${i}`,
    email:`ghl-stored-run-${i}@example.test`,phone:`+1305555${String(1000+i).slice(-4)}`,companyName:`Fixture Business ${i}`};});
  const meta:any={total:PROD_SIZE};
  if(to<PROD_SIZE){meta.startAfter=String(1_700_000_000_000+to);meta.startAfterId=`c-${to-1}`;}
  return new Response(JSON.stringify({contacts,meta}),{status:200,headers:{"Content-Type":"application/json"}});
}) as typeof fetch;
const checks:string[]=[];const failures:string[]=[];
const check=(ok:unknown,label:string)=>{if(ok)checks.push(label);else failures.push(label);};
const measurements:Record<string,unknown>={};
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
let b:Awaited<ReturnType<typeof privateStage3Browser>>|undefined;
const loop=monitorEventLoopDelay({resolution:10});
const ms=(ns:number)=>Math.round(ns/1e5)/10;
const percentile=(a:number[],p:number)=>a.length?[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))]:0;

async function seedRun(state:"ready"|"running",size:number){
  await h.pool.query(`DELETE FROM system_settings WHERE key LIKE $1`,[`${KEY}%`]);
  const pause=await h.pool.query(`SELECT epoch::text AS epoch,state FROM outbound_pause_control ORDER BY id LIMIT 1`);
  assert.equal(pause.rows[0]?.state,"paused","fixture outbound must be paused");
  const runId=crypto.randomUUID();const now=new Date().toISOString();
  const sources=Array.from({length:size},(_,i)=>({id:`ghl-seed-${i}`,firstName:`First${i}`,lastName:`Last${i}`,email:`ghl-seeded-${i}@example.test`,phone:`+1305555${String(1000+i).slice(-4)}`,companyName:`Fixture Business ${i}`}));
  const plans=sources.map(source=>({source,kind:"create",targetId:null,fill:{},}));
  const run={runId,state,createdAt:now,updatedAt:now,counts:{scanned:size,matched:0,wouldUpdate:0,wouldCreate:size,unchanged:0,conflicts:0,skipped:0,updated:0,created:0},
    previewHash:"a".repeat(64),nextAction:state==="running"?"apply":null,lastError:null,issues:[],mode:state==="running"?"apply":"preview",phase:"plan",sources,plans,
    scanCursor:null,seenCursors:[],pageCount:Math.ceil(size/100),planCursor:size,applyCursor:0,remoteTotal:size,pauseEpoch:pause.rows[0].epoch,isWebhook:false,actorId:h.userId("admin"),
    idempotencyKey:crypto.randomUUID(),leaseToken:null,leaseOwner:null,leaseExpiresAt:null};
  await h.pool.query(`INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb),($3,$4::jsonb),($5,'true'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,[`${KEY}_run_${runId}`,JSON.stringify(run),`${KEY}_active`,JSON.stringify(runId),`${KEY}_enabled`]);
  const size2=await h.pool.query(`SELECT pg_column_size(value) AS stored,length(value::text) AS json_chars FROM system_settings WHERE key=$1`,[`${KEY}_run_${runId}`]);
  return {runId,stored:Number(size2.rows[0].stored),jsonChars:Number(size2.rows[0].json_chars)};
}
async function clearRuns(){await h.pool.query(`DELETE FROM system_settings WHERE key LIKE $1`,[`${KEY}%`]);}

async function timed(path:string,role="admin"){const t=performance.now();const r=await h.request(role,"GET",path);return {status:r.status,ms:Math.round(performance.now()-t)};}

try{
  await mkdir(dir,{recursive:true});
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);
  const pauseRow=await h.pool.query(`SELECT state FROM outbound_pause_control ORDER BY id LIMIT 1`);
  if(!pauseRow.rows[0])await h.pool.query(`INSERT INTO outbound_pause_control(state,reason,actor) VALUES('paused','C5 GHL stored-run profile fixture','fixture')`);
  else if(pauseRow.rows[0].state!=="paused")await h.pool.query(`UPDATE outbound_pause_control SET state='paused'`);

  // ── Server-side: status read cost against persisted runs of increasing size (real handler, real table) ──
  const sizes:Record<string,unknown>={};
  for(const size of [PROD_SIZE,20_000]){
    const seeded=await seedRun("ready",size);
    const samples:number[]=[];loop.reset();loop.enable();
    for(let i=0;i<12;i++){samples.push((await timed("/api/admin/ghl/inbound-contact-sync")).ms);}
    loop.disable();
    const body=(await h.request("admin","GET","/api/admin/ghl/inbound-contact-sync")).body as any;
    sizes[String(size)]={...seeded,statusMs:{p50:percentile(samples,.5),max:Math.max(...samples)},eventLoopMs:{max:ms(loop.max),p99:ms(loop.percentile(99))},responseRunState:body.run?.state,responseBytes:JSON.stringify(body).length};
    check(body.run?.state==="ready","real status handler returns the seeded ready run ("+size+")");
  }
  measurements.statusReadBySize=sizes;

  // ── Browser helper ──
  const browser=async()=>{
    const x=await privateStage3Browser(h.base,h.sessions.get("admin")!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
    await x.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await x.call("Page.addScriptToEvaluateOnNewDocument",{source:`window.__lt=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(e.duration)}).observe({entryTypes:["longtask"]})}catch(e){}`});
    return x;
  };
  const count=(s:string)=>b!.evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`) as Promise<number>;
  const mount=async()=>{
    const t0=Date.now();
    await b!.navigate("/dashboard/ghl-integration?tab=settings");
    for(let i=0;i<120;i++){if(await count('[data-testid="card-ghl-inbound-sync"]')>0)return Date.now()-t0;await settle(250);}
    return null;
  };
  const cardText=()=>b!.evaluate(`document.querySelector('[data-testid="card-ghl-inbound-sync"]')?.innerText||''`) as Promise<string>;
  const runState=async()=>{const r=await h.request("admin","GET","/api/admin/ghl/inbound-contact-sync");return (r.body as any)?.run??null;};
  // Observe a window: frame gaps in the page, long tasks, server event-loop delay, and an unrelated fast endpoint probe.
  const observe=async(label:string,windowMs:number,profile=false)=>{
    const requestsBefore=b!.requests.length;
    if(profile){await b!.call("Profiler.enable");await b!.call("Profiler.setSamplingInterval",{interval:1000});await b!.call("Profiler.start");}
    await b!.evaluate(`window.__lt=[];window.__frames={n:0,worst:0,last:performance.now()};(function t(){const n=performance.now();window.__frames.worst=Math.max(window.__frames.worst,n-window.__frames.last);window.__frames.last=n;window.__frames.n++;if(!window.__stop)requestAnimationFrame(t);})();window.__stop=false;`);
    loop.reset();loop.enable();
    const probe:number[]=[];const t0=Date.now();
    while(Date.now()-t0<windowMs){const t=performance.now();const r=await h.originalFetch(`${h.base}/api/csrf-token`);await r.arrayBuffer();probe.push(Math.round(performance.now()-t));await settle(200);}
    loop.disable();
    const page=await b!.evaluate(`(()=>{window.__stop=true;const lt=window.__lt;return {frames:window.__frames.n,worstFrameGapMs:Math.round(window.__frames.worst),longTasks:lt.length,longTaskMaxMs:Math.round(Math.max(0,...lt)),longTaskTotalMs:Math.round(lt.reduce((a,x)=>a+x,0))};})()`) as any;
    let top:any[]=[];
    if(profile){
      const stopped:any=await b!.call("Profiler.stop");const prof=stopped.profile;
      const self=new Map<number,number>();const dt=prof.timeDeltas;for(let i=0;i<prof.samples.length;i++)self.set(prof.samples[i],(self.get(prof.samples[i])||0)+(dt[i]||0));
      const byFn=new Map<string,number>();
      for(const n of prof.nodes){const f=n.callFrame;const key=`${f.functionName||"(anonymous)"} ${String(f.url||"").split("/").slice(-1)[0]}:${f.lineNumber}`;byFn.set(key,(byFn.get(key)||0)+(self.get(n.id)||0));}
      const total=[...byFn.values()].reduce((a,x)=>a+x,0)||1;
      const idle=[...byFn.entries()].filter(([k])=>/^\((idle|program|garbage collector)\)/.test(k)).reduce((a,[,v])=>a+v,0);
      top=[...byFn.entries()].filter(([k])=>!/^\((idle|program)\)/.test(k)).sort((a,c)=>c[1]-a[1]).slice(0,8).map(([k,v])=>({fn:k,selfMs:Math.round(v/1000)}));
      await b!.call("Profiler.disable");
      measurements[`${label}Profile`]={sampledMs:Math.round(total/1000),idleMs:Math.round(idle/1000),busyMs:Math.round((total-idle)/1000),topSelf:top};
    }
    const reqs=b!.requests.slice(requestsBefore).filter(r=>r.url.startsWith("/api/"));
    const out={windowMs,...page,serverEventLoopMs:{max:ms(loop.max),p99:ms(loop.percentile(99)),mean:ms(loop.mean)},
      probeMs:{n:probe.length,p50:percentile(probe,.5),max:Math.max(...probe)},
      apiRequests:reqs.length,stepCalls:reqs.filter(r=>r.method==="POST"&&/\/step$/.test(r.url)).length,statusReads:reqs.filter(r=>r.method==="GET"&&/inbound-contact-sync$/.test(r.url)).length,
      pageExceptions:b!.exceptions.length};
    measurements[label]=out;return out;
  };
  const assertResponsive=(label:string,o:any,{loopMax=1000,probeMax=1500,frame=1500}={})=>{
    check(o.worstFrameGapMs<frame,`${label}: page main thread stays responsive (worst frame gap ${o.worstFrameGapMs}ms)`);
    check(o.serverEventLoopMs.max<loopMax,`${label}: server event loop never blocked ${loopMax}ms (max ${o.serverEventLoopMs.max}ms)`);
    check(o.probeMs.max<probeMax,`${label}: an unrelated fast endpoint answers within ${probeMax}ms while the page is open (max ${o.probeMs.max}ms)`);
    check(o.pageExceptions===0,`${label}: no uncaught page exceptions`);
  };

  // ── A. Persisted READY run at production size: mount Integration Hub -> GHL Settings ──
  await seedRun("ready",PROD_SIZE);
  b=await browser();
  const readyMs=await mount();
  check(readyMs!==null,`ready (${PROD_SIZE}): GHL Settings mounts the incoming-sync card (${readyMs}ms)`);
  measurements.readyMountMs=readyMs;
  const ready=await observe("ready",8000,true);
  const text=await cardText();
  check(/Preview ready/.test(text)&&/3,994/.test(text.replace(/\s/g," ")),`ready: the card shows the persisted preview and its 3,994 counts`);
  assertResponsive("ready",ready);
  await b.close();b=undefined;

  // ── B. Real PREVIEW from the card: scan 3,994 contacts (fake GHL), plan, reach ready ──
  await clearRuns();
  b=await browser();
  check(await mount()!==null,"preview: card mounts with no stored run");
  const previewT0=Date.now();
  await b.click('[data-testid="button-ghl-inbound-preview"]');
  const preview=await observe("previewing",25000,true);
  let state:any=await runState();
  for(let i=0;i<240&&state&&state.state==="previewing";i++){await settle(500);state=await runState();}
  measurements.previewToReadyMs=Date.now()-previewT0;
  measurements.previewFinal={state:state?.state,counts:state?.counts,lastError:state?.lastError};
  check(state?.state==="ready",`preview: real preview reaches ready (state ${state?.state}, ${measurements.previewToReadyMs}ms, error ${state?.lastError})`);
  check(state?.counts?.scanned===PROD_SIZE,`preview: scanned ${state?.counts?.scanned} of ${PROD_SIZE}`);
  check(fakeGhlCalls>=Math.ceil(PROD_SIZE/100),`preview: fake GHL served ${fakeGhlCalls} pages`);
  assertResponsive("previewing",preview);

  // ── C. Real APPLY from the card (disposable DB; outbound paused; nothing sent) ──
  await b.call("Page.reload");
  for(let i=0;i<80&&await count('[data-testid="button-ghl-inbound-execute"]')===0;i++)await settle(250);
  check(await count('[data-testid="button-ghl-inbound-execute"]')>0,"apply: execute button is offered for the ready preview");
  const stepsBefore=Number((await h.pool.query(`SELECT (value->>'applyCursor')::int AS c FROM system_settings WHERE key=$1`,[`${KEY}_run_${state?.runId}`])).rows[0]?.c??0);
  await b.click('[data-testid="button-ghl-inbound-execute"]');
  const apply=await observe("running",45000,true);
  const after=await runState();
  const cursor=Number((await h.pool.query(`SELECT (value->>'applyCursor')::int AS c FROM system_settings WHERE key=$1`,[`${KEY}_run_${state?.runId}`])).rows[0]?.c??0);
  measurements.applyProgress={cursorBefore:stepsBefore,cursorAfter:cursor,state:after?.state,counts:after?.counts,lastError:after?.lastError,
    contactsPerSecond:Math.round((cursor-stepsBefore)/45*10)/10,projectedFullApplySeconds:cursor>stepsBefore?Math.round(PROD_SIZE/((cursor-stepsBefore)/45)):null};
  check(cursor>stepsBefore,`apply: real apply advanced (${stepsBefore} -> ${cursor} of ${PROD_SIZE})`);
  assertResponsive("running",apply);
  await b.close();b=undefined;
  check(h.externalCalls()===0,"no external provider egress");
}catch(error){failures.push(`suite error: ${(error as Error).message}`);}
finally{
  if(b)await b.close().catch(()=>{});
  const status=failures.length?"failed":"passed";
  await writeFile(`${dir}/ghl-stored-run-receipt.json`,JSON.stringify({status,identity:{sourceHead:(identity as any)?.sourceHead??null},fixture:h.prefix,checks,failures,measurements,
    scope:"candidate build, disposable migrated DB, real incoming-sync handlers and service, persisted production-sized runs, GHL pages from an in-process fake; loopback timings, not production or network measurements"},null,2));
  await h.close();
  if(failures.length){console.error(`GHL stored-run profile: FAIL\n - ${failures.join("\n - ")}`);process.exitCode=1;}
  else console.log(`GHL stored-run profile: PASS (${checks.length} checks)`);
}
