/**
 * Signed-in UI verification of the SFP launch inventory and operator release panel against disposable data.
 * Real persisted sessions (admin and manager logins), the real route handlers and the freshly built client; the
 * browser is private and loopback-only. Nothing is sent: transports are denied and no message provider is configured.
 * Build the client first: npx vite build --outDir generated-artifacts/ui-verify-public
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { stage3BHttpFixture } from "../fixtures/stage3-b-http";
import { privateStage3Browser } from "../fixtures/private-stage3-browser";

const publicDir = path.resolve("generated-artifacts/ui-verify-public");
assert(existsSync(path.join(publicDir, "index.html")), "Build the client into generated-artifacts/ui-verify-public first");
const shots = "generated-artifacts/ui-verify-shots";
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; console.log(`  ok  ${message}`); };

const h = await stage3BHttpFixture(async app => {
  const { registerCanonicalEnrichmentRoutes } = await import("../../server/routes/canonical-enrichment");
  registerCanonicalEnrichmentRoutes(app);
  app.use("/api", (_req, res) => res.status(501).json({ message: "Unregistered isolated verification service" }));
  const { default: express } = await import("express");
  app.use("/assets", express.static(path.join(publicDir, "assets")));
  app.use(express.static(publicDir, { index: false }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
}, undefined, { backgroundProfile: "off" });
const { pool } = h;
const prefix = `ui_launch_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const actor = { role: "admin" as const, actorId: `system:${prefix}`, email: null };
let browser: Awaited<ReturnType<typeof privateStage3Browser>> | undefined;
try {
  await pool.query("UPDATE users SET tour_completed_at=NOW() WHERE id LIKE $1", [h.prefix + "%"]);
  const release = await import("../../server/services/sfp-canonical-release");
  const { prepareCanonicalRecipient } = await import("../../server/services/canonical-recipient-preparation");
  const { previewContactBusinessSystemLinks, applyContactBusinessSystemLink } = await import("../../server/services/contact-business-system-links");
  const content = await import("../../server/services/cro03/sfp-launch-content");
  const { hashEmailToken } = await import("../../server/services/provider-readiness-control");
  const { COLD_OUTREACH_FROM } = await import("../../server/services/sender-policy");
  const { db } = await import("../../server/db");
  const { computeLivePackageContentHash } = await import("../../server/services/cro03/sfp-campaign-packages");

  // Fixture data: one program/sequence with the real launch drafts and a current pinned package, three recipients, one sender.
  await pool.query(`DELETE FROM sending_identities WHERE lower(email_address)=lower($1)`, [COLD_OUTREACH_FROM]);
  await pool.query(`INSERT INTO sending_identities (label,domain,email_address,is_active,warmup_status,daily_limit,sent_today)
    VALUES('ui','mail.libertybancard.com',$1,TRUE,'warm',2,0)`, [COLD_OUTREACH_FROM]);
  const programId = randomUUID();
  await pool.query(`INSERT INTO sfp_programs (id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
    VALUES($1,$2,ARRAY['12086'],ARRAY['Automotive'],2,TRUE,$3)`, [programId, prefix, actor.actorId]);
  const sequenceId = Number((await pool.query(`INSERT INTO follow_up_sequences
    (name,status,trigger_type,trigger_config,sequence_family,total_steps) VALUES($1,'paused','contact_created',$2::jsonb,'sfp-v2-cold-automotive',3) RETURNING id`,
    [prefix, JSON.stringify({ canonicalProgramId: programId, canonicalVerticals: ["Automotive"] })])).rows[0].id);
  const campaignId = Number((await pool.query(`INSERT INTO campaigns (name,status,total_steps,created_by) VALUES($1,'draft',3,'ui') RETURNING id`, [`${prefix}_c`])).rows[0].id);
  for (const d of content.buildLaunchStepDrafts("sfp.automotive.v2")) {
    await pool.query(`INSERT INTO sequence_steps (sequence_id,step_order,action_type,delay_days,delay_hours,subject,body,config)
      VALUES($1,$2,'email',$3,0,$4,$5,'{"format":"plain_text"}'::jsonb)`, [sequenceId, d.stepOrder, d.delayDays, d.subject, d.body]);
    await pool.query(`INSERT INTO campaign_steps (campaign_id,step_order,step_type,delay_days,subject,body_template,channel)
      VALUES($1,$2,'follow_up',$3,$4,$5,'email')`, [campaignId, d.stepOrder, d.delayDays, d.subject, d.body]);
  }
  const hash = await computeLivePackageContentHash(db, campaignId, sequenceId);
  await pool.query(`UPDATE sfp_campaign_package_versions SET lifecycle_state='superseded', superseded_at=NOW(), updated_at=NOW()
    WHERE package_key='sfp.automotive.v2' AND lifecycle_state='current'`);
  await pool.query(`INSERT INTO sfp_campaign_package_versions
    (package_key,vertical,campaign_id,campaign_name,sequence_id,sequence_name,sequence_family,content_hash,lifecycle_state,effective_at,actor_id)
    SELECT 'sfp.automotive.v2','Automotive',$1,c.name,$2,s.name,s.sequence_family,$3,'current',NOW(),'ui'
      FROM campaigns c, follow_up_sequences s WHERE c.id=$1 AND s.id=$2`, [campaignId, sequenceId, hash]);

  const enrollmentIds: number[] = [];
  for (let n = 0; n < 3; n++) {
    const label = randomUUID().replaceAll("-", "");
    const place = `${prefix}_${label}_place`;
    const business = (await pool.query(`INSERT INTO businesses (canonical_name,normalized_name,record_class,google_place_id,vertical,city,state,postal_code)
      VALUES($1,$2,'canonical',$3,'Automotive','Miami','FL','33130') RETURNING *`, [`${prefix} ${n} ${label.slice(0, 6)}`, `${prefix}${n}${label}`, place])).rows[0];
    await pool.query(`INSERT INTO canonical_source_links (business_id,source_system,source_type,stable_key) VALUES($1,'google_maps','place',$2)`, [business.id, place]);
    const email = `${prefix.slice(0, 20)}.${n}.${label.slice(0, 12)}@gmail.com`.toLowerCase();
    const contact = (await pool.query(`INSERT INTO contacts (first_name,last_name,email,phone,company_name,record_class,email_status)
      VALUES('Maria','Lopez',$1,'',$2,'production','valid') RETURNING id`, [email, `${business.canonical_name} LLC`])).rows[0];
    await pool.query(`INSERT INTO contact_source_events (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
      VALUES($1,$2,'import','google_maps_outscraper',$2,'system',$3,$4::jsonb)`, [contact.id, `${prefix}_${label}_event`, actor.actorId, JSON.stringify({ place_id: place })]);
    const pv = await previewContactBusinessSystemLinks({ afterContactId: Number(contact.id) - 1, limit: 1 });
    const linked = await applyContactBusinessSystemLink({ contactId: Number(contact.id), businessId: Number(business.id),
      sourceLinkId: pv.rows[0].sourceLinkId!, sourceEntityId: pv.rows[0].sourceEntityId, snapshotHash: pv.rows[0].snapshotHash });
    assert.equal(linked.status, "applied");
    const tokenHash = hashEmailToken(email);
    const opId = randomUUID();
    await pool.query(`INSERT INTO provider_operations (id,provider,operation_type,purpose,idempotency_key,actor_type,target_fingerprint,state)
      VALUES($1,'zerobounce','email_validation','certification',$2,'system',$3,'completed')`, [opId, `${prefix}-${opId}`, `business:${business.id}`]);
    await pool.query(`INSERT INTO provider_observations (provider,operation_id,subject_type,subject_id,email_token_hash,subject_generation,outcome,retryable,observed_at,expires_at)
      VALUES('zerobounce',$1,'contact',$2,$3,0,'valid',false,NOW()-INTERVAL '1 hour',NOW()+INTERVAL '29 days')`, [opId, contact.id, tokenHash]);
    await pool.query(`UPDATE contacts SET email_status='valid',email_token_hash=$2,email_validation_updated_at=NOW() WHERE id=$1`, [contact.id, tokenHash]);
    const prepared = await prepareCanonicalRecipient({ contactId: Number(contact.id), sequenceId, programId, actor, source: prefix });
    assert(prepared.enrollmentId != null);
    enrollmentIds.push(Number(prepared.enrollmentId));
  }
  await pool.query("DELETE FROM system_settings WHERE key=$1", [release.CANONICAL_RELEASE_CONTROL_KEY]);

  const open = async (role: "admin" | "manager") => {
    if (browser) await browser.close();
    browser = await privateStage3Browser(h.base, h.sessions.get(role)!.cookie, h.originalFetch, shots);
    await browser.navigate("/dashboard/canonical-enrichment");
    await browser.waitFor(/Backlog/);
    await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('nav[aria-label="Canonical enrichment views"] button')].find(x=>/Backlog/.test(x.textContent));b.click();return true})()`);
    await browser.waitFor(/Launch inventory/);
  };
  const clickText = async (re: string) => {
    for (let i = 0; i < 100; i++) {
      const ok = await browser!.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>new RegExp(${JSON.stringify(re)}).test(x.textContent.trim())&&!x.disabled);if(!b)return false;b.click();return true})()`);
      if (ok) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Button not available: ${re}`);
  };
  const shot = async (name: string) => {
    await browser!.evaluate(`(document.querySelector('[data-testid="release-panel"]')??document.querySelector('[data-testid="launch-inventory"]'))?.scrollIntoView({block:'start'})`);
    await new Promise(r => setTimeout(r, 300));
    await browser!.screenshot(name);
  };
  const panelText = () => browser!.evaluate(`document.querySelector('[data-testid="release-panel"]')?.innerText ?? ''`) as Promise<string>;
  const waitPanel = async (re: RegExp) => {
    for (let i = 0; i < 150; i++) { if (re.test(await panelText())) return; await new Promise(r => setTimeout(r, 100)); }
    await browser!.screenshot("failure"); throw new Error(`Panel text unavailable: ${re.source}\n${await panelText()}`);
  };

  // ── Admin: inventory and an empty release panel ────────────────────────────
  await open("admin");
  const page1 = await browser!.text();
  check(/ready, held/i.test(page1) && /3 of 3 pass every check now/.test(page1.replace(/\s+/g, " ")), "Inventory shows three recipients passing every check");
  check(/pending validation/i.test(page1) && /before anything can send/i.test(page1), "Inventory shows pending validation and the pre-send blockers");
  check(/Miami-Dade/.test(page1) && /Automotive/.test(page1), "County and vertical breakdown is rendered");
  await waitPanel(/no release yet/);
  const p0 = await panelText();
  check(/Sender capacity today: 2 admittable/.test(p0), "Panel shows the single sender capacity definition (2 admittable)");
  check(/Journey period: none/.test(p0) && /days per release/.test(p0), "Journey period is shown separately from the admission window");
  check(/does not lift the outbound pause/.test(p0), "Panel states that releasing does not lift the pause");
  await shot("01-admin-no-release");

  // ── Preview → execute through the UI ───────────────────────────────────────
  await clickText("^Preview$");
  await waitPanel(/2 selected of 3 primary candidates/);
  check(/2 messages of sender capacity/.test(await panelText()), "Preview is bounded by actual sender capacity, not an arbitrary count");
  await shot("02-admin-preview");
  await clickText("^Release 2 recipients$");
  await waitPanel(/open until/);
  const p1 = await panelText();
  check(/Journey period: ends/.test(p1) && /Journeys: .*In progress: 2/.test(p1), "After release: window open, journey period running, two journeys in progress");
  check(/Revoke and re-hold/.test(p1) && !/Preview/.test(p1), "A second release is not offered while the admission window is open");
  const rows1 = (await pool.query(`SELECT status FROM sequence_enrollments WHERE id=ANY($1::int[]) ORDER BY id`, [enrollmentIds])).rows.map(r => r.status);
  check(rows1.filter(s => s === "active").length === 2 && rows1.filter(s => s === "paused").length === 1, "Database agrees: two admitted, one still held");
  check((await pool.query(`SELECT status FROM follow_up_sequences WHERE id=$1`, [sequenceId])).rows[0].status === "paused", "The sequence stays paused");
  await shot("03-admin-released");

  // ── Hold states, resolved through the UI ───────────────────────────────────
  const releasedIds = (await pool.query(`SELECT id FROM sequence_enrollments WHERE id=ANY($1::int[]) AND status='active' ORDER BY id`, [enrollmentIds])).rows.map(r => Number(r.id));
  // A realistic uncertain outcome: a real dispatch attempt exists for this journey and the hold names it.
  const sendLog = await import("../../server/services/outbound-send-log");
  const heldKey = `${prefix}-held-attempt`;
  const heldRow = (await pool.query(`SELECT contact_id, sequence_id FROM sequence_enrollments WHERE id=$1`, [releasedIds[0]])).rows[0];
  assert(await sendLog.openSendAttempt({ idempotencyKey: heldKey, sequenceId: Number(heldRow.sequence_id), sequenceEnrollmentId: releasedIds[0],
    contactId: Number(heldRow.contact_id), stepOrder: 1, channel: "email" as any, fromAddress: "Scott@mail.libertybancard.com", toAddress: "uncertain@example.test", subject: "held" }));
  assert(await release.holdCanonicalEnrollment(releasedIds[0], "UNCERTAIN_DELIVERY", { step: 1 }));
  await pool.query(`UPDATE sequence_enrollments SET metadata=jsonb_set(metadata,'{canonicalRelease,heldIdempotencyKey}',to_jsonb($2::text)) WHERE id=$1`, [releasedIds[0], heldKey]);
  assert(await release.holdCanonicalEnrollment(releasedIds[1], "REPEATED_UNSENT", { step: 1 }));
  await browser!.navigate("/dashboard/canonical-enrichment");
  await browser!.waitFor(/Backlog/);
  await browser!.evaluate(`(()=>{[...document.querySelectorAll('nav button')].find(x=>/Backlog/.test(x.textContent)).click();return true})()`);
  await waitPanel(/Delivery outcome unknown/);
  const p2 = await panelText();
  check(/Repeated send failures/.test(p2) && /Confirmed delivered/.test(p2) && /Confirmed not delivered/.test(p2) && /Resume/.test(p2),
    "Uncertain delivery needs an explicit decision; repeated failures offer Resume");
  await shot("04-admin-holds");
  await clickText("^Confirmed not delivered$");
  await waitPanel(/^(?![\s\S]*Delivery outcome unknown)[\s\S]*Repeated send failures/);
  check(true, "Resolving the uncertain delivery removes its hold in the UI");
  await clickText("^Resume$");
  await waitPanel(/^(?![\s\S]*Repeated send failures)/);
  const metas = (await pool.query(`SELECT metadata->'canonicalRelease'->>'hold' hold, status FROM sequence_enrollments WHERE id=ANY($1::int[])`, [[releasedIds[0], releasedIds[1]]])).rows;
  check(metas.every(m => !m.hold), "Both holds are cleared in the database by the operator decision");

  // ── Revoke through the UI ──────────────────────────────────────────────────
  await clickText("^Revoke and re-hold$");
  await waitPanel(/closed \(revoked\)/);
  const p3 = await panelText();
  check(/closed \(revoked\)/.test(p3) && /Journey period: revoked/.test(p3), "Revoked state is shown for both periods");
  check(/Preview/.test(p3), "A new release can be previewed after revoke");
  const after = (await pool.query(`SELECT status, metadata->'canonicalRelease'->>'endedReason' r FROM sequence_enrollments WHERE id=ANY($1::int[])`, [enrollmentIds])).rows;
  check(after.every(r => r.status === "paused"), "Every membership is paused again after revoke");
  await shot("05-admin-revoked");

  // ── Expired: a later release whose admission window and journey have lapsed ─
  await clickText("^Preview$");
  await waitPanel(/selected of/);
  await clickText("^Release \\d+ recipient");
  await waitPanel(/open until/);
  const control = (await pool.query("SELECT value FROM system_settings WHERE key=$1", [release.CANONICAL_RELEASE_CONTROL_KEY])).rows[0].value;
  const latest = control.releases[control.releases.length - 1];
  latest.admissionClosesAt = new Date(Date.now() - 3_600_000).toISOString();
  latest.journeyExpiresAt = new Date(Date.now() - 60_000).toISOString();
  await pool.query("UPDATE system_settings SET value=$2::jsonb WHERE key=$1", [release.CANONICAL_RELEASE_CONTROL_KEY, JSON.stringify(control)]);
  await release.reconcileCanonicalReleases();
  await browser!.navigate("/dashboard/canonical-enrichment");
  await browser!.waitFor(/Backlog/);
  await browser!.evaluate(`(()=>{[...document.querySelectorAll('nav button')].find(x=>/Backlog/.test(x.textContent)).click();return true})()`);
  await waitPanel(/Admission window: closed/);
  const p4 = await panelText();
  check(/Journey period: ended/.test(p4) && !/Revoke and re-hold/.test(p4), "Expired state: both periods shown as ended; nothing left to revoke");
  check(/Preview/.test(p4), "A fresh release is offered once the old one has expired");
  await shot("06-admin-expired");

  // ── Error and loading states ───────────────────────────────────────────────
  browser!.failRead("/api/canonical-enrichment/release", { exact: true });
  await browser!.navigate("/dashboard/canonical-enrichment");
  await browser!.waitFor(/Backlog/);
  await browser!.evaluate(`(()=>{[...document.querySelectorAll('nav button')].find(x=>/Backlog/.test(x.textContent)).click();return true})()`);
  await waitPanel(/could not be read\. Nothing is shown as released/);
  check(!/open until|Revoke and re-hold|Preview/.test(await panelText()), "A failed release read shows an error and no release controls");
  await shot("07-admin-release-error");
  browser!.failRead(null);
  browser!.delayRead("/api/canonical-enrichment/release", 2500);
  await browser!.navigate("/dashboard/canonical-enrichment");
  await browser!.waitFor(/Backlog/);
  await browser!.evaluate(`(()=>{[...document.querySelectorAll('nav button')].find(x=>/Backlog/.test(x.textContent)).click();return true})()`);
  await waitPanel(/Reading release state/);
  await shot("08-admin-release-loading");
  check(true, "Loading state is shown while the release state is read");
  await waitPanel(/Admission window/);
  browser!.delayRead(null);

  // ── Role enforcement ───────────────────────────────────────────────────────
  await open("manager");
  const mgr = await browser!.text();
  check(/Launch inventory/.test(mgr), "A manager can read the launch inventory");
  check(!(await browser!.evaluate(`!!document.querySelector('[data-testid="release-panel"]')`)), "A manager sees no release controls");
  await shot("09-manager-read-only");
  for (const [method, p] of [["POST", "/api/canonical-enrichment/release/preview"], ["POST", "/api/canonical-enrichment/release/execute"],
    ["POST", "/api/canonical-enrichment/release/revoke"], ["PUT", "/api/canonical-enrichment/release/policy"],
    ["POST", "/api/canonical-enrichment/release/enrollments/1/resolve"]] as const) {
    check((await h.request("manager", method, p, {})).status === 403, `Manager ${method} ${p.split("/release")[1] || "/release"} is refused with 403`);
    check((await h.request("agent", method, p, {})).status === 403, `Agent ${method} ${p.split("/release")[1] || "/release"} is refused with 403`);
  }
  check((await h.request("agent", "GET", "/api/canonical-enrichment/release")).status === 403, "An agent cannot read the release state");
  const unauth = await h.originalFetch(`${h.base}/api/canonical-enrichment/release`);
  check(unauth.status === 401 || unauth.status === 403, "An anonymous request is refused");

  const exceptions = browser!.exceptions;
  check(exceptions.length === 0, `No uncaught browser exceptions (${exceptions.slice(0, 2).join(" ; ")})`);
  check(h.externalCalls() === 0, "No external network call was attempted");
  check(Number((await pool.query(`SELECT count(*) n FROM outbound_send_log WHERE status IN ('sent','delivered')`)).rows[0].n) === 0, "No message was sent or recorded as sent");
  console.log(`PASS SFP launch release UI verification (${checks} checks); screenshots in ${shots}`);
} finally {
  await browser?.close().catch(() => {});
  await pool.query("DELETE FROM system_settings WHERE key='sfp_canonical_release_control'").catch(() => {});
  await h.close().catch(() => {});
}
