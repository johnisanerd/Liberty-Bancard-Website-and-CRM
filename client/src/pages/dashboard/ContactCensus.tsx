import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  // Note: Select components retained for run filter controls below
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Play, Pause, Download, BarChart3, Eye, CheckCircle2, AlertTriangle, XCircle, GitMerge, ThumbsUp, ThumbsDown, RotateCcw, ShieldCheck, Filter, Zap, PhoneOff } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// ──────────────────────────────────────────────────────────────────────────────
// Quality signal types
// ──────────────────────────────────────────────────────────────────────────────
interface QualitySignalRow {
  code: string;
  severity: "critical" | "warning" | "info";
  description: string;
  instanceCount: number;
  contactCount: number;
  pct: number;
}

interface QualitySummary {
  runId: string;
  rulesVersion: string;
  status: string;
  environmentLabel: string;
  sourceCensusRunId: string;
  denominator: number;
  processedContacts: number;
  contactsWithAnySignal: number;
  qualitySignalInstances: number;
  suppressedCosmeticCandidates: number;
  historicalProposals: number;
  signals: QualitySignalRow[];
  completedAt: string | null;
  createdAt: string;
}

interface ReconCluster {
  id: string;
  cluster_key: string;
  cluster_reason: string;
  created_at: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
interface CensusRun {
  id: string;
  environment_label: string;
  rules_version: string;
  release_sha: string;
  db_identity_token: string;
  requested_by: string;
  status: string;
  pause_reason: string | null;
  denominator_at_start: number | null;
  total_processed: number | null;
  total_excluded: number | null;
  provider_call_count: number;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  lane_counts: Record<string, number> | null;
  dimension_counts: Record<string, Record<string, number>> | null;
  is_active: boolean;
  pool_metrics_before: { totalCount: number; idleCount: number; waitingCount: number; at: string } | null;
  pool_metrics_during: { totalCount: number; idleCount: number; waitingCount: number; at: string } | null;
  pool_metrics_after: { totalCount: number; idleCount: number; waitingCount: number; at: string } | null;
}

interface Preview {
  totalActive: number;
  totalArchived: number;
  byRecordClass: Record<string, number>;
  byContactability: Record<string, number>;
  byEmailStatus: Record<string, number>;
  sharedPhoneContactCount: number;
  sharedPhoneDistinctValues: number;
  businessRows: number;
  poolMetrics: { totalCount: number; idleCount: number; waitingCount: number };
}

// ──────────────────────────────────────────────────────────────────────────────
// Environment badge
// ──────────────────────────────────────────────────────────────────────────────
function EnvBadge({ label }: { label: string }) {
  const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
    development_preview: { label: "Development Preview", variant: "secondary" },
    production_readonly_preview: { label: "Production Read-Only Preview", variant: "default" },
    frozen_production_snapshot: { label: "Frozen Production Snapshot", variant: "default" },
  };
  const info = map[label] ?? { label: label, variant: "secondary" as const };
  return (
    <Badge
      variant={info.variant}
      className={
        label === "frozen_production_snapshot"
          ? "bg-emerald-100 text-emerald-800 border-emerald-300"
          : label === "production_readonly_preview"
          ? "bg-blue-100 text-blue-800 border-blue-300"
          : "bg-gray-100 text-gray-700 border-gray-300"
      }
    >
      {info.label}
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: "bg-green-100 text-green-800",
    running: "bg-blue-100 text-blue-800 animate-pulse",
    paused: "bg-yellow-100 text-yellow-800",
    failed: "bg-red-100 text-red-800",
    cancelled:    "bg-gray-100 text-gray-600",
    pending:      "bg-gray-100 text-gray-600",
    interrupted:  "bg-orange-100 text-orange-800",
  };
  return <Badge className={map[status] ?? "bg-gray-100 text-gray-600"}>{status}</Badge>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Preview card
// ──────────────────────────────────────────────────────────────────────────────
function PreviewCard() {
  const { data, isLoading, refetch } = useQuery<Preview>({
    queryKey: ["/api/admin/census/preview"],
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base">Contact Inventory Preview</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {!data && isLoading ? (
          <p className="text-sm text-muted-foreground">Loading preview...</p>
        ) : data ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Tile label="Active Contacts" value={data.totalActive.toLocaleString()} />
            <Tile label="Archived" value={data.totalArchived.toLocaleString()} />
            <Tile label="Shared-Phone Contacts" value={data.sharedPhoneContactCount.toLocaleString()} />
            <Tile label="Business Rows" value={data.businessRows.toLocaleString()} />
            <Tile label="Email + Phone" value={(data.byContactability.email_and_phone ?? 0).toLocaleString()} />
            <Tile label="Email Only" value={(data.byContactability.email_only ?? 0).toLocaleString()} />
            <Tile label="Phone Only" value={(data.byContactability.phone_only ?? 0).toLocaleString()} />
            <Tile label="No Channel" value={(data.byContactability.no_usable_channel ?? 0).toLocaleString()} />
            <Tile
              label="Pool (idle/total/waiting)"
              value={`${data.poolMetrics.idleCount}/${data.poolMetrics.totalCount}/${data.poolMetrics.waitingCount}`}
              warn={data.poolMetrics.waitingCount > 0}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Tile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warn ? "border-red-300 bg-red-50" : "border-gray-200 bg-gray-50"}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold ${warn ? "text-red-700" : ""}`}>{value}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Start-run form
// ──────────────────────────────────────────────────────────────────────────────
function StartRunPanel({ onStarted }: { onStarted: (runId: string) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Environment label is derived server-side — the server reads NODE_ENV + RELEASE_SHA.
  // We fetch it here only to display it; the client never sends it.
  const { data: envData } = useQuery<{ environmentLabel: string }>({
    queryKey: ["/api/admin/census/environment"],
    staleTime: 60_000,
  });

  const startMutation = useMutation({
    // No body needed — server derives environment label from runtime config
    mutationFn: () => apiRequest("POST", "/api/admin/census/runs", {}),
    onSuccess: async (res) => {
      const data = await res.json();
      toast({ title: "Census run started", description: `Run ID: ${data.runId.slice(0, 8)}…` });
      qc.invalidateQueries({ queryKey: ["/api/admin/census/runs"] });
      onStarted(data.runId);
    },
    onError: (err: any) => {
      toast({ title: "Failed to start run", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Play className="h-4 w-4" /> Start Census Run
        </CardTitle>
        <CardDescription>
          Admin-triggered only. BACKGROUND_JOB_PROFILE must be <code>off</code>.
          No canonical records are mutated. Environment label is determined by
          server configuration (NODE_ENV + RELEASE_SHA).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3 items-center">
        {envData && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-medium">Environment:</span>
            <EnvBadge label={envData.environmentLabel} />
          </div>
        )}
        <Button
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending}
          className="gap-2 ml-auto"
        >
          <Play className="h-4 w-4" />
          {startMutation.isPending ? "Starting…" : "Start Census"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Runs list
// ──────────────────────────────────────────────────────────────────────────────
function RunsList({ selectedRunId, onSelect }: { selectedRunId: string | null; onSelect: (id: string) => void }) {
  const { data, isLoading } = useQuery<{ runs: CensusRun[]; total: number }>({
    queryKey: ["/api/admin/census/runs"],
    refetchInterval: 5_000, // poll while runs are active
  });

  if (isLoading) return <p className="text-sm text-muted-foreground py-4">Loading runs…</p>;
  if (!data?.runs.length) return <p className="text-sm text-muted-foreground py-4">No census runs yet.</p>;

  return (
    <div className="space-y-2">
      {data.runs.map((run) => (
        <div
          key={run.id}
          className={`rounded-lg border p-3 cursor-pointer transition-colors ${
            selectedRunId === run.id ? "border-primary bg-primary/5" : "border-gray-200 hover:bg-gray-50"
          }`}
          onClick={() => onSelect(run.id)}
        >
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={run.status} />
                <EnvBadge label={run.environment_label} />
                <span className="text-xs text-muted-foreground">v{run.rules_version}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {new Date(run.created_at).toLocaleString()} · {run.requested_by}
              </p>
              {run.denominator_at_start && (
                <p className="text-xs mt-0.5">
                  {run.total_processed?.toLocaleString() ?? "—"} / {run.denominator_at_start.toLocaleString()} contacts
                </p>
              )}
            </div>
            <code className="text-xs text-muted-foreground shrink-0">{run.id.slice(0, 8)}…</code>
          </div>
          {run.failure_reason && (
            <p className="text-xs text-red-600 mt-1">{run.failure_reason}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Run detail panel
// ──────────────────────────────────────────────────────────────────────────────
function RunDetail({ runId }: { runId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: run, isLoading } = useQuery<CensusRun>({
    queryKey: [`/api/admin/census/runs/${runId}`],
    refetchInterval: (query) => query.state.data?.status === "running" ? 3_000 : false,
  });

  const { data: dimensions } = useQuery({
    queryKey: [`/api/admin/census/runs/${runId}/dimensions`],
    enabled: !!run && ["completed", "paused", "failed"].includes(run.status),
  });

  const { data: reconciliation } = useQuery({
    queryKey: [`/api/admin/census/runs/${runId}/reconciliation`],
    enabled: !!run && run.status !== "pending",
  });

  const { data: laneData } = useQuery<{ primary_lane: string; count: string }[]>({
    queryKey: [`/api/admin/census/runs/${runId}/lanes`],
    enabled: !!run && run.status !== "pending",
  });

  const pauseMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/census/runs/${runId}/pause`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [`/api/admin/census/runs/${runId}`] }); },
  });

  const resumeMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/census/runs/${runId}/resume`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [`/api/admin/census/runs/${runId}`] }); },
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/census/runs/${runId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/census/runs"] });
      qc.invalidateQueries({ queryKey: [`/api/admin/census/runs/${runId}`] });
      toast({ title: "Run cancelled" });
    },
  });

  const forceCancelMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/census/runs/${runId}/force-cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/census/runs"] });
      qc.invalidateQueries({ queryKey: [`/api/admin/census/runs/${runId}`] });
      toast({ title: "Run force-cancelled" });
    },
    onError: (e: Error) =>
      toast({ title: "Force cancel failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !run) return <p className="text-sm text-muted-foreground py-4">Loading run details…</p>;

  const recon = reconciliation as any;
  const dimData = dimensions as any;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={run.status} />
            <EnvBadge label={run.environment_label} />
          </div>
          <p className="text-xs text-muted-foreground">
            Run {run.id.slice(0, 8)}… · v{run.rules_version} · SHA {run.release_sha.slice(0, 8)} · DB token {run.db_identity_token}
          </p>
          <p className="text-xs text-muted-foreground">
            Started {new Date(run.created_at).toLocaleString()} by {run.requested_by}
          </p>
          {run.pause_reason && (
            <p className="text-xs text-yellow-700 bg-yellow-50 px-2 py-1 rounded">{run.pause_reason}</p>
          )}
          {run.failure_reason && (
            <p className="text-xs text-red-700 bg-red-50 px-2 py-1 rounded">{run.failure_reason}</p>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {run.status === "running" && (
            <Button size="sm" variant="outline" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
              <Pause className="h-3 w-3 mr-1" /> Pause
            </Button>
          )}
          {run.status === "paused" && (
            <Button size="sm" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
              <Play className="h-3 w-3 mr-1" /> Resume
            </Button>
          )}
          {["running", "paused", "pending"].includes(run.status) && (
            <Button size="sm" variant="destructive" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}>
              <XCircle className="h-3 w-3 mr-1" /> Cancel
            </Button>
          )}
          {run.status === "running" && (() => {
            const updatedAt = new Date(run.updated_at ?? run.created_at);
            const isStuck = (Date.now() - updatedAt.getTime()) > 5 * 60 * 1000;
            return isStuck ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="destructive" disabled={forceCancelMutation.isPending}>
                    <XCircle className="h-3 w-3 mr-1" /> Force Cancel
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Force-cancel this run?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will immediately cancel the run without waiting for the worker lease to expire.
                      Use this only when the worker has gone silent (no progress for &gt;5 minutes).
                      The action is logged to audit_logs.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep waiting</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => forceCancelMutation.mutate()}
                    >
                      Force cancel
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null;
          })()}
          {run.status === "completed" && (
            <Button size="sm" variant="outline" asChild>
              <a href={`/api/admin/census/runs/${runId}/export`} download>
                <Download className="h-3 w-3 mr-1" /> Export CSV
              </a>
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="lanes">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="lanes">Lane Breakdown</TabsTrigger>
          <TabsTrigger value="dimensions">Dimensions</TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
          <TabsTrigger value="pool">Pool Health</TabsTrigger>
        </TabsList>

        {/* Lane breakdown */}
        <TabsContent value="lanes" className="mt-4">
          {laneData && laneData.length > 0 ? (
            <div className="space-y-2">
              {laneData.map((row) => {
                const count = parseInt(row.count as any, 10);
                const total = run.total_processed ?? 1;
                const pct = ((count / total) * 100).toFixed(1);
                const isAlert = row.primary_lane === "UNCLASSIFIED_REVIEW";
                return (
                  <div key={row.primary_lane} className={`flex items-center gap-3 p-2 rounded ${isAlert ? "bg-red-50 border border-red-200" : ""}`}>
                    {isAlert && <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center">
                        <code className="text-xs font-medium truncate">{row.primary_lane}</code>
                        <span className="text-xs text-muted-foreground ml-2 shrink-0">{count.toLocaleString()} ({pct}%)</span>
                      </div>
                      <div className="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${isAlert ? "bg-red-500" : "bg-primary"}`}
                          style={{ width: `${Math.max(0.5, parseFloat(pct))}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No lane data yet.</p>
          )}
        </TabsContent>

        {/* Dimensions */}
        <TabsContent value="dimensions" className="mt-4">
          {dimData ? (
            <div className="grid md:grid-cols-2 gap-4">
              {Object.entries(dimData as Record<string, { value: string; count: string }[]>).map(([dim, rows]) => (
                <Card key={dim} className="border-gray-100">
                  <CardHeader className="pb-1 pt-3 px-4">
                    <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{dim.replace(/_/g, " ")}</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-3">
                    <table className="w-full text-xs">
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.value}>
                            <td className="py-0.5 font-mono">{r.value}</td>
                            <td className="py-0.5 text-right text-muted-foreground">{parseInt(r.count as any).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Dimensions available after run completes.</p>
          )}
        </TabsContent>

        {/* Reconciliation */}
        <TabsContent value="reconciliation" className="mt-4">
          {recon ? (
            <div className="space-y-3">
              <div className={`flex items-center gap-2 p-3 rounded-lg border ${recon.reconciles ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                {recon.reconciles ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                ) : (
                  <AlertTriangle className="h-5 w-5 text-red-600 shrink-0" />
                )}
                <div>
                  <p className={`text-sm font-medium ${recon.reconciles ? "text-green-800" : "text-red-800"}`}>
                    {recon.reconciles ? "Reconciliation PASS" : "Reconciliation FAIL"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    processed({recon.totalProcessed}) + excluded({recon.totalExcluded}) ={" "}
                    {(recon.totalProcessed ?? 0) + (recon.totalExcluded ?? 0)} / denominator({recon.denominator})
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <Tile label="Denominator" value={(recon.denominator ?? 0).toLocaleString()} />
                <Tile label="Processed" value={(recon.totalProcessed ?? 0).toLocaleString()} />
                <Tile label="Excluded" value={(recon.totalExcluded ?? 0).toLocaleString()} />
                <Tile label="Provider Calls" value={(recon.providerCallCount ?? 0).toString()} warn={(recon.providerCallCount ?? 0) > 0} />
              </div>
              {recon.mutationProofBefore && (
                <div className="text-xs font-mono bg-gray-50 rounded border p-3 overflow-x-auto">
                  <p className="font-semibold mb-1 font-sans">Mutation Proof (before → after)</p>
                  {Object.entries(recon.mutationProofBefore as Record<string, number>).map(([table, before]) => {
                    const after = (recon.mutationProofAfter as Record<string, number> | null)?.[table] ?? before;
                    const changed = after !== before;
                    return (
                      <p key={table} className={changed ? "text-red-600" : ""}>
                        {table}: {before} → {after} {changed ? "⚠" : "✓"}
                      </p>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Reconciliation available after processing starts.</p>
          )}
        </TabsContent>

        {/* Pool health */}
        <TabsContent value="pool" className="mt-4">
          <div className="space-y-3">
            {run.pool_metrics_before && (
              <PoolSnapshot label="Before Run" metrics={run.pool_metrics_before} />
            )}
            {run.pool_metrics_during && (
              <PoolSnapshot label="During Run (last checkpoint)" metrics={run.pool_metrics_during} />
            )}
            {run.pool_metrics_after && (
              <PoolSnapshot label="After Run" metrics={run.pool_metrics_after} />
            )}
            {!run.pool_metrics_before && <p className="text-sm text-muted-foreground">Pool metrics collected at run start.</p>}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PoolSnapshot({ label, metrics }: { label: string; metrics: { totalCount: number; idleCount: number; waitingCount: number; at: string } }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-semibold mb-2">{label} <span className="text-muted-foreground font-normal">— {new Date(metrics.at).toLocaleTimeString()}</span></p>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Tile label="Total" value={String(metrics.totalCount)} />
        <Tile label="Idle" value={String(metrics.idleCount)} />
        <Tile label="Waiting" value={String(metrics.waitingCount)} warn={metrics.waitingCount > 0} />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Reconciliation types
// ──────────────────────────────────────────────────────────────────────────────
interface ReconciliationRun {
  id: string;
  source_census_run_id: string;
  status: string;
  rules_version: string;
  failure_reason: string | null;
  total_processed: number | null;
  total_proposed: number | null;
  total_org_candidates: number | null;
  total_clusters: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  lane_counts: Record<string, number> | null;
  quality_flagged_contacts: number | null;
  quality_signal_instances: number | null;
  suppressed_cosmetic_candidates: number | null;
  quality_signal_counts: Record<string, number> | null;
}

interface ReconciliationProposal {
  id: number;
  contact_id: number;
  proposal_type: string;
  field_name: string;
  current_value: string | null;
  proposed_value: string;
  confidence: number;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Reconciliation sub-panels
// ──────────────────────────────────────────────────────────────────────────────
function ReconciliationRunsList({
  selectedRunId,
  onSelect,
}: {
  selectedRunId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useQuery<{ runs: ReconciliationRun[]; total: number }>({
    queryKey: ["/api/admin/reconciliation/runs"],
    refetchInterval: 5_000,
  });
  if (isLoading) return <p className="text-sm text-muted-foreground py-4">Loading runs…</p>;
  if (!data?.runs.length)
    return <p className="text-sm text-muted-foreground py-4">No reconciliation runs yet.</p>;
  return (
    <div className="space-y-2">
      {data.runs.map((run) => (
        <div
          key={run.id}
          className={`rounded-lg border p-3 cursor-pointer transition-colors ${
            selectedRunId === run.id ? "border-primary bg-primary/5" : "border-gray-200 hover:bg-gray-50"
          }`}
          onClick={() => onSelect(run.id)}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <StatusBadge status={run.status} />
              <p className="text-xs text-muted-foreground mt-1">
                {new Date(run.created_at).toLocaleString()}
              </p>
              {run.total_processed != null && (
                <p className="text-xs mt-0.5">
                  {run.total_processed.toLocaleString()} scanned ·{" "}
                  {run.rules_version === "quality-v1" ? (
                    (() => {
                      const flagged = run.quality_flagged_contacts ?? 0;
                      const pct = run.total_processed > 0 ? flagged / run.total_processed : 0;
                      const color =
                        pct > 0.25
                          ? "text-red-600 font-medium"
                          : pct > 0.1
                          ? "text-amber-600 font-medium"
                          : "text-muted-foreground";
                      return (
                        <span className={color}>Quality flags: {flagged.toLocaleString()}</span>
                      );
                    })()
                  ) : (
                    <span>{run.total_proposed?.toLocaleString() ?? 0} proposals</span>
                  )}
                </p>
              )}
              {run.rules_version === "quality-v1" && run.quality_signal_counts && Object.keys(run.quality_signal_counts).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
                  {Object.entries(run.quality_signal_counts)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5)
                    .map(([code, count]) => (
                      <span key={code} className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
                        {code}: <strong className="text-foreground">{count.toLocaleString()}</strong>
                      </span>
                    ))}
                  {Object.keys(run.quality_signal_counts).length > 5 && (
                    <span className="text-[10px] text-muted-foreground">
                      +{Object.keys(run.quality_signal_counts).length - 5} more
                    </span>
                  )}
                </div>
              )}
            </div>
            <code className="text-xs text-muted-foreground shrink-0">{run.id.slice(0, 8)}…</code>
          </div>
          {run.failure_reason && <p className="text-xs text-red-600 mt-1">{run.failure_reason}</p>}
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// DuplicateClustersSection — summary tiles + server-populated cluster list.
// Clusters are loaded from the identity crosswalk clusters endpoint rather than
// requiring the admin to know or paste a UUID.
// ──────────────────────────────────────────────────────────────────────────────
interface CrosswalkCluster {
  contact_id: number;
  source_count: number;
  sample_sources: string[];
  last_seen_at: string;
}

function DuplicateClustersSection({ runId, runData }: { runId: string; runData: ReconciliationRun }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Fix: use the selected reconciliation run's cluster endpoint, not the identity-crosswalk endpoint.
  const clustersQuery = useQuery<{ clusters: ReconCluster[]; total: number }>({
    queryKey: [`/api/admin/reconciliation/runs/${runId}/clusters?limit=30`],
    enabled: drawerOpen,
  });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Members Scanned" value={(runData.total_processed ?? 0).toLocaleString()} />
        <Tile label="Proposals" value={(runData.total_proposed ?? 0).toLocaleString()} />
        <Tile label="Org Candidates" value={(runData.total_org_candidates ?? 0).toLocaleString()} />
        {/* Clickable Duplicate Clusters tile — loads list from reconciliation run */}
        <button
          onClick={() => setDrawerOpen((o) => !o)}
          className={`rounded-xl border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${drawerOpen ? "bg-muted/40 border-primary/40" : "bg-card border-border"}`}
          title="Click to view identity collision clusters"
        >
          <div className="text-[11px] text-muted-foreground mb-1 font-medium">Identity Collision Review</div>
          <div className="text-lg font-bold flex items-center gap-2">
            {(runData.total_clusters ?? 0).toLocaleString()}
            <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
        </button>
      </div>

      {/* Cluster list drawer — populated from /api/admin/reconciliation/runs/:runId/clusters */}
      {drawerOpen && (
        <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Identity Collision Clusters</p>
            <button onClick={() => setDrawerOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">✕ Close</button>
          </div>
          {clustersQuery.isLoading && (
            <p className="text-xs text-muted-foreground">Loading clusters…</p>
          )}
          {clustersQuery.data && clustersQuery.data.clusters.length === 0 && (
            <p className="text-xs text-muted-foreground">No collision clusters found in this reconciliation run.</p>
          )}
          {clustersQuery.data && clustersQuery.data.clusters.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-1 pr-4 font-medium text-muted-foreground">Cluster Key</th>
                    <th className="text-left py-1 font-medium text-muted-foreground">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {clustersQuery.data.clusters.map((cl) => (
                    <tr key={cl.id} className="border-b border-border/40 hover:bg-muted/20">
                      <td className="py-1 pr-4 font-mono text-[10px]">{cl.cluster_key}</td>
                      <td className="py-1 text-muted-foreground">{cl.cluster_reason.replace(/_/g, " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {runData.lane_counts && (
        <div>
          <p className="text-xs font-semibold mb-2">Lane Breakdown</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {Object.entries(runData.lane_counts)
              .sort((a, b) => b[1] - a[1])
              .map(([lane, count]) => (
                <Tile key={lane} label={lane.replace(/_/g, " ")} value={count.toLocaleString()} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Quality breakdown panel for quality-v1 runs
// ──────────────────────────────────────────────────────────────────────────────
function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: "bg-red-100 text-red-800",
    warning: "bg-yellow-100 text-yellow-800",
    info: "bg-blue-100 text-blue-800",
  };
  return <Badge className={`text-xs ${map[severity] ?? "bg-gray-100 text-gray-600"}`}>{severity}</Badge>;
}

function QualityBreakdownPanel({ runId }: { runId: string }) {
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  const [memberCursor, setMemberCursor] = useState<number>(0);

  const { data, isLoading } = useQuery<QualitySummary>({
    queryKey: [`/api/admin/reconciliation/runs/${runId}/quality-summary`],
    refetchInterval: (q) =>
      q.state.data?.status === "running" ? 4_000 : false,
  });

  const { data: membersData, isLoading: membersLoading } = useQuery<{
    members: Array<{ contactId: number; firstName: string | null; lastName: string | null; companyName: string | null; signalCodes: string[] }>;
    nextCursor: number | null;
    hasMore: boolean;
  }>({
    queryKey: [`/api/admin/reconciliation/runs/${runId}/quality-members`, selectedSignal, memberCursor],
    queryFn: () => {
      const params = new URLSearchParams({ signal_code: selectedSignal!, limit: "50" });
      if (memberCursor) params.set("cursor", String(memberCursor));
      return apiRequest("GET", `/api/admin/reconciliation/runs/${runId}/quality-members?${params}`).then(r => r.json());
    },
    enabled: !!selectedSignal,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading quality summary…</p>;
  if (!data) return <p className="text-sm text-muted-foreground text-red-600">Quality summary not available for this run.</p>;

  const isQualityRun = data.rulesVersion === "quality-v1";
  if (!isQualityRun) {
    return (
      <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
        This is a legacy reconciliation run (rules_version: <code>{data.rulesVersion}</code>).
        Quality signals are available on runs started with <code>quality-v1</code>.
      </div>
    );
  }

  const denominator = data.denominator || 1;

  return (
    <div className="space-y-4">
      {/* Summary header */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="Processed Contacts" value={data.processedContacts.toLocaleString()} />
        <Tile
          label="Contacts w/ Any Signal"
          value={data.contactsWithAnySignal.toLocaleString()}
        />
        <Tile label="Signal Instances" value={data.qualitySignalInstances.toLocaleString()} />
        <Tile label="Suppressed Cosmetic" value={data.suppressedCosmeticCandidates.toLocaleString()} />
        <Tile label="Historical Proposals" value={data.historicalProposals.toLocaleString()} />
      </div>

      <div className="text-xs text-muted-foreground">
        Frozen census denominator: <strong>{data.denominator.toLocaleString()}</strong> contacts.
        Percentages are signal contacts / denominator.
      </div>

      {/* Quality signal breakdown table */}
      {data.signals.length === 0 ? (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          No quality signals emitted yet. Run may still be processing.
        </div>
      ) : (
        <div>
          <p className="text-sm font-semibold mb-2 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Quality Signal Breakdown
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-3 font-medium text-muted-foreground">Signal</th>
                  <th className="text-left py-2 pr-3 font-medium text-muted-foreground">Severity</th>
                  <th className="text-right py-2 pr-3 font-medium text-muted-foreground">Contacts</th>
                  <th className="text-right py-2 pr-3 font-medium text-muted-foreground">Instances</th>
                  <th className="text-right py-2 pr-3 font-medium text-muted-foreground">% of Census</th>
                  <th className="text-left py-2 font-medium text-muted-foreground">Description</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.signals.sort((a, b) => {
                  const sevOrder = { critical: 0, warning: 1, info: 2 };
                  return (sevOrder[a.severity] - sevOrder[b.severity]) || b.contactCount - a.contactCount;
                }).map((sig) => (
                  <tr key={sig.code} className="border-b border-border/40 hover:bg-muted/20">
                    <td className="py-2 pr-3 font-mono text-[11px]">{sig.code}</td>
                    <td className="py-2 pr-3"><SeverityBadge severity={sig.severity} /></td>
                    <td className="py-2 pr-3 text-right font-medium">{sig.contactCount.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right text-muted-foreground">{sig.instanceCount.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right">{((sig.contactCount / denominator) * 100).toFixed(1)}%</td>
                    <td className="py-2 pr-3 text-muted-foreground max-w-xs">{sig.description}</td>
                    <td className="py-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs gap-1"
                        onClick={() => { setSelectedSignal(sig.code); setMemberCursor(0); }}
                      >
                        <Filter className="h-3 w-3" /> View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Quality member drawer */}
      {selectedSignal && (
        <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold flex items-center gap-2">
              <Filter className="h-3 w-3" />
              Contacts with <code className="font-mono">{selectedSignal}</code>
            </p>
            <button
              onClick={() => setSelectedSignal(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >✕ Close</button>
          </div>
          {membersLoading ? (
            <p className="text-xs text-muted-foreground">Loading contacts…</p>
          ) : !membersData?.members.length ? (
            <p className="text-xs text-muted-foreground">No contacts found for this signal in this page.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-1 pr-3 font-medium text-muted-foreground">Contact ID</th>
                    <th className="text-left py-1 pr-3 font-medium text-muted-foreground">Name</th>
                    <th className="text-left py-1 pr-3 font-medium text-muted-foreground">Company</th>
                    <th className="text-left py-1 font-medium text-muted-foreground">All Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {membersData.members.map((m) => (
                    <tr key={m.contactId} className="border-b border-border/40 hover:bg-muted/20">
                      <td className="py-1 pr-3">
                        <a href={`/dashboard/contacts/${m.contactId}`} className="text-blue-600 hover:underline">
                          #{m.contactId}
                        </a>
                      </td>
                      <td className="py-1 pr-3">{[m.firstName, m.lastName].filter(Boolean).join(" ") || "—"}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{m.companyName || "—"}</td>
                      <td className="py-1">
                        <div className="flex flex-wrap gap-1">
                          {m.signalCodes.map((code) => (
                            <span key={code} className="px-1 py-0.5 rounded text-[9px] font-mono bg-blue-50 border border-blue-200">
                              {code}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {membersData.hasMore && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={() => setMemberCursor(membersData.nextCursor ?? 0)}
                >
                  Load more
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Remediation panel for quality-v1 runs
// ──────────────────────────────────────────────────────────────────────────────
interface RemediationOp {
  operationId?: string;
  status: string;
  alreadyRunning?: boolean;
  resultSummary?: Record<string, unknown>;
}

const REMEDIABLE_SIGNALS = [
  { code: "EMAIL_UNVALIDATED", label: "Unvalidated Emails", action: "validate_emails", description: "Pre-filter + send passing contacts to ZeroBounce for validation." },
  { code: "PHONE_PLACEHOLDER", label: "Fake / Placeholder Phones", action: "suppress_fake_phones", description: "Set do_not_auto_contact on contacts with placeholder or malformed phone numbers." },
];

const EXPORT_TYPES = [
  { type: "quality-signals", label: "All Quality Signals CSV" },
  { type: "shared-phone", label: "Shared Phone Clusters CSV" },
  { type: "shared-email", label: "Shared Email Clusters CSV" },
];

interface SuppressedFakePhonesData {
  total: number;
  hasMore: boolean;
  nextCursor: number | null;
  contacts: Array<{ id: number; name: string | null; email: string | null; phone: string | null; suppressedAt: string | null }>;
}
interface ValidateEmailsPreview {
  totalEligible: number;
  dnc_skipped: number;
  already_validated_skipped: number;
  locally_syntax_rejected: number;
  locally_placeholder_rejected: number;
  no_mx_authoritative: number;
  disposable_rejected: number;
  dns_indeterminate: number;
  max_zb_credits: number;
  unique_surviving_emails: number;
  crosswalk_relevant_count: number;
  capped_credit_count: number;
}

function RemediationPanel({ runId, signals }: { runId: string; signals: QualitySignalRow[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [opResults, setOpResults] = useState<Record<string, RemediationOp>>({});
  const [validatePreview, setValidatePreview] = useState<ValidateEmailsPreview | null>(null);
  const [showValidateDialog, setShowValidateDialog] = useState(false);
  const [creditCap, setCreditCap] = useState<number>(2000);

  const { data: suppressedData, isLoading: suppressedLoading } = useQuery<SuppressedFakePhonesData>({
    queryKey: ["/api/admin/contacts/suppressed-fake-phones"],
    queryFn: () => apiRequest("GET", "/api/admin/contacts/suppressed-fake-phones").then(r => r.json()),
    refetchInterval: 30_000,
  });

  const getSignalCount = (code: string) => signals.find(s => s.code === code)?.contactCount ?? 0;

  // Step 1: fetch dry-run preview (free — no ZeroBounce credits consumed)
  const previewMutation = useMutation({
    mutationFn: () =>
      apiRequest("GET", `/api/admin/reconciliation/runs/${runId}/remediation/validate-emails/preview?creditCap=${creditCap}`)
        .then(r => r.json() as Promise<ValidateEmailsPreview>),
    onSuccess: (data) => {
      setValidatePreview(data);
      setShowValidateDialog(true);
    },
    onError: () => toast({ title: "Error", description: "Could not load validation preview.", variant: "destructive" }),
  });

  // Step 2: actually launch ZeroBounce (only called after user confirms preview)
  const validateMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/admin/reconciliation/runs/${runId}/remediation/validate-emails`, { creditCap })
        .then(r => r.json() as Promise<RemediationOp>),
    onSuccess: (data) => {
      setOpResults(prev => ({ ...prev, validate_emails: data }));
      setShowValidateDialog(false);
      toast({ title: "Email validation triggered", description: data.alreadyRunning ? "Existing operation returned." : "Pre-filter completed; passing contacts sent to ZeroBounce." });
    },
    onError: () => toast({ title: "Error", description: "Failed to trigger email validation.", variant: "destructive" }),
  });

  const suppressMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/admin/reconciliation/runs/${runId}/remediation/suppress-fake-phones`, {})
        .then(r => r.json() as Promise<RemediationOp>),
    onSuccess: (data) => {
      setOpResults(prev => ({ ...prev, suppress_fake_phones: data }));
      queryClient.invalidateQueries({ queryKey: [`/api/admin/reconciliation/runs/${runId}/quality-summary`] });
      toast({ title: "Fake phone suppression completed", description: `${(data.resultSummary?.suppressed as number) ?? 0} contacts suppressed.` });
    },
    onError: () => toast({ title: "Error", description: "Failed to suppress fake phones.", variant: "destructive" }),
  });

  return (
    <div className="space-y-5">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Bulk Remediation Actions</p>

      {/* Actionable signal cohorts */}
      <div className="space-y-3">
        {REMEDIABLE_SIGNALS.map((sig) => {
          const count = getSignalCount(sig.code);
          const opKey = sig.action;
          const opResult = opResults[opKey];

          return (
            <div key={sig.code} className="border rounded-lg p-3 space-y-2">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-xs font-semibold font-mono">{sig.code}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{sig.description}</p>
                  <p className="text-xs text-muted-foreground">{count.toLocaleString()} contact{count !== 1 ? "s" : ""} affected</p>
                </div>
                <div className="flex gap-2">
                  {/* Export button */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={() => {
                      const params = new URLSearchParams({ type: "quality-signals", signal_code: sig.code });
                      window.open(`/api/admin/reconciliation/runs/${runId}/export?${params}`);
                    }}
                  >
                    <Download className="h-3 w-3" /> Export CSV
                  </Button>

                  {/* Action button — destructive ones require confirmation */}
                  {sig.action === "suppress_fake_phones" ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 text-xs gap-1"
                          disabled={suppressMutation.isPending || count === 0}
                        >
                          <PhoneOff className="h-3 w-3" />
                          Suppress {count.toLocaleString()} contacts
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Suppress fake-phone contacts?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will set <code>do_not_auto_contact = true</code> on{" "}
                            <strong>{count.toLocaleString()}</strong> contacts with{" "}
                            <code>PHONE_PLACEHOLDER</code> or <code>PHONE_MALFORMED</code> signals.
                            Already-blocked contacts will be skipped. This does NOT set{" "}
                            <code>do_not_contact</code> and does NOT affect email channels.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground"
                            onClick={() => suppressMutation.mutate()}
                          >
                            Confirm — Suppress {count.toLocaleString()} contacts
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : (
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 text-xs gap-1"
                      disabled={previewMutation.isPending || validateMutation.isPending || count === 0}
                      onClick={() => previewMutation.mutate()}
                    >
                      <Zap className="h-3 w-3" />
                      {previewMutation.isPending ? "Analysing…" : validateMutation.isPending ? "Launching…" : `Validate ${count.toLocaleString()} emails`}
                    </Button>
                  )}
                </div>
              </div>

              {/* Result summary */}
              {opResult && (
                <div className="mt-2 p-2 rounded bg-muted/30 text-xs space-y-1">
                  <p className="font-medium">Operation result — status: <span className="font-mono">{opResult.status}</span></p>
                  {opResult.resultSummary && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-1 mt-1">
                      {Object.entries(opResult.resultSummary).filter(([k]) => typeof opResult.resultSummary![k] === "number").map(([k, v]) => (
                        <div key={k} className="flex flex-col">
                          <span className="text-muted-foreground text-[10px] font-mono">{k}</span>
                          <span className="font-semibold">{(v as number).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Live fake-phone suppression counter */}
      <div className="border rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <p className="text-xs font-semibold">Currently suppressed via fake-phone remediation</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Contacts with <code>suppression_reason = &apos;fake_phone_detected&apos;</code> and{" "}
              <code>do_not_auto_contact = true</code> across the entire CRM.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {suppressedLoading ? (
              <span className="text-xs text-muted-foreground">Loading…</span>
            ) : (
              <span className="text-sm font-semibold tabular-nums">
                {(suppressedData?.total ?? 0).toLocaleString()} contact{suppressedData?.total !== 1 ? "s" : ""}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              disabled={!suppressedData || suppressedData.total === 0}
              onClick={() => window.open("/api/admin/contacts/suppressed-fake-phones?format=csv")}
            >
              <Download className="h-3 w-3" /> Export CSV
            </Button>
          </div>
        </div>
        {suppressedData && suppressedData.contacts.length > 0 && (
          <div className="overflow-x-auto rounded border border-border/50 mt-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 text-left">
                  <th className="px-2 py-1 font-medium">ID</th>
                  <th className="px-2 py-1 font-medium">Name</th>
                  <th className="px-2 py-1 font-medium">Email</th>
                  <th className="px-2 py-1 font-medium">Phone</th>
                  <th className="px-2 py-1 font-medium">Suppressed at</th>
                </tr>
              </thead>
              <tbody>
                {suppressedData.contacts.map(c => (
                  <tr key={c.id} className="border-t border-border/30 hover:bg-muted/20">
                    <td className="px-2 py-1 font-mono text-[10px]">{c.id}</td>
                    <td className="px-2 py-1">{c.name ?? <span className="text-muted-foreground italic">—</span>}</td>
                    <td className="px-2 py-1 font-mono text-[10px]">{c.email ?? "—"}</td>
                    <td className="px-2 py-1 font-mono text-[10px]">{c.phone ?? "—"}</td>
                    <td className="px-2 py-1 text-muted-foreground">{c.suppressedAt ? new Date(c.suppressedAt).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {suppressedData.hasMore && (
              <p className="text-[10px] text-muted-foreground px-2 py-1">
                Showing first 50 of {suppressedData.total.toLocaleString()} — download CSV for full list.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Shared-identity exports */}
      <div>
        <p className="text-xs font-semibold mb-2">Export Cohorts</p>
        <div className="flex flex-wrap gap-2">
          {EXPORT_TYPES.map(({ type, label }) => (
            <Button
              key={type}
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              onClick={() => window.open(`/api/admin/reconciliation/runs/${runId}/export?type=${type}`)}
            >
              <Download className="h-3 w-3" /> {label}
            </Button>
          ))}
        </div>
      </div>

      {/* ZeroBounce validation cost-preview confirmation dialog */}
      <AlertDialog open={showValidateDialog} onOpenChange={setShowValidateDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Email Validation</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {validatePreview && (
                  <>
                    <p>The local pre-filter has analysed the unvalidated cohort. Review before spending ZeroBounce credits:</p>
                    <div className="rounded border bg-muted/40 p-3 space-y-1 text-xs font-mono">
                      <div className="flex justify-between"><span>Total evaluated</span><span className="font-semibold">{validatePreview.totalEligible.toLocaleString()}</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>DNC / blocked skipped</span><span>{validatePreview.dnc_skipped.toLocaleString()}</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>Already validated skipped</span><span>{validatePreview.already_validated_skipped.toLocaleString()}</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>Syntax rejected (local)</span><span>{validatePreview.locally_syntax_rejected.toLocaleString()}</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>Placeholder rejected (local)</span><span>{validatePreview.locally_placeholder_rejected.toLocaleString()}</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>No MX record (local)</span><span>{validatePreview.no_mx_authoritative.toLocaleString()}</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>Disposable domain (local)</span><span>{validatePreview.disposable_rejected.toLocaleString()}</span></div>
                      <div className="flex justify-between text-muted-foreground"><span>DNS indeterminate (local)</span><span>{validatePreview.dns_indeterminate.toLocaleString()}</span></div>
                      <div className="border-t pt-1 mt-1 flex justify-between font-semibold text-foreground">
                        <span>Passes all local gates</span>
                        <span>{validatePreview.max_zb_credits.toLocaleString()}</span>
                      </div>
                      {validatePreview.crosswalk_relevant_count > 0 && (
                        <div className="flex justify-between text-blue-600 font-semibold">
                          <span>↳ Crosswalk-relevant (ZB can improve match)</span>
                          <span>{validatePreview.crosswalk_relevant_count.toLocaleString()}</span>
                        </div>
                      )}
                    </div>

                    {/* Credit cap */}
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">Credit cap</label>
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="number"
                          min={1}
                          max={validatePreview.max_zb_credits}
                          value={creditCap}
                          onChange={e => {
                            const v = parseInt(e.target.value) || 1;
                            setCreditCap(Math.max(1, Math.min(validatePreview.max_zb_credits, v)));
                          }}
                          className="w-28 rounded border bg-background px-2 py-1 text-sm text-right font-mono"
                        />
                        <span className="text-xs text-muted-foreground">of {validatePreview.max_zb_credits.toLocaleString()} eligible</span>
                        {validatePreview.crosswalk_relevant_count > 0 && creditCap !== validatePreview.crosswalk_relevant_count && (
                          <button
                            type="button"
                            className="text-xs text-blue-600 underline underline-offset-2"
                            onClick={() => setCreditCap(validatePreview.crosswalk_relevant_count)}
                          >
                            Use crosswalk count ({validatePreview.crosswalk_relevant_count.toLocaleString()})
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Start small — confirm crosswalk match rate improves before expanding.
                        {validatePreview.crosswalk_relevant_count > 0 && (
                          <>{" "}<span className="text-blue-600">{validatePreview.crosswalk_relevant_count.toLocaleString()} contacts have unresolved crosswalk candidates</span> — those give the highest yield per credit.</>
                        )}
                      </p>
                    </div>

                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex justify-between items-center">
                      <span>Credits that will be consumed</span>
                      <span className="font-bold text-amber-700 font-mono">{Math.min(creditCap, validatePreview.max_zb_credits).toLocaleString()}</span>
                    </div>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={validateMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={validateMutation.isPending || (validatePreview?.max_zb_credits ?? 0) === 0}
              onClick={(e) => { e.preventDefault(); validateMutation.mutate(); }}
            >
              {validateMutation.isPending
                ? "Launching…"
                : `Approve — validate ${Math.min(creditCap, validatePreview?.max_zb_credits ?? 0).toLocaleString()} emails`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ReconciliationRunDetail({ runId }: { runId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ReconciliationRun>({
    queryKey: [`/api/admin/reconciliation/runs/${runId}`],
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return (s === "running" || s === "pending") ? 3_000 : false;
    },
  });

  const cancelReconMutation = useMutation({
    mutationFn: () =>
      apiRequest("DELETE", `/api/admin/reconciliation/runs/${runId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/reconciliation/runs"] });
      qc.invalidateQueries({ queryKey: [`/api/admin/reconciliation/runs/${runId}`] });
      toast({ title: "Reconciliation run cancelled" });
    },
    onError: (e: Error) =>
      toast({ title: "Cancel failed", description: e.message, variant: "destructive" }),
  });

  const forceReconCancelMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/admin/reconciliation/runs/${runId}/force-cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/reconciliation/runs"] });
      qc.invalidateQueries({ queryKey: [`/api/admin/reconciliation/runs/${runId}`] });
      toast({ title: "Reconciliation run force-cancelled" });
    },
    onError: (e: Error) =>
      toast({ title: "Force cancel failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const isQuality = data.rules_version === "quality-v1";
  const canCancel = ["running", "paused", "pending", "interrupted"].includes(data.status);
  const isReconStuck =
    data.status === "running" &&
    (Date.now() - new Date(data.updated_at ?? data.created_at).getTime()) > 5 * 60 * 1000;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <CardTitle className="text-base">Run {data.id.slice(0, 8)}…</CardTitle>
            <StatusBadge status={data.status} />
            {isQuality && (
              <Badge className="bg-purple-100 text-purple-800 text-xs">quality-v1</Badge>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
          {canCancel && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => cancelReconMutation.mutate()}
              disabled={cancelReconMutation.isPending}
            >
              <XCircle className="h-3 w-3 mr-1" /> Cancel run
            </Button>
          )}
          {isReconStuck && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive" disabled={forceReconCancelMutation.isPending}>
                  <XCircle className="h-3 w-3 mr-1" /> Force Cancel
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Force-cancel this run?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will immediately cancel the run without waiting for the worker lease to expire.
                    Use this only when the worker has gone silent (no progress for &gt;5 minutes).
                    The action is logged to audit_logs.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep waiting</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => forceReconCancelMutation.mutate()}
                  >
                    Force cancel
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          </div>
        </div>
        {data.status === "interrupted" && (
          <p className="text-xs text-orange-700 bg-orange-50 px-2 py-1 rounded mt-1">
            This run was interrupted by a server restart. Cancel it to start a new one.
          </p>
        )}
        <CardDescription className="text-xs">Census run: {data.source_census_run_id.slice(0, 8)}…</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isQuality ? (
          <Tabs defaultValue="quality">
            <TabsList className="flex-wrap h-auto gap-1">
              <TabsTrigger value="quality">Quality Signals</TabsTrigger>
              <TabsTrigger value="remediation">Remediation</TabsTrigger>
            </TabsList>
            <TabsContent value="quality" className="mt-3">
              <QualityBreakdownPanel runId={runId} />
            </TabsContent>
            <TabsContent value="remediation" className="mt-3">
              <RemediationPanelWrapper runId={runId} />
            </TabsContent>
          </Tabs>
        ) : (
          <DuplicateClustersSection runId={runId} runData={data} />
        )}
      </CardContent>
    </Card>
  );
}

function RemediationPanelWrapper({ runId }: { runId: string }) {
  const { data } = useQuery<QualitySummary>({
    queryKey: [`/api/admin/reconciliation/runs/${runId}/quality-summary`],
  });
  if (!data) return <p className="text-sm text-muted-foreground">Loading quality summary…</p>;
  return <RemediationPanel runId={runId} signals={data.signals ?? []} />;
}

// Keys must match the proposal_type values written by reconciliation-classifier.ts
const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  name_normalization: "Name",
  phone_normalization: "Phone",
  company_normalization: "Company Name",
};

function ProposalStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    approved: "bg-green-100 text-green-800",
    rejected: "bg-red-100 text-red-800",
    reverted: "bg-gray-100 text-gray-600",
    superseded: "bg-gray-100 text-gray-500",
  };
  return <Badge className={map[status] ?? "bg-gray-100 text-gray-600"}>{status}</Badge>;
}

function ReconciliationProposalsPanel({ runId }: { runId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const { data, isLoading } = useQuery<{ proposals: ReconciliationProposal[]; total: number; nextCursor: number | null }>({
    queryKey: [`/api/admin/reconciliation/runs/${runId}/proposals`, statusFilter, typeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "50" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("proposalType", typeFilter);
      return fetch(`/api/admin/reconciliation/runs/${runId}/proposals?${params}`).then((r) => r.json());
    },
    staleTime: 10_000,
  });

  const approve = useMutation({
    mutationFn: (id: number) =>
      apiRequest("POST", `/api/admin/reconciliation/proposals/${id}/approve`, {}).then((res) => res.json()),
    onSuccess: (data: any) => {
      if (data?.outcome === "applied") {
        toast({ title: "Proposal approved", description: `Field '${data.fieldName}' updated.` });
      } else if (data?.outcome === "stale") {
        toast({ title: "Proposal stale", description: data.reason ?? "Contact was modified after proposal was captured.", variant: "destructive" });
      } else if (data?.outcome === "already_reviewed") {
        toast({ title: "Already reviewed", description: "This proposal was already processed." });
      } else {
        toast({ title: "Approval not applied", description: data?.reason ?? "Unknown outcome.", variant: "destructive" });
      }
      qc.invalidateQueries({ queryKey: [`/api/admin/reconciliation/runs/${runId}/proposals`] });
    },
    onError: (err: any) => toast({ title: "Approval failed", description: err.message, variant: "destructive" }),
  });

  const reject = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/reconciliation/proposals/${id}/reject`, {}),
    onSuccess: () => {
      toast({ title: "Proposal rejected" });
      qc.invalidateQueries({ queryKey: [`/api/admin/reconciliation/runs/${runId}/proposals`] });
    },
    onError: (err: any) => toast({ title: "Rejection failed", description: err.message, variant: "destructive" }),
  });

  const revert = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/reconciliation/proposals/${id}/revert`, {}),
    onSuccess: () => {
      toast({ title: "Proposal reverted" });
      qc.invalidateQueries({ queryKey: [`/api/admin/reconciliation/runs/${runId}/proposals`] });
    },
    onError: (err: any) => toast({ title: "Revert failed", description: err.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <CardTitle className="text-base">Normalization Proposals</CardTitle>
          <span className="text-xs text-muted-foreground">{data?.total ?? 0} total</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["pending", "approved", "rejected", "reverted", "all"].map((s) => (
                <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All types</SelectItem>
              {Object.keys(PROPOSAL_TYPE_LABELS).map((t) => (
                <SelectItem key={t} value={t} className="text-xs">{PROPOSAL_TYPE_LABELS[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1"
            onClick={() => {
              const params = new URLSearchParams({ format: "csv" });
              if (statusFilter !== "all") params.set("status", statusFilter);
              if (typeFilter !== "all") params.set("proposalType", typeFilter);
              window.open(`/api/admin/reconciliation/runs/${runId}/proposals/export?${params}`);
            }}
          >
            <Download className="h-3 w-3" /> Export CSV
          </Button>
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading proposals…</p>
        ) : !data?.proposals.length ? (
          <p className="text-sm text-muted-foreground">No proposals match this filter.</p>
        ) : (
          <div className="space-y-2">
            {data.proposals.map((p) => (
              <div key={p.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs">{PROPOSAL_TYPE_LABELS[p.proposal_type] ?? p.proposal_type}</Badge>
                      <ProposalStatusBadge status={p.status} />
                      <span className="text-xs text-muted-foreground">contact #{p.contact_id}</span>
                      <span className="text-xs text-muted-foreground">confidence {p.confidence}%</span>
                    </div>
                    <p className="text-xs mt-1">
                      <span className="text-red-600 line-through mr-2">{p.current_value ?? "(empty)"}</span>
                      <span className="text-green-700 font-medium">{p.proposed_value}</span>
                    </p>
                  </div>
                  {p.status === "pending" && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs gap-1 text-green-700 border-green-300 hover:bg-green-50"
                        onClick={() => approve.mutate(p.id)}
                        disabled={approve.isPending}
                      >
                        <ThumbsUp className="h-3 w-3" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs gap-1 text-red-700 border-red-300 hover:bg-red-50"
                        onClick={() => reject.mutate(p.id)}
                        disabled={reject.isPending}
                      >
                        <ThumbsDown className="h-3 w-3" /> Reject
                      </Button>
                    </div>
                  )}
                  {p.status === "approved" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={() => revert.mutate(p.id)}
                      disabled={revert.isPending}
                    >
                      <RotateCcw className="h-3 w-3" /> Revert
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReconciliationTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: runsData } = useQuery<{ runs: ReconciliationRun[]; total: number }>({
    queryKey: ["/api/admin/reconciliation/runs"],
    refetchInterval: 5_000,
  });

  const { data: censusRuns } = useQuery<{ runs: { id: string; status: string; environment_label: string }[]; total: number }>({
    queryKey: ["/api/admin/census/runs"],
    staleTime: 30_000,
  });

  // quality-v1 flow: census-scoped preview → token → full run (no circular dependency)
  const [qualityPreviewToken, setQualityPreviewToken] = useState<string | null>(null);
  const [qualityPreviewResult, setQualityPreviewResult] = useState<Record<string, unknown> | null>(null);

  // Legacy reconciliation run (generates proposals)
  const startMutation = useMutation({
    mutationFn: (sourceCensusRunId: string) =>
      apiRequest("POST", `/api/admin/reconciliation/runs`, { sourceCensusRunId }),
    onSuccess: async (res) => {
      const data = await res.json();
      toast({ title: "Reconciliation run started", description: `Run ID: ${data.runId?.slice(0, 8)}…` });
      qc.invalidateQueries({ queryKey: ["/api/admin/reconciliation/runs"] });
      if (data.runId) setSelectedRunId(data.runId);
    },
    onError: (err: any) => toast({ title: "Failed to start run", description: err.message, variant: "destructive" }),
  });

  // Step 1: Run bounded preview directly on the census (no recon run needed).
  // POST /api/admin/reconciliation/quality-preview returns an acceptance token.
  const previewMutation = useMutation({
    mutationFn: async (censusRunId: string) => {
      const res = await apiRequest("POST", `/api/admin/reconciliation/quality-preview`, { censusRunId });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? "Preview failed"); }
      return res.json() as Promise<Record<string, unknown>>;
    },
    onSuccess: (data) => {
      setQualityPreviewToken(data.acceptanceToken as string);
      setQualityPreviewResult(data);
      toast({
        title: "Quality preview complete",
        description: `${data.contactsScanned} contacts sampled, ${data.contactsWithAnySignal} flagged. Review and start the full run.`,
      });
    },
    onError: (err: any) => toast({ title: "Preview failed", description: err.message, variant: "destructive" }),
  });

  // Step 2: Start full quality-v1 run using the acceptance token from the preview
  const startQualityFullMutation = useMutation({
    mutationFn: async ({ sourceCensusRunId, token }: { sourceCensusRunId: string; token: string }) => {
      const res = await apiRequest("POST", `/api/admin/reconciliation/runs`, {
        sourceCensusRunId,
        rulesVersion: "quality-v1",
        previewAcceptanceToken: token,
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? "Failed to start quality run"); }
      return res.json();
    },
    onSuccess: async (data) => {
      toast({ title: "Quality-v1 run started", description: `Run ID: ${data.runId?.slice(0, 8)}…` });
      qc.invalidateQueries({ queryKey: ["/api/admin/reconciliation/runs"] });
      if (data.runId) setSelectedRunId(data.runId);
      setQualityPreviewToken(null);
      setQualityPreviewResult(null);
    },
    onError: (err: any) => toast({ title: "Failed to start quality run", description: err.message, variant: "destructive" }),
  });

  const frozenCensus = censusRuns?.runs.find((r) => r.status === "completed");
  const hasRuns = (runsData?.runs?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      {!hasRuns && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <p>
            No reconciliation runs exist yet. Start a run below to classify contacts for remediation.
            A completed census run is required.
          </p>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <GitMerge className="h-4 w-4" /> Start Reconciliation Run
          </CardTitle>
          <CardDescription>
            Legacy mode generates normalization proposals. Quality-v1 mode classifies contacts with
            26 signal codes — requires a bounded preview review before starting the full run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {frozenCensus ? (
            <>
              <div className="text-sm text-muted-foreground">
                Using census run: <code className="text-xs">{frozenCensus.id.slice(0, 8)}…</code>{" "}
                <EnvBadge label={frozenCensus.environment_label} />
              </div>
              <div className="flex flex-wrap gap-3 items-center">
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => startMutation.mutate(frozenCensus.id)}
                  disabled={startMutation.isPending}
                >
                  <Play className="h-4 w-4" />
                  {startMutation.isPending ? "Starting…" : "Start Legacy Reconciliation"}
                </Button>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Quality-v1: Step 1 — preview on census (no run needed) */}
                  <Button
                    variant={qualityPreviewToken ? "outline" : "default"}
                    className="gap-2"
                    onClick={() => previewMutation.mutate(frozenCensus.id)}
                    disabled={previewMutation.isPending}
                  >
                    <Filter className="h-4 w-4" />
                    {previewMutation.isPending ? "Previewing…" : qualityPreviewToken ? "Re-run Preview" : "Quality Preview (5k contacts)"}
                  </Button>
                  {/* Quality-v1: Step 2 — start full run after preview accepted */}
                  {qualityPreviewToken && (
                    <Button
                      className="gap-2 bg-green-600 hover:bg-green-700 text-white"
                      onClick={() => startQualityFullMutation.mutate({ sourceCensusRunId: frozenCensus.id, token: qualityPreviewToken })}
                      disabled={startQualityFullMutation.isPending}
                    >
                      <ShieldCheck className="h-4 w-4" />
                      {startQualityFullMutation.isPending ? "Starting…" : "Start Full Quality-v1 Run"}
                    </Button>
                  )}
                </div>
              </div>
              {qualityPreviewResult && (
                <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 space-y-1">
                  <p className="font-semibold">Preview complete — review results, then start the full run:</p>
                  <p>Contacts sampled: <strong>{(qualityPreviewResult.contactsScanned as number).toLocaleString()}</strong></p>
                  <p>Contacts with any signal: <strong>{(qualityPreviewResult.contactsWithAnySignal as number).toLocaleString()}</strong></p>
                  <p>Total signal instances: <strong>{(qualityPreviewResult.signalInstances as number).toLocaleString()}</strong></p>
                  <p>Cosmetic proposals generated: <strong>{qualityPreviewResult.cosmeticProposals as number}</strong> ✓</p>
                  <p>Canonical mutations: <strong>{qualityPreviewResult.canonicalMutations as number}</strong> ✓</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No completed census run found. Run a census first from the Census tab.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold mb-3">Reconciliation Runs</h2>
          <ReconciliationRunsList selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
        </div>
        <div className="lg:col-span-3">
          {selectedRunId ? (
            <div className="space-y-4">
              <ReconciliationRunDetail runId={selectedRunId} />
              <ReconciliationProposalsPanel runId={selectedRunId} />
            </div>
          ) : (
            <div className="h-48 flex items-center justify-center rounded-lg border border-dashed border-gray-200">
              <p className="text-sm text-muted-foreground">Select a run to review proposals</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────────
export default function ContactCensus() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      {/* Page header */}
      <div className="flex items-start gap-3">
        <BarChart3 className="h-7 w-7 text-primary mt-0.5" />
        <div>
          <PageTitle className="text-xl font-bold">Contact Census &amp; Reconciliation</PageTitle>
          <p className="text-sm text-muted-foreground">
            Census classifies every active contact into remediation lanes. Reconciliation generates
            proposals for name, phone, and company name corrections — each approved individually.
          </p>
        </div>
      </div>

      <Tabs defaultValue="census">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="census">Census</TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
        </TabsList>

        <TabsContent value="census" className="space-y-6 mt-4">
          {/* Safety notice */}
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
            <Eye className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              Census runs are <strong>read-only</strong>. Lane assignments and dimension counts are stored in{" "}
              <code>contact_census_members</code>. No changes are made to <code>contacts</code>,{" "}
              <code>businesses</code>, or any other canonical table. No enrichment or outreach is triggered.
            </p>
          </div>

          <PreviewCard />
          <StartRunPanel onStarted={(id) => setSelectedRunId(id)} />

          <div className="grid lg:grid-cols-5 gap-6">
            <div className="lg:col-span-2">
              <h2 className="text-sm font-semibold mb-3">Census Runs</h2>
              <RunsList selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
            </div>
            <div className="lg:col-span-3">
              {selectedRunId ? (
                <>
                  <h2 className="text-sm font-semibold mb-3">Run Detail</h2>
                  <RunDetail runId={selectedRunId} />
                </>
              ) : (
                <div className="h-48 flex items-center justify-center rounded-lg border border-dashed border-gray-200">
                  <p className="text-sm text-muted-foreground">Select a run to see details</p>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="reconciliation" className="mt-4">
          <ReconciliationTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
