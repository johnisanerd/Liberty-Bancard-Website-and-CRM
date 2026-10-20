import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertCircle, RefreshCw, Play, RotateCcw, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import { humanizeReasonCode } from "@shared/readiness-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GradeDistribution = {
  A: number;
  B: number;
  C: number;
  D: number;
  F: number;
};

type BackfillRun = {
  runId: string;
  status: "idle" | "running" | "complete" | "failed" | "interrupted";
  processed: number | null;
  updated: number | null;
  errors: number | null;
  startedAt: string | null;
  completedAt: string | null;
  lastHeartbeatAt: string | null;
  lastProcessedContactId: number | null;
};

// Each reader is independent: a section the server could not read is null and
// named in `unavailable`; it is never a zero.
type ReadinessStats = {
  total: number | null;
  nullScore: number | null;
  staleModel: number | null;
  mutationStale: number | null;
  grades: GradeDistribution | null;
  avgScore: number | null;
  minScore: number | null;
  maxScore: number | null;
  histogram: Array<{ bucketStart: number; bucketEnd: number; count: number }> | null;
  topMissingReasons: Array<{ reason: string; cnt: number }> | null;
  modelVersion: number;
  backfillRun: BackfillRun | null;
  unavailable?: Partial<Record<"summary" | "histogram" | "missingReasons" | "backfillRun", { code: string | null; message: string }>>;
  asOf?: string;
};

type ReadinessStatsReady = ReadinessStats & {
  total: number; nullScore: number; staleModel: number; mutationStale: number; grades: GradeDistribution;
};

