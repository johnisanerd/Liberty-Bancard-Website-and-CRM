import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, getCsrfToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Database, Shield, CheckCircle2, AlertCircle, Loader2, RefreshCw,
  TrendingUp, Users, BarChart3, Filter, ChevronLeft, ChevronRight,
  MessageSquareOff, ArrowUpCircle, Download, XCircle, GitMerge,
  Eye,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MasterLeadStats {
  total: number;
  byStatus: Array<{ status: string; count: number }>;
  bySource: Array<{ source: string; count: number }>;
  byFitTier: Array<{ fit_tier: string; count: number }>;
  byVertical: Array<{ vertical: string; count: number }>;
  suppressionReport: Array<{ suppression_reason: string; count: number }>;
}

interface MasterLead {
  id: string;
  status: string;
  company: string | null;
  domain: string | null;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  vertical: string | null;
  fitTier: string | null;
  qualityScore: number | null;
  source: string | null;
  emailValid: boolean | null;
  phoneValid: boolean | null;
  smsEligible: boolean | null;
  suppressionReason: string | null;
  promotedAt: string | null;
  createdAt: string;
}

interface SmsStatus {
  smsEligible: boolean;
  ghlPhoneNumberIdSet: boolean;
  a2pRegistrationIdSet: boolean;
  blockedReason: string | null;
}

// ─── Pipeline types ───────────────────────────────────────────────────────────

interface PipelineLead {
  id: string;
  status: string;
  company: string | null;
  normalizedCompany: string | null;
  domain: string | null;
  maskedEmail: string | null;
  emailType: string | null;
  phone: string | null;
  vertical: string | null;
  countyFips: string | null;
  qualityScore: number | null;
  fitTier: string | null;
  readinessReason: string | null;
  canonicalBusinessId: number | null;
  cro03GenerationId: string | null;
  openConflictCount: number;
  promotedAt: string | null;
  createdAt: string;
}

interface PipelineStats {
  staged: number;
  readyToPromote: number;
  suppressed: number;
  duplicates: number;
  promoted: number;
}

interface PromotionPreview {
  rows: Array<{ masterLeadId: string; company: string | null; blocker: string | null; eligible: boolean }>;
  eligibleCount: number;
  blockedCount: number;
}

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  staged:                    { label: "Staged",                  color: "text-slate-700",  bg: "bg-slate-100" },
  imported:                  { label: "Imported",                color: "text-blue-700",   bg: "bg-blue-100" },
  duplicate:                 { label: "Duplicate",               color: "text-amber-700",  bg: "bg-amber-100" },
  suppressed:                { label: "Suppressed",              color: "text-red-700",    bg: "bg-red-100" },
  needs_website_check:       { label: "Needs Website Check",     color: "text-orange-700", bg: "bg-orange-100" },
  needs_mx_verification:     { label: "Needs MX Verify",         color: "text-orange-700", bg: "bg-orange-100" },
  ready_for_internal_test:   { label: "Ready (Internal Test)",   color: "text-indigo-700", bg: "bg-indigo-100" },
  ready_for_controlled_cohort: { label: "Ready (Cohort)",        color: "text-green-700",  bg: "bg-green-100" },
  enrolled:                  { label: "Enrolled",                color: "text-emerald-700",bg: "bg-emerald-100" },
  paused:                    { label: "Paused",                  color: "text-yellow-700", bg: "bg-yellow-100" },
  bounced:                   { label: "Bounced",                 color: "text-red-700",    bg: "bg-red-100" },
  unsubscribed:              { label: "Unsubscribed",            color: "text-gray-700",   bg: "bg-gray-100" },
  client_customer:           { label: "Client / Customer",       color: "text-purple-700", bg: "bg-purple-100" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, color: "text-gray-700", bg: "bg-gray-100" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cfg.bg} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ─── Mini bar chart ───────────────────────────────────────────────────────────

