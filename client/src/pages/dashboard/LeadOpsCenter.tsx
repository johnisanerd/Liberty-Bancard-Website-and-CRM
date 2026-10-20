import { useState, useCallback, useRef, useEffect } from "react";
import { useCrmQuery } from "@/hooks/use-crm-query";
import { CrmAreaNav } from "@/components/crm/CrmPresentation";
import CanonicalEnrichment from "./CanonicalEnrichment";
import { prospectingAreas, prospectingAreaTabs, prospectingAreaForTab, typedTabUrl } from "@/lib/crm-destination-state";
import { useLocation, useSearch, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, parseApiRequestError } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sparkles, RefreshCw, Trash2, Search, ChevronLeft, ChevronRight,
  AlertTriangle, CheckCircle, Clock, Zap, Users, Mail, Phone,
  TrendingUp, Brain, Target, ArrowRight, Download, Activity,
  X, ShieldAlert, Cpu, RotateCcw, ListTodo, XCircle, RotateCw,
  Building2, GitBranch, BarChart3, Layers, HeartPulse, MapPin,
  ArrowRightLeft, Loader2, ExternalLink,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { SouthFloridaQualificationPanel } from "@/components/lead-ops/SouthFloridaQualificationPanel";
import { SouthFloridaProspectingPanel } from "@/components/lead-ops/SouthFloridaProspectingPanel";
import { SourceRegistryPanel } from "@/pages/dashboard/SourceRegistryPanel";
import { ProgramHealthPanel } from "@/pages/dashboard/LeadOps/ProgramHealthPanel";
import { BusinessDetailPanel } from "@/pages/dashboard/LeadOps/BusinessDetailPanel";
import { BusinessAdminContext } from "@/pages/dashboard/LeadOps/BusinessAdminContext";
import { MobileBusinessCard, type BusinessListItem } from "@/pages/dashboard/LeadOps/MobileBusinessCard";
import MasterLeadDatabase, { PipelineReviewTab } from "@/pages/dashboard/MasterLeadDatabase";
import Prospects from "@/pages/dashboard/Prospects";
import LeadImports from "@/pages/dashboard/LeadImports";
import LeadIntelligence from "@/pages/dashboard/LeadIntelligence";
import DataQuality from "@/pages/dashboard/DataQuality";

const CONTACT_RECONCILIATION_PATH = "/api/admin/contact-business-reconciliation";
const CONTACT_SUGGESTIONS_PATH = "/api/admin/contact-business-suggestions";

type ContactBusinessReconciliationProgress = {
  jobId: string | null;
  status: "idle" | "running" | "ready" | "paused" | "completed" | "error";
  serverProcessing: boolean;
  cursorContactId: number;
  scannedContacts: number;
  suggestionsRecorded: number;
  ambiguousContacts: number;
  unmatchedContacts: number;
  batchSize: number;
  startedAt: string | null;
  updatedAt: string | null;
  lastError: string | null;
};

type ContactBusinessSuggestion = {
  candidateId: string;
  contactId: number;
  businessId: number;
  confidence: number;
  source: string;
  sourceVersion: string;
  createdAt: string;
  contactCompanyName: string | null;
  contactEmail: string | null;
  projectedBusinessId: number | null;
  safetyFlags: string[];
  businessName: string | null;
  businessDomain: string | null;
  contactCandidateCount: number;
  domainBusinessCount: number;
  currentDecisionId: number | null;
  currentDecision: string | null;
  currentRevision: number;
  ambiguous: boolean;
  reviewBlocked: boolean;
  isVerified: boolean;
};

type ContactBusinessSuggestionPage = {
  candidates: ContactBusinessSuggestion[];
  nextCursor: { createdAt: string; id: string } | null;
  limit: number;
};

type ContactBusinessReviewInput = {
  decision: string;
  evidenceEventId: string;
  decisionKey: string;
};

function maskContactEmail(email: string | null): string {
  if (!email) return "Email unavailable";
  const [local, domain] = email.split("@");
  if (!domain) return "Email unavailable";
  return `${local.slice(0, 1)}***@${domain}`;
}

