/**
 * MI-08: Program Health Panel
 * Displays per-named-worker heartbeats, pipeline counts, and enrichment queue
 * depth with per-metric { value, available, stale, staleSince?, error? } signals.
 * Polls /api/lead-ops/health every 30 seconds.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, CheckCircle, AlertTriangle, Clock, XCircle, RefreshCw, PlayCircle, Info } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MetricCell {
  value: number | string | null;
  available: boolean;
  stale: boolean;
  staleSince?: string;
  error?: string;
}

interface WorkerHeartbeat {
  available: boolean;
  stale: boolean;
  staleSince?: string | null;
  lastFinishedAt?: string | null;
  status?: string | null;
  consecutiveFailures?: number | null;
  minutesSince?: number | null;
  error?: string;
}

interface PipelineCountsMetric {
  value: { staged: number; readyToPromote: number; promoted: number; suppressed: number; duplicates: number } | null;
  available: boolean;
  stale: boolean;
  error?: string;
}

interface FreeEnrichQueueDepth {
  free: number;
  paid: number;
}

interface CandidateFunnel {
  staged: number;
  validationAdmitted: number;
  suppressed: number;
  stalled: number;
}

interface SchedulerStatus {
  singleProducer: string;
  legacyFenceRemoved: boolean;
  schedulerEnabled: boolean;
}

interface LeadOpsHealth {
  // Existing fields
  enrichedToday: MetricCell;
  emailsToday: MetricCell;
  phonesToday: MetricCell;
  queueDepth: MetricCell;
  totalEnriched: MetricCell;
  totalFailed: MetricCell;
  successRate: MetricCell;
  lastEnrichedAt: string | null;
  minutesSinceLastJob: number | null;
  workerActive: boolean;
  isStale?: boolean;
  // MI-08
  workerStalenessThresholdMs?: number;
  /** Server-derived: true when the enrichment worker has exceeded the staleness threshold */
  enrichmentWorkerStaleAlert?: boolean;
  workerHeartbeats?: Record<string, WorkerHeartbeat>;
  pipelineCounts?: PipelineCountsMetric;
  freeEnrichQueueDepth?: FreeEnrichQueueDepth;
  // Correction #7: scheduler status + stuck count + candidate funnel
  freeEnrichmentSchedulerStatus?: SchedulerStatus;
  businessStuckProcessingCount?: { value: number | null; available: boolean; error?: string };
  candidateFunnel?: CandidateFunnel | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORKER_LABELS: Record<string, string> = {
  enrichment:     "Enrichment Queue",
  stager:         "Stager Worker (BullMQ)",
  ghlSync:        "GHL Sync",
  sequenceWorker: "Sequence Enrollment",
  slaWorker:      "SLA Checks",
};

function WorkerStatusBadge({ hb }: { hb: WorkerHeartbeat }) {
  if (!hb.available) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-label={`Worker unavailable: ${hb.error ?? "not registered"}`}>
        <XCircle className="h-3.5 w-3.5 text-gray-400" />
        {hb.error === "bullmq_only"
          ? "BullMQ-only (not monitorable here)"
          : hb.error === "audit_query_failed"
            ? "Audit unavailable"
            : "Not registered"
        }
      </span>
    );
  }
  // A failed status OR consecutive_failures > 0 means the worker's last run failed.
  // Display degraded (red) even when the heartbeat timestamp is recent — a recently
  // failed worker is NOT the same as an active worker.
  const hasFailed = hb.status === "failed" || (hb.consecutiveFailures ?? 0) > 0;
  if (hasFailed) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-700" aria-label={`Worker failed: ${hb.consecutiveFailures ?? "?"} consecutive failures`}>
        <XCircle className="h-3.5 w-3.5 text-red-500" />
        Failed {(hb.consecutiveFailures ?? 0) > 0 ? `(${hb.consecutiveFailures}×)` : ""}{" "}
        {hb.minutesSince !== null ? `${hb.minutesSince}m ago` : ""}
      </span>
    );
  }
  if (hb.stale) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-700" aria-label={`Worker stale since ${hb.staleSince ?? "unknown"}`}>
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        Stale {hb.minutesSince !== null ? `(${hb.minutesSince}m ago)` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-green-700" aria-label="Worker active">
      <CheckCircle className="h-3.5 w-3.5 text-green-500" />
      Active {hb.minutesSince !== null ? `(${hb.minutesSince}m ago)` : ""}
    </span>
  );
}

