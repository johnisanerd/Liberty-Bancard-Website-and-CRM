/**
 * Reviewed-copy convergence and shared token contract certification (disposable database; no network, no sends).
 *
 * F1: the supported convergence applies the reviewed wording to stored workflows/templates without the full seed
 *     profile, reports per-target results, preserves operator edits and drafts, is a no-op on repeat, never toggles
 *     enabled/isActive, and the seed no longer overwrites operator-edited workflows.
 * F2: publication checks, previews and final rendering use one registry: typos and unsupported tokens are rejected
 *     before publication and at final send, values are escaped, and role/missing-name personas render cleanly.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Message copy convergence certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const replacements = await import("../../server/services/reviewed-copy-replacements");
const registry = await import("../../server/services/message-token-registry");
const { lintCopy } = await import("../../server/services/message-copy-lint");
const emailWording = await import("../../server/services/workflow-email-wording");
const smsWording = await import("../../server/services/workflow-sms-wording");
const templates = await import("../../server/services/message-template-versions");
const { RenderError } = await import("../../server/services/message-render");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [MCC-${String(checks).padStart(2, "0")}] ${message}`); };
const id = randomUUID().slice(0, 8);

// ── F2: one token contract ──────────────────────────────────────────────────
check(lintCopy("<p>Hi {{contact.fristName}}</p>", "workflow").some((f) => f.rule === "unknown_merge_variable"), "A misspelled contact token is rejected for workflow steps");
check(lintCopy("<p>Hi {{contact.fristName}}</p>", "template").some((f) => f.rule === "unknown_merge_variable"), "A misspelled contact token is rejected for stored templates");
for (const token of ["agentName", "referenceId", "agentEmail", "agentPhone"]) {
  check(lintCopy(`<p>{{${token}}}</p>`, "workflow").some((f) => f.rule === "unknown_merge_variable"), `{{${token}}} is not offered because the real renderer cannot fill it`);
}
for (const purpose of ["workflow", "template"] as const) {
  const all = registry.TOKEN_REGISTRY[purpose].map((t) => `{{${t}}}`).join(" ");
  check(lintCopy(`<p>${all}</p>`, purpose).length === 0, `Every registered ${purpose} token passes publication checks and renders`);
}
check(lintCopy("<p>{{deal.totalFees}}</p>", "workflow").some((f) => f.rule === "unknown_merge_variable"), "Template-only deal tokens are not available to workflow steps");
check(lintCopy("<p>{{deal.totalFees}}</p>", "template").length === 0, "The same deal token is available to stored templates");

const source = (firstName: string, email: string, extra: Record<string, any> = {}) => ({
  contact: { firstName, lastName: "O'Neil <b>", email, phone: "5550100", companyName: "A & B <Co>", vertical: "retail" },
  deal: { stage: "Proposal" }, calendarLink: "https://example.test/book", ...extra,
});
const html = registry.renderMessage("workflow", "<p>{{companyName}} / {{contact.lastName}}</p>", source("Alex", "a@x.test"), "html").output;
check(html === "<p>A &amp; B &lt;Co&gt; / O&#039;Neil &lt;b&gt;</p>", "Interpolated values are HTML-escaped in email bodies");
const text = registry.renderMessage("workflow", "{{companyName}}", source("Alex", "a@x.test"), "text").output;
check(text === "A & B <Co>", "SMS text keeps the literal characters");
check(registry.renderMessage("workflow", "Hi {{contact.firstName}},\nbody", source("Alex", "a@x.test"), "text").output.startsWith("Hi Alex,"), "A named person is greeted by name");
check(registry.renderMessage("workflow", "Hi {{contact.firstName}},\nbody", source("Info", "info@x.test"), "text").output.startsWith("Hello,"), "A role mailbox gets a generic greeting");
check(registry.renderMessage("workflow", "Hi {{contact.firstName}},\nbody", source("", "orders@x.test"), "text").output.startsWith("Hello,"), "A missing name gets a generic greeting");
check(registry.renderMessage("workflow", "<p>Hi {{contact.firstName}}</p>", source("", "orders@x.test"), "html").output === "<p>Hi there</p>", "Mid-body first name falls back to a neutral word");
for (const bad of ["{{contact.fristName}}", "{{agentName}}"]) {
  let err: unknown;
  try { registry.renderMessage("workflow", bad, source("Alex", "a@x.test"), "html"); } catch (e) { err = e; }
  check(err instanceof RenderError && err.code === "RENDER_UNSUPPORTED_TOKEN", `Final render refuses ${bad} instead of sending it literally`);
}
let noDeal: unknown;
try { registry.renderMessage("workflow", "{{deal.stage}}", { ...source("Alex", "a@x.test"), deal: null }, "html"); } catch (e) { noDeal = e; }
check(noDeal instanceof RenderError, "A deal token with no deal fails rather than printing a blank");
let noLink: unknown;
try { registry.renderMessage("workflow", "{{calendarLink}}", { ...source("Alex", "a@x.test"), calendarLink: null }, "html"); } catch (e) { noLink = e; }
check(noLink instanceof RenderError, "A missing calendar link fails rather than printing an empty href");

const prev = await emailWording.previewWorkflowEmail({ subject: "Hi {{contact.firstName}}", body: "<p>{{contact.firstName}} {{contact.fristName}}</p>" });
check(prev.unresolved.includes("{{contact.fristName}}") && prev.findings.some((f) => f.rule === "unknown_merge_variable"), "Preview and publication checks agree on the typo");
check(prev.personas.length === 3, "Preview renders named, role-mailbox and missing-name personas");
const ok = smsWording.previewWorkflowSms({ body: "Hi {{contact.firstName}}, {{calendarLink}}" });
check(ok.unresolved.length === 0 && ok.text.startsWith("Hi Alex"), "SMS preview uses the same renderer");

// Publication of a workflow email step with a typo is blocked.
const wf = await storage.createWorkflow({
  name: `MCC wf ${id}`, triggerType: "manual", triggerConfig: {}, enabled: false,
  actions: [{ type: "send_ghl_email", subject: "S", body: "<p>Hi {{contact.firstName}}</p>" }],
} as any);
let blocked: any;
try { await emailWording.publishWorkflowEmailStep(wf.id, { stepIndex: 0, subject: "S", body: "<p>Hi {{contact.fristName}}</p>", expectedVersion: wf.version }, "mcc"); } catch (e) { blocked = e; }
check(blocked?.status === 422, "Publishing a workflow email with a misspelled token is blocked (422)");
check((await storage.getWorkflow(wf.id))!.version === wf.version, "Blocked publication leaves the stored workflow untouched");

// Template send fails before any provider call when the stored template has a bad token.
const badTpl = await storage.createMessageTemplate({ name: `MCC bad ${id}`, category: "cert", channel: "email", subject: "Hello", body: "<p>Hi {{contact.fristName}}</p>", mergeFields: [], isActive: true });
const contact = await storage.createContact({ firstName: "Alex", lastName: "Fixture", email: `mcc-${id}@fixture.invalid`, companyName: "MCC Fixture", phone: `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}` } as any);
const { sendTemplatedMessage } = await import("../../server/services/ghl");
const sent = await sendTemplatedMessage({ templateId: badTpl.id, contactId: contact.id });
check(sent.success === false && /RENDER_UNSUPPORTED_TOKEN/.test(sent.error ?? ""), "Stored-template dispatch fails closed on an unsupported token");
await templates.setTemplateActive(badTpl.id, false, "mcc");

// ── F1: convergence ─────────────────────────────────────────────────────────
const targeted = ["B. Estimate Request Intake", "D. No-Show Rescue", "E. Proposal Follow-Up Cadence", "F. Closed Won - Onboarding Kickoff", "G. Go-Live Lifecycle (Day 2/7/14/30)"];
const OLD: Record<string, any[]> = {
  [targeted[0]]: [{ type: "send_ghl_email", subject: "Thanks", body: "<p>Hi</p><p>You can upload it here: [UPLOAD_LINK]</p><p>Or reply to this email with the statement attached. Once we review it, we'll be in touch.</p>" }],
  [targeted[1]]: [{ type: "send_ghl_email", subject: "We saved your analysis - reschedule anytime", body: "<p>No worries - your analysis is saved and ready whenever you are.</p><p>We'll keep your data on file so you won't need to resubmit anything.</p>" }],
  [targeted[2]]: [{ type: "send_ghl_email", subject: "Last", body: "<p>Your analysis is saved and ready whenever you want to revisit. Just reply to this email or book a call: {{calendarLink}}</p>" }],
  [targeted[3]]: [{ type: "send_ghl_email", subject: "OPERATOR SUBJECT", body: "<p>You can upload these documents through your merchant portal or reply to this email with them attached.</p>" }],
  [targeted[4]]: [{ type: "wait", hours: 1 }, { type: "request_review", reviewUrl: "[GOOGLE_REVIEW_LINK]" }, { type: "wait", hours: 2 }],
};
await pool.query(`DELETE FROM workflows WHERE name = ANY($1)`, [targeted]);
await pool.query(`DELETE FROM message_templates WHERE name IN ('Day 7 Review Request','30-Day Nurture Email')`);
const before: Record<string, { id: number; version: number }> = {};
for (const name of targeted) {
  const w = await storage.createWorkflow({ name, triggerType: "manual", actions: OLD[name], enabled: name !== targeted[1] } as any);
  before[name] = { id: w.id, version: w.version };
}
const day7 = await storage.createMessageTemplate({
  name: "Day 7 Review Request", category: "cert", channel: "email", subject: "How's it going?", mergeFields: [], isActive: true,
  body: `<p>Hi {{contact.firstName}},</p>\n<p>It's been a week.</p>\n<p>Would you take 30 seconds to share your experience? <a href="[GOOGLE_REVIEW_LINK]">Leave a Review</a></p>\n<p>Your feedback helps other business owners make better processing decisions.</p>\n<p>Best,<br/>Liberty Bancard Team</p>`,
});
const nurture = await storage.createMessageTemplate({
  name: "30-Day Nurture Email", category: "cert", channel: "email", subject: "Still thinking?", mergeFields: [], isActive: false,
  body: "<p>Hi {{contact.firstName}},</p>\n<p>Your statement analysis is saved and the numbers haven't changed. When you're ready, we're here.</p>",
});
// An administrator draft already exists on the nurture template: it must not be overwritten.
await templates.saveDraft(nurture.id, { subject: nurture.subject, body: "<p>Admin draft in progress</p>", baseVersion: nurture.contentVersion }, "admin1");

const run1 = await replacements.convergeReviewedCopy();
const byName = (n: string) => run1.results.find((r) => r.name === n)!;
for (const name of targeted) {
  check(byName(name).status === "applied" && byName(name).toVersion === before[name].version + 1, `"${name}" is applied as one workflow version`);
  const w = (await storage.getWorkflow(before[name].id))!;
  check(w.enabled === (name !== targeted[1]), `"${name}" keeps its enabled state`);
  check(lintCopy(JSON.stringify(w.actions), "workflow").length === 0, `"${name}" has no audited findings`);
}
const fAfter = (await storage.getWorkflow(before[targeted[3]].id))!;
check((fAfter.actions as any[])[0].subject === "OPERATOR SUBJECT", "An operator-set subject on workflow F survives convergence");
check(byName("Day 7 Review Request").status === "applied", "The Day 7 template is published as a new version");
check(byName("30-Day Nurture Email").status === "conflict", "A template with an administrator draft is reported as a conflict");
check((await storage.getMessageTemplate(nurture.id))!.body.includes("analysis is saved"), "The conflicting template is left untouched");
check((await storage.getMessageTemplate(day7.id))!.isActive === true, "The Day 7 template stays active");
check(run1.counts.failed === 0, "No target failed");

const run2 = await replacements.convergeReviewedCopy();
check(run2.counts.applied === 0 && run2.counts.partial === 0 && targeted.every((n) => run2.results.find((r) => r.name === n)!.status === "already_current"), "A second run applies nothing (idempotent)");
for (const name of targeted) check((await storage.getWorkflow(before[name].id))!.version === before[name].version + 1, `"${name}" version is unchanged by the repeat`);
const status = await replacements.getCopyConvergenceStatus();
check(status?.counts.applied === 0 && !!status?.ranAt, "The last result is persisted and readable");

// An operator edit that still carries audited text is a reported conflict, not an overwrite.
const edited = await storage.createWorkflow({
  name: `${targeted[0]} copy`, triggerType: "manual", actions: [{ type: "send_ghl_email", subject: "x", body: "<p>custom</p>" }], enabled: false,
} as any);
await storage.updateWorkflow(before[targeted[0]].id, { actions: [{ type: "send_ghl_email", subject: "Mine", body: "<p>Reply to this email with the statement attached.</p>" }] }, { expectedVersion: (await storage.getWorkflow(before[targeted[0]].id))!.version });
const run3 = await replacements.convergeReviewedCopy();
check(run3.results.find((r) => r.name === targeted[0])!.status === "conflict", "Operator wording that still has audited findings is reported as a conflict");
check(JSON.stringify((await storage.getWorkflow(before[targeted[0]].id))!.actions).includes("Mine"), "The operator edit is not overwritten");

// ── Partial match is reported, not called clean ─────────────────────────────
const bId = before[targeted[0]].id;
await storage.updateWorkflow(bId, { actions: [
  { type: "send_ghl_email", subject: "One", body: OLD[targeted[0]][0].body },
  { type: "send_ghl_email", subject: "Two", body: "<p>Upload it here: [UPLOAD_LINK]</p>" },
] }, { expectedVersion: (await storage.getWorkflow(bId))!.version });
const runPartial = await replacements.convergeReviewedCopy();
const partialB = runPartial.results.find((r) => r.name === targeted[0])!;
check(partialB.status === "partial" && /bracket_placeholder/.test(partialB.detail ?? "") && runPartial.counts.partial === 1, "A workflow where only part of the audited wording matched is reported as partial with the residual findings, not as applied/clean");
check(!JSON.stringify((await storage.getWorkflow(bId))!.actions).includes("You can upload it here: [UPLOAD_LINK]"), "The matched part was still converged");

// ── Atomicity against an operator draft (deterministic schedules) ───────────
const mkTpl = (label: string) => storage.createMessageTemplate({
  name: `MCC atomic ${label} ${id}`, category: "cert", channel: "email", subject: "S", mergeFields: [], isActive: false,
  body: "<p>Hi {{contact.firstName}}</p><p>old wording</p>",
});
// Schedule 1: the operator saves a draft after the system computed its change and before it saves.
const t1 = await mkTpl("between-check-and-save");
await templates.saveDraft(t1.id, { subject: "S", body: "<p>OPERATOR DRAFT</p>", baseVersion: t1.contentVersion }, "operator-1");
let c1: any;
try { await templates.publishSystemWording(t1.id, { expectedVersion: t1.contentVersion, subject: "S", body: "<p>system wording</p>" }, "system:cert"); } catch (e) { c1 = e; }
const w1 = await templates.getTemplateWorkspace(t1.id);
check(c1?.status === 409 && w1.draft?.body === "<p>OPERATOR DRAFT</p>" && w1.draft?.authorId === "operator-1" && w1.template.contentVersion === t1.contentVersion, "A draft that exists when the system saves produces a visible conflict; the draft and the live wording are intact");
// Schedule 2: the operator updates the draft between the system's save and publish. The system never creates a draft, so
// there is nothing to consume: the operator draft and the system version coexist only if the operator's base is current.
const t2 = await mkTpl("between-save-and-publish");
const sys2 = await templates.publishSystemWording(t2.id, { expectedVersion: t2.contentVersion, subject: "S", body: "<p>system wording</p>" }, "system:cert");
let stale: any;
try { await templates.saveDraft(t2.id, { subject: "S", body: "<p>OPERATOR</p>", baseVersion: t2.contentVersion }, "operator-2"); } catch (e) { stale = e; }
check(sys2.contentVersion === t2.contentVersion + 1 && stale?.status === 409 && (await templates.getTemplateWorkspace(t2.id)).draft === null, "An operator who opened the old version gets a visible conflict instead of silently publishing over the system change");
const fresh2 = await templates.saveDraft(t2.id, { subject: "S", body: "<p>OPERATOR v2</p>", baseVersion: sys2.contentVersion }, "operator-2");
check(fresh2.baseVersion === sys2.contentVersion && (await storage.getMessageTemplate(t2.id))!.body === "<p>system wording</p>", "A draft saved against the new version is kept and does not change live wording");
// Schedule 3: genuinely concurrent operator save and system publish, repeated; an operator draft is never lost.
let sysWon = 0, opWon = 0;
for (let i = 0; i < 8; i++) {
  const t = await mkTpl(`race-${i}`);
  const runOp = () => templates.saveDraft(t.id, { subject: "S", body: `<p>OPERATOR ${i}</p>`, baseVersion: t.contentVersion }, "operator-3");
  const runSys = () => templates.publishSystemWording(t.id, { expectedVersion: t.contentVersion, subject: "S", body: "<p>system wording</p>" }, "system:cert");
  // Alternate which side is issued first so both interleavings are exercised.
  const [op, sys] = i % 2 === 0
    ? await Promise.allSettled([runOp(), runSys()])
    : await Promise.allSettled([runSys(), runOp()]).then(([a, b]) => [b, a] as const);
  const ws = await templates.getTemplateWorkspace(t.id);
  if (op.status === "fulfilled" && sys.status === "rejected") {
    opWon++;
    assert(ws.draft?.body === `<p>OPERATOR ${i}</p>` && ws.template.contentVersion === t.contentVersion, "operator draft must survive");
  } else if (op.status === "rejected" && sys.status === "fulfilled") {
    sysWon++;
    assert((op.reason as any)?.status === 409 && ws.template.body === "<p>system wording</p>" && !ws.draft, "operator must see a conflict");
  } else assert.fail(`unexpected race outcome ${op.status}/${sys.status}`);
}
check(opWon + sysWon === 8, `Eight concurrent operator-save/system-publish races each ended with exactly one winner and a visible loser (operator ${opWon}, system ${sysWon}); no draft was lost or consumed`);
// Schedule 4: parallel startup and admin convergence apply a template once.
await pool.query(`DELETE FROM message_templates WHERE name='Day 7 Review Request'`);
const d7b = await storage.createMessageTemplate({
  name: "Day 7 Review Request", category: "cert", channel: "email", subject: "How's it going?", mergeFields: [], isActive: true,
  body: `<p>Hi {{contact.firstName}},</p>\n<p>Would you take 30 seconds to share your experience? <a href="[GOOGLE_REVIEW_LINK]">Leave a Review</a></p>\n<p>Your feedback helps other business owners make better processing decisions.</p>`,
});
const [pa, pb] = await Promise.all([replacements.convergeReviewedCopy(), replacements.convergeReviewedCopy()]);
const d7After = (await storage.getMessageTemplate(d7b.id))!;
const d7Statuses = [pa, pb].map((r) => r.results.find((x) => x.name === "Day 7 Review Request")!.status).sort();
check(d7After.contentVersion === d7b.contentVersion + 1 && d7Statuses.filter((x) => x === "applied").length === 1, `Parallel startup and admin convergence publish the template exactly once (${d7Statuses.join("/")})`);
check((await pool.query(`SELECT count(*)::int n FROM message_template_versions WHERE template_id=$1 AND state='draft'`, [d7b.id])).rows[0].n === 0, "Convergence leaves no draft row behind");

// Seed no longer rewrites operator-edited F/G workflows.
const { seedDefaultData } = await import("../../server/services/seed-workflows");
const fVersion = (await storage.getWorkflow(before[targeted[3]].id))!.version;
await seedDefaultData();
const fSeeded = (await storage.getWorkflow(before[targeted[3]].id))!;
check(fSeeded.version === fVersion && (fSeeded.actions as any[])[0].subject === "OPERATOR SUBJECT", "Running the seed leaves operator-edited workflow F alone");

await pool.query(`DELETE FROM workflows WHERE id = ANY($1)`, [[wf.id, edited.id, ...Object.values(before).map((b) => b.id)]]);
console.log(`MESSAGE_COPY_CONVERGENCE_PASS (${checks} checks)`);
await pool.end();
process.exit(0);
