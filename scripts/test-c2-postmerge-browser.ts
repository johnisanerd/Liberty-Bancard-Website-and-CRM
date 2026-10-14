import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { privateStage3Browser } from "./fixtures/private-stage3-browser";
import { moveCalendarEventToDate } from "../client/src/lib/calendar-date-repair";
import { isPendingTask } from "../client/src/lib/task-source";
import { randomUUID } from "node:crypto";

const directory = "docs/certification/stage3-c2/postmerge-browser";
let repairId = 0, invalidWireTimes = true;
const checks: string[] = [];
const h = await stage3BHttpFixture(async app => {
  // Fault only timestamps on an already-authorized real read. Ownership/content
  // authority and actual writes remain the real registered handler's.
  app.use((req, res, next) => {
    if (req.method === "GET" && req.path === "/api/calendar-events") {
      const json = res.json.bind(res);
      res.json = ((body: any) => json(invalidWireTimes && Array.isArray(body)
        ? body.map(row => row.id === repairId ? { ...row, startTime: "invalid", endTime: "invalid" } : row) : body)) as typeof res.json;
    }
    next();
  });
  for (const [file, fn] of [
    ["contacts", "registerContactsRoutes"], ["crm-operations", "registerCrmOperationsRoutes"],
    ["activity", "registerActivityRoutes"], ["tickets-tasks", "registerTicketsTasksRoutes"],
    ["notifications", "registerNotificationsRoutes"], ["deals", "registerDealsRoutes"],
    ["message-drafts", "registerMessageDraftRoutes"], ["daily-briefing", "registerDailyBriefingRoutes"],
    ["my-day", "registerMyDayRoutes"], ["toolkit", "registerToolkitRoutes"],
    ["inbox", "registerInboxRoutes"], ["live-chat", "registerLiveChatRoutes"],
    ["analytics", "registerAnalyticsRoutes"], ["conversation-ai-config", "registerConversationAiConfigRoutes"],
  ]) {
    const module = await import(`../server/routes/${file}.ts`);
    module[fn](app);
  }
  app.use("/api", (_req, res) => res.status(501).json({ message: "Unregistered isolated service" }));
  const { static: serveStatic } = await import("express");
  app.use(serveStatic("dist/public"));
  app.use((_req, res) => res.sendFile("index.html", { root: `${process.cwd()}/dist/public` }));
});
let browser: Awaited<ReturnType<typeof privateStage3Browser>> | undefined;
async function until(expression: string) {
  for (let n = 0; n < 200; n++) {
    if (await browser!.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  throw new Error(`UI condition not reached: ${expression}`);
}
async function nativeDateOrTime(selector: string, digits: string, expected: string) {
  await browser!.click(selector);
  // Chromium's native segmented inputs ignore Input.insertText. Navigate to
  // the first segment and use actual key events in the fixture's en-US locale.
  for (const key of ["ArrowLeft","ArrowLeft","ArrowLeft",...digits]) {
    await browser!.call("Input.dispatchKeyEvent",{
      type:"keyDown",key,
      ...(key==="ArrowLeft" ? {code:key,windowsVirtualKeyCode:37} : {text:key}),
    });
    await browser!.call("Input.dispatchKeyEvent",{type:"keyUp",key});
  }
  assert.equal(await browser!.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`),expected);
}
try {
  await mkdir(directory, { recursive: true });
  await h.pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1", [h.prefix+"%"]);
  const contact = (await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class,assigned_to)
    VALUES('Repair','Fixture',$1,'','production',$2) RETURNING id`, [h.prefix+"@example.test",h.email("agent")])).rows[0].id;
  const now = new Date(); now.setHours(9,17,23,456);
  const original = { startTime: now.toISOString(), endTime: new Date(now.getTime()+90*60000).toISOString() };
  repairId = (await h.pool.query(`INSERT INTO calendar_events(title,start_time,end_time,owner_id,contact_id)
    VALUES('C2 repair fixture',$1,$2,$3,$4) RETURNING id`,
    [original.startTime,original.endTime,h.userId("agent"),contact])).rows[0].id;
  for (const state of ["open","in_progress","completed","cancelled"]) {
    await h.pool.query(`INSERT INTO tasks(title,contact_id,assigned_to,canonical_assignee,status,authority_state,due_date)
      VALUES($1,$2,$3,$3,$4,$5,NOW())`, [`C2 ${state}`,contact,h.email("agent"),
      state==="open" || state==="in_progress" ? "pending" : state, state]);
  }
  // Ordinary moves use the real handler and PostgreSQL, not an injected store.
  for (const day of ["2026-10-31","2026-11-01","2028-02-29"]) {
    const moved = moveCalendarEventToDate(original,day);
    const result = await h.request("agent","PUT",`/api/calendar-events/${repairId}`,moved);
    assert.equal(result.status,200,JSON.stringify(result.body));
    const row = (await h.pool.query("SELECT start_time,end_time,owner_id,contact_id FROM calendar_events WHERE id=$1",[repairId])).rows[0];
    assert.equal(row.start_time.toISOString(),moved.startTime);
    assert.equal(row.end_time-row.start_time,90*60000);
    assert.equal(row.owner_id,h.userId("agent")); assert.equal(row.contact_id,contact);
  }
  checks.push("ordinary/month-end/leap-day real SQL persistence retains start, duration, owner and contact");
  assert.equal((await h.request("other","PUT",`/api/calendar-events/${repairId}`,original)).status,403);
  assert.equal((await h.request("merchant","PUT",`/api/calendar-events/${repairId}`,original)).status,403);
  assert.equal((await h.request("agent","PUT",`/api/calendar-events/${repairId}`,{startTime:original.startTime,endTime:original.startTime})).status,400);
  checks.push("foreign owner/merchant denial and nonpositive backend rejection");
  await h.pool.query("UPDATE calendar_events SET start_time=$1,end_time=$2 WHERE id=$3",
    [original.startTime,original.endTime,repairId]);
  browser = await privateStage3Browser(h.base,"",h.originalFetch,directory,{realInput:true});
  await browser.navigate("/login"); await browser.waitFor(/Sign In/);
  await browser.set('[data-testid="input-email"]',h.email("admin"));
  await browser.set('[data-testid="input-password"]',h.password);
  await browser.click('[data-testid="button-login"]');
  await browser.waitFor(/Dashboard|Today|My Day/);
  await browser.evaluate("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");
  await browser.navigate("/dashboard/calendar");
  await until(`!!document.querySelector('[data-testid="button-edit-invalid-date-event_${repairId}"]')`);
  await browser.click(`[data-testid="button-edit-invalid-date-event_${repairId}"]`);
  await nativeDateOrTime(`[data-testid="input-fix-date-event_${repairId}"]`, "10202026", "2026-10-20");
  await nativeDateOrTime(`[data-testid="input-fix-start-event_${repairId}"]`, "0230p", "14:30");
  await browser.set(`[data-testid="input-fix-duration-event_${repairId}"]`, "45");
  await browser.screenshot("calendar-replacement-fields");
  browser.failRead(`/api/calendar-events/${repairId}`);
  await browser.click(`[data-testid="button-save-fix-event_${repairId}"]`);
  await browser.waitFor(/Failed to fix date/);
  assert.equal(await browser.evaluate("document.body.innerText.includes('Event date fixed')"),false);
  assert.equal((await h.pool.query("SELECT start_time FROM calendar_events WHERE id=$1",[repairId])).rows[0].start_time.toISOString(), original.startTime);
  checks.push("real signed-in repair write failure retains SQL record/editor and shows error without success");
  browser.failRead(null);
  invalidWireTimes = false;
  await browser.click(`[data-testid="button-save-fix-event_${repairId}"]`);
  await browser.waitFor(/Event date fixed/);
  const saved = (await h.pool.query("SELECT start_time,end_time FROM calendar_events WHERE id=$1",[repairId])).rows[0];
  assert.equal(saved.start_time.toISOString(),"2026-10-20T14:30:00.000Z");
  assert.equal(saved.end_time-saved.start_time,45*60000);
  await browser.navigate("/dashboard/calendar");
  await until(`!!document.querySelector('[data-testid="calendar-day-2026-10-20"]') && !document.querySelector('[data-testid="card-invalid-date-events"]')`);
  await browser.click('[data-testid="calendar-day-2026-10-20"]');
  await browser.waitFor(/C2 repair fixture/);
  await browser.screenshot("calendar-after-save-reload");
  checks.push("replacement fields real pointer/input, successful actual handler SQL write and reload");
  const tasks = await h.request("admin","GET",`/api/tasks?contactId=${contact}`);
  assert.equal(tasks.status,200,JSON.stringify(tasks.body));
  const scoped = tasks.body.filter((task: any) => task.contactId === contact);
  assert.equal(scoped.length,4); assert.equal(scoped.filter(isPendingTask).length,2);
  await browser.navigate(`/dashboard/contacts/${contact}?area=overview&section=overview`);
  await until("!!document.querySelector('[data-testid=\"text-contact-name\"]')");
  await new Promise(resolve=>setTimeout(resolve,800));
  await browser.screenshot("contact-pending-population");
  await writeFile(`${directory}/contact-text.txt`,await browser.text());
  await until("document.querySelector('[data-testid=\"text-pending-tasks\"]')?.textContent==='2'");
  await browser.screenshot("contact-pending-count-two");
  const pending = scoped.find((task: any) => task.effectiveState === "open");
  assert.ok(pending);
  const complete = await h.request("admin","PUT",`/api/tasks/${pending.id}`,{
    status:"completed",expectedFence:pending.authorityFence,expectedActorId:h.userId("admin"),commandId:randomUUID(),
  });
  assert.equal(complete.status,200,JSON.stringify(complete.body));
  await browser.navigate(`/dashboard/contacts/${contact}?area=overview&section=overview`);
  await until("document.querySelector('[data-testid=\"text-pending-tasks\"]')?.textContent==='1'");
  const after = await h.request("admin","GET",`/api/tasks?contactId=${contact}`);
  assert.equal(after.body.filter((task: any)=>task.contactId===contact).filter(isPendingTask).length,1);
  await browser.call("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await browser.screenshot("contact-mobile-after-task-change");
  checks.push("Contact visible pending count equals authorized Work population, 2 to 1 after real task command/reload; mobile capture");
  assert.equal(browser.exceptions.length,0,JSON.stringify(browser.exceptions));
  assert.equal(h.externalCalls(),0);
  await writeFile(`${directory}/receipt.json`,JSON.stringify({
    status:"pass",checks,effects:"private PostgreSQL/Redis, real fixture login, provider egress denied",
    invalidTimeFixture:"timestamp-only wire fault on authorized read, not a production malformed SQL row",
    requests:browser.requests.map(r=>({path:new URL(r.url,h.base).pathname,method:r.method,status:r.status})),
  },null,2)+"\n");
  console.log("C2 postmerge signed-in/SQL certification: PASS",checks);
} catch (error) {
  if (browser) { await browser.screenshot("failure"); await writeFile(`${directory}/failure-text.txt`,await browser.text()); }
  throw error;
} finally { await browser?.close(); await h.close(); }
process.exit(0);
