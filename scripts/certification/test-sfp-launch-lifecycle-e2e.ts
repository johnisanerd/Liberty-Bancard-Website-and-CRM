/**
 * SFP launch lifecycle certification (disposable PostgreSQL only).
 *
 * Exercises the real selector, preparation writer and worker tick, release writer/authority, sequence
 * scheduler and the real SMTP transport adapter (against a local fake SMTP server). The clock is controlled
 * by shifting every persisted deadline and due time earlier, which is equivalent to advancing time for the
 * schedule and journey authority. No message leaves the machine and no provider is called.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "SFP launch lifecycle certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });

// ── Fake SMTP: modes ok | reject (554 after DATA = proven unsent) | drop (connection lost after DATA = uncertain)
interface Captured { rcpt: string[]; data: string }
const captured: Captured[] = [];
let smtpMode: "ok" | "reject" | "drop" = "ok";
const smtp = net.createServer((sock) => {
  let inData = false; let buf = ""; let cur: Captured = { rcpt: [], data: "" };
  sock.on("error", () => {});
  sock.write("220 fake ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        cur.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
        if (smtpMode === "reject") { sock.write("554 rejected\r\n"); cur = { rcpt: [], data: "" }; continue; }
        if (smtpMode === "drop") { captured.push(cur); sock.destroy(); return; }
        captured.push(cur); cur = { rcpt: [], data: "" };
        sock.write("250 OK queued\r\n"); continue;
      }
      const nl = buf.indexOf("\r\n"); if (nl < 0) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO")) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
      else if (cmd.startsWith("AUTH")) sock.write("235 ok\r\n");
      else if (cmd.startsWith("RCPT TO")) { cur.rcpt.push(line.toLowerCase()); sock.write("250 OK\r\n"); }
      else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
      else if (cmd.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 OK\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
process.env.SMTP_HOST = "127.0.0.1"; process.env.SMTP_PORT = String((smtp.address() as net.AddressInfo).port);
process.env.SMTP_USER = "cert"; process.env.SMTP_PASS = "cert";
process.env.APP_URL = "https://liberty.example.test";
process.env.UNSUBSCRIBE_TOKEN_SECRET ||= "cert-unsubscribe-secret-0123456789abcdef";

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const { prepareCanonicalRecipient } = await import("../../server/services/canonical-recipient-preparation");
const release = await import("../../server/services/sfp-canonical-release");
const capacityLib = await import("../../server/services/sfp-sender-capacity");
const inventory = await import("../../server/services/sfp-launch-inventory");
const { previewContactBusinessSystemLinks, applyContactBusinessSystemLink } = await import("../../server/services/contact-business-system-links");
const content = await import("../../server/services/cro03/sfp-launch-content");
const { processSequenceEnrollments } = await import("../../server/services/sequence-worker");
const { hashEmailToken } = await import("../../server/services/provider-readiness-control");
const { COLD_OUTREACH_FROM } = await import("../../server/services/sender-policy");

const prefix = `cert_lifecycle_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const actor = { role: "admin" as const, actorId: `system:${prefix}`, email: null };
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };
const one = async (q: string, p: unknown[] = []) => (await pool.query(q, p)).rows[0];
const DAY = 86_400_000;

// ── Environment ──────────────────────────────────────────────────────────────
async function openPause() {
  await pool.query(`DELETE FROM outbound_pause_control`);
  await pool.query(`INSERT INTO outbound_pause_control(state,reason,epoch,actor) VALUES('unpaused','cert',1,'cert')`);
  const { invalidatePauseStateCache } = await import("../../server/services/outbound-pause-authority");
  invalidatePauseStateCache();
}
async function setSender(dailyLimit: number, sentToday = 0) {
  const updated = await pool.query(`UPDATE sending_identities SET is_active=TRUE, warmup_status='warm', daily_limit=$2, sent_today=$3
    WHERE lower(email_address)=lower($1)`, [COLD_OUTREACH_FROM, dailyLimit, sentToday]);
  if ((updated.rowCount ?? 0) === 0) await pool.query(`INSERT INTO sending_identities (label,domain,email_address,is_active,warmup_status,daily_limit,sent_today)
    VALUES('cert','mail.libertybancard.com',$1,TRUE,'warm',$2,$3)`, [COLD_OUTREACH_FROM, dailyLimit, sentToday]);
}
async function programAndSequence(tag: string) {
  const programId = randomUUID();
  await pool.query(`INSERT INTO sfp_programs (id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
    VALUES($1,$2,ARRAY['12086'],ARRAY['Automotive'],2,TRUE,$3)`, [programId, `${prefix}_${tag}`, actor.actorId]);
  const sequenceId = Number((await pool.query(`INSERT INTO follow_up_sequences
    (name,status,trigger_type,trigger_config,sequence_family,total_steps) VALUES($1,'paused','contact_created',$2::jsonb,'sfp-v2-cold-automotive',0) RETURNING id`,
    [`${prefix}_${tag}`, JSON.stringify({ canonicalProgramId: programId, canonicalVerticals: ["Automotive"] })])).rows[0].id);
  for (const d of content.buildLaunchStepDrafts("sfp.automotive.v2")) {
    await pool.query(`INSERT INTO sequence_steps (sequence_id,step_order,action_type,delay_days,delay_hours,subject,body,config)
      VALUES($1,$2,'email',$3,0,$4,$5,'{"format":"plain_text"}'::jsonb)`, [sequenceId, d.stepOrder, d.delayDays, d.subject, d.body]);
  }
  await pool.query("UPDATE follow_up_sequences SET total_steps=3 WHERE id=$1", [sequenceId]);
  // The approved package: a draft campaign carrying the same three steps, pinned by content hash.
  const campaignId = Number((await pool.query(`INSERT INTO campaigns (name,status,total_steps,created_by) VALUES($1,'draft',3,'cert') RETURNING id`,
    [`${prefix}_${tag}_campaign`])).rows[0].id);
  for (const d of content.buildLaunchStepDrafts("sfp.automotive.v2")) {
    await pool.query(`INSERT INTO campaign_steps (campaign_id,step_order,step_type,delay_days,subject,body_template,channel)
      VALUES($1,$2,'follow_up',$3,$4,$5,'email')`, [campaignId, d.stepOrder, d.delayDays, d.subject, d.body]);
  }
  await pool.query(`UPDATE campaigns SET status='draft' WHERE id=$1`, [campaignId]);
  await publishPackage("sfp.automotive.v2", campaignId, sequenceId);
  return { programId, sequenceId, campaignId, packageKey: "sfp.automotive.v2" };
}
async function publishPackage(packageKey: string, campaignId: number, sequenceId: number) {
  const { db } = await import("../../server/db");
  const { computeLivePackageContentHash } = await import("../../server/services/cro03/sfp-campaign-packages");
  const hash = await computeLivePackageContentHash(db, campaignId, sequenceId);
  await pool.query(`UPDATE sfp_campaign_package_versions SET lifecycle_state='superseded', superseded_at=NOW(), updated_at=NOW()
    WHERE package_key=$1 AND lifecycle_state='current'`, [packageKey]);
  await pool.query(`INSERT INTO sfp_campaign_package_versions
    (package_key,vertical,campaign_id,campaign_name,sequence_id,sequence_name,sequence_family,content_hash,lifecycle_state,effective_at,actor_id)
    SELECT $1,'Automotive',$2,c.name,$3,s.name,s.sequence_family,$4,'current',NOW(),'cert'
      FROM campaigns c, follow_up_sequences s WHERE c.id=$2 AND s.id=$3`, [packageKey, campaignId, sequenceId, hash]);
  return hash;
}
/** A real package replacement: new wording in both the sequence and its campaign, superseded pin, new pin. */
async function replacePackageWording(seq: { packageKey: string; campaignId: number; sequenceId: number }, suffix: string) {
  await pool.query(`UPDATE sequence_steps SET body=body || $2 WHERE sequence_id=$1 AND step_order=1`, [seq.sequenceId, suffix]);
  await pool.query(`UPDATE campaign_steps SET body_template=body_template || $2 WHERE campaign_id=$1 AND step_order=1`, [seq.campaignId, suffix]);
  await pool.query(`UPDATE campaigns SET content_revision=content_revision+1 WHERE id=$1`, [seq.campaignId]);
  return publishPackage(seq.packageKey, seq.campaignId, seq.sequenceId);
}

