import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "SFP launch content certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });

const render = await import("../../server/services/message-render");
const { db, pool } = await import("../../server/db");
const packages = await import("../../server/services/cro03/sfp-campaign-packages");
const content = await import("../../server/services/cro03/sfp-launch-content");
const release = await import("../../server/services/sfp-canonical-release");

let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };

try {
  // ── Renderer: greeting, escaping, unresolved tokens ───────────────────────
  const person = { firstName: "Maria", email: "maria@acme-shop.test", companyName: "Acme & Sons", agentName: "Scott Stevenson", agentPhone: "954-266-8214" };
  const named = render.renderTemplate("Hi {{firstName}},\n\nAbout {{companyName}}.", person, { format: "html" });
  check(named.greeting === "person" && named.output.startsWith("Hi Maria,"), "A genuine person name gets a person greeting");
  check(named.output.includes("Acme &amp; Sons"), "Values are HTML-escaped");
  const role = render.renderTemplate("Hi {{firstName}},\n\nx", { ...person, firstName: "Precision Auto Glass Contact", email: "info@acme-shop.test" }, { format: "text" });
  check(role.greeting === "generic" && role.output.startsWith("Hello,"), "A role mailbox / company-like name renders Hello,");
  const missing = render.renderTemplate("Hi {{first_name}},\n\nx {{firstName}}", { ...person, firstName: null }, { format: "text" });
  check(missing.output.startsWith("Hello,") && missing.output.endsWith("x there"), "Missing name renders Hello, and never leaves a token");
  const dollar = render.renderTemplate("{{companyName}}", { ...person, companyName: "Cash $& $1 Co" }, { format: "text" });
  check(dollar.output === "Cash $& $1 Co", "Replacement patterns in values are literal");
  const snake = render.renderTemplate("{{company_name}} {{agent_phone}} {{contact.companyName}}", person, { format: "text" });
  check(snake.output === "Acme & Sons 954-266-8214 Acme & Sons", "camelCase, snake_case and contact.* tokens are one vocabulary");
  for (const bad of ["{{unknownThing}}", "Hi [FIRST NAME]", "%FIRSTNAME%", "{companyName}", "x undefined y"]) {
    let threw = false;
    try { render.renderTemplate(bad, person, { format: "text" }); } catch (e) { threw = e instanceof render.RenderError; }
    check(threw, `Unresolved or bracketed placeholder is rejected: ${bad}`);
  }
  let emptyRequired = false;
  try { render.renderTemplate("{{companyName}}", { ...person, companyName: "" }, { format: "text", required: ["companyName"] }); }
  catch (e) { emptyRequired = e instanceof render.RenderError; }
  check(emptyRequired, "An empty required value fails instead of rendering a blank");
  let badUrl = false;
  try { render.plainHtmlToEmailHtml("see https://evil.example.com/x", ["libertybancard.com"]); } catch (e) { badUrl = e instanceof render.RenderError; }
  check(badUrl, "A URL outside the approved host list is rejected");

  // ── Launch copy: every vertical x audience renders cleanly ────────────────
  const forbidden = [/10\s*[–-]\s*30%/, /hundreds/i, /70\s*\/\s*30|70%/, /\bRe:/, /\$1,6\d\d/, /\$1\.87/, /\/upload(?!-statement)/, /\{\{|\}\}/, /\[[A-Za-z ]+\]/,
    /email (?:us|me) (?:your|a) statement/i, /forward(?:ing)? your (?:last )?(?:processing )?statement/i, /24 hours/i, /guarantee/i, /\bundefined\b/];
  for (const key of packages.SFP_PACKAGE_KEYS_V2) {
    for (const audience of ["named_contact", "role_mailbox", "missing_name"] as const) {
      const steps = content.renderLaunchPreview(key, audience);
      check(steps.length === 3, `${key}/${audience}: three email touches`);
      steps.forEach((s) => {
        for (const re of forbidden) assert(!re.test(s.subject) && !re.test(s.text) && !re.test(s.html), `${key}/${audience}/${s.stepOrder}: forbidden ${re}`);
        assert(s.text.includes(content.SFP_SECURE_UPLOAD_URL), `${key}/${audience}/${s.stepOrder}: secure upload CTA present`);
        assert((s.text.match(/https?:\/\//g) ?? []).length === 1, `${key}/${audience}/${s.stepOrder}: exactly one URL`);
        assert(/Scott Stevenson\nLiberty Bancard\n954-266-8214$/.test(s.text), `${key}/${audience}/${s.stepOrder}: single sign-off`);
        assert(s.html.includes(`<a href="${content.SFP_SECURE_UPLOAD_URL}">`), `${key}/${audience}/${s.stepOrder}: link rendered`);
      });
      checks += 3 * 5;
      if (audience === "named_contact") check(steps[0].text.startsWith("Hi Maria,"), `${key}: touch 1 greets a named contact`);
      else check(steps[0].text.startsWith("Hello,"), `${key}/${audience}: touch 1 renders Hello,`);
      check(steps[1].text.startsWith("Hello,") && steps[2].text.startsWith("Hello,"), `${key}/${audience}: follow-ups use the generic greeting`);
    }
  }

  // ── Database: sources, W6 template and v2 packages (real writers) ─────────
  const tag = randomUUID().slice(0, 8);
  await pool.query(`INSERT INTO follow_up_sequences (name,status,trigger_type,trigger_config,total_steps,sequence_family)
    VALUES ($1,'paused','contact_created','{}'::jsonb,5,'cold-email-manual-call')`, [`W6 fixture ${tag}`]);
  const sources: Record<string, number> = {};
  for (const name of ["SDR-01: Statement Review Cold Outreach", "SDR-05: Medical / Dental / Medspa", "SDR-07: Auto / Service / Trades", "SDR-10: Salon / Spa / Beauty"]) {
    const c = (await pool.query(`INSERT INTO campaigns (name,status,total_steps,created_by) VALUES ($1,'draft',5,'cert') RETURNING id`, [name])).rows[0];
    sources[name] = Number(c.id);
    for (let i = 1; i <= 5; i++) {
      await pool.query(`INSERT INTO campaign_steps (campaign_id,step_order,step_type,delay_days,subject,body_template,channel)
        VALUES ($1,$2,'follow_up',$3,$4,$5,'email')`, [c.id, i, i * 2, `Source ${name} ${i}`, `Original body ${name} ${i} most find 10–30%`]);
    }
  }
  const sourceHashBefore = (await pool.query(`SELECT md5(string_agg(subject||body_template,'|' ORDER BY id)) h FROM campaign_steps WHERE campaign_id = ANY($1)`, [Object.values(sources)])).rows[0].h;

  const applied = await packages.applyPackageConvergenceV2({ actorId: `cert:${tag}` });
  check(applied.length === 5 && applied.every((r: any) => r.status === "created"), "Convergence creates five placeholder packages");
  const empty = await content.verifySfpLaunchContentV2();
  check(!empty.ok && empty.packages.every(p => p.issues.includes("SEQUENCE_HAS_NO_STEPS")), "Empty packages fail launch readiness");
  const emptySeq = Number((await pool.query(`SELECT sequence_id FROM sfp_campaign_package_versions WHERE package_key='sfp.automotive.v2' AND lifecycle_state='current'`)).rows[0].sequence_id);
  check(!(await release.sequenceHasLaunchReadyContent(emptySeq)), "An empty sequence can never be released");

  const dry = await content.populateSfpLaunchContentV2({ actorId: "cert", dryRun: true });
  check(dry.every(r => r.status === "would_populate"), "Dry run reports the plan without writing");
  check(Number((await pool.query(`SELECT count(*) c FROM sequence_steps WHERE sequence_id=$1`, [emptySeq])).rows[0].c) === 0, "Dry run wrote nothing");

  const before = (await pool.query(`SELECT id,package_key,content_hash FROM sfp_campaign_package_versions WHERE lifecycle_state='current' ORDER BY package_key`)).rows;
  const done = await content.populateSfpLaunchContentV2({ actorId: `cert:${tag}` });
  check(done.length === 5 && done.every(r => r.status === "populated"), `Populate writes all five packages (${done.map(d => d.status + (d.reason ? ":" + d.reason : "")).join(",")})`);
  const current = (await pool.query(`SELECT id,package_key,content_hash,notes FROM sfp_campaign_package_versions WHERE lifecycle_state='current' ORDER BY package_key`)).rows;
  check(current.length === 5 && current.every((c: any) => !before.some((b: any) => b.id === c.id || b.content_hash === c.content_hash)),
    "Each package got a NEW immutable version with a new content hash");
  const superseded = (await pool.query(`SELECT count(*) c FROM sfp_campaign_package_versions WHERE lifecycle_state='superseded' AND superseded_at IS NOT NULL`)).rows[0].c;
  check(Number(superseded) === 5, "Prior versions are superseded, not mutated or deleted");
  check(current.every((c: any) => { const n = JSON.parse(c.notes); return n.map.length === 3 && n.map.every((m: any) => m.reason && m.cta && m.revisedBodyHash && m.source.primary); }),
    "Each version records source, hashes, delay, CTA and reason per step");
  const verified = await content.verifySfpLaunchContentV2();
  check(verified.ok && verified.packages.every(p => p.stepCount === 3), `Verify passes with real child counts (${JSON.stringify(verified.packages.filter(p => !p.ok))})`);
  const steps = (await pool.query(`SELECT step_order,delay_days,delay_hours,action_type,config FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order`, [emptySeq])).rows;
  check(steps.map((s: any) => s.delay_days).join(",") === "0,3,5" && steps.every((s: any) => s.action_type === "email" && s.delay_hours === 0), "Relative delays are 0,3,5 days and all steps are email");
  check(await release.sequenceHasLaunchReadyContent(emptySeq), "A populated package sequence is release-eligible");
  const sourceHashAfter = (await pool.query(`SELECT md5(string_agg(subject||body_template,'|' ORDER BY id)) h FROM campaign_steps WHERE campaign_id = ANY($1)`, [Object.values(sources)])).rows[0].h;
  check(sourceHashBefore === sourceHashAfter, "Source library steps are untouched");
  check(Number((await pool.query(`SELECT count(*) c FROM sfp_campaign_package_versions WHERE lifecycle_state='current'`)).rows[0].c) === 5, "Exactly one current version per package");
  check((await pool.query(`SELECT status FROM campaigns c JOIN sfp_campaign_package_versions v ON v.campaign_id=c.id WHERE v.lifecycle_state='current'`)).rows.every((r: any) => r.status === "draft"), "Campaigns stay draft");
  check((await pool.query(`SELECT status FROM follow_up_sequences s JOIN sfp_campaign_package_versions v ON v.sequence_id=s.id WHERE v.lifecycle_state='current'`)).rows.every((r: any) => r.status === "paused"), "Sequences stay paused");

  const again = await content.populateSfpLaunchContentV2({ actorId: "cert" });
  check(again.every(r => r.status === "already_current"), "Re-running is idempotent");
  check(Number((await pool.query(`SELECT count(*) c FROM sfp_campaign_package_versions`)).rows[0].c) === 10, "Re-running created no extra versions");

  // A drifted live step is detected, never silently re-pinned.
  await pool.query(`UPDATE sequence_steps SET body=body||' edited' WHERE sequence_id=$1 AND step_order=2`, [emptySeq]);
  const drift = await content.verifySfpLaunchContentV2();
  check(!drift.ok && drift.packages.some(p => p.issues.includes("PINNED_HASH_DIFFERS_FROM_LIVE_CONTENT")), "Live content that differs from its pinned hash fails readiness");
  const drifted = await content.populateSfpLaunchContentV2({ actorId: "cert" });
  check(drifted.find(r => r.packageKey === "sfp.automotive.v2")?.status === "skipped_needs_review", "Populate refuses to overwrite different existing steps in place");

  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider or network call was attempted");
  console.log(`PASS SFP launch content (${checks} checks)`);
} finally {
  await pool.end().catch(() => {});
}