function MetricDisplay({ label, cell, unit = "" }: { label: string; cell?: MetricCell | null; unit?: string }) {
  if (!cell) {
    return (
      <div className="rounded-md border bg-muted/10 px-3 py-2">
        <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
        <div className="text-sm font-medium text-muted-foreground">—</div>
      </div>
    );
  }
  if (!cell.available) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50/30 px-3 py-2" aria-label={`${label}: unavailable`}>
        <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
        <div className="text-sm font-medium text-red-500 flex items-center gap-1">
          <XCircle className="h-3 w-3" /> Unavailable
        </div>
        {cell.error && <div className="text-[10px] text-red-400 mt-0.5">{cell.error}</div>}
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-muted/10 px-3 py-2">
      <div className="text-xs text-muted-foreground mb-0.5 flex items-center gap-1">
        {label}
        {cell.stale && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 text-amber-600 border-amber-300" aria-label="Stale data">
            stale
          </Badge>
        )}
      </div>
      <div className="text-sm font-medium">
        {cell.value !== null && cell.value !== undefined
          ? `${typeof cell.value === "number" ? cell.value.toLocaleString() : cell.value}${unit}`
          : "—"}
      </div>
      {cell.stale && cell.staleSince && (
        <div className="text-[10px] text-amber-500 mt-0.5">
          Since {new Date(cell.staleSince).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface PromotionState {
  promotionEnabled: boolean;
  runtimeOwnerReady: boolean;
  runtimeOwnerReason: string | null;
  gateOpen: boolean;
  staged: number;
  scopedStaged: number;
  unscopedStaged: number;
  validationAdmitted: number;
  note: string;
}

interface GateDiagnostics {
  deployedReleaseSha: string | null;
  deploymentIdentity: string | null;
  environmentIdentity: string | null;
  queueTopologyHash: string;
  inventory: {
    present: boolean;
    ambiguous?: boolean;
    inventoryId?: string;
    releaseShaMatch?: boolean;
    environmentMatch?: boolean;
    deploymentMatch?: boolean;
    topologyMatch?: boolean;
    workerIdentitiesInInventory?: string[];
    expectedCount?: number;
    issuedAt?: string;
    expiresAt?: string;
    expired?: boolean;
  };
  workerFleet: {
    present: boolean;
    count: number;
    identities?: string[];
    oldestHeartbeatAgeMs?: number;
    complete?: boolean;
    errorCode?: string;
    /** Unique release SHAs seen in live heartbeats */
    workerReleaseShas?: string[];
    /** true when any worker SHA differs from the API SHA — warning only, not a gate failure */
    shaWarning?: boolean;
    shaWarnings?: Array<{ apiSha: string; workerSha: string; processIdentity: string }>;
    /** Heartbeats skipped because they belong to a different generation (old topology/env/deploy/stale) */
    generationalSkips?: Array<{ reason: string; processIdentity: string; observed: string; expected: string }>;
    generationalSkipCount?: number;
  };
  attestation: {
    present: boolean;
    attestationId?: string;
    capturedAt?: string;
    expiresAt?: string;
    reason: string;
  };
  closedGateReason: string | null;
  /** Non-null when a SHA difference exists — shown as yellow warning, not a red failure */
  shaReleaseWarning?: string | null;
}

interface BackfillResult {
  examined: number;
  promoted: number;
  skipped: number;
  failed: number;
  errors: string[];
  reasons?: Record<string, number>;
}

export function ProgramHealthPanel() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [backfillLimit, setBackfillLimit] = useState<number>(50);

  const healthQuery = useQuery<LeadOpsHealth>({
    queryKey: ["/api/lead-ops/health"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/health", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const promotionStateQuery = useQuery<PromotionState>({
    queryKey: ["/api/lead-ops/candidates/promotion-state"],
    queryFn: async () => {
      const r = await fetch("/api/lead-ops/candidates/promotion-state", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const gateDiagnosticsQuery = useQuery<GateDiagnostics>({
    queryKey: ["/api/admin/cro03c/gate-diagnostics"],
    queryFn: async () => {
      const r = await fetch("/api/admin/cro03c/gate-diagnostics", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: isAdmin,
    refetchInterval: 30_000,
  });

  const backfillMutation = useMutation<BackfillResult, Error, number>({
    mutationFn: async (limit: number) => {
      const res = await apiRequest("POST", "/api/lead-ops/candidates/routine-promotion", { limit });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Backfill complete",
        description: `Examined ${data.examined} — promoted ${data.promoted}, skipped ${data.skipped}${data.failed > 0 ? `, failed ${data.failed}` : ""}.${data.reasons && Object.keys(data.reasons).length ? ` Reasons: ${Object.entries(data.reasons).map(([reason, count]) => `${reason}: ${count}`).join("; ")}` : ""}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/candidates/promotion-state"] });
    },
    onError: (err) => {
      toast({
        title: "Backfill failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const h = healthQuery.data;
  const ps = promotionStateQuery.data;

  if (healthQuery.isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-4">
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (healthQuery.isError) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">
          Failed to load health data. {healthQuery.error instanceof Error ? healthQuery.error.message : ""}
        </CardContent>
      </Card>
    );
  }

  const workerKeys = Object.keys(h?.workerHeartbeats ?? {});

  // The server derives enrichmentWorkerStaleAlert with exact ms precision so the
  // client never re-implements the threshold comparison. Only the enrichment
  // worker is in scope — other workers have independent cadences.
  const alertThresholdMs = h?.workerStalenessThresholdMs ?? 10 * 60 * 1000;
  const alertThresholdMin = Math.round(alertThresholdMs / 60000);
  const enrichmentHb = h?.workerHeartbeats?.enrichment;
  const showEnrichmentStaleAlert = h?.enrichmentWorkerStaleAlert === true;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-base font-semibold">Program Health</h2>
            <p className="text-xs text-muted-foreground">Live counters — refreshes every 30 s</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {h?.isStale && (
            <Badge variant="outline" className="text-amber-600 border-amber-300 text-xs" aria-label="Showing stale cached data">
              <Clock className="h-3 w-3 mr-1" /> Stale cache
            </Badge>
          )}
          <Button
            size="sm" variant="outline" className="h-7 gap-1.5"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/health"] })}
            disabled={healthQuery.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${healthQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Enrichment worker stale alert banner ─────────────────────────── */}
      {showEnrichmentStaleAlert && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-800"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">
              Enrichment worker silent for over {alertThresholdMin} minutes
            </p>
            {enrichmentHb?.minutesSince !== null && enrichmentHb?.minutesSince !== undefined && (
              <p className="mt-0.5 text-xs text-amber-700">
                Last heartbeat {enrichmentHb.minutesSince}m ago — the enrichment queue may have stalled.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Per-named-worker heartbeats ──────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Worker Heartbeats</CardTitle>
          <CardDescription className="text-xs">
            Per-named-worker last completion time. Stale = no completion in last 30 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {workerKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No worker heartbeat data available.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {workerKeys.map((key) => {
                const hb = h!.workerHeartbeats![key];
                return (
                  <div key={key} className="rounded-md border bg-muted/10 px-3 py-2">
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      {WORKER_LABELS[key] ?? key}
                    </div>
                    <WorkerStatusBadge hb={hb} />
                    {hb.available && hb.lastFinishedAt && (
                      <div className="text-[10px] text-muted-foreground mt-1 truncate">
                        Last: {new Date(hb.lastFinishedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Pipeline counts ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Pipeline Counts</CardTitle>
          <CardDescription className="text-xs">
            Live counts from master_leads staging table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {h?.pipelineCounts?.available && h.pipelineCounts.value ? (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { label: "Staged", value: h.pipelineCounts.value.staged, color: "text-blue-700" },
                { label: "Ready", value: h.pipelineCounts.value.readyToPromote, color: "text-green-700" },
                { label: "Promoted", value: h.pipelineCounts.value.promoted, color: "text-emerald-700" },
                { label: "Suppressed", value: h.pipelineCounts.value.suppressed, color: "text-red-700" },
                { label: "Duplicates", value: h.pipelineCounts.value.duplicates, color: "text-amber-700" },
              ].map(({ label, value, color }) => (
                <div key={label} className="rounded-md border bg-muted/10 px-3 py-2">
                  <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
                  <div className={`text-lg font-bold ${color}`}>{value.toLocaleString()}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <XCircle className="h-4 w-4" />
              {h?.pipelineCounts?.error ?? "Pipeline counts unavailable"}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Enrichment queue depth ───────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Enrichment Queue</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            <MetricDisplay
               label="Free Enrich Queue"
               cell={h?.freeEnrichQueueDepth?.free != null
                 ? { ...(h.freeEnrichQueueDepth.free as any), stale: false }
                 : null}
              unit=" pending"
            />
            <MetricDisplay
               label="Paid Enrich Queue"
               cell={h?.freeEnrichQueueDepth?.paid != null
                 ? { ...(h.freeEnrichQueueDepth.paid as any), stale: false }
                 : null}
              unit=" pending"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Enrichment throughput ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Enrichment Throughput (24 h)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: "Source entities enriched today (raw Sunbiz)", cell: h?.enrichedToday },
              { label: "Emails Found", cell: h?.emailsToday },
              { label: "Phones Found", cell: h?.phonesToday },
              { label: "Total Enriched", cell: h?.totalEnriched },
              { label: "Total Failed", cell: h?.totalFailed },
              { label: "Success Rate", cell: h?.successRate },
            ].map(({ label, cell }) => (
              <MetricDisplay key={label} label={label} cell={cell} unit={label === "Success Rate" ? "%" : ""} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Scheduler status (Correction #3) ────────────────────────────── */}
      {h?.freeEnrichmentSchedulerStatus && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Free Enrichment Scheduler</CardTitle>
            <CardDescription className="text-xs">
              Single-producer design — only the BullMQ repeatable lane enqueues businesses.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-0.5">Producer</div>
                <div className="text-xs font-mono font-medium truncate">
                  {h.freeEnrichmentSchedulerStatus.singleProducer}
                </div>
              </div>
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-0.5">Legacy fence</div>
                <span className={`inline-flex items-center gap-1 text-xs ${h.freeEnrichmentSchedulerStatus.legacyFenceRemoved ? "text-green-700" : "text-amber-700"}`}>
                  {h.freeEnrichmentSchedulerStatus.legacyFenceRemoved
                    ? <><CheckCircle className="h-3 w-3 text-green-500" /> Removed</>
                    : <><AlertTriangle className="h-3 w-3 text-amber-500" /> Active (dual-producer risk)</>
                  }
                </span>
              </div>
              <div className="rounded-md border bg-muted/10 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-0.5">Scheduler</div>
                <span className={`inline-flex items-center gap-1 text-xs ${h.freeEnrichmentSchedulerStatus.schedulerEnabled ? "text-green-700" : "text-muted-foreground"}`}>
                  {h.freeEnrichmentSchedulerStatus.schedulerEnabled
                    ? <><CheckCircle className="h-3 w-3 text-green-500" /> Enabled</>
                    : "Disabled"
                  }
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── CRO-03C Readiness diagnostics (admin only) ───────────────────── */}
      {isAdmin && (() => {
        const diag = gateDiagnosticsQuery.data;
        if (!diag && gateDiagnosticsQuery.isLoading) {
          return (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">CRO-03C Readiness</CardTitle></CardHeader>
              <CardContent><Skeleton className="h-16 w-full" /></CardContent>
            </Card>
          );
        }
        if (!diag) return null;

        const apiShaOk = !!diag.deployedReleaseSha && /^[0-9a-f]{40}$/i.test(diag.deployedReleaseSha);
        const workerReleaseSha = diag.workerFleet.workerReleaseShas?.[0] ?? null;
        const shasDiffer = diag.workerFleet.shaWarning === true;

        // Hard-gate checks (red = blocked)
        const checks: Array<{ label: string; pass: boolean; warn?: boolean; detail?: string }> = [
          {
            label: "Live worker heartbeat",
            pass: diag.workerFleet.present && (diag.workerFleet.complete ?? false),
            detail: diag.workerFleet.present
              ? `${diag.workerFleet.count} worker(s)${diag.workerFleet.oldestHeartbeatAgeMs !== undefined ? `, ${Math.round(diag.workerFleet.oldestHeartbeatAgeMs / 1000)}s ago` : ""}`
              : (diag.workerFleet.errorCode ?? "none found — start worker process"),
          },
          {
            label: "Environment identity",
            pass: !!diag.environmentIdentity,
            detail: diag.environmentIdentity ?? "unknown",
          },
          {
            label: "Worker fleet complete",
            pass: diag.workerFleet.present && (diag.workerFleet.complete ?? false),
            detail: diag.workerFleet.complete ? `${diag.workerFleet.count} worker(s) confirmed` : "scan incomplete",
          },
          {
            label: "Queue topology compat.",
            pass: diag.inventory.topologyMatch !== false,
            detail: diag.inventory.topologyMatch === false ? "topology hash mismatch" : (diag.queueTopologyHash.slice(0, 12) + "…"),
          },
          {
            label: "Capability manifest",
            pass: diag.inventory.present && !diag.inventory.expired,
            detail: diag.inventory.present ? (diag.inventory.expired ? "expired" : "present") : "missing",
          },
          {
            label: "API release SHA",
            pass: apiShaOk,
            detail: diag.deployedReleaseSha ? diag.deployedReleaseSha.slice(0, 12) + "…" : "missing",
          },
          {
            label: "Worker release SHA",
            // SHA equality is diagnostic — mark as pass, use warn=shasDiffer for yellow
            pass: diag.workerFleet.present,
            warn: shasDiffer,
            detail: workerReleaseSha
              ? (shasDiffer ? `${workerReleaseSha.slice(0, 12)}… (differs from API)` : `${workerReleaseSha.slice(0, 12)}… (matches)`)
              : (diag.workerFleet.present ? "checking…" : "no heartbeat"),
          },
          {
            label: "SHA equality",
            pass: true,  // never a hard gate
            warn: shasDiffer,
            detail: shasDiffer ? "SHA differs — diagnostic only" : "matches",
          },
          {
            label: "Deployment inventory",
            pass: diag.inventory.present && !diag.inventory.ambiguous && !diag.inventory.expired,
            detail: diag.inventory.ambiguous ? "ambiguous — run convergence" : diag.inventory.present ? (diag.inventory.expired ? "expired" : `issued ${diag.inventory.issuedAt ? new Date(diag.inventory.issuedAt).toLocaleTimeString() : "?"}`) : "missing — issue attestation",
          },
          {
            label: "Runtime attestation",
            pass: diag.attestation.present,
            detail: diag.attestation.present
              ? `expires ${new Date(diag.attestation.expiresAt!).toLocaleTimeString()}`
              : diag.closedGateReason ?? "missing",
          },
          {
            label: "Provider admission",
            pass: diag.attestation.present && diag.inventory.present && diag.workerFleet.present,
            detail: diag.closedGateReason ? `Blocked: ${diag.closedGateReason}` : "Gate open",
          },
        ];

        const hardFails = checks.filter((c) => !c.pass && !c.warn);
        const warnings = checks.filter((c) => c.warn);
        const allPass = hardFails.length === 0;

        return (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">CRO-03C Readiness</CardTitle>
                  <CardDescription className="text-xs mt-0.5">Separate certificate-governed CRO-03C lane. These checks do not authorize or block routine SFP. SHA equality is diagnostic.</CardDescription>
                </div>
                {allPass ? (
                  warnings.length > 0 ? (
                    <Badge className="shrink-0 bg-yellow-100 text-yellow-800 border-yellow-300 hover:bg-yellow-100" variant="outline">
                      <AlertTriangle className="h-3 w-3 mr-1" /> SHA differs (warning)
                    </Badge>
                  ) : (
                    <Badge className="shrink-0 bg-green-100 text-green-800 border-green-300 hover:bg-green-100" variant="outline">
                      <CheckCircle className="h-3 w-3 mr-1" /> All checks pass
                    </Badge>
                  )
                ) : (
                  <Badge className="shrink-0 bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100" variant="outline">
                    <AlertTriangle className="h-3 w-3 mr-1" /> {diag.closedGateReason ?? "Checks failing"}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {diag.shaReleaseWarning && (
                <div className="mb-3 flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50/60 px-3 py-2 text-xs text-yellow-800">
                  <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-600" />
                  <span>{diag.shaReleaseWarning} — This is expected after a new publish. Workers adopt the new SHA on restart.</span>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {checks.map((c) => {
                  const isWarnOnly = c.warn && c.pass;
                  const isFail = !c.pass;
                  const bg = isWarnOnly ? "bg-yellow-50/60 border-yellow-200" : isFail ? "bg-amber-50/60 border-amber-200" : "bg-muted/10";
                  const textColor = isWarnOnly ? "text-yellow-700" : isFail ? "text-amber-700" : "text-green-700";
                  const Icon = isWarnOnly ? AlertTriangle : isFail ? AlertTriangle : CheckCircle;
                  const iconColor = isWarnOnly ? "text-yellow-500" : isFail ? "text-amber-500" : "text-green-500";
                  return (
                    <div key={c.label} className={`rounded-md border px-3 py-2 ${bg}`}>
                      <div className="text-xs text-muted-foreground mb-0.5">{c.label}</div>
                      <span className={`inline-flex items-center gap-1 text-xs ${textColor}`}>
                        <Icon className={`h-3 w-3 ${iconColor}`} />
                        {isWarnOnly ? "Warn" : c.pass ? "OK" : "Fail"}
                      </span>
                      {c.detail && <div className="text-[10px] text-muted-foreground mt-0.5 truncate" title={c.detail}>{c.detail}</div>}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* ── Stuck-processing + candidate funnel ─────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Routine SFP Candidate Pipeline</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Free-discovery candidates by validation state. Stuck = businesses locked in 'processing' (reaper recovers these every 15 min).
              </CardDescription>
            </div>
            {/* Gate status badge reflects the feature flag and durable runtime owner. */}
            {ps && (
              ps.gateOpen ? (
                <Badge className="shrink-0 bg-green-100 text-green-800 border-green-300 hover:bg-green-100" variant="outline">
                  <CheckCircle className="h-3 w-3 mr-1" /> Gate open
                </Badge>
              ) : (
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge
                    className="bg-red-100 text-red-800 border-red-300 hover:bg-red-100 cursor-help"
                    variant="outline"
                    title={ps.note}
                  >
                    <XCircle className="h-3 w-3 mr-1" />
                    {ps.promotionEnabled && !ps.runtimeOwnerReady ? "Owner unavailable" : "Gate closed"}
                  </Badge>
                </div>
              )
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Stuck processing count */}
          {ps && <p className="text-xs text-muted-foreground">
            {ps.note} Scoped staged: {ps.scopedStaged?.toLocaleString() ?? "Unknown"}; outside current scope: {ps.unscopedStaged?.toLocaleString() ?? "Unknown"}.
          </p>}
          <div className="flex items-center gap-3">
            <div className="rounded-md border bg-muted/10 px-3 py-2 flex-1">
              <div className="text-xs text-muted-foreground mb-0.5">Stuck in processing</div>
              {h?.businessStuckProcessingCount?.available
                ? (
                  <div className={`text-sm font-medium ${(h.businessStuckProcessingCount.value ?? 0) > 0 ? "text-amber-700" : "text-green-700"}`}>
                    {h.businessStuckProcessingCount.value?.toLocaleString() ?? "0"}
                    {(h.businessStuckProcessingCount.value ?? 0) === 0 && (
                      <span className="text-xs font-normal text-muted-foreground ml-1">(reaper healthy)</span>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">—</div>
                )
              }
            </div>
          </div>

          {/* Candidate funnel */}
          {h?.candidateFunnel ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Staged tile — includes backfill controls */}
              <div className="rounded-md border bg-muted/10 px-3 py-2 col-span-2 sm:col-span-1">
                <div className="text-xs text-muted-foreground mb-0.5">
                  Staged
                  <span className="ml-1 text-[9px] text-muted-foreground/70">(unvalidated)</span>
                </div>
                <div className="text-lg font-bold text-blue-700">{h.candidateFunnel.staged.toLocaleString()}</div>
                {/* Backfill controls — admin only */}
                {isAdmin && (
                  <>
                    <div className="mt-2 flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={1}
                        max={200}
                        value={backfillLimit}
                        onChange={(e) => setBackfillLimit(Math.min(200, Math.max(1, Math.floor(Number(e.target.value)) || 50)))}
                        className="h-6 w-16 text-xs px-1.5 py-0"
                        aria-label="Backfill limit"
                        disabled={backfillMutation.isPending}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px] px-2 gap-1"
                        disabled={backfillMutation.isPending || !ps?.gateOpen}
                        title={!ps?.gateOpen ? (ps?.promotionEnabled ? `Durable runtime owner unavailable: ${ps.runtimeOwnerReason ?? "identity not ready"}` : "Gate is closed — enable FREE_DISCOVERY_VALIDATION_PROMOTION_ENABLED first") : `Promote up to ${backfillLimit} staged candidates`}
                        onClick={() => backfillMutation.mutate(backfillLimit)}
                      >
                        {backfillMutation.isPending
                          ? <><RefreshCw className="h-3 w-3 animate-spin" /> Running…</>
                          : <><PlayCircle className="h-3 w-3" /> Promote</>
                        }
                      </Button>
                    </div>
                    {!ps?.gateOpen && (
                      <p className="mt-1 text-[10px] text-red-500">
                        {ps?.promotionEnabled && !ps?.runtimeOwnerReady
                          ? "Runtime owner unavailable"
                          : "Gate closed"}
                      </p>
                    )}
                  </>
                )}
              </div>

              {[
                { label: "Admitted", value: h.candidateFunnel.validationAdmitted, color: "text-indigo-700", note: "pending ZB" },
                { label: "Suppressed", value: h.candidateFunnel.suppressed, color: "text-red-700", note: "" },
                { label: "Stalled", value: h.candidateFunnel.stalled, color: "text-amber-700", note: "crashed gen" },
              ].map(({ label, value, color, note }) => (
                <div key={label} className="rounded-md border bg-muted/10 px-3 py-2">
                  <div className="text-xs text-muted-foreground mb-0.5">
                    {label}
                    {note && <span className="ml-1 text-[9px] text-muted-foreground/70">({note})</span>}
                  </div>
                  <div className={`text-lg font-bold ${color}`}>{value.toLocaleString()}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Candidate funnel data unavailable.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