function BarBreakdown({ rows, labelKey, countKey, maxRows = 10 }: {
  rows: Record<string, any>[];
  labelKey: string;
  countKey: string;
  maxRows?: number;
}) {
  if (!rows || rows.length === 0) return <p className="text-xs text-muted-foreground">No data</p>;
  const total = rows.reduce((s, r) => s + (Number(r[countKey]) || 0), 0);
  return (
    <div className="space-y-1.5">
      {rows.slice(0, maxRows).map((r) => {
        const pct = total > 0 ? Math.round((Number(r[countKey]) / total) * 100) : 0;
        return (
          <div key={r[labelKey]} className="space-y-0.5">
            <div className="flex justify-between text-xs">
              <span className="truncate max-w-[60%]">{r[labelKey] ?? "(none)"}</span>
              <span className="text-muted-foreground shrink-0">{Number(r[countKey]).toLocaleString()} ({pct}%)</span>
            </div>
            <div className="w-full bg-muted rounded-full h-1.5">
              <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
      {rows.length > maxRows && (
        <p className="text-xs text-muted-foreground">+{rows.length - maxRows} more</p>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

// ─── Fit tier badge ───────────────────────────────────────────────────────────

function FitTierBadge({ tier }: { tier: string | null }) {
  const colors: Record<string, string> = {
    A: "bg-emerald-100 text-emerald-800",
    B: "bg-blue-100 text-blue-800",
    C: "bg-amber-100 text-amber-700",
  };
  const cls = colors[tier ?? ""] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${cls}`}>
      {tier ?? "—"}
    </span>
  );
}

// ─── Pipeline Review Tab ──────────────────────────────────────────────────────
// Exported so LeadOpsCenter (MI-08 Staging tab) can embed it without
// duplicating the component. The /dashboard/master-lead-database route is
// preserved unchanged — this is a re-export, not a removal.

export function PipelineReviewTab() {
  const { toast } = useToast();
  const [pipelineStatusFilter, setPipelineStatusFilter] = useState("staged");
  const [pipelineFitTier, setPipelineFitTier] = useState("all");
  const [pipelinePage, setPipelinePage] = useState(0);
  const [bulkPreviewGenerationId, setBulkPreviewGenerationId] = useState("");
  const [showBulkPreviewDialog, setShowBulkPreviewDialog] = useState(false);
  const [bulkPreviewData, setBulkPreviewData] = useState<PromotionPreview | null>(null);
  const [promotingPipelineId, setPromotingPipelineId] = useState<string | null>(null);
  const PIPELINE_PAGE_SIZE = 50;

  const { data: pipelineStats, refetch: refetchPipelineStats } = useQuery<PipelineStats>({
    queryKey: ["/api/master-leads/pipeline-stats"],
    queryFn: async () => {
      const r = await fetch("/api/master-leads/pipeline-stats", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load pipeline stats");
      return r.json();
    },
  });

  const pipelineParams = new URLSearchParams({
    status: pipelineStatusFilter,
    ...(pipelineFitTier !== "all" && { fitTier: pipelineFitTier }),
    page: String(pipelinePage),
    limit: String(PIPELINE_PAGE_SIZE),
  });

  const { data: pipelineLeads, isLoading: pipelineLoading, refetch: refetchPipeline } = useQuery<{
    leads: PipelineLead[]; total: number;
  }>({
    queryKey: ["/api/master-leads/pipeline", pipelineStatusFilter, pipelineFitTier, pipelinePage],
    queryFn: async () => {
      const r = await fetch(`/api/master-leads/pipeline?${pipelineParams}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load pipeline leads");
      return r.json();
    },
  });

  const promotePipelineMutation = useMutation({
    mutationFn: async (masterLeadId: string) => {
      const csrf = getCsrfToken();
      const r = await fetch(`/api/master-leads/pipeline/${masterLeadId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        credentials: "include",
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: "Failed" }));
        throw new Error(`${err.code ?? ""}: ${err.message ?? "Promotion failed"}`);
      }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Lead promoted to contact (local_only mode)" });
      setPromotingPipelineId(null);
      refetchPipeline();
      refetchPipelineStats();
    },
    onError: (err: Error) => {
      toast({ title: "Promotion failed", description: err.message, variant: "destructive" });
      setPromotingPipelineId(null);
    },
  });

  const suppressPipelineMutation = useMutation({
    mutationFn: async (masterLeadId: string) => {
      const csrf = getCsrfToken();
      const r = await fetch(`/api/master-leads/pipeline/${masterLeadId}/suppress`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        credentials: "include",
        body: JSON.stringify({ reason: "admin_suppressed" }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: "Failed" }));
        throw new Error(err.message ?? "Suppress failed");
      }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Lead suppressed" });
      refetchPipeline();
      refetchPipelineStats();
    },
    onError: (err: Error) => {
      toast({ title: "Suppress failed", description: err.message, variant: "destructive" });
    },
  });

  const bulkPreviewMutation = useMutation({
    mutationFn: async (generationId: string) => {
      const r = await fetch(`/api/master-leads/generations/${generationId}/promotion-preview`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load preview");
      return r.json() as Promise<PromotionPreview>;
    },
    onSuccess: (data) => {
      setBulkPreviewData(data);
      setShowBulkPreviewDialog(true);
    },
    onError: (err: Error) => {
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    },
  });

  const bulkPromoteMutation = useMutation({
    mutationFn: async (generationId: string) => {
      const csrf = getCsrfToken();
      const r = await fetch(`/api/master-leads/generations/${generationId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        credentials: "include",
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error("Bulk promote failed");
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: `Promoted ${data.promotedCount} leads`, description: `${data.blockedCount} blocked` });
      setShowBulkPreviewDialog(false);
      refetchPipeline();
      refetchPipelineStats();
    },
    onError: (err: Error) => {
      toast({ title: "Bulk promote failed", description: err.message, variant: "destructive" });
    },
  });

  const pipelineTotalPages = Math.ceil((pipelineLeads?.total ?? 0) / PIPELINE_PAGE_SIZE);

  return (
    <div className="space-y-4">
      {/* Pipeline stats counter */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "Staged", value: pipelineStats?.staged ?? 0, color: "text-blue-700" },
          { label: "Ready", value: pipelineStats?.readyToPromote ?? 0, color: "text-green-700" },
          { label: "Promoted", value: pipelineStats?.promoted ?? 0, color: "text-emerald-700" },
          { label: "Suppressed", value: pipelineStats?.suppressed ?? 0, color: "text-red-700" },
          { label: "Duplicates", value: pipelineStats?.duplicates ?? 0, color: "text-amber-700" },
        ].map(({ label, value, color }) => (
          <Card key={label}>
            <CardContent className="pt-3 pb-3">
              <p className={`text-xl font-bold ${color}`}>{value.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Bulk promote by generation */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <GitMerge className="h-4 w-4" />
            Bulk Promote by Generation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              placeholder="cro03_generation_id (UUID)"
              value={bulkPreviewGenerationId}
              onChange={(e) => setBulkPreviewGenerationId(e.target.value)}
              className="h-8 text-sm font-mono w-80"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!bulkPreviewGenerationId.trim() || bulkPreviewMutation.isPending}
              onClick={() => bulkPreviewMutation.mutate(bulkPreviewGenerationId.trim())}
            >
              {bulkPreviewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Eye className="h-4 w-4 mr-1" />}
              Preview
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Pipeline leads table */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Filter className="h-4 w-4" />
              Pipeline Leads
              {pipelineLeads && (
                <Badge variant="secondary" className="ml-1">{pipelineLeads.total.toLocaleString()}</Badge>
              )}
            </CardTitle>
            <Button size="sm" variant="outline" className="h-7" onClick={() => { refetchPipeline(); refetchPipelineStats(); }}>
              <RefreshCw className="h-3 w-3 mr-1" />
              Refresh
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            <Select value={pipelineStatusFilter} onValueChange={(v) => { setPipelineStatusFilter(v); setPipelinePage(0); }}>
              <SelectTrigger className="h-8 text-sm w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="staged">Staged</SelectItem>
                <SelectItem value="promoted">Promoted</SelectItem>
                <SelectItem value="suppressed">Suppressed</SelectItem>
                <SelectItem value="duplicate">Duplicate</SelectItem>
              </SelectContent>
            </Select>
            <Select value={pipelineFitTier} onValueChange={(v) => { setPipelineFitTier(v); setPipelinePage(0); }}>
              <SelectTrigger className="h-8 text-sm w-28">
                <SelectValue placeholder="All tiers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tiers</SelectItem>
                <SelectItem value="A">A</SelectItem>
                <SelectItem value="B">B</SelectItem>
                <SelectItem value="C">C</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="hidden md:table-cell">Vertical</TableHead>
                  <TableHead className="hidden lg:table-cell">County</TableHead>
                  <TableHead className="hidden lg:table-cell">Score</TableHead>
                  <TableHead className="hidden md:table-cell">Readiness</TableHead>
                  <TableHead>Conflicts</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pipelineLoading ? (
                  [...Array(5)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(9)].map((_, j) => (
                        <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse w-20" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : !pipelineLeads?.leads?.length ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      No pipeline leads found
                    </TableCell>
                  </TableRow>
                ) : (
                  pipelineLeads.leads.map((lead) => (
                    <TableRow key={lead.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium text-sm truncate max-w-[180px]">{lead.company ?? "—"}</p>
                          {lead.domain && <p className="text-xs text-muted-foreground">{lead.domain}</p>}
                        </div>
                      </TableCell>
                      <TableCell><FitTierBadge tier={lead.fitTier} /></TableCell>
                      <TableCell>
                        <div>
                          <p className="text-xs font-mono">{lead.maskedEmail ?? "—"}</p>
                          {lead.emailType && (
                            <span className="text-xs text-green-600">{lead.emailType}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">{lead.vertical ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">{lead.countyFips ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">{lead.qualityScore != null ? lead.qualityScore.toFixed(0) : "—"}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {lead.readinessReason && (
                          <span className="text-xs font-mono bg-muted px-1 rounded">{lead.readinessReason}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {lead.openConflictCount > 0 ? (
                          <Badge variant="destructive" className="text-xs">{lead.openConflictCount}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {lead.status === "staged" && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs text-green-700 border-green-300 hover:bg-green-50"
                                    disabled={lead.openConflictCount > 0 || promotePipelineMutation.isPending}
                                    onClick={() => setPromotingPipelineId(lead.id)}
                                  >
                                    <ArrowUpCircle className="h-3 w-3 mr-1" />
                                    Promote
                                  </Button>
                                </TooltipTrigger>
                                {lead.openConflictCount > 0 && (
                                  <TooltipContent>
                                    <p>Cannot promote — {lead.openConflictCount} open conflict(s)</p>
                                  </TooltipContent>
                                )}
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {lead.status === "staged" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-red-600 hover:bg-red-50"
                              disabled={suppressPipelineMutation.isPending}
                              onClick={() => suppressPipelineMutation.mutate(lead.id)}
                            >
                              <XCircle className="h-3 w-3 mr-1" />
                              Suppress
                            </Button>
                          )}
                          {lead.status === "promoted" && (
                            <span className="text-xs text-emerald-600 flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              Promoted
                            </span>
                          )}
                          {lead.status === "suppressed" && (
                            <span className="text-xs text-red-500">Suppressed</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {pipelineTotalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-xs text-muted-foreground">
                Page {pipelinePage + 1} of {pipelineTotalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7" onClick={() => setPipelinePage(p => p - 1)} disabled={pipelinePage === 0}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" className="h-7" onClick={() => setPipelinePage(p => p + 1)} disabled={pipelinePage >= pipelineTotalPages - 1}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pipeline promote confirmation */}
      <AlertDialog open={!!promotingPipelineId} onOpenChange={(open) => { if (!open) setPromotingPipelineId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ArrowUpCircle className="h-5 w-5 text-green-600" />
              Promote Pipeline Lead to Contact?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will create a new <strong>contacts</strong> row in <strong>local_only mode</strong> — no GHL sync,
              no sequence enrollment, no deal, no outbound effect of any kind.
              The contact will have <code>consent_tier=cold_no_consent</code>.
              <br /><br />
              This action is governed by preconditions (valid email, no open conflicts, no duplicate contact).
              If preconditions are unmet, the promotion returns a 422 with the specific blocker.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-green-600 hover:bg-green-700"
              onClick={() => { if (promotingPipelineId) promotePipelineMutation.mutate(promotingPipelineId); }}
              disabled={promotePipelineMutation.isPending}
            >
              {promotePipelineMutation.isPending
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Promoting…</>
                : "Yes, Promote to Contact"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk promote preview dialog */}
      <AlertDialog open={showBulkPreviewDialog} onOpenChange={setShowBulkPreviewDialog}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Bulk Promote Preview</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-green-700">{bulkPreviewData?.eligibleCount ?? 0}</p>
                    <p className="text-xs text-green-600">Eligible to promote</p>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-amber-700">{bulkPreviewData?.blockedCount ?? 0}</p>
                    <p className="text-xs text-amber-600">Blocked</p>
                  </div>
                </div>
                {(bulkPreviewData?.rows ?? []).filter(r => !r.eligible).length > 0 && (
                  <div>
                    <p className="text-xs font-medium mb-1">Blocked rows:</p>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {(bulkPreviewData?.rows ?? []).filter(r => !r.eligible).map(r => (
                        <div key={r.masterLeadId} className="flex justify-between text-xs bg-muted px-2 py-1 rounded">
                          <span className="truncate">{r.company ?? r.masterLeadId}</span>
                          <span className="text-red-600 shrink-0 ml-2">{r.blocker}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Only eligible rows will be promoted. Blocked rows are skipped with per-row reason codes.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-green-600 hover:bg-green-700"
              disabled={bulkPromoteMutation.isPending || (bulkPreviewData?.eligibleCount ?? 0) === 0}
              onClick={() => { if (bulkPreviewGenerationId) bulkPromoteMutation.mutate(bulkPreviewGenerationId.trim()); }}
            >
              {bulkPromoteMutation.isPending
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Promoting…</>
                : `Promote ${bulkPreviewData?.eligibleCount ?? 0} eligible`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function MasterLeadDatabase() {
  const { toast } = useToast();

  // Filters
  const [statusFilter, setStatusFilter] = useState("all");
  const [verticalFilter, setVerticalFilter] = useState("all");
  const [fitTierFilter, setFitTierFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Promotion dialog

  // Stats
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<MasterLeadStats>({
    queryKey: ["/api/master-leads/stats"],
    queryFn: async () => {
      const r = await fetch("/api/master-leads/stats", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load stats");
      return r.json();
    },
  });

  // SMS status
  const { data: smsStatus } = useQuery<SmsStatus>({
    queryKey: ["/api/master-leads/sms-status"],
    queryFn: async () => {
      const r = await fetch("/api/master-leads/sms-status", { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  // Lead list
  const leadsQueryParams = new URLSearchParams({
    ...(statusFilter !== "all" && { status: statusFilter }),
    ...(verticalFilter !== "all" && { vertical: verticalFilter }),
    ...(fitTierFilter !== "all" && { fitTier: fitTierFilter }),
    ...(sourceFilter !== "all" && { source: sourceFilter }),
    ...(search && { search }),
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });

  const { data: leadsData, isLoading: leadsLoading, refetch: refetchLeads } = useQuery<{
    rows: MasterLead[]; total: number;
  }>({
    queryKey: ["/api/master-leads/leads", statusFilter, verticalFilter, fitTierFilter, sourceFilter, search, page],
    queryFn: async () => {
      const r = await fetch(`/api/master-leads/leads?${leadsQueryParams}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load leads");
      return r.json();
    },
  });

  // Backfill progress
  const { data: backfillProgress, refetch: refetchBackfill } = useQuery<any>({
    queryKey: ["/api/master-leads/backfill-progress"],
    queryFn: async () => {
      const r = await fetch("/api/master-leads/backfill-progress", { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    refetchInterval: (q) => q.state.data?.status === "running" ? 3000 : false,
  });

  // Backfill trigger
  const backfillMutation = useMutation({
    mutationFn: async () => {
      const csrf = getCsrfToken();
      const r = await fetch("/api/master-leads/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json()).message);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Backfill started", description: "Existing contacts are being copied to master_leads…" });
      setTimeout(() => refetchBackfill(), 2000);
    },
    onError: (err: Error) => {
      toast({ title: "Backfill failed", description: err.message, variant: "destructive" });
    },
  });

  const totalLeads = stats?.total ?? 0;
  const stagedCount = stats?.byStatus.find(s => s.status === "staged")?.count ?? 0;
  const readyCount = (stats?.byStatus.find(s => s.status === "ready_for_internal_test")?.count ?? 0)
    + (stats?.byStatus.find(s => s.status === "ready_for_controlled_cohort")?.count ?? 0);
  const suppressedCount = stats?.byStatus.find(s => s.status === "suppressed")?.count ?? 0;
  const duplicateCount = stats?.byStatus.find(s => s.status === "duplicate")?.count ?? 0;

  const totalPages = Math.ceil((leadsData?.total ?? 0) / PAGE_SIZE);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageTitle className="text-2xl font-bold flex items-center gap-2">
            <Database className="h-6 w-6 text-blue-600" />
            Master Lead Database
          </PageTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Manual-import &amp; CRO-03 pipeline staging pool — deduped, suppressed, and status-tracked.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { refetchStats(); refetchLeads(); }}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Build the same filter params as the current view (#1079 — CSV export)
              const params = new URLSearchParams({
                ...(statusFilter !== "all" && { status: statusFilter }),
                ...(verticalFilter !== "all" && { vertical: verticalFilter }),
                ...(fitTierFilter !== "all" && { fitTier: fitTierFilter }),
                ...(sourceFilter !== "all" && { source: sourceFilter }),
                ...(search && { search }),
              });
              const a = document.createElement("a");
              a.href = `/api/master-leads/leads/export?${params}`;
              a.download = `master-leads-${statusFilter}-${new Date().toISOString().slice(0, 10)}.csv`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            }}
          >
            <Download className="h-4 w-4 mr-1" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending || backfillProgress?.status === "running"}
          >
            {backfillMutation.isPending || backfillProgress?.status === "running"
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <Download className="h-4 w-4 mr-1" />}
            Backfill Existing Contacts
          </Button>
        </div>
      </div>

      {/* Backfill progress bar */}
      {backfillProgress?.status === "running" && (
        <Card className="border-blue-200 bg-blue-50 dark:bg-blue-950/20">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-blue-600 shrink-0" />
              <div className="flex-1 space-y-1">
                <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
                  Backfill in progress — {(backfillProgress.processed ?? 0).toLocaleString()} / {(backfillProgress.total ?? 0).toLocaleString()} contacts processed
                </p>
                <Progress
                  value={backfillProgress.total > 0 ? (backfillProgress.processed / backfillProgress.total) * 100 : 0}
                  className="h-1.5"
                />
              </div>
              <span className="text-xs text-blue-700 shrink-0">
                {backfillProgress.inserted?.toLocaleString()} inserted
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* SMS blocked banner */}
      {smsStatus && !smsStatus.smsEligible && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-3">
              <MessageSquareOff className="h-5 w-5 text-amber-600 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  SMS Channel Blocked on All Leads
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                  {smsStatus.blockedReason} — SMS will remain blocked until both are set.
                  {!smsStatus.ghlPhoneNumberIdSet && " Missing: GHL_PHONE_NUMBER_ID."}
                  {!smsStatus.a2pRegistrationIdSet && " Missing: A2P_REGISTRATION_ID."}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Database className="h-8 w-8 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">{totalLeads.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Total Leads</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-8 w-8 text-green-500" />
              <div>
                <p className="text-2xl font-bold">{readyCount.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Ready for Outreach</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Shield className="h-8 w-8 text-red-500" />
              <div>
                <p className="text-2xl font-bold">{suppressedCount.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Suppressed</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-8 w-8 text-amber-500" />
              <div>
                <p className="text-2xl font-bold">{duplicateCount.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Duplicates</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Status breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              By Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="space-y-2">{[...Array(5)].map((_, i) => (
                <div key={i} className="h-4 bg-muted rounded animate-pulse" />
              ))}</div>
            ) : (
              <div className="space-y-1.5">
                {(stats?.byStatus ?? []).map(({ status, count }) => {
                  const pct = totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;
                  const cfg = STATUS_CONFIG[status] ?? { label: status, color: "text-gray-700", bg: "bg-gray-100" };
                  return (
                    <div key={status} className="space-y-0.5">
                      <div className="flex justify-between text-xs">
                        <button
                          className={`font-medium hover:underline ${cfg.color}`}
                          onClick={() => { setStatusFilter(status); setPage(0); }}
                        >
                          {cfg.label}
                        </button>
                        <span className="text-muted-foreground">{count.toLocaleString()} ({pct}%)</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5">
                        <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              By Source
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? <div className="h-32 bg-muted rounded animate-pulse" /> : (
              <BarBreakdown rows={stats?.bySource ?? []} labelKey="source" countKey="count" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" />
              By Fit Tier
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? <div className="h-32 bg-muted rounded animate-pulse" /> : (
              <BarBreakdown rows={stats?.byFitTier ?? []} labelKey="fit_tier" countKey="count" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Vertical breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            Vertical Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? <div className="h-24 bg-muted rounded animate-pulse" /> : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {(stats?.byVertical ?? []).slice(0, 8).map(({ vertical, count }) => (
                <div key={vertical} className="text-center p-3 bg-muted/40 rounded-lg">
                  <p className="text-lg font-bold">{count.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground truncate">{vertical}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Suppression report */}
      {(stats?.suppressionReport ?? []).length > 0 && (
        <Card className="border-red-200 dark:border-red-900">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-red-700 dark:text-red-400">
              <Shield className="h-4 w-4" />
              Suppression Report
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(stats?.suppressionReport ?? []).map(({ suppression_reason, count }) => (
                <div key={suppression_reason} className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                  <p className="text-lg font-bold text-red-700 dark:text-red-400">{count.toLocaleString()}</p>
                  <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">{suppression_reason}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Manual Import (Pipeline Review moved out to Lead Ops' Promotion Review
          subtab — this default export is now Master Leads only, per #1957). */}
      <Tabs defaultValue="manual-import">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="manual-import" className="flex items-center gap-1.5">
            <Download className="h-3.5 w-3.5" />
            Manual Import
          </TabsTrigger>
        </TabsList>

        <TabsContent value="manual-import">

      {/* Lead table with filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Filter className="h-4 w-4" />
              Lead Records
              {leadsData && (
                <Badge variant="secondary" className="ml-1">
                  {leadsData.total.toLocaleString()} total
                </Badge>
              )}
            </CardTitle>
            {statusFilter !== "all" && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7"
                onClick={() => { setStatusFilter("all"); setPage(0); }}
              >
                <XCircle className="h-3 w-3 mr-1" />
                Clear filters
              </Button>
            )}
          </div>

          {/* Filters row */}
          <div className="flex flex-wrap gap-2 mt-2">
            <Input
              placeholder="Search company, email, domain…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="h-8 text-sm w-48"
            />
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
              <SelectTrigger className="h-8 text-sm w-44">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={fitTierFilter} onValueChange={(v) => { setFitTierFilter(v); setPage(0); }}>
              <SelectTrigger className="h-8 text-sm w-36">
                <SelectValue placeholder="All fit tiers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All fit tiers</SelectItem>
                <SelectItem value="A">A</SelectItem>
                <SelectItem value="B">B</SelectItem>
                <SelectItem value="C">C</SelectItem>
                <SelectItem value="D">D</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); setPage(0); }}>
              <SelectTrigger className="h-8 text-sm w-44">
                <SelectValue placeholder="All sources" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="google_ads">Google Ads</SelectItem>
                <SelectItem value="sunbiz">Sunbiz</SelectItem>
                <SelectItem value="imported_list">Imported List</SelectItem>
                <SelectItem value="referral">Referral</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
                <SelectItem value="backfill">Backfill</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Company / Domain</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Fit Tier</TableHead>
                  <TableHead>Vertical</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-center">Email</TableHead>
                  <TableHead className="text-center">Phone</TableHead>
                  <TableHead className="text-center">SMS</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leadsLoading ? (
                  [...Array(8)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(10)].map((_, j) => (
                        <TableCell key={j}>
                          <div className="h-4 bg-muted rounded animate-pulse" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (leadsData?.rows ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                      No leads match the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  (leadsData?.rows ?? []).map((lead) => (
                    <TableRow key={lead.id}>
                      <TableCell className="font-medium">
                        <div className="max-w-[180px]">
                          <p className="truncate text-sm">{lead.company || "(no company)"}</p>
                          {lead.domain && (
                            <p className="text-xs text-muted-foreground truncate">{lead.domain}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="max-w-[160px]">
                          {lead.contactName && (
                            <p className="text-xs truncate">{lead.contactName}</p>
                          )}
                          {lead.email && (
                            <p className="text-xs text-muted-foreground truncate">{lead.email}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={lead.status} />
                        {lead.suppressionReason && (
                          <p className="text-xs text-red-600 mt-0.5">{lead.suppressionReason}</p>
                        )}
                      </TableCell>
                      <TableCell>
                        {lead.fitTier ? (
                          <Badge variant={lead.fitTier === "A" ? "default" : "secondary"} className="text-xs">
                            {lead.fitTier}
                          </Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[100px] truncate">
                        {lead.vertical ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {lead.source ?? "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        {lead.emailValid === true
                          ? <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" />
                          : lead.emailValid === false
                            ? <XCircle className="h-4 w-4 text-red-500 mx-auto" />
                            : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-center">
                        {lead.phoneValid === true
                          ? <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" />
                          : lead.phoneValid === false
                            ? <XCircle className="h-4 w-4 text-red-500 mx-auto" />
                            : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-center">
                        {smsStatus?.smsEligible && lead.smsEligible
                          ? <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" aria-label="SMS eligible" />
                          : <MessageSquareOff className="h-4 w-4 text-amber-500 mx-auto" aria-label={smsStatus?.blockedReason ?? "SMS blocked"} />}
                      </TableCell>
                      <TableCell className="text-right">
                        {lead.status === "ready_for_internal_test" && (
                          <span className="text-xs text-muted-foreground italic" title="Promotion now happens from the Promotion Review tab.">
                            Ready
                          </span>
                        )}
                        {lead.status === "ready_for_controlled_cohort" && (
                          <span className="text-xs text-green-600 flex items-center gap-1 justify-end">
                            <CheckCircle2 className="h-3 w-3" />
                            Cohort
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-xs text-muted-foreground">
                Showing {(page * PAGE_SIZE) + 1}–{Math.min((page + 1) * PAGE_SIZE, leadsData?.total ?? 0)} of {(leadsData?.total ?? 0).toLocaleString()}
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7" onClick={() => setPage(p => p - 1)} disabled={page === 0}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs">Page {page + 1} of {totalPages}</span>
                <Button size="sm" variant="outline" className="h-7" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

        </TabsContent>{/* end manual-import TabsContent */}
      </Tabs>
    </div>
  );
}
