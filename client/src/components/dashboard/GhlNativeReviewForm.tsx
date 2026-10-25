import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ClipboardCheck, Loader2, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { getApiErrorMessage } from "@/lib/ghlTruth";
import { isSha256, parseGhlReviewOperations } from "@/lib/ghlNativeReview";
import { useToast } from "@/hooks/use-toast";

export interface GhlNativeWorkflowInventoryRow {
  locationId: string;
  id: string;
  status: string;
  updatedAt: string;
  version: string;
}

export interface GhlNativeFieldInventoryRow {
  id: string;
  key: string;
  dataType?: string;
}

export interface GhlScopeRulesSnapshot {
  version: number;
  enabled: boolean;
  productionOnly: boolean;
  createSourceCategories: string[];
  neverCategories: string[];
  sourceLessLegacy: boolean;
  currentIntakeSince: string;
}

export type GhlApprovalStatus =
  | "approved_unchanged" | "verification_unavailable" | "review_required_changed" | "revoked" | "review_required";

export interface GhlApprovalSnapshot {
  status: GhlApprovalStatus;
  reviewerId: string | null;
  reviewedAt: string | null;
  locationId: string | null;
  lastCheckedAt: string | null;
  lastVerifiedAt: string | null;
  changedFacts: string[];
  unavailable: string[];
  contractVersion: number | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
  operations: Array<{ method: string; path: string; fields: string[]; tags: string[] }>;
  scopeRules: GhlScopeRulesSnapshot | null;
}

export interface GhlNativeSafetySnapshot {
  state?: string | null;
  locationId?: string | null;
  inventoryRevision?: string | null;
  workflows?: GhlNativeWorkflowInventoryRow[] | null;
  customFields?: GhlNativeFieldInventoryRow[] | null;
  customFieldInventoryRevision?: string | null;
  scopeRules?: GhlScopeRulesSnapshot | null;
  scopeRulesRevision?: string | null;
  approval?: GhlApprovalSnapshot | null;
  warning?: string | null;
  reason?: string | null;
  nativeReview?: {
    state: string;
    reviewedAt: string | null;
    evidenceReference: string | null;
  } | null;
}

interface GhlSyncControlSnapshot {
  epoch: number;
}

interface WorkflowReviewDraft {
  disposition: "" | "reviewed_safe" | "no_native_triggers";
  evidenceReference: string;
  definitionHash: string;
  changeMetadata: string;
  inspected: boolean;
}

const EMPTY_WORKFLOW_REVIEW: WorkflowReviewDraft = {
  disposition: "",
  evidenceReference: "",
  definitionHash: "",
  changeMetadata: "",
  inspected: false,
};

function freshInventoryAvailable(safety: GhlNativeSafetySnapshot | undefined): safety is GhlNativeSafetySnapshot & {
  locationId: string;
  inventoryRevision: string;
  workflows: GhlNativeWorkflowInventoryRow[];
  customFields: GhlNativeFieldInventoryRow[];
  customFieldInventoryRevision: string;
  scopeRules: GhlScopeRulesSnapshot;
  scopeRulesRevision: string;
} {
  return !!safety
    && safety.state !== "unverified"
    && typeof safety.locationId === "string" && safety.locationId.length > 0
    && isSha256(safety.inventoryRevision)
    && Array.isArray(safety.workflows)
    && safety.workflows.every((workflow) => typeof workflow?.id === "string" && workflow.id.length > 0
      && workflow.locationId === safety.locationId && typeof workflow.status === "string"
      && typeof workflow.updatedAt === "string" && typeof workflow.version === "string")
    && Array.isArray(safety.customFields)
    && safety.customFields.every((field) => typeof field?.id === "string" && field.id.length > 0
      && typeof field.key === "string" && field.key.length > 0)
    && isSha256(safety.customFieldInventoryRevision)
    && !!safety.scopeRules && isSha256(safety.scopeRulesRevision);
}

