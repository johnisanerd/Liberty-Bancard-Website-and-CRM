import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { privateStage3Browser } from "./fixtures/private-stage3-browser";
import { verifyCandidateIdentity } from "./fixtures/candidate-build-identity";

/**
 * Stage 3 D-V Contact verification, cases 1 and 2 (TEST-ONLY file; no application behavior is changed here).
 *
 * The REAL Contact page, auth hook and protected query fence are driven in a real private Chromium against persisted
 * Passport sessions on a disposable database. A section response is held in the page while the actor changes:
 *   case 1  a different persisted user (agent -> other agent) signs in (cookie swap, as a second tab would do), and the
 *           open page re-reads /api/auth/user;
 *   case 2a the SAME user's account_version changes (session stays valid), then the page re-reads /api/auth/user;
 *   case 2b the SAME user's permissions change, then the page re-reads /api/auth/user.
 * The held response was produced by the server under the OLD actor and is released only AFTER the new actor is current
 * (the in-page hold strips the abort signal so the late response is genuinely delivered to the page's own fetch caller).
 *
 * Test-only instrumentation (not in the serving application): the in-page fetch hold, a Date.now skew (so the 5-minute-stale
 * auth query is eligible for the app's own reconnect refetch) and synthetic offline/online events (the trigger for the
 * app's own /api/auth/user revalidation). Everything that clears, fences or recovers is the unmodified application.
 */
const SERVING = "cafc77ab1ba7c5a834a84fa000299524516aa626";
const directory = "docs/certification/stage3-d-v/contact-actor-browser";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const lines = (value: string) => value.split("\n").filter(Boolean);

