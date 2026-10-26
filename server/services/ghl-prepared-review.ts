import type { PreparedNativeReview } from "../data/ghl-prepared-native-review";

export interface LiveReviewFacts {
  locationId: string;
  inventoryRevision: string;
  customFieldInventoryRevision: string;
  scopeRulesRevision: string;
  workflows: Array<{ id: string; status: string; updatedAt: string; version: string; locationId: string }>;
  customFieldIds: string[];
}

export interface PreparedReviewComparison {
  allMatch: boolean;
  revisions: {
    location: boolean;
    workflow: boolean;
    customField: boolean;
    scopeRules: boolean;
  };
  workflows: Array<{
    workflowId: string;
    status: string | null;
    matches: boolean;
    changes: string[];
  }>;
  missingCustomFieldIds: string[];
  /** Plain statements of what differs; empty when allMatch. */
  differences: string[];
}

/**
 * Compares prepared evidence to live facts. It never rewrites prepared values: any difference is reported
 * so a person can inspect the changed workflow or field before a new package is prepared.
 */
export function comparePreparedReview(prepared: PreparedNativeReview, live: LiveReviewFacts): PreparedReviewComparison {
  const revisions = {
    location: prepared.locationId === live.locationId,
    workflow: prepared.inventoryRevision === live.inventoryRevision,
    customField: prepared.customFieldInventoryRevision === live.customFieldInventoryRevision,
    scopeRules: prepared.scopeRulesRevision === live.scopeRulesRevision,
  };
  const liveById = new Map(live.workflows.map(workflow => [workflow.id, workflow]));
  const preparedIds = new Set(prepared.workflowActionEvidence.map(item => item.workflowId));
  const workflows = prepared.workflowActionEvidence.map(item => {
    const current = liveById.get(item.workflowId);
    const changes: string[] = [];
    if (!current) changes.push("workflow no longer present in the live inventory");
    else {
      if (current.updatedAt !== item.observedUpdatedAt) changes.push(`updatedAt ${item.observedUpdatedAt} -> ${current.updatedAt}`);
      if (current.version !== item.observedVersion) changes.push(`version ${item.observedVersion} -> ${current.version}`);
    }
    return { workflowId: item.workflowId, status: current?.status ?? null, matches: changes.length === 0, changes };
  });
  for (const current of live.workflows) {
    if (!preparedIds.has(current.id)) {
      workflows.push({ workflowId: current.id, status: current.status, matches: false, changes: ["new live workflow with no prepared evidence"] });
    }
  }
  const liveFieldIds = new Set(live.customFieldIds);
  const missingCustomFieldIds = [...new Set(prepared.allowedOperations.flatMap(op => op.customFieldIds))]
    .filter(id => !liveFieldIds.has(id));
  const differences: string[] = [];
  if (!revisions.location) differences.push("GHL location differs from the prepared evidence");
  if (!revisions.workflow) differences.push("Workflow metadata revision differs from the prepared evidence");
  if (!revisions.customField) differences.push("Custom-field inventory revision differs from the prepared evidence");
  if (!revisions.scopeRules) differences.push("Export scope rules revision differs from the prepared evidence");
  for (const row of workflows) if (!row.matches) differences.push(`Workflow ${row.workflowId}: ${row.changes.join("; ")}`);
  if (missingCustomFieldIds.length) differences.push(`Prepared custom-field IDs missing from the live inventory: ${missingCustomFieldIds.join(", ")}`);
  return { allMatch: differences.length === 0, revisions, workflows, missingCustomFieldIds, differences };
}
