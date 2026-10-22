import { PageTitle } from "@/components/ui/page-header";
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getCsrfToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useChargebackSubmission } from "@/hooks/use-chargeback-submission";
import { ChargebackCommandStatus } from "@/components/crm/ChargebackCommandStatus";
import { ChargebackMidSelect } from "@/components/crm/ChargebackMidSelect";
import type { Chargeback } from "@shared/schema";
import { CHARGEBACK_STATUSES, CHARGEBACK_CARD_BRANDS, CHARGEBACK_DEADLINE_DAYS } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle, Plus, DollarSign, Clock, CheckCircle, XCircle, TrendingDown,
  ShieldAlert, FileText, ChevronRight, X, Loader2, ArrowUpRight, Sparkles,
  ClipboardCopy, Download, Check, AlertCircle, HelpCircle, ChevronDown, ChevronUp,
  UploadCloud, Send,
} from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  New: { label: "New", variant: "secondary" },
  "Under Review": { label: "Under Review", variant: "outline" },
  Responded: { label: "Responded", variant: "default" },
  Won: { label: "Won", variant: "default", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  Lost: { label: "Lost", variant: "destructive" },
};

const REASON_CODE_OPTIONS = [
  "13.1 – Merchandise/Services Not Received",
  "13.2 – Canceled Recurring",
  "13.3 – Not as Described",
  "13.4 – Counterfeit / Fraud",
  "13.5 – Misrepresentation",
  "13.6 – Credit Not Processed",
  "13.7 – Canceled Merchandise / Services",
  "4853 – Cardholder Dispute",
  "4855 – Non-Receipt of Merchandise",
  "4831 – Transaction Amount Differs",
  "4834 – Duplicate Processing",
  "4863 – Cardholder Does Not Recognize",
  "4849 – Questionable Merchant Activity",
  "C08 – Goods / Services Not Received",
  "C14 – Paid by Other Means",
  "C28 – Canceled Recurring",
  "C31 – Goods / Services Not as Described",
  "Other",
];

function isOverdue(cb: Chargeback): boolean {
  if (!cb.responseDeadline) return false;
  if (cb.status === "Won" || cb.status === "Lost") return false;
  return new Date(cb.responseDeadline) < new Date();
}

