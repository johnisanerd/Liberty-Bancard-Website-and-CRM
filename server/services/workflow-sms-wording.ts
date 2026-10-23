import { storage } from "../storage";
import { WorkflowCommandError } from "./workflow-command-error";
import { lintCopy, renderPreview, type CopyFinding } from "./message-copy-lint";

/**
 * Wording edits for inline SMS steps (send_ghl_sms with its own body) in a workflow.
 * Publishing replaces only that step's body through the versioned workflow command. It never passes
 * `enabled`, so a disabled workflow stays disabled and an enabled one stays enabled.
 */

export class WorkflowSmsWordingError extends Error {
  constructor(message: string, public status: number, public findings?: CopyFinding[]) { super(message); }
}

export interface WorkflowSmsStep {
  stepIndex: number;
  body: string;
  /** Steps that send a stored template take their wording from that template, so they are edited there. */
  templateId: number | null;
  editable: boolean;
  findings: CopyFinding[];
}

function stepsOf(workflow: { actions: unknown }): any[] {
  return Array.isArray(workflow.actions) ? workflow.actions : [];
}

export function listSmsSteps(workflow: { actions: unknown }): WorkflowSmsStep[] {
  const out: WorkflowSmsStep[] = [];
  stepsOf(workflow).forEach((a, stepIndex) => {
    if (a?.type !== "send_ghl_sms") return;
    const body = typeof a.body === "string" ? a.body : "";
    const templateId = a.templateId ? Number(a.templateId) : null;
    out.push({ stepIndex, body, templateId, editable: !templateId, findings: lintCopy(body) });
  });
  return out;
}

async function loadWorkflow(id: number) {
  const workflow = await storage.getWorkflow(id);
  if (!workflow) throw new WorkflowSmsWordingError("Workflow unavailable", 404);
  return workflow;
}

export async function getWorkflowSmsWorkspace(workflowId: number) {
  const workflow = await loadWorkflow(workflowId);
  return {
    workflow: { id: workflow.id, name: workflow.name, version: workflow.version, enabled: workflow.enabled, retired: !!workflow.retiredAt },
    steps: listSmsSteps(workflow),
  };
}

export function previewWorkflowSms(input: { body: string }) {
  const body = renderPreview(input.body);
  return {
    text: body.rendered,
    characters: body.rendered.length,
    unresolved: body.unresolved,
    findings: lintCopy(input.body),
    note: "Rendered with sample values. Nothing is sent or stored by previewing.",
  };
}

export async function publishWorkflowSmsStep(
  workflowId: number,
  input: { stepIndex: number; body: string; expectedVersion: number },
  actorId: string,
) {
  const workflow = await loadWorkflow(workflowId);
  if (workflow.retiredAt) throw new WorkflowSmsWordingError("Retired workflows must be restored before editing", 409);
  if (workflow.version !== input.expectedVersion) {
    throw new WorkflowSmsWordingError("Workflow changed. Reopen it before retrying; your wording has not been published.", 409);
  }
  const actions = stepsOf(workflow);
  const current = actions[input.stepIndex];
  if (current?.type !== "send_ghl_sms") throw new WorkflowSmsWordingError("That step is not a text message step.", 400);
  if (current.templateId) {
    throw new WorkflowSmsWordingError("This step sends a stored template. Edit the wording on that template instead.", 409);
  }
  const findings = lintCopy(input.body);
  if (findings.length) {
    throw new WorkflowSmsWordingError("The wording still contains text that cannot be sent. Fix these before publishing.", 422, findings);
  }
  if ((current.body ?? "") === input.body) throw new WorkflowSmsWordingError("The wording is unchanged.", 409);
  const nextActions = actions.map((a, i) => (i === input.stepIndex ? { ...a, body: input.body } : a));
  try {
    // Only `actions` is supplied: name, trigger and `enabled` are left exactly as stored.
    return await storage.commandWorkflow(workflowId, "save", { expectedVersion: input.expectedVersion, actorId }, { actions: nextActions } as any);
  } catch (err) {
    if (err instanceof WorkflowCommandError) throw new WorkflowSmsWordingError(err.message, err.status);
    throw err;
  }
}
