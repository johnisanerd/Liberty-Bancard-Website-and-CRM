import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getApiErrorMessage } from "@/lib/ghlTruth";
import { useToast } from "@/hooks/use-toast";

interface Finding { rule: string; match: string; why: string }
interface Preview { text: string; characters: number; unresolved: string[]; findings: Finding[]; note: string }

function findingsFromError(e: unknown): Finding[] {
  const raw = e instanceof Error ? e.message : "";
  const start = raw.indexOf("{");
  if (start < 0) return [];
  try {
    const body = JSON.parse(raw.slice(start));
    return Array.isArray(body.findings) ? body.findings : [];
  } catch { return []; }
}

function FindingList({ findings, testId }: { findings: Finding[]; testId: string }) {
  if (findings.length === 0) return null;
  return (
    <Alert variant="destructive" data-testid={testId}>
      <AlertDescription>
        <p className="font-medium mb-1">This wording cannot be sent as written:</p>
        <ul className="list-disc pl-5 space-y-0.5 text-sm">
          {findings.map((f) => <li key={`${f.rule}:${f.match}`}><code>{f.match}</code> - {f.why}</li>)}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export interface WorkflowSmsStepTarget {
  workflowId: number;
  workflowName: string;
  workflowVersion: number;
  workflowEnabled: boolean | null;
  stepIndex: number;
  body: string;
}

/**
 * Edit the body of one inline text message step. Preview uses sample values; publishing runs the shared copy
 * checks on the server, writes a new workflow version, and never changes whether the workflow is enabled.
 */
export function WorkflowSmsStepEditor({ target, onClose }: { target: WorkflowSmsStepTarget | null; onClose: () => void }) {
  const { toast } = useToast();
  const open = target !== null;
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);

  useEffect(() => {
    if (!target) { setPreview(null); setFindings([]); return; }
    setBody(target.body);
    setFindings([]);
  }, [target]);

  useEffect(() => {
    if (!target || !body.trim()) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await apiRequest("POST", `/api/workflows/${target.workflowId}/sms-steps/preview`,
          { body }, undefined, ctl.signal);
        setPreview(await res.json());
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPreview(null);
      }
    }, 400);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [target, body]);

  const publish = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/workflows/${target!.workflowId}/sms-steps/publish`, {
      stepIndex: target!.stepIndex, body, expectedVersion: target!.workflowVersion,
    })).json(),
    onSuccess: async () => {
      setFindings([]);
      await queryClient.invalidateQueries({ queryKey: ["/api/workflows"] });
      toast({ title: "Text message wording published", description: "A new workflow version was saved. Whether the workflow is enabled was not changed." });
      onClose();
    },
    onError: (e: Error) => {
      setFindings(findingsFromError(e));
      toast({ title: "Could not publish wording", description: getApiErrorMessage(e, "Could not publish wording"), variant: "destructive" });
    },
  });

  const dirty = useMemo(
    () => !!target && target.body !== body,
    [target, body],
  );
  const previewBlocked = (preview?.findings.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="dialog-workflow-sms-editor">
        <DialogHeader>
          <DialogTitle>{target ? `${target.workflowName} - text message step ${target.stepIndex + 1}` : "Workflow text message"}</DialogTitle>
          <DialogDescription>
            Preview the wording, then publish it. Publishing saves a new workflow version with this wording only; the workflow stays {target?.workflowEnabled ? "enabled" : "disabled"} and nothing is sent.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="wf-sms-body">Message text</Label>
              <Textarea id="wf-sms-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} data-testid="input-workflow-sms-body" />
            </div>
          </div>
          <div className="space-y-2" data-testid="workflow-sms-preview">
            <Label>Preview (sample values)</Label>
            {preview ? (
              <>
                <div className="text-sm bg-muted/50 rounded-md p-3 whitespace-pre-wrap" data-testid="workflow-sms-preview-text">{preview.text}</div>
                <p className="text-xs text-muted-foreground" data-testid="workflow-sms-preview-count">{preview.characters} characters with sample values</p>
                {preview.unresolved.length > 0 && (
                  <p className="text-xs text-destructive">Unsupported merge fields (publishing is blocked and sending would fail): {preview.unresolved.join(", ")}</p>
                )}
                <FindingList findings={preview.findings} testId="workflow-sms-findings-preview" />
              </>
            ) : <p className="text-sm text-muted-foreground">Preview appears here.</p>}
          </div>
        </div>
        <FindingList findings={findings} testId="workflow-sms-findings-action" />
        <div className="flex flex-wrap items-center gap-2">
          <Button className="min-h-11" disabled={publish.isPending || !dirty || !body.trim() || previewBlocked}
            onClick={() => publish.mutate()} data-testid="button-publish-workflow-sms">
            Publish wording
          </Button>
          <Button className="min-h-11" variant="outline" onClick={onClose} data-testid="button-cancel-workflow-sms">Cancel</Button>
          {!dirty && <p className="text-xs text-muted-foreground">Change the wording to publish.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
