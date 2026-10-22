import { PageTitle } from "@/components/ui/page-header";
import { useState,useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import {useCrmQuery as useQuery,useCrmActorIdentity} from "@/hooks/use-crm-query";
import {CrmDataState} from "@/components/crm/CrmPresentation";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  FileText,
  DollarSign,
  TrendingDown,
  TrendingUp,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Shield,
  Zap,
  Target,
  Clock,
  Star,
  Send,
  Calendar,
  XCircle,
  Link2,
  Copy,
  Eye,
  Mail,
  ChevronDown,
  ClipboardList,
  UserCheck,
  ArrowRightCircle,
  Bot,
  Pencil,
} from "lucide-react";
import type { Deal, Contact } from "@shared/schema";
import { formatTimeAgo } from "@/lib/utils";

// ─── Statement Review Types ────────────────────────────────────────────────────
interface StatementReviewRecord {
  id: number;
  documentId: number | null;
  contactId: number | null;
  dealId: number | null;
  status: string;
  analystId: string | null;
  analystName: string | null;
  aiSummary: any;
  analystNotes: string | null;
  savingsEstimateOverride: string | null;
  followUpDraft: string | null;
  followUpSentAt: string | null;
  reviewedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  // enriched
  contactName?: string;
  companyName?: string;
  documentName?: string;
}

// ─── Status pipeline display ──────────────────────────────────────────────────
const REVIEW_STATUS_STEPS = [
  { key: "received",       label: "Received",       icon: FileText },
  { key: "in_review",      label: "In Review",      icon: Eye },
  { key: "ai_analyzed",   label: "AI Analyzed",    icon: Bot },
  { key: "reviewed",       label: "Reviewed",       icon: CheckCircle2 },
  { key: "complete",       label: "Complete",       icon: Star },
];

const STATUS_INDEX: Record<string, number> = Object.fromEntries(
  REVIEW_STATUS_STEPS.map((s, i) => [s.key, i])
);

