import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";

// C3 real-browser Sequence create/edit with durable readback, plus a seven-role entrance matrix and a
// role change during a live session. Real session cookies, real pointer/keyboard input, compiled client,
// disposable database. Nothing here enrolls, activates, sends or calls a provider.
const identity=await verifyCandidateIdentity();
const dir="docs/certification/stage3-c3/browser-sequences";
const clientRoot=path.resolve("dist/public");
const h=await stage3BHttpFixture(async app=>{
  const module=await import("../server/routes/campaigns.ts");module.registerCampaignsRoutes(app);
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C3 fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
const checks:string[]=[];
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);};
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
const open=(role:string)=>privateStage3Browser(h.base,h.sessions.get(role)!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
type B=Awaited<ReturnType<typeof privateStage3Browser>>;
const until=async(fn:()=>Promise<boolean>,label:string,tries=80)=>{for(let i=0;i<tries;i++){if(await fn())return;await settle(250);}throw new Error(`Timed out: ${label}`);};
let b:B|undefined;
const route="/dashboard/outbound-center?tab=sequences";
const seqName=`c3seq-${randomUUID().slice(0,8)}`;
try{
  await mkdir(dir,{recursive:true});
  // The first-login staff tour is a separate feature (covered by the C4 suite); mark it done for the fixture users
  // so its modal does not sit on top of the controls under test.
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);
  const count=(s:string)=>b!.evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`) as Promise<number>;

  // ── A. Manager creates a sequence through the real form ──
  b=await open("manager");
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await b.navigate(route);
  await until(async()=>await count('[data-testid="button-create-sequence"]')>0,"create button");
  await b.click('[data-testid="button-create-sequence"]');
  await until(async()=>await count('[data-testid="input-seq-name"]')>0,"create dialog");
  check((await b.evaluate(`document.querySelector('[data-testid="button-save-sequence"]').disabled`))===true,"Create Sequence is disabled with no name and no step");
  await b.set('[data-testid="input-seq-name"]',seqName);
  await b.click('[data-testid="button-add-step"]');
  await until(async()=>await count('[data-testid="input-step-subject-0"]')>0,"step editor");
  await b.set('[data-testid="input-step-subject-0"]',"Hello from C3");
  await b.set('[data-testid="input-step-body-0"]',"Body for the first step");
  const before=await h.pool.query(`SELECT count(*)::int n FROM follow_up_sequences WHERE name=$1`,[seqName]);
  check(before.rows[0].n===0,"nothing is saved before the user presses Create Sequence");
  await b.click('[data-testid="button-save-sequence"]');
  await until(async()=>(await h.pool.query(`SELECT 1 FROM follow_up_sequences WHERE name=$1`,[seqName])).rowCount===1,"created row");
  const created=(await h.pool.query(`SELECT id,status,total_steps FROM follow_up_sequences WHERE name=$1`,[seqName])).rows[0];
  check(created.status==="paused","created sequence is paused (server-owned status)");
  const steps=(await h.pool.query(`SELECT id,step_order,subject,body,action_type FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order`,[created.id])).rows;
  check(steps.length===1&&steps[0].subject==="Hello from C3"&&steps[0].body==="Body for the first step","exactly one step with the typed subject and body is stored");
  check(Number(created.total_steps)===1,"server owns total_steps and it matches the stored steps");
  const createPosts=b.requests.filter(r=>r.method==="POST"&&/\/api\/sequences(\/\d+\/steps)?$/.test(r.url));
  check(createPosts.every(r=>r.status&&r.status<300),"create and step requests were accepted by the strict server schemas (no 400)");
  await b.navigate(route);
  await until(async()=>await count(`[data-testid="card-sequence-${created.id}"]`)>0,"sequence listed after refresh");
  check((await b.evaluate(`document.querySelector('[data-testid="badge-seq-status-${created.id}"]').textContent`) as string).toLowerCase().includes("paused"),"after refresh the list shows the sequence as paused");

  // ── B. Edit: advanced step config survives, step ID is preserved ──
  await h.pool.query(`UPDATE sequence_steps SET config=$2::jsonb WHERE id=$1`,[steps[0].id,JSON.stringify({c3Marker:"keep-me"})]);
  await b.navigate(route);
  await until(async()=>await count(`[data-testid="button-edit-${created.id}"]`)>0,"edit button");
  await b.click(`[data-testid="button-edit-${created.id}"]`);
  await until(async()=>(await b!.evaluate(`document.querySelector('[data-testid="input-step-subject-0"]')?.value||""`))==="Hello from C3","edit hydrates the stored step");
  await b.set('[data-testid="input-step-subject-0"]',"Edited by C3");
  await b.click('[data-testid="button-save-sequence"]');
  await until(async()=>(await h.pool.query(`SELECT 1 FROM sequence_steps WHERE sequence_id=$1 AND subject='Edited by C3'`,[created.id])).rowCount===1,"edited subject stored");
  const after=(await h.pool.query(`SELECT id,config FROM sequence_steps WHERE sequence_id=$1`,[created.id])).rows;
  check(after.length===1&&after[0].id===steps[0].id,"edit keeps the persisted step ID (no delete and recreate)");
  check(after[0].config?.c3Marker==="keep-me","edit round-trips advanced step config instead of clearing it");
  const stillPaused=(await h.pool.query(`SELECT status FROM follow_up_sequences WHERE id=$1`,[created.id])).rows[0].status;
  check(stillPaused==="paused","editing never activates the sequence");

  // ── C. Failed step hydration blocks Save (injected read fault) ──
  await b.navigate(route);
  await until(async()=>await count(`[data-testid="button-edit-${created.id}"]`)>0,"edit button again");
  b.failRead(`/api/sequences/${created.id}/steps`,{exact:true});
  await b.click(`[data-testid="button-edit-${created.id}"]`);
  await until(async()=>await count('[data-testid="sequence-hydration-error"]')>0,"hydration error shown");
  check(await count('[data-testid="button-save-sequence"]')===0,"Save is not offered while step hydration failed");
  b.failRead(null);
  const stepsAfterFault=(await h.pool.query(`SELECT count(*)::int n FROM sequence_steps WHERE sequence_id=$1`,[created.id])).rows[0].n;
  check(stepsAfterFault===1,"a failed hydration did not touch the stored steps");
  check(b.exceptions.length===0,"no uncaught browser exceptions (manager)");
  await b.close();b=undefined;

  // ── D. Seven-role entrance matrix on the same page ──
  const matrix:Record<string,{path:string;createButton:boolean;sequenceListStatuses:number[]}>={};
  for(const role of ["admin","manager","agent","other","merchant","affiliate","partner"]) {
    const rb=await open(role);
    try{
      await rb.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      await rb.navigate(route);
      await settle(2500);
      const hasButton=await rb.evaluate(`document.querySelectorAll('[data-testid="button-create-sequence"]').length>0`) as boolean;
      const statuses=rb.requests.filter(r=>r.url.startsWith("/api/sequences")&&r.method==="GET").map(r=>r.status??0);
      matrix[role]={path:await rb.evaluate("location.pathname+location.search") as string,createButton:hasButton,sequenceListStatuses:statuses};
      if(role==="admin"||role==="manager") check(hasButton,`${role} sees the Create Sequence control`);
      else {
        check(!hasButton,`${role} is not offered Create Sequence`);
        check(statuses.every(s=>s===401||s===403||s===0),`${role} sequence reads are refused by the server (${statuses.join(",")||"no request"})`);
      }
    } finally { await rb.close(); }
  }

  // ── E. Role change during a live session: manager session demoted in the database ──
  const mb=await open("manager");
  try{
    await mb.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await mb.navigate(route);
    await until(async()=>(await mb.evaluate(`document.querySelectorAll('[data-testid="button-create-sequence"]').length`) as number)>0,"manager sees control before demotion");
    await h.pool.query(`UPDATE users SET role='agent' WHERE id=$1`,[`${h.prefix}-manager`]);
    mb.requests.length=0;
    await mb.navigate(route);
    await settle(2500);
    const statuses=mb.requests.filter(r=>r.url.startsWith("/api/sequences")&&r.method==="GET").map(r=>r.status??0);
    const still=await mb.evaluate(`document.querySelectorAll('[data-testid="button-create-sequence"]').length>0`) as boolean;
    check(!still,"after the role is demoted the same session no longer gets Create Sequence");
    check(statuses.every(s=>s===401||s===403||s===0),`after demotion the same session's sequence reads are refused (${statuses.join(",")||"no request"})`);
    const csrf=h.sessions.get("manager")!;
    const forced=await h.originalFetch(`${h.base}/api/sequences`,{method:"POST",headers:{"Content-Type":"application/json",Cookie:csrf.cookie,"X-CSRF-Token":csrf.token},body:JSON.stringify({name:`${seqName}-demoted`})});
    check(forced.status===403,"a direct POST from the demoted session is refused with 403");
    check((await h.pool.query(`SELECT 1 FROM follow_up_sequences WHERE name=$1`,[`${seqName}-demoted`])).rowCount===0,"no sequence was created by the demoted session");
  } finally { await h.pool.query(`UPDATE users SET role='manager' WHERE id=$1`,[`${h.prefix}-manager`]); await mb.close(); }

  check(h.externalCalls()===0,"no external provider egress");
  await writeFile(`${dir}/receipt.json`,JSON.stringify({status:"passed",identity,fixture:h.prefix,checks,matrix,
    qualification:"Real-browser Sequence create/edit with DB readback, hydration-failure block, seven-role entrance matrix and a mid-session demotion, on a disposable database with only the campaigns routes registered. Not campaign/signature controls, not published-candidate or production acceptance."},null,2));
  console.log(`STAGE3_C3_BROWSER_SEQUENCES_PASS (${checks.length} checks)`);
}catch(error){
  await b?.screenshot("failure");
  await writeFile(`${dir}/failed-receipt.json`,JSON.stringify({status:"failed",identity,error:String(error),checks},null,2));
  throw error;
}finally{await b?.close();await h.close();}
