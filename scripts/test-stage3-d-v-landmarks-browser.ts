import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { privateStage3Browser } from "./fixtures/private-stage3-browser";
import { verifyCandidateIdentity } from "./fixtures/candidate-build-identity";

// U1 and F02 in a real browser. U1: Canonical Enrichment, direct and embedded in Lead Ops, has exactly one main and one h1.
// F02: with the partner read unavailable (the isolated fixture registers no partner routes, so the real read answers 501),
// both partner pages show an unavailable state with Retry and "Unavailable" metrics, never zeros or "No partners".
const identity = await verifyCandidateIdentity();
const directory = "docs/certification/stage3-d-v/landmarks-browser";
const checks: string[] = [];
const h = await stage3BHttpFixture(async app => {
  app.use("/api", (req, res, next) => {
    if (req.path === "/partners/referral-pipeline") return res.status(501).json({ message: "Unregistered isolated service" });
    next();
  });
  app.use("/api", (_req, res) => res.status(501).json({ message: "Unregistered isolated service" }));
  const { static: serveStatic } = await import("express");
  app.use(serveStatic("dist/public"));
  app.use((_req, res) => res.sendFile("index.html", { root: `${process.cwd()}/dist/public` }));
});
let browser: Awaited<ReturnType<typeof privateStage3Browser>> | undefined;
const until = async (expression: string, label = expression) => {
  for (let n = 0; n < 300; n++) { if (await browser!.evaluate(expression)) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`UI condition not reached: ${label}`);
};
try {
  await mkdir(directory, { recursive: true });
  await h.pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1", [h.prefix + "%"]);
  browser = await privateStage3Browser(h.base, "", h.originalFetch, directory, { realInput: true });
  await browser.navigate("/login"); await browser.waitFor(/Sign In/);
  await browser.set('[data-testid="input-email"]', h.email("admin")); await browser.set('[data-testid="input-password"]', h.password);
  await browser.click('[data-testid="button-login"]'); await browser.waitFor(/Dashboard|Today|My Day/);
  await browser.evaluate("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");
  const landmarks = async () => JSON.parse(await browser!.evaluate(`JSON.stringify({main:document.querySelectorAll('main').length,h1:document.querySelectorAll('h1').length,enrichment:!!document.querySelector('[data-testid="canonical-enrichment"]')})`) as string);

  await browser.navigate("/dashboard/canonical-enrichment");
  await until(`!!document.querySelector('[data-testid="canonical-enrichment"]')`);
  await new Promise(r => setTimeout(r, 1500));
  let l = await landmarks();
  assert.equal(l.main, 1, `direct Canonical Enrichment has one main (got ${l.main})`); assert.equal(l.h1, 1, `one h1 (got ${l.h1})`);
  checks.push("Canonical Enrichment direct page: exactly one main and one h1");
  await browser.navigate("/dashboard/lead-ops?area=canonical&tab=canonical");
  await until(`!!document.querySelector('[data-testid="canonical-enrichment"]')`, "embedded enrichment");
  await new Promise(r => setTimeout(r, 1500));
  l = await landmarks();
  assert.equal(l.main, 1, `embedded Canonical Enrichment has one main (got ${l.main})`); assert.equal(l.h1, 1, `one h1 (got ${l.h1})`);
  checks.push("Canonical Enrichment embedded in Lead Ops: exactly one main and one h1");

  for (const route of ["/dashboard/partner-portal", "/dashboard/partner-referral-pipeline"]) {
    await browser.navigate(route);
    await until(`!!document.querySelector('[data-crm-state="unavailable"]') || /could not be loaded/i.test(document.body.innerText)`, `${route} unavailable state`);
    const body = await browser.evaluate("document.body.innerText") as string;
    assert.ok(/could not be loaded/i.test(body) && /Try Again|Retry/i.test(body), `${route} shows the failure with Retry`);
    assert.ok(!/No partners in the program yet|No partners found/.test(body), `${route} does not claim the program is empty`);
    const metrics = await browser.evaluate(`[...document.querySelectorAll('[data-testid^="kpi-"] p.text-xl')].map(e=>e.textContent.trim())`) as string[];
    assert.ok(metrics.length >= 3 && metrics.every(m => m === "Unavailable"), `${route} metrics read Unavailable, not zero: ${metrics}`);
    checks.push(`${route}: failed read shows unavailable + Retry, metrics Unavailable, no empty-program claim`);
    await browser.screenshot(route.split("/").pop()!);
  }
  await writeFile(`${directory}/receipt.json`, JSON.stringify({ status: "passed", candidate: identity, checks, scope: "1280px desktop, admin session, isolated fixture; denied (403) and real-success partner states are covered by contract/unit checks only" }, null, 2));
  console.log(checks.map(c => `✓ ${c}`).join("\n")); console.log("Stage 3 D-V landmarks browser: PASS");
} finally { await browser?.close(); await h.close(); }