export function GhlNativeReviewForm({
  control,
  safety,
  safetyUnavailable,
}: {
  control: GhlSyncControlSnapshot | null;
  safety: GhlNativeSafetySnapshot | undefined;
  safetyUnavailable: boolean;
}) {
  const { toast } = useToast();
  const localQueryClient = useQueryClient();
  const previousInventoryRevision = useRef<string | null>(null);
  const [evidenceReference, setEvidenceReference] = useState("");
  const [operationsJson, setOperationsJson] = useState("[]");
  const [workflowDrafts, setWorkflowDrafts] = useState<Record<string, WorkflowReviewDraft>>({});
  const [submitted, setSubmitted] = useState(false);
  const inventoryAvailable = freshInventoryAvailable(safety);
  const knownCustomFieldIds = new Set((inventoryAvailable ? safety.customFields : []).map((field) => field.id));
  const operationResult = parseGhlReviewOperations(operationsJson, knownCustomFieldIds);

  useEffect(() => {
    const revision = inventoryAvailable ? `${safety.inventoryRevision}:${safety.customFieldInventoryRevision}` : null;
    if (revision !== previousInventoryRevision.current) {
      previousInventoryRevision.current = revision;
      setWorkflowDrafts({});
      setSubmitted(false);
      setEvidenceReference("");
      setOperationsJson("[]");
    }
  }, [inventoryAvailable, safety?.inventoryRevision, safety?.customFieldInventoryRevision]);

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!inventoryAvailable || !control || !operationResult.operations || !evidenceReference.trim()) {
        throw new Error("A current inventory, control epoch, explicit operation allowlist, and review evidence are required.");
      }
      const incompleteWorkflow = safety.workflows.some((workflow) => {
        const draft = workflowDrafts[workflow.id];
        return !draft?.inspected
          || !draft.disposition
          || draft.evidenceReference.trim().length < 8
          || draft.evidenceReference.trim().length > 500
          || !isSha256(draft.definitionHash)
          || draft.changeMetadata.trim().length < 8
          || draft.changeMetadata.trim().length > 500;
      });
      if (incompleteWorkflow) throw new Error("Every workflow must be manually inspected and have explicit disposition and evidence before submission.");

      const workflowActionEvidence = safety.workflows.map((workflow) => {
        const draft = workflowDrafts[workflow.id];
        return {
          workflowId: workflow.id,
          disposition: draft.disposition,
          evidenceReference: draft.evidenceReference.trim(),
          observedUpdatedAt: workflow.updatedAt,
          observedVersion: workflow.version,
          definitionHash: draft.definitionHash.trim(),
          changeMetadata: draft.changeMetadata.trim(),
        };
      });
      const response = await apiRequest("POST", "/api/admin/ghl/native-trigger-safety/review", {
        expectedEpoch: control.epoch,
        evidenceReference: evidenceReference.trim(),
        locationId: safety.locationId,
        inventoryRevision: safety.inventoryRevision,
        customFieldInventoryRevision: safety.customFieldInventoryRevision,
        scopeRulesRevision: safety.scopeRulesRevision,
        allowedOperations: operationResult.operations,
        workflowActionEvidence,
      });
      return response.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      localQueryClient.invalidateQueries({ queryKey: ["/api/admin/ghl/sync-control"] });
      localQueryClient.invalidateQueries({ queryKey: ["/api/admin/ghl/sync-truth"] });
      localQueryClient.invalidateQueries({ queryKey: ["/api/admin/ghl/native-trigger-safety"] });
      toast({
        title: "Native-review evidence submitted",
        description: "The backend must verify the evidence and current inventory before approving any CRM-write allowlist.",
      });
    },
    onError: (error) => toast({
      title: "Native-review submission failed",
      description: getApiErrorMessage(error, "The backend did not accept the review evidence."),
      variant: "destructive",
    }),
  });

  const allWorkflowEvidenceReady = inventoryAvailable && safety.workflows.every((workflow) => {
    const draft = workflowDrafts[workflow.id];
    return !!draft?.inspected
      && !!draft.disposition
      && draft.evidenceReference.trim().length >= 8
      && draft.evidenceReference.trim().length <= 500
      && isSha256(draft.definitionHash)
      && draft.changeMetadata.trim().length >= 8
      && draft.changeMetadata.trim().length <= 500;
  });
  const canSubmit = !!control
    && inventoryAvailable
    && !safetyUnavailable
    && !!evidenceReference.trim()
    && evidenceReference.trim().length >= 8
    && evidenceReference.trim().length <= 500
    && operationResult.operations !== null
    && allWorkflowEvidenceReady;

  const updateWorkflow = (workflowId: string, update: Partial<WorkflowReviewDraft>) => {
    setWorkflowDrafts((previous) => ({
      ...previous,
      [workflowId]: { ...EMPTY_WORKFLOW_REVIEW, ...previous[workflowId], ...update },
    }));
  };

  return (
    <Card className="border-amber-300" data-testid="card-ghl-native-review">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-amber-600" />
          <CardTitle className="text-base">Native-trigger safety review</CardTitle>
        </div>
        <CardDescription>
          Submit only evidence from a real manual inspection of current native GHL workflow actions. A workflow inventory list is metadata, not proof of action safety; the backend validates both inventory revisions and the control epoch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {safetyUnavailable && (
          <Alert variant="destructive" data-testid="alert-native-review-unavailable">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Native inventory could not be verified. The review form is blocked; no workflow actions or custom-field IDs are assumed.</AlertDescription>
          </Alert>
        )}
        {!safetyUnavailable && !inventoryAvailable && (
          <Alert variant="destructive" data-testid="alert-native-review-inventory-incomplete">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>The server has not returned both complete native-workflow and custom-field inventories with their current revisions. Submission remains blocked.</AlertDescription>
          </Alert>
        )}
        {safety?.warning && (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription>{safety.warning}</AlertDescription>
          </Alert>
        )}
        {safety?.state === "reviewed_current" && safety.nativeReview?.state === "approved" && (
          <Alert data-testid="alert-native-review-current">
            <ClipboardCheck className="h-4 w-4" />
            <AlertDescription>
              Backend reports a current approved review for the returned workflow and custom-field inventories. The review is limited to its explicitly allowed operations.
            </AlertDescription>
          </Alert>
        )}

        {inventoryAvailable && (
          <>
            <div className="grid gap-2 rounded-md border p-3 text-xs sm:grid-cols-2">
              <div>GHL location ID: <code className="break-all">{safety.locationId}</code></div>
              <div>Control epoch: <code>{control?.epoch ?? "Unknown"}</code></div>
              <div>Workflow inventory revision: <code className="break-all">{safety.inventoryRevision}</code></div>
              <div>Custom-field inventory revision: <code className="break-all">{safety.customFieldInventoryRevision}</code></div>
              <div>Export scope rules revision: <code className="break-all">{safety.scopeRulesRevision}</code></div>
              <div className="sm:col-span-2" data-testid="text-ghl-review-scope-rules">
                Export scope rules (approved with this review): production records only; creates from source categories{" "}
                {safety.scopeRules.createSourceCategories.join(", ") || "none"}; never {safety.scopeRules.neverCategories.join(", ")};
                source-less legacy prospects {safety.scopeRules.sourceLessLegacy ? "included" : "excluded"}; existing-population scope {safety.scopeRules.enabled ? "on" : "off"}.
              </div>
              <div>Workflow rows: {safety.workflows.length}</div>
              <div>Custom-field IDs: {safety.customFields.length}</div>
            </div>

            <section className="space-y-2" aria-label="Manual workflow action inspection">
              <h3 className="text-sm font-semibold">Inspect each native workflow in GHL</h3>
              <p className="text-xs text-muted-foreground">
                The server returns workflow identity/status metadata only. It does not inspect workflow actions for you. Do not choose a disposition unless you reviewed the current workflow itself.
              </p>
              {safety.workflows.length === 0 ? (
                <p className="rounded-md border p-3 text-sm text-muted-foreground">The current server inventory contains no workflow rows. The backend will still validate this inventory revision.</p>
              ) : (
                <div className="max-h-[28rem] space-y-3 overflow-y-auto rounded-md border p-3">
                  {safety.workflows.map((workflow) => {
                    const draft = workflowDrafts[workflow.id] ?? EMPTY_WORKFLOW_REVIEW;
                    return (
                      <div key={workflow.id} className="space-y-3 rounded-md border p-3" data-testid={`native-workflow-review-${workflow.id}`}>
                        <div className="break-all text-xs">
                          <strong>Workflow ID:</strong> <code>{workflow.id}</code>
                          <div>Status: {workflow.status} · last updated: {workflow.updatedAt || "Unknown"} · version: {workflow.version || "Unknown"}</div>
                        </div>
                        <label className="flex items-start gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={draft.inspected}
                            onChange={(event) => updateWorkflow(workflow.id, { inspected: event.target.checked })}
                            className="mt-0.5"
                          />
                          <span>I personally inspected this workflow's current native actions in GHL; metadata alone is not the basis for this review.</span>
                        </label>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Select
                            value={draft.disposition || "__unreviewed"}
                            onValueChange={(value) => updateWorkflow(workflow.id, { disposition: value as WorkflowReviewDraft["disposition"] })}
                          >
                            <SelectTrigger aria-label={`Manual disposition for workflow ${workflow.id}`}>
                              <SelectValue placeholder="Choose reviewed disposition" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__unreviewed">No disposition selected</SelectItem>
                              <SelectItem value="reviewed_safe">Inspected; reviewed safe for explicitly allowed operation(s)</SelectItem>
                              <SelectItem value="no_native_triggers">Inspected; confirmed no native trigger path for explicitly allowed operation(s)</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            value={draft.definitionHash}
                            onChange={(event) => updateWorkflow(workflow.id, { definitionHash: event.target.value })}
                            placeholder="Inspected workflow definition SHA-256"
                            aria-label={`Workflow definition hash for ${workflow.id}`}
                          />
                          <Input
                            value={draft.evidenceReference}
                            onChange={(event) => updateWorkflow(workflow.id, { evidenceReference: event.target.value })}
                            placeholder="Evidence reference (8+ characters)"
                            aria-label={`Workflow review evidence reference for ${workflow.id}`}
                          />
                          <Input
                            value={draft.changeMetadata}
                            onChange={(event) => updateWorkflow(workflow.id, { changeMetadata: event.target.value })}
                            placeholder="Observed review/change metadata"
                            aria-label={`Workflow change metadata for ${workflow.id}`}
                          />
                        </div>
                        {draft.definitionHash.trim() && !isSha256(draft.definitionHash) && (
                          <p className="text-xs text-destructive">Definition hash must be a 64-character SHA-256 from your inspected workflow evidence.</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold">Constrained CRM write templates</h3>
                <p className="text-xs text-muted-foreground">
                  Provide exact operations only. Methods and endpoint paths must match the supported CRM template allowlist; fields, tags, stage IDs, and custom-field IDs are explicit and bounded. Wildcards and blanket “all” entries are rejected.
                </p>
              </div>
              <Textarea
                value={operationsJson}
                onChange={(event) => setOperationsJson(event.target.value)}
                rows={9}
                spellCheck={false}
                className="font-mono text-xs"
                aria-label="Native review allowed CRM operations JSON"
                data-testid="textarea-native-review-operations"
              />
              {operationResult.error && <p className="text-xs text-destructive">{operationResult.error}</p>}
              <div className="max-h-28 overflow-y-auto rounded-md border p-2 text-xs text-muted-foreground">
                Current inventory custom-field IDs for explicit selection:
                {safety.customFields.length === 0 ? (
                  <span className="ml-1">none returned</span>
                ) : (
                  <ul className="mt-1 grid gap-x-4 sm:grid-cols-2">
                    {safety.customFields.map((field) => (
                      <li key={field.id} className="break-all">{field.key}: <code>{field.id}</code></li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="native-review-evidence-reference">Overall review evidence reference</label>
              <Input
                id="native-review-evidence-reference"
                value={evidenceReference}
                onChange={(event) => setEvidenceReference(event.target.value)}
                placeholder="Link/reference to the actual manual review evidence"
              />
            </div>
            <Alert>
              <ShieldAlert className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Submitting this form records your attestations; it does not claim the workflows are safe automatically. The backend re-reads both inventories, checks each workflow's observed revision, and applies the server allowlist before any CRM write is authorized.
              </AlertDescription>
            </Alert>
            {submitted && (
              <p className="text-sm text-muted-foreground" data-testid="text-native-review-submitted">
                Evidence submitted. Approval is not assumed; refresh the backend review state to see whether it approved this exact inventory.
              </p>
            )}
            {reviewMutation.error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{getApiErrorMessage(reviewMutation.error, "The backend did not accept the native-review evidence.")}</AlertDescription>
              </Alert>
            )}
            <Button
              variant="outline"
              onClick={() => reviewMutation.mutate()}
              disabled={!canSubmit || reviewMutation.isPending}
              data-testid="button-submit-native-review"
            >
              {reviewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Submit manually reviewed evidence
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}