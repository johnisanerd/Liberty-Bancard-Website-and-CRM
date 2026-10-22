/**
 * Queue Holds & Backlog Preview admin page.
 *
 * Two sections side-by-side (or stacked on mobile):
 *  1. Hold Ledger — current active holds + coordinator state
 *  2. Backlog Preview — per-source risk preview, polled every 30s
 *
 * The backlog preview card is wrapped in an ErrorBoundary so a crashed card
 * cannot crash the hold ledger section.
 */

import React, { useEffect, useRef, useCallback, Component } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CrmPage, CrmPageHeader } from "@/components/crm/CrmPresentation";
import { decodeQueueHolds, reconciliationDiverges, type QueueHoldsDecoded } from "@shared/queue-holds-dto";
import {
  RefreshCw,
  Server,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Database,
  Layers,
} from "lucide-react";

// ── ErrorBoundary ─────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class BacklogPreviewErrorBoundary extends Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              Backlog Preview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              The backlog preview card encountered an unexpected error and has been isolated.
              The hold ledger above remains functional.
            </p>
            <pre className="mt-2 text-xs text-destructive/80 whitespace-pre-wrap">
              {this.state.error?.message}
            </pre>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface SourceResult<T> {
  status: "ok" | "timeout" | "unavailable" | "schema_missing";
  data: T | null;
  capturedAt: string;
  errorCode?: string;
}

interface BacklogPreview {
  partial: boolean;
  nonAdditive: true;
  generatedAt: string;
  bullmq: SourceResult<{
    queues: Record<string, { waiting: number; delayed: number; active: number; failed: number }>;
    namedJobs?: Array<{ queue: string; jobName: string; state: string; count: number }>;
    scanTruncated: boolean;
  }>;
  sequenceEnrollments: SourceResult<{
    due: number;
    byActionType: Record<string, number>;
    bySequence: Array<{ sequenceId: number; count: number; oldestDueAt: string | null }>;
    byAge: { under1h: number; h1to24: number; over24h: number };
    eligibilityIndicators: { missingEndpoint: number; knownSuppressed: number; requiresEmailValidation: number };
  }>;
  outboundMessages: SourceResult<{ queued: number; sending: number; staleSending: number }>;
  deferredGhlEnrollments: SourceResult<{ pending: number; dueNow: number; terminalFailed: number }>;
  postEnrichmentIntents: SourceResult<{ pending: number; eligibleNow: number; processing: number; expiredLease: number; failed: number }>;
}

// ── Source Status Badge ───────────────────────────────────────────────────────

function SourceBadge({ status }: { status: string }) {
  if (status === "ok") return null;
  const label =
    status === "timeout" ? "timed out"
    : status === "schema_missing" ? "schema not found"
    : "unavailable";
  return (
    <Badge variant="outline" className="text-xs text-amber-800 border-amber-300 bg-amber-50 dark:text-amber-300 dark:bg-amber-950 dark:border-amber-700">
      <AlertTriangle className="w-3 h-3 mr-1" />
      {label}
    </Badge>
  );
}

// ── Backlog Preview Card ──────────────────────────────────────────────────────

