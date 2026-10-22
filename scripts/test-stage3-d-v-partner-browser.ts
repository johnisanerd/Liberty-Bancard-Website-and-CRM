import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { privateStage3Browser } from "./fixtures/private-stage3-browser";
import { verifyCandidateIdentity } from "./fixtures/candidate-build-identity";

// F02 and the partner response repair in a real browser against the REAL partner handlers: successful, truly empty,
// forbidden (403) and unavailable (500) states on both partner pages, expanded referrals (success, forbidden, unavailable),
// Retry recovering, no credential value in the rendered page, and no credential key in the response the page received.
const identity = await verifyCandidateIdentity();
const directory = "docs/certification/stage3-d-v/partner-browser";
const SENTINEL = "SENTINEL-PW-HASH-b17e", TOKEN = "SENTINEL-RESET-TOKEN-0d3a";
const checks: string[] = [];
let mode: "pass" | "403" | "500" = "pass";
let referralMode: "pass" | "403" | "500" = "pass";
const h = await stage3BHttpFixture(async app => {
  app.use("/api/partners/referral-pipeline", (_req, res, next) => mode === "403" ? res.status(403).json({ message: "Forbidden" }) : mode === "500" ? res.status(500).json({ message: "Internal server error" }) : next());
  app.use("/api/referrals", (_req, res, next) => referralMode === "403" ? res.status(403).json({ message: "Forbidden" }) : referralMode === "500" ? res.status(500).json({ message: "Internal server error" }) : next());
  const { registerPartnersRoutes } = await import("../server/routes/partners.ts");
  const { registerOnboardingStagesRoutes } = await import("../server/routes/onboarding-stages.ts");
  registerPartnersRoutes(app); registerOnboardingStagesRoutes(app);
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
const body = () => browser!.evaluate("document.body.innerText") as Promise<string>;
const metrics = () => browser!.evaluate(`[...document.querySelectorAll('[data-testid^="kpi-"] p.text-xl')].map(e=>e.textContent.trim())`) as Promise<string[]>;
const pages = ["/dashboard/partner-portal", "/dashboard/partner-referral-pipeline"];
try {
  await mkdir(directory, { recursive: true });
  await h.pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1", [h.prefix + "%"]);
  const tag = h.prefix.slice(-8).toLowerCase();
  const pid = (await h.pool.query(`INSERT INTO partners(company_name,contact_name,email,password_hash,password_reset_token,password_reset_expires_at,partner_type,affiliate_code,status,partner_category)
    VALUES('Browser Partner Co','Pat',$1,$2,$3,NOW()+interval '1 day','referral',$4,'active','referral') RETURNING id`,
    [`${h.prefix}-bp@example.test`, SENTINEL, TOKEN, `${tag}-bp`])).rows[0].id as number;
  const c = (await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class) VALUES('Ref','Lead',$1,'','production') RETURNING id`, [`${h.prefix}-bpl@example.test`])).rows[0].id;
  await h.pool.query(`INSERT INTO referrals(partner_id,contact_id,referred_name,referred_company,status) VALUES($1,$2,'Referred Person','Referred Co','pending')`, [pid, c]);
  await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,record_class,total_volume) VALUES($1,'sales','Negotiation / Follow-Up','production','2500')`, [c]);

  browser = await privateStage3Browser(h.base, "", h.originalFetch, directory, { realInput: true });
  await browser.navigate("/login"); await browser.waitFor(/Sign In/);
  await browser.set('[data-testid="input-email"]', h.email("admin")); await browser.set('[data-testid="input-password"]', h.password);
  await browser.click('[data-testid="button-login"]'); await browser.waitFor(/Dashboard|Today|My Day/);
  await browser.evaluate("localStorage.setItem('liberty_setup_notice_hidden','true');localStorage.setItem('libertycrm_tour_completed','true');localStorage.setItem('prefer_desktop','true')");

  for (const route of pages) {
    const name = route.split("/").pop()!;
    // Successful
    mode = "pass"; referralMode = "pass";
    await browser.navigate(route);
    await until(`document.body.innerText.includes('Browser Partner Co')`, `${name} success`);
    let m = await metrics();
    assert.ok(m.length >= 3 && !m.includes("Unavailable") && m.some(v => v.includes("2,500") || v.includes("2500")), `${name} success metrics are real values including the 2,500 open volume: ${m}`);
    let text = await body();
    assert.ok(/Open Pipeline Volume/.test(text) && !/Pipeline Value/.test(text), `${name} labels the figure as open pipeline volume`);
    assert.ok(!text.includes(SENTINEL) && !text.includes(TOKEN), `${name} page shows no credential value`);
    const received = JSON.parse(await browser.evaluate(`fetch('/api/partners/referral-pipeline',{credentials:'include'}).then(r=>r.text())`) as string) as any[];
    const keys = Object.keys(received[0]);
    assert.ok(!keys.some(k => /pass|token|hash|invite|reset|paypal/i.test(k)) && !JSON.stringify(received).includes(SENTINEL), `${name} received no credential key`);
    checks.push(`${route}: successful state shows real metrics and the open-volume label; no credential value rendered or received`);
    await browser.screenshot(`${name}-success`);

    if (route === "/dashboard/partner-portal") {
      // Expanded referrals: success, forbidden, unavailable, retry.
      await browser.click(`[data-testid="partner-card-${pid}"] button`);
      await until(`document.body.innerText.includes('Referred Person') || document.body.innerText.includes('Referred Co')`, "expanded referrals");
      checks.push("expanded referrals: successful state lists the referral");
      for (const [kind, expectation] of [["403", /do not have access/i], ["500", /could not be loaded/i]] as const) {
        referralMode = kind;
        await browser.navigate(route);
        await until(`!!document.querySelector('[data-testid="partner-card-${pid}"] button')`);
        await browser.click(`[data-testid="partner-card-${pid}"] button`);
        await until(`${expectation.toString()}.test(document.body.innerText)`, `expanded ${kind}`);
        assert.ok(!/No referrals on record/.test(await body()), `expanded ${kind} does not claim the partner has no referrals`);
        checks.push(`expanded referrals: ${kind} shows ${kind === "403" ? "denied" : "unavailable"}, not an empty list`);
      }
      referralMode = "pass";
    }
    // Forbidden and unavailable
    for (const [kind, expectation] of [["403", /do not have access/i], ["500", /could not be loaded/i]] as const) {
      mode = kind;
      await browser.navigate(route);
      await until(`${expectation.toString()}.test(document.body.innerText)`, `${name} ${kind}`);
      text = await body(); m = await metrics();
      assert.ok(!/No partners in the program yet/.test(text) && m.every(v => v === "Unavailable"), `${name} ${kind}: no empty claim, metrics Unavailable (${m})`);
      // A denied read is not retryable by design (the actor lacks access); an unavailable read offers Retry.
      assert.equal(/Try Again|Retry/i.test(text), kind === "500", `${name} ${kind}: Retry ${kind === "500" ? "offered" : "not offered for a denied read"}`);
      if (kind === "500") {
        mode = "pass";
        await browser.evaluate(`[...document.querySelectorAll('button')].find(b=>/Try Again|Retry/i.test(b.textContent))?.click()`);
        await until(`document.body.innerText.includes('Browser Partner Co')`, `${name} Retry recovers`);
        checks.push(`${route}: Retry after an unavailable read recovers to the successful state`);
      }
      checks.push(`${route}: ${kind === "403" ? "forbidden" : "unavailable"} state with no empty claim and metrics Unavailable`);
      await browser.screenshot(`${name}-${kind}`);
    }
  }
  // Truly empty: the reads succeed and there are no partners.
  await h.pool.query("DELETE FROM referrals WHERE partner_id=$1", [pid]); await h.pool.query("DELETE FROM partners WHERE id=$1", [pid]);
  mode = "pass";
  await browser.navigate("/dashboard/partner-portal");
  await until(`/No partners in the program yet/.test(document.body.innerText)`, "empty state");
  const em = await metrics();
  assert.ok(em.every(v => v !== "Unavailable"), `empty state shows real zeros, not Unavailable (${em})`);
  checks.push("/dashboard/partner-portal: a successful read with no partners shows the empty state and real zero metrics");
  await browser.screenshot("partner-portal-empty");
  await writeFile(`${directory}/receipt.json`, JSON.stringify({ status: "passed", candidate: identity, checks,
    scope: "real partner and referral-pipeline handlers; 403 and 500 injected by middleware ahead of the real handler; admin session, desktop viewport; agent and manager sessions are covered by the API role matrix, not driven in this browser" }, null, 2));
  console.log(checks.map(x => `✓ ${x}`).join("\n")); console.log("Stage 3 D-V partner browser: PASS");
} finally { await browser?.close(); await h.close(); }