function ContactBusinessReconciliationPanel({ contactId }: { contactId?: number } = {}) {
  const { toast } = useToast();
  const [previewLimit, setPreviewLimit] = useState(25);
  const [showPreview, setShowPreview] = useState(false);
  const [pageCursor, setPageCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<{ createdAt: string; id: string } | null>>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [reviewInputs, setReviewInputs] = useState<Record<string, ContactBusinessReviewInput>>({});

  const progressQuery = useQuery<ContactBusinessReconciliationProgress>({
    queryKey: ["/api/admin/contact-business-reconciliation/progress"],
    queryFn: async () => (await apiRequest("GET", `${CONTACT_RECONCILIATION_PATH}/progress`)).json(),
    refetchInterval: 10_000,
    enabled: contactId === undefined,
    retry: false,
  });

  const previewQuery = useQuery({
    queryKey: ["/api/admin/contact-business-reconciliation/preview", previewLimit],
    queryFn: async () => (await apiRequest("GET", `${CONTACT_RECONCILIATION_PATH}/preview?limit=${previewLimit}`)).json() as Promise<{
      mode: string;
      sampleLimit: number;
      sampledContacts: number;
      sampleSuggestions: number;
      sampleAmbiguousContacts: number;
      sampleUnmatchedContacts: number;
      eligibleUnlinkedContacts: number | null;
      totalCountStatus: string;
      paidProviderCalls: number;
      writes: number;
      note: string;
    }>,
    enabled: showPreview,
    retry: false,
  });

  const suggestionQueryKey = [CONTACT_SUGGESTIONS_PATH, contactId ?? null, pageCursor?.createdAt ?? null, pageCursor?.id ?? null] as const;
  const suggestionsQuery = useQuery<ContactBusinessSuggestionPage>({
    queryKey: suggestionQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "50" });
      if (contactId !== undefined) params.set("contactId", String(contactId));
      if (pageCursor) {
        params.set("afterCreatedAt", pageCursor.createdAt);
        params.set("afterId", pageCursor.id);
      }
      return (await apiRequest("GET", `${CONTACT_SUGGESTIONS_PATH}?${params.toString()}`)).json();
    },
    retry: false,
  });

  const invalidateWorkflowReads = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/contact-business-reconciliation/progress"] });
    queryClient.invalidateQueries({ queryKey: [CONTACT_SUGGESTIONS_PATH] });
  };

  const runControlMutation = useMutation({
    mutationFn: async (action: "start" | "pause" | "resume") => {
      const body = action === "start" ? { batchSize: 50 } : {};
      return (await apiRequest("POST", `${CONTACT_RECONCILIATION_PATH}/${action}`, body)).json();
    },
    onSuccess: (_result, action) => {
      toast({ title: `Contact reconciliation ${action === "start" ? "batch started" : action === "pause" ? "paused" : "resumed"}` });
      invalidateWorkflowReads();
    },
    onError: (error: Error) => toast({ title: "Reconciliation control failed", description: error.message, variant: "destructive" }),
  });

  const selectedRows = (suggestionsQuery.data?.candidates ?? [])
    .filter((candidate) => selectedCandidateIds.includes(candidate.candidateId));
  const reviewReadinessIssue = selectedRows.find((candidate) => {
    const review = reviewInputs[candidate.candidateId];
    if (!review?.decision) return true;
    if (review.decision !== "verified") return false;
    const evidenceEventId = Number(review.evidenceEventId);
    const projectedToDifferentBusiness = candidate.projectedBusinessId != null
      && candidate.projectedBusinessId !== candidate.businessId;
    return candidate.ambiguous || candidate.reviewBlocked || candidate.isVerified
      || projectedToDifferentBusiness || !Number.isInteger(evidenceEventId) || evidenceEventId < 1;
  });

  const reviewBatchMutation = useMutation({
    mutationFn: async () => {
      if (selectedRows.length === 0) throw new Error("Select at least one candidate to review.");
      if (reviewReadinessIssue) {
        const candidate = reviewReadinessIssue;
        const review = reviewInputs[candidate.candidateId];
        if (!review?.decision) throw new Error(`Choose a decision for contact #${candidate.contactId}.`);
        if (review.decision === "verified" && candidate.ambiguous) throw new Error(`Contact #${candidate.contactId} is ambiguous; it cannot be verified from this candidate row.`);
        if (review.decision === "verified" && candidate.reviewBlocked) throw new Error(`Contact #${candidate.contactId} has safety flags and cannot be verified.`);
        if (review.decision === "verified" && candidate.projectedBusinessId != null && candidate.projectedBusinessId !== candidate.businessId) {
          throw new Error(`Contact #${candidate.contactId} projects to a different business; resolve the conflicting link decision first.`);
        }
        if (review.decision === "verified" && (!Number.isInteger(Number(review.evidenceEventId)) || Number(review.evidenceEventId) < 1)) {
          throw new Error(`Enter a pre-existing source evidence event ID to verify contact #${candidate.contactId}.`);
        }
      }
      const decisions = selectedRows.map((candidate) => {
        const review = reviewInputs[candidate.candidateId];
        if (!review) throw new Error(`Choose a decision for contact #${candidate.contactId}.`);
        const evidenceId = review.evidenceEventId.trim() ? Number(review.evidenceEventId) : null;
        return {
          candidateId: candidate.candidateId,
          contactId: candidate.contactId,
          businessId: candidate.businessId,
          decision: review.decision,
          decisionKey: review.decisionKey,
          evidenceSourceEventId: evidenceId,
          expectedRevision: candidate.currentRevision,
        };
      });
      return (await apiRequest("POST", `${CONTACT_SUGGESTIONS_PATH}/review-batch`, { decisions })).json() as Promise<{
        outcomes: Array<{ candidateId: string; status: string; code?: string }>;
        applied: number;
        rejected: number;
      }>;
    },
    onSuccess: (result) => {
      toast({
        title: "Batch review recorded",
        description: `${result.applied} applied · ${result.rejected} rejected. Verified links require the existing independent decision authority.`,
      });
      setSelectedCandidateIds([]);
      invalidateWorkflowReads();
    },
    onError: (error: Error) => toast({ title: "Batch review failed", description: error.message, variant: "destructive" }),
  });

  const setCandidateReview = (candidateId: string, patch: Partial<ContactBusinessReviewInput>) => {
    setReviewInputs((current) => {
      const prior = current[candidateId] ?? {
        decision: "",
        evidenceEventId: "",
        decisionKey: crypto.randomUUID(),
      };
      return {
        ...current,
        [candidateId]: {
          ...prior,
          ...patch,
          // A changed payload must use a fresh decision key. A retry without
          // edits retains the same key for server-side idempotent replay.
          decisionKey: patch.decision !== undefined || patch.evidenceEventId !== undefined
            ? crypto.randomUUID()
            : prior.decisionKey,
        },
      };
    });
  };

  const progress = progressQuery.data;
  const canStart = progress?.status === "idle" || progress?.status === "completed";
  const canResume = Boolean(progress && !progress.serverProcessing
    && ["ready", "paused", "running", "error"].includes(progress.status));
  const canPause = Boolean(progress?.serverProcessing);

  return (
    <Card data-testid="contact-business-reconciliation">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Contact ↔ Business Reconciliation
          <Badge variant="outline" className="text-[10px]">Admin review</Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          Keyset-based candidate generation and independent human review. Suggestions never set a verified link; no provider or outreach action is run here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {contactId !== undefined ? null : progressQuery.isLoading ? (
          <div className="text-xs text-muted-foreground" role="status">Loading reconciliation progress…</div>
        ) : progressQuery.isError ? (
          <div className="text-xs text-red-700" role="alert">Progress unavailable — counts are not zero: {(progressQuery.error as Error).message}</div>
        ) : progress ? (
          <div className="rounded border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={progress.status === "error" ? "destructive" : progress.status === "completed" ? "default" : "secondary"}>
                {progress.status}
              </Badge>
              <Badge variant={progress.serverProcessing ? "default" : "outline"}>
                {progress.serverProcessing ? "Server processing enabled" : "Server processing paused"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {progress.jobId ? `Run ${progress.jobId}` : "No reconciliation run recorded"}
                {progress.updatedAt ? ` · updated ${new Date(progress.updatedAt).toLocaleString()}` : ""}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
              {[
                ["Contacts scanned", progress.scannedContacts],
                ["Suggestions recorded", progress.suggestionsRecorded],
                ["Ambiguous contacts", progress.ambiguousContacts],
                ["Unmatched contacts", progress.unmatchedContacts],
                ["Cursor contact ID", progress.cursorContactId],
              ].map(([label, count]) => (
                <div key={String(label)} className="rounded bg-muted/40 px-2 py-1.5">
                  <div className="font-semibold">{count}</div>
                  <div className="text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
            {progress.lastError && <div className="text-xs text-red-700" role="alert">Last error: {progress.lastError}</div>}
            {runControlMutation.isError && (
              <div className="text-xs text-red-700" role="alert">
                Reconciliation control failed: {(runControlMutation.error as Error).message}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {canStart && (
                <Button size="sm" onClick={() => runControlMutation.mutate("start")}
                  disabled={runControlMutation.isPending || progressQuery.isError}>
                  {runControlMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                  Start new reconciliation run
                </Button>
              )}
                  {canResume && (
                <Button size="sm" onClick={() => runControlMutation.mutate("resume")}
                  disabled={runControlMutation.isPending || progressQuery.isError}>
                  {runControlMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                      Resume server processing
                </Button>
              )}
              {canPause && (
                <Button size="sm" variant="outline" onClick={() => runControlMutation.mutate("pause")}
                  disabled={runControlMutation.isPending || progressQuery.isError}>
                  Pause
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => progressQuery.refetch()} disabled={progressQuery.isFetching}>
                <RefreshCw className={`h-3 w-3 mr-1 ${progressQuery.isFetching ? "animate-spin" : ""}`} />
                Refresh progress
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Start or resume enables the durable server worker, which drains bounded keyset pages and checkpoints progress independently of this page.
              Resume is a recovery/control action, not a one-page-at-a-time workflow. Pause disables server processing.
            </p>
          </div>
        ) : null}

        {contactId === undefined && <div className="rounded border p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold">Read-only preview</h3>
            <label className="text-xs" htmlFor="contact-reconciliation-preview-limit">Sample contacts</label>
            <Input
              id="contact-reconciliation-preview-limit"
              type="number"
              min={1}
              max={100}
              className="h-8 w-20"
              value={previewLimit}
              onChange={(event) => setPreviewLimit(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
            />
            <Button size="sm" variant="outline"
              onClick={() => showPreview ? previewQuery.refetch() : setShowPreview(true)}
              disabled={previewQuery.isFetching}>
              {previewQuery.isFetching ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              Preview matches
            </Button>
          </div>
          {showPreview && previewQuery.isLoading && <p className="text-xs text-muted-foreground" role="status">Loading preview…</p>}
          {showPreview && previewQuery.isError && (
            <p className="text-xs text-red-700" role="alert">Preview unavailable — totals were not counted: {(previewQuery.error as Error).message}</p>
          )}
          {showPreview && previewQuery.data && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                {[
                  ["Sampled contacts", previewQuery.data.sampledContacts],
                  ["Candidate matches", previewQuery.data.sampleSuggestions],
                  ["Ambiguous contacts", previewQuery.data.sampleAmbiguousContacts],
                  ["No match in sample", previewQuery.data.sampleUnmatchedContacts],
                  ["Unlinked total", previewQuery.data.eligibleUnlinkedContacts ?? "Not counted"],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded bg-muted/40 px-2 py-1.5">
                    <div className="font-semibold">{value}</div>
                    <div className="text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{previewQuery.data.note} · writes: {previewQuery.data.writes} · paid calls: {previewQuery.data.paidProviderCalls}.</p>
            </>
          )}
        </div>}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold">Candidate suggestions</h3>
              <p className="text-[11px] text-muted-foreground">Contact email is masked. Candidate presence is not a verified association.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => suggestionsQuery.refetch()} disabled={suggestionsQuery.isFetching}>
              <RefreshCw className={`h-3 w-3 mr-1 ${suggestionsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh suggestions
            </Button>
          </div>
          {suggestionsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground" role="status">Loading suggestion page…</div>
          ) : suggestionsQuery.isError ? (
            <div className="text-xs text-red-700" role="alert">Suggestions unavailable — no empty-state conclusion can be made: {(suggestionsQuery.error as Error).message}</div>
          ) : suggestionsQuery.data ? (
            <>
              <div className="overflow-x-auto rounded border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">Review</TableHead>
                      <TableHead>Contact / candidate</TableHead>
                      <TableHead>Evidence / ambiguity</TableHead>
                      <TableHead>Safety</TableHead>
                      <TableHead>Current identity state</TableHead>
                      <TableHead>Independent decision</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {suggestionsQuery.data.candidates.map((candidate) => {
                      const review = reviewInputs[candidate.candidateId];
                      const selected = selectedCandidateIds.includes(candidate.candidateId);
                      const projectionConflict = candidate.projectedBusinessId != null
                        && candidate.projectedBusinessId !== candidate.businessId;
                      const canVerifyCandidate = !candidate.ambiguous && !candidate.reviewBlocked
                        && !candidate.isVerified && !projectionConflict;
                      return (
                        <TableRow key={candidate.candidateId}>
                          <TableCell>
                            <Checkbox
                              checked={selected}
                              disabled={candidate.isVerified}
                              aria-label={`Select candidate for contact ${candidate.contactId}`}
                              onCheckedChange={(checked) => setSelectedCandidateIds((current) =>
                                checked
                                  ? current.includes(candidate.candidateId) ? current : [...current, candidate.candidateId]
                                  : current.filter((id) => id !== candidate.candidateId))}
                            />
                          </TableCell>
                          <TableCell className="min-w-[220px]">
                            <a href={`/dashboard/contacts/${candidate.contactId}`} className="font-medium text-blue-700 hover:underline">
                              Contact #{candidate.contactId}
                            </a>
                            <div className="text-xs text-muted-foreground">{candidate.contactCompanyName ?? "Company name unavailable"}</div>
                            <div className="font-mono text-[11px]">{maskContactEmail(candidate.contactEmail)}</div>
                            <div className="mt-1 text-xs">Candidate: <a href={`/dashboard/lead-ops/business/${candidate.businessId}`} className="text-blue-700 hover:underline">
                              {candidate.businessName ?? `Business #${candidate.businessId}`}
                            </a></div>
                            <div className="text-[11px] text-muted-foreground">{candidate.businessDomain ?? "Domain unavailable"}</div>
                          </TableCell>
                          <TableCell className="min-w-[180px] text-xs">
                            <div>{candidate.source} · {candidate.sourceVersion}</div>
                            <div>Confidence {candidate.confidence}</div>
                            <div>Observed {candidate.createdAt ? new Date(candidate.createdAt).toLocaleString() : "time unavailable"}</div>
                            <div>{candidate.contactCandidateCount} contact candidate(s) · {candidate.domainBusinessCount} businesses on domain</div>
                            {candidate.ambiguous && <Badge variant="destructive" className="mt-1">Ambiguous — do not verify</Badge>}
                          </TableCell>
                          <TableCell className="min-w-[150px]">
                            {candidate.safetyFlags.length ? (
                              <div className="space-y-1">
                                {candidate.safetyFlags.map((flag) => <Badge key={flag} variant="destructive" className="mr-1">{flag.replace(/_/g, " ")}</Badge>)}
                                <div className="text-[11px] text-red-700">Verification blocked by safety evidence.</div>
                              </div>
                            ) : <span className="text-xs text-muted-foreground">No safety flags returned</span>}
                          </TableCell>
                          <TableCell className="min-w-[170px]">
                            {candidate.isVerified ? (
                              <Badge variant="default">Verified link (decision + projection)</Badge>
                            ) : (
                              <Badge variant="outline">Suggestion only · not verified</Badge>
                            )}
                            <div className="text-[11px] text-muted-foreground mt-1">
                              Decision: {candidate.currentDecision ?? "none"} · revision {candidate.currentRevision}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              Projected business: {candidate.projectedBusinessId ?? "none"}
                            </div>
                            {projectionConflict && <Badge variant="destructive" className="mt-1">Existing projection conflicts</Badge>}
                          </TableCell>
                          <TableCell className="min-w-[220px]">
                            <div className="space-y-1.5">
                              <select
                                className="h-8 w-full rounded border bg-background px-2 text-xs"
                                aria-label={`Decision for contact ${candidate.contactId}`}
                                value={review?.decision ?? ""}
                                disabled={!selected || candidate.isVerified}
                                onChange={(event) => setCandidateReview(candidate.candidateId, { decision: event.target.value })}
                              >
                                <option value="">Choose independent decision…</option>
                                <option value="verified" disabled={!canVerifyCandidate}>Verify link (requires evidence)</option>
                                <option value="conflicted">Mark conflicted</option>
                                <option value="rejected">Reject candidate</option>
                                <option value="missing">Mark missing</option>
                                <option value="legacy_unknown">Legacy unknown</option>
                              </select>
                              <Input
                                type="number"
                                min={1}
                                className="h-8"
                                placeholder="Pre-existing source event ID"
                                aria-label={`Evidence event ID for contact ${candidate.contactId}`}
                                value={review?.evidenceEventId ?? ""}
                                disabled={!selected || review?.decision !== "verified"}
                                onChange={(event) => setCandidateReview(candidate.candidateId, { evidenceEventId: event.target.value })}
                              />
                              {review?.decision === "verified" && (
                                <div className="text-[10px] text-amber-800">
                                  Verification requires an existing source event, safe unambiguous evidence, and expected revision {candidate.currentRevision}.
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {suggestionsQuery.data.candidates.length === 0 && (
                      <TableRow><TableCell colSpan={6} className="text-center text-xs text-muted-foreground">
                        {contactId !== undefined
                          ? "No stored candidate for this contact. Inspect its record and generate candidate evidence through Contact ↔ Business Reconciliation first. A missing candidate cannot be verified here."
                          : "No suggestions on this page. This is not a count of all contacts or a verified-link result."}
                      </TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {suggestionsQuery.data.candidates.length} suggestion(s) on this page
                  {selectedCandidateIds.length ? ` · ${selectedCandidateIds.length} selected` : ""}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline"
                    disabled={cursorHistory.length === 0 || suggestionsQuery.isFetching}
                    onClick={() => {
                      const previous = cursorHistory[cursorHistory.length - 1];
                      setCursorHistory((history) => history.slice(0, -1));
                      setPageCursor(previous ?? null);
                      setSelectedCandidateIds([]);
                    }}>
                    Previous page
                  </Button>
                  <Button size="sm" variant="outline"
                    disabled={!suggestionsQuery.data.nextCursor || suggestionsQuery.isFetching}
                    onClick={() => {
                      if (!suggestionsQuery.data?.nextCursor) return;
                      setCursorHistory((history) => [...history, pageCursor]);
                      setPageCursor(suggestionsQuery.data.nextCursor);
                      setSelectedCandidateIds([]);
                    }}>
                    Next page
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => reviewBatchMutation.mutate()}
                  disabled={!selectedCandidateIds.length || Boolean(reviewReadinessIssue) || reviewBatchMutation.isPending}>
                  {reviewBatchMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                  Submit independent review batch (max 50)
                </Button>
                {reviewReadinessIssue && selectedCandidateIds.length > 0 && (
                  <span className="text-xs text-amber-800">
                    Choose a decision for each selected suggestion. Verification additionally requires a pre-existing evidence event and non-ambiguous, safe evidence.
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">Suggestion page has not loaded.</div>
          )}
          {reviewBatchMutation.isError && (
            <div className="text-xs text-red-700" role="alert">Review batch failed; selections are retained for correction/retry: {(reviewBatchMutation.error as Error).message}</div>
          )}
          {reviewBatchMutation.data && (
            <div className="rounded border p-2 text-xs" role="status">
              Last batch: {reviewBatchMutation.data.applied} applied · {reviewBatchMutation.data.rejected} rejected
              {reviewBatchMutation.data.outcomes.filter((outcome) => outcome.status === "rejected").length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {reviewBatchMutation.data.outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => (
                    <li key={outcome.candidateId}>{outcome.candidateId}: {outcome.code ?? "review rejected"}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface LeadOpsStats {
  total: number;
  processing_completed: number;
  pending_processing: number;
  processing: number;
  failed: number;
  hot: number; warm: number; cold: number;
  current_email_inventory: number;
  current_phone_inventory: number;
  contactable: number;
  has_owner_name: number;
  verticals: Array<{ vertical: string; count: number; hot_count: number }>;
}

interface LeadOpsHealth {
  enrichedToday: HealthMetric;
  emailsToday: HealthMetric;
  phonesToday: HealthMetric;
  queueDepth: HealthMetric;
  totalEnriched: HealthMetric;
  totalFailed: HealthMetric;
  successRate: HealthMetric;
  lastEnrichedAt: string | null;
  minutesSinceLastJob: number | null;
  workerActive: boolean;
  // Worker-authority truth fields (MI-01)
  intakeAuthority: "scheduled-sunbiz-pipeline" | "legacy-outreach-cycle" | "both" | "none";
  enrichmentProgressStatus: "idle" | "running" | "interrupted" | "failed";
  sunbizEnrichmentEnabled: boolean;
  freeEnrichmentPendingJobs: number;
  lastScheduledEnrichmentAt: string | null;
  legacyRouteAttemptsSinceStartup: number;
  canonicalFreeEnrichmentQueueDepth?: number;
  sourceRegistryCounts?: {
    canonicalBusinesses: HealthMetric;
    sourceLinks: HealthMetric;
    adapters: HealthMetric;
  };
}

interface HealthMetric {
  value: number | string | null;
  available: boolean;
  stale?: boolean;
  error?: string;
}

interface LeadOpsConfig {
  serperConfigured: boolean;
  openaiConfigured: boolean;
}

interface LeadEntity {
  id: number; entity_name: string; principal_city: string; principal_state: string;
  vertical: string | null; score: string | null; enrichment_status: string;
  enriched_at: string | null; owner_name: string | null;
  owner_email: string | null; owner_phone: string | null;
  email: string | null; phone: string | null; website: string | null;
  prospect_id: number | null; ai_summary: string | null; tags: string[] | null;
}

interface AiSegment {
  name: string; vertical: string; score: string; estimatedCount: number;
  channel: string; angle: string; priority: number;
}

interface AiAnalysis {
  summary: string;
  segments: AiSegment[];
  recommendations: string[];
  outreachPriority: Array<{ vertical: string; estimatedCloseRate: string; whyNow: string }>;
  quickWins: string[];
  pool: any;
  verticals: any[];
}

interface InboundRequest {
  requestReceipt: string;
  sourceClass: string;
  sourceCategory: string;
  sourceType: string;
  lifecycleState: string;
  effects: Array<{
    effectKey: string;
    effectType: string;
    state: string;
    required: boolean;
    externalSideEffect: boolean;
    terminalReason: string | null;
  }>;
  assignmentStatus: string;
  assignmentReason?: string | null;
  assignedTo: string | null;
  slaDueAt: string | null;
  contactId: number | null;
  dealId: number | null;
  ticketId: number | null;
  createdAt: string;
  terminalReason: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scoreBadge(score: string | null) {
  if (score === "hot")  return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300";
  if (score === "warm") return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300";
  if (score === "cold") return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300";
  return "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300";
}

function statusBadge(status: string) {
  if (status === "enriched")   return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300";
  if (status === "pending")    return "bg-yellow-100 text-yellow-800 border-yellow-200";
  if (status === "processing") return "bg-blue-100 text-blue-800 border-blue-200";
  if (status === "failed")     return "bg-red-100 text-red-800 border-red-200";
  return "bg-gray-100 text-gray-700 border-gray-200";
}

function inboundStatusBadge(status: string | null | undefined) {
  if (status === "accepted" || status === "completed" || status === "sent" || status === "assigned") return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300";
  if (status === "failed" || status === "cancelled" || status === "suppressed" || status === "unassigned_policy_missing") return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300";
  if (status === "review_required" || status === "pending" || status === "held") return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300";
}

function formatInboundDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

// ─── MI-04: Canonical Business Free Enrichment Panel ─────────────────────────

interface CanonicalBusiness {
  id: number;
  canonical_name: string | null;
  website_domain: string | null;
  city: string | null;
  state: string | null;
  vertical: string | null;
  free_enrichment_status: string | null;
  free_enrichment_attempt_count: number;
  free_enrichment_last_attempt_at: string | null;
  free_enrichment_completed_at: string | null;
  free_enrichment_evidence: Record<string, unknown> | null;
  // MI-06: email discovery pipeline
  email_discovery_status: string | null;
  email_validation_updated_at: string | null;
  email_selected_candidate_hash: string | null;
  email_outreach_catch_all_approved_at: string | null;
  email_outreach_approved_by: string | null;
  main_email: string | null;
}

interface WinnerSelection {
  id: string;
  source: string;
  subject_type: string;
  confidence: number;
  state: string;
  normalized_value_hash: string;
  masked_value: string | null;
}

interface BusinessPendingIntent {
  id: string;
  state: string;
  approval_required: boolean;
  apollo_match_confidence: string | null;
  disposition: string | null;
  attempt_count: number;
  created_at: string;
}

type BusinessQueryResponse = {
  business: CanonicalBusiness;
  processorSignals: ProcessorSignal[];
  emailDiscoveryStatus: string | null;
  emailValidationUpdatedAt: string | null;
  isStale: boolean;
  winnerSelection: WinnerSelection | null;
  pendingIntent: BusinessPendingIntent | null;
};

interface ProcessorSignal {
  id: number;
  signal_type: string;
  vendor_name: string;
  detection_method: string;
  confidence_score: number;
  evidence: string | null;
  detected_at: string | null;
}

function freeEnrichStatusBadge(status: string | null) {
  if (!status) return "bg-gray-100 text-gray-600 border-gray-200";
  if (status === "enriched")   return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300";
  if (status === "processing") return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300";
  if (status === "failed")     return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300";
  if (status === "skipped")    return "bg-gray-100 text-gray-600 border-gray-200";
  return "bg-yellow-100 text-yellow-800 border-yellow-200"; // queued / null
}

// MI-06: email_discovery_status color coding
function emailDiscoveryBadge(status: string | null): string {
  if (!status) return "bg-gray-100 text-gray-600 border-gray-200";
  if (status === "provider_valid")    return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300";
  if (status === "provider_invalid")  return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300";
  if (status === "provider_catch_all") return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300";
  if (status === "discovered")        return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300";
  if (status === "no_valid_candidate") return "bg-gray-100 text-gray-600 border-gray-200";
  if (status === "stale")             return "bg-amber-100 text-amber-800 border-amber-200";
  if (status === "provider_unknown" || status === "provider_spamtrap") {
    return "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300";
  }
  if (status === "dns_indeterminate" || status === "no_mx") {
    return "bg-yellow-100 text-yellow-800 border-yellow-200";
  }
  return "bg-gray-100 text-gray-600 border-gray-200";
}

type NamedEmailEligibilityReview = {
  eligibility_id: string;
  cohort_run_id: string;
  business_id: number;
  business_name: string;
  source_kind: string;
  contact_id: number | null;
  contact_email: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  business_website: string | null;
  masked_email: string | null;
  decision_reason: string;
  validation_at: string | null;
  validation_expires_at: string | null;
  updated_at: string;
  latest_review_decision: string | null;
  latest_reviewer_id: string | null;
  latest_reason: string | null;
};

function NamedEmailEligibilityReviewPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkReviewResult, setBulkReviewResult] = useState<Array<{ eligibilityId: string; ok: boolean; message?: string }> | null>(null);
  const query = useQuery<{ reviews: NamedEmailEligibilityReview[] }>({
    queryKey: ["/api/lead-ops/sfp/named-email-eligibility-reviews"],
    queryFn: async () => (await apiRequest("GET", "/api/lead-ops/sfp/named-email-eligibility-reviews?limit=50")).json(),
    retry: false,
  });
  const reviewMutation = useMutation({
    mutationFn: async ({ row, decision }: { row: NamedEmailEligibilityReview; decision: "approved" | "rejected" }) => {
      const reason = (reasons[row.eligibility_id] ?? "").trim();
      if (reason.length < 8) throw new Error("Enter a review reason of at least 8 characters.");
      return (await apiRequest("POST", `/api/lead-ops/sfp/named-email-eligibility-reviews/${row.eligibility_id}`, {
        decision,
        reason,
        expectedUpdatedAt: row.updated_at,
        idempotencyKey: crypto.randomUUID(),
      })).json();
    },
    onSuccess: (_data, variables) => {
      toast({ title: "Eligibility decision recorded", description: "This decision affects policy eligibility only; it does not authorize enrollment or sending." });
      setReasons((current) => ({ ...current, [variables.row.eligibility_id]: "" }));
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sfp/named-email-eligibility-reviews"] });
    },
    onError: (error: Error) => toast({ title: "Eligibility review failed", description: error.message, variant: "destructive" }),
  });
  const bulkReviewMutation = useMutation({
    mutationFn: async (decision: "approved" | "rejected") => {
      const selectedRows = (query.data?.reviews ?? [])
        .filter((row) => selectedReviewIds.includes(row.eligibility_id))
        .slice(0, 50);
      const results: Array<{ eligibilityId: string; ok: boolean; message?: string }> = [];
      // Keep the original per-item endpoint as the authority. Every item gets
      // a fresh server-side source/receipt/policy/suppression/CAS and
      // independent-reviewer check; one conflict does not stop later rows.
      for (const row of selectedRows) {
        try {
          await apiRequest("POST", `/api/lead-ops/sfp/named-email-eligibility-reviews/${row.eligibility_id}`, {
            decision,
            reason: bulkReason.trim(),
            expectedUpdatedAt: row.updated_at,
            idempotencyKey: crypto.randomUUID(),
          });
          results.push({ eligibilityId: row.eligibility_id, ok: true });
        } catch (error) {
          results.push({
            eligibilityId: row.eligibility_id,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      setBulkReviewResult(results);
      setSelectedReviewIds([]);
      toast({
        title: "Bounded named-email review finished",
        description: `${results.filter((result) => result.ok).length} decisions recorded; ${results.filter((result) => !result.ok).length} held for review.`,
        variant: results.some((result) => !result.ok) ? "destructive" : undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sfp/named-email-eligibility-reviews"] });
    },
    onError: (error: Error) => toast({ title: "Bulk review failed", description: error.message, variant: "destructive" }),
  });
  const toggleReviewSelection = (eligibilityId: string, checked: boolean) => {
    setSelectedReviewIds((current) => checked
      ? current.includes(eligibilityId) ? current : [...current, eligibilityId].slice(0, 50)
      : current.filter((id) => id !== eligibilityId));
  };
  if (user?.role !== "admin") return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Named-email eligibility review</CardTitle>
        <CardDescription>
          Independently review fresh ZeroBounce-valid named addresses held by the active policy. Approval is not held-intent review, enrollment, or send authority.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Bounded to 50 current, unexpired records. No provider calls or outbound actions.</span>
          <Button size="sm" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}Refresh
          </Button>
        </div>
        {query.isError && <p className="text-sm text-red-700" role="alert">Review queue unavailable: {(query.error as Error).message}</p>}
        {query.isLoading && <p className="text-sm text-muted-foreground">Loading eligibility reviews…</p>}
        {query.data?.reviews.length === 0 && <p className="text-sm text-muted-foreground">No current named-email eligibility reviews are awaiting decision.</p>}
        {query.data?.reviews.length ? (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <div className="text-xs text-muted-foreground">
              Select up to 50 current rows for sequential bulk review. Every decision is submitted to the existing independently-attributed per-item route; a self-review or stale item remains held without stopping other items.
            </div>
            <select className="w-full rounded-md border bg-background p-2 text-sm"
              aria-label="Bulk named-email review reason"
              value={bulkReason}
              onChange={(event) => setBulkReason(event.target.value)}
            >
              <option value="">Choose a reason for the selected records</option>
              <option value="Reviewed business recipient and company association">Business recipient — company association reviewed</option>
              <option value="Recipient is not associated with this company">Wrong company or recipient</option>
              <option value="Insufficient information to establish business recipient affiliation">Insufficient information to approve</option>
            </select>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={bulkReviewMutation.isPending || selectedReviewIds.length === 0 || selectedReviewIds.length > 50 || bulkReason.trim().length < 8}
                onClick={() => bulkReviewMutation.mutate("approved")}
              >
                {bulkReviewMutation.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Approve selected ({selectedReviewIds.length})
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkReviewMutation.isPending || selectedReviewIds.length === 0 || selectedReviewIds.length > 50 || bulkReason.trim().length < 8}
                onClick={() => bulkReviewMutation.mutate("rejected")}
              >
                Reject selected ({selectedReviewIds.length})
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedReviewIds([])} disabled={selectedReviewIds.length === 0 || bulkReviewMutation.isPending}>
                Clear selection
              </Button>
            </div>
            {bulkReviewResult && (
              <div className="space-y-1 text-xs" role="status">
                <div>Last batch: {bulkReviewResult.filter((result) => result.ok).length} recorded, {bulkReviewResult.filter((result) => !result.ok).length} not recorded.</div>
                {bulkReviewResult.filter((result) => !result.ok).map((result) => (
                  <div key={result.eligibilityId} className="text-destructive">
                    {result.eligibilityId}: {result.message ?? "review did not commit; row remains held"}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
        {query.data?.reviews.map((row) => (
          <div key={row.eligibility_id} className="rounded-md border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                aria-label={`Select named-email eligibility ${row.eligibility_id} for bulk review`}
                checked={selectedReviewIds.includes(row.eligibility_id)}
                onCheckedChange={(checked) => toggleReviewSelection(row.eligibility_id, checked === true)}
                disabled={bulkReviewMutation.isPending || (!selectedReviewIds.includes(row.eligibility_id) && selectedReviewIds.length >= 50)}
              />
              <Link href={`/dashboard/lead-ops/business/${row.business_id}`} className="text-sm font-semibold underline">
                {row.business_name || `Business #${row.business_id}`}
              </Link>
              <Badge variant="outline">{row.contact_email || row.masked_email || "Email masked"}</Badge>
              <Badge variant="secondary">ZeroBounce valid · {row.source_kind}</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {row.contact_id && <Link className="underline" href={`/dashboard/contacts/${row.contact_id}`}>
                Open contact{row.contact_first_name ? ` · ${[row.contact_first_name, row.contact_last_name].filter(Boolean).join(" ")}` : ""}
              </Link>}
              <Link className="underline" href={`/dashboard/lead-ops/business/${row.business_id}`}>Open company record</Link>
              {row.business_website && <span>{row.business_website}</span>}
              <span>Validated {row.validation_at ? new Date(row.validation_at).toLocaleString() : "timestamp unavailable"}</span>
            </div>
            <p className="text-xs">
              ZeroBounce passed. The active outreach policy separately holds named addresses until a business-recipient decision is recorded.
              Choose a reason below; no typed explanation is required.
            </p>
            <p className="text-xs text-muted-foreground">
              Eligibility {row.eligibility_id} · validation expires {row.validation_expires_at ? new Date(row.validation_expires_at).toLocaleString() : "unknown"} · {row.decision_reason}
            </p>
            {row.latest_review_decision && <p className="text-xs">Latest separate decision: {row.latest_review_decision} by {row.latest_reviewer_id} — {row.latest_reason}</p>}
            <select className="w-full rounded-md border bg-background p-2 text-sm"
              aria-label={`Eligibility review reason for ${row.eligibility_id}`}
              value={reasons[row.eligibility_id] ?? ""}
              onChange={(event) => setReasons((current) => ({ ...current, [row.eligibility_id]: event.target.value }))}
            >
              <option value="">Choose the reason for your decision</option>
              <option value="Reviewed business recipient and company association">Business recipient — company association reviewed</option>
              <option value="Recipient is not associated with this company">Wrong company or recipient</option>
              <option value="Insufficient information to establish business recipient affiliation">Insufficient information to approve</option>
            </select>
            <div className="flex gap-2">
              <Button size="sm" disabled={reviewMutation.isPending || (reasons[row.eligibility_id] ?? "").trim().length < 8}
                onClick={() => reviewMutation.mutate({ row, decision: "approved" })}>Approve eligibility</Button>
              <Button size="sm" variant="outline" disabled={reviewMutation.isPending || (reasons[row.eligibility_id] ?? "").trim().length < 8}
                onClick={() => reviewMutation.mutate({ row, decision: "rejected" })}>Reject eligibility</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CanonicalBusinessPanel({ healthQueueDepth }: { healthQueueDepth: number | null }) {
  const { toast } = useToast();
  const [lookupId, setLookupId] = useState("");
  const [businessId, setBusinessId] = useState<number | null>(null);
  const businessQuery = useQuery<BusinessQueryResponse>({
    queryKey: [`/api/lead-ops/businesses/${businessId}`],
    queryFn: async () => {
      const res = await fetch(`/api/lead-ops/businesses/${businessId}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: businessId !== null,
  });

  const enrichMutation = useMutation({
    mutationFn: async (id: number) => {
      // Use apiRequest so the CSRF token is attached — raw fetch would return 403
      const res = await apiRequest("POST", `/api/lead-ops/businesses/${id}/enrich-free`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Enrichment queued", description: "Free enrichment job enqueued for this business." });
      businessQuery.refetch();
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const approveCatchAllMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/lead-ops/businesses/${id}/approve-catch-all`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Catch-all approved", description: "Business approved for outreach. email_discovery_status unchanged." });
      businessQuery.refetch();
    },
    onError: (e: Error) => toast({ title: "Approval failed", description: e.message, variant: "destructive" }),
  });

  const approveMediumConfidenceMutation = useMutation({
    mutationFn: async ({ id, intentId }: { id: number; intentId: string }) => {
      const res = await apiRequest("POST", `/api/lead-ops/businesses/${id}/approve-medium-confidence-validation`, { intentId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Medium-confidence approved", description: "Intent enabled for ZeroBounce validation." });
      businessQuery.refetch();
    },
    onError: (e: Error) => toast({ title: "Approval failed", description: e.message, variant: "destructive" }),
  });

  const biz = businessQuery.data?.business;
  const signals = businessQuery.data?.processorSignals ?? [];
  const winnerSelection = businessQuery.data?.winnerSelection ?? null;
  const pendingIntent = businessQuery.data?.pendingIntent ?? null;
  const isStale = businessQuery.data?.isStale ?? false;

  const signalTypeLabel = (t: string) => {
    if (t === "processor") return "💳";
    if (t === "pos") return "🖥️";
    if (t === "booking_platform") return "📅";
    if (t === "ecommerce_platform") return "🛒";
    return "📦";
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <div>
            <CardTitle className="text-base">Canonical Business Enrichment</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Free enrichment pipeline (MI-04) — HTML signals, RDAP, JSON-LD, contact pages.
              {healthQueueDepth !== null && (
                <span className="ml-2 font-medium text-foreground">
                  {healthQueueDepth.toLocaleString()} pending in queue.
                </span>
              )}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        <div className="flex items-center gap-2">
          <Input
            placeholder="Enter business ID…"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            className="h-8 text-sm w-40"
            onKeyDown={(e) => { if (e.key === "Enter") setBusinessId(Number(lookupId) || null); }}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => setBusinessId(Number(lookupId) || null)}
            disabled={!lookupId || isNaN(Number(lookupId))}
          >
            Look up
          </Button>
        </div>

        {businessQuery.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        )}

        {businessQuery.isError && (
          <p className="text-sm text-destructive">
            {businessQuery.error instanceof Error ? businessQuery.error.message : "Failed to load business"}
          </p>
        )}

        {biz && (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/10 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <div className="font-medium text-sm">{biz.canonical_name ?? `Business #${biz.id}`}</div>
                  {biz.website_domain && (
                    <a
                      href={`https://${biz.website_domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:underline"
                    >
                      {biz.website_domain}
                    </a>
                  )}
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {[biz.city, biz.state].filter(Boolean).join(", ")}
                    {biz.vertical && <> · {biz.vertical}</>}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <Badge
                    variant="outline"
                    className={`text-[10px] px-1.5 py-0 h-5 ${freeEnrichStatusBadge(biz.free_enrichment_status)}`}
                  >
                    {biz.free_enrichment_status ?? "unprocessed"}
                  </Badge>
                  {biz.free_enrichment_completed_at && (
                    <div className="text-[10px] text-muted-foreground">
                      Enriched {new Date(biz.free_enrichment_completed_at).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </div>

              {/* Processor/POS/booking/ecommerce signals as tags */}
              {signals.length > 0 && (
                <div>
                  <div className="text-[10px] text-muted-foreground mb-1">Detected signals</div>
                  <div className="flex flex-wrap gap-1">
                    {signals.map((s) => (
                      <Badge
                        key={s.id}
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 h-5"
                        title={`${s.detection_method} · confidence ${Math.round(s.confidence_score * 100)}%`}
                      >
                        {signalTypeLabel(s.signal_type)} {s.vendor_name}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Email count evidence (not raw emails) */}
              {biz.free_enrichment_evidence && (
                <div className="text-[10px] text-muted-foreground">
                  {typeof (biz.free_enrichment_evidence as any).jsonldEmailCount === "number" && (
                    <span className="mr-3">JSON-LD emails: {(biz.free_enrichment_evidence as any).jsonldEmailCount}</span>
                  )}
                  {typeof (biz.free_enrichment_evidence as any).contactPageEmailCount === "number" && (
                    <span>Contact-page emails: {(biz.free_enrichment_evidence as any).contactPageEmailCount}</span>
                  )}
                </div>
              )}

              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5 mt-1"
                onClick={() => enrichMutation.mutate(biz.id)}
                disabled={enrichMutation.isPending}
              >
                <RefreshCw className={`h-3 w-3 ${enrichMutation.isPending ? "animate-spin" : ""}`} />
                Enrich now
              </Button>
            </div>

            {/* ── MI-06: Email Discovery Status ──────────────────────────── */}
            <div className="rounded-lg border bg-muted/10 p-3 space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email Discovery (MI-06)</div>

              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1.5 py-0 h-5 ${emailDiscoveryBadge(biz.email_discovery_status)}`}
                >
                  {biz.email_discovery_status ?? "not started"}
                </Badge>
                {isStale && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-amber-100 text-amber-800 border-amber-200">
                    stale (90d+)
                  </Badge>
                )}
                {biz.email_validation_updated_at && (
                  <span className="text-[10px] text-muted-foreground">
                    Validated {new Date(biz.email_validation_updated_at).toLocaleDateString()}
                  </span>
                )}
              </div>

              {/* Winner candidate (masked — no raw email displayed) */}
              {winnerSelection && (
                <div className="text-[10px] text-muted-foreground space-y-0.5">
                  <div>Winner: <span className="font-mono">{winnerSelection.masked_value ?? "***"}</span></div>
                  <div>Source: {winnerSelection.source} · Type: {winnerSelection.subject_type}</div>
                </div>
              )}

              {/* Catch-all approval banner */}
              {biz.email_discovery_status === "provider_catch_all" && !biz.email_outreach_catch_all_approved_at && (
                <div className="rounded border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-1.5">
                  <div className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    ⚠ Catch-all mail server — individual delivery unverifiable. Approve for outreach?
                  </div>
                  <div className="text-[10px] text-amber-700 dark:text-amber-400">
                    This will not change the validation result. Outreach eligibility only.
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] gap-1"
                    onClick={() => {
                      if (confirm("Approve this catch-all address for outreach? This will not change the validation result.")) {
                        approveCatchAllMutation.mutate(biz.id);
                      }
                    }}
                    disabled={approveCatchAllMutation.isPending}
                  >
                    Approve for outreach
                  </Button>
                </div>
              )}

              {/* Catch-all already approved */}
              {biz.email_discovery_status === "provider_catch_all" && biz.email_outreach_catch_all_approved_at && (
                <div className="text-[10px] text-green-700 dark:text-green-400">
                  ✓ Catch-all approved for outreach by {biz.email_outreach_approved_by ?? "admin"} on{" "}
                  {new Date(biz.email_outreach_catch_all_approved_at).toLocaleDateString()}
                </div>
              )}

              {/* Medium-confidence approval banner — explicit operator approval
                  is required before attempting ZeroBounce validation. */}
              {pendingIntent && pendingIntent.approval_required && (
                <div className="rounded border border-blue-200 bg-blue-50 dark:bg-blue-900/20 p-2 space-y-1.5">
                  <div className="text-xs font-medium text-blue-800 dark:text-blue-300">
                    🔵 Apollo returned medium-confidence match. Approve to attempt ZeroBounce validation?
                  </div>
                  <div className="text-[10px] text-blue-700 dark:text-blue-400">
                    This does NOT approve for outreach — ZeroBounce must confirm validity first.
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] gap-1 border-amber-300 text-amber-700 hover:bg-amber-50"
                    onClick={() => {
                      if (confirm("Approve this medium-confidence match for ZeroBounce validation? This does not approve the result for outreach.")) {
                        approveMediumConfidenceMutation.mutate({ id: biz.id, intentId: pendingIntent.id });
                      }
                    }}
                    disabled={approveMediumConfidenceMutation.isPending}
                  >
                    Approve for validation
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Enrichment Queue Panel ───────────────────────────────────────────────────
interface EnrichmentJob {
  id: number;
  prospectId: number | null;
  listId: number | null;
  jobType: string;
  status: string | null;
  totalCount: number | null;
  processedCount: number | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

function jobStatusBadge(status: string | null) {
  if (status === "completed") return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300";
  if (status === "processing") return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300";
  if (status === "failed")     return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300";
  if (status === "cancelled")  return "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400";
  return "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300"; // pending
}

// TASK-1830: enrichment job controls are governed (503) until Gen-2 authorization.
// The panel renders job status read-only; retry/cancel buttons are hidden and replaced
// with a static notice until the governed state machine is promoted.
const ENRICHMENT_CONTROLS_GOVERNED = true;

function EnrichmentQueuePanel() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: jobs = [], isLoading, refetch } = useQuery<EnrichmentJob[]>({
    queryKey: ["/api/enrichment-jobs"],
    queryFn: async () => {
      const r = await fetch("/api/enrichment-jobs", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30000,
  });

  // patchJobMutation retained for future use when ENRICHMENT_CONTROLS_GOVERNED is lifted.
  const patchJobMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "pending" | "cancelled" }) => {
      const res = await apiRequest("PATCH", `/api/enrichment-jobs/${id}`, { status });
      return res.json();
    },
    onSuccess: (_data, vars) => {
      toast({
        title: vars.status === "cancelled" ? "Job cancelled" : "Job reset to pending",
        description: vars.status === "cancelled" ? "The job has been cancelled." : "The job will be retried on the next worker tick.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/enrichment-jobs"] });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const filtered = statusFilter === "all" ? jobs : jobs.filter(j => j.status === statusFilter);
  const counts = {
    total: jobs.length,
    pending: jobs.filter(j => j.status === "pending").length,
    processing: jobs.filter(j => j.status === "processing").length,
    completed: jobs.filter(j => j.status === "completed").length,
    failed: jobs.filter(j => j.status === "failed").length,
    cancelled: jobs.filter(j => j.status === "cancelled").length,
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Enrichment Queue</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                {ENRICHMENT_CONTROLS_GOVERNED
                  ? "Read-only view — job controls require activation authorization."
                  : "View, retry, or cancel individual enrichment jobs. Auto-refreshes every 30s."}
              </CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Summary chips */}
        <div className="flex flex-wrap gap-2 pt-1">
          {[
            { label: "All", value: "all", count: counts.total },
            { label: "Pending", value: "pending", count: counts.pending },
            { label: "Processing", value: "processing", count: counts.processing },
            { label: "Completed", value: "completed", count: counts.completed },
            { label: "Failed", value: "failed", count: counts.failed },
            { label: "Cancelled", value: "cancelled", count: counts.cancelled },
          ].map(({ label, value, count }) => (
            <button
              key={value}
              onClick={() => setStatusFilter(value)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                statusFilter === value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background border-border hover:bg-muted"
              }`}
            >
              {label}
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
                statusFilter === value ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}>{count}</span>
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {isLoading ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">Loading enrichment jobs…</div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-8 text-sm text-muted-foreground text-center">
            {statusFilter === "all" ? "No enrichment jobs found." : `No ${statusFilter} jobs.`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Prospect / List</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(0, 200).map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">#{job.id}</TableCell>
                    <TableCell className="text-xs">{job.jobType}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.prospectId ? `Prospect #${job.prospectId}` : job.listId ? `List #${job.listId}` : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-xs ${jobStatusBadge(job.status)}`}>
                        {job.status ?? "unknown"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {(job.totalCount ?? 0) > 0
                        ? `${job.processedCount ?? 0} / ${job.totalCount}`
                        : "—"}
                      {job.error && (
                        <span className="ml-1 text-red-500" title={job.error}>⚠</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.createdAt ? new Date(job.createdAt).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.completedAt ? new Date(job.completedAt).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell>
                      {ENRICHMENT_CONTROLS_GOVERNED ? (
                        <span className="text-[10px] text-muted-foreground" title="Job controls require activation authorization — available in a future release">
                          Governed
                        </span>
                      ) : (
                        <div className="flex items-center gap-1">
                          {(job.status === "failed" || job.status === "cancelled") && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              title="Retry (reset to pending)"
                              disabled={patchJobMutation.isPending}
                              onClick={() => patchJobMutation.mutate({ id: job.id, status: "pending" })}
                            >
                              <RotateCw className="h-3.5 w-3.5 text-blue-600" />
                            </Button>
                          )}
                          {(job.status === "pending" || job.status === "processing") && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              title="Cancel job"
                              disabled={patchJobMutation.isPending}
                              onClick={() => patchJobMutation.mutate({ id: job.id, status: "cancelled" })}
                            >
                              <XCircle className="h-3.5 w-3.5 text-red-500" />
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
// ─── MI-08: Businesses Tab ────────────────────────────────────────────────────
function BusinessesTab({ userRole }: { userRole: string }) {
  // List context lives in the address (replace, not push) so Back from a business restores the same page.
  const initialList = new URLSearchParams(window.location.search);
  const listParam = (key: string) => { const all = initialList.getAll(key); return all.length === 1 ? all[0] : ""; };
  const [search, setSearch] = useState(() => listParam("bq").slice(0, 200));
  const [verticalFilter, setVerticalFilter] = useState(() => listParam("bvertical").slice(0, 120));
  const [emailStatusFilter, setEmailStatusFilter] = useState(() => listParam("bemail").slice(0, 60));
  const [offset, setOffset] = useState(() => { const v = Number(listParam("boffset")); return Number.isInteger(v) && v >= 0 && v % 50 === 0 ? v : 0; });
  useEffect(() => {
    const url = new URL(window.location.href);
    const write = (key: string, value: string) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    write("bq", search); write("bvertical", verticalFilter); write("bemail", emailStatusFilter);
    write("boffset", offset ? String(offset) : "");
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [search, verticalFilter, emailStatusFilter, offset]);
  const [selectedBusiness, setSelectedBusiness] = useState<BusinessListItem | null>(null);
  const [, navigateTo] = useLocation();
  const [bootstrapConfirmation, setBootstrapConfirmation] = useState("");
  const [bootstrapLimit, setBootstrapLimit] = useState("10");
  const [recordClassRepairConfirmation, setRecordClassRepairConfirmation] = useState("");
  const LIMIT = 50;
  // Source vertical options from canonical businesses table, not legacy sunbiz_entities.
  const verticalsQuery = useQuery<{ verticals: Array<{ vertical: string; count: number }> }>({
    queryKey: ["/api/lead-ops/business-verticals"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/business-verticals", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 60_000,
  });
  const verticals = verticalsQuery.data?.verticals ?? [];

  const bootstrapPreviewQuery = useQuery<any>({
    queryKey: ["/api/lead-ops/sunbiz-bootstrap/preview", bootstrapLimit],
    queryFn: async () => {
      const r = await fetch(`/api/lead-ops/sunbiz-bootstrap/preview?limit=${encodeURIComponent(bootstrapLimit)}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: userRole === "admin",
    staleTime: 10_000,
  });
  const bootstrapStatusQuery = useQuery<any>({
    queryKey: ["/api/lead-ops/sunbiz-bootstrap/status"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/sunbiz-bootstrap/status", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: userRole === "admin",
    refetchInterval: 15_000,
  });

  // Task #2002 completion: truthful corpus-level backfill run status, driven
  // by the recurring worker in server/services/sunbiz-full-backfill.ts.
  // Distinct from bootstrapStatusQuery above (which reports claim totals,
  // not run/cursor state).
  const backfillStatusQuery = useQuery<any>({
    queryKey: ["/api/lead-ops/sunbiz-bootstrap/backfill-status"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/sunbiz-bootstrap/backfill-status", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: userRole === "admin",
    refetchInterval: 10_000,
  });
  const backfillResumeMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/lead-ops/sunbiz-bootstrap/backfill/resume", {})).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sunbiz-bootstrap/backfill-status"] }),
  });
  const backfillPauseMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/lead-ops/sunbiz-bootstrap/backfill/pause", {})).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sunbiz-bootstrap/backfill-status"] }),
  });

  // One-time correction: businesses the Sunbiz bootstrap created before the
  // create.recordClass fix was published landed with record_class='unknown'
  // instead of 'canonical', making them invisible to this page, the
  // free-enrichment cohort, and MI-09 eligibility. Preview is read-only;
  // execution is guarded by a typed confirmation phrase bound to a
  // short-lived, single-use preview token, mirroring the bootstrap pattern
  // above. Safe to leave running indefinitely — once the cohort is empty,
  // preview always reports 0 and there is nothing left to run.
  const recordClassRepairPreviewQuery = useQuery<any>({
    queryKey: ["/api/lead-ops/sunbiz-bootstrap/record-class-repair/preview"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/sunbiz-bootstrap/record-class-repair/preview", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: userRole === "admin",
    staleTime: 10_000,
  });
  const recordClassRepairRunMutation = useMutation({
    mutationFn: async () => {
      const previewToken = recordClassRepairPreviewQuery.data?.previewToken;
      if (!previewToken) {
        const err: Error & { code?: string } = new Error("No active preview token — re-checking preview before you can run.");
        err.code = "no_active_preview_token";
        throw err;
      }
      try {
        const r = await apiRequest("POST", "/api/lead-ops/sunbiz-bootstrap/record-class-repair/run", {
          confirmation: recordClassRepairConfirmation,
          previewToken,
        });
        return await r.json();
      } catch (e) {
        const { code, reason } = parseApiRequestError(e instanceof Error ? e.message : String(e));
        const err: Error & { code?: string } = new Error(reason || (e instanceof Error ? e.message : String(e)));
        err.code = code;
        throw err;
      }
    },
    onSuccess: () => {
      setRecordClassRepairConfirmation("");
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sunbiz-bootstrap/record-class-repair/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/businesses"] });
    },
    onError: (err: Error & { code?: string }) => {
      // Same rationale as the bootstrap mutation above: only force a fresh
      // preview/token when this one is actually dead, never on a typed
      // confirmation typo (which leaves the server-side token untouched).
      if (err?.code && err.code !== "typed_confirmation_required") {
        queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sunbiz-bootstrap/record-class-repair/preview"] });
      }
    },
  });
  const bootstrapRunMutation = useMutation({
    mutationFn: async () => {
      // previewToken binds this run to the exact preview response the admin
      // is looking at (candidateCount + confirmationPhrase). It's single-use
      // and short-lived — if it's missing (preview hasn't loaded, or a prior
      // attempt already consumed it), re-fetch preview instead of running.
      const previewToken = bootstrapPreviewQuery.data?.previewToken;
      if (!previewToken) {
        const err: Error & { code?: string } = new Error("No active preview token — re-checking preview before you can run.");
        err.code = "no_active_preview_token";
        throw err;
      }
      try {
        const r = await apiRequest("POST", "/api/lead-ops/sunbiz-bootstrap/run", {
          limit: Number(bootstrapLimit),
          confirmation: bootstrapConfirmation,
          previewToken,
        });
        return await r.json();
      } catch (e) {
        // apiRequest() itself throws `Error(\`${status}: ${text}\`)` on any
        // non-OK response — it never returns the Response for us to inspect,
        // so the server's structured error code has to be recovered from the
        // thrown message via parseApiRequestError. The server only DELETES
        // the previewToken once limit+confirmation both validate (see
        // peekSunbizBootstrapPreviewToken in sunbiz-bootstrap.ts), so a
        // typed_confirmation_required rejection means the token is still
        // alive and reusable — onError uses this code to tell that apart
        // from a rejection that means the token is actually dead.
        const { code, reason } = parseApiRequestError(e instanceof Error ? e.message : String(e));
        const err: Error & { code?: string } = new Error(reason || (e instanceof Error ? e.message : String(e)));
        err.code = code;
        throw err;
      }
    },
    onSuccess: () => {
      setBootstrapConfirmation("");
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sunbiz-bootstrap/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sunbiz-bootstrap/status"] });
    },
    onError: (err: Error & { code?: string }) => {
      // Only force a fresh preview/token when THIS token is actually dead
      // (missing, expired, already consumed/reused, or minted for a
      // different limit) — never on typed_confirmation_required. A
      // confirmation typo leaves the server-side token untouched, so
      // refetching here would throw away a still-valid token and risk
      // showing the operator a changed candidate count just for correcting
      // a typo.
      if (err?.code && err.code !== "typed_confirmation_required") {
        queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sunbiz-bootstrap/preview"] });
      }
    },
  });

  const params = new URLSearchParams({
    limit: String(LIMIT),
    offset: String(offset),
    ...(search ? { search } : {}),
    ...(verticalFilter ? { vertical: verticalFilter } : {}),
    ...(emailStatusFilter ? { emailStatus: emailStatusFilter } : {}),
  });

  const { data, isLoading, isError, error } = useQuery<{ businesses: BusinessListItem[]; total: number }>({
    queryKey: ["/api/lead-ops/businesses", search, verticalFilter, emailStatusFilter, offset],
    queryFn: async () => {
      const r = await fetch(`/api/lead-ops/businesses?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    placeholderData: (prev) => prev,
  });

  const businesses = data?.businesses ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / LIMIT);
  const page = Math.floor(offset / LIMIT);

  // Mobile detection
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;

  return (
    <div className="space-y-4">
      {/* Detail panel removed — clicking a row navigates to /dashboard/lead-ops/business/:id */}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            placeholder="Search company or domain…"
            className="pl-9 h-9"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
            aria-label="Search businesses"
          />
        </div>
        <Select value={verticalFilter || "all"} onValueChange={(v) => { setVerticalFilter(v === "all" ? "" : v); setOffset(0); }}>
          <SelectTrigger className="w-44 h-9" aria-label="Filter by vertical">
            <SelectValue placeholder="All verticals" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All verticals</SelectItem>
            {verticals.map((v) => (
              <SelectItem key={v.vertical} value={v.vertical}>{v.vertical} ({v.count})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={emailStatusFilter} onValueChange={(v) => { setEmailStatusFilter(v === "all" ? "" : v); setOffset(0); }}>
          <SelectTrigger className="w-48 h-9" aria-label="Filter by email status">
            <SelectValue placeholder="All email statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All email statuses</SelectItem>
            <SelectItem value="provider_valid">Valid</SelectItem>
            <SelectItem value="provider_catch_all">Catch-all</SelectItem>
            <SelectItem value="provider_invalid">Invalid</SelectItem>
            <SelectItem value="discovered">Discovered</SelectItem>
            <SelectItem value="no_valid_candidate">No candidate</SelectItem>
          </SelectContent>
        </Select>
        <div className="text-sm text-muted-foreground ml-auto">
          {total.toLocaleString()} canonical businesses
        </div>
      </div>

      {/* Error */}
      {isError && (
        <div className="text-sm text-destructive flex items-center gap-2">
          <XCircle className="h-4 w-4" />
          {error instanceof Error ? error.message : "Failed to load businesses"}
        </div>
      )}

      {/* Mobile card list (≤768px) */}
      <div className="md:hidden space-y-3">
        {isLoading
          ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-lg" />)
          : businesses.length === 0
            ? <p className="text-sm text-muted-foreground py-8 text-center">No businesses match your filters.</p>
            : businesses.map((b) => (
                <MobileBusinessCard key={b.id} business={b} onTap={(biz) => navigateTo(`/dashboard/lead-ops/business/${biz.id}`)} />
              ))
        }
      </div>

      {/* Desktop table (>768px) */}
      <Card className="hidden md:block shadow-sm">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[800px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Legacy vertical / SFP v2</TableHead>
                  <TableHead>Email Status</TableHead>
                  <TableHead>Enrichment</TableHead>
                  <TableHead>Fit Tier</TableHead>
                  <TableHead>Field</TableHead>
                  <TableHead className="w-20">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: 8 }).map((_, j) => (
                          <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  : businesses.length === 0
                    ? (
                      <TableRow>
                        <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                          No businesses match your current filters.
                        </TableCell>
                      </TableRow>
                    )
                    : businesses.map((b) => (
                        <TableRow key={b.id} className="cursor-pointer hover:bg-muted/30" onClick={() => navigateTo(`/dashboard/lead-ops/business/${b.id}`)}>
                          <TableCell className="font-medium max-w-[200px]">
                            <Link href={`/dashboard/lead-ops/business/${b.id}`} onClick={(e) => e.stopPropagation()}
                              className="block truncate underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                              aria-label={`Open business ${b.canonical_name ?? b.id}`}>{b.canonical_name ?? `Business #${b.id}`}</Link>
                            {b.website_domain && (
                              <a
                                href={b.website_domain.startsWith("http") ? b.website_domain : `https://${b.website_domain}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-0.5 text-[10px] text-blue-500 hover:text-blue-700 truncate"
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`Open ${b.website_domain}`}
                              >
                                {b.website_domain}
                                <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                              </a>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {[b.city, b.state].filter(Boolean).join(", ") || "—"}
                          </TableCell>
                          <TableCell>
                            {b.vertical
                              ? <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">{b.vertical}</Badge>
                              : <span className="text-muted-foreground text-xs">—</span>
                            }
                            <div className="text-[10px] mt-1 max-w-[220px]" title={b.sfpClassification?.reasons?.join(", ")}>
                              {b.sfpClassification
                                ? <>SFP v2: {b.sfpClassification.vertical ?? b.sfpClassification.outcome} · {b.sfpClassification.state}</>
                                : <span className="text-muted-foreground">No current active-v2 evidence</span>}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <Badge
                                variant="outline"
                                className={`text-[10px] px-1.5 py-0 h-auto whitespace-normal ${
                                  b.email_discovery_status === "provider_valid" ? "bg-green-100 text-green-800" :
                                  b.email_discovery_status === "provider_catch_all" ? "bg-amber-100 text-amber-800" :
                                  b.email_discovery_status === "provider_invalid" ? "bg-red-100 text-red-800" :
                                  "bg-blue-100 text-blue-800"
                                }`}
                                aria-label={`Email: ${b.emailEvidenceDisplay?.statusLabel ?? "not started"}`}
                              >
                                {b.emailEvidenceDisplay?.statusLabel ?? "not started"}
                              </Badge>
                              {b.emailEvidenceDisplay && (
                                <div className="text-[10px] text-muted-foreground">
                                  {b.emailEvidenceDisplay.candidateCount} unvalidated email candidate(s)
                                  {b.emailEvidenceDisplay.maskedCandidateEmailPreview && (
                                    <span className="block font-mono">{b.emailEvidenceDisplay.maskedCandidateEmailPreview}</span>
                                  )}
                                  {b.emailEvidenceDisplay.selectedWinner && (
                                    <span className="block">Winner: {b.emailEvidenceDisplay.selectedWinner.state ?? "unknown"}</span>
                                  )}
                                  {b.emailEvidenceDisplay.validationIntent && (
                                    <span className="block">Validation: {b.emailEvidenceDisplay.validationIntent.state ?? "unknown"}</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {b.free_enrichment_status ? (
                              <Badge
                                variant="outline"
                                className={`text-[10px] px-1.5 py-0 h-5 ${
                                  b.free_enrichment_status === "enriched" ? "bg-green-100 text-green-800" :
                                  b.free_enrichment_status === "processing" ? "bg-blue-100 text-blue-800" :
                                  b.free_enrichment_status === "failed" ? "bg-red-100 text-red-800" :
                                  "bg-gray-100 text-gray-600"
                                }`}
                                aria-label={`Enrichment: ${b.free_enrichment_status}`}
                              >
                                {b.free_enrichment_status}
                              </Badge>
                            ) : <span className="text-muted-foreground text-xs">—</span>}
                          </TableCell>
                          <TableCell>
                            {b.fit_tier ? (
                              <Badge
                                variant="outline"
                                className={`text-[10px] px-1.5 py-0 h-5 font-bold ${
                                  b.fit_tier === "A" ? "bg-emerald-100 text-emerald-800" :
                                  b.fit_tier === "B" ? "bg-blue-100 text-blue-800" :
                                  "bg-amber-100 text-amber-700"
                                }`}
                                aria-label={`Fit tier ${b.fit_tier}`}
                              >
                                {b.fit_tier}
                              </Badge>
                            ) : <span className="text-muted-foreground text-xs">—</span>}
                          </TableCell>
                          <TableCell>
                            {b.field_claim_status === "claimed" ? (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-amber-50 text-amber-700" aria-label="Field claim active">
                                claimed
                              </Badge>
                            ) : <span className="text-muted-foreground text-xs">—</span>}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost" size="sm" className="h-7 text-xs"
                              onClick={(e) => { e.stopPropagation(); navigateTo(`/dashboard/lead-ops/business/${b.id}`); }}
                              aria-label={`View details for ${b.canonical_name}`}
                            >
                              View
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                }
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))} className="gap-1.5">
            <ChevronLeft className="h-4 w-4" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {page + 1} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)} className="gap-1.5">
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
      {userRole === "admin" && (
        <section aria-labelledby="business-tools-heading" className="space-y-4 border-t pt-6" data-testid="business-privileged-tools">
          <div>
            <h2 id="business-tools-heading" className="text-lg font-semibold">Privileged reconciliation and repair tools</h2>
            <p className="text-sm text-muted-foreground">Administrator-only. Opening this page runs none of them; each action needs its own confirmation.</p>
          </div>
      {userRole === "admin" && (
        <Card className="border-amber-200 dark:border-amber-900">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Sunbiz Bootstrap — bounded admin run</CardTitle>
            <CardDescription className="text-xs">
              Manual only. Preview is read-only; execution is capped at 25 and idempotent by filing number.
              This action is not scheduled.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs">Batch size
                <Input className="h-8 w-20 mt-1" type="number" min={1} max={25} value={bootstrapLimit}
                  onChange={(e) => setBootstrapLimit(String(Math.min(25, Math.max(1, Math.floor(Number(e.target.value) || 1)))))} />
              </label>
              <div className="text-xs text-muted-foreground">
                Would pull <strong>{bootstrapPreviewQuery.data?.candidateCount ?? "—"}</strong>;
                create {bootstrapPreviewQuery.data?.wouldCreate ?? "—"}, match {bootstrapPreviewQuery.data?.wouldMatchExisting ?? "—"},
                defer {bootstrapPreviewQuery.data?.wouldDefer ?? "—"}.
              </div>
            </div>
            {bootstrapPreviewQuery.data?.candidates?.length > 0 && (
              <div className="text-[11px] text-muted-foreground">
                Sample: {bootstrapPreviewQuery.data.candidates.slice(0, 5).map((c: any) => `${c.entityName} (${c.outcome})`).join(" · ")}
              </div>
            )}
            <div className="flex flex-wrap gap-2 items-end">
              <label className="text-xs flex-1 min-w-[240px]">Type confirmation
                <Input className="h-8 mt-1 font-mono" placeholder={`RUN SUNBIZ BOOTSTRAP ${bootstrapPreviewQuery.data?.candidateCount ?? "N"}`}
                  value={bootstrapConfirmation} onChange={(e) => setBootstrapConfirmation(e.target.value)} />
              </label>
              <Button size="sm" variant="outline"
                disabled={bootstrapRunMutation.isPending || !bootstrapPreviewQuery.data?.candidateCount || !bootstrapPreviewQuery.data?.previewToken}
                onClick={() => bootstrapRunMutation.mutate()}>
                {bootstrapRunMutation.isPending ? "Running…" : "Run bounded batch"}
              </Button>
            </div>
            {bootstrapRunMutation.error && <p className="text-xs text-red-600">{(bootstrapRunMutation.error as Error).message}</p>}
            {bootstrapStatusQuery.data && (
              <>
                <div className="text-[11px] text-muted-foreground">
                  Cursor entity #{bootstrapStatusQuery.data.cursor ?? "—"} · claimed {bootstrapStatusQuery.data.claimed ?? 0} ·
                  created {bootstrapStatusQuery.data.created ?? 0} · failed {bootstrapStatusQuery.data.failed ?? 0} ·
                  last completed {bootstrapStatusQuery.data.last_completed_at ? new Date(bootstrapStatusQuery.data.last_completed_at).toLocaleString() : "—"}.
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Recovery: failed claims are eligible for a later bounded rerun; successful claims are never duplicated.
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
      {userRole === "admin" && (
        <Card className="border-amber-200 dark:border-amber-900">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Sunbiz Full Backfill — resumable corpus scan</CardTitle>
            <CardDescription className="text-xs">
              Recurring worker tick (every 60s), disabled by default. Resume to let it advance through the
              whole hot/warm backlog in bounded microbatches; pause halts new batches (in-flight ones finish).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                backfillStatusQuery.data?.status === "running" ? "bg-green-100 text-green-800" :
                backfillStatusQuery.data?.status === "paused" ? "bg-amber-100 text-amber-800" :
                backfillStatusQuery.data?.status === "completed" ? "bg-blue-100 text-blue-800" :
                backfillStatusQuery.data?.status === "failed" ? "bg-red-100 text-red-800" :
                "bg-muted text-muted-foreground"
              }`}>
                {backfillStatusQuery.data?.status ?? "idle"}
              </span>
              {backfillStatusQuery.data?.status === "running" && backfillStatusQuery.data?.workerCapability?.active === false && (
                <span className="text-xs font-medium px-2 py-0.5 rounded bg-red-100 text-red-800" data-testid="badge-worker-capability-not-active">
                  WORKER_CAPABILITY_NOT_ACTIVE
                </span>
              )}
              {backfillStatusQuery.data?.status === "running" ? (
                <Button size="sm" variant="outline" disabled={backfillPauseMutation.isPending}
                  onClick={() => backfillPauseMutation.mutate()}>
                  {backfillPauseMutation.isPending ? "Pausing…" : "Pause"}
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={backfillResumeMutation.isPending}
                  onClick={() => backfillResumeMutation.mutate()}>
                  {backfillResumeMutation.isPending ? "Resuming…" : "Resume"}
                </Button>
              )}
            </div>
            {backfillStatusQuery.data?.status === "running" && backfillStatusQuery.data?.workerCapability?.active === false && (
              <div className="text-[11px] text-red-600">
                Marked running, but no worker can execute this queue right now (profile selects it: {String(backfillStatusQuery.data.workerCapability.selected)},
                queue manager ready: {String(backfillStatusQuery.data.workerCapability.queueManagerReady)},
                worker active: {String(backfillStatusQuery.data.workerCapability.workerActive)}). The corpus scan is NOT advancing —
                add <code>sunbiz-backfill</code> to <code>BACKGROUND_JOB_PROFILE=selective:...</code> and restart, or use <code>full</code>.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                backfillStatusQuery.data?.phase === "south_florida" ? "bg-sky-100 text-sky-800" :
                backfillStatusQuery.data?.phase === "remaining" ? "bg-indigo-100 text-indigo-800" :
                "bg-blue-100 text-blue-800"
              }`} data-testid="badge-backfill-phase">
                {backfillStatusQuery.data?.phase === "south_florida" ? "Pass 1/2: South Florida" :
                 backfillStatusQuery.data?.phase === "remaining" ? "Pass 2/2: Remaining universe" :
                 "Both passes complete"}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground" data-testid="text-backfill-soflo-lane">
              South Florida — cursor #{backfillStatusQuery.data?.southFlorida?.highWaterEntityId ?? 0} ·
              processed {backfillStatusQuery.data?.southFlorida?.processedCount ?? 0} ·
              dead-lettered {backfillStatusQuery.data?.southFlorida?.deadLetterCount ?? 0} ·
              remaining eligible ~{backfillStatusQuery.data?.southFlorida?.remainingEligible ?? "—"}.
            </div>
            <div className="text-[11px] text-muted-foreground" data-testid="text-backfill-remaining-lane">
              Remaining universe — cursor #{backfillStatusQuery.data?.remainingUniverse?.highWaterEntityId ?? 0} ·
              processed {backfillStatusQuery.data?.remainingUniverse?.processedCount ?? 0} ·
              dead-lettered {backfillStatusQuery.data?.remainingUniverse?.deadLetterCount ?? 0} ·
              remaining eligible ~{backfillStatusQuery.data?.remainingUniverse?.remainingEligible ?? "—"}.
            </div>
            <div className="text-[11px] text-muted-foreground">
              Total processed {backfillStatusQuery.data?.processedCount ?? 0} ·
              total dead-lettered {backfillStatusQuery.data?.deadLetterCount ?? 0} ·
              geography reference {backfillStatusQuery.data?.geographyReferenceVersion ?? "—"} ·
              last batch {backfillStatusQuery.data?.lastBatchAt ? new Date(backfillStatusQuery.data.lastBatchAt).toLocaleString() : "—"}.
            </div>
            {backfillStatusQuery.data?.lastError && (
              <div className="text-[11px] text-red-600">Last error: {backfillStatusQuery.data.lastError}</div>
            )}
          </CardContent>
        </Card>
      )}
      {userRole === "admin" && (
        <Card className="border-amber-200 dark:border-amber-900">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Sunbiz Record-Class Repair — one-time correction</CardTitle>
            <CardDescription className="text-xs">
              Fixes businesses created by the Sunbiz bootstrap before a defect was patched: they were left as
              "unknown" instead of "canonical", hiding them from Lead Ops, free enrichment, and MI-09. Preview
              is read-only. Safe to rerun — once the cohort is empty, this always reports 0 and there's nothing
              left to fix.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="text-xs text-muted-foreground">
              Affected businesses found: <strong>{recordClassRepairPreviewQuery.data?.cohortCount ?? "—"}</strong>
              {recordClassRepairPreviewQuery.isFetching && " (checking…)"}
            </div>
            {recordClassRepairPreviewQuery.data?.rows?.length > 0 && (
              <div className="text-[11px] text-muted-foreground">
                Sample: {recordClassRepairPreviewQuery.data.rows.slice(0, 5).map((r: any) => r.canonicalName).join(" · ")}
              </div>
            )}
            {recordClassRepairPreviewQuery.data?.cohortCount === 0 && (
              <div className="text-[11px] text-muted-foreground">Nothing to repair right now.</div>
            )}
            <div className="flex flex-wrap gap-2 items-end">
              <label className="text-xs flex-1 min-w-[240px]">Type confirmation
                <Input
                  className="h-8 mt-1 font-mono"
                  placeholder={recordClassRepairPreviewQuery.data?.confirmationPhrase ?? "REPAIR SUNBIZ RECORD CLASS N"}
                  value={recordClassRepairConfirmation}
                  onChange={(e) => setRecordClassRepairConfirmation(e.target.value)}
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  recordClassRepairRunMutation.isPending ||
                  !recordClassRepairPreviewQuery.data?.cohortCount ||
                  !recordClassRepairPreviewQuery.data?.previewToken
                }
                onClick={() => recordClassRepairRunMutation.mutate()}
              >
                {recordClassRepairRunMutation.isPending ? "Running…" : "Run repair"}
              </Button>
            </div>
            {recordClassRepairRunMutation.error && (
              <p className="text-xs text-red-600">{(recordClassRepairRunMutation.error as Error).message}</p>
            )}
            {recordClassRepairRunMutation.data && (
              <div className="text-[11px] text-muted-foreground">
                Repaired {recordClassRepairRunMutation.data.repairedCount} of{" "}
                {recordClassRepairRunMutation.data.attemptedCount} attempted.
              </div>
            )}
          </CardContent>
        </Card>
      )}
        </section>
      )}
    </div>
  );
}

const AREA_LABEL = {
  inventory: "Inventory", "sources-imports": "Sources & Imports", enrichment: "Enrichment",
  "qualification-staging": "Qualification & Staging", "program-health": "Program Health",
} as const;
/** First leaf opened by an area link. Canonical keeps its own view parameter. */
const AREA_ENTRY = {
  inventory: "businesses", "sources-imports": "prospects", enrichment: "canonical&canonicalView=pipeline",
  "qualification-staging": "staging", "program-health": "health",
} as const;

export default function LeadOpsCenter() {
  const { user } = useAuth();
  const { toast } = useToast();

  // ── Tab state (MI-08 + #1957 consolidation) ─────────────────────────────────
  const urlSearch = useSearch();
  const [, navigate] = useLocation();
  const VALID_TABS = ["businesses", "prospects", "imports", "staging", "sources", "census", "intelligence", "quality", "pipeline", "pilot", "health", "sfp", "provider-results", "canonical"] as const;
  const STAGING_SUBTABS = ["master-leads", "promotion-review"] as const;
  const tabFromUrl = (() => {
    const t = new URLSearchParams(urlSearch).get("tab");
    return t && (VALID_TABS as readonly string[]).includes(t) ? t : "businesses";
  })();
  const [activeTab, setActiveTabState] = useState(tabFromUrl);
  const areaTabs = prospectingAreaTabs[prospectingAreaForTab(activeTab)] as readonly string[];
  const inArea = (tab: string) => areaTabs.includes(tab);
  const stagingTabFromUrl = (() => {
    const t = new URLSearchParams(urlSearch).get("stagingTab");
    return t && (STAGING_SUBTABS as readonly string[]).includes(t) ? t : "master-leads";
  })();
  const [stagingTab, setStagingTab] = useState(stagingTabFromUrl);

  useEffect(() => {
    setActiveTabState(tabFromUrl);
    setStagingTab(stagingTabFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSearch]);

  // Typed context (contact/business/deal/source IDs, `from`) survives a tab change; stale list or paging state does not.
  // Each user choice is a pushed entry so Back/Forward restore the previous tab.
  const setActiveTab = (value: string) => {
    setActiveTabState(value);
    navigate(typedTabUrl("/dashboard/lead-ops", urlSearch, window.location.hash, { tab: value }));
  };

  const handleStagingTabChange = (value: string) => {
    setStagingTab(value);
    navigate(typedTabUrl("/dashboard/lead-ops", urlSearch, window.location.hash, { tab: "staging", stagingTab: value }));
  };

  // ── Filter / pagination state ──────────────────────────────────────────────
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [filterStatus,    setFilterStatus]    = useState("all");
  const [filterScore,     setFilterScore]     = useState("all");
  const [filterVertical,  setFilterVertical]  = useState("all");
  const [filterContactable, setFilterContactable] = useState(false);
  const [filterNoContact,   setFilterNoContact]   = useState(false);
  const [filterTag,         setFilterTag]         = useState("all");
  const LIMIT = 100;
  const [inboundPage, setInboundPage] = useState(0);
  const [inboundSourceClass, setInboundSourceClass] = useState("all");
  const [inboundLifecycle, setInboundLifecycle] = useState("all");
  const INBOUND_LIMIT = 25;

  // ── Selection state ────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ── AI analysis ───────────────────────────────────────────────────────────
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);
  const [showAI, setShowAI] = useState(false);

  // ── SERPER banner dismiss (session-only) ───────────────────────────────────
  const [serperBannerDismissed, setSerperBannerDismissed] = useState(false);

  // ── Queries ────────────────────────────────────────────────────────────────
  // Heavy readers belong to the selected child only: they load on entry, refresh on explicit action,
  // carry the cancellation signal and are keyed by actor. No background polling.
  const onPipeline = activeTab === "pipeline";
  const crmFetch = async (url: string, signal?: AbortSignal) => {
    const r = await fetch(url, { credentials: "include", signal });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };
  const statsQuery = useCrmQuery<LeadOpsStats>({
    queryKey: ["/api/lead-ops/stats"],
    queryFn: ({ signal }) => crmFetch("/api/lead-ops/stats", signal),
    enabled: onPipeline,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const healthQuery = useCrmQuery<LeadOpsHealth>({
    queryKey: ["/api/lead-ops/health"],
    queryFn: ({ signal }) => crmFetch("/api/lead-ops/health", signal),
    enabled: onPipeline,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const freeLaneHealthQuery = useCrmQuery<any>({
    queryKey: ["/api/lead-ops/enrichment-program-health"],
    queryFn: ({ signal }) => crmFetch("/api/lead-ops/enrichment-program-health", signal),
    enabled: onPipeline,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const configQuery = useQuery<LeadOpsConfig>({
    queryKey: ["/api/lead-ops/config"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/config", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const entitiesParams = new URLSearchParams({
    page: String(page), limit: String(LIMIT),
    ...(filterStatus   !== "all" ? { status:  filterStatus   } : {}),
    ...(filterScore    !== "all" ? { score:   filterScore    } : {}),
    ...(filterVertical !== "all" ? { vertical: filterVertical } : {}),
    ...(filterContactable ? { contactable: "true" } : {}),
    ...(filterNoContact   ? { noContact:   "true" } : {}),
    ...(filterTag !== "all" ? { tag: filterTag } : {}),
    ...(search ? { search } : {}),
  });

  const entitiesQuery = useCrmQuery<{ data: LeadEntity[]; total: number; page: number; limit: number }>({
    queryKey: ["/api/lead-ops/entities", page, filterStatus, filterScore, filterVertical, filterContactable, filterNoContact, filterTag, search],
    queryFn: ({ signal }) => crmFetch(`/api/lead-ops/entities?${entitiesParams}`, signal),
    enabled: onPipeline,
  });

  const entities = entitiesQuery.data?.data || [];
  const total    = entitiesQuery.data?.total || 0;
  const totalPages = Math.ceil(total / LIMIT);

  const inboundParams = new URLSearchParams({
    limit: String(INBOUND_LIMIT),
    offset: String(inboundPage * INBOUND_LIMIT),
    ...(inboundSourceClass !== "all" ? { sourceClass: inboundSourceClass } : {}),
    ...(inboundLifecycle !== "all" ? { lifecycleState: inboundLifecycle } : {}),
  });
  const inboundRequestsQuery = useCrmQuery<InboundRequest[]>({
    queryKey: ["/api/lead-ops/inbound-requests", inboundPage, inboundSourceClass, inboundLifecycle],
    queryFn: ({ signal }) => crmFetch(`/api/lead-ops/inbound-requests?${inboundParams}`, signal),
    enabled: onPipeline,
  });
  const inboundRequests = inboundRequestsQuery.data || [];

  const stagingCountsQuery = useCrmQuery<Record<string, number>>({
    queryKey: ["/api/lead-ops/staging-counts"],
    queryFn: ({ signal }) => crmFetch("/api/lead-ops/staging-counts", signal),
    enabled: activeTab === "staging",
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  // NOTE: legacy bulk/single-row enrichment mutation removed — CRO-03 provider
  // transport is disabled, so it always threw. Both entry points (the bulk
  // "Enrich Selected" action and the per-row re-enrich button) are now
  // unconditionally disabled instead (#1957).

  const aiSegmentMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/lead-ops/ai-segment", { sampleSize: 150 });
      return r.json();
    },
    onSuccess: (data: AiAnalysis) => {
      setAiAnalysis(data);
      setShowAI(true);
    },
    onError: (e: Error) => toast({ title: "AI analysis failed", description: e.message, variant: "destructive" }),
  });

  const writebackMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/lead-ops/run-writeback", { limit: 2000 });
      return r.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Owner data synced", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/stats"] });
    },
    onError: (e: Error) => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  const clearSlaMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/lead-ops/clear-sla-tasks", {});
      return r.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "SLA tasks cleared", description: data.message });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const resetJobsMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/lead-ops/reset-stuck-jobs", {});
      return r.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Queue reset", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/health"] });
    },
    onError: (e: Error) => toast({ title: "Reset failed", description: e.message, variant: "destructive" }),
  });

  const convertToProspectsMutation = useMutation({
    mutationFn: async (entityIds: number[]) => {
      const r = await apiRequest("POST", "/api/sunbiz/convert-batch", { entityIds });
      return r.json();
    },
    onSuccess: (data: { converted: number }) => {
      toast({ title: "Converted", description: `${data.converted} entities pushed to Source Prospects.` });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/entities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prospects"] });
      setSelectedIds(new Set());
    },
    onError: (e: Error) => toast({ title: "Conversion failed", description: e.message, variant: "destructive" }),
  });

  // ── Selection helpers ──────────────────────────────────────────────────────
  const allPageSelected = entities.length > 0 && entities.every(e => selectedIds.has(e.id));
  const someSelected    = selectedIds.size > 0;

  const toggleAll = useCallback(() => {
    if (allPageSelected) {
      setSelectedIds(prev => { const next = new Set(prev); entities.forEach(e => next.delete(e.id)); return next; });
    } else {
      setSelectedIds(prev => { const next = new Set(prev); entities.forEach(e => next.add(e.id)); return next; });
    }
  }, [entities, allPageSelected]);

  const toggleOne = useCallback((id: number) => {
    setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }, []);

  const stats = statsQuery.data;

  // ── Stat cards ─────────────────────────────────────────────────────────────
  const statCards = [
    { label: "Total Leads",        value: stats?.total?.toLocaleString()                     || "—", icon: Users,       color: "text-gray-700 dark:text-gray-300" },
    { label: "Processing Done",    value: stats?.processing_completed?.toLocaleString()      || "—", icon: CheckCircle,  color: "text-green-600 dark:text-green-400" },
    { label: "Awaiting Processing",value: stats?.pending_processing?.toLocaleString()        || "—", icon: Clock,        color: "text-yellow-600 dark:text-yellow-400" },
    { label: "Email Inventory",    value: stats?.current_email_inventory?.toLocaleString()   || "—", icon: Mail,         color: "text-blue-600 dark:text-blue-400" },
    { label: "Phone Inventory",    value: stats?.current_phone_inventory?.toLocaleString()   || "—", icon: Phone,        color: "text-indigo-600 dark:text-indigo-400" },
    { label: "Hot Leads",          value: stats?.hot?.toLocaleString()                       || "—", icon: TrendingUp,   color: "text-red-600 dark:text-red-400" },
  ];

  const health = healthQuery.data;
  const config = configQuery.data;
  const showSerperBanner = !serperBannerDismissed && config !== undefined && !config.serperConfigured;

  return (
    <div className="space-y-6 pb-12">

      {/* ── SERPER key warning banner ─────────────────────────────────────── */}
      {showSerperBanner && (
        <div className="relative flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-4 py-3">
          <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Google search steps are disabled — email discovery rate is near 0
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              Add <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded font-mono">SERPER_API_KEY</code> in{" "}
              <a
                href="https://docs.replit.com/replit-workspace/workspace-features/secrets"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Replit Secrets
              </a>{" "}
              to unlock 13 enrichment steps and dramatically improve email discovery.
            </p>
          </div>
          <button
            onClick={() => setSerperBannerDismissed(true)}
            className="shrink-0 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lead Operations Center</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Enrich, segment, and route your entire lead pool — no code required.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline" size="sm"
            onClick={() => writebackMutation.mutate()}
            disabled={writebackMutation.isPending}
            className="gap-1.5"
          >
            {writebackMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sync Owner Data
          </Button>

          {user?.role === "admin" && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear SLA Flood
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear stuck SLA tasks?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will resolve all pending "SLA Alert" tasks for leads that have no email and no phone — contacts that can't be reached yet. They'll be re-created automatically once enrichment adds contact data.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-600 hover:bg-red-700"
                    onClick={() => clearSlaMutation.mutate()}
                  >
                    Clear Tasks
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* ── Five Prospecting areas; the leaf tabs below are the secondary selector for the current area ── */}
      <CrmAreaNav
        current={`/dashboard/lead-ops?tab=${AREA_ENTRY[prospectingAreaForTab(activeTab)]}`}
        entries={prospectingAreas.map(area => ({
          label: AREA_LABEL[area],
          href: `/dashboard/lead-ops?tab=${AREA_ENTRY[area]}`,
          allowed: true,
        }))}
      />

      {/* ── MI-08: Unified Lead Ops Workspace Tabs ───────────────────────────── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        {/* inArea: leaf tabs shown for the active area. Hidden tabs stay valid compatibility URLs. */}
        <TabsList className="flex-wrap h-auto gap-1" aria-label="Lead Ops workspace tabs">
          <TabsTrigger value="businesses" className={inArea("businesses") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <Building2 className="h-4 w-4" aria-hidden /> Businesses
          </TabsTrigger>
          <TabsTrigger value="prospects" className={inArea("prospects") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <Layers className="h-4 w-4" aria-hidden /> Source Prospects
          </TabsTrigger>
          <TabsTrigger value="imports" className={inArea("imports") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <GitBranch className="h-4 w-4" aria-hidden /> Imports
          </TabsTrigger>
          <TabsTrigger value="staging" className={inArea("staging") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <GitBranch className="h-4 w-4" aria-hidden /> Staging &amp; Promotion
          </TabsTrigger>
          <TabsTrigger value="sources" className={inArea("sources") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <Layers className="h-4 w-4" aria-hidden /> Sources
          </TabsTrigger>
          <TabsTrigger value="census" className={inArea("census") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <BarChart3 className="h-4 w-4" aria-hidden /> Census
          </TabsTrigger>
          <TabsTrigger value="intelligence" className={inArea("intelligence") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <BarChart3 className="h-4 w-4" aria-hidden /> Intelligence
          </TabsTrigger>
          <TabsTrigger value="quality" className={inArea("quality") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <HeartPulse className="h-4 w-4" aria-hidden /> Data Quality
          </TabsTrigger>
          <TabsTrigger value="pipeline" className={inArea("pipeline") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <TrendingUp className="h-4 w-4" aria-hidden /> Inbound Operations
          </TabsTrigger>
          <TabsTrigger value="sfp" className={inArea("sfp") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <MapPin className="h-4 w-4" aria-hidden /> South Florida Prospecting
          </TabsTrigger>
          <TabsTrigger value="provider-results" className={inArea("provider-results") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <Activity className="h-4 w-4" aria-hidden /> Provider Results
          </TabsTrigger>
          <TabsTrigger value="pilot" className={inArea("pilot") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            Pilot history (read-only)
          </TabsTrigger>
          <TabsTrigger value="health" className={inArea("health") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <HeartPulse className="h-4 w-4" aria-hidden /> Enrichment Program Health
          </TabsTrigger>
          <TabsTrigger value="canonical" className={inArea("canonical") ? "gap-1.5 min-h-[44px] text-sm" : "hidden"}>
            <GitBranch className="h-4 w-4" aria-hidden /> Canonical Enrichment
          </TabsTrigger>
        </TabsList>

        <TabsContent value="canonical" className="space-y-4">
          <CanonicalEnrichment embedded />
        </TabsContent>

        <TabsContent value="prospects" className="space-y-4">
          <Prospects />
        </TabsContent>

        <TabsContent value="imports" className="space-y-4">
          <LeadImports />
        </TabsContent>

        {/* ── Businesses tab ─────────────────────────────────────────────── */}
        <TabsContent value="businesses" className="space-y-4">
          <BusinessesTab userRole={user?.role ?? "agent"} />
          {user?.role === "admin" && <BusinessAdminContext renderReconciliation={(contactId) => <ContactBusinessReconciliationPanel contactId={contactId} />} />}
        </TabsContent>

        {/* ── Staging & Promotion tab: Master Leads (all-origin inventory) vs
             Promotion Review (MI-07 controlled-cohort pipeline), split per #1957 ── */}
        <TabsContent value="staging" className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Pipeline staging inventory</CardTitle>
              <CardDescription className="text-xs">
                Server-derived counts. Promotion remains a separate, explicit admin action.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                {[
                  ["Pending", "pending"],
                  ["Staged", "staged"],
                  ["Duplicate", "duplicate"],
                  ["Suppressed", "suppressed"],
                  ["Failed", "failed"],
                  ["Promoted", "promoted"],
                ].map(([label, key]) => (
                  <div key={key} className="rounded border px-3 py-2">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="text-lg font-semibold">{stagingCountsQuery.data?.[key] ?? "—"}</div>
                  </div>
                ))}
              </div>
              {stagingCountsQuery.isError && (
                <div className="text-xs text-red-600 mt-2">Unable to load staging counts: {(stagingCountsQuery.error as Error).message}</div>
              )}
            </CardContent>
          </Card>
          <Tabs
            value={user?.role === "admin" ? stagingTab : "promotion-review"}
            onValueChange={handleStagingTabChange}
          >
            <TabsList>
              {/* Master Leads (the raw master_leads inventory, including CSV export and
                  Backfill Existing Contacts) was admin-only at its old standalone route
                  (/dashboard/master-lead-database). Lead Ops itself is reachable by
                  managers too, so this subtab stays admin-only here to avoid handing
                  managers a client UI for admin-gated server routes (#1957). */}
              {user?.role === "admin" && (
                <TabsTrigger value="master-leads" data-testid="tab-master-leads">Master Leads</TabsTrigger>
              )}
              <TabsTrigger value="promotion-review" data-testid="tab-promotion-review">Promotion Review</TabsTrigger>
            </TabsList>
            {user?.role === "admin" && (
              <TabsContent value="master-leads" className="space-y-4 mt-4">
                <MasterLeadDatabase />
              </TabsContent>
            )}
            <TabsContent value="promotion-review" className="space-y-4 mt-4">
              <PipelineReviewTab />
            </TabsContent>
          </Tabs>
        </TabsContent>

        {/* ── Sources tab ────────────────────────────────────────────────── */}
        <TabsContent value="sources" className="space-y-4">
          {user?.role === "admin" ? (
            /* Admin: full import controls + registry panel */
            <SourceRegistryPanel />
          ) : (
            /* Manager: read-only counts. SourceRegistryPanel hits /api/admin/source-registry
               which is admin-only and returns 403 for managers. Show a safe summary instead. */
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-blue-600" aria-hidden />
                  <CardTitle className="text-sm">Source Registry (read-only)</CardTitle>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">Manager view</Badge>
                </div>
                <CardDescription className="text-xs">
                  Import controls are restricted to admins. You can view pipeline counts in the Health tab.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                  {[
                    ["Canonical businesses", health?.sourceRegistryCounts?.canonicalBusinesses],
                    ["Source links", health?.sourceRegistryCounts?.sourceLinks],
                    ["Adapters", health?.sourceRegistryCounts?.adapters],
                  ].map(([label, metric]) => (
                    <div key={label as string} className="rounded-md border bg-muted/10 px-3 py-2">
                      <div className="text-xs text-muted-foreground">{label as string}</div>
                      <div className="text-lg font-semibold">
                        {(metric as HealthMetric | undefined)?.available
                          ? Number((metric as HealthMetric).value ?? 0).toLocaleString()
                          : "unknown"}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 text-amber-500" aria-hidden />
                  Contact an admin to import or configure data sources.
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Census tab ─────────────────────────────────────────────────── */}
        <TabsContent value="census" className="space-y-4">
          <SouthFloridaQualificationPanel />
        </TabsContent>

        {/* ── Intelligence tab ──────────────────────────────────────────── */}
        <TabsContent value="intelligence" className="space-y-4">
          <LeadIntelligence />
        </TabsContent>

        {/* ── Data Quality tab ──────────────────────────────────────────── */}
        <TabsContent value="quality" className="space-y-4">
          <DataQuality />
        </TabsContent>

        {/* ── Pipeline tab (enrichment queue + AI + entity table) ─────────── */}
        <TabsContent value="pipeline" className="space-y-6">
          {/* Inbound request operations */}
          {/* ── Inbound request operations ─────────────────────────────── */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-base">Inbound Request Operations</CardTitle>
              <CardDescription className="text-xs mt-1">
                Bounded operational view of governed inbound receipts and their canonical work links.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 shrink-0"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/inbound-requests"] })}
              disabled={inboundRequestsQuery.isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${inboundRequestsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Select value={inboundSourceClass} onValueChange={(value) => { setInboundSourceClass(value); setInboundPage(0); }}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="All source classes" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All source classes</SelectItem>
                <SelectItem value="sales_request">Sales request</SelectItem>
                <SelectItem value="support_request">Support request</SelectItem>
                <SelectItem value="fulfillment_request">Fulfillment request</SelectItem>
                <SelectItem value="content_reputation">Content &amp; reputation</SelectItem>
                <SelectItem value="marketing_opt_in">Marketing opt-in</SelectItem>
                <SelectItem value="imported_provider_event">Imported provider event</SelectItem>
              </SelectContent>
            </Select>
            <Select value={inboundLifecycle} onValueChange={(value) => { setInboundLifecycle(value); setInboundPage(0); }}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="All lifecycle states" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All lifecycle states</SelectItem>
                <SelectItem value="claimed">Claimed</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="accepted">Accepted</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="review_required">Review required</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {inboundRequestsQuery.isError ? (
            <div className="px-6 py-8 text-sm text-destructive">
              Unable to load inbound requests. {inboundRequestsQuery.error instanceof Error ? inboundRequestsQuery.error.message : ""}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[1300px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Source / received</TableHead>
                    <TableHead>Opaque receipt</TableHead>
                    <TableHead>Assignment</TableHead>
                    <TableHead>SLA due</TableHead>
                    <TableHead>Lifecycle / effect truth</TableHead>
                    <TableHead>Terminal reason (redacted)</TableHead>
                    <TableHead>Canonical links</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inboundRequestsQuery.isLoading
                    ? Array.from({ length: 5 }).map((_, index) => (
                      <TableRow key={index}>
                        {Array.from({ length: 7 }).map((__, cell) => <TableCell key={cell}><Skeleton className="h-4 w-full" /></TableCell>)}
                      </TableRow>
                    ))
                    : inboundRequests.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                          No inbound requests match the current filters.
                        </TableCell>
                      </TableRow>
                    ) : inboundRequests.map((request) => (
                      <TableRow key={request.requestReceipt}>
                        <TableCell className="text-xs">
                          <div className="font-medium">{request.sourceClass}</div>
                          <div className="text-muted-foreground">{request.sourceCategory} / {request.sourceType}</div>
                          <div className="text-muted-foreground mt-1">{formatInboundDate(request.createdAt)}</div>
                        </TableCell>
                        <TableCell className="max-w-[190px] font-mono text-[11px] break-all">{request.requestReceipt}</TableCell>
                        <TableCell className="text-xs">
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 ${inboundStatusBadge(request.assignmentStatus)}`}>
                            {request.assignmentStatus}
                          </Badge>
                          {(request.assignedTo || request.assignmentReason) && (
                            <div className="text-muted-foreground mt-1 max-w-[180px] break-words">
                              {request.assignedTo || request.assignmentReason}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{formatInboundDate(request.slaDueAt)}</TableCell>
                        <TableCell className="text-xs space-y-1">
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 ${inboundStatusBadge(request.lifecycleState)}`}>
                            {request.lifecycleState}
                          </Badge>
                          <div className="space-y-1 pt-0.5">
                            {request.effects.length === 0 ? (
                              <div className="text-muted-foreground">No effects reported</div>
                            ) : request.effects.map((effect) => (
                              <div key={effect.effectKey} className="flex flex-wrap items-center gap-1 text-[10px]">
                                <span className="text-muted-foreground">{effect.effectKey}</span>
                                <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 ${inboundStatusBadge(effect.state)}`}>
                                  {effect.state}
                                </Badge>
                                {effect.externalSideEffect && <span className="text-muted-foreground">(external effect)</span>}
                                {effect.terminalReason && <span className="text-muted-foreground">{effect.terminalReason}</span>}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[220px] text-xs text-muted-foreground break-words">
                          {request.terminalReason || "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-col items-start gap-1">
                            {request.contactId && <a className="text-blue-600 hover:underline" href={`/dashboard/contacts/${request.contactId}`}>Contact #{request.contactId}</a>}
                            {request.dealId && <a className="text-blue-600 hover:underline" href="/dashboard/pipeline">Deal #{request.dealId}</a>}
                            {request.ticketId && <a className="text-blue-600 hover:underline" href="/dashboard/tickets">Ticket #{request.ticketId}</a>}
                            {!request.contactId && !request.dealId && !request.ticketId && <span className="text-muted-foreground">—</span>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  }
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
        <div className="flex items-center justify-between border-t px-6 py-3">
          <span className="text-xs text-muted-foreground">
            {inboundRequestsQuery.isLoading ? "Loading receipts…" : `Page ${inboundPage + 1} · up to ${INBOUND_LIMIT} receipts`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={inboundPage === 0 || inboundRequestsQuery.isFetching} onClick={() => setInboundPage((page) => page - 1)}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={inboundRequests.length < INBOUND_LIMIT || inboundRequestsQuery.isFetching} onClick={() => setInboundPage((page) => page + 1)}>
              Next <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCards.map((s) => (
          <Card key={s.label} className="border shadow-sm">
            <CardContent className="p-3.5">
              <div className="flex items-center gap-2 mb-1">
                <s.icon className={`h-3.5 w-3.5 ${s.color}`} />
                <span className="text-xs text-muted-foreground">{s.label}</span>
              </div>
              {statsQuery.isLoading
                ? <Skeleton className="h-7 w-16" />
                : <div className="text-xl font-bold">{s.value}</div>
              }
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Pipeline Health widget ───────────────────────────────────────── */}
      <Card id="pipeline-health-card" className="border shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <CardTitle className="text-sm">Pipeline Health</CardTitle>
              {healthQuery.isLoading
                ? <Skeleton className="h-4 w-20" />
                : health
                  ? health.workerActive
                    ? (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-green-600 dark:text-green-400">
                        <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                        Live
                      </span>
                    )
                    : (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        <span className="h-2 w-2 rounded-full bg-amber-500" />
                        {health.minutesSinceLastJob !== null
                          ? `Idle ${health.minutesSinceLastJob}m`
                          : "No activity yet"}
                      </span>
                    )
                  : null
              }
            </div>
            <span className="text-[10px] text-muted-foreground">
              Auto-refreshes every 2m
            </span>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {healthQuery.isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-lg" />
              ))}
            </div>
          ) : health ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {[
                { label: "Source entities enriched today (raw Sunbiz)",    metric: health.enrichedToday,    icon: CheckCircle, color: "text-green-600 dark:text-green-400" },
                { label: "Email results today (raw attempts/results)", metric: health.emailsToday,     icon: Mail,        color: "text-blue-600 dark:text-blue-400" },
                { label: "Phone results today (raw attempts/results)", metric: health.phonesToday,     icon: Phone,       color: "text-indigo-600 dark:text-indigo-400" },
                { label: "Queue Depth",        metric: health.queueDepth,      icon: Clock,       color: "text-yellow-600 dark:text-yellow-400" },
                { label: "Success Rate",       metric: health.successRate,      icon: TrendingUp,  color: "text-emerald-600 dark:text-emerald-400" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <s.icon className={`h-3.5 w-3.5 ${s.color}`} />
                    <span className="text-[11px] text-muted-foreground">{s.label}</span>
                  </div>
                  <div className="text-lg font-bold">
                    {s.metric.available && s.metric.value !== null
                      ? `${s.metric.value}${s.label === "Success Rate" ? "%" : ""}`
                      : "unknown"}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-destructive" role="alert">Health data could not be loaded. Counters are unknown, not zero.</p>
          )}
          {/* ── Worker-authority truth fields (MI-01) ───────────────────── */}
          {health && (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-muted-foreground mb-0.5">Intake Authority</div>
                <div className={`font-medium truncate ${
                  health.intakeAuthority === "none"
                    ? "text-muted-foreground"
                    : health.intakeAuthority === "both"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-green-700 dark:text-green-400"
                }`}>
                  {health.intakeAuthority === "scheduled-sunbiz-pipeline" ? "Scheduled pipeline"
                   : health.intakeAuthority === "legacy-outreach-cycle" ? "Legacy outreach cycle"
                   : health.intakeAuthority === "both" ? "Both (scheduled + legacy)"
                   : "None"}
                </div>
              </div>
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-muted-foreground mb-0.5">Enrichment State</div>
                <div className={`font-medium truncate ${
                  health.enrichmentProgressStatus === "interrupted" || health.enrichmentProgressStatus === "failed"
                    ? "text-amber-600 dark:text-amber-400"
                    : health.enrichmentProgressStatus === "running"
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-green-700 dark:text-green-400"
                }`}>
                  {health.enrichmentProgressStatus}
                </div>
              </div>
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-muted-foreground mb-0.5">Sunbiz Gate</div>
                <div className={`font-medium ${health.sunbizEnrichmentEnabled ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}`}>
                  {health.sunbizEnrichmentEnabled ? "Enabled" : "Disabled"}
                </div>
              </div>
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-muted-foreground mb-0.5">Free Enrich Pending</div>
                <div className="font-medium">{health.freeEnrichmentPendingJobs.toLocaleString()}</div>
              </div>
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-muted-foreground mb-0.5">Last Scheduled Run</div>
                <div className="font-medium truncate">
                  {health.lastScheduledEnrichmentAt
                    ? new Date(health.lastScheduledEnrichmentAt).toLocaleTimeString()
                    : "Never"}
                </div>
              </div>
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-muted-foreground mb-0.5">Legacy Trigger Hits</div>
                <div className={`font-medium ${health.legacyRouteAttemptsSinceStartup > 0 ? "text-amber-600 dark:text-amber-400" : ""}`}>
                  {health.legacyRouteAttemptsSinceStartup} since restart
                </div>
              </div>
              {/* MI-04: Canonical free enrichment queue depth */}
              {typeof health.canonicalFreeEnrichmentQueueDepth === "number" && (
                <div className="rounded-md border bg-muted/10 px-3 py-2">
                  <div className="text-muted-foreground mb-0.5">Canonical Free Enrich Queue</div>
                  <div className="font-medium">
                    {health.canonicalFreeEnrichmentQueueDepth.toLocaleString()} pending
                  </div>
                </div>
              )}
            </div>
          )}
          {freeLaneHealthQuery.data && (
            <div className="mt-3 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20 px-3 py-2 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Free-only enrichment lane</span>
                <Badge variant="outline" className="text-[10px]">{freeLaneHealthQuery.data.status}</Badge>
              </div>
              <div className="text-muted-foreground mt-1">
                Capability: {freeLaneHealthQuery.data.capabilityGroup} · configured: {String(freeLaneHealthQuery.data.configured)} ·
                running: {String(freeLaneHealthQuery.data.running)} · examined: {freeLaneHealthQuery.data.examined} ·
                enriched: {freeLaneHealthQuery.data.enriched} · skipped: {freeLaneHealthQuery.data.skipped} ·
                failed: {freeLaneHealthQuery.data.failed} · pending: {freeLaneHealthQuery.data.pending}
              </div>
              <div className="text-muted-foreground">Last run: {freeLaneHealthQuery.data.lastRunAt ? new Date(freeLaneHealthQuery.data.lastRunAt).toLocaleString() : "—"} · next run: manual/pilot only</div>
            </div>
          )}
          {health && !health.workerActive && health.minutesSinceLastJob !== null && health.minutesSinceLastJob >= 15 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 dark:text-amber-400">
                No enrichment jobs have completed in the last {health.minutesSinceLastJob} minutes.
                The worker may be stalled — use "Reset Stuck Queue Jobs" below if this persists.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Admin Controls card ───────────────────────────────────────────── */}
      {user?.role === "admin" && (
        <Card className="border border-dashed border-muted-foreground/30">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm text-muted-foreground">Admin Controls</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Pipeline maintenance operations — use with care.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0 flex flex-wrap gap-3">

            {/* Reset stuck queue jobs */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={resetJobsMutation.isPending}
                >
                  {resetJobsMutation.isPending
                    ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    : <RotateCcw className="h-3.5 w-3.5" />
                  }
                  Reset Stuck Queue Jobs
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset stuck enrichment jobs?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This resets any sunbiz entities that have been stuck in "processing" state
                    for more than 30 minutes back to "pending", so the enrichment worker can
                    pick them up again on its next tick. Use this if enrichment appears stalled
                    after a worker crash or restart. No other queue jobs are affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => resetJobsMutation.mutate()}>
                    Reset Jobs
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {/* Download enrichment report */}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                const a = document.createElement("a");
                a.href = "/api/lead-ops/export-enriched";
                a.download = `enriched-leads-${new Date().toISOString().slice(0, 10)}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                toast({ title: "Download started", description: "Your enrichment report CSV is being prepared." });
              }}
            >
              <Download className="h-3.5 w-3.5" />
              Download Enrichment Report
            </Button>

          </CardContent>
        </Card>
      )}

      {/* ── MI-04: Canonical Business Free Enrichment ────────────────────── */}
      <CanonicalBusinessPanel healthQueueDepth={typeof health?.canonicalFreeEnrichmentQueueDepth === "number" ? health.canonicalFreeEnrichmentQueueDepth : null} />

      {/* ── Enrichment Queue Management ──────────────────────────────────── */}
      <EnrichmentQueuePanel />

      {/* ── AI Intelligence Panel ─────────────────────────────────────────── */}
      <Card className="border-2 border-dashed border-purple-200 dark:border-purple-800 bg-purple-50/40 dark:bg-purple-950/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-purple-600 dark:text-purple-400" />
              <div>
                <CardTitle className="text-base">AI Lead Intelligence</CardTitle>
                <CardDescription className="text-xs">
                  GPT-powered analysis of your lead pool — segments, outreach strategy, and quick wins.
                </CardDescription>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Button
                size="sm"
                onClick={() => aiSegmentMutation.mutate()}
                disabled={aiSegmentMutation.isPending}
                className="gap-2 bg-purple-600 hover:bg-purple-700 text-white"
                title="Returns a narrative over a random sample. Does not enrich, qualify, or write any records."
              >
                {aiSegmentMutation.isPending
                  ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  : <Sparkles className="h-3.5 w-3.5" />
                }
                {aiAnalysis ? "Re-analyze" : "Analyze My Lead Pool"}
              </Button>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-purple-300 text-purple-600 dark:border-purple-700 dark:text-purple-400">
                Diagnostic only
              </Badge>
            </div>
          </div>
        </CardHeader>

        {showAI && aiAnalysis && (
          <CardContent className="pt-0 space-y-5">
            {/* Executive summary */}
            <div className="bg-white dark:bg-gray-900 rounded-lg p-4 border border-purple-200 dark:border-purple-800">
              <p className="text-sm leading-relaxed">{aiAnalysis.summary}</p>
            </div>

            {/* Segments + recommendations grid */}
            <div className="grid md:grid-cols-2 gap-4">
              {/* Priority segments */}
              {aiAnalysis.segments.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                    <Target className="h-4 w-4 text-purple-600" />
                    Priority Segments
                  </h3>
                  <div className="space-y-2">
                    {aiAnalysis.segments.slice(0, 5).map((seg, i) => (
                      <div key={i} className="bg-white dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700 flex items-start gap-2.5">
                        <div className="text-xs font-bold text-muted-foreground mt-0.5 w-4 shrink-0">#{i + 1}</div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium truncate">{seg.name}</span>
                            {seg.score && <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 ${scoreBadge(seg.score)}`}>{seg.score}</Badge>}
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                              {seg.channel}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{seg.angle}</p>
                          {seg.estimatedCount > 0 && (
                            <p className="text-xs text-purple-600 dark:text-purple-400 mt-0.5">
                              ~{seg.estimatedCount.toLocaleString()} leads
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recommendations */}
              <div className="space-y-4">
                {aiAnalysis.recommendations.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                      <Zap className="h-4 w-4 text-amber-500" />
                      Do This Today
                    </h3>
                    <div className="space-y-1.5">
                      {aiAnalysis.recommendations.map((rec, i) => (
                        <div key={i} className="bg-white dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700 flex items-start gap-2">
                          <ArrowRight className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                          <p className="text-xs leading-relaxed">{rec}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {aiAnalysis.quickWins.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold mb-2">⚡ Quick Wins (&lt;30 min)</h3>
                    <div className="space-y-1.5">
                      {aiAnalysis.quickWins.map((win, i) => (
                        <div key={i} className="text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 rounded px-3 py-2 border border-amber-200 dark:border-amber-800">
                          {win}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Outreach priority */}
            {aiAnalysis.outreachPriority.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Outreach Priority by Vertical</h3>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {aiAnalysis.outreachPriority.map((op, i) => (
                    <div key={i} className="bg-white dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                      <div className="font-medium text-sm">{op.vertical}</div>
                      <div className="text-lg font-bold text-green-600 dark:text-green-400">{op.estimatedCloseRate}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{op.whyNow}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* ── Filters + bulk actions toolbar ───────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search company, owner, email…"
            className="pl-9 h-9"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
        </div>

        <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setPage(0); }}>
          <SelectTrigger className="w-36 h-9">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="enriched">Enriched</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterScore} onValueChange={(v) => { setFilterScore(v); setPage(0); }}>
          <SelectTrigger className="w-32 h-9">
            <SelectValue placeholder="All scores" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scores</SelectItem>
            <SelectItem value="hot">Hot</SelectItem>
            <SelectItem value="warm">Warm</SelectItem>
            <SelectItem value="cold">Cold</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterVertical} onValueChange={(v) => { setFilterVertical(v); setPage(0); }}>
          <SelectTrigger className="w-40 h-9">
            <SelectValue placeholder="All verticals" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All verticals</SelectItem>
            {(stats?.verticals || []).slice(0, 20).map((v: any) => (
              <SelectItem key={v.vertical} value={v.vertical}>{v.vertical} ({v.count})</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={filterContactable ? "default" : "outline"}
          size="sm" className="h-9"
          onClick={() => { setFilterContactable(!filterContactable); setFilterNoContact(false); setPage(0); }}
        >
          Has Contact Info
        </Button>

        <Button
          variant={filterNoContact ? "default" : "outline"}
          size="sm" className="h-9"
          onClick={() => { setFilterNoContact(!filterNoContact); setFilterContactable(false); setPage(0); }}
        >
          <AlertTriangle className="h-3.5 w-3.5 mr-1 text-amber-500" />
          No Contact Info
        </Button>

        <Select value={filterTag} onValueChange={(v) => { setFilterTag(v); setPage(0); }}>
          <SelectTrigger className="w-36 h-9">
            <SelectValue placeholder="All leads" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All leads</SelectItem>
            <SelectItem value="quiz_lead">Quiz Leads</SelectItem>
          </SelectContent>
        </Select>

        {/* Bulk action buttons */}
        {someSelected && (
          <div className="flex items-center gap-2 ml-2 pl-2 border-l">
            <span className="text-sm font-medium text-muted-foreground">
              {selectedIds.size} selected
            </span>
            {/* Legacy bulk enrichment always throws (CRO-03 provider transport disabled);
                disabled here instead of left clickable-but-broken. */}
            <Button
              size="sm" className="h-9 gap-1.5"
              disabled
              title="Legacy bulk enrichment is retired — CRO-03 provider transport is disabled."
            >
              <Sparkles className="h-3.5 w-3.5" />
              Enrich Selected (retired)
            </Button>
            <Button
              size="sm" variant="outline" className="h-9 gap-1.5"
              onClick={() => convertToProspectsMutation.mutate(Array.from(selectedIds))}
              disabled={convertToProspectsMutation.isPending}
            >
              {convertToProspectsMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
              Convert to Prospects
            </Button>
            <Button variant="ghost" size="sm" className="h-9" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        )}

        <div className="ml-auto flex gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>
              This trigger is deprecated. Enrichment runs automatically via the{" "}
              <button
                className="underline font-medium hover:no-underline"
                onClick={() => document.getElementById("pipeline-health-card")?.scrollIntoView({ behavior: "smooth" })}
              >
                scheduled pipeline
              </button>
              .
            </span>
          </div>
        </div>
      </div>

      {/* ── Results count ─────────────────────────────────────────────────── */}
      <div className="text-sm text-muted-foreground">
        {entitiesQuery.isLoading
          ? "Loading…"
          : `${total.toLocaleString()} leads matching current filters · Page ${page + 1} of ${Math.max(1, totalPages)}`
        }
      </div>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <Card className="shadow-sm">
        <CardContent className="p-0 overflow-x-auto">
          <Table className="min-w-[1000px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allPageSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all on page"
                  />
                </TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entitiesQuery.isLoading
                ? Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 10 }).map((_, j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                : entities.length === 0
                  ? (
                    <TableRow>
                      <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                        No leads match your current filters.
                      </TableCell>
                    </TableRow>
                  )
                  : entities.map((entity) => {
                      const email = entity.owner_email || entity.email;
                      const phone = entity.owner_phone || entity.phone;
                      const ownerName = entity.owner_name;
                      return (
                        <TableRow
                          key={entity.id}
                          className={selectedIds.has(entity.id) ? "bg-blue-50/60 dark:bg-blue-950/20" : ""}
                        >
                          <TableCell>
                            <Checkbox
                              checked={selectedIds.has(entity.id)}
                              onCheckedChange={() => toggleOne(entity.id)}
                            />
                          </TableCell>
                          <TableCell className="font-medium max-w-[200px]">
                            <div className="truncate" title={entity.entity_name}>{entity.entity_name}</div>
                            {entity.website && (
                              <a href={entity.website.startsWith("http") ? entity.website : `https://${entity.website}`}
                                 target="_blank" rel="noopener noreferrer"
                                 className="text-[10px] text-blue-500 hover:underline truncate block">
                                {entity.website}
                              </a>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {entity.principal_city || "—"}
                          </TableCell>
                          <TableCell className="text-sm">
                            {ownerName || <span className="text-muted-foreground text-xs">—</span>}
                          </TableCell>
                          <TableCell className="text-sm">
                            {email
                              ? <a href={`mailto:${email}`} className="text-blue-600 hover:underline text-xs">{email}</a>
                              : <span className="text-muted-foreground text-xs">—</span>
                            }
                          </TableCell>
                          <TableCell className="text-sm text-nowrap">
                            {phone
                              ? <a href={`tel:${phone}`} className="text-blue-600 hover:underline text-xs">{phone}</a>
                              : <span className="text-muted-foreground text-xs">—</span>
                            }
                          </TableCell>
                          <TableCell>
                            {entity.vertical
                              ? <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">{entity.vertical}</Badge>
                              : <span className="text-muted-foreground text-xs">—</span>
                            }
                          </TableCell>
                          <TableCell>
                            {entity.score
                              ? <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 ${scoreBadge(entity.score)}`}>{entity.score}</Badge>
                              : <span className="text-muted-foreground text-xs">—</span>
                            }
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 ${statusBadge(entity.enrichment_status)}`}>
                              {entity.enrichment_status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost" size="icon" className="h-7 w-7"
                              title="Re-enrich this lead (retired — CRO-03 provider transport disabled)"
                              disabled
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
              }
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline" size="sm" disabled={page === 0}
            onClick={() => setPage(p => Math.max(0, p - 1))}
            className="gap-1.5"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline" size="sm" disabled={page >= totalPages - 1}
            onClick={() => setPage(p => p + 1)}
            className="gap-1.5"
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
        </TabsContent>

        {/* ── South Florida Prospecting tab ──────────────────────────────── */}
        <TabsContent value="sfp" className="space-y-4">
          <NamedEmailEligibilityReviewPanel />
          <SfpEnrichmentControlCenter />
          <SouthFloridaProspectingPanel />
        </TabsContent>

        {/* ── Provider Results tab: per-call evidence log ─────────────────── */}
        <TabsContent value="provider-results" className="space-y-4">
          <SfpProviderResultsPanel />
        </TabsContent>

        {/* ── MI-09: Pilot Status tab (legacy) ────────────────────────── */}
        <TabsContent value="pilot" className="space-y-4">
          <p role="note" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="pilot-history-notice">
            Retired paid-pilot ceremony, kept as read-only history under Program Health. Current reviewed processing and release operations are on the Enrichment area (Canonical Backlog).
            A stale legacy heartbeat here does not show that incoming GHL sync is off.
          </p>
          <PilotStatusPanel />
        </TabsContent>

        {/* ── Health tab ─────────────────────────────────────────────────── */}
        <TabsContent value="health" className="space-y-4">
          <ProgramHealthPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Enrichment Control Center — single-glance health for the SFP
// source-to-paused-enrollment pipeline (discovery → validation →
// ready-held → paused sequence enrollment). Every number here is read
// straight from existing server authorities (pilot status-overview,
// promotion-state, the new validation-promotion override route) — this
// panel adds no new server-side state of its own beyond the override.
function SfpEnrichmentControlCenter() {
  const { toast } = useToast();

  const overviewQuery = useQuery<any>({
    queryKey: ["/api/lead-ops/pilot/status-overview"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/status-overview", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const promotionStateQuery = useQuery<any>({
    queryKey: ["/api/lead-ops/candidates/promotion-state"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/candidates/promotion-state", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const overrideQuery = useQuery<{ override: boolean | null; envVarEnabled: boolean; effective: boolean }>({
    queryKey: ["/api/lead-ops/sfp/settings/validation-promotion-override"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/sfp/settings/validation-promotion-override", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const setOverrideMutation = useMutation({
    mutationFn: async (value: boolean | null) => {
      return apiRequest("PUT", "/api/lead-ops/sfp/settings/validation-promotion-override", { override: value });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/sfp/settings/validation-promotion-override"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/candidates/promotion-state"] });
      toast({ title: "Validation promotion setting updated" });
    },
    onError: (err: any) => toast({ title: "Failed to update setting", description: parseApiRequestError(String(err?.message ?? err))?.reason ?? String(err?.message ?? err), variant: "destructive" }),
  });

  const overview = overviewQuery.data;
  const providerControls: Array<{ provider: string; enabled: boolean; circuitState: string }> =
    overview?.providerControls ?? [];
  const serper = providerControls.find((p) => p.provider === "serper");
  const zerobounce = providerControls.find((p) => p.provider === "zerobounce");
  const override = overrideQuery.data?.override ?? null;

  return (
    <Card data-testid="card-sfp-enrichment-control-center">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" /> Enrichment Control Center
        </CardTitle>
        <CardDescription>
          Live health of the source → validated email → ready-held → paused-enrollment pipeline. Outbound sending stays paused regardless of what's shown here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(overviewQuery.isLoading || promotionStateQuery.isLoading) ? (
          <Skeleton className="h-24 w-full" />
        ) : (overviewQuery.isError) ? (
          <div className="text-sm text-destructive">Failed to load pipeline status.</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="rounded-md border p-3" data-testid="stat-serper-status">
                <div className="text-xs text-muted-foreground">Serper (discovery)</div>
                <div className="text-lg font-semibold">{serper ? (serper.enabled ? "enabled" : "disabled") : "unknown"}</div>
                <div className="text-xs text-muted-foreground">{serper?.circuitState === "closed" ? "Failure protection: healthy" : serper?.circuitState === "open" ? "Failure protection: blocking calls" : serper?.circuitState === "half-open" || serper?.circuitState === "half_open" ? "Failure protection: testing recovery" : "Failure protection: unavailable"}</div>
              </div>
              <div className="rounded-md border p-3" data-testid="stat-zerobounce-status">
                <div className="text-xs text-muted-foreground">ZeroBounce (validation)</div>
                <div className="text-lg font-semibold">{zerobounce ? (zerobounce.enabled ? "enabled" : "disabled") : "unknown"}</div>
                <div className="text-xs text-muted-foreground">{zerobounce?.circuitState === "closed" ? "Failure protection: healthy" : zerobounce?.circuitState === "open" ? "Failure protection: blocking calls" : zerobounce?.circuitState === "half-open" || zerobounce?.circuitState === "half_open" ? "Failure protection: testing recovery" : "Failure protection: unavailable"}</div>
              </div>
              <div className="rounded-md border p-3" data-testid="stat-ready-held">
                <div className="text-xs text-muted-foreground">Ready-held enrollments</div>
                <div className="text-lg font-semibold">{overview?.funnel?.ready_held_enrollments ?? "—"}</div>
                <div className="text-xs text-muted-foreground">{overview?.funnel?.policy_eligible ?? "—"} outreach-eligible decisions (not unique recipients)</div>
              </div>
            </div>

            <div className="rounded-md border p-3 space-y-2" data-testid="sfp-actual-throughput">
              <div className="text-sm font-medium">CRM pool and actual SFP movement · rolling 24 hours</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div className="rounded bg-muted/40 p-2"><div className="text-muted-foreground">CRM contacts with email</div><div className="text-base font-semibold">{overview?.sourcePool?.active_contacts_with_email ?? "—"}</div></div>
                <div className="rounded bg-muted/40 p-2"><div className="text-muted-foreground">Verified linked to canonical</div><div className="text-base font-semibold">{overview?.sourcePool?.verified_canonical_linked_contacts_with_email ?? "—"}</div></div>
                <div className="rounded bg-muted/40 p-2"><div className="text-muted-foreground">Inside frozen v2 SFP cohorts</div><div className="text-base font-semibold">{overview?.sourcePool?.v2_sfp_cohort_linked_contacts_with_email ?? "—"}</div></div>
                <div className="rounded bg-muted/40 p-2"><div className="text-muted-foreground">Canonical businesses</div><div className="text-base font-semibold">{overview?.eligibleCounts?.canonical_businesses ?? "—"}</div></div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                <div className="rounded border p-2"><div className="text-muted-foreground">Provider operations</div><div className="font-semibold">{overview?.throughput24h?.provider_attempts ?? "—"}</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Distinct targets attempted</div><div className="font-semibold">{overview?.throughput24h?.distinct_provider_targets ?? "—"}</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Paid evidence facts</div><div className="font-semibold">{overview?.throughput24h?.paid_evidence_rows ?? "—"} · {overview?.throughput24h?.businesses_with_paid_evidence ?? "—"} businesses</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Validation decisions</div><div className="font-semibold">{overview?.throughput24h?.validation_decisions ?? "—"} · {overview?.throughput24h?.validation_eligible ?? "—"} eligible</div></div>
                <div className="rounded border p-2"><div className="text-muted-foreground">Ready-held created</div><div className="font-semibold">{overview?.throughput24h?.ready_held_created ?? "—"} · {overview?.throughput24h?.contact_source_ready_held ?? "—"} from contacts</div></div>
              </div>
              <div className="text-xs text-muted-foreground">
                  Provider calls, returned evidence, validation outcomes, and staged records are counted separately. This rolling window is real record movement, not worker ticks; outbound sending remains independently paused.
                  Linked-contact totals cover the whole CRM; the table below covers only frozen v2 SFP cohorts. Unclassified cohort members are shown separately, not assigned a guessed vertical.
              </div>
              {overview?.enrichmentTelemetry?.available === false && (
                <div className="text-xs text-amber-700">
                  SFP throughput details unavailable: {overview.enrichmentTelemetry.unavailableReason ?? "query_failed"}. Counts are not inferred.
                </div>
              )}
              {overview?.v2VerticalFunnel24h?.length > 0 && (
                <div className="overflow-x-auto rounded border" data-testid="sfp-v2-vertical-funnel">
                  <table className="w-full text-[11px] min-w-[900px]">
                    <thead className="bg-muted/50 text-left">
                      <tr>
                        <th className="p-2">V2 vertical</th><th className="p-2">Frozen businesses</th>
                        <th className="p-2">Verified linked CRM emails</th><th className="p-2">Free email candidates</th>
                        <th className="p-2">Paid email candidates</th><th className="p-2">ZB policy eligible · 24h</th>
                        <th className="p-2">Validation held/rejected · 24h</th><th className="p-2">Ready-held · 24h</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.v2VerticalFunnel24h.map((row: any) => (
                        <tr key={row.vertical} className="border-t">
                          <td className="p-2 font-medium">{row.vertical === "__unclassified__" ? "Unclassified / legacy cohort" : row.vertical}</td>
                          <td className="p-2">{row.frozen_businesses}</td>
                          <td className="p-2">{row.verified_contact_candidates}</td>
                          <td className="p-2">{row.free_email_candidates} · {row.businesses_with_free_email_candidate} businesses</td>
                          <td className="p-2">{row.paid_email_candidates} · {row.businesses_with_paid_email_candidate} businesses</td>
                          <td className="p-2">{row.validation_eligible_24h} / {row.validation_decisions_24h}</td>
                          <td className="p-2">{row.validation_held_or_rejected_24h}</td>
                          <td className="p-2">{row.ready_held_created_24h}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {overview?.paidEvidenceByProvider24h?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {overview.paidEvidenceByProvider24h.map((row: any) => <span key={`${row.provider}:${row.field}`} className="rounded bg-muted px-2 py-1 text-[11px] font-mono">{row.provider} {row.field}: {row.evidence_rows} facts / {row.businesses} businesses</span>)}
                </div>
              )}
              {overview?.validationBySourceStatus24h?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {overview.validationBySourceStatus24h.map((row: any) => <span key={`${row.source_kind}:${row.status}`} className="rounded bg-muted px-2 py-1 text-[11px] font-mono">{row.source_kind} → {row.status}: {row.rows}</span>)}
                </div>
              )}
            </div>

            <div className="rounded-md border p-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Email-validation promotion gate</div>
                <div className="text-xs text-muted-foreground">
                  Env var: {overrideQuery.data?.envVarEnabled ? "on" : "off"} · Override: {override === null ? "none (defers to env var)" : override ? "forced ON" : "forced OFF"} ·{" "}
                  Configured switch: {overrideQuery.isError || !overrideQuery.data ? "unavailable" : overrideQuery.data.effective ? "ON" : "OFF"}
                </div>
                <div className="text-xs mt-1" role="status" data-testid="sfp-effective-promotion-gate">
                  Effective promotion gate: <strong>{promotionStateQuery.isError || !promotionStateQuery.data ? "UNAVAILABLE" : promotionStateQuery.data.gateOpen ? "OPEN" : "CLOSED"}</strong>
                  {promotionStateQuery.data?.note && <p className="text-muted-foreground">{promotionStateQuery.data.note}</p>}
                  {promotionStateQuery.data?.runtimeOwnerReady === false && <p className="text-destructive">Deployment owner blocker: {promotionStateQuery.data.runtimeOwnerReason}</p>}
                  <p className="text-muted-foreground">This gate controls validation promotion, not successful enrichment or sending. Outbound stays paused.</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant={override === true ? "default" : "outline"} disabled={setOverrideMutation.isPending}
                  onClick={() => setOverrideMutation.mutate(true)} data-testid="button-promotion-override-on">
                  Force ON
                </Button>
                <Button size="sm" variant={override === false ? "default" : "outline"} disabled={setOverrideMutation.isPending}
                  onClick={() => setOverrideMutation.mutate(false)} data-testid="button-promotion-override-off">
                  Force OFF
                </Button>
                <Button size="sm" variant={override === null ? "default" : "outline"} disabled={setOverrideMutation.isPending}
                  onClick={() => setOverrideMutation.mutate(null)} data-testid="button-promotion-override-clear">
                  Use env var
                </Button>
              </div>
            </div>

            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" /> Auto-refreshes every 30s. Outbound sending authority is separate and unaffected by this panel — see the Health tab.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Provider Results Panel: per-call evidence log ──────────────────────────
//
// Complements the Enrichment Control Center's aggregate spend/counts with
// the actual per-call output: which business a discovery call resolved to
// which masked candidate value, and which classification call reached which
// verdict. Never fetches or renders decrypted contact values — the server
// route excludes envelope ciphertext entirely; maskedValue is already
// redacted at write time.
function SfpProviderResultsPanel() {
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [validationOutcome, setValidationOutcome] = useState("all");
  const [classificationOutcome, setClassificationOutcome] = useState("all");

  const resultsQuery = useQuery<{ candidateResults: any[]; classificationResults: any[]; validationResults: any[]; validationSummary: any }>({
    queryKey: ["/api/lead-ops/sfp/provider-results", providerFilter, validationOutcome, classificationOutcome],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "200" });
      if (providerFilter !== "all") params.set("provider", providerFilter);
      params.set("validationOutcome", validationOutcome);
      params.set("classificationOutcome", classificationOutcome);
      const r = await fetch(`/api/lead-ops/sfp/provider-results?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const candidateResults = resultsQuery.data?.candidateResults ?? [];
  const classificationResults = resultsQuery.data?.classificationResults ?? [];
  const validationResults = resultsQuery.data?.validationResults ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" aria-label="Provider result filters">
        {["all", "serper", "outscraper", "apollo", "openai", "zerobounce"].map((p) => (
          <Button key={p} size="sm" variant={providerFilter === p ? "default" : "outline"} onClick={() => setProviderFilter(p)} data-testid={`button-filter-${p}`}>
            {p === "all" ? "All" : p}
          </Button>
        ))}
      </div>
      {(providerFilter === "all" || ["serper", "outscraper", "apollo"].includes(providerFilter)) && <Card data-testid="card-sfp-candidate-results">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" /> Discovery &amp; Candidate Results
          </CardTitle>
          <CardDescription>
            What each paid discovery call (Serper, Outscraper, Apollo) actually returned, one row per candidate value. Values are masked — this is a results log, not a data export. Cost fields are application-ledger metadata, not provider invoices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {resultsQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : resultsQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load provider results.</div>
          ) : candidateResults.length === 0 ? (
            <div className="text-sm text-muted-foreground">No candidate results yet for this filter.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1.5 pr-3">Time</th>
                    <th className="py-1.5 pr-3">Provider</th>
                    <th className="py-1.5 pr-3">Business</th>
                    <th className="py-1.5 pr-3">Field</th>
                    <th className="py-1.5 pr-3">Value</th>
                    <th className="py-1.5 pr-3">Confidence</th>
                    <th className="py-1.5 pr-3">Disposition</th>
                    <th className="py-1.5 pr-3">Unit price</th>
                    <th className="py-1.5 pr-3">Recorded cost</th>
                  </tr>
                </thead>
                <tbody>
                  {candidateResults.map((r: any) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="py-1.5 pr-3 font-mono">{r.provider}</td>
                      <td className="py-1.5 pr-3">{r.business_name ?? `#${r.business_id}`}</td>
                      <td className="py-1.5 pr-3">{r.field}</td>
                      <td className="py-1.5 pr-3 font-mono">{r.masked_value}</td>
                      <td className="py-1.5 pr-3">{r.confidence}</td>
                      <td className="py-1.5 pr-3">
                        <span className="px-1.5 py-0.5 rounded bg-muted">{r.disposition}</span>
                      </td>
                      <td className="py-1.5 pr-3">{r.unit_price_micros == null ? "Unpriced" : usdFromMicros(r.unit_price_micros)}</td>
                      <td className="py-1.5 pr-3">{r.settled_cost_micros == null ? (r.billing_state === "ambiguous" ? "Reserved / unresolved" : "Unpriced") : usdFromMicros(r.settled_cost_micros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>}

      {(providerFilter === "all" || providerFilter === "openai") && <Card data-testid="card-sfp-classification-results">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" /> Classification Results
          </CardTitle>
          <CardDescription>
            Classification ledger, including deterministic and free-only decisions, AI results and blocked attempts.
            A provisional review row is not a successful OpenAI call. SFP classifications do not overwrite the legacy business vertical.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 mb-3" aria-label="Classification outcome filters">
            {["all", "target", "non_target", "review_required"].map((outcome) => <Button key={outcome} size="sm"
              variant={classificationOutcome === outcome ? "default" : "outline"} onClick={() => setClassificationOutcome(outcome)}
              data-testid={`filter-classification-${outcome}`}>{outcome === "all" ? "All decisions" : outcome === "target" ? "Target classifications" : outcome === "non_target" ? "Non-target" : "Needs review"}</Button>)}
          </div>
          {resultsQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : resultsQuery.isError ? <p role="alert" className="text-destructive">Classification results unavailable — not an empty result.</p> : classificationResults.length === 0 ? (
            <div className="text-sm text-muted-foreground">No classification results yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1.5 pr-3">Time</th>
                    <th className="py-1.5 pr-3">Business</th>
                    <th className="py-1.5 pr-3">Outcome</th>
                    <th className="py-1.5 pr-3">Vertical</th>
                    <th className="py-1.5 pr-3">Admission tier</th>
                    <th className="py-1.5 pr-3">Confidence</th>
                    <th className="py-1.5 pr-3">Source / state</th>
                    <th className="py-1.5 pr-3">Reason</th>
                    <th className="py-1.5 pr-3">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {classificationResults.map((r: any) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="py-1.5 pr-3">{r.business_name ?? `#${r.business_id}`}</td>
                      <td className="py-1.5 pr-3">
                        <span className={`px-1.5 py-0.5 rounded ${r.outcome === "target" ? "bg-green-100 text-green-800" : r.outcome === "review_required" ? "bg-amber-100 text-amber-800" : "bg-muted"}`}>
                          {r.outcome}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">{r.resolved_vertical_id ?? "—"}</td>
                      <td className="py-1.5 pr-3">{r.admission_tier ?? "—"}</td>
                      <td className="py-1.5 pr-3">{r.confidence ?? "—"}</td>
                      <td className="py-1.5 pr-3">
                        {r.model_version ? `AI: ${r.model_version}` : r.reason_codes?.includes("OPENAI_ESCALATION_NOT_CONFIGURED") ? "AI escalation blocked"
                          : r.reason_codes?.includes("OPENAI_UNAVAILABLE") ? "AI unavailable / failed"
                          : r.reason_codes?.includes("FREE_ONLY_NO_ESCALATION") ? "Free-only; AI not attempted" : "Deterministic"}
                        {" · "}{r.terminal_state} · taxonomy {r.taxonomy_version}
                      </td>
                      <td className="py-1.5 pr-3 max-w-sm break-words">{Array.isArray(r.reason_codes) ? r.reason_codes.join(", ") : "Reason unavailable"}</td>
                      <td className="py-1.5 pr-3">{usdFromMicros(r.cost_micros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>}

      {(providerFilter === "all" || providerFilter === "zerobounce") && <Card data-testid="card-sfp-validation-results">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5" /> ZeroBounce Validation Results</CardTitle>
          <CardDescription>
            Actual recorded ZeroBounce outcomes, including reused results. Discovery-required rows are backlog, not validations.
            A valid email is not necessarily policy eligible or approved to send. Addresses remain masked; costs are not provider invoices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {resultsQuery.data?.validationSummary && <div className="rounded border p-3 text-xs mb-3" data-testid="sfp-validation-summary">
            {resultsQuery.data.validationSummary.distinct_valid_emails} distinct emails with a stored valid result ·{" "}
            {resultsQuery.data.validationSummary.distinct_policy_eligible_emails} distinct policy-eligible emails ·{" "}
            {resultsQuery.data.validationSummary.result_rows} result records.
            <p className="text-muted-foreground">
              Discovery backlog: {resultsQuery.data.validationSummary.discovery_backlog_rows} records / {resultsQuery.data.validationSummary.discovery_backlog_businesses} businesses.
              Totals cover historical SFP eligibility records, not current freshness or the 5,000-recipient certification target.
            </p>
          </div>}
          <div className="flex flex-wrap gap-2 mb-3" aria-label="Validation outcome filters">
            {["all", "valid", "invalid", "review"].map((outcome) => <Button key={outcome} size="sm"
              variant={validationOutcome === outcome ? "default" : "outline"} onClick={() => setValidationOutcome(outcome)}
              data-testid={`filter-validation-${outcome}`}>{outcome === "all" ? "All outcomes" : outcome === "valid" ? "Valid emails" : outcome === "invalid" ? "Invalid / do not mail" : "Held for review"}</Button>)}
          </div>
          {resultsQuery.isLoading ? <Skeleton className="h-32 w-full" /> : resultsQuery.isError ? (
            <p role="alert" className="text-destructive">Validation results unavailable — not zero validations.</p>
          ) : validationResults.length === 0 ? (
            <div className="text-sm text-muted-foreground">No recorded ZeroBounce outcomes for this filter.</div>
          ) : <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground border-b">
                <th className="py-1.5 pr-3">Validated</th><th className="py-1.5 pr-3">Business</th>
                <th className="py-1.5 pr-3">Source</th><th className="py-1.5 pr-3">Email (masked)</th>
                <th className="py-1.5 pr-3">Status</th><th className="py-1.5 pr-3">Outcome</th>
                <th className="py-1.5 pr-3">Recorded cost</th>
              </tr></thead>
              <tbody>{validationResults.map((r: any) => <tr key={r.id} className="border-b last:border-0">
                <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{r.validation_at ? new Date(r.validation_at).toLocaleString() : "—"}</td>
                <td className="py-1.5 pr-3">{r.business_name ?? `#${r.business_id}`}</td>
                <td className="py-1.5 pr-3">{r.source_kind ?? r.discovery_source ?? "—"}</td>
                <td className="py-1.5 pr-3 font-mono">{r.masked_email ?? "—"}</td>
                <td className="py-1.5 pr-3">{r.status}</td><td className="py-1.5 pr-3">{r.zb_outcome ?? "—"}</td>
                <td className="py-1.5 pr-3">{r.settled_cost_micros == null ? (r.reused_from_operation_id ? "Reused; no new charge" : r.billing_state === "ambiguous" ? "Reserved / unresolved" : "Unpriced") : usdFromMicros(r.settled_cost_micros)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </CardContent>
      </Card>}
    </div>
  );
}

// ── MI-09: Pilot Status Panel — guided production operator workflow ────────
//
// This panel is a thin, ordered UI over the existing MI-09 pilot lifecycle
// service (server/services/mi09-pilot-authority.ts) and its routes
// (server/routes/lead-ops.ts). It never fabricates state on the client: every
// number shown (release SHA, migration head, pause epoch, spend) is read
// straight from the server. All mutating actions are gated by the run's
// actual state so an operator cannot skip a step the server would reject
// anyway — the server-side checks remain the real authority.
const PAID_APPROVAL_CONFIRMATION = "AUTHORIZE PAID PILOT";

function usdFromMicros(micros: number | undefined | null): string {
  return `$${((Number(micros ?? 0)) / 1_000_000).toFixed(2)}`;
}

function StateBadge({ state }: { state: string }) {
  const cls =
    state === "completed" ? "bg-green-100 text-green-800" :
    state === "running"   ? "bg-blue-100 text-blue-800" :
    state === "stopped"   ? "bg-red-100 text-red-800" :
    state === "paused"    ? "bg-yellow-100 text-yellow-800" :
    "bg-gray-100 text-gray-800";
  return <span className={`px-1.5 py-0.5 rounded-full font-medium text-xs ${cls}`}>{state}</span>;
}

function PilotStatusPanel() {
  const { toast } = useToast();
  const [executingRunId, setExecutingRunId] = useState<string | null>(null);
  const [reconciliationReport, setReconciliationReport] = useState<any>(null);
  const [paidApprovalConfirmText, setPaidApprovalConfirmText] = useState("");
  const [newDefLevel, setNewDefLevel] = useState<"1" | "2" | "3">("1");
  const [newDefCounties, setNewDefCounties] = useState("");
  const [newDefVerticals, setNewDefVerticals] = useState("");
  const [newDefSourceAdapters, setNewDefSourceAdapters] = useState("");
  const [newDefMaxCohort, setNewDefMaxCohort] = useState("25");
  const [newDefProviders, setNewDefProviders] = useState<Record<string, boolean>>({
    serper: false, outscraper: false, openai: false, apollo: false, zerobounce: false,
  });
  const [newRunDefId, setNewRunDefId] = useState<string>("");

  const preflightQuery = useQuery<{ passed: boolean; checks: Record<string, { passed: boolean; detail?: string }> }>({
    queryKey: ["/api/lead-ops/pilot/preflight"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/preflight", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 30_000,
  });

  const runsQuery = useQuery<any[]>({
    queryKey: ["/api/lead-ops/pilot/runs"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/runs", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 15_000,
  });

  const defsQuery = useQuery<any[]>({
    queryKey: ["/api/lead-ops/pilot/definitions"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/definitions", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 30_000,
  });

  const paidApprovalQuery = useQuery<{ authorization: any }>({
    queryKey: ["/api/lead-ops/pilot/paid-provider-approval"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/paid-provider-approval", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  const scheduleDefsQuery = useQuery<any[]>({
    queryKey: ["/api/admin/cro08a/schedule-definitions"],
    queryFn: async () => {
      const r = await fetch("/api/admin/cro08a/schedule-definitions", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 30_000,
  });

  const poolAuthorityQuery = useQuery<{ decision: { pool: string; decidedBy: string; decidedAt: string; revision: number } | null }>({
    queryKey: ["/api/lead-ops/pilot/pool-authority"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/pool-authority", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 30_000,
  });

  const statusOverviewQuery = useQuery<any>({
    queryKey: ["/api/lead-ops/pilot/status-overview"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/status-overview", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

  const activationReadinessQuery = useQuery<{ readiness: { ready: boolean; gates: { key: string; passed: boolean; detail: string }[] }; authorization: any; scope: string; pilotScope: string; recurrenceScope: string }>({
    queryKey: ["/api/lead-ops/pilot/activation-readiness"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/activation-readiness", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 20_000,
  });
  const [activationConfirmText, setActivationConfirmText] = useState("");

  const pricingScheduleQuery = useQuery<{
    source: string; snapshotId: string; currentVersion: number; capturedBy: string; capturedAt: string; expiresAt: string;
    compositeHash: string;
    priceSchedules: Record<string, { version: number; unitType: string; currency: string; amountMicros: number; billingSemantics: string }>;
  }>({
    queryKey: ["/api/lead-ops/pilot/pricing-schedule"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/pilot/pricing-schedule", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    staleTime: 30_000,
  });

  const invalidatePilot = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/preflight"] });
    queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/runs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/definitions"] });
    queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/paid-provider-approval"] });
  };

  const errToast = (err: unknown) => {
    toast({ title: "Action failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
  };

  const setPoolAuthorityMutation = useMutation({
    mutationFn: async (pool: "master_leads" | "prospects") => {
      const res = await apiRequest("PUT", "/api/lead-ops/pilot/pool-authority", { pool });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Pool authority updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/pool-authority"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/preflight"] });
    },
    onError: errToast,
  });

  const authorizeActivationMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/lead-ops/pilot/activation-readiness", { typedConfirmation: activationConfirmText });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Selective activation authorized (record only — BACKGROUND_JOB_PROFILE unchanged)" });
      setActivationConfirmText("");
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/activation-readiness"] });
    },
    onError: errToast,
  });

  const createDefMutation = useMutation({
    mutationFn: async () => {
      const county = newDefCounties.split(",").map((s) => s.trim()).filter(Boolean);
      const vertical = newDefVerticals.split(",").map((s) => s.trim()).filter(Boolean);
      const sourceAdapters = newDefSourceAdapters.split(",").map((s) => s.trim()).filter(Boolean);
      const level = Number(newDefLevel);
      const res = await apiRequest("POST", "/api/lead-ops/pilot/definitions", {
        level,
        countyScope: county,
        verticalScope: vertical,
        sourceAdapterFilter: sourceAdapters,
        maxCohortSize: Number(newDefMaxCohort),
        enrichmentRecipeVersion: 1,
        // Selecting a provider here is only a proposal — the server
        // independently rejects any provider missing its secret or pricing
        // artifact, or (for level 1) any paid provider at all.
        paidProvidersAllowed: level === 1
          ? {}
          : Object.fromEntries(Object.entries(newDefProviders).filter(([, v]) => v)),
        stopConditionThresholds: {
          conflictPct: 5,
          apolloYieldPct: 0,
          zbUnknownPct: 20,
        },
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { toast({ title: "Pilot definition created" }); invalidatePilot(); },
    onError: errToast,
  });

  const createRunMutation = useMutation({
    mutationFn: async () => {
      if (!newRunDefId) throw new Error("Select a pilot definition first");
      const def = (defsQuery.data ?? []).find((d: any) => String(d.id) === newRunDefId);
      const preflight = preflightQuery.data as any;
      if (!preflight?.releaseSha || preflight.releaseSha === "unknown") {
        throw new Error("Cannot create a run: server did not report a release SHA (RELEASE_SHA env var missing)");
      }
      const res = await apiRequest("POST", "/api/lead-ops/pilot/runs", {
        pilotDefinitionId: newRunDefId,
        releaseSha: preflight.releaseSha,
        cro03cSelectionPolicyVersion: 1,
        cro03cRoutingPolicyVersion: 1,
        cro03cRecipeVersion: def?.enrichment_recipe_version ?? 1,
        outboundPauseEpoch: preflight.outboundPauseEpoch,
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { toast({ title: "Pilot run created (draft)" }); invalidatePilot(); },
    onError: errToast,
  });

  const selectCohortMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiRequest("POST", `/api/lead-ops/pilot/runs/${runId}/select-cohort`, {});
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: data.frozen ? "Cohort frozen" : "Cohort already frozen", description: `Selected ${data.selectedCount || ""} businesses from ${data.eligiblePoolSize ?? "?"} in scope.` });
      invalidatePilot();
    },
    onError: errToast,
  });

  const selectRoiCohortMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiRequest("POST", `/api/lead-ops/pilot/runs/${runId}/select-roi-cohort`, {});
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.frozen ? "ROI cohort frozen" : "ROI cohort already frozen",
        description: `Selected ${data.selectedCount || 0} of ${data.eligiblePoolSize ?? "?"} eligible businesses — top ROI-ranked from South Florida / five verticals. master_leads = 0 is OK.`,
      });
      invalidatePilot();
    },
    onError: errToast,
  });

  const transitionMutation = useMutation({
    mutationFn: async ({ runId, toState, stopReason }: { runId: string; toState: string; stopReason?: string }) => {
      const res = await apiRequest("POST", `/api/lead-ops/pilot/runs/${runId}/transition`, { toState, stopReason });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { invalidatePilot(); },
    onError: errToast,
  });

  const advanceMutation = useMutation({
    mutationFn: async ({ runId, fromLevel, toLevel }: { runId: string; fromLevel: number; toLevel: number }) => {
      const res = await apiRequest("POST", `/api/lead-ops/pilot/runs/${runId}/advance`, {
        fromLevel, toLevel, idempotencyKey: crypto.randomUUID(),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { toast({ title: "Advancement receipt issued" }); invalidatePilot(); },
    onError: errToast,
  });

  const reconciliationMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiRequest("POST", "/api/lead-ops/pilot/reconciliation-reports", { pilotRunId: runId });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => {
      setReconciliationReport(data);
      toast({ title: "Reconciliation report generated and saved" });
    },
    onError: errToast,
  });

  const authorizePaidPilotMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/lead-ops/pilot/paid-provider-approval", { typedConfirmation: paidApprovalConfirmText });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { toast({ title: "Paid pilot approved" }); setPaidApprovalConfirmText(""); queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/paid-provider-approval"] }); },
    onError: errToast,
  });

  const emergencyStopMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/lead-ops/pilot/emergency-stop-paid", { reason: "operator_emergency_stop" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "All paid providers stopped",
        description: `Disabled ${data.providersDisabled ?? 0} provider control(s); ${data.inFlightCount ?? 0} in-flight operation(s) require reconciliation.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/paid-provider-approval"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/status-overview"] });
    },
    onError: errToast,
  });

  const activateScheduleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/cro08a/schedule-definitions/${id}/activate`, {});
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { toast({ title: "Schedule activated" }); queryClient.invalidateQueries({ queryKey: ["/api/admin/cro08a/schedule-definitions"] }); },
    onError: errToast,
  });

  const deactivateScheduleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/cro08a/schedule-definitions/${id}/deactivate`, {});
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => { toast({ title: "Schedule deactivated" }); queryClient.invalidateQueries({ queryKey: ["/api/admin/cro08a/schedule-definitions"] }); },
    onError: errToast,
  });

  // Repeated execute-phase calls until the phase reports complete:true.
  const runExecuteLoop = useCallback(async (runId: string) => {
    setExecutingRunId(runId);
    try {
      let complete = false;
      let totalProcessed = 0;
      let guard = 0;
      while (!complete && guard < 500) {
        guard++;
        const res = await apiRequest("POST", `/api/lead-ops/pilot/runs/${runId}/execute-phase`, { phase: "enrichment", batchSize: 50 }, { "Idempotency-Key": crypto.randomUUID() });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        totalProcessed += data.processed ?? 0;
        complete = !!data.complete;
      }
      toast({ title: "Enrichment phase complete", description: `Processed ${totalProcessed} cohort member(s).` });
    } catch (err) {
      errToast(err);
    } finally {
      setExecutingRunId(null);
      invalidatePilot();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preflight = preflightQuery.data;
  const runs = runsQuery.data ?? [];
  const defs = defsQuery.data ?? [];
  const paidApproval = paidApprovalQuery.data?.authorization;
  const paidPilotApproved = !!paidApproval && !paidApproval.revokedAt;

  const checkEntries = preflight ? Object.entries(preflight.checks) : [];
  const passedCount = checkEntries.filter(([, c]) => c.passed).length;

  return (
    <div className="space-y-4">
      {/* Production verification — server-resolved, never user-entered */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">Production Verification</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          {checkEntries.filter(([k]) => ["releaseSha", "migrationHead", "outboundPaused", "poolAuthorityDecided"].includes(k)).map(([key, check]) => (
            <div key={key} className="rounded border p-2">
              <div className="text-muted-foreground font-mono">{key}</div>
              <div className={check.passed ? "text-green-600" : "text-red-500"}>{check.detail ?? (check.passed ? "OK" : "missing")}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Pool authority — owner-only decision of which pool MI-09 treats as authoritative */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">Pool Authority</h3>
        <p className="text-xs text-muted-foreground">
          Determines whether MI-09 pilots and free enrichment treat <code>master_leads</code> or <code>prospects</code> as the
          authoritative pool for downstream sales handoff. Owner-only; every change is written to the audit log.
        </p>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-muted-foreground">Current:</span>
          <span className="font-mono px-2 py-0.5 rounded bg-muted">
            {poolAuthorityQuery.data?.decision?.pool ?? "not yet decided"}
          </span>
          {poolAuthorityQuery.data?.decision && (
            <span className="text-muted-foreground">
              (rev {poolAuthorityQuery.data.decision.revision}, by {poolAuthorityQuery.data.decision.decidedBy}, {new Date(poolAuthorityQuery.data.decision.decidedAt).toLocaleString()})
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={poolAuthorityQuery.data?.decision?.pool === "master_leads" ? "default" : "outline"}
            onClick={() => setPoolAuthorityMutation.mutate("master_leads")}
            disabled={setPoolAuthorityMutation.isPending}
            data-testid="button-pool-authority-master-leads"
          >
            Set master_leads authoritative
          </Button>
          <Button
            size="sm"
            variant={poolAuthorityQuery.data?.decision?.pool === "prospects" ? "default" : "outline"}
            onClick={() => setPoolAuthorityMutation.mutate("prospects")}
            disabled={setPoolAuthorityMutation.isPending}
            data-testid="button-pool-authority-prospects"
          >
            Set prospects authoritative
          </Button>
        </div>
      </div>

      {/* Full telemetry snapshot */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">System Telemetry</h3>
        {statusOverviewQuery.isLoading && <p className="text-xs text-muted-foreground">Loading...</p>}
        {statusOverviewQuery.data && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="rounded border p-2">
              <div className="text-muted-foreground">RELEASE_SHA</div>
              <div className="font-mono truncate">{statusOverviewQuery.data.releaseSha}</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-muted-foreground">Background job profile</div>
              <div className={statusOverviewQuery.data.backgroundJobProfile === "off" ? "text-green-600" : "text-amber-600"}>
                {statusOverviewQuery.data.backgroundJobProfile}
              </div>
            </div>
            <div className="rounded border p-2">
              <div className="text-muted-foreground">Canonical businesses</div>
              <div>{statusOverviewQuery.data.eligibleCounts?.canonical_businesses ?? "—"}</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-muted-foreground">Canonical, non-DBPR</div>
              <div>{statusOverviewQuery.data.eligibleCounts?.canonical_non_dbpr_businesses ?? "—"}</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-muted-foreground">Excluded businesses</div>
              <div>{statusOverviewQuery.data.eligibleCounts?.excluded_businesses ?? "—"}</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-muted-foreground">Free enrichment complete</div>
              <div>{statusOverviewQuery.data.eligibleCounts?.free_enrichment_complete ?? "—"}</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-muted-foreground">master_leads rows</div>
              <div>{statusOverviewQuery.data.eligibleCounts?.master_leads_count ?? "—"}</div>
            </div>
          </div>
        )}
        {statusOverviewQuery.data?.funnel && (
          <div className="rounded border p-2 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>Enrichment funnel (Gate 3)</span>
              <span className="font-mono">as of {new Date(statusOverviewQuery.data.funnel.snapshotAt).toLocaleTimeString()}</span>
            </div>
            {statusOverviewQuery.data.funnel.available === false && (
              <div className="text-xs text-amber-700">
                Funnel counts unavailable: {statusOverviewQuery.data.funnel.unavailableReason ?? "query_failed"}. Counts are not inferred.
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="rounded border p-2"><div className="text-muted-foreground">Sunbiz source rows</div><div>{statusOverviewQuery.data.funnel.sunbiz_source_rows ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Canonical businesses</div><div>{statusOverviewQuery.data.funnel.canonical_businesses ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Contacts linked to business</div><div>{statusOverviewQuery.data.funnel.contacts_linked_to_business ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Canonical missing domain</div><div>{statusOverviewQuery.data.funnel.canonical_missing_domain ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Free enrichment complete</div><div>{statusOverviewQuery.data.funnel.free_enrichment_complete ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Free enrichment queued</div><div>{statusOverviewQuery.data.funnel.free_enrichment_queued ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Paid discovered evidence</div><div>{statusOverviewQuery.data.funnel.paid_discovered_evidence_rows ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Policy eligible</div><div className="text-green-600 font-semibold">{statusOverviewQuery.data.funnel.policy_eligible ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Policy suppressed</div><div>{statusOverviewQuery.data.funnel.policy_suppressed ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Policy ineligible</div><div>{statusOverviewQuery.data.funnel.policy_ineligible ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Policy pending/discovery</div><div>{statusOverviewQuery.data.funnel.policy_pending ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Catch-all review</div><div>{statusOverviewQuery.data.funnel.policy_catch_all_review ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Ready-held enrollments</div><div>{statusOverviewQuery.data.funnel.ready_held_enrollments ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Identity quarantined</div><div>{statusOverviewQuery.data.funnel.identity_quarantined ?? "—"}</div></div>
              <div className="rounded border p-2"><div className="text-muted-foreground">Contacts suppressed</div><div>{statusOverviewQuery.data.funnel.contacts_suppressed ?? "—"}</div></div>
            </div>
          </div>
        )}
        {statusOverviewQuery.data?.crosswalkOnlyExcluded && (
          <div className="rounded border p-2">
            <div className="text-xs text-muted-foreground mb-1">Crosswalk-only excluded contacts</div>
            <div className="flex flex-wrap gap-2 items-center text-xs">
              <span className="font-semibold text-base">{statusOverviewQuery.data.crosswalkOnlyExcluded.crosswalk_only_excluded_count ?? 0}</span>
              <span className="text-muted-foreground">
                have no deterministic/explicit identity link — only ambiguous ({statusOverviewQuery.data.crosswalkOnlyExcluded.ambiguous_match_count ?? 0}) or
                insufficient-evidence ({statusOverviewQuery.data.crosswalkOnlyExcluded.insufficient_evidence_count ?? 0}) crosswalk candidates. Kept in review, never promoted or dropped.
              </span>
            </div>
          </div>
        )}
        {statusOverviewQuery.data?.zbOutcomes?.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">ZeroBounce outcomes (contacts.email_status)</div>
            <div className="flex flex-wrap gap-1">
              {statusOverviewQuery.data.zbOutcomes.map((o: any) => (
                <span key={o.email_status} className="text-xs px-2 py-0.5 rounded bg-muted font-mono">{o.email_status}: {o.cnt}</span>
              ))}
            </div>
          </div>
        )}
        {statusOverviewQuery.data?.providerControls?.length > 0 && (
          <div>
            <div className="text-xs text-muted-foreground mb-2">Paid Provider Controls</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {statusOverviewQuery.data.providerControls.map((p: any) => (
                <div key={p.provider} className={`rounded border p-2 text-xs ${p.circuitState !== "closed" || !p.enabled ? "border-red-200 bg-red-50/50" : "bg-muted/30"}`}>
                  <div className="flex items-center justify-between font-semibold">
                    <span className="capitalize">{p.provider}</span>
                    <span className={p.enabled && p.circuitState === "closed" ? "text-green-700" : "text-red-700"}>
                      {p.enabled ? "enabled" : "disabled"} · {p.circuitState}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 mt-1 font-mono text-[11px]">
                    <span>credential: {String(p.credentialPresent)}</span>
                    <span>reserved units: {p.reservedUnits ?? "unavailable"}</span>
                    <span>consumed units: {p.consumedUnits ?? "unavailable"}</span>
                    <span className="col-span-2 truncate">price: {p.currentPriceArtifactReference ?? "unavailable"}</span>
                    <span className="col-span-2">last: {p.lastCallAt ? `${p.lastOutcome ?? "unknown"} @ ${new Date(p.lastCallAt).toLocaleString()}` : "none"}</span>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    purposes: {(p.authorizedPurposes ?? []).join(", ") || "none"}
                  </div>
                  <div className="truncate text-muted-foreground" title={(p.authorizedCallers ?? []).join(", ")}>
                    callers: {(p.authorizedCallers ?? []).join(", ") || "none"}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Credentials are presence booleans only. In-flight operations requiring reconciliation:{" "}
              <span className="font-semibold">{statusOverviewQuery.data.paidInFlightCount ?? "unavailable"}</span>
            </div>
          </div>
        )}
        {statusOverviewQuery.data?.zeroBounceSafety && (
          <div className="rounded border p-2 text-xs">
            <div className="font-semibold">ZeroBounce automatic lane</div>
            <div className="font-mono mt-1">
              {statusOverviewQuery.data.zeroBounceSafety.autoRunEnabled ? "enabled" : "disabled"} · next run{" "}
              {new Date(statusOverviewQuery.data.zeroBounceSafety.nextAutomaticRunAt).toLocaleString()}
            </div>
          </div>
        )}
        <Button
          size="sm"
          variant="destructive"
          disabled={emergencyStopMutation.isPending}
          onClick={() => emergencyStopMutation.mutate()}
          data-testid="button-paid-provider-emergency-stop"
        >
          <ShieldAlert className="h-3.5 w-3.5 mr-1" />
          Emergency stop all paid providers
        </Button>
      </div>

      {/* Final operator-gated activation step (corrective item 10) */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">Selective Activation Readiness</h3>
        <p className="text-xs text-muted-foreground">
          Pilot scope (use this to authorize the bounded pilot run — no recurring enrichment):{" "}
          <code className="font-mono">{activationReadinessQuery.data?.pilotScope ?? "selective:enrichment,free-enrichment-lane,provider-live,email-validation"}</code>.
          Authorizing here only records your decision — it does not change <code>BACKGROUND_JOB_PROFILE</code> or start any worker.
          To actually go live for the pilot, set that secret to the pilot scope above yourself after Publish, then restart.
        </p>
        <p className="text-xs text-muted-foreground border-t pt-2">
          Recurrence scope (separate decision — adds <code className="font-mono">continuous-enrichment</code>; do not use this for a pilot):{" "}
          <code className="font-mono">{activationReadinessQuery.data?.recurrenceScope ?? "selective:enrichment,free-enrichment-lane,provider-live,email-validation,continuous-enrichment"}</code>.
          Only apply this profile if you are deliberately turning on ongoing recurring enrichment on top of a completed, reviewed pilot — never as part of authorizing the pilot itself.
        </p>
        {activationReadinessQuery.data && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
            {activationReadinessQuery.data.readiness.gates.map((g) => (
              <div key={g.key} className="rounded border p-2">
                <div className="text-muted-foreground font-mono">{g.key}</div>
                <div className={g.passed ? "text-green-600" : "text-red-500"}>{g.detail}</div>
              </div>
            ))}
          </div>
        )}
        {activationReadinessQuery.data?.authorization ? (
          <div className="text-xs text-green-700 dark:text-green-400">
            Authorized by {activationReadinessQuery.data.authorization.authorizedBy} at{" "}
            {new Date(activationReadinessQuery.data.authorization.authorizedAt).toLocaleString()}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input
              value={activationConfirmText}
              onChange={(e) => setActivationConfirmText(e.target.value)}
              placeholder="Type: AUTHORIZE SELECTIVE ACTIVATION"
              className="text-xs h-8 max-w-xs"
              data-testid="input-activation-confirm"
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={!activationReadinessQuery.data?.readiness.ready || authorizeActivationMutation.isPending || activationConfirmText !== "AUTHORIZE SELECTIVE ACTIVATION"}
              onClick={() => authorizeActivationMutation.mutate()}
              data-testid="button-authorize-activation"
            >
              Record activation authorization
            </Button>
          </div>
        )}
      </div>

      {/* Preflight checklist */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">Pre-Pilot Checklist</h3>
          {preflight && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${preflight.passed ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"}`}>
              {passedCount}/{checkEntries.length} passed
            </span>
          )}
        </div>
        {preflightQuery.isLoading && <p className="text-xs text-muted-foreground">Loading...</p>}
        {preflightQuery.isError && <p className="text-xs text-red-500">Failed to load preflight checklist</p>}
        {checkEntries.length > 0 && (
          <div className="grid gap-1">
            {checkEntries.map(([key, check]) => (
              <div key={key} className="flex items-start gap-2 text-xs">
                <span className={check.passed ? "text-green-600" : "text-red-500"}>
                  {check.passed ? "✓" : "✗"}
                </span>
                <span className="font-mono">{key}</span>
                {check.detail && <span className="text-muted-foreground">{check.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Explicit paid-provider approval */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">Paid Provider Approval</h3>
        <div className="text-xs text-muted-foreground">
          Status: {paidPilotApproved ? <span className="text-green-600 font-medium">Approved by {paidApproval.authorizedBy} at {new Date(paidApproval.authorizedAt).toLocaleString()}</span> : <span className="text-red-500 font-medium">Not approved — paid pilot phases remain blocked</span>}
        </div>
        {!paidPilotApproved && (
          <div className="flex items-center gap-2">
            <Input
              value={paidApprovalConfirmText}
              onChange={(e) => setPaidApprovalConfirmText(e.target.value)}
              placeholder={PAID_APPROVAL_CONFIRMATION}
              className="text-xs h-8 max-w-xs font-mono"
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={paidApprovalConfirmText !== PAID_APPROVAL_CONFIRMATION || authorizePaidPilotMutation.isPending}
              onClick={() => authorizePaidPilotMutation.mutate()}
            >
              Approve paid pilot
            </Button>
          </div>
        )}
      </div>

      {/* Pilot definitions */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">Pilot Definitions ({defs.length})</h3>
        {defs.map((d: any) => (
          <div key={d.id} className="rounded border p-2 text-xs font-mono space-y-0.5">
            <div className="font-semibold">Level {d.level} — {d.pilot_definition_hash?.slice(0, 12)}…</div>
            <div className="text-muted-foreground">Counties: {JSON.stringify(d.county_scope)}</div>
            <div className="text-muted-foreground">Verticals: {JSON.stringify(d.vertical_scope)}</div>
            <div className="text-muted-foreground">Source adapters: {JSON.stringify(d.source_adapter_filter)}</div>
            <div className="text-muted-foreground">Max cohort: {d.max_cohort_size}</div>
            <div className="text-muted-foreground">Paid providers: {JSON.stringify(d.paid_providers_allowed)}</div>
          </div>
        ))}
        <div className="rounded border border-dashed p-3 space-y-2">
          <div className="text-xs font-semibold">Create pilot definition</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Select value={newDefLevel} onValueChange={(v) => setNewDefLevel(v as any)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Level 1 (free only)</SelectItem>
                <SelectItem value="2">Level 2 (paid)</SelectItem>
                <SelectItem value="3">Level 3 (paid)</SelectItem>
              </SelectContent>
            </Select>
            <Input className="h-8 text-xs" placeholder="Counties (FIPS, comma-sep)" value={newDefCounties} onChange={(e) => setNewDefCounties(e.target.value)} />
            <Input className="h-8 text-xs" placeholder="Verticals (comma-sep)" value={newDefVerticals} onChange={(e) => setNewDefVerticals(e.target.value)} />
            <Input className="h-8 text-xs" placeholder="Source adapters (comma-sep)" value={newDefSourceAdapters} onChange={(e) => setNewDefSourceAdapters(e.target.value)} />
            <Input className="h-8 text-xs" type="number" placeholder="Max cohort size" value={newDefMaxCohort} onChange={(e) => setNewDefMaxCohort(e.target.value)} />
          </div>
          {newDefLevel !== "1" && (
            <div className="space-y-1">
              <div className="rounded border bg-muted/20 p-2 text-xs">
                <div className="font-semibold">Pricing authority</div>
                {pricingScheduleQuery.data ? (
                  <div className="text-muted-foreground">
                    DB snapshot v{pricingScheduleQuery.data.currentVersion ?? "—"} ·
                    captured by {pricingScheduleQuery.data.capturedBy} ·
                    {new Date(pricingScheduleQuery.data.capturedAt).toLocaleString()} ·
                    source: {pricingScheduleQuery.data.source} · expires {new Date(pricingScheduleQuery.data.expiresAt).toLocaleString()}
                  </div>
                ) : pricingScheduleQuery.isLoading ? (
                  <div className="text-muted-foreground">Loading reviewed pricing schedule…</div>
                ) : (
                  <div className="text-destructive">Pricing unavailable — provider selection is blocked.</div>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Paid providers to allow (selecting a provider here only proposes it — the server independently rejects any provider missing its API secret or a recorded pricing artifact):
              </div>
              <div className="flex flex-wrap gap-3">
                {(["serper", "outscraper", "openai", "apollo", "zerobounce"] as const).map((p) => {
                  const price = pricingScheduleQuery.data?.priceSchedules?.[p];
                  return (
                    <label key={p} className="flex items-center gap-1.5 text-xs">
                      <Checkbox
                        checked={!!newDefProviders[p]}
                        onCheckedChange={(checked) => setNewDefProviders((prev) => ({ ...prev, [p]: !!checked }))}
                      />
                      {p}
                      {price ? (
                        <span className="text-muted-foreground">
                          (${(price.amountMicros / 1_000_000).toFixed(4)}/{price.unitType})
                        </span>
                      ) : pricingScheduleQuery.isError ? (
                        <span className="text-destructive">(pricing unavailable)</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <Button size="sm" disabled={createDefMutation.isPending || !newDefSourceAdapters.trim()} onClick={() => createDefMutation.mutate()}>Create Definition</Button>
        </div>
      </div>

      {/* Active pilot runs */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">Pilot Runs ({runs.length})</h3>
        {runs.length === 0 && <p className="text-xs text-muted-foreground">No pilot runs yet. Complete the preflight checklist first.</p>}
        {runs.map((r: any) => (
          <div key={r.id} className="rounded border p-3 text-xs space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold font-mono">Level {r.level} — {r.id?.slice(0, 8)}…</span>
              <StateBadge state={r.state} />
            </div>
            <div className="text-muted-foreground">Started: {r.started_at ? new Date(r.started_at).toLocaleString() : "—"}</div>
            <div className="text-muted-foreground">Release SHA: {r.release_sha?.slice(0, 12)}…</div>
            {r.cohort_frozen_hash && <div className="text-muted-foreground">Cohort frozen: ✓ {String(r.cohort_frozen_hash).slice(0, 12)}…</div>}
            {r.stop_reason && <div className="text-red-600">Stop reason: {r.stop_reason}</div>}
            <div className="flex flex-wrap gap-2 pt-1">
              {r.state === "draft" && !r.cohort_frozen_hash && r.level === 1 && (
                <Button size="sm" variant="outline" disabled={selectRoiCohortMutation.isPending} onClick={() => selectRoiCohortMutation.mutate(r.id)}>
                  Select ROI Cohort (Level 1)
                </Button>
              )}
              {r.state === "draft" && !r.cohort_frozen_hash && r.level !== 1 && (
                <Button size="sm" variant="outline" disabled={selectCohortMutation.isPending} onClick={() => selectCohortMutation.mutate(r.id)}>Select &amp; Freeze Cohort</Button>
              )}
              {r.state === "draft" && r.cohort_frozen_hash && (
                <Button size="sm" onClick={() => transitionMutation.mutate({ runId: r.id, toState: "running" })}>Start Run</Button>
              )}
              {r.state === "running" && (
                <Button size="sm" disabled={executingRunId === r.id} onClick={() => runExecuteLoop(r.id)}>
                  {executingRunId === r.id ? "Executing…" : "Run Enrichment Phase"}
                </Button>
              )}
              {r.state === "running" && (
                <Button size="sm" variant="outline" onClick={() => transitionMutation.mutate({ runId: r.id, toState: "paused" })}>Pause</Button>
              )}
              {r.state === "paused" && (
                <Button size="sm" onClick={() => transitionMutation.mutate({ runId: r.id, toState: "running" })}>Resume</Button>
              )}
              {["running", "paused"].includes(r.state) && (
                <Button size="sm" variant="outline" onClick={() => transitionMutation.mutate({ runId: r.id, toState: "completed" })}>Mark Completed</Button>
              )}
              {["draft", "running", "paused"].includes(r.state) && (
                <Button size="sm" variant="destructive" onClick={() => transitionMutation.mutate({ runId: r.id, toState: "stopped", stopReason: "operator_stop" })}>Stop</Button>
              )}
              {r.level < 3 && ["running", "paused", "completed"].includes(r.state) && (
                <Button size="sm" variant="outline" onClick={() => advanceMutation.mutate({ runId: r.id, fromLevel: r.level, toLevel: r.level + 1 })}>
                  Advance to Level {r.level + 1}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => reconciliationMutation.mutate(r.id)}>Save Reconciliation Report</Button>
            </div>
          </div>
        ))}
        <div className="rounded border border-dashed p-3 space-y-2">
          <div className="text-xs font-semibold">Create pilot run</div>
          <div className="flex gap-2">
            <Select value={newRunDefId} onValueChange={setNewRunDefId}>
              <SelectTrigger className="h-8 text-xs w-64"><SelectValue placeholder="Choose definition" /></SelectTrigger>
              <SelectContent>
                {defs.map((d: any) => (
                  <SelectItem key={d.id} value={String(d.id)}>Level {d.level} — {String(d.pilot_definition_hash).slice(0, 10)}…</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" disabled={!newRunDefId || createRunMutation.isPending} onClick={() => createRunMutation.mutate()}>Create Run</Button>
          </div>
        </div>
      </div>

      {reconciliationReport?.reportData && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Reconciliation report</h3>
            <span className="text-xs text-muted-foreground font-mono">
              {reconciliationReport.reportData.pilotRun?.id} · {new Date(reconciliationReport.reportData.generatedAt).toLocaleString()}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            <div className="rounded border p-2"><div className="text-muted-foreground">Cohort</div><div className="font-semibold">{reconciliationReport.reportData.cohortComposition?.total ?? 0}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Commands</div><div className="font-semibold">{reconciliationReport.reportData.issuedCommands?.length ?? 0}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Operations</div><div className="font-semibold">{reconciliationReport.reportData.resultingOperations?.length ?? 0}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Receipts</div><div className="font-semibold">{reconciliationReport.reportData.receipts?.length ?? 0}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Settled spend</div><div className="font-semibold">{usdFromMicros(reconciliationReport.reportData.spend?.totalSettledMicros)}</div></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
            <div><div className="font-medium mb-1">Outcomes</div>{(reconciliationReport.reportData.outcomes ?? []).map((row: any) => <div key={row.outcome} className="flex justify-between border-b py-1"><span>{row.outcome}</span><span>{row.count}</span></div>)}</div>
            <div><div className="font-medium mb-1">Staging results</div>{(reconciliationReport.reportData.stagingResults ?? []).map((row: any) => <div key={row.disposition} className="flex justify-between border-b py-1"><span>{row.disposition}</span><span>{row.count}</span></div>)}</div>
            <div><div className="font-medium mb-1">Forbidden-effect check</div><div className={reconciliationReport.reportData.forbiddenEffectChecks?.passed ? "text-green-600" : "text-red-600"}>{reconciliationReport.reportData.forbiddenEffectChecks?.passed ? "Passed" : "Failed"}</div><div className="text-muted-foreground mt-1">{reconciliationReport.reportData.forbiddenEffectChecks?.note}</div></div>
          </div>
        </div>
      )}

      {/* CRO-08A schedules */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h3 className="font-semibold text-sm">CRO-08A Schedules</h3>
        <div className="text-xs text-muted-foreground">
          Activation requires the MI-09 pilot ladder (Levels 1–3) to be complete and the paid-provider approval to remain active. The certification-receipt ceremony was removed on 2026-09-13.
        </div>
        {(scheduleDefsQuery.data ?? []).map((s: any) => (
          <div key={s.id} className="rounded border p-2 text-xs flex items-center justify-between">
            <div>
              <div className="font-mono font-semibold">{s.logical_key} v{s.definition_version}</div>
              <div className="text-muted-foreground">{s.purpose}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded-full text-xs ${s.active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}`}>{s.active ? "active" : "inactive"}</span>
              {!s.active && <Button size="sm" variant="outline" onClick={() => activateScheduleMutation.mutate(s.id)}>Activate</Button>}
              {s.active && <Button size="sm" variant="destructive" onClick={() => deactivateScheduleMutation.mutate(s.id)}>Deactivate</Button>}
            </div>
          </div>
        ))}
        {(scheduleDefsQuery.data ?? []).length === 0 && <p className="text-xs text-muted-foreground">No CRO-08A schedule definitions yet.</p>}
      </div>

      <p className="text-xs text-muted-foreground">
        Pilot lifecycle is controlled through the MI-09 authority service. See{" "}
        <code className="font-mono">docs/cro03d-ceremony-runbook.md</code> for the full ceremony workflow.
        No secrets, credentials, or raw PII are displayed anywhere in this panel.
      </p>
    </div>
  );
}
