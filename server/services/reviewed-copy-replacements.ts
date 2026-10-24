import { storage } from "../storage";
import { auditChange } from "./audit-change";
import { WorkflowCommandError } from "./workflow-command-error";
import { publishSystemWording, TemplateVersionError } from "./message-template-versions";
import { lintRules } from "./message-copy-lint";

/**
 * Owner-approved wording replacements from docs/public-journeys/copy-reconciliation.md.
 *
 * Each replacement is an exact-substring edit, so it is idempotent and never overwrites wording that has already been
 * changed by an administrator. Applying it only rewrites stored wording: it never sets `enabled` on a workflow, never
 * changes a template's isActive, and never starts a run or a send.
 */

const UPLOAD_URL = "https://libertybancard.com/upload-statement";
const BUTTON_STYLE = "display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:bold;";

interface Edit { from: string; to: string }
interface EmailEdit { subjectFrom?: string; subjectTo?: string; edits: Edit[] }

const WORKFLOW_EMAIL_EDITS: Record<string, EmailEdit[]> = {
  "B. Estimate Request Intake": [{
    edits: [
      {
        from: "<p>You can upload it here: [UPLOAD_LINK]</p><p>Or reply to this email with the statement attached. Once we review it,",
        to: `<p><a href='${UPLOAD_URL}' style='${BUTTON_STYLE}'>Upload your statement</a></p><p>Or copy this link into your browser: <a href='${UPLOAD_URL}'>${UPLOAD_URL}</a></p><p>Once we review it,`,
      },
    ],
  }],
  "D. No-Show Rescue": [{
    subjectFrom: "We saved your analysis - reschedule anytime",
    subjectTo: "Let's reschedule your statement review",
    edits: [
      { from: "No worries - your analysis is saved and ready whenever you are.", to: "No worries - we can find a new time whenever you are ready." },
      {
        from: "<p>We'll keep your data on file so you won't need to resubmit anything.</p>",
        to: `<p>If you would like us to review your statement, you can upload it here: <a href='${UPLOAD_URL}'>Upload your statement</a></p>`,
      },
    ],
  }],
  "E. Proposal Follow-Up Cadence": [{
    edits: [{
      from: "<p>Your analysis is saved and ready whenever you want to revisit. Just reply to this email or book a call: {{calendarLink}}</p>",
      to: `<p>If you would like us to review your statement, you can upload it here: <a href='${UPLOAD_URL}'>Upload your statement</a></p><p>You can also reply to this email or book a call: {{calendarLink}}</p>`,
    }],
  }],
  "F. Closed Won - Onboarding Kickoff": [{
    edits: [{
      from: "<p>You can upload these documents through your merchant portal or reply to this email with them attached.</p>",
      to: "<p>Your representative will share a secure link for documents.</p>",
    }],
  }],
};

/** Workflow G: remove the review request until a verified review URL exists. */
const REMOVED_ACTIONS: Record<string, (a: any) => boolean> = {
  "G. Go-Live Lifecycle (Day 2/7/14/30)": (a) => a?.type === "request_review" && a?.reviewUrl === "[GOOGLE_REVIEW_LINK]",
};

const TEMPLATE_EDITS: Record<string, Edit[]> = {
  "30-Day Nurture Email": [{
    from: "<p>Your statement analysis is saved and the numbers haven't changed. When you're ready, we're here.</p>",
    to: "<p>If you would like us to review your statement, we can pick it up whenever you are ready.</p>",
  }],
  "Day 7 Review Request": [{
    from: `<p>Would you take 30 seconds to share your experience? <a href="[GOOGLE_REVIEW_LINK]">Leave a Review</a></p>\n<p>Your feedback helps other business owners make better processing decisions.</p>`,
    to: `<p>If anything needs attention, just reply to this email and we will help.</p>`,
  }],
};

function editText(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of edits) if (out.includes(e.from)) out = out.replace(e.from, e.to);
  return out;
}