interface Rec { contactId: number; businessId: number; email: string; enrollmentId: number; intentId: string; sequenceId: number; programId: string }
async function recipient(tag: string, seq: { programId: string; sequenceId: number }, businessId?: number): Promise<Rec> {
  const label = randomUUID().replaceAll("-", "");
  let business;
  if (businessId) business = (await pool.query("SELECT * FROM businesses WHERE id=$1", [businessId])).rows[0];
  else {
    const place = `${prefix}_${label}_place`;
    business = (await pool.query(`INSERT INTO businesses (canonical_name,normalized_name,record_class,google_place_id,vertical,city,state,postal_code)
      VALUES($1,$2,'canonical',$3,'Automotive','Miami','FL','33130') RETURNING *`, [`${prefix} ${tag} ${label.slice(0, 6)}`, `${prefix}${tag}${label}`, place])).rows[0];
    await pool.query(`INSERT INTO canonical_source_links (business_id,source_system,source_type,stable_key) VALUES($1,'google_maps','place',$2)`, [business.id, place]);
  }
  const email = `${prefix.slice(0, 22)}.${tag}.${label.slice(0, 14)}@gmail.com`.toLowerCase();
  const contact = (await pool.query(`INSERT INTO contacts (first_name,last_name,email,phone,company_name,record_class,email_status)
    VALUES('Maria','Lopez',$1,'',$2,'production','valid') RETURNING id`, [email, `${business.canonical_name} LLC`])).rows[0];
  await pool.query(`INSERT INTO contact_source_events (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
    VALUES($1,$2,'import','google_maps_outscraper',$2,'system',$3,$4::jsonb)`,
    [contact.id, `${prefix}_${label}_event`, actor.actorId, JSON.stringify({ place_id: business.google_place_id })]);
  const preview = await previewContactBusinessSystemLinks({ afterContactId: Number(contact.id) - 1, limit: 1 });
  const linked = await applyContactBusinessSystemLink({ contactId: Number(contact.id), businessId: Number(business.id),
    sourceLinkId: preview.rows[0].sourceLinkId!, sourceEntityId: preview.rows[0].sourceEntityId, snapshotHash: preview.rows[0].snapshotHash });
  assert.equal(linked.status, "applied");
  await observeValid(Number(contact.id), email, Number(business.id));
  const prepared = await prepareCanonicalRecipient({ contactId: Number(contact.id), sequenceId: seq.sequenceId, programId: seq.programId, actor, source: prefix });
  assert(prepared.enrollmentId != null, "preparation owns a paused membership");
  return { contactId: Number(contact.id), businessId: Number(business.id), email, enrollmentId: Number(prepared.enrollmentId),
    intentId: String(prepared.intentId), sequenceId: seq.sequenceId, programId: seq.programId };
}
async function observeValid(contactId: number, email: string, businessId: number) {
  const tokenHash = hashEmailToken(email);
  const gen = (await one("SELECT email_mutation_generation g FROM contacts WHERE id=$1", [contactId])).g ?? 0;
  const opId = randomUUID();
  await pool.query(`INSERT INTO provider_operations (id,provider,operation_type,purpose,idempotency_key,actor_type,target_fingerprint,state)
    VALUES($1,'zerobounce','email_validation','certification',$2,'system',$3,'completed')`, [opId, `${prefix}-${opId}`, `business:${businessId}`]);
  await pool.query(`INSERT INTO provider_observations (provider,operation_id,subject_type,subject_id,email_token_hash,subject_generation,outcome,retryable,observed_at,expires_at)
    VALUES('zerobounce',$1,'contact',$2,$3,$4,'valid',false,NOW()-INTERVAL '1 hour',NOW()+INTERVAL '29 days')`, [opId, contactId, tokenHash, gen]);
  await pool.query(`UPDATE contacts SET email_status='valid',email_token_hash=$2,email_validation_updated_at=NOW() WHERE id=$1`, [contactId, tokenHash]);
}

