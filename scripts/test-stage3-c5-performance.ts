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
const results:Record<string,Record<string,{medianMs:number;samples:number[];jsBytes:number}>>={baseline:{},candidate:{}};
try{
  await mkdir(dir,{recursive:true});
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);
  const b=await privateStage3Browser(h.base,h.sessions.get("admin")!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await b.call("Network.setCacheDisabled",{cacheDisabled:true});
  const visit=async(url:string,sel:string)=>{
    const t0=Date.now();await b.navigate(url);
    for(let i=0;i<200;i++){if(await b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`))break;await new Promise(r=>setTimeout(r,25));}
    const ms=Date.now()-t0;
    const jsBytes=await b.evaluate(`performance.getEntriesByType('resource').filter(e=>e.name.endsWith('.js')).reduce((n,e)=>n+(e.transferSize||e.encodedBodySize||0),0)`) as number;
    return {ms,jsBytes};
  };
  for(const [url,sel] of pages){
    const samples:Record<string,number[]>={baseline:[],candidate:[]};const bytes:Record<string,number>={baseline:0,candidate:0};
    await visit(url,sel); // warm the server once
    for(let i=0;i<N;i++)for(const which of ["baseline","candidate"] as const){
      clientRoot=which==="baseline"?baselineRoot:path.resolve("dist/public");
      const r=await visit(url,sel);samples[which].push(r.ms);bytes[which]=r.jsBytes;
    }
    for(const which of ["baseline","candidate"] as const)results[which][url]={medianMs:median(samples[which]),samples:samples[which],jsBytes:bytes[which]};
  }
  await b.close();
  const verdict=pages.map(([url])=>{const a=results.baseline[url].medianMs,c=results.candidate[url].medianMs;
    return {url,baselineMedianMs:a,candidateMedianMs:c,deltaMs:c-a,withinBound:c<=a*1.25+150};});
  for(const v of verdict)assert.ok(v.withinBound,`${v.url}: candidate median ${v.candidateMedianMs}ms exceeds baseline ${v.baselineMedianMs}ms by more than 25% + 150ms`);
  await writeFile(`${dir}/performance-receipt.json`,JSON.stringify({status:"passed",runs:N,machine:"disposable local fixture",baseline:"1422503b pre-C5 client",verdict,results,
    scope:"cold navigation to first ready element, cache disabled, same API/DB/machine; client assets only vary; not a production or network measurement"},null,2));
  console.log(JSON.stringify(verdict));console.log("Stage 3 C5 performance: PASS");
} finally { await h.close(); }
