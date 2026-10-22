import assert from "node:assert/strict";
import {mkdir,writeFile,access} from "node:fs/promises";
import path from "node:path";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";

// C5 matched performance (manual certification, not a mandatory suite): the SAME disposable API, database, machine and
// session serve two production client builds — the pre-C5 build (git 1422503b, built into generated-artifacts/c5-baseline-client)
// and the candidate in dist/public. Only client assets vary. Cold navigations with the HTTP cache disabled.
const baselineRoot=path.resolve("generated-artifacts/c5-baseline-client");
await access(path.join(baselineRoot,"index.html")).catch(()=>{throw new Error("Build the pre-C5 client into generated-artifacts/c5-baseline-client first (git worktree at 1422503b, npx vite build, copy dist/public)");});
const identity=await verifyCandidateIdentity();
const {createHash}=await import("node:crypto");const {readFile}=await import("node:fs/promises");
const baselineIndexSha=createHash("sha256").update(await readFile(path.join(baselineRoot,"index.html"))).digest("hex");
const dir="docs/certification/stage3-c5/browser";
let clientRoot=path.resolve("dist/public");
const h=await stage3BHttpFixture(async app=>{
  for(const [file,fn] of [["knowledge-admin","registerKnowledgeAdminRoutes"],["documents","registerDocumentsRoutes"],["permissions-audit","registerPermissionsAuditRoutes"]]){
    const module=await import(`../server/routes/${file}.ts`);module[fn](app);
  }
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C5 fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
const pages:Array<[string,string]>=[["/dashboard",'[data-testid="text-page-title"]'],["/dashboard/admin-hub?tab=users",'[role=tab]'],["/dashboard/knowledge-base",'[data-testid="page-knowledge-base"]'],["/dashboard/permissions",'[data-testid="page-permissions"]']];
const N=7;
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
const results:Record<string,Record<string,{medianMs:number;samples:number[];shellMedianMs:number;shellSamples:number[];jsBytes:number}>>={baseline:{},candidate:{}};
try{
  await mkdir(dir,{recursive:true});
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);
  const b=await privateStage3Browser(h.base,h.sessions.get("admin")!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await b.call("Network.setCacheDisabled",{cacheDisabled:true});
  // Readiness contract, asserted for EVERY sample (a timeout is a failure, never a sample):
  //   shell ready = the page's own landmark element exists;
  //   data ready  = shell ready AND no loading indicator (aria-busy, skeleton pulse, spinner, progressbar, "Loading" status)
  //                 remains for two consecutive polls. A legitimate empty or unavailable state with no loading indicator
  //                 counts as data-ready: the contract is "the page stopped loading", not "rows exist".
  // Both builds are held to the same predicate; the timed value used for the bound is data-ready.
  const loadingProbe=`(()=>{const q=s=>document.querySelector(s);return !!(q('[aria-busy="true"]')||q('.animate-pulse')||q('[role=progressbar]')||q('.animate-spin')||[...document.querySelectorAll('[role=status]')].some(e=>/^\\s*(loading|working|checking)/i.test(e.textContent||'')))})()`;
  const READY_TIMEOUT_MS=15000;
  const visit=async(url:string,sel:string)=>{
    const t0=Date.now();await b.navigate(url);
    let shellMs=-1,dataMs=-1,quiet=0;
    while(Date.now()-t0<READY_TIMEOUT_MS){
      if(shellMs<0&&await b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`))shellMs=Date.now()-t0;
      if(shellMs>=0){
        const loading=await b.evaluate(loadingProbe);
        quiet=loading?0:quiet+1;
        if(quiet>=2){dataMs=Date.now()-t0;break;}
      }
      await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(shellMs>=0,`${url}: shell element ${sel} not ready within ${READY_TIMEOUT_MS}ms (a timeout is not a sample)`);
    assert.ok(dataMs>=0,`${url}: still loading ${READY_TIMEOUT_MS}ms after the shell was ready (a timeout is not a sample)`);
    const jsBytes=await b.evaluate(`performance.getEntriesByType('resource').filter(e=>e.name.endsWith('.js')).reduce((n,e)=>n+(e.transferSize||e.encodedBodySize||0),0)`) as number;
    return {ms:dataMs,shellMs,jsBytes};
  };
  for(const [url,sel] of pages){
    const samples:Record<string,number[]>={baseline:[],candidate:[]};const shell:Record<string,number[]>={baseline:[],candidate:[]};const bytes:Record<string,number>={baseline:0,candidate:0};
    await visit(url,sel); // warm the server once
    for(let i=0;i<N;i++)for(const which of ["baseline","candidate"] as const){
      clientRoot=which==="baseline"?baselineRoot:path.resolve("dist/public");
      const r=await visit(url,sel);samples[which].push(r.ms);shell[which].push(r.shellMs);bytes[which]=r.jsBytes;
    }
    for(const which of ["baseline","candidate"] as const)results[which][url]={medianMs:median(samples[which]),samples:samples[which],shellMedianMs:median(shell[which]),shellSamples:shell[which],jsBytes:bytes[which]};
  }
  await b.close();
  const verdict=pages.map(([url])=>{const a=results.baseline[url].medianMs,c=results.candidate[url].medianMs;
    return {url,baselineMedianMs:a,candidateMedianMs:c,deltaMs:c-a,withinBound:c<=a*1.25+150};});
  for(const v of verdict)assert.ok(v.withinBound,`${v.url}: candidate median ${v.candidateMedianMs}ms exceeds baseline ${v.baselineMedianMs}ms by more than 25% + 150ms`);
  await writeFile(`${dir}/performance-receipt.json`,JSON.stringify({status:"passed",runs:N,machine:"disposable local fixture",baseline:"1422503b pre-C5 client",verdict,results,
    readiness:"every sample asserted shell-ready then data-ready (no loading indicator for two consecutive polls); timeouts fail the run; timed value is data-ready, shell-ready recorded separately; empty/unavailable states without a loading indicator count as ready",
    candidateIdentity:identity,baselineInput:{commit:"1422503b",root:"generated-artifacts/c5-baseline-client",indexSha256:baselineIndexSha},
    scope:"cold navigation to data-ready, cache disabled, same API/DB/machine; client assets only vary; not a production or network measurement"},null,2));
  console.log(JSON.stringify(verdict));console.log("Stage 3 C5 performance: PASS");
} finally { await h.close(); }
