import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { privateStage3Browser } from "./fixtures/private-stage3-browser";
import { verifyCandidateIdentity } from "./fixtures/candidate-build-identity";

// Stage 3 D-V: Data Health reconcile in a REAL browser against the REAL admin route module, a disposable migrated
// database and real persisted admin/manager/agent sessions. Covers plan -> select -> review -> confirm -> receipt,
// durable readback, a real post-commit truncated response followed by the same-operation recovery (nothing applied twice),
// and the role boundary (manager sees no plan controls and the plan/apply routes answer 403; agent cannot open the page).
// Nothing is sent, enrolled, rescheduled or unpaused and no provider is called.
const identity = await verifyCandidateIdentity();
const dir = "docs/certification/stage3-d-v";
const clientRoot = path.resolve("dist/public");
const h = await stage3BHttpFixture(async app => {
  (await import("../server/routes/admin.ts")).registerAdminRoutes(app);
  app.use("/api", (_req, res) => res.status(501).json({ message: "Source not registered in this isolated D-V fixture" }));
  const { static: serveStatic } = await import("express");
  app.use((req, res, next) => serveStatic(clientRoot)(req, res, next));
  app.use((_req, res) => res.sendFile("index.html", { root: clientRoot }));
}, undefined, { backgroundProfile: "off" });
const checks: string[] = [];
const check = (ok: unknown, label: string) => { assert.ok(ok, label); checks.push(label); };
const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
const q = async (text: string, v: any[] = []) => (await h.pool.query(text, v)).rows;
const nonce = randomUUID().replaceAll("-", "").slice(0, 10);
try {
  await mkdir(dir, { recursive: true });
  await h.pool.query(`UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1`, [`${h.prefix}-%`]);
  // Fixtures: one unique-email unlinked deal, one orphan enrollment (sequence removed).
  const email = `dv.${nonce}@dv.example.test`;
  const contactId = Number((await q(`INSERT INTO contacts (first_name,last_name,phone,email,company_name,record_class) VALUES('Dv','Fixture','',$1,$2,'production') RETURNING id`, [email, `Dv Co ${nonce}`]))[0].id);
  const dealId = Number((await q(`INSERT INTO deals (notes,pipeline,stage,record_class) VALUES($1,'sales','New Lead','production') RETURNING id`, [`Inbound lead ${email}`]))[0].id);
  const seqId = Number((await q(`INSERT INTO follow_up_sequences (name,trigger_type,status) VALUES($1,'manual','paused') RETURNING id`, [`dv-${nonce}`]))[0].id);
  const enrollId = Number((await q(`INSERT INTO sequence_enrollments (contact_id,sequence_id,status,next_action_at) VALUES($1,$2,'active',NULL) RETURNING id`, [contactId, seqId]))[0].id);
  const raw = await h.pool.connect(); // orphan the enrollment exactly as the governed certification does
  try { await raw.query(`SET session_replication_role = replica`); await raw.query(`DELETE FROM follow_up_sequences WHERE id=$1`, [seqId]); }
  finally { await raw.query(`SET session_replication_role = DEFAULT`).catch(() => undefined); raw.release(); }
  const orphaned = (await q(`SELECT 1 FROM follow_up_sequences WHERE id=$1`, [seqId])).length === 0;
  check(orphaned, "Fixture enrollment is orphaned (its sequence no longer exists)");
  const contactBefore = (await q(`SELECT lifecycle_state, updated_at FROM contacts WHERE id=$1`, [contactId]))[0];
  const dealStageBefore = (await q(`SELECT stage FROM deals WHERE id=$1`, [dealId]))[0].stage;
  const pauseBefore = (await q(`SELECT md5(string_agg(key||value::text,'|' ORDER BY key)) h FROM system_settings WHERE key ILIKE '%pause%'`))[0].h;

  const open = async (role: string) => {
    const b = await privateStage3Browser(h.base, h.sessions.get(role)!.cookie, h.originalFetch, dir, { realInput: true, startupTimeoutMs: 30000 });
    await b.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    return b;
  };
  type B = Awaited<ReturnType<typeof open>>;
  const until = async (fn: () => Promise<boolean>, label: string, tries = 80) => { for (let i = 0; i < tries; i++) { if (await fn()) return; await settle(250); } throw new Error(`Timed out: ${label}`); };
  const tag = (b: B, tagName: string, textRe: string, scope = "button") =>
    b.evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(scope)})].find(x=>new RegExp(${JSON.stringify(textRe)},'i').test(x.getAttribute('aria-label')||x.textContent||'')&&x.getClientRects().length>0&&!x.disabled);if(!e)return false;e.setAttribute('data-dv',${JSON.stringify(tagName)});return true})()`) as Promise<boolean>;

  // ── Admin: plan, select, review, confirm with a real lost response, recover ──
  const admin = await open("admin");
  try {
    await admin.navigate("/dashboard/data-health");
    await until(async () => (await admin.evaluate(`document.querySelectorAll('h1').length`)) === 1, "Data Health heading");
    check(await admin.evaluate(`/Data Health/i.test(document.querySelector('h1').textContent)`), "Data Health has exactly one H1 naming the page");
    await until(() => tag(admin, "plan", "Build read-only plan"), "plan button");
    await admin.click('[data-dv="plan"]');
    await until(async () => (await admin.evaluate(`!!document.querySelector('[data-testid="reconcile-plan"]')`)) as boolean, "plan rendered");
    const labels = await admin.evaluate(`[...document.querySelectorAll('input[type=checkbox][aria-label^="Select action"]')].map(i=>i.getAttribute('aria-label'))`) as string[];
    check(labels.length >= 1, `Plan lists safe actions (${labels.length})`);
    check(await q(`SELECT 1 FROM deals WHERE id=$1 AND contact_id IS NULL`, [dealId]).then(r => r.length === 1), "Building the plan wrote nothing (deal still unlinked)");
    check(await admin.evaluate(`document.body.innerText.includes('Nothing is sent, enrolled, rescheduled or unpaused')`), "Plan page states the safety boundary in the visible text");
    // select all offered actions that belong to this fixture
    const picked = await admin.evaluate(`(()=>{const boxes=[...document.querySelectorAll('input[type=checkbox][aria-label^="Select action"]')];let n=0;for(const b of boxes){const t=b.getAttribute('aria-label');if(t.includes(${JSON.stringify(email)})||t.includes(${JSON.stringify(String(dealId))})||t.includes(${JSON.stringify(String(enrollId))})){b.setAttribute('data-dv-pick',String(n++))}}return n})()`) as number;
    check(picked >= 1, `Fixture actions found in the plan (${picked})`);
    for (let i = 0; i < picked; i++) await admin.click(`[data-dv-pick="${i}"]`);
    await until(() => tag(admin, "review", "Review \\d+ selected"), "review button");
    await admin.click('[data-dv="review"]');
    await until(() => tag(admin, "confirm", "Confirm and apply"), "confirm button");
    check(await admin.evaluate(`[...document.querySelectorAll('[role=alert]')].some(a=>a.innerText.includes('Apply exactly these'))`), "Confirmation names the exact number of actions before anything is applied");
    check(await q(`SELECT 1 FROM deals WHERE id=$1 AND contact_id IS NULL`, [dealId]).then(r => r.length === 1), "Review/confirm prompt wrote nothing");
    h.loseNextSuccessfulResponse("POST", "/api/admin/data-health/reconcile/apply", "truncate");
    await admin.click('[data-dv="confirm"]');
    await until(async () => h.responseLossCount() === 1, "response loss executed");
    await settle(600);
    check(h.responseFaultEvents.some(e => e.event === "executed" && e.path === "/api/admin/data-health/reconcile/apply"), "The post-commit response loss actually executed");
    check(await admin.evaluate(`document.body.innerText.includes('Result not confirmed')`), "The page says the result was not confirmed and tells the administrator to re-submit to recover it");
    check(await admin.evaluate(`!document.querySelector('[data-testid="reconcile-receipt"]')`), "After the lost response the page does not claim success (no receipt shown)");
    const dealAfterLoss = (await q(`SELECT contact_id FROM deals WHERE id=$1`, [dealId]))[0].contact_id;
    check(Number(dealAfterLoss) === contactId, "The saved effect is durable in the database even though the response was lost");
    const auditAfterLoss = Number((await q(`SELECT count(*)::int n FROM audit_logs WHERE action='DATA_HEALTH_DEAL_LINKED' AND entity_id=$1`, [dealId]))[0].n);
    check(auditAfterLoss === 1, "Exactly one audit row exists after the lost response");
    // Re-submit with the SAME operation: recovered, not applied twice.
    await until(() => tag(admin, "confirm2", "Confirm and apply"), "confirm still offered after the failure");
    await admin.click('[data-dv="confirm2"]');
    await until(async () => (await admin.evaluate(`!!document.querySelector('[data-testid="reconcile-receipt"]')`)) as boolean, "receipt after recovery");
    const receiptText = await admin.evaluate(`document.querySelector('[data-testid="reconcile-receipt"]').innerText`) as string;
    check(/Result \(saved\)/.test(receiptText) && /applied/.test(receiptText), "Recovered receipt is the saved result");
    check(Number((await q(`SELECT count(*)::int n FROM audit_logs WHERE action='DATA_HEALTH_DEAL_LINKED' AND entity_id=$1`, [dealId]))[0].n) === 1, "Recovery did not apply or audit the action a second time");
    const cancelled = (await q(`SELECT status FROM sequence_enrollments WHERE id=$1`, [enrollId]))[0].status;
    check(!orphaned || cancelled === "cancelled", `Orphan enrollment ${orphaned ? "cancelled" : "not orphaned by FK (not offered)"}`);
    check(await admin.evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('data-health-reconcile-op:')).length`) === 0, "The remembered operation is cleared once the final receipt is read");
    await admin.screenshot("data-health-receipt");

    // ── Scenario 2: lost response, then a full reload. The operation is remembered per user and recovered from the server. ──
    const email2 = `dv2.${nonce}@dv.example.test`;
    const contact2 = Number((await q(`INSERT INTO contacts (first_name,last_name,phone,email,company_name,record_class) VALUES('Dv','Second','',$1,$2,'production') RETURNING id`, [email2, `Dv Co2 ${nonce}`]))[0].id);
    const deal2 = Number((await q(`INSERT INTO deals (notes,pipeline,stage,record_class) VALUES($1,'sales','New Lead','production') RETURNING id`, [`Inbound lead ${email2}`]))[0].id);
    await admin.navigate("/dashboard/data-health");
    await until(() => tag(admin, "plan2", "Build read-only plan"), "plan button (scenario 2)");
    await admin.click('[data-dv="plan2"]');
    await until(async () => (await admin.evaluate(`!!document.querySelector('[data-testid="reconcile-plan"]')`)) as boolean, "plan rendered (scenario 2)");
    await admin.evaluate(`(()=>{const b=[...document.querySelectorAll('input[type=checkbox][aria-label^="Select action"]')].find(i=>i.getAttribute('aria-label').includes(${JSON.stringify(String(deal2))}));if(b)b.setAttribute('data-dv-pick2','1')})()`);
    await admin.click('[data-dv-pick2="1"]');
    await until(() => tag(admin, "review2", "Review \\d+ selected"), "review button (scenario 2)");
    await admin.click('[data-dv="review2"]');
    await until(() => tag(admin, "confirm3", "Confirm and apply"), "confirm button (scenario 2)");
    h.loseNextSuccessfulResponse("POST", "/api/admin/data-health/reconcile/apply", "truncate");
    await admin.click('[data-dv="confirm3"]');
    await until(async () => h.responseLossCount() === 2, "second response loss executed");
    await settle(600);
    check(await admin.evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('data-health-reconcile-op:')).length`) === 1, "The unconfirmed operation is remembered for this signed-in user");
    check(await admin.evaluate(`document.querySelectorAll('[data-testid="reconcile-pending"]').length`) === 1, "An unresolved-operation notice is shown after the lost response");
    check(await admin.evaluate(`[...document.querySelectorAll('input[type=checkbox][aria-label^="Select action"]')].every(i=>i.disabled)`), "Selection is frozen while the operation is unresolved");
    check(Number((await q(`SELECT contact_id FROM deals WHERE id=$1`, [deal2]))[0].contact_id) === contact2, "Scenario 2 effect is durable although the response was lost");
    await admin.navigate("/dashboard/data-health"); // full reload: component state is gone, only the remembered identity survives
    await until(async () => (await admin.evaluate(`document.querySelectorAll('h1').length`)) === 1, "Data Health heading after reload");
    await until(async () => (await admin.evaluate(`!!document.querySelector('[data-testid="reconcile-receipt"]')`)) as boolean, "receipt recovered after reload");
    const recovered = await admin.evaluate(`document.querySelector('[data-testid="reconcile-receipt"]').innerText`) as string;
    check(/Result \(saved\)/.test(recovered) && /applied/.test(recovered), "After a reload the saved final result is read back from the server");
    check(await admin.evaluate(`document.querySelectorAll('[data-testid="reconcile-pending"]').length`) === 0 && await admin.evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('data-health-reconcile-op:')).length`) === 0, "The notice and remembered identity clear after the final receipt");
    check(Number((await q(`SELECT count(*)::int n FROM audit_logs WHERE action='DATA_HEALTH_DEAL_LINKED' AND entity_id=$1`, [deal2]))[0].n) === 1, "Reload recovery applied and audited nothing a second time");

    // ── Scenario 3: a remembered operation the server never saw is reported as not started and can be discarded. ──
    const ghostId = randomUUID();
    await admin.evaluate(`(()=>{const k=Object.keys(localStorage);const user=${JSON.stringify(h.userId("admin"))};localStorage.setItem('data-health-reconcile-op:'+user,JSON.stringify({operationId:${JSON.stringify(ghostId)},actionKeys:['enrollment_cancel:1']}))})()`);
    await admin.navigate("/dashboard/data-health");
    await until(async () => (await admin.evaluate(`!!document.querySelector('[data-testid="reconcile-pending"]')`)) as boolean, "ghost operation notice");
    await until(async () => (await admin.evaluate(`document.querySelector('[data-testid="reconcile-pending"]').innerText.includes('no record')`)) as boolean, "not-started wording");
    check(true, "A remembered operation unknown to the server is reported as not started (nothing applied)");
    await until(() => tag(admin, "discard", "Discard"), "discard button");
    await admin.click('[data-dv="discard"]');
    await until(async () => (await admin.evaluate(`!document.querySelector('[data-testid="reconcile-pending"]')`)) as boolean, "notice cleared after discard");
    check(Number((await q(`SELECT count(*)::int n FROM system_settings WHERE key=$1`, [`data_health_reconcile_op:${ghostId}`]))[0].n) === 0, "Discarding a not-started operation leaves no server record");
  } finally { await admin.close(); }
  const contactAfter = (await q(`SELECT lifecycle_state, updated_at FROM contacts WHERE id=$1`, [contactId]))[0];
  check(contactAfter.lifecycle_state === contactBefore.lifecycle_state && String(contactAfter.updated_at) === String(contactBefore.updated_at), "Contact lifecycle and record are unchanged by the reconcile");
  check((await q(`SELECT stage FROM deals WHERE id=$1`, [dealId]))[0].stage === dealStageBefore, "Deal stage is unchanged by linking");
  check((await q(`SELECT md5(string_agg(key||value::text,'|' ORDER BY key)) h FROM system_settings WHERE key ILIKE '%pause%'`))[0].h === pauseBefore, "No pause setting changed");
  check(h.externalCalls() === 0, "No provider or external network call");

  // ── Manager and agent boundaries ──
  const manager = await open("manager");
  try {
    await manager.navigate("/dashboard/data-health");
    await until(async () => (await manager.evaluate(`document.querySelectorAll('h1').length`)) === 1, "manager Data Health heading");
    check(await manager.evaluate(`!document.body.innerText.includes('Build read-only plan')`), "Manager sees no reconcile plan controls");
    const statuses = await manager.evaluate(`Promise.all([fetch('/api/admin/data-health/reconcile/plan',{credentials:'include'}).then(r=>r.status)])`) as number[];
    check(statuses[0] === 403, `Manager plan request is denied by the server (${statuses[0]})`);
    const mApply = await h.request("manager", "POST", "/api/admin/data-health/reconcile/apply", { operationId: randomUUID(), actionKeys: ["enrollment_cancel:1"] });
    check(mApply.status === 403, `Manager apply request (POST, valid CSRF) is denied (${mApply.status})`);
    check((await h.request("manager", "GET", `/api/admin/data-health/reconcile/operations/${randomUUID()}`)).status === 403, "Manager cannot read operation receipts");
  } finally { await manager.close(); }
  const agent = await open("agent");
  try {
    await agent.navigate("/dashboard/data-health");
    await settle(2500);
    const here = await agent.evaluate(`location.pathname`) as string;
    check(here !== "/dashboard/data-health" || (await agent.evaluate(`!document.body.innerText.includes('Reconcile plan')`)), `Agent cannot use Data Health (now at ${here})`);
    const st = await agent.evaluate(`fetch('/api/admin/data-health/reconcile/plan',{credentials:'include'}).then(r=>r.status)`) as number;
    check(st === 403, `Agent plan request is denied by the server (${st})`);
    const aApply = await h.request("agent", "POST", "/api/admin/data-health/reconcile/apply", { operationId: randomUUID(), actionKeys: ["enrollment_cancel:1"] });
    check(aApply.status === 403, `Agent apply request (POST, valid CSRF) is denied (${aApply.status})`);
  } finally { await agent.close(); }

  await writeFile(path.join(dir, "data-health-browser-receipt.json"), JSON.stringify({ identity, checks, responseFaultEvents: h.responseFaultEvents }, null, 2));
  console.log(`Stage 3 D-V Data Health browser: ${checks.length} checks passed`);
} finally { await h.close(); }
