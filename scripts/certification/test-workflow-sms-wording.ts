/**
 * Workflow SMS-step wording certification (disposable database; no network, no sends).
 * Proves: preview is side-effect free; publish is lint-gated, version-checked and step-scoped; publishing never
 * changes enabled (on or off); template-backed steps are refused; each publish advances exactly one workflow version.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary } from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "Workflow SMS wording certification" });
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { storage } = await import("../../server/storage");
const wording = await import("../../server/services/workflow-sms-wording");

let checks = 0;
const check = (v: unknown, message: string) => { assert(v, message); checks++; console.log(`✓ [WSW-${String(checks).padStart(2, "0")}] ${message}`); };
const rejects = async (fn: () => Promise<unknown>, status: number, message: string) => {
  try { await fn(); } catch (e: any) { check(e?.status === status, message); return e; }
  assert.fail(`${message}: expected rejection`);
};
const id = randomUUID().slice(0, 8);
const actor = `wsw-${id}`;
await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,'admin')`, [actor, `${actor}@fixture.invalid`]);

const mk = async (enabled: boolean) => storage.createWorkflow({
  name: `WSW ${id} ${enabled ? "on" : "off"}`, triggerType: "manual", triggerConfig: {}, enabled,
  actions: [
    { type: "send_ghl_sms", body: "Hi {{contact.firstName}}, original." },
    { type: "send_ghl_email", subject: "Email subject", body: "<p>Email body</p>" },
    { type: "send_ghl_sms", templateId: 999999, body: "" },
  ],
} as any);
const on = await mk(true);
const off = await mk(false);

const steps = wording.listSmsSteps(on);
check(steps.length === 2 && steps[0].editable && !steps[1].editable && steps[1].stepIndex === 2, "SMS steps are listed with their position; template-backed steps are not editable");

const p = wording.previewWorkflowSms({ body: "Hi {{contact.firstName}} {{bogus.thing}}" });
check(p.text.includes("Alex") && p.unresolved.includes("{{bogus.thing}}"), "Preview renders sample values and reports unknown merge fields");
check((await storage.getWorkflow(on.id))!.version === on.version, "Previewing changes nothing");

const good = { stepIndex: 0, body: "Hi {{contact.firstName}}, new wording." };
await rejects(() => wording.publishWorkflowSmsStep(on.id, { ...good, expectedVersion: on.version + 5 }, actor), 409, "Stale workflow version is rejected");
const blocked = await rejects(() => wording.publishWorkflowSmsStep(on.id, {
  ...good, body: "Upload: [UPLOAD_LINK] or reply with the statement attached. Your analysis is saved.", expectedVersion: on.version,
}, actor), 422, "Unsendable wording is blocked");
check(new Set((blocked.findings ?? []).map((f: any) => f.rule)).has("bracket_placeholder"), "Blocked publish names the findings");
check((await storage.getWorkflow(on.id))!.version === on.version, "Blocked publish leaves the workflow untouched");
await rejects(() => wording.publishWorkflowSmsStep(on.id, { ...good, stepIndex: 1, expectedVersion: on.version }, actor), 400, "A non-SMS step is refused");
await rejects(() => wording.publishWorkflowSmsStep(on.id, { ...good, stepIndex: 2, expectedVersion: on.version }, actor), 409, "A template-backed step is refused");
await rejects(() => wording.publishWorkflowSmsStep(on.id, { stepIndex: 0, body: "Hi {{contact.firstName}}, original.", expectedVersion: on.version }, actor), 409, "Unchanged wording is refused");

for (const [label, wf] of [["enabled", on], ["disabled", off]] as const) {
  const after = await wording.publishWorkflowSmsStep(wf.id, { ...good, expectedVersion: wf.version }, actor);
  check(after.version === wf.version + 1, `Publish advances the ${label} workflow by one version`);
  check(after.enabled === wf.enabled, `Publishing leaves the ${label} workflow ${label}`);
  const a = after.actions as any[];
  check(a[0].body.includes("new wording"), `The ${label} workflow's step carries the new wording`);
  check(a.length === 3 && a[1].type === "send_ghl_email" && a[1].body === "<p>Email body</p>" && a[2].templateId === 999999, `Other steps in the ${label} workflow are unchanged`);
  check(after.name === wf.name && after.triggerType === wf.triggerType, `Name and trigger of the ${label} workflow are unchanged`);
}
const { rows: audits } = await pool.query(`SELECT 1 FROM audit_logs WHERE entity_type='workflow' AND entity_id=$1 AND action='workflow_updated'`, [String(on.id)]);
check(audits.length >= 1, "The change is audited as a workflow update");

await pool.query(`DELETE FROM workflows WHERE id = ANY($1)`, [[on.id, off.id]]);
await pool.query(`DELETE FROM users WHERE id=$1`, [actor]);
console.log(`\nAll ${checks} workflow SMS wording checks passed`);
await pool.end();
