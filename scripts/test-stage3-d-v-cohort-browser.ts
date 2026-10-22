import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { privateStage3Browser } from "./fixtures/private-stage3-browser";
import { verifyCandidateIdentity } from "./fixtures/candidate-build-identity";

// F03: the Today actions open the exact cohort they count. Real Tasks and Pipeline pages, real registered routes, disposable
// database. Proves direct entry, reload, in-app change, and Back/Forward restoration of the URL-held cohort.
const identity = await verifyCandidateIdentity();
const directory = "docs/certification/stage3-d-v/cohort-browser";
const checks: string[] = [];
const h = await stage3BHttpFixture(async app => {
  for (const [file, fn] of [["tickets-tasks", "registerTicketsTasksRoutes"], ["deals", "registerDealsRoutes"], ["contacts", "registerContactsRoutes"],
    ["notifications", "registerNotificationsRoutes"], ["activity", "registerActivityRoutes"], ["crm-operations", "registerCrmOperationsRoutes"]] as const) {
    const module = await import(`../server/routes/${file}.ts`); module[fn](app);
  }
  app.use("/api", (_req, res) => res.status(501).json({ message: "Unregistered isolated service" }));
  const { static: serveStatic } = await import("express");
  app.use(serveStatic("dist/public"));
  app.use((_req, res) => res.sendFile("index.html", { root: `${process.cwd()}/dist/public` }));
});
let browser: Awaited<ReturnType<typeof privateStage3Browser>> | undefined;
const until = async (expression: string, label = expression) => {
  for (let n = 0; n < 240; n++) { if (await browser!.evaluate(expression)) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`UI condition not reached: ${label}`);
};
const has = (testid: string) => `!!document.querySelector('[data-testid="${testid}"]')`;
const url = () => browser!.evaluate("location.pathname+location.search") as Promise<string>;
try {
  await mkdir(directory, { recursive: true });
  await h.pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1", [h.prefix + "%"]);
  const contact = (await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class) VALUES('Cohort','Fixture',$1,'','production') RETURNING id`, [h.prefix + "-cohort@example.test"])).rows[0].id;
  const task = async (title: string, status: string, due: string) => (await h.pool.query(`INSERT INTO tasks(title,contact_id,assigned_to,canonical_assignee,status,authority_state,due_date)
    VALUES($1,$2,$3,$3,$4,$5,$6::timestamptz) RETURNING id`, [title, contact, h.email("admin"), status, status === "pending" ? "open" : status, due])).rows[0].id as number;
  const overdue = await task("D-V overdue pending", "pending", "2020-01-01T00:00:00Z");
  const overdueProgress = await task("D-V overdue in progress", "in_progress", "2020-01-02T00:00:00Z");
  const future = await task("D-V future pending", "pending", "2099-01-01T00:00:00Z");
  const doneOld = await task("D-V done old", "completed", "2020-01-03T00:00:00Z");
  const fresh = (await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,record_class,created_at) VALUES($1,'sales','New Lead','production',NOW()) RETURNING id`, [contact])).rows[0].id;
  const old = (await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,record_class,created_at) VALUES($1,'sales','New Lead','production',NOW()-INTERVAL '30 days') RETURNING id`, [contact])).rows[0].id;

  browser = await privateStage3Browser(h.base, "", h.originalFetch, directory, { realInput: true });
  await browser.navigate("/login"); await browser.waitFor(/Sign In/);
  await browser.set('[data-testid="input-email"]', h.email("admin")); await browser.set('[data-testid="input-password"]', h.password);
  await browser.click('[data-testid="button-login"]'); await browser.waitFor(/Dashboard|Today|My Day/);
  await browser.evaluate("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");

  const rows = () => browser!.evaluate(`[...document.querySelectorAll('[data-testid^="row-task-"]')].map(e=>Number(e.getAttribute('data-testid').slice(9))).sort((a,b)=>a-b)`) as Promise<number[]>;
  const sameSet = (actual: number[], expected: number[]) => assert.deepEqual(actual, [...expected].sort((a, b) => a - b));

  // Direct entry on the overdue cohort (the Today "overdue" action target).
  await browser.navigate("/dashboard/tasks-appointments?tab=tasks&due=overdue");
  await until(has(`row-task-${overdue}`));
  sameSet(await rows(), [overdue, overdueProgress]);
  assert.match(await browser.evaluate(`document.querySelector('[data-testid="select-filter-due"]').textContent`) as string, /Overdue only/);
  checks.push("direct entry on due=overdue lists exactly the pending/in-progress tasks past due and shows the filter");
  await browser.screenshot("tasks-overdue-direct");

  // Reload restores the same cohort.
  await browser.navigate("/dashboard/tasks-appointments?tab=tasks&due=overdue");
  await until(has(`row-task-${overdue}`)); sameSet(await rows(), [overdue, overdueProgress]);
  checks.push("reload keeps the overdue cohort");

  // In-app change pushes history; Back and Forward restore.
  await browser.click('[data-testid="select-filter-due"]');
  await until(`!![...document.querySelectorAll('[role=option]')].find(o=>/Any due date/.test(o.textContent))`);
  await browser.evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>/Any due date/.test(o.textContent)).click()`);
  await until(has(`row-task-${future}`));
  assert.ok(!(await url()).includes("due=overdue"), "clearing the due filter updates the URL");
  sameSet((await rows()).filter(id => id !== doneOld), [overdue, overdueProgress, future]);
  checks.push("clearing the due filter shows every task and removes the URL selector");
  await browser.evaluate("history.back()");
  await until(`!document.querySelector('[data-testid="row-task-${future}"]')`);
  assert.ok((await url()).includes("due=overdue")); sameSet(await rows(), [overdue, overdueProgress]);
  await browser.evaluate("history.forward()");
  await until(has(`row-task-${future}`));
  checks.push("Back restores the overdue cohort and Forward restores the full list");

  // Pending cohort (the Today "pending" action target).
  await browser.navigate("/dashboard/tasks-appointments?tab=tasks&taskState=pending");
  await until(has(`row-task-${future}`)); sameSet(await rows(), [overdue, future]);
  checks.push("direct entry on taskState=pending lists exactly the pending tasks");

  // Invalid selector falls back visibly, never silently narrows.
  await browser.navigate("/dashboard/tasks-appointments?tab=tasks&due=bogus");
  await until(has(`row-task-${future}`));
  assert.match(await browser.evaluate("document.body.innerText") as string, /due: invalid selection/);
  checks.push("an invalid due value shows all tasks and says so");

  // Pipeline: created=7d.
  const cards = () => browser!.evaluate(`[...document.querySelectorAll('[data-testid^="card-deal-"]')].map(e=>Number(e.getAttribute('data-testid').slice(10))).sort((a,b)=>a-b)`) as Promise<number[]>;
  await browser.navigate("/dashboard/pipeline"); await until(has(`card-deal-${old}`));
  assert.ok((await cards()).includes(fresh) && (await cards()).includes(old));
  await browser.navigate("/dashboard/pipeline?created=7d");
  await until(has("pipeline-created-cohort") + ` && ${has(`card-deal-${fresh}`)}`);
  await new Promise(r => setTimeout(r, 400));
  const filtered = await cards();
  assert.ok(filtered.includes(fresh) && !filtered.includes(old), `created=7d shows only new deals: ${filtered}`);
  checks.push("Pipeline created=7d shows only sales deals created in the last 7 days and a clearable chip");
  // The page selector is created=7d; the API selector is createdLast7Days=true (created=7d is a page-only selector).
  const apiIds = async (query: string) => JSON.parse(await browser!.evaluate(`fetch('/api/deals?${query}',{credentials:'include'}).then(r=>r.json()).then(j=>JSON.stringify((Array.isArray(j)?j:(j.deals??j.data??j.items??[])).map(d=>d.id)))`) as string) as number[];
  const apiRecent = await apiIds("pipeline=sales&createdLast7Days=true");
  assert.ok(apiRecent.includes(fresh) && !apiRecent.includes(old), `API createdLast7Days=true returns only recent deals: ${apiRecent.length} rows`);
  checks.push("API selector createdLast7Days=true returns the recent sales deals and excludes the old one (the page selector is created=7d)");
  await browser.screenshot("pipeline-created-7d");
  await browser.click('[data-testid="pipeline-created-cohort"]');
  await until(has(`card-deal-${old}`));
  assert.ok(!(await url()).includes("created=7d") && !(await browser.evaluate(has("pipeline-created-cohort"))));
  await browser.evaluate("history.back()");
  await until(has("pipeline-created-cohort")); await until(`!document.querySelector('[data-testid="card-deal-${old}"]')`);
  checks.push("clearing the Pipeline cohort removes it; Back restores it");

  await writeFile(`${directory}/receipt.json`, JSON.stringify({ status: "passed", candidate: identity, checks, scope: "disposable fixture, real Tasks/Pipeline pages and routes, admin session, 1280px desktop; Today page itself not driven here (its links are asserted statically)" }, null, 2));
  console.log(checks.map(c => `✓ ${c}`).join("\n")); console.log("Stage 3 D-V cohort browser: PASS");
} finally { await browser?.close(); await h.close(); }