function ReviewStatusPipeline({ status }: { status: string }) {
  const current = STATUS_INDEX[status] ?? 0;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {REVIEW_STATUS_STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const Icon = step.icon;
        return (
          <div key={step.key} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full transition-colors ${
                done
                  ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                  : active
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 ring-1 ring-blue-300"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Icon className="w-2.5 h-2.5" />
              {step.label}
            </div>
            {i < REVIEW_STATUS_STEPS.length - 1 && (
              <ArrowRightCircle className="w-3 h-3 text-muted-foreground/40 shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Statement Operations Panel ────────────────────────────────────────────────
function StatementOperationsPanel() {
  const { toast } = useToast();
  const [selectedReview, setSelectedReview] = useState<StatementReviewRecord | null>(null);
  const [analystNotes, setAnalystNotes] = useState("");
  const [savingsOverride, setSavingsOverride] = useState("");
  const [followUpDraft, setFollowUpDraft] = useState("");

  const actorIdentity=useCrmActorIdentity();
  useEffect(()=>{setSelectedReview(null);setAnalystNotes("");setSavingsOverride("");setFollowUpDraft("");},[actorIdentity]);
  const { data: reviews = [], isLoading,isError,error, refetch } = useQuery<StatementReviewRecord[]>({
    queryKey: ["/api/statement-reviews"],
    queryFn:async({signal})=>{
      const response=await fetch("/api/statement-reviews",{credentials:"include",signal});
      if(!response.ok)throw new Error(`${response.status}: Statement reviews unavailable`);
      const rows=await response.json();
      if(!Array.isArray(rows)||rows.some(row=>!Number.isInteger(row?.id)||!Number.isInteger(row?.version)))
        throw new Error("Statement review identity/version shape unavailable");
      return rows;
    },
    refetchInterval: 60000,
  });
  const selectionCurrent=!isLoading&&!isError&&!!selectedReview&&
    reviews.some(row=>row.id===selectedReview.id&&row.version===selectedReview.version);

  const updateMutation = useMutation({
    mutationFn: async (updates: Record<string, any>) => {
      if (!selectedReview||!selectionCurrent) throw new Error("Current matching review/version read required");
      const res = await apiRequest("PATCH", `/api/statement-reviews/${selectedReview.id}`, {
        ...updates,
        version: selectedReview.version,
      });
      return res.json();
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["/api/statement-reviews"] });
      setSelectedReview(updated);
      toast({ title: "Review updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const generateDraftMutation = useMutation({
    mutationFn: async () => {
      if (!selectedReview||!selectionCurrent) throw new Error("Current matching review/version read required");
      const res = await apiRequest("POST", `/api/statement-reviews/${selectedReview.id}/follow-up-draft`);
      return res.json();
    },
    onSuccess: (data: { draft: string; review: StatementReviewRecord }) => {
      setFollowUpDraft(data.draft);
      setSelectedReview(data.review);
      queryClient.invalidateQueries({ queryKey: ["/api/statement-reviews"] });
      toast({ title: "Follow-up draft generated" });
    },
    onError: (err: Error) => {
      toast({ title: "Draft generation failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSelectReview = (r: StatementReviewRecord) => {
    setSelectedReview(r);
    setAnalystNotes(r.analystNotes || "");
    setSavingsOverride(r.savingsEstimateOverride || "");
    setFollowUpDraft(r.followUpDraft || "");
  };

  const handleAdvanceStatus = (newStatus: string) => {
    updateMutation.mutate({ status: newStatus });
  };

  const handleSaveNotes = () => {
    updateMutation.mutate({
      analystNotes,
      savingsEstimateOverride: savingsOverride || undefined,
    });
  };

  const nextStatus = (current: string): string | null => {
    const idx = STATUS_INDEX[current];
    if (idx === undefined) return null;
    return REVIEW_STATUS_STEPS[idx + 1]?.key ?? null;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-teal-500" />
            Statement Review Operations
          </h2>
          <p className="text-sm text-muted-foreground">
            Track analyst workflow from statement receipt through merchant follow-up
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <ArrowRightCircle className="w-4 h-4 mr-1" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: review list */}
        <Card data-testid="card-statement-reviews-list">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Reviews ({reviews.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isError ? <CrmDataState state={/^403:/.test(error?.message||"")?"denied":"unavailable"} message="Statement reviews unavailable; this is not a no-reviews result." onRetry={()=>void refetch()}/>
            : isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            ) : reviews.length === 0 ? (
              <p className="text-xs text-muted-foreground p-4">
                No statement reviews yet. Reviews are created automatically when a Processing Statement is uploaded.
              </p>
            ) : (
              <div className="divide-y max-h-96 overflow-y-auto">
                {reviews.map((r) => (
                  <button
                    key={r.id}
                    className={`w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors text-sm ${selectedReview?.id === r.id ? "bg-muted" : ""}`}
                    onClick={() => handleSelectReview(r)}
                    data-testid={`review-row-${r.id}`}
                  >
                    <div className="font-medium text-xs truncate">{r.contactName || r.documentName || `Review #${r.id}`}</div>
                    {r.companyName && <div className="text-[10px] text-muted-foreground truncate">{r.companyName}</div>}
                    <div className="flex items-center gap-1.5 mt-1">
                      <Badge
                        className={`text-[9px] px-1 h-4 ${
                          r.status === "complete" ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300" :
                          r.status === "received" ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" :
                          r.status === "follow_up_sent" ? "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300" :
                          "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
                        }`}
                      >
                        {r.status.replace(/_/g, " ")}
                      </Badge>
                      {r.analystName && (
                        <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                          <UserCheck className="w-2.5 h-2.5" />
                          {r.analystName}
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] text-muted-foreground mt-0.5">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right: review detail */}
        <div className="lg:col-span-2">
          {selectedReview&&!selectionCurrent ? <CrmDataState state="unavailable" message="Selected review has no current matching authorized version. Reselect after retry; prior fields are not an editable placeholder." onRetry={()=>void refetch()}/>
          : !selectedReview ? (
            <Card>
              <CardContent className="flex items-center justify-center py-16 text-muted-foreground">
                <div className="text-center">
                  <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Select a review to see details</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {/* Status pipeline */}
              <Card data-testid="card-review-pipeline">
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="font-semibold text-sm">{selectedReview.contactName || `Review #${selectedReview.id}`}</p>
                      {selectedReview.companyName && (
                        <p className="text-xs text-muted-foreground">{selectedReview.companyName}</p>
                      )}
                      {selectedReview.documentName && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <FileText className="w-3 h-3" />
                          {selectedReview.documentName}
                        </p>
                      )}
                    </div>
                    {selectedReview.analystName && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <UserCheck className="w-3 h-3 text-blue-500" />
                        {selectedReview.analystName}
                      </span>
                    )}
                  </div>
                  <ReviewStatusPipeline status={selectedReview.status} />

                  {nextStatus(selectedReview.status) && (
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-7"
                        onClick={() => handleAdvanceStatus(nextStatus(selectedReview.status)!)}
                        disabled={updateMutation.isPending}
                        data-testid="button-advance-status"
                      >
                        {updateMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <ArrowRightCircle className="w-3 h-3 mr-1" />}
                        Advance to {nextStatus(selectedReview.status)!.replace(/_/g, " ")}
                      </Button>
                      <Select
                        value={selectedReview.status}
                        onValueChange={(v) => handleAdvanceStatus(v)}
                      >
                        <SelectTrigger className="h-7 text-xs w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REVIEW_STATUS_STEPS.filter((s) => s.key !== "follow_up_sent").map((s) => (
                            <SelectItem key={s.key} value={s.key}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* AI Summary */}
              {selectedReview.aiSummary && (
                <Card data-testid="card-ai-summary">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Bot className="w-4 h-4 text-blue-500" />
                      AI Analysis Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {Object.entries(selectedReview.aiSummary as Record<string, any>)
                        .filter(([k]) => !["raw", "fullText"].includes(k))
                        .slice(0, 9)
                        .map(([k, v]) => (
                          <div key={k} className="space-y-0.5">
                            <p className="text-[10px] text-muted-foreground uppercase font-medium">
                              {k.replace(/([A-Z])/g, " $1").trim()}
                            </p>
                            <p className="text-sm font-semibold">{String(v)}</p>
                          </div>
                        ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Analyst notes + savings override */}
              <Card data-testid="card-analyst-notes">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Pencil className="w-4 h-4" />
                    Analyst Notes & Savings Override
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Analyst Notes</Label>
                    <Textarea
                      value={analystNotes}
                      onChange={(e) => setAnalystNotes(e.target.value)}
                      rows={3}
                      placeholder="Add review notes, observations, or key findings…"
                      className="text-sm resize-none"
                      data-testid="textarea-analyst-notes"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Savings Estimate Override</Label>
                    <Input
                      value={savingsOverride}
                      onChange={(e) => setSavingsOverride(e.target.value)}
                      inputMode="decimal"
                      placeholder="Annual savings amount, e.g. 4200.00"
                      className="text-sm h-8"
                      data-testid="input-savings-override"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Numeric annual savings only. The analyzed statement is retained as evidence.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSaveNotes}
                    disabled={updateMutation.isPending}
                    className="h-7 text-xs"
                    data-testid="button-save-analyst-notes"
                  >
                    {updateMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                    Save Notes
                  </Button>
                </CardContent>
              </Card>

              {/* Follow-up draft */}
              <Card data-testid="card-follow-up-draft">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Send className="w-4 h-4 text-teal-500" />
                    Merchant Follow-Up Draft
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => generateDraftMutation.mutate()}
                    disabled={generateDraftMutation.isPending}
                    className="h-7 text-xs gap-1.5"
                    data-testid="button-generate-follow-up"
                  >
                    {generateDraftMutation.isPending ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Sparkles className="w-3 h-3 text-blue-500" />
                    )}
                    Generate Follow-Up Draft
                  </Button>

                  {followUpDraft && (
                    <>
                      <Textarea
                        value={followUpDraft}
                        onChange={(e) => setFollowUpDraft(e.target.value)}
                        rows={8}
                        className="text-sm resize-none font-mono text-xs"
                        data-testid="textarea-follow-up-draft"
                      />
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(followUpDraft);
                              toast({ title: "Copied to clipboard" });
                            } catch {
                              toast({ title: "Copy failed", description: "Use Ctrl+A, Ctrl+C to copy manually", variant: "destructive" });
                            }
                          }}
                          data-testid="button-copy-follow-up"
                        >
                          <Copy className="w-3 h-3 mr-1" />
                          Copy to Clipboard
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => {
                            updateMutation.mutate({ followUpDraft });
                          }}
                          disabled={updateMutation.isPending}
                          data-testid="button-save-follow-up-draft"
                        >
                          <Mail className="w-3 h-3 mr-1" />
                          Save Draft
                        </Button>
                      </div>
                      <p className="text-[10px] text-muted-foreground">Draft only — this workflow does not send merchant communications.</p>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface PlanData {
  name: string;
  shortName: string;
  headline: string;
  effectiveRate: string;
  monthlyFees: number;
  monthlySavings: number;
  annualSavings: number;
  savingsPercent: number;
  howItWorks: string;
  pros: string[];
  cons: string[];
  bestFor: string;
  libertyMarginBps: number;
  libertyMonthlyRevenue: number;
}

interface Proposal {
  merchantName: string;
  generatedAt: string;
  dealId: number;
  currentState: {
    monthlyVolume: number;
    effectiveRate: string;
    monthlyFees: number;
    annualFees: number;
    avgTicket: number;
    topIssues: string[];
  };
  plans: PlanData[];
  recommendedPlan: string;
  recommendedReason: string;
  urgencyCtas: string[];
  complianceDisclaimer: string;
  verticalInsights?: {
    industryAvgRate: string;
    industryAvgTicket: string;
    verticalBenchmark: string;
    opportunityScore: number;
  };
  feeBreakdown: {
    currentInterchange: string;
    currentMarkup: string;
    currentMonthlyFees: string;
    currentPciFees: string;
    hiddenFees: string[];
  };
}

function formatCurrency(val: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(val);
}

function formatCurrencyExact(val: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(val);
}

const planIcons: Record<string, typeof DollarSign> = {
  cashDiscount: Zap,
  interchangePlus: Target,
  tieredReduction: TrendingDown,
};

const planColors: Record<string, string> = {
  cashDiscount: "text-emerald-600 dark:text-emerald-400",
  interchangePlus: "text-blue-600 dark:text-blue-400",
  tieredReduction: "text-amber-600 dark:text-amber-400",
};

export default function StatementReview() {
  const { toast } = useToast();
  const [selectedDealId, setSelectedDealId] = useState<string>("");
  const [manualVolume, setManualVolume] = useState("");
  const [manualRate, setManualRate] = useState("");
  const [manualTicket, setManualTicket] = useState("");
  const [manualVertical, setManualVertical] = useState("");
  const [activeProposal, setActiveProposal] = useState<Proposal | null>(null);

  const { data: dealsRes, isLoading: dealsLoading } = useQuery<{ data: Deal[]; total: number }>({
    queryKey: ["/api/deals"],
  });
  const deals = dealsRes?.data ?? [];

  const { data: contactsRes } = useQuery<{ data: Contact[]; total: number }>({
    queryKey: ["/api/contacts"],
  });
  const contacts = contactsRes?.data ?? [];

  const dealsWithStatements = deals.filter(
    (d) => d.statementReceived || d.stage === "Statement Received" || d.effectiveRate
  );

  const sendProposalMutation = useMutation({
    mutationFn: async (dealId: number) => {
      const res = await apiRequest("POST", `/api/deals/${dealId}/send-proposal`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Proposal Sent", description: "Proposal emailed to the merchant" });
    },
    onError: (err: Error) => {
      toast({ title: "Send Failed", description: err.message, variant: "destructive" });
    },
  });

  const shareLinkMutation = useMutation({
    mutationFn: async (dealId: number) => {
      const res = await apiRequest("POST", `/api/deals/${dealId}/generate-share-link`);
      return res.json();
    },
    onSuccess: async (data: { shareUrl: string }) => {
      try {
        await navigator.clipboard.writeText(data.shareUrl);
        toast({ title: "Share link copied!", description: "Send it to the merchant or paste it anywhere." });
      } catch {
        toast({ title: "Share link generated", description: data.shareUrl });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Failed to generate link", description: err.message, variant: "destructive" });
    },
  });

  const emailShareLinkMutation = useMutation({
    mutationFn: async (dealId: number) => {
      const res = await apiRequest("POST", `/api/deals/${dealId}/email-share-link`);
      return res.json();
    },
    onSuccess: (data: { email: string }) => {
      toast({ title: "Email sent!", description: `Savings results link sent to ${data.email}.` });
    },
    onError: (err: Error) => {
      toast({ title: "Email failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSendProposal = (dealId: number) => {
    sendProposalMutation.mutate(dealId);
  };

  const generateMutation = useMutation({
    mutationFn: async (params: { dealId: number; statementData?: any }) => {
      const res = await apiRequest("POST", "/api/ai/generate-proposal", params);
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.error) {
        toast({ title: data.errorType === "credential" ? "AI Credentials Issue" : data.errorType === "quota" ? "AI Quota Exceeded" : "AI Unavailable", description: data.message || "Proposal generation is temporarily unavailable.", variant: "destructive" });
        return;
      }
      setActiveProposal(data);
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Proposal Generated", description: `Savings proposal ready for ${data.merchantName}` });
    },
    onError: (err: Error) => {
      toast({ title: "Generation Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleGenerate = () => {
    if (!selectedDealId) {
      toast({ title: "Select a Deal", description: "Please select a deal to generate a proposal for", variant: "destructive" });
      return;
    }
    generateMutation.mutate({
      dealId: Number(selectedDealId),
      statementData: (manualVolume || manualVertical) ? {
        monthlyVolume: manualVolume || undefined,
        effectiveRate: manualRate || undefined,
        avgTicket: manualTicket || undefined,
        vertical: manualVertical || undefined,
      } : undefined,
    });
  };

  const handleViewExisting = (deal: Deal) => {
    if (deal.savingsProposal) {
      setActiveProposal(deal.savingsProposal as any);
    } else {
      setSelectedDealId(String(deal.id));
      toast({ title: "No Proposal Yet", description: "Generate a new savings proposal for this deal" });
    }
  };

  const getContactName = (contactId: number | null) => {
    if (!contactId) return "Unknown";
    const c = contacts.find((ct) => ct.id === contactId);
    return c ? `${c.firstName} ${c.lastName}`.trim() || c.companyName || "Unknown" : "Unknown";
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" data-testid="page-statement-review">
      <div className="flex flex-col gap-2">
        <PageTitle className="text-2xl font-bold" data-testid="text-statement-review-title">
          Statement Review & Savings Proposals
        </PageTitle>
        <p className="text-muted-foreground">
          Analyze merchant statements and generate competitive pricing proposals with real savings breakdowns.
        </p>
      </div>

      {/* Statement Operations section */}
      <StatementOperationsPanel />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card data-testid="card-generate-proposal">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Generate Proposal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Select Deal</Label>
              <Select value={selectedDealId} onValueChange={setSelectedDealId}>
                <SelectTrigger data-testid="select-deal">
                  <SelectValue placeholder="Choose a deal..." />
                </SelectTrigger>
                <SelectContent>
                  {deals.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)} data-testid={`select-deal-${d.id}`}>
                      {getContactName(d.contactId)} - {d.stage}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Merchant Vertical</Label>
              <Select value={manualVertical} onValueChange={(v) => setManualVertical(v === "_none" ? "" : v)}>
                <SelectTrigger data-testid="select-proposal-vertical">
                  <SelectValue placeholder="Select vertical (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">No vertical</SelectItem>
                  {["Restaurant", "Retail", "Healthcare", "Dental", "Med Spa", "Auto Repair", "Salon/Beauty", "Gym/Fitness", "Hotel/Lodging", "Landscaping", "Construction", "Legal"].map(v => (
                    <SelectItem key={v} value={v} data-testid={`option-proposal-vertical-${v.toLowerCase().replace(/\W+/g, "-")}`}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Monthly Volume ($)</Label>
              <Input
                placeholder="e.g. 50000"
                value={manualVolume}
                onChange={(e) => setManualVolume(e.target.value)}
                data-testid="input-proposal-volume"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Effective Rate (%)</Label>
                <Input
                  placeholder="e.g. 3.2"
                  value={manualRate}
                  onChange={(e) => setManualRate(e.target.value)}
                  data-testid="input-proposal-rate"
                />
              </div>
              <div className="space-y-2">
                <Label>Avg Ticket ($)</Label>
                <Input
                  placeholder="e.g. 45"
                  value={manualTicket}
                  onChange={(e) => setManualTicket(e.target.value)}
                  data-testid="input-proposal-ticket"
                />
              </div>
            </div>

            <Button
              className="w-full gap-2"
              onClick={handleGenerate}
              disabled={generateMutation.isPending || !selectedDealId}
              data-testid="button-generate-proposal"
            >
              {generateMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating Proposal...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate Savings Proposal
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <Card data-testid="card-recent-reviews">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Deals with Statements
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dealsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : dealsWithStatements.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No deals with statement data yet.</p>
              ) : (
                <div className="space-y-2">
                  {dealsWithStatements.slice(0, 10).map((deal) => (
                    <div
                      key={deal.id}
                      className="flex items-center justify-between gap-3 p-3 rounded-md border"
                      data-testid={`deal-row-${deal.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">
                          {getContactName(deal.contactId)}
                        </div>
                        <div className="text-xs text-muted-foreground flex flex-wrap gap-2">
                          <span>{deal.stage}</span>
                          {deal.effectiveRate && <span>Rate: {deal.effectiveRate}</span>}
                          {deal.totalVolume && <span>Vol: {deal.totalVolume}</span>}
                          {deal.shareToken && (deal.shareViewCount ?? 0) > 0 && (
                            <span
                              className="flex items-center gap-1 text-blue-600 dark:text-blue-400 font-medium"
                              data-testid={`text-view-count-${deal.id}`}
                              title={`Last viewed: ${formatTimeAgo(deal.shareLastViewedAt)}`}
                            >
                              <Eye className="w-3 h-3" />
                              Viewed {deal.shareViewCount} {deal.shareViewCount === 1 ? "time" : "times"}
                              {deal.shareLastViewedAt ? `, last seen ${formatTimeAgo(deal.shareLastViewedAt)}` : ""}
                            </span>
                          )}
                          {deal.shareToken && (deal.shareViewCount ?? 0) === 0 && (
                            <span className="flex items-center gap-1 text-muted-foreground" data-testid={`text-view-count-zero-${deal.id}`}>
                              <Eye className="w-3 h-3" />
                              Not yet viewed
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {deal.savingsProposal ? (
                          <Badge
                            variant="secondary"
                            className={`text-xs ${deal.proposalStatus === "resent" ? "bg-orange-100 text-orange-700 border-orange-300" : ""}`}
                          >
                            <CheckCircle2 className="w-3 h-3 mr-1" />
                            {deal.proposalStatus === "resent" ? "Re-sent (Not Opened)" :
                             deal.proposalStatus === "sent" ? "Sent (Not Opened)" :
                             deal.proposalStatus === "viewed" ? "Opened" :
                             deal.proposalStatus === "accepted" ? "Accepted" :
                             "Proposal Ready"}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">
                            Needs Review
                          </Badge>
                        )}
                        {/* AI unavailable at generation time — proposal used the static template */}
                        {!!deal.savingsProposal && (deal.savingsProposal as Record<string, unknown>)._generationSource === "template" && (
                          <Badge variant="outline" className="text-xs border-amber-400 text-amber-600 dark:text-amber-400">
                            ⚠ Template Fallback
                          </Badge>
                        )}
                        {!!deal.savingsProposal && deal.proposalStatus !== "sent" && deal.proposalStatus !== "resent" && (
                          <Button
                            size="sm"
                            variant="default"
                            onClick={() => handleSendProposal(deal.id)}
                            disabled={sendProposalMutation.isPending}
                            data-testid={`button-send-deal-${deal.id}`}
                          >
                            {sendProposalMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                            Send
                          </Button>
                        )}
                        {!!deal.savingsProposal && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  (shareLinkMutation.isPending && shareLinkMutation.variables === deal.id) ||
                                  (emailShareLinkMutation.isPending && emailShareLinkMutation.variables === deal.id)
                                }
                                data-testid={`button-share-deal-${deal.id}`}
                              >
                                {(shareLinkMutation.isPending && shareLinkMutation.variables === deal.id) ||
                                (emailShareLinkMutation.isPending && emailShareLinkMutation.variables === deal.id) ? (
                                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                ) : (
                                  <Link2 className="w-3 h-3 mr-1" />
                                )}
                                Share
                                <ChevronDown className="w-3 h-3 ml-1" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => shareLinkMutation.mutate(deal.id)}
                                data-testid={`menu-copy-link-${deal.id}`}
                              >
                                <Copy className="w-3 h-3 mr-2" />
                                Copy Link
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => emailShareLinkMutation.mutate(deal.id)}
                                data-testid={`menu-email-merchant-${deal.id}`}
                              >
                                <Mail className="w-3 h-3 mr-2" />
                                Email to Merchant
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        <Button
                          size="sm"
                          variant={deal.savingsProposal ? "outline" : "default"}
                          onClick={() => handleViewExisting(deal)}
                          data-testid={`button-view-deal-${deal.id}`}
                        >
                          {deal.savingsProposal ? "View" : "Generate"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {activeProposal && (
        <ProposalReport
          proposal={activeProposal}
          dealId={selectedDealId ? Number(selectedDealId) : activeProposal.dealId}
          onProposalUpdated={(updated) => setActiveProposal(updated)}
        />
      )}
    </div>
  );
}

function ProposalReport({ proposal, dealId, onProposalUpdated }: { proposal: Proposal; dealId?: number; onProposalUpdated?: (p: Proposal) => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editPlans, setEditPlans] = useState<PlanData[]>(proposal.plans);
  const [editRecommendedReason, setEditRecommendedReason] = useState(proposal.recommendedReason || "");

  const { currentState, plans, feeBreakdown, urgencyCtas, complianceDisclaimer } = proposal;
  const recommended = plans.find((p) => p.shortName === proposal.recommendedPlan) || plans[0];

  const editMutation = useMutation({
    mutationFn: async (data: { plans: PlanData[]; recommendedReason: string }) => {
      const res = await apiRequest("PUT", `/api/deals/${dealId}/edit-proposal`, data);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      if (data.proposal && onProposalUpdated) {
        onProposalUpdated(data.proposal);
      }
      setEditing(false);
      toast({ title: "Proposal Updated", description: "Changes saved. You can now send the proposal." });
    },
    onError: (err: Error) => {
      toast({ title: "Save Failed", description: err.message, variant: "destructive" });
    },
  });

  const syncToGhlMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/deals/${dealId}/sync-analysis-to-ghl`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Synced to GHL", description: "Analysis data and custom fields updated in GoHighLevel." });
    },
    onError: (err: Error) => {
      toast({ title: "Sync Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleEditPlanField = (planIndex: number, field: string, value: string | number) => {
    const updated = editPlans.map((plan, i) => {
      if (i !== planIndex) return plan;
      return { ...plan, [field]: value };
    });
    setEditPlans(updated);
  };

  const handleSaveEdits = () => {
    editMutation.mutate({ plans: editPlans, recommendedReason: editRecommendedReason });
  };

  return (
    <div className="space-y-6" data-testid="proposal-report">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold" data-testid="text-proposal-merchant">
            Savings Proposal: {proposal.merchantName}
          </h2>
          <p className="text-sm text-muted-foreground">
            Generated {new Date(proposal.generatedAt).toLocaleDateString()} at {new Date(proposal.generatedAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="gap-1">
            <Star className="w-3 h-3" />
            Recommended: {recommended?.name}
          </Badge>
          {dealId && !editing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditPlans([...proposal.plans]);
                setEditRecommendedReason(proposal.recommendedReason || "");
                setEditing(true);
              }}
              data-testid="button-edit-proposal"
            >
              Edit Before Sending
            </Button>
          )}
          {dealId && !editing && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => syncToGhlMutation.mutate()}
              disabled={syncToGhlMutation.isPending}
              data-testid="button-sync-ghl"
            >
              {syncToGhlMutation.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <TrendingUp className="w-3 h-3 text-blue-500" />
              )}
              Sync to GHL
            </Button>
          )}
          {editing && (
            <>
              <Button
                size="sm"
                variant="default"
                onClick={handleSaveEdits}
                disabled={editMutation.isPending}
                data-testid="button-save-proposal-edits"
              >
                {editMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                Save Changes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} data-testid="button-cancel-edit">
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {proposal.verticalInsights && (
        <Card data-testid="card-vertical-insights" className="border-blue-100 bg-blue-50/30 dark:bg-blue-950/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-blue-500" />
              Vertical Insights & Benchmarking
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase font-semibold">Vertical Benchmark</p>
                <p className="text-sm font-medium">{proposal.verticalInsights.verticalBenchmark}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase font-semibold">Industry Avg Rate</p>
                <p className="text-sm font-medium">{proposal.verticalInsights.industryAvgRate}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase font-semibold">Industry Avg Ticket</p>
                <p className="text-sm font-medium">{proposal.verticalInsights.industryAvgTicket}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground uppercase font-semibold">Opportunity Score</p>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-blue-600 dark:text-blue-400">
                    {proposal.verticalInsights.opportunityScore}/100
                  </p>
                  <div className="h-1.5 w-16 bg-blue-100 dark:bg-blue-900 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-blue-500" 
                      style={{ width: `${proposal.verticalInsights.opportunityScore}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {editing && (
        <Card className="border-amber-200 bg-amber-50/50 dark:bg-amber-950/20" data-testid="card-edit-mode">
          <CardContent className="p-4">
            <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Editing mode — modify plan details below, then save before sending to the merchant.
            </p>
            <div className="mt-3 space-y-3">
              <div>
                <Label className="text-xs">Recommendation Reason</Label>
                <Input
                  value={editRecommendedReason}
                  onChange={(e) => setEditRecommendedReason(e.target.value)}
                  data-testid="input-edit-recommendation-reason"
                />
              </div>
              {editPlans.map((plan, idx) => (
                <div key={plan.shortName} className="border rounded-md p-3 space-y-2 bg-background">
                  <div className="font-medium text-sm">{plan.name}</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Effective Rate</Label>
                      <Input
                        value={plan.effectiveRate}
                        onChange={(e) => handleEditPlanField(idx, "effectiveRate", e.target.value)}
                        data-testid={`input-edit-rate-${plan.shortName}`}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Monthly Savings ($)</Label>
                      <Input
                        type="number"
                        value={plan.monthlySavings}
                        onChange={(e) => handleEditPlanField(idx, "monthlySavings", Number(e.target.value))}
                        data-testid={`input-edit-monthly-savings-${plan.shortName}`}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Annual Savings ($)</Label>
                      <Input
                        type="number"
                        value={plan.annualSavings}
                        onChange={(e) => handleEditPlanField(idx, "annualSavings", Number(e.target.value))}
                        data-testid={`input-edit-annual-savings-${plan.shortName}`}
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Headline</Label>
                    <Input
                      value={plan.headline}
                      onChange={(e) => handleEditPlanField(idx, "headline", e.target.value)}
                      data-testid={`input-edit-headline-${plan.shortName}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-current-state">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Current Processing Costs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <div className="text-xs text-muted-foreground">Monthly Volume</div>
              <div className="text-lg font-bold" data-testid="text-current-volume">
                {formatCurrency(currentState.monthlyVolume)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Effective Rate</div>
              <div className="text-lg font-bold text-destructive" data-testid="text-current-rate">
                {currentState.effectiveRate}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Monthly Fees</div>
              <div className="text-lg font-bold text-destructive" data-testid="text-current-monthly">
                {formatCurrencyExact(currentState.monthlyFees)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Annual Fees</div>
              <div className="text-lg font-bold text-destructive" data-testid="text-current-annual">
                {formatCurrency(currentState.annualFees)}
              </div>
            </div>
          </div>

          {currentState.topIssues && currentState.topIssues.length > 0 && (
            <div className="border-t pt-3">
              <div className="text-sm font-medium mb-2">Fee Problems Identified</div>
              <ul className="space-y-1">
                {currentState.topIssues.map((issue, i) => (
                  <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    {issue}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feeBreakdown && feeBreakdown.hiddenFees && feeBreakdown.hiddenFees.length > 0 && (
            <div className="border-t pt-3 mt-3">
              <div className="text-sm font-medium mb-2">Hidden Fees You're Paying</div>
              <div className="flex flex-wrap gap-2">
                {feeBreakdown.hiddenFees.map((fee, i) => (
                  <Badge key={i} variant="outline" className="text-destructive border-destructive/30">
                    {fee}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plans.map((plan) => {
          const isRecommended = plan.shortName === proposal.recommendedPlan;
          const PlanIcon = planIcons[plan.shortName] || DollarSign;
          const colorClass = planColors[plan.shortName] || "text-foreground";

          return (
            <Card
              key={plan.shortName}
              className={isRecommended ? "ring-2 ring-primary" : ""}
              data-testid={`card-plan-${plan.shortName}`}
            >
              <CardHeader className="pb-3">
                {isRecommended && (
                  <Badge className="w-fit mb-2 gap-1">
                    <Star className="w-3 h-3" />
                    Recommended
                  </Badge>
                )}
                <CardTitle className="text-base flex items-center gap-2">
                  <PlanIcon className={`w-4 h-4 ${colorClass}`} />
                  {plan.name}
                </CardTitle>
                <p className="text-sm text-muted-foreground italic">
                  "{plan.headline}"
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center p-4 rounded-md bg-muted/50">
                  <div className="text-xs text-muted-foreground mb-1">Your New Rate</div>
                  <div className={`text-3xl font-bold ${colorClass}`} data-testid={`text-rate-${plan.shortName}`}>
                    {plan.effectiveRate}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="text-center p-2 rounded-md border">
                    <div className="text-xs text-muted-foreground">Monthly Savings</div>
                    <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400" data-testid={`text-monthly-savings-${plan.shortName}`}>
                      {formatCurrency(plan.monthlySavings)}
                    </div>
                  </div>
                  <div className="text-center p-2 rounded-md border">
                    <div className="text-xs text-muted-foreground">Annual Savings</div>
                    <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400" data-testid={`text-annual-savings-${plan.shortName}`}>
                      {formatCurrency(plan.annualSavings)}
                    </div>
                  </div>
                </div>

                <div className="text-center">
                  <Badge variant="secondary" className="text-sm gap-1">
                    <TrendingDown className="w-3 h-3" />
                    {plan.savingsPercent}% Lower Fees
                  </Badge>
                </div>

                <div className="text-sm text-muted-foreground">
                  {plan.howItWorks}
                </div>

                {plan.pros && plan.pros.length > 0 && (
                  <div>
                    <div className="text-xs font-medium mb-1.5">Advantages</div>
                    <ul className="space-y-1">
                      {plan.pros.map((pro, i) => (
                        <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                          <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0 mt-0.5" />
                          {pro}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.cons && plan.cons.length > 0 && (
                  <div>
                    <div className="text-xs font-medium mb-1.5">Considerations</div>
                    <ul className="space-y-1">
                      {plan.cons.map((con, i) => (
                        <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                          <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
                          {con}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="border-t pt-3">
                  <div className="text-xs text-muted-foreground">Best For</div>
                  <div className="text-sm font-medium">{plan.bestFor}</div>
                </div>

                <Button
                  className="w-full gap-2"
                  variant={isRecommended ? "default" : "outline"}
                  data-testid={`button-select-plan-${plan.shortName}`}
                >
                  <Send className="w-4 h-4" />
                  {isRecommended ? "Send This Proposal" : "Select This Plan"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {proposal.recommendedReason && (
        <Card data-testid="card-recommendation">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-md bg-primary/10">
                <Target className="w-5 h-5 text-primary" />
              </div>
              <div>
                <div className="font-medium mb-1">Why We Recommend {recommended?.name}</div>
                <p className="text-sm text-muted-foreground">{proposal.recommendedReason}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {urgencyCtas && urgencyCtas.length > 0 && (
        <Card data-testid="card-ctas">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Close This Deal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {urgencyCtas.map((cta, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-3 rounded-md border"
                data-testid={`cta-${i}`}
              >
                <ArrowRight className="w-4 h-4 text-primary shrink-0" />
                <span className="text-sm font-medium">{cta}</span>
              </div>
            ))}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button className="gap-2" data-testid="button-send-proposal">
                <Send className="w-4 h-4" />
                Send Proposal to Merchant
              </Button>
              <Button variant="outline" className="gap-2" data-testid="button-book-call">
                <Calendar className="w-4 h-4" />
                Book Follow-Up Call
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-start gap-2 p-3 rounded-md bg-muted/30 border" data-testid="compliance-disclaimer">
        <Shield className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground">
          {complianceDisclaimer || "Eligibility, underwriting, card brand rules, and applicable laws apply. Savings estimates based on statement data provided. Actual results may vary."}
        </p>
      </div>

      <Card data-testid="card-liberty-margin">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Liberty Bancard Revenue (Internal)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {plans.map((plan) => (
              <div key={plan.shortName} className="p-3 rounded-md border text-center">
                <div className="text-xs text-muted-foreground mb-1">{plan.name}</div>
                <div className="text-lg font-bold">{formatCurrencyExact(plan.libertyMonthlyRevenue)}/mo</div>
                <div className="text-xs text-muted-foreground">{plan.libertyMarginBps} bps margin</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