// ── Controlled clock: every persisted deadline and due time moves earlier ────
async function advance(ms: number) {
  const shift = (v: unknown) => typeof v === "string" ? new Date(new Date(v).getTime() - ms).toISOString() : v;
  const control = (await one(`SELECT value FROM system_settings WHERE key=$1`, [release.CANONICAL_RELEASE_CONTROL_KEY]))?.value;
  if (control) {
    for (const r of control.releases) for (const k of ["releasedAt", "admissionClosesAt", "journeyExpiresAt", "admissionClosedAt", "journeyEndedAt", "revokedAt"]) r[k] = shift(r[k]);
    await pool.query(`UPDATE system_settings SET value=$2::jsonb WHERE key=$1`, [release.CANONICAL_RELEASE_CONTROL_KEY, JSON.stringify(control)]);
  }
  const rows = (await pool.query(`SELECT id, metadata FROM sequence_enrollments WHERE metadata ? 'canonicalRelease'`)).rows;
  for (const row of rows) {
    const marker = row.metadata.canonicalRelease;
    for (const k of ["releasedAt", "admissionClosesAt", "journeyExpiresAt"]) if (k in marker) marker[k] = shift(marker[k]);
    await pool.query(`UPDATE sequence_enrollments SET metadata=$2::jsonb, next_action_at=next_action_at - ($3 || ' milliseconds')::interval WHERE id=$1`,
      [row.id, JSON.stringify(row.metadata), String(ms)]);
  }
  await pool.query(`UPDATE sequence_enrollments SET next_action_at=next_action_at - ($1 || ' milliseconds')::interval
    WHERE next_action_at IS NOT NULL AND NOT (metadata ? 'canonicalRelease')`, [String(ms)]);
  // The clock moves for recorded sends too: due times derive from the last confirmed send.
  await pool.query(`UPDATE outbound_send_log SET sent_at=sent_at - ($1 || ' milliseconds')::interval WHERE sent_at IS NOT NULL`, [String(ms)]);
}
const tick = async () => { await release.reconcileCanonicalReleases(); return processSequenceEnrollments({ canonicalReleaseOnly: true }); };
const enr = async (id: number) => one("SELECT * FROM sequence_enrollments WHERE id=$1", [id]);
const sentTo = (email: string) => captured.filter(c => c.rcpt.some(r => r.includes(email))).length;
const subjectOf = (c: Captured) => c.data.match(/^Subject: (.*)$/mi)?.[1] ?? "";
async function releaseAll(limit: number, hours = 24, key = randomUUID()) {
  const p = await release.previewCanonicalRelease(limit);
  const r = await release.executeCanonicalRelease({ requestedLimit: limit, snapshotHash: p.snapshotHash, commandKey: key, expiresInHours: hours, actorId: "admin:cert" });
  return { p, ...r };
}
async function reset() {
  await release.revokeCanonicalRelease("admin:cert").catch(() => {});
  await pool.query(`UPDATE sequence_enrollments SET status='cancelled', next_action_at=NULL WHERE status IN ('active','paused')`);
  await pool.query(`UPDATE cr04_enrollment_intents SET preparation_state='exception', enrollment_id=NULL, reason_code='CERT_RESET' WHERE preparation_state IN ('ready_held','pending_validation')`);
  await pool.query(`DELETE FROM system_settings WHERE key=$1`, [release.CANONICAL_RELEASE_CONTROL_KEY]);
  await pool.query(`DELETE FROM outbound_send_counters`);
  await storage.setSystemSetting("coldEmailChannelPaused", false);
  smtpMode = "ok"; captured.length = 0;
}
async function qualified() { return inventory.listQualifiedPrimaryRecipients(); }