/** Pure: returns the rewritten actions (or the same array if nothing matched). Used by the seed file converter and tests. */
export function applyWorkflowCopyReplacements(name: string, actions: any[]): { actions: any[]; changed: boolean } {
  const emailEdits = WORKFLOW_EMAIL_EDITS[name] ?? [];
  const remove = REMOVED_ACTIONS[name];
  let changed = false;
  let next = actions.map((a) => {
    if (a?.type !== "send_ghl_email") return a;
    let copy = a;
    for (const spec of emailEdits) {
      const body = typeof copy.body === "string" ? editText(copy.body, spec.edits) : copy.body;
      const subject = spec.subjectFrom && copy.subject === spec.subjectFrom ? spec.subjectTo : copy.subject;
      if (body !== copy.body || subject !== copy.subject) { copy = { ...copy, body, subject }; changed = true; }
    }
    return copy;
  });
  if (remove && next.some(remove)) { next = next.filter((a) => !remove(a)); changed = true; }
  return { actions: next, changed };
}

export function applyTemplateCopyReplacements(name: string, body: string): string {
  return editText(body, TEMPLATE_EDITS[name] ?? []);
}

const SYSTEM_ACTOR = "system:copy-reconciliation";
export const COPY_CONVERGENCE_SETTING = "reviewedCopyConvergence";

export type CopyTargetStatus = "applied" | "partial" | "already_current" | "conflict" | "failed" | "missing" | "retired";

export interface CopyTargetResult {
  kind: "workflow" | "template";
  name: string;
  id?: number;
  status: CopyTargetStatus;
  detail?: string;
  fromVersion?: number;
  toVersion?: number;
}

export interface CopyConvergenceReport {
  ranAt: string;
  results: CopyTargetResult[];
  counts: Record<CopyTargetStatus, number>;
}

const WORKFLOW_TARGETS = [...new Set([...Object.keys(WORKFLOW_EMAIL_EDITS), ...Object.keys(REMOVED_ACTIONS)])];
const TEMPLATE_TARGETS = Object.keys(TEMPLATE_EDITS);

function remainingAuditedFindings(actions: any[]): string[] {
  const hits = lintRules(JSON.stringify(actions)).map((f) => f.rule);
  const removeFn = Object.values(REMOVED_ACTIONS).find((fn) => actions.some(fn));
  if (removeFn) hits.push("request_review_unverified_url");
  return [...new Set(hits)];
}

/**
 * Supported, versioned convergence of the owner-approved wording. Safe to run any number of times and at any
 * background profile (it is not part of the seeds): every target is handled independently and reported as applied,
 * already_current, conflict (operator edit, draft or version change: left untouched), failed, missing or retired.
 * It never throws for a single target, never sets `enabled`/`isActive`, and never starts a run or a send.
 */
