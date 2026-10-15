import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { privateStage3Browser } from "./fixtures/private-stage3-browser";
import { verifyCandidateIdentity } from "./fixtures/candidate-build-identity";
import { assertDisposableTestInfrastructure } from "./test-infrastructure-guard";
import { contactAreaSections } from "../client/src/lib/crm-destination-state";
import { crmVisualMetricsExpression } from "./fixtures/crm-visual-metrics";
import { cpus, availableParallelism } from "node:os";

await assertDisposableTestInfrastructure({operation:"C2 protected compiled browser",requireRedis:true});
const identity=await verifyCandidateIdentity();
const clientRoot=path.resolve("dist/public");
const directory="docs/certification/stage3-c2/browser";
const receipts:Array<Record<string,unknown>>=[];
const visualFailures:Array<Record<string,unknown>>=[];
const h=await stage3BHttpFixture(async app=>{
  for(const [file,fn] of [
    ["contacts","registerContactsRoutes"],["crm-operations","registerCrmOperationsRoutes"],
    ["notifications","registerNotificationsRoutes"],["tickets-tasks","registerTicketsTasksRoutes"],
    ["message-drafts","registerMessageDraftRoutes"],["analytics","registerAnalyticsRoutes"],
    ["deals","registerDealsRoutes"],["activity","registerActivityRoutes"],
    ["daily-briefing","registerDailyBriefingRoutes"],["my-day","registerMyDayRoutes"],
    ["toolkit","registerToolkitRoutes"],["inbox","registerInboxRoutes"],
    ["live-chat","registerLiveChatRoutes"],
    ["conversation-ai-config","registerConversationAiConfigRoutes"],
    ["ai","registerAiRoutes"],["nba","registerNbaRoutes"],
    ["admin","registerAdminRoutes"],["permissions-audit","registerPermissionsAuditRoutes"],
  ]) {const module=await import(`../server/routes/${file}.ts`);module[fn](app);}
  app.use("/api",(_req,res)=>res.status(501).json({message:"Unregistered isolated C2 service; blocked, not empty"}));
  const {static:serveStatic}=await import("express");
  app.use(serveStatic(clientRoot));
  app.use((_req,res)=>res.sendFile("index.html",{root:clientRoot}));
});
let browser:Awaited<ReturnType<typeof privateStage3Browser>>|undefined;
async function checkpoint(phase:string){
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(`${directory}/progress-receipt.json`,JSON.stringify({
    identity,phase,status:"in_progress; bounded observations only, not completed browser acceptance",
    asOf:new Date().toISOString(),boundedReceipts:receipts,visualFailures,
    responseFaultEvents:h.responseFaultEvents,responseFaultsExecuted:h.responseLossCount(),
    externalEffects:h.externalCalls(),
  },null,2)+"\n");
  console.log(`C2 browser checkpoint: ${phase}; ${receipts.length} bounded observations`);
}
async function openC2Browser(options:Parameters<typeof privateStage3Browser>[4]){
  const instance=await privateStage3Browser(h.base,"",h.originalFetch,directory,options);
  const navigate=instance.navigate;
  instance.navigate=async(page:string)=>{
    const firstRequest=instance.requests.length;
    await navigate(page);
    let fingerprint="",stableSince=Date.now();
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      const documentId=(await instance.call("Page.getFrameTree")).frameTree.frame.loaderId;
      const requests=instance.requests.slice(firstRequest)
        .filter(request=>!request.documentId || request.documentId===documentId);
      const rendered=await instance.evaluate(`document.readyState==="complete" &&
        !!document.querySelector("#root")?.firstElementChild`);
      const next=JSON.stringify(requests.map(request=>[request.url,request.method,request.status,request.failed]));
      if(next!==fingerprint){fingerprint=next;stableSince=Date.now();}
      if(rendered && requests.every(request=>request.status!==undefined || !!request.failed) &&
        Date.now()-stableSince>=200)return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error(`C2 document/API navigation did not settle: ${page}`);
  };
  return instance;
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,600));
const waitForDom=async(expression:string)=>{
  for(let attempt=0;attempt<200;attempt++){
    if(await browser!.evaluate(expression))return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error(`Useful UI condition not reached: ${expression}`);
};
try{
  await checkpoint("current candidate fixture preparation starting");
  await fs.mkdir(directory,{recursive:true});
  await h.pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1",[h.prefix+"%"]);
  const contacts=(await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class,assigned_to,email_status)
    SELECT 'C2 Person '||n,'Synthetic',$1||n||'@example.test','','production',$2,'valid'
    FROM generate_series(1,601)n RETURNING id`,[h.prefix,h.email("agent")])).rows;
  const contactId=contacts[600].id;
  const missingNameContactId=contacts[590].id;
  await h.pool.query("UPDATE contacts SET first_name='',last_name='' WHERE id=$1",[missingNameContactId]);
  const companyId=(await h.pool.query("INSERT INTO companies(legal_name,created_by_user_id) VALUES('C2 protected company',$1) RETURNING id",[h.userId("agent")])).rows[0].id;
  await h.pool.query("UPDATE contacts SET is_parent_account=true WHERE id=$1",[contactId]);
  const merchantId=(await h.pool.query("INSERT INTO sdr_merchants(business_name) VALUES('C2 synthetic SDR lineage') RETURNING id")).rows[0].id;
  await h.pool.query("INSERT INTO sdr_lead_state(merchant_id,contact_id) VALUES($1,$2)",[merchantId,contactId]);
  await h.pool.query(`INSERT INTO agents(user_id,first_name,last_name,email) VALUES($1,'C2','Agent',$2)`,[h.userId("agent"),h.email("agent")]);
   const dealId=(await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,owner,record_class) VALUES($1,'sales','New Lead',$2,'production') RETURNING id`,
    [contactId,h.email("agent")])).rows[0].id;
   const legacyDealId=(await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,owner,record_class) VALUES($1,'sales','New',$2,'production') RETURNING id`,
     [contactId,h.email("agent")])).rows[0].id;
   const keyboardDeals=new Map<string,number>();
   for(const role of ["admin","manager","agent"])keyboardDeals.set(role,
     (await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,owner,record_class)
       VALUES($1,'sales','New Lead',$2,'production') RETURNING id`,[contactId,h.email("agent")])).rows[0].id);
   await h.pool.query("INSERT INTO deals(contact_id,pipeline,stage,owner,record_class) VALUES($1,'onboarding','New',$2,'production')",[contactId,h.email("agent")]);
  await h.pool.query(`INSERT INTO tasks(title,contact_id,assigned_to,canonical_assignee,status,authority_state,due_date)
    VALUES('C2 due work',$1,$2,$2,'pending','open',NOW())`,[contactId,h.email("agent")]);
  for(let n=0;n<23;n++)await h.pool.query(`INSERT INTO audit_logs(action,entity_type,entity_id,details,created_at)
    VALUES('inbound_email_received','contact',$1,$2::jsonb,NOW()-($3||' seconds')::interval)`,
    [n===1?missingNameContactId:contactId,JSON.stringify({body:n===0?"https://example.test/"+("_".repeat(1500)):`C2 incoming ${n}`,channel:"email"}),String(n)]);
  for(const role of ["admin","manager","agent"]){
    browser=await openC2Browser({realInput:true});
    await browser.navigate("/login");await browser.waitFor(/Sign In/);
    await browser.set('[data-testid="input-email"]',h.email(role));await browser.set('[data-testid="input-password"]',h.password);
    await browser.click('[data-testid="button-login"]');await browser.waitFor(/Dashboard|Today|My Day/);
    await browser.evaluate("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");
    // Literal assigned entrances retain real wrappers and compatibility
    // redirects. A destination observation is deliberately not an action pass.
    const entrances=JSON.parse(await fs.readFile("docs/certification/stage3-c2/ownership.json","utf8")).routes;
    for(const entrance of entrances){
      const recordId=entrance.pattern.includes("companies")?companyId:contactId;
      const requested=entrance.pattern.replace(":id",String(recordId));
      await browser.navigate(requested);await wait();await wait();
      const destination=await browser.evaluate("location.pathname+location.search");
      if(requested.includes("/dashboard/mobile"))
        assert.ok(destination.startsWith("/mobile"),`${requested}: ${destination}`);
      if(role!=="agent" && ["/dashboard/my-leads","/dashboard/my-day"].includes(requested))
        assert.ok(!destination.startsWith(requested),`Expected agent-only redirect: ${requested}`);
      if(role==="agent" && ["/dashboard/stage-rules","/dashboard/nba"].includes(requested))
        assert.ok(!destination.startsWith(requested),`Expected privileged redirect: ${requested}`);
      receipts.push({role,routeId:entrance.id,requested,destination,
        outcome:"actual direct entrance/wrapper observation; child/action coverage remains separate"});
    }
    await browser.navigate(`/dashboard/contacts/${contactId}?area=overview&section=overview`);await wait();
    await browser.navigate(`/dashboard/contacts/${contactId}?area=conversations&section=notes`);await wait();
    await browser.evaluate("history.back()");await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('section')"),"overview");
    await browser.evaluate("history.forward()");await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('section')"),"notes");
    await browser.navigate(`/dashboard/tasks-appointments?tab=tasks&contactId=${contactId}#work`);await wait();
    await browser.click('[data-testid="tab-calendar"]');await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('contactId')"),String(contactId));
    assert.equal(await browser.evaluate("location.hash"),"#work");
    await browser.evaluate("history.back()");await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('tab')"),"tasks");
    await browser.evaluate("history.forward()");await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('tab')"),"calendar");
    await browser.navigate("/dashboard/comms-hub?tab=messages");await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('channel')"),"sms");
    await browser.navigate("/dashboard/comms-hub?tab=live-chat");await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('channel')"),"site");
    receipts.push({role,control:"Contact Back/Forward; Work click preserves context/hash and pushes; exact legacy Inbox channels",outcome:"passed"});
    await browser.navigate("/dashboard/contacts");await browser.waitFor(/People/);await wait();
    await browser.click('[data-testid="button-add-contact"]');await browser.waitFor(/Create New Contact/);await wait();
    await waitForDom("!!document.querySelector('[data-testid=\"input-create-contact-first-name\"]')");
    const newContactFirst=`C2 header creation ${role} ${randomUUID()}`;
    await browser.set('[data-testid="input-create-contact-first-name"]',newContactFirst);
    await browser.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await browser.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await wait();
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM contacts WHERE first_name=$1",[newContactFirst])).rows[0].n,0);
    await browser.click('[data-testid="button-add-contact"]');await browser.waitFor(/Create New Contact/);await wait();
    await waitForDom("!!document.querySelector('[data-testid=\"input-create-contact-first-name\"]')");
    await browser.set('[data-testid="input-create-contact-first-name"]',newContactFirst);
    await browser.set('[data-testid="input-create-contact-last-name"]',"Synthetic");
    await browser.click('[role="dialog"] button[type="submit"]');await wait();await wait();
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM contacts WHERE first_name=$1",[newContactFirst])).rows[0].n,0,
      "Retained required-field validation prevents creation");
    assert.match(await browser.text(),/Invalid email/);
    await browser.set('[data-testid="input-create-contact-email"]',`${h.prefix}header-${randomUUID()}@example.test`);
    await browser.set('[data-testid="input-create-contact-phone"]',`+1202555${String(Date.now()%10000).padStart(4,"0")}`);
    await browser.set('[data-testid="input-create-contact-company"]',"C2 synthetic header company");
    const contactLossBefore=h.responseLossCount();
    h.loseNextSuccessfulResponse("POST","/api/contacts","truncate");
    await browser.click('[role="dialog"] button[type="submit"]');await wait();await wait();
    assert.equal(h.responseLossCount(),contactLossBefore+1,"Contact creation confirmation fault must actually execute");
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM contacts WHERE first_name=$1",[newContactFirst])).rows[0].n,1);
    await browser.click('[role="dialog"] button[type="submit"]');await wait();await wait();
    const createdContact=(await h.pool.query("SELECT id FROM contacts WHERE first_name=$1",[newContactFirst])).rows;
    assert.equal(createdContact.length,1,"Shared header Add Contact uses the actual durable handler");
    await browser.navigate(`/dashboard/contacts/${createdContact[0].id}`);await browser.waitFor(/C2 synthetic header company/);
    assert.equal(await browser.evaluate("location.pathname"),`/dashboard/contacts/${createdContact[0].id}`);
    receipts.push({role,control:"Retained shared-header Add Contact / Escape Cancel / real save / exact-ID reload",outcome:"passed",persistedDelta:1});
    // Contextual tools use exact contacts beyond the first 500 directory rows,
    // real handlers and advisory disabled gates, never provider execution.
    for(const [page,reason] of [
      [`/dashboard/chat?contactId=${contactId}`,"chat-capability-reason"],
      ["/dashboard/bin-lookup","bin-capability-reason"],
      [`/dashboard/call-outcome?contactId=${contactId}&dealId=${dealId}`,"call-outcome-pause-reason"],
      ...(role==="agent"?[]:[["/dashboard/stage-rules","stage-activation-reason"],["/dashboard/nba","nba-pause-reason"]]),
    ]){
      await browser.navigate(page);
      await waitForDom(`!!document.querySelector('[data-testid="${reason}"]')`);
      assert.ok(await browser.evaluate(`!!document.querySelector('[data-testid="${reason}"]')`),page);
      assert.equal(await browser.evaluate("document.querySelectorAll('h1').length"),1,page);
      receipts.push({role,page,control:"Contextual shell and accurate denied execution reason",outcome:"passed"});
    }
    await browser.navigate("/dashboard/chat");await wait();
    await browser.click('[data-testid="button-load-from-contact"]');
    await browser.set('[data-testid="input-contact-search"]',"C2 Person 601");
    await browser.waitFor(/C2 Person 601/);
    await browser.click(`[data-testid="contact-option-${contactId}"]`);await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('contactId')"),String(contactId));
    await browser.set('[data-testid="input-chat-message"]',"Do not execute provider");
    await browser.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
    assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"button-send-message\"]').disabled"),true);
    assert.equal(browser.requests.filter(r=>r.method==="POST" && r.url.endsWith("/api/ai/chat")).length,0);
    receipts.push({role,control:"Authorized Chat search beyond first 500 + paused Enter/button zero dispatch",outcome:"passed",recordId:contactId});
    await browser.navigate(`/dashboard/call-outcome?contactId=${contactId}&dealId=${dealId}`);await wait();await wait();
    await browser.click('[data-testid="select-outcome"]');
    await wait();
    await browser.click('[data-testid="select-outcome-connected---needs-proposal"]');
    assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"button-generate-followups\"]').disabled"),true);
    const logCount=(await h.pool.query("SELECT count(*)::int n FROM call_logs WHERE contact_id=$1",[contactId])).rows[0].n;
    const revisionBefore=(await h.pool.query("SELECT value FROM system_settings WHERE key='crm_fact_cache_revision'")).rows[0]?.value;
    const effectsBefore=(await h.pool.query("SELECT (SELECT count(*) FROM tasks)::int tasks,(SELECT count(*) FROM sequence_enrollments)::int enrollments")).rows[0];
    await browser.set('[data-testid="input-duration"]',"2");
    h.loseNextSuccessfulResponse("POST","/api/call-logs");
    const callLossBefore=h.responseLossCount();
    await browser.click('[data-testid="button-log-only-skip"]');await browser.waitFor(/Local Call Log Saved/);
    assert.equal(h.responseLossCount(),callLossBefore+1,"The post-commit response fault must actually execute");
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM call_logs WHERE contact_id=$1",[contactId])).rows[0].n,logCount+1);
    assert.equal((await h.pool.query("SELECT duration FROM call_logs WHERE contact_id=$1 ORDER BY id DESC LIMIT 1",[contactId])).rows[0].duration,120);
    assert.notEqual((await h.pool.query("SELECT value FROM system_settings WHERE key='crm_fact_cache_revision'")).rows[0]?.value,revisionBefore,
      "The actual freshness owner must finish before the fixture drops the socket response");
    const effectsAfter=(await h.pool.query("SELECT (SELECT count(*) FROM tasks)::int tasks,(SELECT count(*) FROM sequence_enrollments)::int enrollments")).rows[0];
    assert.deepEqual(effectsAfter,effectsBefore);
    assert.equal((await h.pool.query("SELECT stage FROM deals WHERE id=$1",[dealId])).rows[0].stage,"New Lead");
    await browser.navigate(`/dashboard/contacts/${contactId}?area=sales-work&section=call-logs`);await wait();
    receipts.push({role,control:"Exact linked Log Only actual lost-response/readback",outcome:"passed",recordId:contactId,
      persistedDelta:1,taskDelta:0,enrollmentDelta:0,stage:"unchanged"});
    await browser.navigate("/dashboard/tasks-appointments");await browser.waitFor(/Tasks/);await wait();
    await waitForDom("document.querySelector('[data-testid=\"button-ai-generate-tasks\"]') instanceof HTMLButtonElement && document.querySelector('[data-testid=\"button-new-task\"]') instanceof HTMLButtonElement");
    assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"button-ai-generate-tasks\"]').disabled"),true);
    const taskTitle=`C2 compiled Work ${role} ${randomUUID()}`;
    const fillTask=async()=>{
      await browser.click('[data-testid="button-new-task"]');await wait();
      await browser.set('[data-testid="input-task-title"]',taskTitle);
      await browser.set('[data-testid="input-task-contact-id"]',String(contactId));
      await browser.set('[data-testid="input-task-assigned"]',h.email("agent"));
    };
    await fillTask();await browser.click('[data-testid="button-cancel-task"]');await wait();
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[taskTitle])).rows[0].n,0);
    await fillTask();const workLossBefore=h.responseLossCount();h.loseNextSuccessfulResponse("POST","/api/tasks","truncate");
    await browser.click('[data-testid="button-submit-task"]');
    const workFaultDeadline=Date.now()+10000;
    while(h.responseLossCount()===workLossBefore && Date.now()<workFaultDeadline)await wait();
    assert.equal(h.responseLossCount(),workLossBefore+1,"A truncated post-commit confirmation must reach the real browser");
    await wait();
    // The persisted command is real, but an absent reply is not durable UI success.
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[taskTitle])).rows[0].n,1);
    assert.ok(await browser.evaluate("!!document.querySelector('[data-testid=\"button-submit-task\"]')"));
    await browser.click('[data-testid="button-submit-task"]');await browser.waitFor(/Task created successfully/);await wait();
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[taskTitle])).rows[0].n,1);
    await fillTask();await browser.click('[data-testid="button-submit-task"]');
    await waitForDom("!document.querySelector('[data-testid=\"button-submit-task\"]')");
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[taskTitle])).rows[0].n,2,
      "Confirmed save ends the intent; an intentionally identical later task is not deduplicated");
    await browser.navigate("/dashboard/tasks-appointments");await browser.waitFor(new RegExp(taskTitle));await wait();
    receipts.push({role,control:"Work create Cancel / actual lost-response same-UUID retry / new identical intent / durable reload",
      persistedAfterCancel:0,persistedAfterRetry:1,persistedAfterNewIntent:2,outcome:"passed"});
    const workRows=(await h.pool.query("SELECT id,authority_fence FROM tasks WHERE title=$1 ORDER BY id",[taskTitle])).rows;
    for(const row of workRows)await browser.click(`[data-testid="checkbox-task-${row.id}"]`);
    await browser.click('[data-testid="button-task-bulk-actions"]');await wait();
    await browser.click('[data-testid="button-bulk-delete"]');await wait();
    await browser.click('[data-testid="button-cancel-bulk-delete"]');await wait();
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1 AND deleted_at IS NULL",[taskTitle])).rows[0].n,2);
    const concurrent=await h.request(role,"PUT",`/api/tasks/${workRows[0].id}`,{
      priority:"high",expectedFence:workRows[0].authority_fence,expectedActorId:h.userId(role),commandId:randomUUID(),
    });
    assert.equal(concurrent.status,200);
    await browser.click('[data-testid="button-task-bulk-actions"]');await wait();
    await browser.click('[data-testid="button-bulk-complete"]');await browser.waitFor(/Failed to complete tasks/);await wait();
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1 AND authority_state='completed'",[taskTitle])).rows[0].n,0,
      "Work bulk is atomic: one stale member cannot partially complete the other");
    assert.equal(await browser.evaluate("document.querySelectorAll('[data-testid^=\"checkbox-task-\"][data-state=\"checked\"]').length"),2);
    await browser.call("Page.reload");await browser.waitFor(new RegExp(taskTitle));await wait();
    for(const row of workRows)await browser.click(`[data-testid="checkbox-task-${row.id}"]`);
    await browser.click('[data-testid="button-task-bulk-actions"]');await wait();
    await browser.click('[data-testid="button-bulk-complete"]');await browser.waitFor(/2 tasks completed/);
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1 AND authority_state='completed'",[taskTitle])).rows[0].n,2);
    receipts.push({role,control:"Work bulk delete Cancel zero effects / stale displayed-member atomic conflict preserves selection / fresh explicit bulk complete",
      persistedAfterCancel:2,completedAfterConflict:0,completedAfterFreshCommand:2,outcome:"passed"});
    await browser.navigate(`/dashboard/companies/${companyId}`);await browser.waitFor(/C2 protected company/);await wait();
    if(role==="agent"){
      assert.equal(await browser.evaluate(`document.querySelector('[data-testid="btn-add-company-ma-event"]').disabled`),true);
      receipts.push({role,control:"Company M&A privilege-specific create capability",outcome:"agent sees disabled control; no create effect"});
    }else{
      const beforeMaCancel=(await h.pool.query("SELECT count(*)::int n FROM ma_events WHERE entity_type='company' AND entity_id=$1",[companyId])).rows[0].n;
      await browser.click('[data-testid="btn-add-company-ma-event"]');await browser.waitFor(/Log M&A Event/);await wait();
      await browser.set('[data-testid="counterparty-search"]',"C2 Person 1 Synthetic");
      await waitForDom(`Boolean(document.querySelector('[data-testid="counterparty-option-${contacts[0].id}"]'))`);
      await browser.click(`[data-testid="counterparty-option-${contacts[0].id}"]`);
      await browser.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await browser.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await wait();
      assert.equal((await h.pool.query("SELECT count(*)::int n FROM ma_events WHERE entity_type='company' AND entity_id=$1",[companyId])).rows[0].n,beforeMaCancel);
      receipts.push({role,control:"Company counterparty authorized exact selection beyond first page / Escape Cancel",contactId:contacts[0].id,outcome:"zero immutable-event writes"});
    }
    await browser.navigate("/dashboard/pipeline");await browser.waitFor(/Sales Pipeline/);await wait();
    const beforePickerCancel=(await h.pool.query("SELECT count(*)::int n FROM deals")).rows[0].n;
    await browser.click('[data-testid="button-new-deal"]');await browser.waitFor(/Create New Deal/);
    await wait();
    await browser.set('[data-testid="new-deal-contact-search"]',"C2 Person 1 Synthetic");
    await waitForDom(`Boolean(document.querySelector('[data-testid="new-deal-contact-option-${contacts[0].id}"]'))`);
    await browser.click(`[data-testid="new-deal-contact-option-${contacts[0].id}"]`);
    await browser.waitFor(/C2 Person 1 Synthetic/);
    await browser.click('[data-testid="button-cancel-create"]');await wait();
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM deals")).rows[0].n,beforePickerCancel);
    receipts.push({role,control:"New Deal authorized contact search/select beyond page one; Cancel",contactId:contacts[0].id,
      outcome:"selected exact reader identity; cancelled with zero writes"});
    await waitForDom(`!!document.querySelector('[data-testid="card-deal-${legacyDealId}"]')`);
    const legacyIdentity=await browser.evaluate(`document.querySelector('[data-testid="card-deal-${legacyDealId}"]').innerText`);
    assert.match(legacyIdentity,/C2 Person/,"A recorded legacy stage must retain actual linked identity in Board");
    await browser.click('[data-testid="button-view-list"]');await wait();
    assert.equal(await browser.evaluate(`!!document.querySelector('[data-testid="list-row-deal-${legacyDealId}"]')`),true,
      "List must retain the same legacy-stage deal");
    await browser.click('[data-testid="button-view-kanban"]');await wait();
    const keyboardKey=async(key:string,code:string,windowsVirtualKeyCode:number)=>{
      const text=key==="Enter" ? "\r" : key===" " ? " " : undefined;
      await browser.call("Input.dispatchKeyEvent",{type:"keyDown",key,code,windowsVirtualKeyCode,
        ...(text ? {text,unmodifiedText:text} : {})});
      await browser.call("Input.dispatchKeyEvent",{type:"keyUp",key,code,windowsVirtualKeyCode});
    };
    const keyboardDealId=keyboardDeals.get(role)!;
    await browser.click(`[data-testid="button-deal-actions-${keyboardDealId}"]`);await wait();
    await browser.click(`[data-testid="menu-quick-edit-deal-${keyboardDealId}"]`);await browser.waitFor(/Edit Lead/);
    const quickCancelBefore=(await h.pool.query("SELECT first_name,company_name FROM contacts WHERE id=$1",[contactId])).rows[0];
    await waitForDom(`document.querySelector('[data-testid="input-qe-first-name"]')?.value===${JSON.stringify(quickCancelBefore.first_name)}`);
    await waitForDom(`(()=>{
      const input=document.querySelector('[data-testid="input-qe-first-name"]');
      if(!input)return false;
      const r=input.getBoundingClientRect(),dialog=input.closest('[role="dialog"]');
      return r.x>=0 && r.right<=innerWidth && r.height>=44 &&
        !dialog?.getAnimations().some(animation=>animation.playState==="running") &&
        document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input;
    })()`);
    await browser.set('[data-testid="input-qe-first-name"]',"Unsaved C2 name");
    await browser.click('[data-testid="button-qe-cancel"]');await wait();
    assert.deepEqual((await h.pool.query("SELECT first_name,company_name FROM contacts WHERE id=$1",[contactId])).rows[0],quickCancelBefore);
    await browser.call("Network.setBypassServiceWorker",{bypass:true});browser.failRead(`/api/contacts/${contactId}`);
    const quickFaultBefore=browser.readFaults.length;
    await browser.click(`[data-testid="button-deal-actions-${keyboardDealId}"]`);await wait();
    await browser.click(`[data-testid="menu-quick-edit-deal-${keyboardDealId}"]`);await browser.waitFor(/Linked contact could not be loaded/);
    assert.ok(browser.readFaults.length>quickFaultBefore);
    assert.equal(await browser.evaluate("!!document.querySelector('[data-testid=\"button-qe-save\"]')"),false);
    await keyboardKey("Escape","Escape",27);browser.failRead(null);
    await browser.call("Network.setBypassServiceWorker",{bypass:false});
    await waitForDom(`!document.querySelector('[data-testid="sheet-deal-quick-edit"]') &&
      getComputedStyle(document.body).pointerEvents!=="none"`);
    await waitForDom("document.activeElement!==document.body && document.activeElement?.isConnected");
    assert.equal(await browser.evaluate(`document.activeElement?.getAttribute('data-testid')`),
      `button-deal-actions-${keyboardDealId}`,"Quick Edit returns focus to its own live record action");
    assert.equal(await browser.evaluate("document.activeElement!==document.body && document.activeElement?.isConnected"),true,
      "Closing the keyboard Sheet with a detached menu trigger restores a connected focus target");
    receipts.push({role,control:"Pipeline quick edit exact protected contact / Cancel zero writes / actual unavailable read hides editable placeholders",recordId:contactId,outcome:"passed"});
    const keyboardStage=async(stage:string,expectedStage=stage)=>{
      if(role==="agent"){
        await browser.evaluate(`document.querySelector('[data-testid="button-open-deal-${keyboardDealId}"]').focus()`);
        await keyboardKey("Enter","Enter",13);await browser.waitFor(/Deal Details/);await wait();
        await browser.evaluate("document.querySelector('[data-testid=\"select-edit-stage\"]').focus()");
        await keyboardKey("Enter","Enter",13);await wait();
        await waitForDom("document.activeElement?.closest('[role=\"listbox\"]')!==null");
        await keyboardKey("Home","Home",36);
        await waitForDom("document.activeElement?.getAttribute('role')==='option' && document.activeElement.textContent.trim()==='New Lead'");
        if(stage==="Enriched"){
          await keyboardKey("ArrowDown","ArrowDown",40);
          await waitForDom("document.activeElement?.getAttribute('role')==='option' && document.activeElement.textContent.trim()==='Enriched'");
        }
        await keyboardKey("Enter","Enter",13);await wait();
        assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"select-edit-stage\"]').textContent"),stage);
        const beforeStageSave=browser.requests.filter(request=>
          request.method==="PUT" && new URL(request.url,h.base).pathname===`/api/deals/${keyboardDealId}`).length;
        await browser.evaluate("document.querySelector('[data-testid=\"button-save-deal\"]').focus()");
        await keyboardKey("Enter","Enter",13);
        if(stage===expectedStage)await waitForDom("!document.querySelector('[data-testid=\"button-save-deal\"]')");
        else await browser.waitFor(/The existing structural policy does not permit this move; no command was sent/);
        assert.equal((await h.pool.query("SELECT stage FROM deals WHERE id=$1",[keyboardDealId])).rows[0].stage,expectedStage);
        if(stage!==expectedStage){
          assert.match(await browser.text(),/The existing structural policy does not permit this move; no command was sent/);
          assert.equal(browser.requests.filter(request=>request.method==="PUT" &&
            new URL(request.url,h.base).pathname===`/api/deals/${keyboardDealId}`).length,beforeStageSave,
            "Agent structural rejection occurs before any deal PUT and preserves durable stage");
        }
        await browser.navigate("/dashboard/pipeline");
        await waitForDom(`!!document.querySelector('[data-testid="card-deal-${keyboardDealId}"]')`);
        return;
      }
      await browser.evaluate(`document.querySelector('[data-testid="checkbox-deal-${keyboardDealId}"]').focus()`);
      await keyboardKey(" ","Space",32);await wait();
      await browser.evaluate("document.querySelector('[data-testid=\"button-bulk-actions\"]').focus()");
      await keyboardKey("Enter","Enter",13);await wait();
      await browser.evaluate("document.querySelector('[data-testid=\"button-bulk-move-stage\"]').focus()");
      await keyboardKey("ArrowRight","ArrowRight",39);await wait();
      await browser.evaluate(`document.querySelector('[data-testid="button-bulk-stage-${stage.replaceAll(" ","-").toLowerCase()}"]').focus()`);
      await keyboardKey("Enter","Enter",13);await wait();await wait();
      assert.equal((await h.pool.query("SELECT stage FROM deals WHERE id=$1",[keyboardDealId])).rows[0].stage,expectedStage);
      if(stage!==expectedStage){
        assert.match(await browser.text(),/DEAL_STAGE_ILLEGAL/);
        assert.equal(await browser.evaluate(`document.querySelector('[data-testid="checkbox-deal-${keyboardDealId}"]').getAttribute('data-state')`),"checked",
          "Rejected movement retains the exact selected record with its server reason");
      }
      await browser.navigate("/dashboard/pipeline");
      await waitForDom(`!!document.querySelector('[data-testid="card-deal-${keyboardDealId}"]')`);
      assert.ok(await browser.evaluate(`!!document.querySelector('[data-testid="card-deal-${keyboardDealId}"]')`));
    };
    if(role==="agent"){
      const beforeBulkDenial=browser.requests.filter(r=>r.method==="POST"&&new URL(r.url,h.base).pathname==="/api/deals/bulk-stage").length;
      await browser.click(`[data-testid="checkbox-deal-${keyboardDealId}"]`);
      await browser.click('[data-testid="button-bulk-actions"]');await wait();
      assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"button-bulk-move-stage\"]').getAttribute('aria-disabled')"),"true");
      await keyboardKey("Escape","Escape",27);await browser.click('[data-testid="button-clear-selection"]');await wait();
      assert.equal(browser.requests.filter(r=>r.method==="POST"&&new URL(r.url,h.base).pathname==="/api/deals/bulk-stage").length,beforeBulkDenial);
      receipts.push({role,control:"Agent bulk stage privilege is disabled with reason; individual owned editor remains available",outcome:"zero bulk requests/effects"});
    }
    await keyboardStage("Enriched");await keyboardStage("New Lead","Enriched");
    receipts.push({role,control:role==="agent" ? "Keyboard named Open deal / individual stage editor / durable Board reload" : "Keyboard Space/Enter/submenu single-record stage movement and durable Board reload",
      dealId:keyboardDealId,stages:["Enriched"],rejectedStage:"New Lead",outcome:"passed; blocked regression preserves state and selection"});
    await checkpoint(`${role}: keyboard movement and rejection complete`);
    // Contact APIs are forwarded through the worker's own network context.
    // Page-target CDP faults cannot certify that worker path. Bypass only for
    // these fault assertions, then restore before normal browser acceptance.
    await browser.call("Network.setBypassServiceWorker",{bypass:true});
    const historyFaultsBefore=browser.readFaults.length;
    browser.failRead("/api/audit-logs/entity/deal/");
    await browser.navigate(`/dashboard/pipeline?id=${dealId}`);await wait();
    await browser.waitFor(/Immutable deal history could not be loaded/);
    assert.doesNotMatch(await browser.text(),/No change history recorded yet/);
    assert.ok(browser.readFaults.slice(historyFaultsBefore).some(fault=>fault.path===`/api/audit-logs/entity/deal/${dealId}`),
      "History error acceptance requires an executed exact-record 503, not an absent fixture handler");
    assert.ok(browser.requests.some(request=>new URL(request.url,h.base).pathname===`/api/deals/${dealId}`&&request.status===200),
      "Selected-deal history evidence requires the actual authorized exact-record read");
    receipts.push({role,control:"Pipeline immutable history failure",outcome:"unavailable, not empty; original reader retained"});
    browser.failRead(null);
    browser.failRead(`/api/contacts/${contactId}/nps-responses`);
    await browser.navigate(`/dashboard/contacts/${contactId}?area=service-performance&section=nps`);await wait();
    await browser.waitFor(/Survey history unavailable/);
    assert.doesNotMatch(await browser.text(),/No NPS surveys have been sent/);
    assert.ok(browser.readFaults.some(fault=>fault.path===`/api/contacts/${contactId}/nps-responses`),
      "Survey error acceptance requires the actual 503 execution");
    receipts.push({role,control:"Contact survey-history read failure",outcome:"unavailable, not fabricated zero; C4 interior not certified"});
    browser.failRead(null);
    if(role==="agent"){
      await browser.call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
      const mobileFaultsBefore=browser.readFaults.length;
      browser.failRead(`/api/contacts/${contactId}/enrollments`);
      await browser.navigate(`/mobile/contacts/${contactId}`);await browser.waitFor(/Enrollment history unavailable/);
      assert.ok(browser.readFaults.slice(mobileFaultsBefore).some(fault=>fault.path===`/api/contacts/${contactId}/enrollments`),
        "Mobile error state must follow an actually failed enrollment read");
      assert.equal(await browser.evaluate("!!document.querySelector('[data-testid=\"chip-active-sequences\"]')"),false);
      assert.ok(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth+1"));
      receipts.push({role,control:"Dedicated mobile enrollment-history read failure",outcome:"unavailable; no stale active chip or zero-history claim",width:390});
      browser.failRead(null);
      await browser.call("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    }
    await browser.call("Network.setBypassServiceWorker",{bypass:false});
    receipts.push({role,control:"Board/List retain recorded legacy stage and exact linked identity",
      dealId:legacyDealId,recordedStage:"New",outcome:"passed",effects:"Read/view only; no stage normalization or writes"});
    for(const [page,title] of [
      [role==="agent"?"/dashboard/my-day":"/dashboard",role==="agent"?"My Day":"Today"],
      ["/dashboard/contacts","People"],[`/dashboard/contacts/${contactId}?area=overview&section=overview`,"C2 Person"],
      [`/dashboard/pipeline?id=${dealId}`,"Pipeline"],
      ["/dashboard/comms-hub?channel=email","Inbox"],["/dashboard/tasks-appointments","Tasks"],
    ] as const){
      const started=performance.now();await browser.navigate(page);await browser.waitFor(new RegExp(title,"i"));await wait();
      const measured=await browser.evaluate(`(()=>{const h=document.querySelector('main h1')||document.querySelector('h1');return {
        h1s:document.querySelectorAll('h1').length,title:h?.textContent,font:h?getComputedStyle(h).fontFamily:null,
        gutter:(()=>{const p=document.querySelector('main .crm-page');return p?{
          shell:Number.parseFloat(getComputedStyle(document.querySelector('main')).paddingLeft),
          page:Number.parseFloat(getComputedStyle(p).paddingLeft)}:null;})(),
        bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth,plexLoaded:[...document.fonts].some(f=>f.family==='IBM Plex Sans'&&f.status==='loaded')
      }})()`);
      assert.match(measured.font,/IBM Plex Sans/);assert.ok(measured.bodyWidth<=measured.viewport+1,JSON.stringify(measured));
       assert.equal(measured.h1s,1,"one owned workspace H1, including the shell");
       assert.deepEqual(measured.gutter,{shell:0,page:24},"one 24px workspace gutter, not nested shell/page padding");
      await browser.screenshot(`${role}-${title.replaceAll(" ","-")}-1440`);
      receipts.push({role,page,measurement:measured,elapsedMs:performance.now()-started,identity:identity.inputHash,
        qualification:"Settled first viewport; not all controls or useful-list performance threshold proof"});
      if(role==="admin"){
        for(const width of [320,390,768,1280,1440]){
          await browser.call("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});
          await browser.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
          for(const theme of ["light","dark"]){
            await browser.evaluate(`document.documentElement.classList.${theme==="dark"?"add":"remove"}('dark')`);await wait();
            const metrics=await browser.evaluate(crmVisualMetricsExpression);
            const tree=await browser.call("Accessibility.getFullAXTree");
            const unnamed=tree.nodes.filter((node:any)=>!node.ignored&&["button","textbox","combobox","checkbox","tab"].includes(node.role?.value)&&!node.name?.value)
              .map((node:any)=>({role:node.role.value,backendDOMNodeId:node.backendDOMNodeId}));
             for(const control of unnamed.slice(0,6)){
               const node=await browser.call("DOM.describeNode",{backendNodeId:control.backendDOMNodeId});
               Object.assign(control,{tag:node.node.nodeName,attributes:node.node.attributes});
             }
              // Collect safe read-only observations, retaining every original
              // threshold. Functional/access/effect assertions still fail fast.
              let visualOutcome="passed";
              try {
                assert.equal(metrics.status,"measured",page);
                assert.ok(metrics.bodyWidth<=width+1,JSON.stringify({page,width,bodyWidth:metrics.bodyWidth}));
                assert.equal(metrics.gutter,width<640?12:24,"single responsive owned gutter");
                assert.match(metrics.font,/IBM Plex Sans/);
                assert.equal(unnamed.length,0,`${page} ${width} ${theme}: unnamed interactive controls ${JSON.stringify(unnamed)}`);
                assert.deepEqual(metrics.contrastViolations.filter((item:any)=>!item.disabled),[],
                  `${page} ${width} ${theme}: visible enabled text contrast`);
              } catch(error) {
                if(!(error instanceof assert.AssertionError))throw error;
                visualOutcome="defect";
                visualFailures.push({page,width,theme,reason:error.message,metrics,unnamedControls:unnamed});
              }
            await browser.screenshot(`admin-${title.replaceAll(" ","-")}-${width}-${theme}`);
             receipts.push({role,page,width,theme,metrics,unnamedControls:unnamed,outcome:visualOutcome,
              qualification:"Measured compiled first viewport; contrast/unnamed failures retained, not an all-accessibility pass"});
          }
        }
        await browser.evaluate("document.documentElement.classList.remove('dark')");
        await browser.call("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
        await browser.call("Emulation.setEmulatedMedia",{features:[]});
      }
    }
    await browser.navigate(`/dashboard/contacts/${contactId}?area=conversations&section=notes#record`);
    await browser.waitFor(/Notes/);await wait();
    assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('section')"),"notes");
    const note=`C2 browser durable ${randomUUID()}`;
    await browser.set('[data-testid="textarea-add-note"]',note);await browser.click('[data-testid="button-submit-note"]');
    await browser.waitFor(new RegExp(note));await browser.navigate(`/dashboard/contacts/${contactId}?area=conversations&section=notes`);
    await browser.waitFor(new RegExp(note));
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM notes WHERE entity_id=$1 AND content=$2",[contactId,note])).rows[0].n,1);
    receipts.push({role,control:"Contact inline note actual UI save/reload",outcome:"passed",recordId:contactId});
    await browser.navigate(`/dashboard/contacts/${contactId}?area=sales-work&section=tasks`);await browser.waitFor(/C2 Person/);await wait();
    const recordTaskTitle=`C2 record task ${role} ${randomUUID()}`;
    await browser.click('[data-testid="contact-secondary-new-task"]');await wait();
    await browser.set('[data-testid="input-task-title"]',recordTaskTitle);
    await browser.click('[data-testid="button-cancel-task"]');await wait();
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[recordTaskTitle])).rows[0].n,0);
    await browser.click('[data-testid="contact-secondary-new-task"]');await wait();
    await browser.set('[data-testid="input-task-title"]',recordTaskTitle);
    const recordLossBefore=h.responseLossCount();h.loseNextSuccessfulResponse("POST","/api/tasks","truncate");
    await browser.click('[data-testid="button-submit-task"]');
    await waitForDom("!!document.querySelector('[data-testid=\"contact-task-save-error\"]')");
    assert.equal(h.responseLossCount(),recordLossBefore+1,"Record create confirmation fault actually executed");
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[recordTaskTitle])).rows[0].n,1);
    assert.ok(await browser.evaluate("!!document.querySelector('[data-testid=\"contact-task-save-error\"]')"));
    await browser.click('[data-testid="button-submit-task"]');await browser.waitFor(/Task created/);await wait();
    const recordTask=(await h.pool.query("SELECT * FROM tasks WHERE title=$1",[recordTaskTitle])).rows[0];
    assert.equal(recordTask.contact_id,contactId);
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[recordTaskTitle])).rows[0].n,1);
    await browser.navigate(`/dashboard/contacts/${contactId}?area=sales-work&section=tasks`);await browser.waitFor(new RegExp(recordTaskTitle));await wait();
    await browser.click(`[data-testid="button-edit-record-task-${recordTask.id}"]`);await wait();
    await browser.set(`[data-testid="input-record-task-title-${recordTask.id}"]`,`${recordTaskTitle} changed`);
    await browser.click(`[data-testid="button-cancel-record-task-${recordTask.id}"]`);await wait();
    assert.equal((await h.pool.query("SELECT title FROM tasks WHERE id=$1",[recordTask.id])).rows[0].title,recordTaskTitle);
    const editedTitle=`${recordTaskTitle} edited`;
    await browser.click(`[data-testid="button-edit-record-task-${recordTask.id}"]`);await wait();
    await browser.set(`[data-testid="input-record-task-title-${recordTask.id}"]`,editedTitle);
    await browser.click(`[data-testid="button-save-record-task-${recordTask.id}"]`);await browser.waitFor(new RegExp(editedTitle));await wait();
    assert.equal((await h.pool.query("SELECT title FROM tasks WHERE id=$1",[recordTask.id])).rows[0].title,editedTitle);
    for(let notification=0;notification<10&&await browser.evaluate('!!document.querySelector(\'[role="status"][data-state="open"] [toast-close]\')');notification++){
      await browser.click('[role="status"][data-state="open"] [toast-close]');
      await waitForDom('!document.querySelector(\'[role="status"][data-state="closed"]\')');
    }
    assert.equal(await browser.evaluate('!!document.querySelector(\'[role="status"] [toast-close]\')'),false,
      "Real feedback dismissal settles before the next record task pointer action");
    await browser.click(`[data-testid="button-complete-record-task-${recordTask.id}"]`);
    await waitForDom(`!document.querySelector('[data-testid="button-complete-record-task-${recordTask.id}"]')`);
    assert.equal((await h.pool.query("SELECT status FROM tasks WHERE id=$1",[recordTask.id])).rows[0].status,"completed");
    await browser.navigate(`/dashboard/contacts/${contactId}?area=sales-work&section=tasks`);await browser.waitFor(new RegExp(editedTitle));await wait();
    assert.equal(await browser.evaluate(`!!document.querySelector('[data-testid="button-complete-record-task-${recordTask.id}"]')`),false);
    receipts.push({role,control:"Contact task Cancel / create lost-reply retry / durable record readback / Edit Cancel / edit save / actual completion",
      recordId:contactId,taskId:recordTask.id,persistedDelta:1,terminal:"completed",outcome:"passed"});
    for(const [area,sections] of Object.entries(contactAreaSections)){
      for(const section of sections){
        await browser.navigate(`/dashboard/contacts/${contactId}?area=${area}&section=${section}`);
        await browser.waitFor(/C2 Person/);await wait();
        assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('section')"),section);
        receipts.push({role,area,section,entrance:"direct reload",outcome:"mounted; action acceptance remains separate",
          failedRequests:browser.requests.filter(r=>r.status && r.status>=500).slice(-5)});
      }
    }
    for(const drawer of ["activity","history"]){
      await browser.navigate(`/dashboard/contacts/${contactId}?area=conversations&section=notes&drawer=${drawer}#context`);
      await browser.waitFor(new RegExp(drawer,"i"));await wait();
      assert.ok(await browser.evaluate("!!document.querySelector('[role=dialog]')"));
      await browser.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await wait();assert.equal(await browser.evaluate("document.querySelector('[role=dialog]')"),null);
      assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('section')"),"notes");
      receipts.push({role,drawer,outcome:"direct/open/Escape retains section"});
    }
    await browser.navigate("/dashboard/comms-hub?channel=email");await browser.waitFor(/Inbox/);
    await browser.waitFor(/on page/);await wait();
    assert.ok(await browser.evaluate("document.querySelectorAll('[data-testid^=\"inbox-item-\"]').length>=17"),"declared loaded-volume geometry fixture");
    await browser.click('[data-testid^="inbox-item-"]');
    await waitForDom("!!document.querySelector('[data-testid=\"selected-source-message\"]')?.textContent.includes('_'.repeat(1000))");
     assert.ok(await browser.evaluate("document.querySelector('[data-testid=\"selected-source-message\"]')?.textContent.includes('_'.repeat(1000))"),
       "Long selected source content must actually render, not only its truncated list preview");
    const draftText=`C2 ${role} channel-bound unsent draft ${randomUUID()}`;
    await browser.set('[data-testid="thread-reply-input"]',draftText);
    const draftLossBefore=h.responseLossCount();
    // Chromium may transparently retry a dropped idempotent PUT connection.
    // Truncate the committed body instead to prove the explicit UI retry path.
    h.loseNextSuccessfulResponse("PUT","/api/message-drafts","truncate");
    await browser.click('[data-testid="thread-save-draft"]');
    await browser.waitFor(/Draft issue/);
    assert.equal(h.responseLossCount(),draftLossBefore+1,"Draft proof requires the actual post-commit fault");
    assert.ok(await browser.evaluate("document.body.innerText.includes('Draft issue:')"));
    assert.equal((await h.pool.query("SELECT count(*)::int n FROM rep_message_drafts WHERE body=$1",[draftText])).rows[0].n,1,
      "An unconfirmed save is nevertheless committed exactly once");
    await browser.click('[data-testid="thread-save-draft"]');await browser.waitFor(/Saved less than a minute ago/);
    assert.equal((await h.pool.query("SELECT version FROM rep_message_drafts WHERE body=$1",[draftText])).rows[0].version,1,
      "Explicit confirmation-loss retry must replay the original command, not create a second draft revision");
    assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"thread-reply-send\"]').disabled"),true);
    await browser.evaluate("document.querySelector('[data-testid=\"thread-reply-input\"]').focus()");
    assert.equal(await browser.evaluate("document.activeElement?.getAttribute('data-testid')"),"thread-reply-input");
    await browser.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
    assert.equal(browser.requests.filter(request=>request.method==="POST" && /send|reply/.test(request.url)).length,0);
    await browser.call("Page.reload");await wait();await wait();
    assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"thread-reply-input\"]').value"),draftText);
    receipts.push({role,control:"Inbox channel-bound draft actual post-commit response loss / same-intent retry / durable reload / paused Enter and button",
      outcome:"passed",providerEffects:0});
    for(const width of [320,390,768,1280,1363,1440]){
      await browser.call("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});await wait();
      const panels=await browser.evaluate(`(()=>{const rows=[...document.querySelectorAll('[data-testid="card-item-list"],[data-testid="card-thread-panel"]')];
         return rows.map(e=>{const r=e.getBoundingClientRect();return {name:e.getAttribute('data-testid'),x:r.x,width:r.width,right:r.right,viewport:innerWidth,
           containerWidth:e.closest('.crm-inbox-container')?.getBoundingClientRect().width};});})()`);
      assert.equal(panels.length,2,"both inbox panel rectangles required");
      for(const panel of panels)assert.ok(panel.width===0 && panel.containerWidth<=960 ||
        panel.x>=-1 && panel.right<=panel.viewport+1 && panel.width>200,JSON.stringify(panel));
      await browser.screenshot(`${role}-Inbox-${width}-light`);
      await browser.evaluate("document.documentElement.classList.add('dark')");await browser.screenshot(`${role}-Inbox-${width}-dark`);
      await browser.evaluate("document.documentElement.classList.remove('dark')");
      receipts.push({role,width,panels,mode:"compiled light/dark",selected:true,longUnbrokenBody:true});
    }
    if(role==="agent"){
      await browser.call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
      for(const mobile of ["/mobile","/mobile/contacts",`/mobile/contacts/${contactId}`,
        "/mobile/pipeline","/mobile/tasks","/mobile/inbox"]){
        await browser.navigate(mobile);await wait();await wait();
        await browser.screenshot(`agent-${mobile.replaceAll("/","-")}-phone`);
        const measured=await browser.evaluate("({width:innerWidth,bodyWidth:document.documentElement.scrollWidth,text:document.body.innerText.slice(0,240)})");
        assert.ok(measured.bodyWidth<=measured.width+1,JSON.stringify(measured));
        receipts.push({role,mobile,measured,qualification:"Dedicated phone read/layout only; queued work and all actions not certified"});
      }
       // Dedicated phone actions use the same registered A/B work handlers and
       // real actor/CSRF. Contradictory legacy values prove effective authority.
       const mobilePrefix=`C2 phone ${randomUUID()}`;
       const mobileRows=new Map<string,number>();
       for(const [state,legacy] of [["open","completed"],["completed","pending"],["cancelled","pending"]]){
         const row=(await h.pool.query(`INSERT INTO tasks(title,status,authority_state,contact_id,assigned_to,canonical_assignee,due_date)
           VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING id`,
           [`${mobilePrefix} ${state}`,legacy,state,contactId,h.email("agent"),new Date(Date.now()-60000)])).rows[0];
         mobileRows.set(state,row.id);
       }
       await browser.navigate("/mobile/tasks");await browser.waitFor(/Loaded counts, not a paged total/);
       assert.equal(await browser.evaluate("location.pathname"),"/mobile/tasks");
       await browser.click('[data-testid="filter-all"]');await wait();
       assert.ok((await browser.text()).includes(`${mobilePrefix} open`));
       assert.ok(!(await browser.text()).includes(`${mobilePrefix} cancelled`));
       assert.ok(!(await browser.text()).includes(`${mobilePrefix} completed`));
       await browser.click('[data-testid="filter-cancelled"]');await wait();
       assert.ok((await browser.text()).includes(`${mobilePrefix} cancelled`));
       assert.equal(await browser.evaluate(`document.querySelector('[data-testid="button-complete-${mobileRows.get("cancelled")}"]').disabled`),true);
       await browser.click('[data-testid="filter-completed"]');await wait();
       assert.ok((await browser.text()).includes(`${mobilePrefix} completed`));
       await browser.navigate("/mobile");await browser.waitFor(new RegExp(mobilePrefix));
       assert.ok((await browser.text()).includes(`${mobilePrefix} open`));
       assert.ok(!(await browser.text()).includes(`${mobilePrefix} cancelled`));
       assert.ok(!(await browser.text()).includes(`${mobilePrefix} completed`));
       await browser.waitFor(/Native GHL appointments are not configured/);
       receipts.push({role,viewport:"390x844 dedicated mobile",control:"Effective open/completed/cancelled phone Tasks and Home; native not-configured is separate from local events",
         outcome:"passed",fixtureIds:Object.fromEntries(mobileRows),providerEffects:0});
       await browser.call("Network.setBypassServiceWorker",{bypass:true});
       browser.failRead("/api/tasks");
       const failedReadsBefore=browser.readFaults.length;
       await browser.navigate("/mobile/tasks");await browser.waitFor(/Tasks could not be loaded/);
       assert.ok(browser.readFaults.length>failedReadsBefore,"Actual unavailable read must execute");
       assert.ok(!(await browser.text()).includes("No tasks due today"));
       await browser.navigate("/mobile");await browser.waitFor(/Tasks could not be loaded/);
       assert.ok(!(await browser.text()).includes("All caught up!"));
       assert.ok(!(await browser.text()).includes("No due work returned"));
       receipts.push({role,control:"Phone Work read failure is unavailable, not empty or Great job",outcome:"passed",
         qualification:"Page-level transport failure with service worker bypassed; not worker acceptance"});
       browser.failRead(null);
       await browser.call("Network.setBypassServiceWorker",{bypass:false});
       await browser.navigate("/mobile/tasks");await browser.waitFor(/Loaded counts, not a paged total/);
       const mobileTaskTitle=`${mobilePrefix} created`;
        const phoneHeader=await browser.evaluate(`(()=>{
          const add=document.querySelector('[data-testid="button-add-task"]'),
            avatar=document.querySelector('[data-testid="button-avatar-overlay"]');
          const a=add.getBoundingClientRect(),p=avatar.getBoundingClientRect();
          const hit=e=>{const r=e.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
            return target===e || e.contains(target);};
          return {add:{x:a.x,y:a.y,width:a.width,height:a.height},profile:{x:p.x,y:p.y,width:p.width,height:p.height},
            overlap:a.left<p.right && p.left<a.right && a.top<p.bottom && p.top<a.bottom,
            addReachable:hit(add),profileReachable:hit(avatar)};
        })()`);
        assert.equal(phoneHeader.overlap,false,"Profile must not cover the phone header's creation action");
        assert.ok(phoneHeader.addReachable && phoneHeader.profileReachable,JSON.stringify(phoneHeader));
        assert.ok(phoneHeader.add.width>=44 && phoneHeader.profile.width>=44);
        receipts.push({role,control:"Dedicated phone Task creation and profile separate reachable 44px header slots",
          viewport:"390x844",phoneHeader,outcome:"passed; profile destination action remains separate"});
       await browser.click('[data-testid="button-add-task"]');await wait();
        assert.equal(await browser.evaluate(`(()=>{
          const avatar=document.querySelector('[data-testid="button-avatar-overlay"]'),r=avatar.getBoundingClientRect();
          const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return hit===avatar || avatar.contains(hit);
        })()`),false,"Profile must stay below the task modal's backdrop");
       assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"button-create-task\"]').disabled"),true);
       await browser.set('[data-testid="input-task-title"]',mobileTaskTitle);
       await browser.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
       await wait();
       assert.equal(await browser.evaluate("!!document.querySelector('[data-testid=\"mobile-task-editor\"]')"),false);
       assert.equal(await browser.evaluate("document.activeElement?.getAttribute('data-testid')"),"button-add-task");
       assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[mobileTaskTitle])).rows[0].n,0);
       await browser.click('[data-testid="button-add-task"]');await wait();
       await browser.set('[data-testid="input-task-title"]',mobileTaskTitle);
       const phoneFaultBefore=h.responseLossCount();
       h.loseNextSuccessfulResponse("POST","/api/tasks","truncate");
       await browser.click('[data-testid="button-create-task"]');await browser.waitFor(/Task queued for sync/);
       assert.equal(h.responseLossCount(),phoneFaultBefore+1);
       assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[mobileTaskTitle])).rows[0].n,1);
        await waitForDom(`!document.querySelector('[data-testid="mobile-task-editor"]') &&
          getComputedStyle(document.body).pointerEvents!=="none"`);
        if(await browser.evaluate("!!document.querySelector('[toast-close]')")){
          assert.ok(await browser.evaluate(`(()=>{
            const close=document.querySelector('[toast-close]'),r=close.getBoundingClientRect();
            return !!close.closest('.crm-portal') && r.width>=44 && r.height>=44;
          })()`),"Phone notifications adopt the employee portal and a 44px dismiss target");
          await browser.evaluate("document.querySelector('[toast-close]').focus()");
          await keyboardKey("Enter","Enter",13);
          await waitForDom("!document.querySelector('[toast-close]')");
        }
       await browser.click('[data-testid="button-retry-offline-work"]');await wait();
       await waitForDom("!document.querySelector('[data-testid=\"button-retry-offline-work\"]')");
       assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[mobileTaskTitle])).rows[0].n,1);
       await browser.click('[data-testid="filter-all"]');await browser.waitFor(new RegExp(mobileTaskTitle));
       await browser.click('[data-testid="button-add-task"]');await wait();
       await browser.set('[data-testid="input-task-title"]',mobileTaskTitle);
       await browser.click('[data-testid="button-create-task"]');await browser.waitFor(/Task created/);
       assert.equal((await h.pool.query("SELECT count(*)::int n FROM tasks WHERE title=$1",[mobileTaskTitle])).rows[0].n,2,
         "Acknowledged replay ends the old intent; a new identical phone task gets a new UUID");
       await browser.call("Page.reload");await browser.waitFor(/Loaded counts, not a paged total/);
       await browser.click('[data-testid="filter-all"]');await browser.waitFor(new RegExp(mobileTaskTitle));
       const phoneOpenId=mobileRows.get("open");
       await browser.click(`[data-testid="button-complete-${phoneOpenId}"]`);await browser.waitFor(/Task completed/);
       assert.equal((await h.pool.query("SELECT authority_state FROM tasks WHERE id=$1",[phoneOpenId])).rows[0].authority_state,"completed");
       await browser.call("Page.reload");await browser.waitFor(/Loaded counts, not a paged total/);
       await browser.click('[data-testid="filter-completed"]');await browser.waitFor(new RegExp(`${mobilePrefix} open`));
       receipts.push({role,viewport:"390x844 dedicated mobile",control:"Phone task validation / Escape zero writes / focus return / actual truncated create / queued not durable / real retry / one persisted intent / reload / durable complete",
         outcome:"passed",providerEffects:0,createRowsAfterReplay:1,createRowsAfterNewExplicitIntent:2});
       await browser.navigate("/mobile/inbox?channel=email");await browser.waitFor(/Inbox/);await wait();
       await waitForDom("document.querySelectorAll('[data-testid^=\"inbox-item-\"]').length>0");
       await browser.click('[data-testid^="inbox-item-"]');await wait();
       await waitForDom("!!document.querySelector('[data-testid=\"input-inbox-reply\"]')");
        const selectedPhoneUrl=await browser.evaluate("location.pathname+location.search");
        const selectedPhoneState=new URL(selectedPhoneUrl,"https://fixture.invalid").searchParams;
        assert.equal(selectedPhoneState.get("channel"),"email");
        assert.ok(selectedPhoneState.get("thread"),"Mobile source selection must use the common URL codec");
       const phoneDraft=`C2 phone unsent ${randomUUID()}`;
       await browser.set('[data-testid="input-inbox-reply"]',phoneDraft);
       await waitForDom("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Save draft')&&!b.disabled)");
       const phoneSave=await browser.evaluate("(()=>{const e=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Save draft'));e.setAttribute('data-c2-test','phone-save-draft');return !!e})()");
       assert.ok(phoneSave);
       const phoneDraftFault=h.responseLossCount();
       h.loseNextSuccessfulResponse("PUT","/api/message-drafts","truncate");
       await browser.click('[data-c2-test="phone-save-draft"]');await browser.waitFor(/Draft issue/);
       assert.equal(h.responseLossCount(),phoneDraftFault+1);
       const phoneRetry=await browser.evaluate("(()=>{const e=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Retry draft save'));if(!e)return false;e.setAttribute('data-c2-test','phone-retry-draft');return true})()");
       assert.ok(phoneRetry);
       await browser.click('[data-c2-test="phone-retry-draft"]');await browser.waitFor(/Draft saved/);
       const savedPhoneDraft=(await h.pool.query("SELECT id,version,channel FROM rep_message_drafts WHERE actor_id=$1 AND body=$2",[h.userId("agent"),phoneDraft])).rows;
       assert.equal(savedPhoneDraft.length,1);assert.equal(savedPhoneDraft[0].channel,"email");
       assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"button-send-reply\"]').disabled"),true);
       const phoneOutboundBefore=h.externalCalls();
        await browser.evaluate("document.querySelector('[data-testid=\"input-inbox-reply\"]').focus()");
        assert.equal(await browser.evaluate("document.activeElement?.getAttribute('data-testid')"),"input-inbox-reply");
       await browser.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
       await wait();assert.equal(h.externalCalls(),phoneOutboundBefore);
       await browser.call("Page.reload");await browser.waitFor(/Draft saved/);
       assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"input-inbox-reply\"]').value"),phoneDraft);
       assert.equal(await browser.evaluate("location.pathname+location.search"),selectedPhoneUrl);
       await browser.click('[data-testid="button-back-inbox"]');
       await waitForDom("!document.querySelector('[data-testid=\"input-inbox-reply\"]')");
       assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('thread')"),null);
       assert.equal(await browser.evaluate("new URLSearchParams(location.search).get('channel')"),"email");
       await browser.evaluate("history.back()");await browser.waitFor(/Draft saved/);
       assert.equal(await browser.evaluate("document.querySelector('[data-testid=\"input-inbox-reply\"]').value"),phoneDraft);
       await browser.evaluate("history.forward()");
       await waitForDom("!document.querySelector('[data-testid=\"input-inbox-reply\"]')");
       const forbiddenDraftStart=browser.requests.length;
       await browser.navigate(`/mobile/inbox?channel=email&thread=${encodeURIComponent("missing::"+randomUUID())}`);
       await browser.waitFor(/selected source may be missing/);
       assert.equal(await browser.evaluate("!!document.querySelector('[data-testid=\"input-inbox-reply\"]')"),false);
       assert.equal(browser.requests.slice(forbiddenDraftStart).filter(request=>request.url.includes("/api/message-drafts")).length,0,
         "An unavailable exact message must not mount a draft reader");
       const invalidSelectionStart=browser.requests.length;
       await browser.navigate("/mobile/inbox?channel=email&thread=one&thread=two");
       await browser.waitFor(/Invalid thread selection/);
       assert.equal(browser.requests.slice(invalidSelectionStart).filter(request=>
         ["/api/inbox/items/one", "/api/inbox/items/two", "/api/message-drafts"].some(path => request.url.includes(path))).length,0,
         "Conflicting source identities must be rejected before protected child reads");
       receipts.push({role,viewport:"390x844 dedicated mobile",control:"Native Inbox channel-bound real draft / actual truncated confirmation / same-command retry / reload / paused Enter and button",
         outcome:"passed",draftId:savedPhoneDraft[0].id,version:savedPhoneDraft[0].version,channel:"email",providerEffects:0,
         navigation:"Exact source selected through common codec; reload/Back/Forward; unavailable and conflicting targets mount no draft"});
       await checkpoint("agent: dedicated phone task and source-bound Inbox actions complete");
    }
   assert.equal(browser.exceptions.length,0,JSON.stringify(browser.exceptions));
    if(role==="admin"){
      for(const [page,predicate] of [
        ["/dashboard/contacts","document.querySelectorAll('.crm-data-table tbody tr').length>=25 && document.body.innerText.includes('Person')"],
        ["/dashboard/pipeline",`(()=>{const fixtureIds=${JSON.stringify([dealId,legacyDealId,...keyboardDeals.values()])};
          return fixtureIds.some(id=>{const e=document.querySelector('[data-testid="card-deal-'+id+'"]');
            if(!e||!e.textContent.includes('C2 Person'))return false;const r=e.getBoundingClientRect();
            return r.width>0&&r.x>=0&&r.x<innerWidth&&r.y>=0&&r.y<innerHeight});})()`],
        ["/dashboard/tasks-appointments","document.querySelectorAll('[data-testid^=\"row-task-\"]').length>=1"],
        ["/dashboard/comms-hub?channel=email","document.querySelectorAll('[data-testid^=\"inbox-item-\"]').length>=17"],
      ]){
        const started=performance.now(),requestStart=browser.requests.length;
        await browser.navigate(page);await waitForDom(predicate);
        const usefulMs=performance.now()-started;
        receipts.push({role,page,control:"Useful declared-volume list timing",usefulMs,
           criterion:predicate,requests:browser.requests.slice(requestStart),outcome:usefulMs<=2500?"passed":"defect",
           qualification:"Real compiled handler/read path; private loopback, browser HTTP cache disabled; not WAN or full-production-volume evidence"});
         if(usefulMs>2500)visualFailures.push({category:"performance",page,usefulMs,limitMs:2500,
           reason:"Useful list exceeds required 2500ms; retained failure, not a waiver"});
      }
      const input="[data-testid=\"input-search-inbox\"]";
       let searchStarted=0;
       await browser.set(input,"not-a-loaded-message-c2-performance",()=>{searchStarted=performance.now();});
       assert.ok(searchStarted>0,"Timing starts at the real text input, after focus and selection");
      await waitForDom("document.querySelectorAll('[data-testid^=\"inbox-item-\"]').length===0 && document.body.innerText.includes('No loaded messages match')");
      const inputMs=performance.now()-searchStarted;
       receipts.push({role,control:"Loaded-message input to rendered result",inputMs,loadedMessages:23,outcome:inputMs<=200?"passed":"defect",
        qualification:"Real keyboard input/render; local loaded-message search, not all-source search"});
       if(inputMs>200)visualFailures.push({category:"performance",control:"loaded-message input",inputMs,limitMs:200,
         reason:"Local loaded-message input exceeds required 200ms; retained failure, not a waiver"});
    }
    await browser.close();browser=undefined;
  }
  for(const role of ["anonymous","merchant","partner","affiliate"]){
    await checkpoint(`${role}: access-denial phase starting`);
    browser=await openC2Browser({realInput:true});
    if(role!=="anonymous"){
      await browser.navigate("/login");await browser.waitFor(/Sign In/);
      await browser.set('[data-testid="input-email"]',h.email(role));
      await browser.set('[data-testid="input-password"]',h.password);
      await browser.click('[data-testid="button-login"]');await wait();await wait();
    }
    const requestStart=browser.requests.length;
    await browser.navigate(`/dashboard/contacts/${contactId}?area=conversations&section=notes`);
    await wait();await wait();
    assert.equal(await browser.evaluate("!!document.querySelector('[data-testid=\"text-contact-name\"]')"),false);
    const recordRequests=browser.requests.slice(requestStart).filter(request=>
      new URL(request.url,h.base).pathname.startsWith(`/api/contacts/${contactId}`));
    assert.equal(recordRequests.length,0,`${role} must be stopped before the protected Contact child mounts`);
    receipts.push({role,control:"Contact wrapper denies before exact-record/child reads",
      recordId:contactId,registeredRecordRequests:0,outcome:"passed"});
    await browser.close();browser=undefined;
  }
  browser=await openC2Browser({realInput:true,zoom:2,startupTimeoutMs:30000});
  await checkpoint("actual browser zoom phase starting");
  await browser.navigate("/login");await browser.waitFor(/Sign In/);
  await browser.set('[data-testid="input-email"]',h.email("admin"));
  await browser.set('[data-testid="input-password"]',h.password);
  await browser.click('[data-testid="button-login"]');await browser.waitFor(/Dashboard|Today/);
  await browser.evaluate("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");
  for(const page of ["/dashboard","/dashboard/contacts",`/dashboard/contacts/${contactId}?section=notes`,
    "/dashboard/pipeline","/dashboard/comms-hub?channel=email","/dashboard/tasks-appointments"]){
    await browser.navigate(page);await wait();await wait();
    if(page.includes("comms-hub")){await browser.click('[data-testid^="inbox-item-"]');await wait();}
    const measured=await browser.evaluate(`({cssWidth:innerWidth,pixelRatio:devicePixelRatio,
      overflow:document.documentElement.scrollWidth>innerWidth+1,
      panels:[...document.querySelectorAll('[data-testid="card-item-list"],[data-testid="card-thread-panel"]')].map(e=>{
        const r=e.getBoundingClientRect();return {width:r.width,x:r.x,right:r.right};})})`);
    assert.equal(measured.pixelRatio,2,"actual persisted Chromium browser zoom, not viewport emulation");
    assert.equal(measured.overflow,false,JSON.stringify(measured));
    for(const panel of measured.panels)assert.ok(panel.width===0 || panel.width>200&&panel.right<=measured.cssWidth+1,JSON.stringify(measured));
    await browser.screenshot(`admin-actual-200-${page.split("?")[0].replaceAll("/","-")}`);
    receipts.push({role:"admin",page,measured,qualification:"Actual 200% browser zoom; not all controls/overlay/contrast acceptance"});
  }
  assert.equal(browser.exceptions.length,0,JSON.stringify(browser.exceptions));
  await browser.close();browser=undefined;
  assert.equal(h.externalCalls(),0);
   assert.equal((await verifyCandidateIdentity()).inputHash,identity.inputHash,"Candidate inputs/output must still match at terminal evidence capture");
  assert.deepEqual(visualFailures,[],"Compiled visual/performance defects remain; collected observations are not acceptance");
  await fs.writeFile("docs/certification/stage3-c2/browser-receipts.json",JSON.stringify({identity,receipts,
     responseFaultsExecuted:h.responseLossCount(),externalEffects:h.externalCalls(),
    environment:{runtime:process.version,seedContacts:601,seedSalesDeals:5,inboxMessages:23,missingNameContacts:1,browser:"environment Chromium wrapper",network:"private loopback; providers denied",
      hardware:{cpu:cpus()[0]?.model,availableParallelism:availableParallelism()},performanceQualification:"Separate bounded admin list/input timings; layout timings and other workspaces are not performance acceptance"},
    status:"bounded protected UI evidence; no blanket G01–G12/native/release acceptance"},null,2)+"\n");
  console.log(`C2 protected compiled browser: PASS (${receipts.length} bounded receipts)`);
}catch(error){
  if(browser){await browser.screenshot("failure");await fs.writeFile(`${directory}/failure.txt`,await browser.text());}
  await fs.writeFile(`${directory}/failure-receipt.json`,JSON.stringify({identity,status:"failed; no acceptance",
    error:error instanceof Error?error.message:"Unknown failure",boundedReceipts:receipts,
    executedReadFaults:browser?.readFaults,
     responseFaultEvents:h.responseFaultEvents,
    recentRequestPaths:browser?.requests.slice(-35).map(request=>({path:new URL(request.url,h.base).pathname,status:request.status})),
    responseFaultsExecuted:h.responseLossCount(),externalEffects:h.externalCalls()},null,2)+"\n");
  throw error;
}finally{await browser?.close();await h.close();}