function servingBinding() {
  assert.equal(git("cat-file", "-t", SERVING), "commit", "Serving commit must exist locally");
  const changedSince = (paths: string[]) => [...new Set([
    ...lines(git("diff", "--name-only", SERVING, "--", ...paths)),
    ...lines(git("ls-files", "--others", "--exclude-standard", "--", ...paths)),
  ])].sort();
  const clientInputs = ["client", "shared", "migrations", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json"];
  const clientChanged = changedSince(clientInputs);
  // Server/auth files this suite actually loads and whose behavior the cases exercise.
  const exercised = ["server/routes/contacts.ts", "server/routes/crm-operations.ts", "server/routes/activity.ts",
    "server/routes/tickets-tasks.ts", "server/routes/notifications.ts", "server/routes/deals.ts",
    "server/services/crm-object-access.ts", "server/middleware/csrf.ts",
    "server/replit_integrations/auth/replitAuth.ts", "server/replit_integrations/auth/routes.ts",
    "server/replit_integrations/auth/storage.ts", "server/replit_integrations/auth/index.ts", "server/storage.ts"];
  const exercisedIdentical = Object.fromEntries(exercised.map(file =>
    [file, git("rev-parse", `${SERVING}:${file}`) === git("hash-object", file)]));
  return {
    servingVersion: SERVING, workspaceHead: git("rev-parse", "HEAD"),
    clientSharedMigrationsPackageChangedSinceServing: clientChanged,
    exercisedServerAndAuthFilesIdenticalToServing: exercisedIdentical,
    otherServerFilesChangedSinceServing: changedSince(["server"]).filter(file => !exercised.includes(file)),
    scriptsAndDocsChangedSinceServing: changedSince(["scripts", "docs"]),
    thisChangeIsTestAndEvidenceOnly: ["scripts/test-stage3-d-v-contact-actor-browser.ts (new)", "scripts/pre-deploy.ts (one roster line)", "docs/certification/stage3-d-v/contact-actor-browser/** (receipts)", "ledger and specification notes"],
    note: "client/shared/migrations/package inputs and every exercised route/auth file must equal the serving commit; other server files (listed) changed after the serving commit by earlier unrelated work (database client BEGIN-failure release, timing/summary logging) and are loaded by the fixture only as infrastructure; test-db-transaction-begin-release.ts in the scripts list is that earlier work, not part of this change",
  };
}

const binding = servingBinding();
assert.deepEqual(binding.clientSharedMigrationsPackageChangedSinceServing, [], "Client inputs differ from the serving version");
assert.ok(Object.values(binding.exercisedServerAndAuthFilesIdenticalToServing).every(Boolean), "Exercised server/auth files differ from the serving version");
const fullIdentity = await verifyCandidateIdentity();
const { inputs: _inputs, outputs: _outputs, ...identity } = fullIdentity as any;
const checks: Array<{ case: string; claim: string }> = [];
const observations: Array<{ case: string; observation: string }> = [];
const screenshots: string[] = [];
let current = "setup";

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
const ev = (expression: string) => browser!.evaluate(expression);
const text = () => ev("document.body.innerText") as Promise<string>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (expression: string, label: string, polls = 400) => {
  for (let n = 0; n < polls; n++) { if (await ev(expression)) return; await sleep(50); }
  throw new Error(`UI condition not reached: ${label}`);
};
const check = (claim: string, ok: unknown) => { assert.ok(ok, `${current}: ${claim}`); checks.push({ case: current, claim }); };
const shot = async (name: string) => { await browser!.screenshot(name); screenshots.push(`${directory}/${name}.jpg`); };
const go = (path: string) => ev(`history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate'))`);
const held = (gen: number) => ev(`window.__held.filter(e=>e.gen===${gen}&&!e.released).length`) as Promise<number>;
const release = (gen: number) => ev(`window.__held.filter(e=>e.gen===${gen}&&!e.released).forEach(e=>e.release())`);
const authReads = () => browser!.requests.filter(r => r.url.startsWith("/api/auth/user") && r.status === 200).length;

async function openSession(role: string) {
  browser = await privateStage3Browser(h.base, "", h.originalFetch, directory, { realInput: true });
  await browser.navigate("/login"); await browser.waitFor(/Sign In/);
  await browser.set('[data-testid="input-email"]', h.email(role)); await browser.set('[data-testid="input-password"]', h.password);
  await browser.click('[data-testid="button-login"]'); await browser.waitFor(/Dashboard|Today|My Day/);
  await ev("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");
}
/** Holds /detail?section= reads. The real request is sent immediately under the CURRENT cookie (so the server answers as the
 *  current actor); only delivery to the page is deferred, and the abort signal is stripped so a late delivery really happens. */
const installHold = () => ev(`(()=>{const of=window.fetch.bind(window);const realNow=Date.now.bind(Date);
  window.__skew=0;Date.now=()=>realNow()+window.__skew;window.__held=[];window.__gen=0;window.__mode='pass';
  window.fetch=(u,i)=>{const url=String(u);
    if(url.includes('/detail?section=')&&window.__mode==='hold'){
      const init={...(i||{})};delete init.signal;const real=of(u,init);
      const entry={gen:window.__gen,url,released:false,status:null,text:null};
      real.then(r=>{entry.status=r.status;r.clone().text().then(t=>{entry.text=t;});});
      return new Promise(res=>{entry.release=()=>{entry.released=true;res(real);};window.__held.push(entry);});
    }
    return of(u,i);};})()`);
/** Advance the generation first so reads issued after the actor changes are distinguishable from the old actor's reads. */
const revalidateAuth = () => ev(`(()=>{window.__gen=1;window.__skew=600000;
  window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'));})()`);

const contactIds: Record<string, number> = {};
async function mk(label: string, first: string, assignedTo: string, withOnboarding: boolean) {
  const id = (await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class,assigned_to) VALUES($1,'Actorfixture',$2,'','production',$3) RETURNING id`,
    [first, `${h.prefix}-${label}@example.test`, assignedTo])).rows[0].id as number;
  await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,owner,record_class,offer_path) VALUES($1,'sales','New Lead',$2,'production',$3)`, [id, assignedTo, `OLD-OFFER-${first}`]);
  if (withOnboarding) await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,owner,record_class) VALUES($1,'onboarding','New',$2,'production')`, [id, assignedTo]);
  await h.pool.query(`INSERT INTO notes(entity_type,entity_id,content) VALUES('contact',$1,$2)`, [id, `OLD-NOTE-${first}`]);
  contactIds[label] = id;
  return id;
}
const capabilityTabVisible = () => ev(`!!document.querySelector('[data-testid="tab-onboarding-stages"]')`) as Promise<boolean>;

/** Open a contact as the current signed-in actor, prove header, capability and section content, then hold a section read. */
async function loadAndHold(id: number, first: string) {
  await browser!.navigate(`/dashboard/contacts/${id}?area=lifecycle&section=documents`);
  await until(`!!document.querySelector('[data-testid="tab-documents"]')`, "lifecycle area loaded");
  check("old actor sees the onboarding capability tab", await capabilityTabVisible());
  await go(`/dashboard/contacts/${id}?area=sales-work&section=deals`);
  await until(`document.body.innerText.includes('OLD-OFFER-${first}')`, "deals section content visible");
  check("old actor sees header and section content before the change", (await text()).includes(first));
  await installHold();
  await ev("window.__mode='hold'");
  await go(`/dashboard/contacts/${id}?area=conversations&section=notes`);
  await until(`!!document.querySelector('[data-testid="contact-section-loading"]')`, "section loading state");
  const body = await text();
  check("section pending: old header retained for the unchanged actor, no section content", body.includes(first) && !body.includes(`OLD-NOTE-${first}`) && !body.includes(`OLD-OFFER-${first}`));
  check("detector sensitivity: the cleared-state predicate is false while the old header is on screen", !(await noOldContent(first)));
  await until(`window.__held.length===1&&window.__held[0].text!==null`, "old actor's response produced and held");
  check("the held response was produced by the server for the old actor and carries its header and section content",
    await ev(`window.__held[0].status===200&&window.__held[0].text.includes('OLD-NOTE-${first}')&&window.__held[0].text.includes('${first}')`));
}
const tokensAbsent = async (first: string, extra: string[] = []) => {
  const body = await text();
  return !body.includes(first) && !body.includes(`OLD-NOTE-${first}`) && !body.includes(`OLD-OFFER-${first}`) && extra.every(token => !body.includes(token));
};
/** No header, no retained-section loading shell, no capability tab: nothing of any record is shown. */
const shellCleared = async () => !(await ev(`!!document.querySelector('[data-testid="text-contact-name"],[data-testid="contact-section-loading"],[data-testid="tab-onboarding-stages"]')`));
const noOldContent = async (first: string, extra: string[] = []) => (await tokensAbsent(first, extra)) && (await shellCleared());

async function waitNewActorFresh(authBefore: number) {
  await until(`window.__held.some(e=>e.gen===1)`, "fresh read issued for the new actor", 600);
  check("the app re-read /api/auth/user and re-issued the section read for the new actor", authReads() > authBefore && (await held(1)) >= 1);
}

try {
  await mkdir(directory, { recursive: true });
  await h.pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1", [h.prefix + "%"]);
  const agentEmail = h.email("agent"), otherEmail = h.email("other");

  // ---------- Case 1: another persisted user while a section response is delayed ----------
  current = "case-1 user change";
  const x1 = await mk("x1", "Oldone", agentEmail, true);
  const y1 = await mk("y1", "Yankee", otherEmail, false);
  await openSession("agent");
  try {
    await loadAndHold(x1, "Oldone");
    const loginStatus = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',
      body:JSON.stringify({email:${JSON.stringify(otherEmail)},password:${JSON.stringify(h.password)}})}).then(r=>r.status)`);
    assert.equal(loginStatus, 200, "second persisted user must sign in");
    check("the second persisted user is now the server-side signed-in user", (await ev(`fetch('/api/auth/user',{credentials:'include'}).then(r=>r.json()).then(u=>u.id)`)) === h.userId("other"));
    observations.push({ case: current, observation: "Until the app re-reads /api/auth/user it still renders the previous user's retained header; every data read is authorized by the server under the new session. This is the existing client revalidation design, not asserted as a pass/fail." });
    const authBefore = authReads();
    await revalidateAuth();
    await waitNewActorFresh(authBefore);
    check("after the user change (new read pending) the old header, capability tab and section content are gone", await noOldContent("Oldone"));
    await shot("case-1-actor-changed-fresh-pending");
    await release(0);
    await sleep(800);
    check("the late response for the previous user cannot restore its header, capabilities or content", await noOldContent("Oldone"));
    check("the late response really contained the previous user's content", await ev(`window.__held.filter(e=>e.gen===0)[0].released&&window.__held[0].text.includes('OLD-NOTE-Oldone')`));
    await release(1);
    await until(`!!document.querySelector('[data-testid="contact-detail-error"]')`, "new user's own authorization result is shown");
    check("the new user's own read (denied for this record) is shown and nothing of the previous user remains", await noOldContent("Oldone"));
    await shot("case-1-new-user-denied");
    await ev("window.__mode='pass'");
    await go(`/dashboard/contacts/${y1}?area=conversations&section=notes`);
    await until(`document.body.innerText.includes('OLD-NOTE-Yankee')`, "permitted fresh read renders");
    check("a permitted fresh read recovers: the new user's own header and section content render", (await text()).includes("Yankee") && await ev(`!!document.querySelector('[data-testid="text-contact-name"]')`));
    check("the previous user's content is still absent after recovery", await tokensAbsent("Oldone"));
    await go(`/dashboard/contacts/${y1}?area=lifecycle&section=documents`);
    await until(`!!document.querySelector('[data-testid="tab-documents"]')`, "lifecycle area for the new user's record");
    check("capabilities follow the new user's own read (no onboarding tab on this record)", !(await capabilityTabVisible()));
    await shot("case-1-new-user-recovered");
    check("no uncaught page exceptions", browser!.exceptions.length === 0);
  } finally { await browser?.close(); browser = undefined; }

  // ---------- Case 2: same user, account version / permissions change ----------
  for (const variant of ["2a account version", "2b permissions"] as const) {
    current = `case-${variant}`;
    const tag = variant.startsWith("2a") ? "two-a" : "two-b";
    const oldName = variant.startsWith("2a") ? "Oldtwoa" : "Oldtwob", newName = variant.startsWith("2a") ? "Newtwoa" : "Newtwob";
    const x = await mk(tag, oldName, agentEmail, true);
    await openSession("agent");
    try {
      await loadAndHold(x, oldName);
      if (variant.startsWith("2a")) await h.pool.query("UPDATE users SET account_version=account_version+1 WHERE id=$1", [h.userId("agent")]);
      else await h.pool.query(`UPDATE users SET permissions='["fixture.permission.change"]'::jsonb WHERE id=$1`, [h.userId("agent")]);
      // The same actor's record changes, so the fresh read is distinguishable from the held old answer.
      await h.pool.query("UPDATE contacts SET first_name=$2 WHERE id=$1", [x, newName]);
      await h.pool.query("UPDATE notes SET content=$2 WHERE entity_type='contact' AND entity_id=$1", [x, `NEW-NOTE-${newName}`]);
      await h.pool.query("UPDATE deals SET archived_at=NOW() WHERE contact_id=$1 AND pipeline='onboarding'", [x]);
      const changedUser = await ev(`fetch('/api/auth/user',{credentials:'include'}).then(r=>r.json()).then(u=>({v:u.accountVersion,p:(u.permissions||[]).length}))`) as { v: number; p: number };
      check("the same persisted session now reports the changed authority", variant.startsWith("2a") ? changedUser.v === 2 : changedUser.p === 1);
      const authBefore = authReads();
      await revalidateAuth();
      await waitNewActorFresh(authBefore);
      check("after the authority change (fresh read pending) the old header, capability tab and section content are gone", await noOldContent(oldName));
      await shot(`case-${tag}-authority-changed-fresh-pending`);
      await release(0);
      await sleep(800);
      check("the late response from the previous authority cannot restore its header, capabilities or content", await noOldContent(oldName));
      check("the late response really contained the previous authority's content", await ev(`window.__held.filter(e=>e.gen===0)[0].released&&window.__held[0].text.includes('OLD-NOTE-${oldName}')`));
      await release(1);
      await until(`document.body.innerText.includes('NEW-NOTE-${newName}')`, "permitted fresh read recovers");
      check("a permitted fresh read recovers with the current header and section content", (await text()).includes(newName) && await ev(`!!document.querySelector('[data-testid="text-contact-name"]')`));
      check("nothing from the previous authority returns after recovery", await tokensAbsent(oldName));
      await ev("window.__mode='pass'");
      await go(`/dashboard/contacts/${x}?area=lifecycle&section=documents`);
      await until(`!!document.querySelector('[data-testid="tab-documents"]')`, "lifecycle area after recovery");
      check("capabilities come from the fresh read (onboarding tab is gone)", !(await capabilityTabVisible()));
      await shot(`case-${tag}-recovered`);
      check("no uncaught page exceptions", browser!.exceptions.length === 0);
    } finally { await browser?.close(); browser = undefined; }
  }

  const receipt = {
    status: "passed", asOf: new Date().toISOString(), binding, candidate: identity, checks, observations, screenshots,
    testOnlyInstrumentation: ["in-page fetch hold that strips the abort signal so a late response is delivered", "Date.now skew + synthetic offline/online events to trigger the application's own /api/auth/user revalidation", "direct disposable-database updates of users.account_version / users.permissions / fixture rows"],
    scope: "REAL Contact page, auth hook and protected query fence in private Chromium (1280px desktop default window), persisted Passport sessions, disposable DB/Redis, provider transports denied. Case 1: agent -> other agent. Case 2a: same user account_version change. Case 2b: same user permissions change. Not a role matrix, not production, not the full CRM, not a real second tab or network-level abort race.",
  };
  await writeFile(`${directory}/receipt.json`, JSON.stringify(receipt, null, 2) + "\n");
  console.log(checks.map(c => `✓ [${c.case}] ${c.claim}`).join("\n"));
  console.log(`Stage 3 D-V contact actor browser: PASS (${checks.length} checks)`);
} catch (error) {
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/receipt.json`, JSON.stringify({ status: "failed", asOf: new Date().toISOString(), failedIn: current,
    error: error instanceof Error ? error.message : String(error), binding, candidate: identity, checksPassedBeforeFailure: checks, observations, screenshots }, null, 2) + "\n");
  throw error;
} finally { await browser?.close(); await h.close(); }