function daysUntilDeadline(cb: Chargeback): number | null {
  if (!cb.responseDeadline) return null;
  const diff = new Date(cb.responseDeadline).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function formatDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

interface ChargebackFormState {
  contactId: string;
  dealId: string;
  transactionDate: string;
  amount: string;
  cardBrand: string;
  reasonCode: string;
  reasonDescription: string;
  notes: string;
}

const DEFAULT_FORM: ChargebackFormState = {
  contactId: "",
  dealId: "",
  transactionDate: "",
  amount: "",
  cardBrand: "Visa",
  reasonCode: "",
  reasonDescription: "",
  notes: "",
};

type ChecklistItem = { item: string; status: "included" | "missing" | "partial"; notes?: string };

type AiPacket = {
  rebuttalletter: string;
  evidenceChecklist: ChecklistItem[];
  winLikelihood: { estimate: string; rationale: string };
  reasonCodeContext: string;
  generatedAt: string;
  finalizedAt?: string;
  editedRebuttal?: string;
  merchantProfile?: {
    merchantName: string;
    address?: string;
    city?: string;
    state?: string;
    website?: string;
    vertical?: string;
    mid?: string;
  };
};

function WinLikelihoodBadge({ estimate }: { estimate: string }) {
  if (estimate === "High") return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">High Win Likelihood</Badge>;
  if (estimate === "Moderate") return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">Moderate Win Likelihood</Badge>;
  if (estimate === "Low") return <Badge variant="destructive">Low Win Likelihood</Badge>;
  return <Badge variant="outline">{estimate}</Badge>;
}

function ChecklistStatusIcon({ status }: { status: string }) {
  if (status === "included") return <Check className="w-4 h-4 text-green-600 shrink-0" />;
  if (status === "partial") return <HelpCircle className="w-4 h-4 text-amber-500 shrink-0" />;
  return <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />;
}

interface CopilotPanelProps {
  chargeback: Chargeback;
  onClose: () => void;
}

function CopilotPanel({ chargeback: cb, onClose }: CopilotPanelProps) {
  const { toast } = useToast();
  const [submissionMid,setSubmissionMid]=useState("");
  const {mutation:submission}=useChargebackSubmission(cb.id,cb.contactId);
  const existing = cb.aiEvidencePacket as AiPacket | null;
  const [packet, setPacket] = useState<AiPacket | null>(existing);
  const [editedRebuttal, setEditedRebuttal] = useState(existing?.editedRebuttal || existing?.rebuttalletter || "");
  const [editedChecklist, setEditedChecklist] = useState<ChecklistItem[]>(existing?.evidenceChecklist || []);
  const [copied, setCopied] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(true);

  const syncState = (p: AiPacket) => {
    setPacket(p);
    setEditedRebuttal(p.editedRebuttal || p.rebuttalletter || "");
    setEditedChecklist(p.evidenceChecklist || []);
  };

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/ai/chargeback-copilot/${cb.id}`, {});
      if (!res.ok) { const err = await res.json(); throw new Error(err.message || "Generation failed"); }
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.error) {
        toast({ title: data.errorType === "credential" ? "AI Credentials Issue" : data.errorType === "quota" ? "AI Quota Exceeded" : "AI Unavailable", description: data.message || "Evidence packet generation is temporarily unavailable.", variant: "destructive" });
        return;
      }
      syncState(data.packet as AiPacket);
      queryClient.invalidateQueries({ queryKey: ["/api/chargebacks"] });
      toast({ title: "Evidence packet generated", description: "Review and edit before finalizing." });
    },
    onError: (err: any) => toast({ title: "Generation failed", description: err.message, variant: "destructive" }),
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/ai/chargeback-copilot/${cb.id}/finalize`, {
        editedRebuttal,
        editedChecklist,
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.message || "Finalization failed"); }
      return res.json();
    },
    onSuccess: (data) => {
      const p = data.chargeback?.aiEvidencePacket as AiPacket;
      if (p) syncState(p);
      queryClient.invalidateQueries({ queryKey: ["/api/chargebacks"] });
      toast({ title: "Packet finalized", description: "Changes saved. Ready to download." });
    },
    onError: (err: any) => toast({ title: "Finalization failed", description: err.message, variant: "destructive" }),
  });

  const downloadPdfMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/chargebacks/${cb.id}/pdf`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to generate PDF" }));
        throw new Error(err.message || "Failed to generate PDF");
      }
      return res.blob();
    },
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chargeback-evidence-${cb.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onError: (err: any) => toast({ title: "Download failed", description: err.message, variant: "destructive" }),
  });

  // #285 — Submit evidence packet to card brand
  const submitToCardBrandMutation = useMutation({
    mutationFn: async () => {
      return submission.mutateAsync({midId:Number(submissionMid)});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chargebacks"] });
      toast({ title: "Evidence intent accepted", description: "Queued only. No transmission or final card-brand receipt is established." });
    },
      onError: (err: any) => toast({ title: "Acceptance not confirmed", description: `${err.message} Retry unchanged and refresh submission status.`, variant: "destructive" }),
  });

  const updateChecklistItem = (i: number, changes: Partial<ChecklistItem>) => {
    setEditedChecklist(prev => prev.map((c, idx) => idx === i ? { ...c, ...changes } : c));
  };

  const handleCopy = async () => {
    if (!packet) return;
    const cl = editedChecklist.length ? editedChecklist : packet.evidenceChecklist;
    const text = [
      "CHARGEBACK EVIDENCE PACKET",
      "=".repeat(40),
      `Merchant: ${packet.merchantProfile?.merchantName || ""}`,
      `Reason Code: ${cb.reasonCode}`,
      `Card Brand: ${cb.cardBrand}`,
      `Amount: ${formatCurrency(cb.amount)}`,
      `Transaction Date: ${formatDate(cb.transactionDate)}`,
      "",
      "REBUTTAL LETTER",
      "=".repeat(40),
      editedRebuttal || packet.rebuttalletter,
      "",
      "EVIDENCE CHECKLIST",
      "=".repeat(40),
      ...cl.map(c => `[${c.status.toUpperCase()}] ${c.item}${c.notes ? ` — ${c.notes}` : ""}`),
      "",
      `WIN LIKELIHOOD: ${packet.winLikelihood.estimate}`,
      packet.winLikelihood.rationale,
    ].join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "Copied to clipboard" });
  };

  const included = editedChecklist.filter(c => c.status === "included").length;
  const total = editedChecklist.length;

  return (
    <div className="flex flex-col h-full" data-testid="copilot-panel">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-4 border-b shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-bold">AI Chargeback Copilot</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {cb.reasonCode} &nbsp;·&nbsp; {cb.cardBrand} &nbsp;·&nbsp; {formatCurrency(cb.amount)}
            {packet?.merchantProfile?.merchantName && (
              <> &nbsp;·&nbsp; <span className="font-medium text-foreground">{packet.merchantProfile.merchantName}</span></>
            )}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close copilot" onClick={onClose} data-testid="button-close-copilot">
          <X className="w-4 h-4" />
        </Button>
      </div>

      {!packet ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 py-10">
          <Sparkles className="w-12 h-12 text-muted-foreground" />
          <div className="text-center">
            <p className="font-semibold text-base">No evidence packet yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              AI will analyze this chargeback, map the reason code strategy, draft a rebuttal letter,
              and generate a complete evidence checklist based on your merchant's transaction history.
            </p>
          </div>
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            size="lg"
            data-testid="button-generate-packet"
          >
            {generateMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            {generateMutation.isPending ? "Analyzing chargeback…" : "Build Evidence Packet"}
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-4 pb-4 pr-1">

            {/* LEFT COLUMN — context + checklist */}
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <WinLikelihoodBadge estimate={packet.winLikelihood.estimate} />
                <Badge variant="outline">{included}/{total} evidence ready</Badge>
                {packet.finalizedAt && <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Finalized</Badge>}
                <span className="text-xs text-muted-foreground ml-auto">Generated {new Date(packet.generatedAt).toLocaleString()}</span>
              </div>

              {packet.reasonCodeContext && (
                <div className="rounded-md bg-muted/60 px-4 py-3 text-sm border">
                  <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-1">Dispute Context</p>
                  <p>{packet.reasonCodeContext}</p>
                </div>
              )}

              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Win Likelihood Rationale</p>
                <p className="text-sm">{packet.winLikelihood.rationale}</p>
              </div>

              {/* Editable Evidence Checklist */}
              <div className="space-y-2">
                <div
                  className="flex items-center justify-between cursor-pointer select-none"
                  onClick={() => setChecklistOpen(v => !v)}
                  data-testid="button-toggle-checklist"
                >
                  <p className="text-sm font-semibold">Evidence Checklist ({included}/{total} ready)</p>
                  {checklistOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
                {checklistOpen && (
                  <div className="border rounded-md divide-y" data-testid="evidence-checklist">
                    {editedChecklist.map((c, i) => (
                      <div key={i} className="px-3 py-3 space-y-2" data-testid={`checklist-item-${i}`}>
                        <div className="flex items-center gap-2">
                          <ChecklistStatusIcon status={c.status} />
                          <span className="text-sm font-medium flex-1">{c.item}</span>
                          <Select
                            value={c.status}
                            onValueChange={(val) => updateChecklistItem(i, { status: val as ChecklistItem["status"] })}
                          >
                            <SelectTrigger
                              className="h-6 w-24 text-xs px-2"
                              data-testid={`select-checklist-status-${i}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="included">Included</SelectItem>
                              <SelectItem value="partial">Partial</SelectItem>
                              <SelectItem value="missing">Missing</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <Input
                          value={c.notes || ""}
                          onChange={e => updateChecklistItem(i, { notes: e.target.value })}
                          placeholder="Add notes…"
                          className="h-7 text-xs"
                          data-testid={`input-checklist-notes-${i}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT COLUMN — rebuttal letter */}
            <div className="space-y-2 flex flex-col">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Rebuttal Letter</p>
                <span className="text-xs text-muted-foreground">Edit before finalizing</span>
              </div>
              <Textarea
                value={editedRebuttal}
                onChange={e => setEditedRebuttal(e.target.value)}
                className="font-mono text-sm resize-none flex-1 min-h-[420px]"
                placeholder="Rebuttal letter will appear here…"
                data-testid="textarea-rebuttal"
              />
            </div>
          </div>
        </div>
      )}

      {/* Action bar — always visible */}
      {packet && (
        <div className="flex flex-wrap gap-2 pt-3 border-t shrink-0">
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            variant="outline"
            size="sm"
            data-testid="button-regenerate"
          >
            {generateMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
            Regenerate
          </Button>

          <Button
            onClick={() => finalizeMutation.mutate()}
            disabled={finalizeMutation.isPending}
            size="sm"
            data-testid="button-finalize"
          >
            {finalizeMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Check className="w-3 h-3 mr-1" />}
            Finalize & Save
          </Button>

          <Button
            onClick={handleCopy}
            variant="outline"
            size="sm"
            data-testid="button-copy-packet"
          >
            {copied ? <Check className="w-3 h-3 mr-1 text-green-600" /> : <ClipboardCopy className="w-3 h-3 mr-1" />}
            Copy
          </Button>

          <Button
            onClick={() => downloadPdfMutation.mutate()}
            disabled={downloadPdfMutation.isPending}
            variant="outline"
            size="sm"
            data-testid="button-download-pdf"
          >
            {downloadPdfMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
            Download PDF
          </Button>

          {/* #285 — Submit evidence to card brand */}
          {packet?.finalizedAt && <ChargebackMidSelect id={cb.id} value={submissionMid} onChange={setSubmissionMid} disabled={submission.isPending || submission.isSuccess}/>}
          {packet?.finalizedAt && (
            <Button
              onClick={() => submitToCardBrandMutation.mutate()}
              disabled={submitToCardBrandMutation.isPending || submission.isSuccess || !submissionMid.trim() || cb.status.toLowerCase() === "responded"}
              variant={cb.status === "responded" ? "outline" : "default"}
              size="sm"
              data-testid="button-submit-to-card-brand"
              className={cb.status === "responded" ? "border-green-300 text-green-700" : ""}
            >
              {submitToCardBrandMutation.isPending
                ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                : cb.status === "responded"
                  ? <Check className="w-3 h-3 mr-1 text-green-600" />
                  : <Send className="w-3 h-3 mr-1" />}
              {submission.isSuccess ? "Accepted / queued" : cb.status.toLowerCase() === "responded" ? "Final response recorded" : "Queue evidence intent"}
            </Button>
          )}
        </div>
      )}
      <ChargebackCommandStatus id={cb.id}/>
    </div>
  );
}

interface DetailPanelProps {
  chargeback: Chargeback;
  onClose: () => void;
  onUpdated: () => void;
  onOpenCopilot: () => void;
}

function ChargebackDetailPanel({ chargeback: cb, onClose, onUpdated, onOpenCopilot }: DetailPanelProps) {
  const { toast } = useToast();
  const [notes, setNotes] = useState(cb.notes || "");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateMutation = useMutation({
    mutationFn: async (body: Record<string, any>) => {
      const res = await apiRequest("PATCH", `/api/chargebacks/${cb.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chargebacks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chargebacks/stats"] });
      toast({ title: "Chargeback updated" });
      onUpdated();
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const evidenceFiles = (cb.evidenceFiles as any[]) || [];
    if (evidenceFiles.length >= MAX_EVIDENCE_FILES) {
      toast({ title: `Maximum ${MAX_EVIDENCE_FILES} evidence files per chargeback`, variant: "destructive" });
      return;
    }

    const file = files[0];
    if (file.size > MAX_EVIDENCE_BYTES) {
      toast({ title: "File too large — maximum 10 MB per file", variant: "destructive" });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    setUploading(true);
    try {
      const csrfToken = getCsrfToken();
      const res = await fetch(`/api/chargebacks/${cb.id}/evidence/upload`, {
        method: "POST",
        headers: csrfToken ? { "x-csrf-token": csrfToken } : {},
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || "Upload failed");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/chargebacks"] });
      toast({ title: "Evidence file uploaded" });
      onUpdated();
    } catch (err: any) {
      toast({ title: err.message || "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const overdue = isOverdue(cb);
  const days = daysUntilDeadline(cb);
  const statusConfig = STATUS_CONFIG[cb.status] || STATUS_CONFIG["New"];
  const evidenceFiles = (cb.evidenceFiles as any[]) || [];
  const aiPacket = cb.aiEvidencePacket as AiPacket | null;

  return (
    <div className="flex flex-col gap-6" data-testid="chargeback-detail-panel">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={statusConfig.className} variant={statusConfig.variant} data-testid="badge-detail-status">
              {statusConfig.label}
            </Badge>
            {overdue && (
              <Badge variant="destructive" data-testid="badge-detail-overdue">
                <AlertTriangle className="w-3 h-3 mr-1" /> OVERDUE
              </Badge>
            )}
            <Badge variant="outline" data-testid="badge-detail-brand">{cb.cardBrand}</Badge>
          </div>
          <p className="text-2xl font-bold mt-2" data-testid="text-detail-amount">{formatCurrency(cb.amount)}</p>
          <p className="text-sm text-muted-foreground" data-testid="text-detail-reason-code">{cb.reasonCode}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close detail" onClick={onClose} data-testid="button-close-detail">
          <X className="w-4 h-4" />
        </Button>
      </div>

      <Button
        onClick={onOpenCopilot}
        className="w-full"
        variant={aiPacket ? "outline" : "default"}
        data-testid="button-open-copilot"
      >
        <Sparkles className="w-4 h-4 mr-2" />
        {aiPacket ? "View / Edit Evidence Packet" : "Build Evidence Packet (AI)"}
        {aiPacket && (
          <Badge variant="secondary" className="ml-2 text-xs">
            {(aiPacket as any).finalizedAt ? "Finalized" : "Draft"}
          </Badge>
        )}
      </Button>

      {/* #1445 — Download PDF Evidence Packet (available once AI packet is finalized) */}
      {aiPacket && (aiPacket as any).finalizedAt && (
        <a
          href={`/api/chargebacks/${cb.id}/pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full"
          data-testid="link-download-pdf"
        >
          <Button variant="outline" className="w-full border-green-400 text-green-700 hover:bg-green-50 dark:text-green-400 dark:border-green-700">
            <Download className="w-4 h-4 mr-2" />
            Download PDF Evidence Packet
          </Button>
        </a>
      )}

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground block">Transaction Date</span>
          <span className="font-medium" data-testid="text-detail-tx-date">{formatDate(cb.transactionDate)}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">Response Deadline</span>
          <span className={`font-medium ${overdue ? "text-red-600 dark:text-red-400" : days !== null && days <= 7 ? "text-amber-600 dark:text-amber-400" : ""}`} data-testid="text-detail-deadline">
            {cb.responseDeadline ? (
              <>
                {formatDate(cb.responseDeadline)}
                {days !== null && !["Won", "Lost"].includes(cb.status) && (
                  <span className="ml-1 text-xs">({overdue ? `${Math.abs(days)}d overdue` : `${days}d left`})</span>
                )}
              </>
            ) : "—"}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground block">Card Brand</span>
          <span className="font-medium" data-testid="text-detail-card-brand">{cb.cardBrand}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">Created</span>
          <span className="font-medium" data-testid="text-detail-created">{formatDate(cb.createdAt)}</span>
        </div>
        {cb.respondedAt && (
          <div>
            <span className="text-muted-foreground block">Responded At</span>
            <span className="font-medium" data-testid="text-detail-responded">{formatDate(cb.respondedAt)}</span>
          </div>
        )}
        {cb.outcome && (
          <div>
            <span className="text-muted-foreground block">Outcome</span>
            <span className="font-medium" data-testid="text-detail-outcome">{cb.outcome}</span>
          </div>
        )}
      </div>

      {cb.reasonDescription && (
        <div>
          <p className="text-sm text-muted-foreground mb-1">Reason Description</p>
          <p className="text-sm" data-testid="text-detail-reason-desc">{cb.reasonDescription}</p>
        </div>
      )}

      <div className="border-t pt-4">
        <p className="text-sm font-medium mb-2">Update Status</p>
        <div className="flex flex-wrap gap-2">
          {CHARGEBACK_STATUSES.map(s => (
            <Button
              key={s}
              size="sm"
              variant={cb.status === s ? "default" : "outline"}
              onClick={() => {
                const body: Record<string, any> = { status: s };
                if (s === "Won" || s === "Lost") body.outcome = s;
                if (s === "Responded") body.respondedAt = new Date().toISOString();
                updateMutation.mutate(body);
              }}
              disabled={updateMutation.isPending}
              data-testid={`button-status-${s.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      <div className="border-t pt-4">
        <p className="text-sm font-medium mb-2">Notes</p>
        <Textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Add notes about this chargeback..."
          rows={3}
          data-testid="textarea-notes"
        />
        <Button
          size="sm"
          className="mt-2"
          onClick={() => updateMutation.mutate({ notes })}
          disabled={updateMutation.isPending}
          data-testid="button-save-notes"
        >
          Save Notes
        </Button>
      </div>

      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium">Evidence Files ({evidenceFiles.length}/{MAX_EVIDENCE_FILES})</p>
          {evidenceFiles.length > 0 && (
            <span className="text-xs text-muted-foreground">PDF, JPG, PNG, CSV · 10 MB max</span>
          )}
        </div>

        {evidenceFiles.length > 0 && (
          <div className="space-y-2 mb-3">
            {evidenceFiles.map((f: any, i: number) => {
              const downloadUrl = f.storageKey
                ? `/api/chargebacks/${cb.id}/evidence/download?key=${encodeURIComponent(f.storageKey)}`
                : f.url;
              return (
                <div key={i} className="flex items-center gap-2 text-sm bg-muted/40 rounded px-2 py-1.5" data-testid={`evidence-file-${i}`}>
                  <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  <a
                    href={downloadUrl}
                    target={f.storageKey ? undefined : "_blank"}
                    download={f.storageKey ? f.name : undefined}
                    rel="noopener noreferrer"
                    className="text-primary hover:underline truncate flex-1"
                  >
                    {f.name}
                  </a>
                  {f.fileSize && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {f.fileSize < 1024 * 1024
                        ? `${Math.round(f.fileSize / 1024)} KB`
                        : `${(f.fileSize / (1024 * 1024)).toFixed(1)} MB`}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground shrink-0">{formatDate(f.uploadedAt)}</span>
                  {f.storageKey && (
                    <a
                      href={downloadUrl}
                      download={f.name}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label="Download"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {evidenceFiles.length < MAX_EVIDENCE_FILES ? (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={EVIDENCE_ACCEPT}
              className="hidden"
              data-testid="input-evidence-file"
              onChange={handleFileUpload}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              data-testid="button-attach-evidence"
              className="w-full flex flex-col items-center gap-1.5 rounded-md border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30 transition-colors px-4 py-4 text-sm text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Uploading…</span>
                </>
              ) : (
                <>
                  <UploadCloud className="w-5 h-5" />
                  <span><span className="text-primary font-medium">Click to upload</span> evidence file</span>
                  <span className="text-xs">PDF, JPG, PNG, CSV · max 10 MB</span>
                </>
              )}
            </button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground text-center py-2">
            Maximum {MAX_EVIDENCE_FILES} files reached. Remove a file to upload another.
          </p>
        )}
      </div>
    </div>
  );
}

export default function Chargebacks() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [overdueFilter, setOverdueFilter] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedCb, setSelectedCb] = useState<Chargeback | null>(null);
  const [copilotCb, setCopilotCb] = useState<Chargeback | null>(null);
  const [form, setForm] = useState<ChargebackFormState>(DEFAULT_FORM);
  const [downloadingPdfId, setDownloadingPdfId] = useState<number | null>(null);

  async function downloadRowPdf(e: React.MouseEvent, cbId: number) {
    e.stopPropagation();
    if (downloadingPdfId !== null) return;
    setDownloadingPdfId(cbId);
    try {
      const res = await fetch(`/api/chargebacks/${cbId}/pdf`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to generate PDF" }));
        throw new Error(err.message || "Failed to generate PDF");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chargeback-evidence-${cbId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloadingPdfId(null);
    }
  }

  const queryParams = new URLSearchParams();
  if (statusFilter !== "all") queryParams.set("status", statusFilter);
  if (brandFilter !== "all") queryParams.set("cardBrand", brandFilter);
  if (overdueFilter) queryParams.set("overdueOnly", "true");

  const { data: chargebackList = [], isLoading } = useQuery<Chargeback[]>({
    queryKey: ["/api/chargebacks", statusFilter, brandFilter, overdueFilter],
    queryFn: async () => {
      const res = await fetch(`/api/chargebacks?${queryParams}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const { data: stats } = useQuery<{
    total: number; open: number; overdue: number; won: number; lost: number; thisMonthWinRate: number | null; thisMonthWinRateBasis?: { numerator: number; denominator: number; available: boolean }; totalAtRiskAmount: number;
  }>({
    queryKey: ["/api/chargebacks/stats"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/chargebacks", {
        contactId: form.contactId ? Number(form.contactId) : undefined,
        dealId: form.dealId ? Number(form.dealId) : undefined,
        transactionDate: form.transactionDate,
        amount: parseFloat(form.amount),
        cardBrand: form.cardBrand,
        reasonCode: form.reasonCode,
        reasonDescription: form.reasonDescription || undefined,
        notes: form.notes || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chargebacks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chargebacks/stats"] });
      toast({ title: "Chargeback logged successfully" });
      setShowCreate(false);
      setForm(DEFAULT_FORM);
    },
    onError: (err: any) => {
      toast({ title: "Failed to log chargeback", description: err.message, variant: "destructive" });
    },
  });

  const deadlineDays = CHARGEBACK_DEADLINE_DAYS[form.cardBrand] ?? 30;

  if (isLoading) {
    return (
      <div className="space-y-6" data-testid="chargebacks-loading">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-chargebacks">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <PageTitle className="text-2xl font-bold" data-testid="text-page-title">Chargebacks</PageTitle>
          <p className="text-muted-foreground mt-1">Track disputes, manage deadlines, and win more chargebacks</p>
        </div>
        <Button onClick={() => setShowCreate(true)} data-testid="button-log-chargeback">
          <Plus className="w-4 h-4 mr-2" /> Log Chargeback
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card data-testid="card-stat-open">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">Open Disputes</CardTitle>
            <ShieldAlert className="w-4 h-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-stat-open">{stats?.open ?? 0}</div>
            <p className="text-xs text-muted-foreground">Requiring action</p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-overdue">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">Overdue</CardTitle>
            <AlertTriangle className="w-4 h-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600 dark:text-red-400" data-testid="text-stat-overdue">{stats?.overdue ?? 0}</div>
            <p className="text-xs text-muted-foreground">Past deadline</p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-winrate">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">This Month Win Rate</CardTitle>
            <CheckCircle className="w-4 h-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600 dark:text-green-400" data-testid="text-stat-winrate">{stats?.thisMonthWinRate == null ? "No decided deals" : `${stats.thisMonthWinRate}%`}</div>
            <p className="text-xs text-muted-foreground" data-testid="text-stat-winrate-basis">
              {stats?.thisMonthWinRateBasis ? `${stats.thisMonthWinRateBasis.numerator} won of ${stats.thisMonthWinRateBasis.denominator} decided this month` : "This month's decided disputes"}
              {" · "}all time: {stats?.won ?? 0} won / {stats?.lost ?? 0} lost
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-at-risk">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total At-Risk</CardTitle>
            <DollarSign className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-stat-at-risk">{formatCurrency(stats?.totalAtRiskAmount ?? 0)}</div>
            <p className="text-xs text-muted-foreground">Open dispute value</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" data-testid="select-status-filter">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {CHARGEBACK_STATUSES.map(s => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={brandFilter} onValueChange={setBrandFilter}>
          <SelectTrigger className="w-40" data-testid="select-brand-filter">
            <SelectValue placeholder="All Card Brands" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Card Brands</SelectItem>
            {CHARGEBACK_CARD_BRANDS.map(b => (
              <SelectItem key={b} value={b}>{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={overdueFilter ? "default" : "outline"}
          size="sm"
          onClick={() => setOverdueFilter(v => !v)}
          data-testid="button-filter-overdue"
        >
          <Clock className="w-4 h-4 mr-1" /> Overdue Only
        </Button>

        {(statusFilter !== "all" || brandFilter !== "all" || overdueFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setStatusFilter("all"); setBrandFilter("all"); setOverdueFilter(false); }}
            data-testid="button-clear-filters"
          >
            <X className="w-3 h-3 mr-1" /> Clear Filters
          </Button>
        )}
      </div>

      <Card data-testid="card-chargeback-list">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingDown className="w-4 h-4" />
            Chargeback Log
            <Badge variant="secondary">{chargebackList.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chargebackList.length === 0 ? (
            <div className="text-center py-12" data-testid="text-no-chargebacks">
              <ShieldAlert className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground font-medium">No chargebacks found</p>
              <p className="text-sm text-muted-foreground mt-1">Log your first chargeback using the button above</p>
            </div>
          ) : (
            <div className="space-y-2">
              {chargebackList.map(cb => {
                const overdue = isOverdue(cb);
                const days = daysUntilDeadline(cb);
                const statusConf = STATUS_CONFIG[cb.status] || STATUS_CONFIG["New"];
                const aiPacket = cb.aiEvidencePacket as AiPacket | null;
                return (
                  <div
                    key={cb.id}
                    className={`flex flex-wrap items-center justify-between gap-3 p-4 rounded-md border cursor-pointer hover:bg-muted/50 transition-colors ${overdue ? "border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/20" : ""}`}
                    onClick={() => setSelectedCb(cb)}
                    data-testid={`row-chargeback-${cb.id}`}
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className={`mt-0.5 shrink-0 ${overdue ? "text-red-500" : "text-muted-foreground"}`}>
                        {overdue ? <AlertTriangle className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
                      </div>
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm" data-testid={`text-cb-amount-${cb.id}`}>
                            {formatCurrency(cb.amount)}
                          </span>
                          <Badge variant="outline" data-testid={`badge-cb-brand-${cb.id}`}>{cb.cardBrand}</Badge>
                          <Badge className={statusConf.className} variant={statusConf.variant} data-testid={`badge-cb-status-${cb.id}`}>
                            {statusConf.label}
                          </Badge>
                          {overdue && (
                            <Badge variant="destructive" data-testid={`badge-cb-overdue-${cb.id}`}>OVERDUE</Badge>
                          )}
                          {aiPacket && (
                            <Badge
                              variant="outline"
                              className="border-primary/40 text-primary text-xs"
                              data-testid={`badge-cb-ai-${cb.id}`}
                            >
                              <Sparkles className="w-3 h-3 mr-1" />
                              {aiPacket.finalizedAt ? "Finalized" : "AI Draft"}
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground" data-testid={`text-cb-reason-${cb.id}`}>{cb.reasonCode}</p>
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          <span>Tx: {formatDate(cb.transactionDate)}</span>
                          {cb.responseDeadline && (
                            <span className={overdue ? "text-red-500 font-medium" : days !== null && days <= 7 ? "text-amber-500 font-medium" : ""}>
                              Deadline: {formatDate(cb.responseDeadline)}
                              {!["Won", "Lost"].includes(cb.status) && days !== null && (
                                <span className="ml-1">({overdue ? `${Math.abs(days)}d overdue` : `${days}d left`})</span>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant={aiPacket ? "outline" : "ghost"}
                        className="text-xs"
                        onClick={e => { e.stopPropagation(); setCopilotCb(cb); }}
                        data-testid={`button-copilot-${cb.id}`}
                      >
                        <Sparkles className="w-3 h-3 mr-1" />
                        {aiPacket ? "View Packet" : "Build Packet"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-xs"
                        onClick={e => {
                          if (!aiPacket) {
                            e.stopPropagation();
                            toast({ title: "No evidence packet", description: "Build an evidence packet first before downloading the PDF.", variant: "destructive" });
                            return;
                          }
                          downloadRowPdf(e, cb.id);
                        }}
                        disabled={downloadingPdfId === cb.id}
                        aria-label={`Download PDF for chargeback ${cb.id}`}
                        data-testid={`button-pdf-${cb.id}`}
                        title={aiPacket ? "Download evidence PDF" : "Build packet first"}
                      >
                        {downloadingPdfId === cb.id
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Download className="w-3 h-3" />}
                      </Button>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="dialog-create-chargeback">
          <DialogHeader>
            <DialogTitle>Log New Chargeback</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Contact ID (optional)</Label>
                <Input
                  type="number"
                  placeholder="e.g. 42"
                  value={form.contactId}
                  onChange={e => setForm(p => ({ ...p, contactId: e.target.value }))}
                  data-testid="input-contact-id"
                />
              </div>
              <div className="space-y-1">
                <Label>Deal ID (optional)</Label>
                <Input
                  type="number"
                  placeholder="e.g. 7"
                  value={form.dealId}
                  onChange={e => setForm(p => ({ ...p, dealId: e.target.value }))}
                  data-testid="input-deal-id"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Transaction Date *</Label>
                <Input
                  type="date"
                  value={form.transactionDate}
                  onChange={e => setForm(p => ({ ...p, transactionDate: e.target.value }))}
                  data-testid="input-transaction-date"
                />
              </div>
              <div className="space-y-1">
                <Label>Amount ($) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={form.amount}
                  onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                  data-testid="input-amount"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label>Card Brand *</Label>
              <Select value={form.cardBrand} onValueChange={v => setForm(p => ({ ...p, cardBrand: v }))}>
                <SelectTrigger data-testid="select-card-brand">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHARGEBACK_CARD_BRANDS.map(b => (
                    <SelectItem key={b} value={b}>{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Response deadline auto-set to <strong>{deadlineDays} days</strong> from transaction date ({form.cardBrand} standard)
              </p>
            </div>

            <div className="space-y-1">
              <Label>Reason Code *</Label>
              <Select value={form.reasonCode} onValueChange={v => setForm(p => ({ ...p, reasonCode: v }))}>
                <SelectTrigger data-testid="select-reason-code">
                  <SelectValue placeholder="Select reason code..." />
                </SelectTrigger>
                <SelectContent>
                  {REASON_CODE_OPTIONS.map(r => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Reason Description (optional)</Label>
              <Input
                placeholder="Brief description of the dispute"
                value={form.reasonDescription}
                onChange={e => setForm(p => ({ ...p, reasonDescription: e.target.value }))}
                data-testid="input-reason-description"
              />
            </div>

            <div className="space-y-1">
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Additional notes..."
                value={form.notes}
                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                rows={3}
                data-testid="textarea-form-notes"
              />
            </div>

            <div className="flex gap-2 justify-end pt-2">
              <Button variant="outline" onClick={() => { setShowCreate(false); setForm(DEFAULT_FORM); }} data-testid="button-cancel-create">
                Cancel
              </Button>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !form.transactionDate || !form.amount || !form.reasonCode}
                data-testid="button-submit-create"
              >
                {createMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                Log Chargeback
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedCb && !copilotCb} onOpenChange={open => !open && setSelectedCb(null)}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto" data-testid="dialog-chargeback-detail">
          {selectedCb && (
            <ChargebackDetailPanel
              chargeback={selectedCb}
              onClose={() => setSelectedCb(null)}
              onUpdated={() => {
                queryClient.invalidateQueries({ queryKey: ["/api/chargebacks"] });
                setSelectedCb(null);
              }}
              onOpenCopilot={() => {
                setCopilotCb(selectedCb);
                setSelectedCb(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!copilotCb} onOpenChange={open => !open && setCopilotCb(null)}>
        <DialogContent className="max-w-[95vw] w-full h-[95vh] flex flex-col p-6 gap-0 overflow-hidden" data-testid="dialog-copilot">
          {copilotCb && (
            <CopilotPanel
              chargeback={copilotCb}
              onClose={() => setCopilotCb(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

const EVIDENCE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.csv";

const MAX_EVIDENCE_FILES = 5;

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MB