function SectionUnavailable({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 text-sm" data-testid="readiness-section-unavailable">
      <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
      <span>{what} could not be read. This is not zero; other sections are unaffected.</span>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grade bar colours
// ---------------------------------------------------------------------------

const GRADE_COLORS: Record<string, string> = {
  A: "bg-green-600",
  B: "bg-blue-500",
  C: "bg-yellow-500",
  D: "bg-orange-500",
  F: "bg-red-500",
};

const GRADE_TEXT_COLORS: Record<string, string> = {
  A: "text-green-700 dark:text-green-400",
  B: "text-blue-600 dark:text-blue-400",
  C: "text-yellow-600 dark:text-yellow-400",
  D: "text-orange-600 dark:text-orange-400",
  F: "text-red-600 dark:text-red-400",
};

// ---------------------------------------------------------------------------
// Custom hook — stats fetch with conditional polling
// ---------------------------------------------------------------------------

function useReadinessStats() {
  return useQuery<ReadinessStats>({
    queryKey: ["/api/contacts/readiness-stats"],
    queryFn: async ({ signal }) => {
      const res = await apiRequest("GET", "/api/contacts/readiness-stats", undefined, undefined, signal);
      return res.json();
    },
    refetchInterval: (query) => {
      const status = (query.state.data as ReadinessStats | undefined)?.backfillRun?.status;
      return status === "running" ? 10000 : false;
    },
    staleTime: 30000,
  });
}

// ---------------------------------------------------------------------------
// Grade distribution bar
// ---------------------------------------------------------------------------

function GradeBar({ grades }: { grades: GradeDistribution }) {
  const totalScored = grades.A + grades.B + grades.C + grades.D + grades.F;

  if (totalScored === 0) {
    return (
      <div className="text-sm text-muted-foreground italic" data-testid="text-no-scored">
        No contacts have been scored yet.
      </div>
    );
  }

  const segments: Array<{ grade: string; count: number; pct: number }> = (
    ["A", "B", "C", "D", "F"] as const
  ).map((g) => ({
    grade: g,
    count: grades[g],
    pct: (grades[g] / totalScored) * 100,
  }));

  return (
    <div className="space-y-2" data-testid="panel-grade-bar">
      <TooltipProvider>
        <div className="flex h-6 w-full rounded overflow-hidden gap-px">
          {segments.map(({ grade, count, pct }) =>
            pct > 0 ? (
              <Tooltip key={grade}>
                <TooltipTrigger asChild>
                  <div
                    className={`${GRADE_COLORS[grade]} cursor-default transition-opacity hover:opacity-80`}
                    style={{ width: `${pct}%` }}
                    data-testid={`grade-bar-segment-${grade}`}
                    aria-label={`Grade ${grade}: ${count} contacts (${pct.toFixed(1)}%)`}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  <div className="font-semibold">Grade {grade}</div>
                  <div>{count.toLocaleString()} contacts ({pct.toFixed(1)}%)</div>
                </TooltipContent>
              </Tooltip>
            ) : null
          )}
        </div>
      </TooltipProvider>

      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {segments.map(({ grade, count, pct }) => (
          <div key={grade} className="flex items-center gap-1.5 text-xs">
            <div className={`w-2.5 h-2.5 rounded-sm flex-shrink-0 ${GRADE_COLORS[grade]}`} />
            <span className={`font-semibold ${GRADE_TEXT_COLORS[grade]}`}>{grade}</span>
            <span className="text-muted-foreground">
              {count.toLocaleString()} ({pct.toFixed(1)}%)
            </span>
          </div>
        ))}
        <span className="text-xs text-muted-foreground ml-auto" data-testid="text-total-scored">
          {totalScored.toLocaleString()} scored
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Threshold estimator
// ---------------------------------------------------------------------------

function ThresholdEstimator({ grades }: { grades: GradeDistribution }) {
  const [threshold, setThreshold] = useState<number>(60);

  const totalScored = grades.A + grades.B + grades.C + grades.D + grades.F;

  function countAtOrAbove(t: number): number {
    let n = 0;
    if (t <= 80) n += grades.A;
    if (t <= 79) n += grades.B;
    if (t <= 59) n += grades.C;
    if (t <= 39) n += grades.D;
    if (t <= 19) n += grades.F;
    return n;
  }

  const qualifying = countAtOrAbove(threshold);

  return (
    <div className="space-y-2" data-testid="panel-threshold-estimator">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="space-y-1">
          <label
            htmlFor="readiness-threshold-input"
            className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
          >
            At or above selected threshold
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="readiness-threshold-input"
              type="number"
              min={0}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(Math.max(0, Math.min(100, Number(e.target.value))))}
              className="w-24 h-8 text-sm"
              data-testid="input-readiness-threshold-estimator"
            />
            <span className="text-sm text-muted-foreground">/ 100</span>
          </div>
        </div>
        <div className="pb-1">
          <span className="text-2xl font-bold" data-testid="text-threshold-qualifying">
            {qualifying.toLocaleString()}
          </span>
          <span className="text-sm text-muted-foreground ml-1.5">
            of {totalScored.toLocaleString()} scored contacts qualify
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground italic" data-testid="text-threshold-disclaimer">
        Readiness does not determine permission to contact. Campaign contactability checks still apply.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  subtext,
  highlight,
  testId,
}: {
  label: string;
  value: number | string | null;
  subtext?: string;
  highlight?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={`rounded-md border p-3 space-y-1 ${highlight ? "border-orange-300 bg-orange-50 dark:border-orange-800 dark:bg-orange-950/30" : "bg-muted/30"}`}
      data-testid={testId ?? `stat-tile-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-bold ${highlight ? "text-orange-700 dark:text-orange-400" : ""}`}>
        {value === null ? "—" : typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {subtext && <div className="text-xs text-muted-foreground">{subtext}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top missing reasons list
// ---------------------------------------------------------------------------

function MissingReasonsList({ reasons }: { reasons: Array<{ reason: string; cnt: number }> }) {
  if (reasons.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic" data-testid="text-no-reasons">
        No missing-reason data available. Run backfill to populate.
      </p>
    );
  }

  const max = reasons[0].cnt;

  return (
    <ol className="space-y-1.5" data-testid="list-missing-reasons">
      {reasons.map(({ reason, cnt }, idx) => {
        const pct = max > 0 ? (cnt / max) * 100 : 0;
        return (
          <li key={reason} className="space-y-0.5" data-testid={`reason-item-${reason}`}>
            <div className="flex justify-between items-center text-xs gap-2">
              <span className="font-medium truncate">{humanizeReasonCode(reason)}</span>
              <span className="text-muted-foreground shrink-0">{cnt.toLocaleString()}</span>
            </div>
            <div className="h-1.5 w-full bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary/60 rounded"
                style={{ width: `${pct}%` }}
                aria-label={`${cnt} contacts`}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Backfill status widget
// ---------------------------------------------------------------------------

function statusIcon(status: string) {
  switch (status) {
    case "running":  return <RefreshCw className="w-4 h-4 animate-spin text-blue-500" />;
    case "complete": return <CheckCircle2 className="w-4 h-4 text-green-600" />;
    case "failed":   return <XCircle className="w-4 h-4 text-red-500" />;
    case "interrupted": return <AlertTriangle className="w-4 h-4 text-orange-500" />;
    default:         return <Clock className="w-4 h-4 text-muted-foreground" />;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":     return "Running";
    case "complete":    return "Complete";
    case "failed":      return "Failed";
    case "interrupted": return "Interrupted";
    default:            return "Idle";
  }
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleString();
}

function BackfillStatusWidget({
  stats,
  canMutate,
  onStart,
  isStarting,
}: {
  stats: ReadinessStatsReady;
  canMutate: boolean;
  onStart: (force: boolean) => void;
  isStarting: boolean;
}) {
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const run = stats.backfillRun;
  const runStatus = run?.status ?? "idle";
  const isRunning = runStatus === "running";

  const needsBackfill =
    stats.nullScore > 0 || stats.staleModel > 0 || stats.mutationStale > 0;

  return (
    <div className="space-y-3" data-testid="panel-backfill-widget">
      {/* Status row */}
      <div className="flex items-center gap-2 flex-wrap">
        {statusIcon(runStatus)}
        <span className="font-medium text-sm" data-testid="text-backfill-status">
          {statusLabel(runStatus)}
        </span>
        {run?.runId && (
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[180px]">
            {run.runId.slice(0, 8)}…
          </span>
        )}
      </div>

      {/* Progress */}
      {run && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">Processed</div>
            <div className="font-semibold" data-testid="text-backfill-processed">
              {run.processed?.toLocaleString() ?? "—"}
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">Updated</div>
            <div className="font-semibold" data-testid="text-backfill-updated">
              {run.updated?.toLocaleString() ?? "—"}
            </div>
          </div>
          {(run.errors ?? 0) > 0 && (
            <div className="space-y-0.5">
              <div className="text-xs text-muted-foreground">Errors</div>
              <div className="font-semibold text-red-600" data-testid="text-backfill-errors">
                {run.errors?.toLocaleString()}
              </div>
            </div>
          )}
          {run.completedAt && (
            <div className="space-y-0.5 col-span-2 sm:col-span-3">
              <div className="text-xs text-muted-foreground">Completed</div>
              <div className="text-xs" data-testid="text-backfill-completed-at">
                {fmtDate(run.completedAt)}
              </div>
            </div>
          )}
          {isRunning && run.lastHeartbeatAt && (
            <div className="space-y-0.5 col-span-2 sm:col-span-3">
              <div className="text-xs text-muted-foreground">Last heartbeat</div>
              <div className="text-xs" data-testid="text-backfill-heartbeat">
                {fmtDate(run.lastHeartbeatAt)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      {canMutate && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onStart(false)}
            disabled={isRunning || isStarting || !needsBackfill}
            data-testid="button-run-backfill"
          >
            <Play className="w-3.5 h-3.5 mr-1.5" />
            {isStarting ? "Starting…" : "Run Backfill"}
          </Button>
          {!needsBackfill && !isRunning && (
            <span className="text-xs text-muted-foreground">
              All contacts are scored and up-to-date.
            </span>
          )}
          {isRunning && (
            <button
              className="text-xs text-orange-600 hover:underline"
              onClick={() => setForceConfirmOpen(true)}
              data-testid="button-force-restart"
            >
              <RotateCcw className="w-3 h-3 inline mr-0.5" />
              Force Restart
            </button>
          )}
        </div>
      )}

      {/* Force-restart confirmation */}
      <AlertDialog open={forceConfirmOpen} onOpenChange={setForceConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force Restart Backfill?</AlertDialogTitle>
            <AlertDialogDescription>
              This will interrupt the currently running backfill and start a new one from where
              it left off. In-progress batch work will be abandoned. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-force-restart-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setForceConfirmOpen(false); onStart(true); }}
              data-testid="button-force-restart-confirm"
              className="bg-orange-600 hover:bg-orange-700"
            >
              Force Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function ReadinessIntelligencePanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canMutate = user?.role === "admin" || user?.role === "manager";

  const { data: stats, isLoading, isError, refetch } = useReadinessStats();

  const startMutation = useMutation({
    mutationFn: async (force: boolean) => {
      const res = await apiRequest("POST", "/api/admin/readiness-backfill/start", { force });
      return res.json() as Promise<{ runId: string; message: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/readiness-stats"] });
      toast({
        title: "Backfill started",
        description: data.message,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Backfill failed to start", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="panel-readiness-loading">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-8 w-full" />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError || !stats) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-10 text-center"
        data-testid="panel-readiness-error"
      >
        <AlertCircle className="w-8 h-8 text-destructive" />
        <p className="text-sm font-medium text-destructive">
          Failed to load readiness statistics.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-readiness-retry">
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  const runStatus = stats.backfillRun?.status ?? "idle";
  const summary: ReadinessStatsReady | null =
    stats.grades && stats.total !== null && stats.nullScore !== null && stats.staleModel !== null && stats.mutationStale !== null
      ? (stats as ReadinessStatsReady)
      : null;
  const backfillUnavailable = !!stats.unavailable?.backfillRun;

  return (
    <div className="space-y-6" data-testid="panel-readiness-intelligence">
      {/* ── Grade distribution ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Grade Distribution
            </CardTitle>
            {!backfillUnavailable && stats.backfillRun && (
              <Badge
                variant="outline"
                className={`text-xs ${
                  runStatus === "running"
                    ? "border-blue-400 text-blue-600 dark:text-blue-400"
                    : runStatus === "complete"
                    ? "border-green-400 text-green-600 dark:text-green-400"
                    : runStatus === "failed"
                    ? "border-red-400 text-red-600 dark:text-red-400"
                    : ""
                }`}
                data-testid="badge-run-status-header"
              >
                {runStatus === "running" && <RefreshCw className="w-2.5 h-2.5 mr-1 animate-spin" />}
                Backfill: {statusLabel(runStatus)}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {stats.grades ? (
            <>
              <GradeBar grades={stats.grades} />
              <ThresholdEstimator grades={stats.grades} />
            </>
          ) : (
            <SectionUnavailable what="Grade distribution" onRetry={() => refetch()} />
          )}
        </CardContent>
      </Card>

      {/* ── Key stats grid ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Contact Readiness Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summary ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatTile
              label="Total Scored"
              value={summary.grades.A + summary.grades.B + summary.grades.C + summary.grades.D + summary.grades.F}
              subtext={`of ${summary.total.toLocaleString()} contacts`}
              testId="stat-tile-total-scored"
            />
            <StatTile
              label="Avg Score"
              value={stats.avgScore !== null ? `${stats.avgScore}` : null}
              subtext="0–100 scale"
              testId="stat-tile-avg-score"
            />
            <StatTile
              label="Null Score"
              value={summary.nullScore}
              subtext="Not yet scored"
              highlight={summary.nullScore > 0}
              testId="stat-tile-null-score"
            />
            <StatTile
              label="Stale Model"
              value={summary.staleModel}
              subtext={`Model v${stats.modelVersion} needed`}
              highlight={summary.staleModel > 0}
              testId="stat-tile-stale-model"
            />
            <StatTile
              label="Mutation Stale"
              value={summary.mutationStale}
              subtext="Data changed since score"
              highlight={summary.mutationStale > 0}
              testId="stat-tile-mutation-stale"
            />
          </div>
          ) : (
            <SectionUnavailable what="Contact readiness summary" onRetry={() => refetch()} />
          )}
        </CardContent>
      </Card>

      {/* ── Bottom row: missing reasons + backfill ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top missing reasons */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Top Missing Data Reasons
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats.topMissingReasons
              ? <MissingReasonsList reasons={stats.topMissingReasons} />
              : <SectionUnavailable what="Missing-data reasons" onRetry={() => refetch()} />}
          </CardContent>
        </Card>

        {/* Backfill status + controls */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Backfill Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {backfillUnavailable || !summary ? (
              <SectionUnavailable what="Backfill status" onRetry={() => refetch()} />
            ) : canMutate ? (
              <BackfillStatusWidget
                stats={summary}
                canMutate={canMutate}
                onStart={(force) => startMutation.mutate(force)}
                isStarting={startMutation.isPending}
              />
            ) : (
              <>
                {/* Agent read-only view */}
                <div className="flex items-center gap-2 flex-wrap mb-3">
                  {statusIcon(runStatus)}
                  <span className="font-medium text-sm" data-testid="text-backfill-status">
                    {statusLabel(runStatus)}
                  </span>
                </div>
                {stats.backfillRun && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <div className="text-xs text-muted-foreground">Processed</div>
                      <div className="font-semibold" data-testid="text-backfill-processed">
                        {stats.backfillRun.processed?.toLocaleString() ?? "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Updated</div>
                      <div className="font-semibold" data-testid="text-backfill-updated">
                        {stats.backfillRun.updated?.toLocaleString() ?? "—"}
                      </div>
                    </div>
                    {stats.backfillRun.completedAt && (
                      <div className="col-span-2">
                        <div className="text-xs text-muted-foreground">Completed</div>
                        <div className="text-xs" data-testid="text-backfill-completed-at">
                          {fmtDate(stats.backfillRun.completedAt)}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {!stats.backfillRun && (
                  <p className="text-sm text-muted-foreground">No backfill has been run yet.</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