export async function convergeReviewedCopy(): Promise<CopyConvergenceReport> {
  const results: CopyTargetResult[] = [];
  const workflows = await storage.getWorkflows();

  for (const name of WORKFLOW_TARGETS) {
    const wf = workflows.find((w) => w.name === name && !w.retiredAt) ?? workflows.find((w) => w.name === name);
    if (!wf) { results.push({ kind: "workflow", name, status: "missing" }); continue; }
    if (wf.retiredAt) { results.push({ kind: "workflow", name, id: wf.id, status: "retired" }); continue; }
    try {
      const current = (wf.actions as any[]) ?? [];
      const { actions, changed } = applyWorkflowCopyReplacements(name, current);
      if (!changed) {
        const remaining = remainingAuditedFindings(current);
        results.push(remaining.length
          ? { kind: "workflow", name, id: wf.id, status: "conflict", fromVersion: wf.version, detail: `Live wording differs from the reviewed baseline and still has audited findings (${remaining.join(", ")}); not overwritten` }
          : { kind: "workflow", name, id: wf.id, status: "already_current", fromVersion: wf.version });
        continue;
      }
      const updated = await storage.updateWorkflow(wf.id, { actions }, { expectedVersion: wf.version });
      if (updated?.enabled !== wf.enabled) throw new Error(`Workflow ${wf.id} enabled state changed unexpectedly`);
      // A partial match is not a clean result: report what the live wording still contains.
      const residual = remainingAuditedFindings(actions);
      results.push(residual.length
        ? { kind: "workflow", name, id: wf.id, status: "partial", fromVersion: wf.version, toVersion: updated?.version, detail: `Reviewed replacements were applied, but audited findings remain (${residual.join(", ")}); an administrator must edit the rest` }
        : { kind: "workflow", name, id: wf.id, status: "applied", fromVersion: wf.version, toVersion: updated?.version });
    } catch (err: any) {
      results.push({ kind: "workflow", name, id: wf.id, status: err instanceof WorkflowCommandError ? "conflict" : "failed", detail: String(err?.message ?? err).slice(0, 300) });
    }
  }

  const templates = await storage.getMessageTemplates();
  for (const name of TEMPLATE_TARGETS) {
    const tpl = templates.find((t) => t.name === name);
    if (!tpl) { results.push({ kind: "template", name, status: "missing" }); continue; }
    try {
      const body = applyTemplateCopyReplacements(name, tpl.body);
      if (body === tpl.body) {
        const remaining = lintRules(`${tpl.subject ?? ""}\n${tpl.body}`).map((f) => f.rule);
        results.push(remaining.length
          ? { kind: "template", name, id: tpl.id, status: "conflict", fromVersion: tpl.contentVersion, detail: `Live wording differs from the reviewed baseline and still has audited findings (${[...new Set(remaining)].join(", ")}); not overwritten` }
          : { kind: "template", name, id: tpl.id, status: "already_current", fromVersion: tpl.contentVersion });
        continue;
      }
      // One atomic step under the template lock: checks the live version and the absence of an operator draft, then
      // publishes. No draft row is ever created, so an operator draft saved at any moment cannot be consumed.
      const published = await publishSystemWording(tpl.id, { expectedVersion: tpl.contentVersion, subject: tpl.subject, body }, SYSTEM_ACTOR);
      const residual = lintRules(`${published.subject ?? ""}\n${published.body}`).map((f) => f.rule);
      results.push(residual.length
        ? { kind: "template", name, id: tpl.id, status: "partial", fromVersion: tpl.contentVersion, toVersion: published.contentVersion, detail: `Reviewed replacements were applied, but audited findings remain (${[...new Set(residual)].join(", ")})` }
        : { kind: "template", name, id: tpl.id, status: "applied", fromVersion: tpl.contentVersion, toVersion: published.contentVersion });
    } catch (err: any) {
      results.push({ kind: "template", name, id: tpl.id, status: err instanceof TemplateVersionError && (err.status === 409 || err.status === 422) ? "conflict" : "failed", detail: String(err?.message ?? err).slice(0, 300) });
    }
  }

  const counts = { applied: 0, partial: 0, already_current: 0, conflict: 0, failed: 0, missing: 0, retired: 0 } as Record<CopyTargetStatus, number>;
  for (const r of results) counts[r.status]++;
  const report: CopyConvergenceReport = { ranAt: new Date().toISOString(), results, counts };

  try {
    await storage.setSystemSetting(COPY_CONVERGENCE_SETTING, report);
    if (counts.applied || counts.partial || counts.failed) {
      await auditChange({
        actorType: "system", actorId: SYSTEM_ACTOR, action: "reviewed_copy_convergence_run", entityType: "message_copy",
        details: { counts, results: results.filter((r) => r.status === "applied" || r.status === "partial" || r.status === "failed"), source: "docs/public-journeys/copy-reconciliation.md" },
      });
    }
  } catch (err: any) {
    console.error("[CopyConvergence] Could not persist result:", err?.message);
  }
  return report;
}

export async function getCopyConvergenceStatus(): Promise<CopyConvergenceReport | null> {
  return ((await storage.getSystemSetting(COPY_CONVERGENCE_SETTING)) as CopyConvergenceReport | null) ?? null;
}

/** Back-compat summary used by older callers/tests. */
export async function applyReviewedCopyReplacements(): Promise<{ workflows: string[]; templates: string[]; skipped: string[] }> {
  const report = await convergeReviewedCopy();
  return {
    workflows: report.results.filter((r) => r.kind === "workflow" && (r.status === "applied" || r.status === "partial")).map((r) => r.name),
    templates: report.results.filter((r) => r.kind === "template" && (r.status === "applied" || r.status === "partial")).map((r) => r.name),
    skipped: report.results.filter((r) => r.status === "conflict" || r.status === "failed").map((r) => `${r.name}: ${r.detail ?? r.status}`),
  };
}
