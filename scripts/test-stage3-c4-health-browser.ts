import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";
import {runC4HealthReadCase} from "./fixtures/stage3-c4-health-read-case";

const identity=await verifyCandidateIdentity();
const dir="docs/certification/stage3-c4/health-browser";
const h=await stage3BHttpFixture(async app=>{
  const {registerChurnRoutes}=await import("../server/routes/churn");
  registerChurnRoutes(app);
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in isolated Health read fixture"}));
  const {static:serveStatic}=await import("express");
  app.use(serveStatic("dist/public"));
  app.use((_req,res)=>res.sendFile("index.html",{root:`${process.cwd()}/dist/public`}));
},undefined,{backgroundProfile:"off"});
let b:Awaited<ReturnType<typeof privateStage3Browser>>|undefined;
try{
  await mkdir(dir,{recursive:true});
  console.log(`Owned C4 Health fixture: ${h.base}; actual private session, no auth bypass`);
  b=await privateStage3Browser(h.base,h.sessions.get("admin")!.cookie,h.originalFetch,dir,
    {realInput:true,startupTimeoutMs:30000});
  await b.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
  await b.navigate("/mobile");await b.waitFor(/Switch to desktop view/);
  // Existing read failure changes the footer's geometry during hydration.
  // Settle that source before measuring a native pointer, as in the full lane.
  await b.waitFor(/Native appointments are unavailable/);
  await b.evaluate("document.fonts.ready.then(()=>true)");
  await b.click('[data-testid="button-switch-to-desktop"]');
  for(let n=0;n<50&&!await b.evaluate('localStorage.getItem("prefer_desktop")==="true"');n++)
    await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await b.evaluate('localStorage.getItem("prefer_desktop")'),"true");
  for(let n=0;n<50&&!await b.evaluate('location.pathname.startsWith("/dashboard")&&!!document.querySelector("main")');n++)
    await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await b.evaluate('location.pathname.startsWith("/dashboard")'),true);
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const result=await runC4HealthReadCase(h,b);
  assert.equal(b.exceptions.length,0);assert.equal(h.externalCalls(),0);
  await writeFile(`${dir}/receipt.json`,JSON.stringify({status:"passed",identity,fixture:h.prefix,
    result,requests:b.requests,readFaults:b.readFaults,exceptions:b.exceptions,externalEgress:0,
    qualification:"Focused admin Health only; other sources explicitly unsupported (501). Not full C4 browser, bundled-server, production/native or release acceptance."},null,2));
  console.log("C4 focused Health compiled read browser PASS; not full C4 acceptance");
}catch(error){
  await b?.screenshot("failure");
  await writeFile(`${dir}/failed-receipt.json`,JSON.stringify({status:"failed",identity,
    error:String(error),requests:b?.requests,exceptions:b?.exceptions,externalEgress:h.externalCalls()},null,2));
  throw error;
}finally{await b?.close();await h.close();}
