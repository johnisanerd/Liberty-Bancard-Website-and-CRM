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
        const first = s.stepOrder === 1;
        assert(s.text.includes(content.SFP_SECURE_UPLOAD_URL) === !first, `${key}/${audience}/${s.stepOrder}: upload CTA only in follow-ups`);
        assert((s.text.match(/https?:\/\//g) ?? []).length === (first ? 0 : 1), `${key}/${audience}/${s.stepOrder}: URL count`);
        assert(/Scott Stevenson\nLiberty Bancard\n954-266-8214 \| libertybancard\.com$/.test(s.text), `${key}/${audience}/${s.stepOrder}: single polished signature (text)`);
        assert((s.text.match(/Liberty Bancard/g) ?? []).length === 1 + Number(/Liberty Bancard about/.test(s.text)), `${key}/${audience}/${s.stepOrder}: one signature in text`);
        assert((s.html.match(/data-sfp-signature/g) ?? []).length === 1, `${key}/${audience}/${s.stepOrder}: one signature block in html`);
        assert(!/data-can-spam-footer/.test(s.html), `${key}/${audience}/${s.stepOrder}: no footer in the rendered body (transport adds the one footer)`);
        assert(s.html.indexOf("<img") > s.html.indexOf("954-266-8214") && s.html.includes('alt="Liberty Bancard logo"') && (s.html.match(/<img/g) ?? []).length === 1,
          `${key}/${audience}/${s.stepOrder}: single logo beneath the signature with alt text`);
        assert(first ? !s.html.includes("upload-statement") : s.html.includes(`<a href="${content.SFP_SECURE_UPLOAD_URL}">`), `${key}/${audience}/${s.stepOrder}: link rendered where expected`);
        assert(!/\{\{|\}\}|undefined/.test(s.html + s.text + s.subject), `${key}/${audience}/${s.stepOrder}: no unresolved placeholders`);
      });
      checks += 3 * 12;
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

  // Versioned republish: a content/presentation version bump rewrites the home rows IN PLACE (recipients, enrollments and
  // receipts are keyed by the sequence) and pins a new version to them; the old version is superseded.
  await pool.query(`UPDATE sequence_steps SET body=replace(body,' edited','') WHERE sequence_id=$1 AND step_order=2`, [emptySeq]);
  const beforeRepublish = (await pool.query(`SELECT v.package_key, v.id, v.sequence_id, v.campaign_id, v.content_hash FROM sfp_campaign_package_versions v WHERE lifecycle_state='current' ORDER BY package_key`)).rows;
  const stepIdsBefore = (await pool.query(`SELECT string_agg(id::text,',' ORDER BY step_order) ids FROM sequence_steps WHERE sequence_id=$1`, [emptySeq])).rows[0].ids;
  await pool.query(`UPDATE sequence_steps SET body='stale presentation-era text' WHERE sequence_id=$1 AND step_order=1`, [emptySeq]);
  await pool.query(`UPDATE sfp_campaign_package_versions SET notes='{"contentVersion":"legacy-1","map":[]}' WHERE lifecycle_state='current'`);
  const republished = await content.populateSfpLaunchContentV2({ actorId: "cert" });
  check(republished.every(r => r.status === "populated"), `A content/presentation version change republishes every package (${JSON.stringify(republished.map(r => r.reason ?? r.status))})`);
  const afterRepublish = (await pool.query(`SELECT v.package_key, v.id, v.sequence_id, v.campaign_id, v.content_hash FROM sfp_campaign_package_versions v WHERE lifecycle_state='current' ORDER BY package_key`)).rows;
  check(afterRepublish.every((a: any, i: number) => a.id !== beforeRepublish[i].id && a.content_hash !== beforeRepublish[i].content_hash
    && a.sequence_id === beforeRepublish[i].sequence_id && a.campaign_id === beforeRepublish[i].campaign_id), "Republish pins a new version to the SAME campaign and sequence");
  check((await pool.query(`SELECT string_agg(id::text,',' ORDER BY step_order) ids FROM sequence_steps WHERE sequence_id=$1`, [emptySeq])).rows[0].ids === stepIdsBefore, "Step identities are preserved by the in-place rewrite");
  check((await pool.query(`SELECT body FROM sequence_steps WHERE sequence_id=$1 AND step_order=1`, [emptySeq])).rows[0].body.includes("free statement review"), "The rewrite installed the current launch text");
  check((await pool.query(`SELECT status FROM follow_up_sequences s JOIN sfp_campaign_package_versions v ON v.sequence_id=s.id WHERE v.lifecycle_state='current'`)).rows.every((r: any) => r.status === "paused"), "Republished sequences are paused");
  check((await content.verifySfpLaunchContentV2()).ok, "Republished packages verify");

  // A package pinned to a COPY of its rows (the earlier republish shape) returns to its home sequence; the copy is retired.
  const home = (await pool.query(`SELECT v.id, v.campaign_id, v.sequence_id FROM sfp_campaign_package_versions v WHERE package_key='sfp.automotive.v2' AND lifecycle_state='current'`)).rows[0];
  const copyCampaign = (await pool.query(`INSERT INTO campaigns (name,status,total_steps,content_revision) SELECT name||' copy','draft',total_steps,1 FROM campaigns WHERE id=$1 RETURNING id`, [home.campaign_id])).rows[0].id;
  const copySeq = (await pool.query(`INSERT INTO follow_up_sequences (name,status,trigger_type,trigger_config,total_steps,sequence_family) SELECT name||' copy','paused',trigger_type,trigger_config,0,sequence_family FROM follow_up_sequences WHERE id=$1 RETURNING id`, [home.sequence_id])).rows[0].id;
  await pool.query(`UPDATE sfp_campaign_package_versions SET lifecycle_state='superseded',superseded_at=NOW() WHERE id=$1`, [home.id]);
  await pool.query(`INSERT INTO sfp_campaign_package_versions (package_key,vertical,campaign_id,campaign_name,sequence_id,sequence_name,sequence_family,content_hash,lifecycle_state,effective_at,actor_id,notes)
    SELECT package_key,vertical,$2,campaign_name||' copy',$3,sequence_name||' copy',sequence_family,'copyhash','current',NOW(),'cert',notes FROM sfp_campaign_package_versions WHERE id=$1`, [home.id, copyCampaign, copySeq]);
  const rehomed = (await content.populateSfpLaunchContentV2({ actorId: "cert" })).find(r => r.packageKey === "sfp.automotive.v2");
  const homeAfter = (await pool.query(`SELECT campaign_id, sequence_id FROM sfp_campaign_package_versions WHERE package_key='sfp.automotive.v2' AND lifecycle_state='current'`)).rows[0];
  check(rehomed?.status === "populated" && homeAfter.sequence_id === home.sequence_id && homeAfter.campaign_id === home.campaign_id, `A package pinned to a copy returns to its home rows (${rehomed?.reason ?? rehomed?.status})`);
  check((await pool.query(`SELECT retired_at FROM follow_up_sequences WHERE id=$1`, [copySeq])).rows[0].retired_at !== null, "The copy sequence is retired");
  check((await content.populateSfpLaunchContentV2({ actorId: "cert" })).every(r => r.status === "already_current"), "Republish is idempotent");
  // The presentation is part of the pinned hash: a different presentation fingerprint changes the live hash.
  const pres = await import("../../server/services/cro03/sfp-launch-presentation");
  const sig = pres.renderSfpLaunchSignatureHtml({ agentName: "A", agentPhone: "1" });
  check(pres.sfpLaunchPresentationFingerprint().length === 64 && sig.includes(pres.SFP_LAUNCH_LOGO_URL), "Presentation fingerprint is derived from the rendered signature markup");
  let dup = false;
  try { pres.applySfpLaunchPresentation(`<p>x</p>${sig}`, { agentName: "A", agentPhone: "1" }); } catch { dup = true; }
  check(dup, "A body that already carries a signature is refused");

  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider or network call was attempted");
  console.log(`PASS SFP launch content (${checks} checks)`);
} finally {
  await pool.end().catch(() => {});
}
