import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getApiErrorMessage } from "@/lib/ghlTruth";
import { useToast } from "@/hooks/use-toast";
import type { MessageTemplate, MessageTemplateVersion } from "@shared/schema";

interface Finding { rule: string; match: string; why: string }
interface Workspace {
  template: MessageTemplate;
  draft: MessageTemplateVersion | null;
  history: MessageTemplateVersion[];
  liveFindings: Finding[];
  draftFindings: Finding[];
}
interface Preview { subject: string; html: string; unresolved: string[]; findings: Finding[]; note: string }

const LIST_KEY = ["/api/message-templates"];
const wsKey = (id: number) => [`/api/message-templates/${id}/workspace`];

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

function SandboxedEmail({ html, title }: { html: string; title: string }) {
  // Empty sandbox: no scripts, forms, navigation or same-origin access for the previewed markup.
  return <iframe title={title} sandbox="" srcDoc={html} className="w-full h-64 rounded-md border bg-white" />;
}

export function MessageTemplateEditor({
  templateId, canEdit, canActivate, onClose,
}: { templateId: number | null; canEdit: boolean; canActivate: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const open = templateId !== null;
  const { data: ws, isLoading, isError, error } = useQuery<Workspace>({
    queryKey: wsKey(templateId ?? 0),
    enabled: open && canEdit,
  });

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [seeded, setSeeded] = useState<string | null>(null);
  const [publishFindings, setPublishFindings] = useState<Finding[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (!ws) return;
    const key = `${ws.template.id}:${ws.template.contentVersion}:${ws.draft?.id ?? "none"}:${ws.draft?.updatedAt ?? ""}`;
    if (key === seeded) return;
    const src = ws.draft ?? ws.template;
    setSubject(src.subject ?? "");
    setBody(src.body);
    setSeeded(key);
    setPublishFindings([]);
  }, [ws, seeded]);

  useEffect(() => { if (!open) { setSeeded(null); setPreview(null); setPublishFindings([]); } }, [open]);

  // Debounced server preview (sample values only; nothing is sent or stored).
  useEffect(() => {
    if (!open || !canEdit || !body.trim()) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await apiRequest("POST", "/api/message-templates/preview", { subject: subject || null, body }, undefined, ctl.signal);
        setPreview(await res.json());
      } catch (e) {
        if ((e as Error).name !== "AbortError") setPreview(null);
      }
    }, 400);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [open, canEdit, subject, body]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: wsKey(templateId ?? 0) }),
      queryClient.invalidateQueries({ queryKey: LIST_KEY }),
    ]);
  };
  const fail = (title: string) => (e: Error) => {
    setPublishFindings(findingsFromError(e));
    toast({ title, description: getApiErrorMessage(e, title), variant: "destructive" });
  };

  const saveDraft = useMutation({
    mutationFn: async () => (await apiRequest("PUT", `/api/message-templates/${templateId}/draft`, {
      subject: subject.trim() === "" ? null : subject, body, baseVersion: ws!.template.contentVersion,
    })).json(),
    onSuccess: async () => { setPublishFindings([]); await refresh(); toast({ title: "Draft saved", description: "Live wording is unchanged." }); },
    onError: fail("Could not save draft"),
  });
  const discard = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/message-templates/${templateId}/draft`)).json(),
    onSuccess: async () => { setSeeded(null); await refresh(); toast({ title: "Draft discarded" }); },
    onError: fail("Could not discard draft"),
  });
  const publish = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/message-templates/${templateId}/publish`, { expectedVersion: ws!.template.contentVersion })).json(),
    onSuccess: async () => { setPublishFindings([]); await refresh(); toast({ title: "Content version published", description: "Wording is now live for this template. Activation was not changed." }); },
    onError: fail("Could not publish"),
  });
  const activation = useMutation({
    mutationFn: async (active: boolean) => (await apiRequest("POST", `/api/message-templates/${templateId}/activation`, { active })).json(),
    onSuccess: async (_d, active) => { setPublishFindings([]); await refresh(); toast({ title: active ? "Campaign actions activated" : "Campaign actions deactivated" }); },
    onError: fail("Could not change activation"),
  });

  const busy = saveDraft.isPending || discard.isPending || publish.isPending || activation.isPending;
  const t = ws?.template;
  const baseline = ws?.draft ?? t;
  const dirty = useMemo(() => !!baseline && ((baseline.subject ?? "") !== subject || baseline.body !== body), [baseline, subject, body]);
  const hasDraft = !!ws?.draft;
  const draftCurrent = hasDraft && ws!.draft!.baseVersion === t!.contentVersion;
  const canPublish = canEdit && hasDraft && draftCurrent && !dirty && ws!.draftFindings.length === 0;
  const canSave = canEdit && !!t && dirty;
  const isActive = t?.isActive === true;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="dialog-template-editor">
        <DialogHeader>
          <DialogTitle>{t ? t.name : "Message template"}</DialogTitle>
          <DialogDescription>
            Edit and preview wording here. Saving a draft, publishing a content version and activating campaign actions are three separate steps; none of them sends a message.
          </DialogDescription>
        </DialogHeader>
        {!canEdit ? (
          <p className="text-sm text-muted-foreground">Only an administrator or manager can edit message wording.</p>
        ) : isLoading || !t ? (
          isError ? <p className="text-sm text-destructive">{getApiErrorMessage(error, "Could not load template")}</p>
            : <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="template-status">
              <Badge variant="outline">{t.channel}</Badge>
              <Badge variant="outline" data-testid="badge-live-version">Live version {t.contentVersion}</Badge>
              <Badge variant={hasDraft ? "default" : "secondary"} data-testid="badge-draft-state">
                {hasDraft ? (draftCurrent ? "Draft saved (not live)" : "Draft is out of date") : "No draft"}
              </Badge>
              <Badge variant={isActive ? "default" : "secondary"} data-testid="badge-template-active">
                {isActive ? "Campaign actions active" : "Campaign actions not active"}
              </Badge>
            </div>

            <FindingList findings={ws!.liveFindings} testId="findings-live" />

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                {t.channel === "email" && (
                  <div className="space-y-1">
                    <Label htmlFor="tpl-subject">Subject</Label>
                    <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="input-template-subject" />
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="tpl-body">{t.channel === "email" ? "Body (HTML)" : "Message"}</Label>
                  <Textarea id="tpl-body" rows={14} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" data-testid="input-template-body" />
                </div>
              </div>
              <div className="space-y-2" data-testid="template-preview">
                <Label>Preview (sample values)</Label>
                {preview ? (
                  <>
                    {t.channel === "email" && <p className="text-sm font-medium" data-testid="preview-subject">{preview.subject}</p>}
                    {t.channel === "email"
                      ? <SandboxedEmail html={preview.html} title="Email preview" />
                      : <pre className="whitespace-pre-wrap text-sm rounded-md border p-3" data-testid="preview-sms">{preview.html}</pre>}
                    {preview.unresolved.length > 0 && (
                      <p className="text-xs text-destructive">Unknown merge fields stay literal: {preview.unresolved.join(", ")}</p>
                    )}
                    <FindingList findings={preview.findings} testId="findings-preview" />
                  </>
                ) : <p className="text-sm text-muted-foreground">Preview appears here.</p>}
              </div>
            </div>

            <FindingList findings={publishFindings} testId="findings-action" />

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">1. Save draft</p>
                <p className="text-xs text-muted-foreground">Keeps your edits for review. Live wording does not change.</p>
                <div className="flex flex-wrap gap-2">
                  <Button className="min-h-11" disabled={busy || !canSave} onClick={() => saveDraft.mutate()} data-testid="button-save-draft">Save draft</Button>
                  {hasDraft && (
                    <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => discard.mutate()} data-testid="button-discard-draft">Discard draft</Button>
                  )}
                </div>
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">2. Publish content version</p>
                <p className="text-xs text-muted-foreground">Makes the saved draft the live wording as version {t.contentVersion + 1}. It does not activate the template or send anything.</p>
                <Button className="min-h-11" disabled={busy || !canPublish} onClick={() => publish.mutate()} data-testid="button-publish-content">Publish content version</Button>
                {dirty && <p className="text-xs text-muted-foreground">Save your edits first.</p>}
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-sm font-medium">3. Activate campaign actions</p>
                <p className="text-xs text-muted-foreground">Lets workflow and operator sends use the published wording. Receipts are enabled separately under Request receipts.</p>
                {canActivate ? (
                  <Button className="min-h-11" variant={isActive ? "outline" : "default"} disabled={busy}
                    onClick={() => activation.mutate(!isActive)} data-testid="button-activate-campaign">
                    {isActive ? "Deactivate campaign actions" : "Activate campaign actions"}
                  </Button>
                ) : <p className="text-xs text-muted-foreground">Only an administrator can change activation.</p>}
              </div>
            </div>

            {ws!.history.length > 0 && (
              <div className="space-y-1" data-testid="template-history">
                <Label>Published versions</Label>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {ws!.history.map((h) => (
                    <li key={h.id}>Version {h.version}{h.publishedAt ? ` - ${new Date(h.publishedAt).toLocaleString()}` : " - wording live before versioning"}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ReceiptPreviews { previews: Array<{ sourceClass: string; templateKey: string; subject: string; html: string; text: string }>; note: string }

const RECEIPT_LABELS: Record<string, string> = {
  sales_request: "Sales requests", support_request: "Support requests", fulfillment_request: "Equipment orders",
  partner_application_request: "Partner applications", privacy_request: "Privacy requests",
};

/** Read-only view of the exact receipt wording. Delivery is enabled in the Request receipts card, not here. */
export function ReceiptWordingPreview({ canView }: { canView: boolean }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error } = useQuery<ReceiptPreviews>({
    queryKey: ["/api/admin/inbound-acknowledgements/preview"],
    enabled: open && canView,
  });
  if (!canView) return null;
  return (
    <div className="space-y-3 pt-4 border-t" data-testid="receipt-wording-preview">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <p className="text-sm font-medium">Request receipt wording</p>
          <p className="text-xs text-muted-foreground">Fixed factual wording with a reference number and no timing promise. Turn on delivery with "Enable transactional purpose" in Request receipts below.</p>
        </div>
        <Button variant="outline" className="min-h-11" onClick={() => setOpen((v) => !v)} data-testid="button-toggle-receipt-preview">
          {open ? "Hide receipt preview" : "Preview receipts"}
        </Button>
      </div>
      {open && (isLoading ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        : isError ? <p className="text-sm text-destructive">{getApiErrorMessage(error, "Could not load receipt preview")}</p>
        : data && (
          <div className="grid gap-4 md:grid-cols-3">
            {data.previews.map((p) => (
              <div key={p.sourceClass} className="space-y-1" data-testid={`receipt-preview-${p.sourceClass}`}>
                <p className="text-xs font-medium">{RECEIPT_LABELS[p.sourceClass] ?? p.sourceClass}</p>
                <p className="text-xs text-muted-foreground">{p.subject}</p>
                <SandboxedEmail html={p.html} title={`Receipt preview: ${p.sourceClass}`} />
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
