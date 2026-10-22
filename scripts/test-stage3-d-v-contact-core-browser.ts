import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { privateStage3Browser } from "./fixtures/private-stage3-browser";
import { verifyCandidateIdentity } from "./fixtures/candidate-build-identity";

// F04: the REAL Contact component with deferred section responses. While a section read is pending the header (contact core)
// stays, no section content (deals/notes/tickets/tasks) from the previous section is reachable, a different record never
// shows the previous record's header, and a failed read drops the retained core. Actor and permission-generation changes are
// covered by the RetainedContactCore unit suite and the protected-scope key; a second signed-in actor is NOT driven here.
const identity = await verifyCandidateIdentity();
const directory = "docs/certification/stage3-d-v/contact-core-browser";
const checks: string[] = [];
const h = await stage3BHttpFixture(async app => {
  for (const [file, fn] of [["contacts", "registerContactsRoutes"], ["crm-operations", "registerCrmOperationsRoutes"], ["activity", "registerActivityRoutes"],
    ["tickets-tasks", "registerTicketsTasksRoutes"], ["notifications", "registerNotificationsRoutes"], ["deals", "registerDealsRoutes"]] as const) {
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
const text = () => browser!.evaluate("document.body.innerText") as Promise<string>;
try {
  await mkdir(directory, { recursive: true });
  await h.pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1", [h.prefix + "%"]);
  const mk = async (first: string) => (await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class) VALUES($1,'Corefixture',$2,'','production') RETURNING id`, [first, `${h.prefix}-${first}@example.test`])).rows[0].id as number;
  const a = await mk("Alpha"), b = await mk("Bravo");
  await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,record_class,offer_path) VALUES($1,'sales','New Lead','production','SECRET-OFFER-PATH')`, [a]);
  await h.pool.query(`INSERT INTO notes(entity_type,entity_id,content) VALUES('contact',$1,'SECRET-NOTE-BODY')`, [a]);

  browser = await privateStage3Browser(h.base, "", h.originalFetch, directory, { realInput: true });
  await browser.navigate("/login"); await browser.waitFor(/Sign In/);
  await browser.set('[data-testid="input-email"]', h.email("admin")); await browser.set('[data-testid="input-password"]', h.password);
  await browser.click('[data-testid="button-login"]'); await browser.waitFor(/Dashboard|Today|My Day/);
  await browser.evaluate("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");

  await browser.navigate(`/dashboard/contacts/${a}?area=sales-work&section=deals`);
  await until(`document.body.innerText.includes('SECRET-OFFER-PATH')`, "deals section content visible");
  assert.match(await text(), /Alpha/);
  // Install a hold on section reads; the page's own fetch calls are deferred until released or failed by the test.
  await browser.evaluate(`(()=>{const of=window.fetch.bind(window);window.__held=[];window.__mode='pass';
    window.fetch=(u,i)=>{const url=String(u);
      if(url.includes('/detail?section=')&&window.__mode==='hold')return new Promise(res=>window.__held.push(()=>res(of(u,i))));
      if(url.includes('/detail?section=')&&window.__mode==='fail')return Promise.resolve(new Response('{"message":"boom"}',{status:500,headers:{'Content-Type':'application/json'}}));
      return of(u,i);};})()`);
  const go = (path: string) => browser!.evaluate(`history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate'))`);

  // Same record, different section, response deferred.
  await browser.evaluate("window.__mode='hold'");
  await go(`/dashboard/contacts/${a}?area=conversations&section=notes`);
  await until(`!!document.querySelector('[data-testid="contact-section-loading"]')`, "section loading state");
  let body = await text();
  assert.match(body, /Alpha/, "header (contact core) stays while the section loads");
  assert.ok(!body.includes("SECRET-OFFER-PATH") && !body.includes("SECRET-NOTE-BODY"), "no section content is visible while the next section is pending");
  checks.push("deferred section read: header retained, loading state shown, no section arrays/notes/deals visible");
  await browser.screenshot("section-pending");
  await browser.evaluate("window.__mode='pass';window.__held.splice(0).forEach(f=>f())");
  await until(`document.body.innerText.includes('SECRET-NOTE-BODY')`, "notes section after release");
  checks.push("releasing the deferred response renders that section's own content");

  // Different record, response deferred: the previous record's header must not appear.
  await browser.evaluate("window.__mode='hold'");
  await go(`/dashboard/contacts/${b}?area=overview&section=overview`);
  await new Promise(r => setTimeout(r, 600));
  body = await text();
  assert.ok(!body.includes("Alpha") && !body.includes("SECRET-NOTE-BODY"), "another record never shows the previous record's header or content");
  checks.push("deferred read for another record shows nothing from the previous record");
  await browser.evaluate("window.__mode='pass';window.__held.splice(0).forEach(f=>f())");
  await until(`document.body.innerText.includes('Bravo')`, "second record loads");

  // Failed read drops the retained core.
  await browser.evaluate("window.__mode='fail'");
  await go(`/dashboard/contacts/${b}?area=sales-work&section=deals`);
  await until(`!document.querySelector('[data-testid="contact-section-loading"]') && !document.body.innerText.includes('Bravo')`, "failed read drops the header");
  checks.push("a failed section read drops the retained header instead of showing stale identity");
  await browser.screenshot("section-failed");

  await writeFile(`${directory}/receipt.json`, JSON.stringify({ status: "passed", candidate: identity, checks,
    scope: "real Contact component, deferred/failed section responses via in-page fetch hold, admin session, 1280px desktop; no second actor, permission-generation or role-matrix run" }, null, 2));
  console.log(checks.map(c => `✓ ${c}`).join("\n")); console.log("Stage 3 D-V contact core browser: PASS");
} finally { await browser?.close(); await h.close(); }
