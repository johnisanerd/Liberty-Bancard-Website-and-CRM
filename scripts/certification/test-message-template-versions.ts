/**
 * Message wording publication certification (disposable database; no network, no sends).
 * Proves: draft does not change live wording; publish is versioned, optimistic and lint-gated; publish never changes
 * activation; activation is a separate gated command; the owner-approved replacements are idempotent and never toggle a
 * workflow; the seed data contains none of the audited findings.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Message template versions certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const versions = await import("../../server/services/message-template-versions");
const replacements = await import("../../server/services/reviewed-copy-replacements");
const { lintCopy } = await import("../../server/services/message-copy-lint");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [MTV-${String(checks).padStart(2, "0")}] ${message}`); };
const rejects = async (fn: () => Promise<unknown>, status: number, message: string) => {
  try { await fn(); } catch (e: any) { check(e?.status === status, message); return e; }
  assert.fail(`${message}: expected rejection`);
};
const id = randomUUID().slice(0, 8);

// ── Draft / publish / activation are separate commands ──────────────────────
const t = await storage.createMessageTemplate({
  name: `MTV ${id}`, category: "cert", channel: "email", subject: "Original subject", body: "<p>Hi {{contact.firstName}}, original.</p>",
  mergeFields: ["contact.firstName"], isActive: false,
});
check(t.contentVersion === 1 && t.isActive === false, "New template starts at version 1 and inactive");

const draft = await versions.saveDraft(t.id, { subject: "New subject", body: "<p>Hi {{contact.firstName}}, new wording.</p>", baseVersion: 1 }, "u1");
check(draft.state === "draft" && draft.version === null, "Save draft writes a draft row");
let live = (await storage.getMessageTemplate(t.id))!;
check(live.body.includes("original") && live.contentVersion === 1, "Saving a draft leaves live wording unchanged");

await rejects(() => versions.saveDraft(t.id, { subject: null, body: "x", baseVersion: 7 }, "u1"), 409, "Draft against a stale base version is rejected");
await rejects(() => versions.publishDraft(t.id, { expectedVersion: 9 }, "u1"), 409, "Publish with a stale expected version is rejected");

const bad = await versions.saveDraft(t.id, { subject: "S", body: "<p>Upload: [UPLOAD_LINK] or reply to this email with the statement attached. Your analysis is saved.</p>", baseVersion: 1 }, "u1");
check(bad.id === draft.id, "A template keeps one editable draft");
const blocked = await rejects(() => versions.publishDraft(t.id, { expectedVersion: 1 }, "u1"), 422, "Publish is blocked while the draft has unsendable wording");
const rules = new Set((blocked.findings ?? []).map((f: any) => f.rule));
check(rules.has("bracket_placeholder") && rules.has("attachment_ask") && rules.has("exists_claim"), "Findings name the placeholder, attachment ask and unsupported claim");
live = (await storage.getMessageTemplate(t.id))!;
check(live.body.includes("original"), "Blocked publish leaves live wording unchanged");

await versions.saveDraft(t.id, { subject: "New subject", body: "<p>Hi {{contact.firstName}}, new wording.</p>", baseVersion: 1 }, "u1");
const published = await versions.publishDraft(t.id, { expectedVersion: 1 }, "u2");
check(published.contentVersion === 2 && published.body.includes("new wording") && published.subject === "New subject", "Publish promotes the draft as version 2");
check(published.isActive === false, "Publishing never activates the template");
const ws = await versions.getTemplateWorkspace(t.id);
check(ws.draft === null && ws.history.map((h) => h.version).join(",") === "2,1", "Draft is consumed; baseline version 1 and version 2 are retained");
check(ws.history.find((h) => h.version === 1)!.body.includes("original"), "History keeps the wording that was live before");

const audit = await pool.query(`SELECT action FROM audit_logs WHERE entity_type='message_template' AND entity_id=$1 ORDER BY id`, [t.id]);
check(audit.rows.some((r) => r.action === "message_template_content_published") && audit.rows.some((r) => r.action === "message_template_draft_saved"), "Draft and publish are audited separately");

const on = await versions.setTemplateActive(t.id, true, "admin1");
check(on.isActive === true && on.contentVersion === 2, "Activation is its own command and leaves the version alone");
await versions.setTemplateActive(t.id, false, "admin1");
await pool.query(`UPDATE message_templates SET body='<p>[UPLOAD_LINK]</p>' WHERE id=$1`, [t.id]);
await rejects(() => versions.setTemplateActive(t.id, true, "admin1"), 422, "Activation is refused while published wording is unsendable");
check((await versions.setTemplateActive(t.id, false, "admin1")).isActive === false, "Deactivation is always allowed");

await versions.saveDraft(t.id, { subject: null, body: "<p>x</p>", baseVersion: 2 }, "u1");
check((await versions.discardDraft(t.id, "u1")).discarded === 1, "Draft can be discarded");
const prev = versions.previewTemplate({ subject: "Hi {{contact.firstName}}", body: "<p>{{contact.firstName}} {{bogus.value}}</p>" });
check(prev.subject === "Hi Alex" && prev.unresolved.includes("bogus.value") && prev.findings.some((f) => f.rule === "unknown_merge_variable"), "Preview renders sample values and reports unknown variables");

// ── Owner-approved replacements ─────────────────────────────────────────────
const seed = JSON.parse(readFileSync("server/data/seeds/workflows.json", "utf8"));
const targeted = ["B. Estimate Request Intake", "D. No-Show Rescue", "E. Proposal Follow-Up Cadence", "F. Closed Won - Onboarding Kickoff", "G. Go-Live Lifecycle (Day 2/7/14/30)"];
for (const name of targeted) {
  const wf = seed.PREBUILT_WORKFLOWS.find((w: any) => w.name === name);
  check(lintCopy(JSON.stringify(wf.actions)).length === 0, `Seed copy for "${name}" has no audited findings`);
}
const dayTpl = seed.DEFAULT_MESSAGE_TEMPLATES.find((x: any) => x.name === "Day 7 Review Request");
check(lintCopy(dayTpl.body).length === 0, "Seed Day 7 template has no audited findings");

const OLD: Record<string, any[]> = {
  "B. Estimate Request Intake": [{ type: "send_ghl_email", subject: "Thanks", body: "<p>Hi</p><p>You can upload it here: [UPLOAD_LINK]</p><p>Or reply to this email with the statement attached. Once we review it, we'll have real numbers.</p>" }],
  "D. No-Show Rescue": [{ type: "send_ghl_email", subject: "We saved your analysis - reschedule anytime", body: "<p>No worries - your analysis is saved and ready whenever you are.</p><p>Pick a time: {{calendarLink}}</p><p>We'll keep your data on file so you won't need to resubmit anything.</p>" }],
  "E. Proposal Follow-Up Cadence": [{ type: "send_ghl_email", subject: "Last", body: "<p>Your analysis is saved and ready whenever you want to revisit. Just reply to this email or book a call: {{calendarLink}}</p>" }],
  "F. Closed Won - Onboarding Kickoff": [{ type: "send_ghl_email", subject: "Welcome", body: "<p>You can upload these documents through your merchant portal or reply to this email with them attached.</p>" }],
  "G. Go-Live Lifecycle (Day 2/7/14/30)": [{ type: "wait", hours: 1 }, { type: "request_review", reviewUrl: "[GOOGLE_REVIEW_LINK]" }, { type: "wait", hours: 2 }],
};
// Disposable DB: replace any pre-existing copies so the fixtures are exact and enabled.
await pool.query(`DELETE FROM workflows WHERE name = ANY($1)`, [targeted]);
const before: Record<string, { id: number; version: number }> = {};
for (const name of targeted) {
  const wf = await storage.createWorkflow({ name, triggerType: "manual", actions: OLD[name], enabled: true } as any);
  before[name] = { id: wf.id, version: wf.version };
}
await pool.query(`DELETE FROM message_templates WHERE name='Day 7 Review Request'`);
const OLD_DAY7 = `<p>Hi {{contact.firstName}},</p>\n<p>It's been a week since your switch to Liberty Bancard.</p>\n<p>Would you take 30 seconds to share your experience? <a href="[GOOGLE_REVIEW_LINK]">Leave a Review</a></p>\n<p>Your feedback helps other business owners make better processing decisions.</p>\n<p>Best,<br/>Liberty Bancard Team</p>`;
check(lintCopy(OLD_DAY7).some((f) => f.rule === "bracket_placeholder"), "Fixture reproduces the audited Day 7 finding");
const day7 = await storage.createMessageTemplate({ ...dayTpl, body: OLD_DAY7, isActive: true });

const run1 = await replacements.applyReviewedCopyReplacements();
check(targeted.every((n) => run1.workflows.includes(n)) && run1.templates.includes("Day 7 Review Request"), "Replacements apply to every audited workflow and the Day 7 template");
for (const name of targeted) {
  const wf = (await storage.getWorkflow(before[name].id))!;
  check(wf.enabled === true, `"${name}" stays enabled`);
  check(wf.version === before[name].version + 1, `"${name}" advances one workflow version`);
  check(lintCopy(JSON.stringify(wf.actions)).length === 0, `"${name}" has no audited findings after replacement`);
}
const g = (await storage.getWorkflow(before[targeted[4]].id))!;
check(!(g.actions as any[]).some((a) => a.type === "request_review") && (g.actions as any[]).length === 2, "Workflow G drops only the review request");
const d = (await storage.getWorkflow(before[targeted[1]].id))!;
check(JSON.stringify(d.actions).includes("review your statement, you can upload it here") && !JSON.stringify(d.actions).includes("saved your analysis"), "Workflow D uses the reviewed upload wording");
const day7After = (await storage.getMessageTemplate(day7.id))!;
check(day7After.isActive === true && day7After.contentVersion === 2 && lintCopy(day7After.body).length === 0, "Day 7 template is published as a new version and stays active");

const run2 = await replacements.applyReviewedCopyReplacements();
check(run2.workflows.length === 0 && run2.templates.length === 0, "A second run changes nothing (idempotent)");

await pool.query(`DELETE FROM workflows WHERE id = ANY($1)`, [Object.values(before).map((b) => b.id)]);
await pool.query(`DELETE FROM message_templates WHERE id = ANY($1)`, [[t.id, day7.id]]);
// ── Receipt preview covers every receipt class; failed replays are not reported as success ─────────
{
  const ack = await import("../../server/services/inbound-acknowledgement");
  for (const cls of ack.ACK_SOURCE_CLASSES) {
    const c = await ack.buildAckContent({ sourceClass: cls, sourceType: ack.ACK_PREVIEW_SOURCE_TYPE[cls], requestId: randomUUID(), firstName: "Alex" });
    check(c.templateKey === `ack.${cls}` && !c.subject.startsWith("We received your request "), `Receipt preview for ${cls} uses its own wording`);
  }
  const { claimPublicInbound } = await import("../../server/services/public-inbound-intake");
  const key = randomUUID();
  const mk = () => {
    const out: { status?: number; body?: any } = {};
    const res: any = { setHeader() {}, status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; } };
    const req: any = { ip: `10.9.${Math.floor(Math.random() * 200)}.1`, header: (n: string) => (n === "Idempotency-Key" ? key : undefined) };
    return { req, res, out };
  };
  const first = mk();
  const claimed = await claimPublicInbound(first.req, first.res, ["website_form", "privacy_request"], { id });
  check(claimed && claimed.id, "First claim records the occurrence");
  await pool.query(`UPDATE inbound_requests SET lifecycle_state='failed' WHERE id=$1`, [claimed!.id]);
  const replay = mk(); replay.req.ip = first.req.ip;
  const again = await claimPublicInbound(replay.req, replay.res, ["website_form", "privacy_request"], { id });
  check(again === null && replay.out.status === 409 && replay.out.body.success === false && replay.out.body.error === "PREVIOUS_ATTEMPT_NOT_RECORDED", "Replay of a failed attempt returns a non-success response");
  await pool.query(`UPDATE inbound_requests SET lifecycle_state='review_required' WHERE id=$1`, [claimed!.id]);
  const rr = mk(); rr.req.ip = first.req.ip;
  await claimPublicInbound(rr.req, rr.res, ["website_form", "privacy_request"], { id });
  check(rr.out.status === 200 && rr.out.body.status === "review_required", "Replay of a recorded request reports its actual state");
}

console.log(`MESSAGE_TEMPLATE_VERSIONS_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
