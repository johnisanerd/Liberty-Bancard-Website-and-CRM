import { storage } from "../storage";
import { WorkflowCommandError } from "./workflow-command-error";
import { lintCopy, type CopyFinding } from "./message-copy-lint";
import { previewMessage } from "./message-token-registry";

/**
 * Wording edits for inline email steps (send_ghl_email with its own subject/body) in a workflow.
 * Publishing replaces only that step's subject and body through the versioned workflow command. It never passes
 * `enabled`, so a disabled workflow stays disabled and an enabled one stays enabled.
 */

export class WorkflowEmailWordingError extends Error {
  constructor(message: string, public status: number, public findings?: CopyFinding[]) { super(message); }
}

const lintStep = (subject: string | null | undefined, body: string) => lintCopy(`${subject ?? ""}\n${body}`, "workflow");

export interface WorkflowEmailStep {
  stepIndex: number;
  subject: string | null;
  body: string;
  /** Steps that send a stored template take their wording from that template, so they are edited there. */
  templateId: number | null;
  editable: boolean;
  findings: CopyFinding[];
}

function stepsOf(workflow: { actions: unknown }): any[] {
  return Array.isArray(workflow.actions) ? workflow.actions : [];
}

export function listEmailSteps(workflow: { actions: unknown }): WorkflowEmailStep[] {
  const out: WorkflowEmailStep[] = [];
  stepsOf(workflow).forEach((a, stepIndex) => {
    if (a?.type !== "send_ghl_email") return;
    const body = typeof a.body === "string" ? a.body : "";
    const subject = typeof a.subject === "string" ? a.subject : null;
    const templateId = a.templateId ? Number(a.templateId) : null;
    out.push({ stepIndex, subject, body, templateId, editable: !templateId, findings: lintStep(subject, body) });
  });
  return out;
}

async function loadWorkflow(id: number) {
  const workflow = await storage.getWorkflow(id);
  if (!workflow) throw new WorkflowEmailWordingError("Workflow unavailable", 404);
  return workflow;
}

export async function getWorkflowEmailWorkspace(workflowId: number) {
  const workflow = await loadWorkflow(workflowId);
  return {
    workflow: { id: workflow.id, name: workflow.name, version: workflow.version, enabled: workflow.enabled, retired: !!workflow.retiredAt },
    steps: listEmailSteps(workflow),
  };
}

export async function previewWorkflowEmail(input: { subject?: string | null; body: string }) {
  const preview = previewMessage("workflow", input, "html");
  const { buildFinalEmailPreview } = await import("./message-template-versions");
  // Only a fully rendered message has a final form; unresolved merge fields keep the plain preview and its findings.
  const final = preview.unresolved.length ? null : await buildFinalEmailPreview({ subject: preview.subject, html: preview.body });
  return {
    final,
    subject: preview.subject,
    html: preview.body,
    unresolved: preview.unresolved,
    personas: preview.personas,
    findings: lintStep(input.subject, input.body),
    note: "Rendered by the same renderer that sends workflow steps, with sample values. Nothing is sent or stored by previewing.",
  };
}

export async function publishWorkflowEmailStep(
  workflowId: number,
  input: { stepIndex: number; subject: string | null; body: string; expectedVersion: number },
  actorId: string,
) {
  const workflow = await loadWorkflow(workflowId);
  if (workflow.retiredAt) throw new WorkflowEmailWordingError("Retired workflows must be restored before editing", 409);
  if (workflow.version !== input.expectedVersion) {
    throw new WorkflowEmailWordingError("Workflow changed. Reopen it before retrying; your wording has not been published.", 409);
  }
  const actions = stepsOf(workflow);
  const current = actions[input.stepIndex];
  if (current?.type !== "send_ghl_email") throw new WorkflowEmailWordingError("That step is not an email step.", 400);
  if (current.templateId) {
    throw new WorkflowEmailWordingError("This step sends a stored template. Edit the wording on that template instead.", 409);
  }
  const findings = lintStep(input.subject, input.body);
  if (findings.length) {
    throw new WorkflowEmailWordingError("The wording still contains text that cannot be sent. Fix these before publishing.", 422, findings);
  }
  if ((current.subject ?? null) === input.subject && (current.body ?? "") === input.body) {
    throw new WorkflowEmailWordingError("The wording is unchanged.", 409);
  }
  const nextActions = actions.map((a, i) => {
    if (i !== input.stepIndex) return a;
    const { subject: _s, ...rest } = a;
    return { ...rest, ...(input.subject === null ? {} : { subject: input.subject }), body: input.body };
  });
  try {
    // Only `actions` is supplied: name, trigger and `enabled` are left exactly as stored.
    return await storage.commandWorkflow(workflowId, "save", { expectedVersion: input.expectedVersion, actorId }, { actions: nextActions } as any);
  } catch (err) {
    if (err instanceof WorkflowCommandError) throw new WorkflowEmailWordingError(err.message, err.status);
    throw err;
  }
}