try {
  await openPause();
  await storage.setSystemSetting("emailChannelPaused", false);
  await storage.setSystemSetting("coldEmailChannelPaused", false);
  await storage.setSystemSetting("compliance_mailing_address", "100 Test Way, Miami, FL 33130");
  await setSender(30);
  const seq = await programAndSequence("main");

  // ═══ 1. Real selector: one primary recipient per business; release binds exact evidence ═══════════════════
  const a1 = await recipient("a", seq);
  const a2 = await recipient("a2", seq, a1.businessId);       // second person at the same business
  const b1 = await recipient("b", seq);
  const sel = await qualified();
  check(sel.length === 2, "The real selector qualifies exactly one primary recipient per business");
  check(new Set(sel.map(s => s.businessId)).size === 2, "No business appears twice in the selection");
  check(sel.every(s => s.bindingHash && s.binding.contentHash && s.binding.emailHash && s.evidence), "Each selected recipient carries exact binding evidence");
  // Selection cost follows the release size: with a limit the contact policy is applied only to recipients considered.
  const lazyOne = await inventory.selectPrimaryRecipients({ limit: 1 });
  check(lazyOne.chosen.length === 1 && lazyOne.chosen[0].enrollmentId === sel[0].enrollmentId && lazyOne.primaryCandidates === 2,
    "A limited selection picks the same first recipient as the full selection and still counts both primary candidates");
  const lazyAll = await inventory.selectPrimaryRecipients({ limit: 10 });
  check(lazyAll.chosen.map(c => c.bindingHash).join() === sel.map(c => c.bindingHash).join(),
    "A limited selection large enough for everyone binds exactly the same recipients as the full selection");
  const lazyZero = await inventory.selectPrimaryRecipients({ limit: 0 });
  check(lazyZero.chosen.length === 0, "A zero limit selects nobody and evaluates no recipient policy");
  const first = await releaseAll(10, 24, "life-1");
  check(first.p.size === 2 && first.release.enrollmentIds.length === 2, "Preview and execute agree on the selected recipients");
  check(!first.replayed, "First execute is not a replay");
  const replay = await release.executeCanonicalRelease({ requestedLimit: 10, snapshotHash: first.p.snapshotHash, commandKey: "life-1", expiresInHours: 24, actorId: "admin:cert" });
  check(replay.replayed && replay.release.releaseId === first.release.releaseId, "The same command key replays without a second release");
  const heldTwin = await enr(a1.enrollmentId === first.release.enrollmentIds.find(i => i === a1.enrollmentId) ? a2.enrollmentId : a1.enrollmentId);
  check(heldTwin.status === "paused" && !heldTwin.metadata.canonicalRelease, "The other person at the same business stays held");

  // ═══ 2. Automatic progression on the real schedule: touches at 0, +3d, +5d after the actual send ═══════════
  const chosen = sel.find(s => s.businessId === b1.businessId)!;
  const primaryA = first.release.enrollmentIds.find(i => i !== chosen.enrollmentId)!;
  const primaryB = chosen.enrollmentId;
  const emailOf = async (id: number) => (await one("SELECT c.email FROM sequence_enrollments e JOIN contacts c ON c.id=e.contact_id WHERE e.id=$1", [id])).email.toLowerCase();
  const emailA = await emailOf(primaryA), emailB = await emailOf(primaryB);
  await tick();
  check(sentTo(emailA) === 1 && sentTo(emailB) === 1, "Touch 1 is delivered once to each released primary recipient");
  const afterFirst = await enr(primaryA);
  const gap1 = (new Date(afterFirst.next_action_at).getTime() - Date.now()) / DAY;
  check(Number(afterFirst.current_step) === 1 && gap1 > 2.9 && gap1 < 3.1, "Touch 2 is due 3 days after the actual first send");
  await tick();
  check(sentTo(emailA) === 1, "A repeat tick before the due time sends nothing");
  await advance(2 * DAY);
  await tick();
  check(sentTo(emailA) === 1, "Two days after touch 1 nothing is due");
  await advance(DAY + 60_000);
  await tick();
  check(sentTo(emailA) === 2 && sentTo(emailB) === 2, "Touch 2 sends automatically with no new approval");
  const afterSecond = await enr(primaryA);
  const gap2 = (new Date(afterSecond.next_action_at).getTime() - Date.now()) / DAY;
  check(Number(afterSecond.current_step) === 2 && gap2 > 4.9 && gap2 < 5.1, "Touch 3 is due 5 days after the actual second send");
  await advance(4 * DAY);
  await tick();
  check(sentTo(emailA) === 2, "Touch 3 is not sent early");
  await advance(DAY + 60_000);
  check(!(await release.describeCanonicalRelease()).admissionOpen, "The admission window closed long ago; the journey authority is separate");
  await tick();
  check(sentTo(emailA) === 3, "Touch 3 sends after the admission window has closed, inside the journey period");
  const done = await enr(primaryA);
  check(done.status === "completed" || done.completed_at != null, "The journey completes after the final touch");
  const subjects = captured.filter(c => c.rcpt.some(r => r.includes(emailA))).map(subjectOf);
  check(new Set(subjects).size === 3 && subjects.every(s => !/^Re:/i.test(s)), "Three distinct approved subjects, no fake Re:");
  const lastBody = captured.filter(c => c.rcpt.some(r => r.includes(emailA))).pop()!.data.replace(/=\r\n/g, "").replace(/=3D/g, "=");
  check(!/\{\{|undefined/.test(lastBody) && lastBody.includes("https://libertybancard.com/upload-statement"), "Rendered copy keeps the secure upload link with no unresolved tokens");
  check(Number((await one(`SELECT count(*) c FROM outbound_send_log WHERE sequence_enrollment_id=ANY($1) AND status='sent'`, [[primaryA, primaryB]])).c) === 6, "Every delivery has one durable send receipt");
  await reset();

  // ═══ 3. Sender capacity: one definition across preview, execute, dispatch ═══════════════════════════════
  await setSender(2);
  const cap = await seqRecipients(3);
  const capView = await capacityLib.readSenderCapacity();
  check(capView.identityRemaining === 2 && capView.remaining === 2, "Capacity is the selected sender's own limit, not the global ceiling of 200");
  const capRelease = await releaseAll(10, 24, "cap-1");
  check(capRelease.p.size === 2 && capRelease.p.dailyCapacityRemaining === 2 && capRelease.release.enrollmentIds.length === 2, "A 30/day-class sender cannot be released beyond its remaining capacity");
  await tick();
  const sentNow = cap.filter(r => sentTo(r.email) === 1).length;
  check(sentNow === 2, "Both admitted first touches send");
  const after = await capacityLib.readSenderCapacity();
  check(after.identityUsedByLaunch === 2 && after.identityRemaining === 0 && after.remaining === 0, "Dispatch reservations and readiness read the same counters");
  await assert.rejects(releaseAll(10, 24, "cap-2"), (e: any) => ["NOTHING_TO_RELEASE", "ACTIVE_RELEASE_EXISTS"].includes(e.code)); checks++;
  const sender = await capacityLib.readSelectedSender();
  const results = await Promise.all(Array.from({ length: 12 }, () => capacityLib.reserveSenderCapacity(new Date(Date.now() + 3 * DAY))));
  await setSender(5);
  check(results.filter(r => r.ok).length === 2, "Twelve concurrent reservations against a limit of two grant exactly two");
  const sender5 = await capacityLib.readSelectedSender();
  const parallel = await Promise.all(Array.from({ length: 12 }, () => capacityLib.reserveSenderCapacity(new Date(Date.now() + 9 * DAY))));
  check(sender != null && sender5 != null && parallel.filter(r => r.ok).length === 5, "Twelve concurrent reservations against a raised limit of five grant exactly five");
  const rolled = await capacityLib.readSenderCapacity(new Date(Date.now() + 10 * DAY));
  check(rolled.identityUsedByLaunch === 0, "A new UTC day starts a new counter");
  await setSender(2);
  // Follow-up with exhausted capacity is deferred, not lost, not skipped.
  await advance(3 * DAY + 60_000);
  await tick();
  const deferred = await enr(capRelease.release.enrollmentIds[0]);
  check(deferred.status === "active" && Number(deferred.current_step) === 1 && captured.length === 2, "Exhausted capacity defers touch 2 and leaves the journey active");
  check(Number((await one(`SELECT count(*) c FROM audit_logs WHERE action='sequence_step_deferred_sender_capacity'`)).c) >= 1, "The capacity deferral is audited");
  await pool.query(`UPDATE outbound_send_counters SET date=date - 1 WHERE scope LIKE 'sender:%'`);
  await pool.query(`UPDATE sequence_enrollments SET next_action_at=NOW()-interval '1 minute' WHERE status='active'`);
  await tick();
  check(captured.length === 4, "After rollover the deferred follow-ups send");
  await reset();

  // ═══ 4. Admission window, finite journey authority, revocation and continuation ═════════════════════════
  await setSender(30);
  const lc = await seqRecipients(2);
  await storage.setSystemSetting("coldEmailChannelPaused", true);
  const rel4 = await releaseAll(2, 1, "life-4");
  await tick();
  check(captured.length === 0, "A channel pause defers every touch");
  const stillActive = await enr(lc[0].enrollmentId);
  check(stillActive.status === "active", "A channel pause does not strand or pause the released journey");
  await storage.setSystemSetting("coldEmailChannelPaused", false);
  await advance(16 * 60_000);
  await tick();
  check(captured.length === 2, "Lifting the channel pause lets the deferred first touches send");
  await storage.setSystemSetting("coldEmailChannelPaused", true);
  await advance(2 * 3_600_000);
  const swept = await release.reconcileCanonicalReleases();
  check(swept.admissionsClosed >= 1, "Reconciliation closes the admission window");
  check((await enr(lc[0].enrollmentId)).status === "active", "A started journey survives admission-window expiry");
  await storage.setSystemSetting("coldEmailChannelPaused", false);
  await advance(3 * DAY + 60_000);
  await tick();
  check(sentTo(lc[0].email) === 2, "Touch 2 follows after the admission window closed");
  await advance(15 * DAY);
  const swept2 = await release.reconcileCanonicalReleases();
  check(swept2.journeysEnded >= 1, "Reconciliation ends journeys past the journey deadline");
  const expired = await enr(lc[0].enrollmentId);
  check(expired.status === "paused" && expired.metadata.canonicalRelease.endedReason === "journey_expired" && Number(expired.current_step) === 2, "An expired journey pauses in place with an explicit reason and keeps its step");
  await tick();
  check(sentTo(lc[0].email) === 2, "No touch is sent after the journey deadline");
  const cont = (await qualified()).filter(q => q.kind === "continuation");
  check(cont.length === 2 && cont.every(c => c.currentStep >= 1), "Partially completed journeys are offered as continuations");
  const rel4b = await releaseAll(10, 1, "life-4b");
  check(rel4b.p.continuations === 2, "Preview reports the continuations");
  await tick();
  check(sentTo(lc[0].email) === 3 && sentTo(lc[1].email) === 3, "A continuation resumes at the next touch, never restarts at touch 1");
  check(Number((await one(`SELECT count(*) c FROM (SELECT step_order FROM outbound_send_log WHERE sequence_enrollment_id=$1 AND status='sent' GROUP BY step_order HAVING count(*)>1) d`, [lc[0].enrollmentId])).c) === 0
    && Number((await one(`SELECT count(*) c FROM outbound_send_log WHERE sequence_enrollment_id=$1 AND status='sent'`, [lc[0].enrollmentId])).c) === 3, "No touch was ever sent twice; the continuation sent only the missing touch");
  await reset();

  // Revocation is final: revoked journeys are not continuable or auto-extended.
  const rv = await seqRecipients(2);
  await releaseAll(2, 24, "life-rv");
  await tick();
  const revoked = await release.revokeCanonicalRelease("admin:cert");
  check(revoked.revoked && revoked.halted === 2, "Revoke halts started journeys in place");
  await advance(3 * DAY + 60_000);
  await tick();
  check(sentTo(rv[0].email) === 1, "Nothing sends after revocation");
  check((await enr(rv[0].enrollmentId)).metadata.canonicalRelease.endedReason === "revoked", "The revoked journey records its reason");
  check((await qualified()).every(q => q.kind !== "continuation"), "A revoked journey is never offered for automatic continuation");
  await reset();

  // ═══ 5. Preview → execute → dispatch binding; package replacement through the normal worker ═════════════
  const bd = await seqRecipients(2);
  const pv = await release.previewCanonicalRelease(10);
  await pool.query(`UPDATE contacts SET email=$2, email_mutation_generation=COALESCE(email_mutation_generation,0)+1 WHERE id=$1`, [bd[0].contactId, `changed.${bd[0].email}`]);
  await assert.rejects(release.executeCanonicalRelease({ requestedLimit: 10, snapshotHash: pv.snapshotHash, commandKey: "bind-1", expiresInHours: 24, actorId: "admin:cert" }),
    (e: any) => ["RELEASE_SNAPSHOT_DRIFT", "RELEASE_FACTS_CHANGED"].includes(e.code)); checks++;
  check((await enr(bd[0].enrollmentId)).status === "paused", "A recipient changed between preview and execute is not released under the old approval");
  await reset();

  const dp = await seqRecipients(2);
  await releaseAll(2, 24, "bind-2");
  await pool.query(`UPDATE contacts SET email=$2, email_mutation_generation=COALESCE(email_mutation_generation,0)+1 WHERE id=$1`, [dp[0].contactId, `moved.${dp[0].email}`]);
  await tick();
  check(captured.length === 1 && sentTo(dp[1].email) === 1 && sentTo(dp[0].email) === 0, "A recipient changed after execute is not sent; the other still is (final dispatch recheck)");
  await release.reconcileCanonicalReleases();
  const stopped = await enr(dp[0].enrollmentId);
  check(stopped.status === "paused" && !!stopped.metadata.canonicalRelease?.endedReason, "The changed recipient's journey stops with an explicit reason");
  await reset();

  const pk = await seqRecipients(2);
  await releaseAll(2, 24, "bind-3");
  await replacePackageWording(seq, "\n\nP.S. revised wording.");
  await tick();
  check(captured.length === 0, "A package changed after release is never sent under the old approval");
  for (const r of pk) {
    const row = await enr(r.enrollmentId);
    check(row.status === "paused" && ["package_content_changed", "validation_not_current"].includes(row.metadata.canonicalRelease?.endedReason),
      "The released membership holds as package_content_changed (continuable), not cancelled");
  }
  check((await qualified()).length === 0, "Recipients bound to the old package are not selectable until re-prepared");
  const { processCanonicalRecipientPreparationTick } = await import("../../server/services/canonical-recipient-preparation-worker");
  Object.assign(process.env, { NODE_ENV: "production", REPLIT_DEPLOYMENT: "1", RELEASE_SHA: "e".repeat(40),
    SFP_PUBLISH_ARTIFACT_SHA: "e".repeat(40), SFP_PUBLISH_BUILD_ID: randomUUID(), SFP_PUBLISH_BUILT_AT: new Date().toISOString() });
  for (let cycle = 0; cycle < 3; cycle++) {
    await pool.query(`DELETE FROM system_settings WHERE key='canonical_recipient_preparation_cursor'`);
    const ran = await processCanonicalRecipientPreparationTick();
    check(ran.ran !== false, `Preparation worker cycle ${cycle + 1} ran`);
  }
  const reprepared = await qualified();
  check(pk.every(r => reprepared.some(q => q.enrollmentId === r.enrollmentId)) && reprepared.every(r => r.binding.contentHash), "The normal preparation worker re-prepared the released recipients under the new package pin and kept their memberships");
  const newHash = (await one(`SELECT preparation_snapshot->>'contentHash' h FROM cr04_enrollment_intents WHERE id=$1::uuid`, [pk[0].intentId])).h;
  check(reprepared.some(r => r.binding.contentHash === newHash), "Selection binds to the current package hash");

  // Stale-package refresh lane: a republish is repaired in ONE tick even when both keyset cursors have already
  // passed every contact (the previous behaviour waited for each cursor to wrap, hours per republish in production).
  const staleSql = `SELECT count(*)::int n FROM cr04_enrollment_intents i
     WHERE i.preparation_state='ready_held' AND i.sequence_id=$1 AND NOT EXISTS (
       SELECT 1 FROM sfp_campaign_package_versions pkg WHERE pkg.sequence_id=i.sequence_id AND pkg.lifecycle_state='current'
         AND pkg.id::text=i.preparation_snapshot->>'packageVersionId' AND pkg.content_hash=i.preparation_snapshot->>'contentHash')`;
  const membersBefore = (await one(`SELECT count(*)::int n FROM sequence_enrollments WHERE sequence_id=$1`, [seq.sequenceId])).n;
  await replacePackageWording(seq, "\n\nP.S. second revision.");
  check((await one(staleSql, [seq.sequenceId])).n > 0, "Stale lane setup: prepared recipients pin the superseded package");
  const beyond = { afterContactId: 2_000_000_000, cycles: 1, scanned: 0, prepared: 0, held: 0, reasons: {}, leaseToken: null,
    leaseUntil: null, lastCycleAt: null,
    priority: { afterContactId: 2_000_000_000, cycles: 1, scanned: 0, prepared: 0, held: 0, reasons: {}, lastCycleAt: null } };
  await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES('canonical_recipient_preparation_cursor',$1::jsonb,NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(beyond)]);
  const staleRun: any = await processCanonicalRecipientPreparationTick();
  check(staleRun.ran !== false && staleRun.stalePackage.examined > 0 && staleRun.stalePackage.prepared > 0,
    "The stale-package lane re-prepared recipients on its own, with both cursors past every contact");
  check((await one(staleSql, [seq.sequenceId])).n === 0, "No ready-held recipient still pins the superseded package after one tick");
  check((await one(`SELECT count(*)::int n FROM sequence_enrollments WHERE sequence_id=$1`, [seq.sequenceId])).n === membersBefore,
    "Refreshing created no extra memberships");
  check((await qualified()).length > 0, "Refreshed recipients are selectable again");
  await reset();

  // A continued journey keeps the due time its last confirmed send implies, not the release time.
  await setSender(30);
  const cd = await seqRecipients(1);
  await releaseAll(1, 24, "cont-due-1");
  await tick();
  check(sentTo(cd[0].email) === 1, "Continuation due-time: touch 1 sent");
  await advance(3 * DAY + 60_000);
  await tick();
  check(sentTo(cd[0].email) === 2, "Continuation due-time: touch 2 sent 3 days after touch 1");
  await advance(DAY);
  // The journey deadline passes while touch 3 (due 5 days after touch 2) is still waiting.
  const ctl = (await one(`SELECT value FROM system_settings WHERE key=$1`, [release.CANONICAL_RELEASE_CONTROL_KEY])).value;
  for (const r of ctl.releases) r.journeyExpiresAt = new Date(Date.now() - 60_000).toISOString();
  await pool.query(`UPDATE system_settings SET value=$2::jsonb WHERE key=$1`, [release.CANONICAL_RELEASE_CONTROL_KEY, JSON.stringify(ctl)]);
  await release.reconcileCanonicalReleases();
  const cdHeld = await enr(cd[0].enrollmentId);
  check(cdHeld.status === "paused" && cdHeld.metadata.canonicalRelease?.endedReason === "journey_expired" && Number(cdHeld.current_step) === 2, "The journey is paused at touch 3 with touch 3 not yet due");
  const cdSel = (await qualified()).find(q => q.enrollmentId === cd[0].enrollmentId);
  check(cdSel?.kind === "continuation" && cdSel.currentStep === 2, "The paused journey is offered as a continuation at touch 3");
  await releaseAll(1, 24, "cont-due-2");
  const cdRel = await enr(cd[0].enrollmentId);
  const dueInDays = (new Date(cdRel.next_action_at).getTime() - Date.now()) / DAY;
  check(cdRel.status === "active" && dueInDays > 3.9 && dueInDays < 4.1, `The continued journey keeps its due time (touch 3 due ~4 days from now, got ${dueInDays.toFixed(2)})`);
  await tick();
  check(sentTo(cd[0].email) === 2, "Releasing the continuation does not send touch 3 early");
  await advance(4 * DAY + 60_000);
  await tick();
  check(sentTo(cd[0].email) === 3, "Touch 3 sends once it is due, 5 days after touch 2");
  await reset();

  // ═══ 6. Preparation worker preserves released journeys, retires genuine changes ════════════════════════════
  const pw = await seqRecipients(2);
  await releaseAll(2, 24, "prep-1");
  await tick();
  for (let cycle = 0; cycle < 3; cycle++) {
    await pool.query(`DELETE FROM system_settings WHERE key='canonical_recipient_preparation_cursor'`);
    await processCanonicalRecipientPreparationTick();
  }
  const kept = await Promise.all(pw.map(r => enr(r.enrollmentId)));
  check(kept.every(k => k.status === "active" && k.metadata.canonicalRelease?.releaseId), "Repeated preparation cycles leave released active journeys untouched");
  await pool.query(`UPDATE contacts SET do_not_contact=TRUE WHERE id=$1`, [pw[0].contactId]);
  await pool.query(`DELETE FROM system_settings WHERE key='canonical_recipient_preparation_cursor'`);
  await processCanonicalRecipientPreparationTick();
  const retired = await enr(pw[0].enrollmentId);
  check(retired.status !== "active", "A genuine suppression retires the journey through the preparation worker");
  await advance(3 * DAY + 60_000);
  await tick();
  check(sentTo(pw[0].email) === 1 && sentTo(pw[1].email) === 2, "The suppressed recipient receives nothing further; the other continues");
  await reset();
  Object.assign(process.env, { NODE_ENV: "test" }); delete process.env.REPLIT_DEPLOYMENT;

  // ═══ 7. Reply / bounce / complaint / unsubscribe stop sends ═══════════════════════════════════════════════
  const st = await seqRecipients(5);
  await releaseAll(10, 24, "stop-1");
  await tick();
  check(captured.length === 5, "Five first touches sent");
  await pool.query(`UPDATE contacts SET email_status='bounced' WHERE id=$1`, [st[0].contactId]);                    // bounce
  await pool.query(`UPDATE contacts SET do_not_contact=TRUE, email_status='complained' WHERE id=$1`, [st[1].contactId]); // complaint
  await pool.query(`UPDATE contacts SET opted_out_email=TRUE, email_status='opted_out' WHERE id=$1`, [st[2].contactId]); // unsubscribe
  const { recordInboundEvent } = await import("../../server/services/communication-events");
  await recordInboundEvent({ contactId: st[3].contactId, channel: "email", provider: "smtp", subject: "Re: hello", body: "Not interested", status: "replied" }); // real reply authority
  await advance(3 * DAY + 60_000);
  await tick();
  check(captured.length === 6 && sentTo(st[4].email) === 2, "Bounce, complaint, unsubscribe and reply each stop the next touch while the untouched recipient continues");
  check([0, 1, 2, 3].every(i => sentTo(st[i].email) === 1), "None of the four stopped recipients received touch 2");
  await reset();

  // ═══ 8. Unsent versus uncertain outcomes ═════════════════════════════════════════════════════════════════
  const us = await seqRecipients(1);
  await releaseAll(1, 24, "unsent-1");
  smtpMode = "reject";
  await tick();
  const afterReject = await enr(us[0].enrollmentId);
  const cnt = await capacityLib.readSenderCapacity();
  check(captured.length === 0 && afterReject.status === "active" && Number(afterReject.current_step) === 0, "A proven-unsent attempt leaves the step unsent and the journey active");
  check(cnt.identityUsedByLaunch === 0, "A proven-unsent attempt returns its allowance");
  smtpMode = "ok";
  await pool.query(`UPDATE sequence_enrollments SET next_action_at=NOW()-interval '1 minute' WHERE id=$1`, [us[0].enrollmentId]);
  await tick();
  check(sentTo(us[0].email) === 1, "The same step is retried and delivered once the transport recovers");
  await reset();

  const rep = await seqRecipients(1);
  await releaseAll(1, 24, "unsent-2");
  smtpMode = "reject";
  for (let i = 0; i < release.MAX_UNSENT_RETRIES + 1; i++) {
    await pool.query(`UPDATE sequence_enrollments SET next_action_at=NOW()-interval '1 minute' WHERE id=$1 AND status='active'`, [rep[0].enrollmentId]);
    await tick();
  }
  const repHeld = await enr(rep[0].enrollmentId);
  check(repHeld.status === "paused" && repHeld.metadata.canonicalRelease.hold === "REPEATED_UNSENT", "Repeated proven-unsent attempts hold the journey for an operator");
  await reset();

  const un = await seqRecipients(2);
  await releaseAll(2, 24, "uncertain-1");
  smtpMode = "drop";
  await tick();
  smtpMode = "ok";
  const held = await Promise.all(un.map(r => enr(r.enrollmentId)));
  check(held.every(h => h.status === "paused" && h.metadata.canonicalRelease.hold === "UNCERTAIN_DELIVERY"), "An uncertain outcome holds the journey: not treated as unsent, not resent");
  const usedAfterUncertain = await capacityLib.readSenderCapacity();
  check(usedAfterUncertain.identityUsedByLaunch === 2, "An uncertain outcome keeps its allowance reserved");
  const before = captured.length;
  await advance(12 * 3_600_000);
  await tick();
  check(captured.length === before, "A held uncertain journey is never resent automatically");
  const d = await release.resolveCanonicalHold(un[0].enrollmentId, "not_delivered");
  check(d.resolved, "The operator can confirm not-delivered");
  check((await capacityLib.readSenderCapacity()).identityUsedByLaunch === 1, "Confirming not-delivered frees only that allowance");
  const x = await release.resolveCanonicalHold(un[1].enrollmentId, "delivered");
  check(x.resolved, "The operator can confirm delivered");
  check((await capacityLib.readSenderCapacity()).identityUsedByLaunch === 1, "Confirming delivered keeps the allowance used");
  await tick();
  check(sentTo(un[0].email) === 2, "After not-delivered the same first touch is sent (counting the lost attempt)");
  const noDouble = await one(`SELECT count(*) c FROM outbound_send_log WHERE sequence_enrollment_id=$1 AND status='sent'`, [un[1].enrollmentId]);
  check(Number(noDouble.c) === 1, "After delivered the step is recorded once and not resent");
  await reset();

  // Resolving an uncertain delivery is atomic and exactly-once.
  const ar = await seqRecipients(2);
  await releaseAll(2, 24, "uncertain-2");
  smtpMode = "drop";
  await tick();
  smtpMode = "ok";
  check((await capacityLib.readSenderCapacity()).identityUsedByLaunch === 2, "Two uncertain sends hold two allowances");
  const race = await Promise.all([release.resolveCanonicalHold(ar[0].enrollmentId, "not_delivered"), release.resolveCanonicalHold(ar[0].enrollmentId, "not_delivered")]);
  check(race.filter(r => r.resolved).length === 1, "Two simultaneous not-delivered requests resolve the hold exactly once");
  check((await capacityLib.readSenderCapacity()).identityUsedByLaunch === 1, "The allowance is freed once, not twice");
  const again = await release.resolveCanonicalHold(ar[0].enrollmentId, "not_delivered");
  check(!again.resolved && again.reason === "NO_HOLD" && (await capacityLib.readSenderCapacity()).identityUsedByLaunch === 1, "Repeating a settled resolution changes nothing");
  // The attempt can no longer be proven unsent (the provider later confirmed it): not-delivered is refused and nothing is freed or resumed.
  await pool.query(`UPDATE outbound_send_log SET status='sent', sent_at=NOW() WHERE sequence_enrollment_id=$1`, [ar[1].enrollmentId]);
  const refused = await release.resolveCanonicalHold(ar[1].enrollmentId, "not_delivered");
  const stillHeld = await enr(ar[1].enrollmentId);
  check(!refused.resolved && refused.reason === "HELD_ATTEMPT_NOT_REOPENABLE", "Not-delivered is refused when the attempt cannot be reopened");
  check(stillHeld.status === "paused" && stillHeld.metadata.canonicalRelease.hold === "UNCERTAIN_DELIVERY" && stillHeld.metadata.canonicalRelease.heldReservation,
    "A refused resolution leaves the journey held with its reservation");
  check((await capacityLib.readSenderCapacity()).identityUsedByLaunch === 1, "A refused resolution frees no allowance");
  const okDelivered = await release.resolveCanonicalHold(ar[1].enrollmentId, "delivered");
  check(okDelivered.resolved && (await capacityLib.readSenderCapacity()).identityUsedByLaunch === 1, "The delivered decision still settles it, keeping the allowance used");
  await reset();

  // ═══ 9. Concurrency: two workers, one delivery ═══════════════════════════════════════════════════════════
  const cc = await seqRecipients(1);
  await releaseAll(1, 24, "conc-1");
  await Promise.all([tick(), tick(), tick()]);
  check(sentTo(cc[0].email) === 1, "Three concurrent workers deliver the first touch exactly once");
  await reset();

  // ═══ 10. Policy: size is configurable and bounded; sender capacity still binds ═══════════════════════════
  await setSender(30);
  const policy = await release.writeReleasePolicy({ maxRecipientsPerRelease: 3, maxAdmissionWindowHours: 48, journeyDays: 21 }, "admin:cert");
  check(policy.maxRecipientsPerRelease === 3 && (await release.readReleasePolicy()).journeyDays === 21, "Release policy is administrator-configurable");
  await assert.rejects(release.writeReleasePolicy({ maxRecipientsPerRelease: 99999, maxAdmissionWindowHours: 48, journeyDays: 21 }, "admin:cert")); checks++;
  const pol = await seqRecipients(5);
  await assert.rejects(release.previewCanonicalRelease(100), (e: any) => e.code === "RELEASE_LIMIT_INVALID"); checks++;
  const polPreview = await release.previewCanonicalRelease(3);
  check(polPreview.size === 3 && pol.length === 5, "Release size follows the policy ceiling (3) rather than a fixed 50");
  await release.writeReleasePolicy({ maxRecipientsPerRelease: 500, maxAdmissionWindowHours: 72, journeyDays: 14 }, "admin:cert");
  check((await release.previewCanonicalRelease(100)).size === 5, "Raising the policy ceiling admits all five qualified recipients (sender capacity of 30 still binds)");
  await setSender(2);
  check((await release.previewCanonicalRelease(100)).size === 2, "With a 2/day sender the same policy admits only two");
  await reset();

  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider or external network call was attempted");
  console.log(`PASS SFP launch lifecycle (${checks} checks)`);
} finally {
  await pool.query("DELETE FROM system_settings WHERE key=$1", [release.CANONICAL_RELEASE_CONTROL_KEY]).catch(() => {});
  smtp.close();
  await pool.end().catch(() => {});
}

/** n fresh recipients, each at its own business, prepared by the real writer under the shared sequence. */
async function seqRecipients(n: number): Promise<Rec[]> {
  const out: Rec[] = [];
  const seqRow = (await one(`SELECT id, (trigger_config->>'canonicalProgramId') pid FROM follow_up_sequences WHERE name=$1`, [`${prefix}_main`]));
  for (let i = 0; i < n; i++) out.push(await recipient(`r${i}`, { programId: seqRow.pid, sequenceId: Number(seqRow.id) }));
  return out;
}