function BacklogPreviewCard() {
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const { data, isFetching, refetch, error: backlogError } = useQuery<BacklogPreview>({
    queryKey: ["/api/admin/queue-holds/backlog-preview"],
    retry: 1,
    refetchOnWindowFocus: false,
    staleTime: 25_000,
  });

  // Polling every 30s; stops on unmount and when tab is backgrounded
  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      if (document.visibilityState === "hidden") return;
      refetch();
    }, 30_000);
  }, [refetch]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    startPolling();

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        stopPolling();
      } else {
        startPolling();
        refetch();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      mountedRef.current = false;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [startPolling, stopPolling, refetch]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Layers className="w-4 h-4" />
            Backlog Preview
            {data?.partial && (
              <Badge variant="outline" className="text-xs text-amber-800 border-amber-300 bg-amber-50 dark:text-amber-300 dark:bg-amber-950 dark:border-amber-700 ml-1">
                partial
              </Badge>
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-7 px-2 gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} />
            <span className="text-xs">Refresh</span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Risk preview only — sources overlap and{" "}
          <strong>must not be summed</strong>. Updated every 30 s.
          {data?.generatedAt && (
            <span className="ml-1">
              Last: {new Date(data.generatedAt).toLocaleTimeString()}
            </span>
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data && isFetching ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading backlog preview…
          </div>
        ) : !data && backlogError ? (
          <div className="space-y-2 text-sm text-destructive" role="alert" data-testid="backlog-unavailable">
            <p>Backlog preview request failed: {backlogError instanceof Error ? backlogError.message : "unknown error"}. This is not an empty backlog.</p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">No data available.</p>
        ) : (
          <>
            {/* ── Sequence Enrollments ── */}
            <SourceRow
              label="Due sequence enrollments"
              status={data.sequenceEnrollments.status}
              value={
                data.sequenceEnrollments.status === "ok"
                  ? `${data.sequenceEnrollments.data!.due} due`
                  : null
              }
              detail={
                data.sequenceEnrollments.status === "ok" ? (
                  <div className="space-y-1">
                    <AgeBar byAge={data.sequenceEnrollments.data!.byAge} />
                    <div className="flex flex-wrap gap-2 mt-1">
                      {Object.entries(data.sequenceEnrollments.data!.byActionType).map(
                        ([t, n]) => (
                          <Badge key={t} variant="secondary" className="text-xs">
                            {t}: {n}
                          </Badge>
                        )
                      )}
                    </div>
                    <EligibilityRow
                      indicators={data.sequenceEnrollments.data!.eligibilityIndicators}
                    />
                  </div>
                ) : null
              }
            />

            {/* ── Outbound Messages ── */}
            <SourceRow
              label="Outbound messages"
              status={data.outboundMessages.status}
              value={
                data.outboundMessages.status === "ok"
                  ? `${data.outboundMessages.data!.queued} queued · ${data.outboundMessages.data!.sending} sending`
                  : null
              }
              detail={
                data.outboundMessages.status === "ok" &&
                data.outboundMessages.data!.staleSending > 0 ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    ⚠ {data.outboundMessages.data!.staleSending} stale in &quot;sending&quot; (&gt;30 min)
                  </p>
                ) : null
              }
            />

            {/* ── Deferred GHL Enrollments ── */}
            <SourceRow
              label="Pending GHL deferrals"
              status={data.deferredGhlEnrollments.status}
              value={
                data.deferredGhlEnrollments.status === "ok"
                  ? `${data.deferredGhlEnrollments.data!.pending} pending`
                  : null
              }
              detail={
                data.deferredGhlEnrollments.status === "ok" ? (
                  <p className="text-xs text-muted-foreground">
                    {data.deferredGhlEnrollments.data!.dueNow} due now ·{" "}
                    {data.deferredGhlEnrollments.data!.terminalFailed} terminal failed
                  </p>
                ) : null
              }
            />

            {/* ── Post-Enrichment Intents ── */}
            <SourceRow
              label="Post-enrichment intents"
              status={data.postEnrichmentIntents.status}
              value={
                data.postEnrichmentIntents.status === "ok"
                  ? `${data.postEnrichmentIntents.data!.pending} pending`
                  : null
              }
              detail={
                data.postEnrichmentIntents.status === "ok" ? (
                  <div className="flex flex-wrap gap-2">
                    <span className="text-xs text-muted-foreground">
                      {data.postEnrichmentIntents.data!.eligibleNow} eligible now
                    </span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs text-muted-foreground">
                      {data.postEnrichmentIntents.data!.processing} processing
                    </span>
                    {data.postEnrichmentIntents.data!.expiredLease > 0 && (
                      <>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-amber-700 dark:text-amber-400">
                          {data.postEnrichmentIntents.data!.expiredLease} expired lease
                        </span>
                      </>
                    )}
                  </div>
                ) : null
              }
            />

            {/* ── BullMQ Queues ── */}
            <SourceRow
              label="BullMQ queue depths"
              status={data.bullmq.status}
              value={
                data.bullmq.status === "ok"
                  ? `${Object.keys(data.bullmq.data!.queues).length} queues`
                  : null
              }
              detail={
                data.bullmq.status === "ok" ? (
                  <div className="mt-1 max-h-40 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground">
                          <th className="text-left pb-1">Queue</th>
                          <th className="text-right pb-1">W</th>
                          <th className="text-right pb-1">D</th>
                          <th className="text-right pb-1">A</th>
                          <th className="text-right pb-1">F</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(data.bullmq.data!.queues).map(([name, q]) => (
                          <tr key={name} className="border-t border-muted/20">
                            <td className="py-0.5 pr-2 truncate max-w-[140px]" title={name}>
                              {name}
                            </td>
                            <td className="text-right">{q.waiting}</td>
                            <td className="text-right">{q.delayed}</td>
                            <td className="text-right">{q.active}</td>
                            <td className={`text-right ${q.failed > 0 ? "text-destructive" : ""}`}>
                              {q.failed}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {data.bullmq.data!.scanTruncated && (
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        ⚠ Named-job scan was truncated — results may be incomplete.
                      </p>
                    )}
                  </div>
                ) : null
              }
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SourceRow({
  label,
  status,
  value,
  detail,
}: {
  label: string;
  status: string;
  value: string | null;
  detail?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {status === "ok" && value && (
          <span className="text-sm text-muted-foreground">{value}</span>
        )}
        <SourceBadge status={status} />
      </div>
      {detail && <div className="ml-0">{detail}</div>}
    </div>
  );
}

function AgeBar({ byAge }: { byAge: { under1h: number; h1to24: number; over24h: number } }) {
  const total = byAge.under1h + byAge.h1to24 + byAge.over24h;
  if (total === 0) return null;
  return (
    <div className="flex gap-2 text-xs text-muted-foreground">
      <span className="text-green-600">&lt;1h: {byAge.under1h}</span>
      <span>1–24h: {byAge.h1to24}</span>
      {byAge.over24h > 0 && (
        <span className="text-amber-700 dark:text-amber-400">&gt;24h: {byAge.over24h}</span>
      )}
    </div>
  );
}

function EligibilityRow({
  indicators,
}: {
  indicators: { missingEndpoint: number; knownSuppressed: number; requiresEmailValidation: number };
}) {
  const { missingEndpoint, knownSuppressed, requiresEmailValidation } = indicators;
  if (!missingEndpoint && !knownSuppressed && !requiresEmailValidation) return null;
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {missingEndpoint > 0 && (
        <span className="text-destructive">
          {missingEndpoint} missing endpoint
        </span>
      )}
      {knownSuppressed > 0 && (
        <span className="text-amber-700 dark:text-amber-400">
          {knownSuppressed} suppressed (DNC)
        </span>
      )}
      {requiresEmailValidation > 0 && (
        <span className="text-amber-700 dark:text-amber-400">
          {requiresEmailValidation} need email validation
        </span>
      )}
    </div>
  );
}

// ── Hold Ledger Section ───────────────────────────────────────────────────────

function formatWhen(value: string | null): string {
  if (!value) return "not recorded";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function HoldLedgerSection() {
  const { data, isFetching, isLoading, refetch, error, dataUpdatedAt } = useQuery<QueueHoldsDecoded>({
    queryKey: ["/api/admin/queue-holds"],
    // Decode in the query so a malformed payload is an explicit state, never an empty ledger.
    select: (raw) => decodeQueueHolds(raw),
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const decoded = data;
  const live = decoded && (decoded.kind === "ok" || decoded.kind === "degraded") ? decoded : null;

  return (
    <Card data-testid="card-hold-ledger">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Server className="w-4 h-4" />
            Hold Ledger
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching} className="h-7 px-2 gap-1">
            <RefreshCw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} />
            <span className="text-xs">Refresh</span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Read-only. Viewing, refreshing or retrying never reconciles, clears, resumes or releases anything.</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading hold ledger…
          </div>
        ) : error && !live ? (
          <div className="space-y-2 text-sm text-destructive" role="alert" data-testid="hold-ledger-unavailable">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Hold ledger unavailable: {error instanceof Error ? error.message : "request failed"}.
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : decoded && decoded.kind === "malformed" ? (
          <div className="space-y-2 text-sm text-destructive" role="alert" data-testid="hold-ledger-malformed">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              The coordinator response could not be read ({decoded.reason}). Hold and queue state is unknown, not empty.
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : live ? (
          <div className="space-y-4">
            {error && (
              <p className="text-xs text-amber-700" role="status" data-testid="hold-ledger-stale">
                Refresh failed; showing last known data from {formatWhen(new Date(dataUpdatedAt).toISOString())}.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Coordinator status:</span>
              <Badge variant={live.kind === "ok" ? "outline" : "destructive"} className="text-xs">
                {live.kind === "ok" ? <CheckCircle2 className="w-3 h-3 mr-1 text-green-600" /> : <AlertTriangle className="w-3 h-3 mr-1" />}
                {live.kind}
              </Badge>
              <span className="text-xs text-muted-foreground">ledger epoch {live.ledgerEpoch}</span>
              {live.errorCode && <span className="text-xs text-destructive">{live.errorCode}</span>}
            </div>
            {live.kind === "degraded" && (
              <p className="text-xs text-amber-700" role="status">
                Coordinator is degraded. The data below is partial last-known state, not a confirmed result.
              </p>
            )}

            <div data-testid="outbound-pause-facts" className="rounded-md border p-2 text-xs space-y-0.5">
              <p className="font-medium text-sm">Canonical outbound pause</p>
              {live.pause ? (
                <p className="text-muted-foreground">
                  {live.pause.state} · source {live.pause.source} · epoch {live.pause.epoch}
                  {live.pause.reason ? ` · ${live.pause.reason}` : ""} · committed {formatWhen(live.pause.committedAt)} · as of {formatWhen(live.pause.asOf)}.
                  A seed lease is a narrow per-message exception, not an unpause.
                </p>
              ) : (
                <p className="text-amber-700">Unavailable: {live.pauseUnavailable}. Treat as unknown, not unpaused.</p>
              )}
            </div>

            {live.holds.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="hold-ledger-empty">
                {live.kind === "ok" ? "No active holds recorded." : "No holds were returned, but the coordinator is degraded, so this is not confirmed."}
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Holds ({live.holds.length}) across {live.logicalKeys.length} logical job{live.logicalKeys.length === 1 ? "" : "s"}
                </p>
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {live.holds.map((hold) => (
                    <div key={hold.holdId} className="rounded-md border border-border px-3 py-2 text-xs space-y-0.5" data-testid={`hold-${hold.holdId}`}>
                      <div className="flex flex-wrap items-center gap-2 font-medium">
                        <Clock className="w-3 h-3" />
                        {hold.logicalJobKey}
                        <Badge variant="secondary" className="text-xs">{hold.reasonCode}</Badge>
                        {!hold.active && <Badge variant="outline" className="text-xs">released</Badge>}
                      </div>
                      <div className="text-muted-foreground">
                        Source: {hold.sourceType}{hold.sourceKey ? ` (${hold.sourceKey})` : ""} · ledger epoch {hold.ledgerEpoch || "unknown"}
                        {hold.sourceEpoch ? ` · source epoch ${hold.sourceEpoch}` : ""}
                        {hold.expiresAt ? ` · expires ${formatWhen(hold.expiresAt)}` : ""}
                        {hold.correlationId ? ` · corr ${hold.correlationId}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-sm font-medium mb-2">Physical queue reconciliation</p>
              {live.reconciliation.length === 0 ? (
                <p className="text-xs text-muted-foreground">No physical queue results were returned.</p>
              ) : (
                <div className="space-y-1" data-testid="physical-queues">
                  {live.reconciliation.map((r) => (
                    <div key={r.physicalQueue} className="rounded border px-2 py-1 text-xs" data-testid={`queue-${r.physicalQueue}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate" title={r.physicalQueue}>{r.physicalQueue}</span>
                        <Badge variant={reconciliationDiverges(r) ? "destructive" : "outline"} className="text-xs">
                          {r.outcome}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground">
                        desired {r.desiredState} (epoch {r.desiredEpoch || "unknown"}) · observed {r.observedState}
                        {r.observedEpoch ? ` (epoch ${r.observedEpoch})` : ""}
                        {r.error ? ` · error: ${r.error}` : ""}
                      </p>
                      {r.observedState === "unknown" && <p className="text-amber-700">Observed state is unknown; not assumed running.</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground">Last reconciled: {formatWhen(live.reconciledAt)}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function QueueHoldsPage() {
  return (
    <CrmPage className="container mx-auto p-6 max-w-6xl space-y-6">
      {/* Header */}
      <CrmPageHeader title="Queue Holds & Backlog Preview" icon={<Database className="w-6 h-6" />}
        description={<>
          Admin-only. Hold ledger shows active logical job holds and coordinator state.
          Backlog preview shows a per-source risk estimate of queued work — sources overlap
          and{" "}
          <strong>must not be summed</strong>.
        </>} />

      {/* Two-column layout on large screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hold Ledger */}
        <HoldLedgerSection />

        {/* Backlog Preview — isolated by ErrorBoundary */}
        <BacklogPreviewErrorBoundary>
          <BacklogPreviewCard />
        </BacklogPreviewErrorBoundary>
      </div>
    </CrmPage>
  );
}
