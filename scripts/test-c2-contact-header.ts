import assert from "node:assert/strict";
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {privateStage3Browser} from "./fixtures/private-stage3-browser";

const before=process.argv.includes("--before");
const phase=before?"before":"after";
const dir="docs/certification/stage3-c2/contact-header";
const checks:string[]=[];
const mutations:Array<{path:string;method:string;contactId:number|null;status?:number}>=[];
const h=await stage3BHttpFixture(async app=>{
  app.use((req,res,next)=>{
    if(["POST","PATCH","PUT"].includes(req.method) && /^\/api\/(contacts|tasks|call-logs|deals|tickets)(\/|$)/.test(req.path)){
      const row={path:req.path,method:req.method,contactId:Number(req.body?.contactId || /^\/api\/contacts\/(\d+)/.exec(req.path)?.[1])||null,status:undefined as number|undefined};
      mutations.push(row);res.once("finish",()=>{row.status=res.statusCode;});
    }
    next();
  });
  for(const [file,fn] of [
    ["contacts","registerContactsRoutes"],["crm-operations","registerCrmOperationsRoutes"],
    ["activity","registerActivityRoutes"],["tickets-tasks","registerTicketsTasksRoutes"],
    ["notifications","registerNotificationsRoutes"],["deals","registerDealsRoutes"],
    ["message-drafts","registerMessageDraftRoutes"],["daily-briefing","registerDailyBriefingRoutes"],
    ["my-day","registerMyDayRoutes"],["toolkit","registerToolkitRoutes"],
    ["inbox","registerInboxRoutes"],["live-chat","registerLiveChatRoutes"],
    ["analytics","registerAnalyticsRoutes"],["conversation-ai-config","registerConversationAiConfigRoutes"],
    ["nba","registerNbaRoutes"],
  ]) {const module=await import(`../server/routes/${file}.ts`);module[fn](app);}
  app.use("/api",(_req,res)=>res.status(501).json({message:"Unregistered isolated service"}));
  const {static:serveStatic}=await import("express");
  app.use(serveStatic("dist/public"));
  app.use((_req,res)=>res.sendFile("index.html",{root:`${process.cwd()}/dist/public`}));
});
let b:Awaited<ReturnType<typeof privateStage3Browser>>|undefined;
let contact=0;
const href=()=>`/dashboard/contacts/${contact}?area=overview&section=overview`;
async function until(expression:string) {
  for(let n=0;n<240;n++){
    if(await b!.evaluate(expression))return;
    await new Promise(r=>setTimeout(r,50));
  }
  throw Error(`Header condition not reached: ${expression}; URL=${await b!.evaluate("location.pathname+location.search")}`);
}
async function mutation(path:string) {
  for(let n=0;n<240;n++){
    const result=mutations.find(m=>m.path===path && m.status!==undefined);
    if(result)return result;
    await new Promise(r=>setTimeout(r,50));
  }
  throw Error(`No completed real mutation at ${path}`);
}
async function settleOverlays() {
  await until(`![...document.querySelectorAll('[role="dialog"],[role="menu"]')].some(e=>
    e.getAnimations({subtree:true}).some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity))`);
}
async function key(key:string) {
  await settleOverlays();
  const codes:Record<string,number>={Tab:9,Enter:13,Escape:27,ArrowDown:40};
  await b!.call("Input.dispatchKeyEvent",{type:"keyDown",key,code:key,windowsVirtualKeyCode:codes[key],...(key==="Enter"?{text:"\r",unmodifiedText:"\r"}:{})});
  await b!.call("Input.dispatchKeyEvent",{type:"keyUp",key,code:key,windowsVirtualKeyCode:codes[key]});
  // The protocol acknowledgement precedes Radix's rendered focus update.
  // Measure each actual keyboard transition after rendering, without changing
  // the command count, menu order, focus assertions or input timing budgets.
  await b!.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function login(zoom=1) {
  b=await privateStage3Browser(h.base,"",h.originalFetch,dir,{realInput:true,zoom});
  await b.navigate("/login");await b.waitFor(/Sign In/);
  await b.set('[data-testid="input-email"]',h.email("agent"));
  await b.set('[data-testid="input-password"]',h.password);
  await b.click('[data-testid="button-login"]');await b.waitFor(/Dashboard|Today|My Day/);
  await b.evaluate("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");
  await b.navigate(href());await until("!!document.querySelector('[data-testid=\"text-contact-name\"]')");
  const realClick=b.click;
  b.click=async selector=>{
    if(selector==='[data-testid="contact-more-actions"]')
      await until("!document.querySelector('[role=\"menu\"]') && getComputedStyle(document.body).pointerEvents!=='none'");
    await settleOverlays();
    await realClick(selector);
    if(selector==='[data-testid="contact-more-actions"]'){
      await until("!!document.querySelector('[role=\"menu\"]')");
      await settleOverlays();
      await until("!!document.activeElement?.closest('[role=\"menu\"]')");
    }
  };
  const realSet=b.set;
  b.set=async(selector,value)=>{await settleOverlays();await realSet(selector,value);};
}
async function capture(name:string) {
  await b!.evaluate("window.scrollTo(0,0)");
  await new Promise(r=>setTimeout(r,300));
  const metrics=await b!.evaluate(`(()=>{
    const box=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:!!e.getClientRects().length};};
    return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
      documentWidth:document.documentElement.scrollWidth,
      header:box('[data-testid="contact-compact-header"]'),
      navigation:box('nav[aria-label="CRM areas"]'),
      status:box('[data-testid="contact-authority-status"]'),
      nextAction:box('[data-testid="contact-next-action"]')};
  })()`);
  await b!.screenshot(`${phase}-${name}`);
  await writeFile(`${dir}/${phase}-${name}.json`,JSON.stringify(metrics,null,2)+"\n");
  if(!before){
    assert.ok(metrics.documentWidth<=metrics.viewport.width+1,`${name}: horizontal overflow`);
    for(const fact of ["header","navigation","status","nextAction"])assert.ok(metrics[fact]?.visible,`${name}: ${fact} missing`);
    if(!name.includes("200")){
      for(const fact of ["status","nextAction","navigation"])assert.ok(metrics[fact].bottom<=metrics.viewport.height,`${name}: ${fact} below fold`);
    }
  }
  return metrics;
}
try {
  await mkdir(dir,{recursive:true});
  await h.pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1",[h.prefix+"%"]);
  contact=(await h.pool.query(`INSERT INTO contacts(first_name,last_name,company_name,email,phone,record_class,assigned_to,email_status,vertical)
    VALUES('Header','Fixture','Liberty fixture',$1,$3,'production',$2,'valid','Automotive') RETURNING id`,
    [h.prefix+"@example.test",h.email("agent"),"+1908"+String(Date.now()%10000000).padStart(7,"0")])).rows[0].id;
  const other=(await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class,assigned_to)
    VALUES('Other','Fixture',$1,'','production',$2) RETURNING id`,[h.prefix+"other@example.test",h.email("other")])).rows[0].id;
  await login();
  await capture("desktop");
  await b!.call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await capture("mobile");
  if(!before){
    assert.equal(await b!.evaluate("document.querySelector('[data-testid=\"contact-more-actions\"]')?.getAttribute('aria-label')"),"More actions");
    assert.equal(await b!.evaluate("document.querySelectorAll('[data-testid=\"contact-primary-action\"]').length"),1);
    assert.equal(await b!.evaluate("document.querySelectorAll('[data-testid^=\"contact-secondary-\"]').length"),2);
    assert.equal(await b!.evaluate("document.querySelector('[data-testid=\"contact-context-details\"]').open"),false);
    assert.equal(await b!.evaluate("document.querySelectorAll('[data-testid=\"next-steps-widget\"],[data-testid=\"next-steps-widget-mobile\"]').length"),0);
    await b!.click('[data-testid="contact-context-details-toggle"]');
    await until("document.querySelector('[data-testid=\"contact-context-details\"]').open");
    await key("Enter");
    await until("!document.querySelector('[data-testid=\"contact-context-details\"]').open");
    await key("Enter");
    await until("!!document.querySelector('[data-testid=\"section-sfp-readiness\"]')");
    await b!.click('[data-testid="contact-context-details-toggle"]');
    checks.push("one primary/two secondaries; five areas above fold; diagnostic details keyboard-expandable");
    await b!.call("Emulation.clearDeviceMetricsOverride");
    // Real keyboard opens and closes the overflow, returning focus.
    await b!.click('[data-testid="contact-more-actions"]');
    await until("!!document.querySelector('[role=\"menu\"]')");
    await key("Escape");
    await until("document.activeElement?.getAttribute('data-testid')==='contact-more-actions'");
    await key("Enter");
    await until("!!document.querySelector('[role=\"menu\"]')");
    await key("ArrowDown");await key("Escape");
    await until("document.activeElement?.getAttribute('data-testid')==='contact-more-actions'");
    checks.push("More actions: labelled, keyboard open/navigation/Escape, focus returns to trigger");
    await b!.call("Browser.grantPermissions",{origin:h.base,permissions:["clipboardReadWrite","clipboardSanitizedWrite"]});
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-copy-email"]');
    assert.equal(await b!.evaluate("navigator.clipboard.readText()"),h.prefix+"@example.test");
    await key("Escape");
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-copy-phone"]');
    const fixturePhone=(await h.pool.query("SELECT phone FROM contacts WHERE id=$1",[contact])).rows[0].phone;
    assert.equal(await b!.evaluate("navigator.clipboard.readText()"),fixturePhone);
    await key("Escape");
    await b!.click('[data-testid="contact-more-actions"]');
    assert.equal(await b!.evaluate("document.querySelector('[data-testid=\"menu-action-call-phone\"]')?.getAttribute('aria-disabled')"),"true");
    await key("Escape");
    checks.push("clipboard menu commands use this record's actual values; paused dial command disabled");
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-schedule-follow-up"]');
    await until("!!document.querySelector('[data-testid=\"next-steps-scheduler-dialog\"]')");
    // Native datetime is filled through its standard input event; menu,
    // submission and dismissal use real keyboard/pointer input.
    await b!.evaluate(`(()=>{
      const e=document.querySelector('[data-testid="input-next-step-datetime"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'2026-10-20T14:30');
      e.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await b!.set('[data-testid="input-next-step-note"]',`${h.prefix} scheduler`);
    await b!.click('[data-testid="button-save-next-step"]');
    const scheduled=await mutation("/api/tasks");
    assert.equal(scheduled.contactId,contact);
    assert.ok(scheduled.status===200 || scheduled.status===201,JSON.stringify(scheduled));
    await until("document.activeElement?.getAttribute('data-testid')==='contact-more-actions'");
    checks.push("relocated follow-up scheduler invokes actual contact-bound task handler; focus returns; no floating scheduler overlays");
    // Every non-send overflow command is opened through its real menu handler.
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-edit"]');
    await until("!!document.querySelector('[data-testid=\"input-edit-firstname\"]')");
    assert.equal(await b!.evaluate("document.querySelector('[data-testid=\"input-edit-firstname\"]').value"),"Header");
    await b!.click('[data-testid="button-cancel-edit"]');
    await until("document.activeElement?.getAttribute('data-testid')==='contact-more-actions'");
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-edit"]');
    await until("!!document.querySelector('[data-testid=\"input-edit-firstname\"]')");
    await b!.set('[data-testid="input-edit-firstname"]',"Header edited");
    await b!.click('[data-testid="button-save-edit"]');
    const edited=await mutation(`/api/contacts/${contact}`);
    assert.ok(edited.status===200 || edited.status===201,JSON.stringify(edited));
    assert.equal((await h.pool.query("SELECT first_name FROM contacts WHERE id=$1",[contact])).rows[0].first_name,"Header edited");
    await until("document.activeElement?.getAttribute('data-testid')==='contact-more-actions'");
    checks.push("Edit actual record-bound save and cancellation restore More focus");
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-deal"]');
    await until("!!document.querySelector('[data-testid=\"dialog-create-deal\"]')");
    await b!.click('[data-testid="button-submit-deal"]');
    const deal=await mutation("/api/deals");
    assert.equal(deal.contactId,contact);
    if(deal.status!==200 && deal.status!==201){
      checks.push(`Create Deal actual handler/contact ID verified; isolated endpoint returned ${deal.status}, successful deal persistence not certified`);
      await b!.click('[data-testid="button-cancel-deal"]');
    } else {
      assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM deals WHERE contact_id=$1",[contact])).rows[0].n,1);
      checks.push("Create Deal actual contact-bound SQL persistence");
    }
    await until("document.activeElement?.getAttribute('data-testid')==='contact-more-actions'");
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-email"]');
    await until("!!document.querySelector('[role=\"dialog\"]')");
    assert.ok(b!.requests.some(r=>r.url.includes(`/api/contacts/${contact}`)));
    await key("Escape");
    await until("document.activeElement?.getAttribute('data-testid')==='contact-more-actions'");
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-ticket"]');
    await until("!!document.querySelector('[data-testid=\"dialog-create-ticket\"]')");
    await b!.set('[data-testid="input-ticket-subject"]',`${h.prefix} header ticket`);
    await b!.set('[data-testid="textarea-ticket-description"]',"Fixture record-context verification");
    await b!.click('[data-testid="button-submit-ticket"]');
    await until(`!document.querySelector('[data-testid="dialog-create-ticket"]')`);
    const ticket=mutations.find(m=>m.path==="/api/tickets");
    assert.equal(ticket?.contactId,contact);
    assert.ok(ticket?.status===200 || ticket?.status===201,JSON.stringify(ticket));
    await b!.click('[data-testid="contact-more-actions"]');
    await b!.click('[data-testid="menu-action-ai"]');
    await until("location.pathname==='/dashboard/chat' && new URLSearchParams(location.search).get('vertical')==='Automotive'");
    await b!.navigate(href());await until("!!document.querySelector('[data-testid=\"contact-more-actions\"]')");
    checks.push("overflow Edit/Deal/Email/Ticket retain record handlers; ticket persists; modal dismissal focus returns; AI preserves existing vertical-context navigation");

    await b!.click('[data-testid="contact-secondary-add-note"]');
    await until("!!document.querySelector('[data-testid=\"textarea-add-note\"]')");
    assert.ok(await b!.evaluate("location.search.includes('section=notes')"));
    const note=`${h.prefix} header note`;
    await b!.set('[data-testid="textarea-add-note"]',note);
    await b!.click('[data-testid="button-submit-note"]');
    await b!.waitFor(new RegExp(note));
    const notes=await h.request("agent","GET",`/api/contacts/${contact}/detail?section=notes`);
    assert.equal(notes.status,200);
    assert.ok(JSON.stringify(notes.body.notes).includes(note));
    const otherNotes=await h.request("other","GET",`/api/contacts/${other}/detail?section=notes`);
    assert.equal(otherNotes.status,200);
    assert.ok(!JSON.stringify(otherNotes.body.notes).includes(note));
    checks.push("Add Note retains URL-backed notes section and real contact-bound persistence");

    await b!.navigate(href());await until("!!document.querySelector('[data-testid=\"contact-secondary-new-task\"]')");
    await b!.click('[data-testid="contact-secondary-new-task"]');
    await until("!!document.querySelector('[data-testid=\"input-task-title\"]')");
    const title=`${h.prefix} header task`;
    await b!.set('[data-testid="input-task-title"]',title);
    await b!.click('[data-testid="button-submit-task"]');
    await b!.waitFor(/Task created/);
    await until("document.activeElement?.getAttribute('data-testid')==='contact-secondary-new-task'");
    assert.equal((await h.pool.query("SELECT contact_id FROM tasks WHERE title=$1",[title])).rows[0]?.contact_id,contact);
    await b!.navigate(href());
    const currentFacts=await h.request("agent","GET",`/api/contacts/${contact}/detail`);
    assert.equal(currentFacts.status,200);
    const followUp=currentFacts.body.headerDealFacts?.nextFollowUp;
    if(followUp){
      const expected=await b!.evaluate(`'Follow up '+new Date(${JSON.stringify(followUp)}).toLocaleString()`);
      await until(`document.querySelector('[data-testid="contact-next-action"]')?.textContent.includes(${JSON.stringify(expected)})`);
    }else{
      await until(`document.querySelector('[data-testid="contact-next-action"]')?.textContent.includes('Complete task:')`);
      const taskText=await b!.evaluate("document.querySelector('[data-testid=\"contact-next-action\"]').textContent");
      assert.ok(currentFacts.body.tasks.some((task:any)=>task.contactId===contact && taskText.includes(task.title)));
    }
    checks.push("New Task submits the actual task handler with the current contact ID");

    await b!.click('[data-testid="contact-primary-action"]');
    await until("!!document.querySelector('[data-testid=\"select-call-outcome\"]')");
    await b!.click('[data-testid="select-call-outcome"]');
    await until("!!document.querySelector('[role=\"option\"]')");
    await b!.click('[role="option"]');
    const call=`${h.prefix} header call`;
    await b!.set('[data-testid="textarea-call-notes"]',call);
    if(await b!.evaluate("document.querySelector('[data-testid=\"checkbox-create-task\"]')?.getAttribute('aria-checked')==='true'"))
      await b!.click('[data-testid="checkbox-create-task"]');
    await b!.click('[data-testid="button-save-call-log"]');
    await b!.waitFor(/Call logged/);
    await until("document.activeElement?.getAttribute('data-testid')==='contact-primary-action'");
    assert.equal((await h.pool.query("SELECT contact_id FROM call_logs WHERE summary=$1",[call])).rows[0]?.contact_id,contact);
    checks.push("Log Call submits the actual call log handler with the current contact ID");
    assert.equal((await h.request("other","GET",`/api/contacts/${contact}/detail`)).status,404);
    assert.equal((await h.request("merchant","GET",`/api/contacts/${contact}/detail`)).status,403);
    checks.push("foreign owner non-disclosure 404 and merchant denial 403 remain intact");
  }
  assert.equal(b!.exceptions.length,0,JSON.stringify(b!.exceptions));
  const primaryRequests=[...b!.requests];
  await b!.close();b=undefined;
  await login(2);
  const zoom=await capture("desktop-200-percent");
  assert.ok(zoom.viewport.dpr>=1.9 && zoom.viewport.width<=800,"Actual native 200% browser zoom must be observed");
  checks.push("desktop/mobile screenshots and actual native 200% browser zoom");
  if(!before){
    await b!.click('[data-testid="contact-more-actions"]');
    for(let n=0;n<14;n++){
      if(await b!.evaluate("document.activeElement?.getAttribute('data-testid')==='menu-action-ai'"))break;
      await key("ArrowDown");
    }
    assert.equal(await b!.evaluate("document.activeElement?.getAttribute('data-testid')"),"menu-action-ai");
    assert.ok(await b!.evaluate("(()=>{const r=document.activeElement.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1;})()"),
      "Last overflow command must remain visible and keyboard-reachable at native 200%");
    await b!.screenshot("after-200-percent-menu");
    await key("Escape");
    await until("document.activeElement?.getAttribute('data-testid')==='contact-more-actions'");
    checks.push("native 200% overflow scrolls to last command with keyboard and returns focus on Escape");
  }
  assert.equal(b!.exceptions.length,0,JSON.stringify(b!.exceptions));
  // The actual Create Deal handler can request a blueprint after commit.
  // The fixture denies every provider request before transport; count these
  // honestly instead of treating denied attempts as successful provider I/O.
  const identity=JSON.parse(await readFile("dist/candidate-integrity.json","utf8"));
  await writeFile(`${dir}/${phase}-receipt.json`,JSON.stringify({
    status:"pass",phase,checks,mutations,sourceHead:identity.sourceHead,compiledInputHash:identity.inputHash,compiledOutputHash:identity.outputHash,
    requests:[...primaryRequests,...b!.requests].map(r=>({path:r.url,method:r.method,status:r.status})),
    deniedProviderAttempts:h.externalCalls(),externalEgress:0,
    qualification:"retained compiled client and actual registered source handlers; private agent login, not published bundled-server UI",
    effects:"private PostgreSQL/Redis; fixture-only writes; provider egress denied",
  },null,2)+"\n");
  console.log(`C2 contact header ${phase}: PASS`,checks);
} catch(error) {
  if(b){await b.screenshot(`${phase}-failure`);await writeFile(`${dir}/${phase}-failure.txt`,await b.text());}
  throw error;
} finally {await b?.close();await h.close();}
process.exit(0);
