import { storage } from "../storage";
import { auditChange } from "./audit-change";
import { WorkflowCommandError } from "./workflow-command-error";
import { getTemplateWorkspace, publishDraft, saveDraft } from "./message-template-versions";

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

export async function applyReviewedCopyReplacements(): Promise<{ workflows: string[]; templates: string[]; skipped: string[] }> {
  const result = { workflows: [] as string[], templates: [] as string[], skipped: [] as string[] };

  for (const wf of await storage.getWorkflows()) {
    if (wf.retiredAt) continue;
    const { actions, changed } = applyWorkflowCopyReplacements(wf.name, (wf.actions as any[]) ?? []);
    if (!changed) continue;
    try {
      // `enabled` is deliberately not passed: enabled workflows stay enabled and disabled ones stay disabled.
      const updated = await storage.updateWorkflow(wf.id, { actions }, { expectedVersion: wf.version });
      if (updated?.enabled !== wf.enabled) throw new Error(`Workflow ${wf.id} enabled state changed unexpectedly`);
      result.workflows.push(wf.name);
    } catch (err) {
      if (err instanceof WorkflowCommandError) { result.skipped.push(`${wf.name}: ${err.message}`); continue; }
      throw err;
    }
  }

  for (const tpl of await storage.getMessageTemplates()) {
    if (!(tpl.name in TEMPLATE_EDITS)) continue;
    const body = applyTemplateCopyReplacements(tpl.name, tpl.body);
    if (body === tpl.body) continue;
    const ws = await getTemplateWorkspace(tpl.id);
    if (ws.draft) { result.skipped.push(`${tpl.name}: an administrator draft exists; not overwritten`); continue; }
    await saveDraft(tpl.id, { subject: tpl.subject, body, baseVersion: tpl.contentVersion }, SYSTEM_ACTOR);
    await publishDraft(tpl.id, { expectedVersion: tpl.contentVersion }, SYSTEM_ACTOR, "system");
    result.templates.push(tpl.name);
  }

  if (result.workflows.length || result.templates.length) {
    await auditChange({
      actorType: "system", actorId: SYSTEM_ACTOR, action: "reviewed_copy_replacements_applied", entityType: "message_copy",
      details: { workflows: result.workflows, templates: result.templates, source: "docs/public-journeys/copy-reconciliation.md" },
    });
  }
  return result;
}
