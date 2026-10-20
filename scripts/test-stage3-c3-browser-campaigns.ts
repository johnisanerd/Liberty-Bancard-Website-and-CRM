import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";

// C3 real-browser Campaign create (draft only) and Signature edit/permission/failure recovery with durable readback.
// Real session, real pointer/keyboard input, compiled client, disposable database. No activation, enrollment or send.
const identity=await verifyCandidateIdentity();
const dir="docs/certification/stage3-c3/browser-campaigns";
const clientRoot=path.resolve("dist/public");
const h=await stage3BHttpFixture(async app=>{
  for(const [file,fn] of [["campaigns","registerCampaignsRoutes"],["templates-settings","registerTemplatesSettingsRoutes"],["imports","registerImportsRoutes"]]) {
    const module=await import(`../server/routes/${file}.ts`);module[fn](app);
  }
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated C3 fixture"}));
  const {static:serveStatic}=await import("express");
  app.use((req,res,next)=>serveStatic(clientRoot)(req,res,next));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
},undefined,{backgroundProfile:"off"});
const checks:string[]=[];
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);};
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn:()=>Promise<boolean>,label:string,tries=80)=>{for(let i=0;i<tries;i++){if(await fn())return;await settle(250);}throw new Error(`Timed out: ${label}`);};
let b:Awaited<ReturnType<typeof privateStage3Browser>>|undefined;
const campaignName=`c3camp-${randomUUID().slice(0,8)}`;
try{
  await mkdir(dir,{recursive:true});
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`,[`${h.prefix}-%`]);
  b=await privateStage3Browser(h.base,h.sessions.get("manager")!.cookie,h.originalFetch,dir,{realInput:true,startupTimeoutMs:30000});
  await b.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const count=(s:string)=>b!.evaluate(`document.querySelectorAll(${JSON.stringify(s)}).length`) as Promise<number>;
  const sendBefore=(await h.pool.query(`SELECT count(*)::int n FROM campaigns`)).rows[0].n;

  // ── A. Create a draft campaign with a current-taxonomy vertical ──
  await b.navigate("/dashboard/outbound-center?tab=campaigns");
  await until(async()=>await count('[data-testid="button-create-campaign"]')>0,"create campaign button");
  await b.click('[data-testid="button-create-campaign"]');
  await until(async()=>await count('[data-testid="input-campaign-name"]')>0,"campaign dialog");
  await b.set('[data-testid="input-campaign-name"]',campaignName);
  await b.click('[data-testid="button-source-crm"]');
  await until(async()=>await count('[data-testid^="checkbox-vertical-"]')>0,"vertical choices");
  const verticalCount=await count('[data-testid^="checkbox-vertical-"]');
  check(verticalCount===5,`the audience offers the five current-taxonomy verticals (${verticalCount})`);
  const verticalLabel=await b.evaluate(`document.querySelector('[data-testid^="checkbox-vertical-"]').closest('[class*="flex"]').querySelector('label').textContent`) as string;
  const verticalId=await b.evaluate(`document.querySelector('[data-testid^="checkbox-vertical-"]').getAttribute('data-testid')`) as string;
  await b.click(`[data-testid="${verticalId}"]`);
  check(!/Restaurant|Retail/.test(await b.evaluate("document.querySelector('[role=dialog]').innerText") as string),"the audience does not offer the retired Restaurant/Retail labels");
  check((await h.pool.query(`SELECT count(*)::int n FROM campaigns WHERE name=$1`,[campaignName])).rows[0].n===0,"nothing is saved before Create Campaign");
  await b.click('[data-testid="button-submit-campaign"]');
  await until(async()=>(await h.pool.query(`SELECT 1 FROM campaigns WHERE name=$1`,[campaignName])).rowCount===1,"campaign row");
  const camp=(await h.pool.query(`SELECT id,status,target_verticals,daily_send_limit FROM campaigns WHERE name=$1`,[campaignName])).rows[0];
  check(camp.status==="draft","the created campaign is a draft (never active)");
  check(Array.isArray(camp.target_verticals)&&camp.target_verticals.includes(verticalLabel.trim()),`the stored audience keeps the chosen vertical (${verticalLabel.trim()})`);
  check((await h.pool.query(`SELECT count(*)::int n FROM campaigns`)).rows[0].n===sendBefore+1,"exactly one campaign was created");
  const post=b.requests.filter(r=>r.method==="POST"&&r.url==="/api/campaigns");
  check(post.length===1&&post[0].status===201,"one POST /api/campaigns accepted with 201");
  await b.navigate("/dashboard/outbound-center?tab=campaigns");
  await until(async()=>(await b!.evaluate("document.body.innerText") as string).includes(campaignName),"campaign listed after refresh");
  check(true,"the created campaign is still listed after a full reload");

  // ── A2. Campaign step edit on the draft: cancel, failed save, state conflict, then a durable save ──
  const stepRow=(await h.pool.query(`INSERT INTO campaign_steps(campaign_id,step_order,step_type,subject,body_template,delay_days,channel)
    VALUES($1,1,'email','Original subject','Original body',2,'email') RETURNING id`,[camp.id])).rows[0];
  const stepState=async()=>(await h.pool.query(`SELECT subject,body_template,delay_days FROM campaign_steps WHERE id=$1`,[stepRow.id])).rows[0];
  const campaignState=async()=>(await h.pool.query(`SELECT status FROM campaigns WHERE id=$1`,[camp.id])).rows[0].status;
  await b.navigate("/dashboard/outbound-center?tab=campaigns");
  await until(async()=>await count(`[data-testid="button-expand-campaign-${camp.id}"]`)>0,"expand campaign");
  await b.click(`[data-testid="button-expand-campaign-${camp.id}"]`);
  await until(async()=>await count(`[data-testid="button-edit-step-${stepRow.id}"]`)>0,"step edit control");
  await b.click(`[data-testid="button-edit-step-${stepRow.id}"]`);
  await until(async()=>await count(`[data-testid="input-edit-subject-${stepRow.id}"]`)>0,"step edit form");
  await b.set(`[data-testid="input-edit-subject-${stepRow.id}"]`,"Changed but cancelled");
  await b.click(`[data-testid="button-cancel-edit-step-${stepRow.id}"]`);
  check(await count(`[data-testid="input-edit-subject-${stepRow.id}"]`)===0,"Cancel closes the step editor");
  check((await stepState()).subject==="Original subject","Cancel stored nothing");
  const putsBefore=b.requests.filter(r=>r.method==="PUT"&&r.url.startsWith("/api/campaign-steps/")).length;
  check(putsBefore===0,"Cancel sent no request (no-op)");
  await b.click(`[data-testid="button-edit-step-${stepRow.id}"]`);
  await until(async()=>await count(`[data-testid="input-edit-subject-${stepRow.id}"]`)>0,"step edit form (failed save)");
  await b.set(`[data-testid="input-edit-subject-${stepRow.id}"]`,"Saved by C3");
  b.failRead(`/api/campaign-steps/${stepRow.id}`,{exact:true});
  await b.click(`[data-testid="button-save-edit-step-${stepRow.id}"]`);
  await until(async()=>(await b!.evaluate("document.body.innerText") as string).includes("Failed to update step"),"failed-save message");
  b.failRead(null);
  check(await count(`[data-testid="input-edit-subject-${stepRow.id}"]`)===1,"a failed save leaves the editor open with the edit");
  check((await stepState()).subject==="Original subject","a failed save stored nothing");
  // State conflict: the campaign leaves draft before the retry; the server refuses and nothing changes.
  await h.pool.query(`UPDATE campaigns SET status='paused' WHERE id=$1`,[camp.id]);
  await b.click(`[data-testid="button-save-edit-step-${stepRow.id}"]`);
  await until(async()=>b!.requests.some(r=>r.method==="PUT"&&r.url===`/api/campaign-steps/${stepRow.id}`&&r.status===409),"409 for a non-draft campaign");
  check((await stepState()).subject==="Original subject","a refused save (campaign no longer draft) stored nothing");
  await h.pool.query(`UPDATE campaigns SET status='draft' WHERE id=$1`,[camp.id]);
  await b.click(`[data-testid="button-save-edit-step-${stepRow.id}"]`);
  await until(async()=>(await stepState()).subject==="Saved by C3","retried save stored");
  check((await campaignState())==="draft","editing a step never activates or launches the campaign");
  await b.navigate("/dashboard/outbound-center?tab=campaigns");
  await until(async()=>await count(`[data-testid="button-expand-campaign-${camp.id}"]`)>0,"expand after reload");
  await b.click(`[data-testid="button-expand-campaign-${camp.id}"]`);
  await until(async()=>(await b!.evaluate("document.body.innerText") as string).includes("Saved by C3"),"saved step shown after reload");
  check(true,"the saved step is shown after a full reload");

  // ── B. Signatures: read failure is explicit, edit saves with readback, failed save keeps the dialog ──
  b.failRead("/api/email-signatures",{exact:true});
  await b.navigate("/dashboard/outbound-center?tab=command");
  await until(async()=>await count('[data-testid="tab-signatures"]')>0,"signatures tab");
  await b.click('[data-testid="tab-signatures"]');
  await until(async()=>await count('[data-testid="signatures-unavailable"]')>0,"signature read failure shown");
  check(await count('[data-testid^="sig-preview-"]')===0,"a failed signature read shows no previews and is not an empty list");
  b.failRead(null);
  await b.click('[data-testid="button-retry-signatures"]');
  await until(async()=>await count('[data-testid="sig-preview-sales"]')>0,"previews after Retry");
  check(await count('[data-testid="signatures-unavailable"]')===0,"Retry clears the unavailable state and shows the three presentations");
  check(await count('[data-testid^="sig-preview-"]')===3,"three signature presentations render");
  await b.click('[data-testid="button-edit-sig-sales"]');
  await until(async()=>await count('[data-testid="input-sig-phone"]')>0,"signature dialog");
  const phone="555-0199";
  await b.set('[data-testid="input-sig-phone"]',phone);
  b.failRead("/api/email-signatures/sales",{exact:true});
  await b.click('[data-testid="button-save-signature"]');
  await settle(1500);
  check(await count('[data-testid="dialog-edit-signature"]')===1,"a failed save leaves the dialog open with the edit");
  check((await h.pool.query(`SELECT 1 FROM system_settings WHERE key='email_signature_sales' AND value::text LIKE $1`,[`%${phone}%`])).rowCount===0,"a failed save stored nothing");
  b.failRead(null);
  await b.click('[data-testid="button-save-signature"]');
  await until(async()=>(await h.pool.query(`SELECT 1 FROM system_settings WHERE key='email_signature_sales' AND value::text LIKE $1`,[`%${phone}%`])).rowCount===1,"signature stored");
  check(true,"a retried save is stored durably");
  await b.navigate("/dashboard/outbound-center?tab=command");
  await until(async()=>await count('[data-testid="tab-signatures"]')>0,"signatures tab after reload");
  await b.click('[data-testid="tab-signatures"]');
  await until(async()=>(await b!.evaluate(`document.querySelector('[data-testid="sig-preview-sales"]')?.innerText||""`) as string).includes(phone),"preview shows the saved phone");
  check(true,"after a reload the sales preview shows the saved signature");
  const agentPut=await h.request("agent","PUT","/api/email-signatures/sales",{name:"x",title:"x",phone:"000",email:"x@example.test"});
  check(agentPut.status===403,"an agent cannot edit a signature (403)");
  check((await h.pool.query(`SELECT 1 FROM system_settings WHERE key='email_signature_sales' AND value::text LIKE '%000%'`)).rowCount===0,"the refused edit stored nothing");
  check(b.exceptions.length===0,"no uncaught browser exceptions");
  check(h.externalCalls()===0,"no external provider egress");
  await writeFile(`${dir}/receipt.json`,JSON.stringify({status:"passed",identity,fixture:h.prefix,checks,
    qualification:"Real-browser draft campaign create and signature edit/failure recovery with DB readback, manager session, disposable database. Not activation, enrollment, queueing or send (none exercised); not published-candidate or production acceptance."},null,2));
  console.log(`STAGE3_C3_BROWSER_CAMPAIGNS_PASS (${checks.length} checks)`);
}catch(error){
  await b?.screenshot("failure");
  await writeFile(`${dir}/failed-receipt.json`,JSON.stringify({status:"failed",identity,error:String(error),checks},null,2));
  throw error;
}finally{await b?.close();await h.close();}
