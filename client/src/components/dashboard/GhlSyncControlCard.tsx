import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Clock3, Database, Loader2, Shield, ShieldAlert, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getApiErrorMessage, valueOrUnknown } from "@/lib/ghlTruth";
import { useToast } from "@/hooks/use-toast";
import { GhlNativeReviewForm, type GhlNativeSafetySnapshot } from "@/components/dashboard/GhlNativeReviewForm";

interface NativeReview {
  state: string | null;
  reviewedAt: string | null;
  expiresAt: string | null;
  evidenceReference: string | null;
  allowedOperations: Array<{
    method: string;
    path: string;
    fields: string[];
    tags: string[];
    stageIds: string[];
    safetyEvidence: string;
    purpose: string;
    customFieldIds: string[];
  }> | null;
}

interface SyncControl {
  enabled: boolean;
  transitioning?: boolean;
  permissionsEnabled: boolean;
  epoch: number;
  ownerProfile: string | null;
  selectedRuntime: string | null;
  nativeReview: NativeReview | null;
}

interface SyncTruth {
  control: SyncControl | null;
  errors: { control: string | null; runtime: string | null } | null;
  runtime: {
    owner: {
      profile: string | null;
      processProfile: string | null;
      releaseSha: string | null;
      deploymentIdentity: string | null;
      processIdentity: string | null;
      heartbeatAt: string | null;
      heartbeatFresh: boolean | null;
      leaseExpiresAt: string | null;
      state: string | null;
    } | null;
    worker: {
      selected: boolean | null;
      active: boolean | null;
      profile: string | null;
      state: string | null;
    } | null;
    queueBacklog: {
      waiting: number | null;
      active: number | null;
      delayed: number | null;
      failed: number | null;
    } | null;
    metrics: {
      currentEntityCounts: {
        contacts: Record<string, number | null> | null;
        deals: Record<string, number | null> | null;
        providerProjections: Record<string, number | null> | null;
      } | null;
      historicEntityCounts: Record<string, { syncedCount: number | null; errorCount: number | null }> | null;
    } | null;
    blockedDeferred: {
      count: number | null;
      lastAt: string | null;
      lastEntityType: string | null;
      lastReason: string | null;
    } | null;
    exportBacklog?: {
      eligiblePending: number; eligibleRetryDue: number; eligibleRetryWaiting: number; processing: number;
      heldHistorical: number; localOnlyOrTest: number; ambiguous: number; terminal: number; succeeded: number;
      deferralsTotal: number; oldestEligibleAt: string | null; oldestHeldAt: string | null; asOf: string;
    } | null;
    lastTick?: { at?: string; outcome?: string; reason?: string; error?: string | null; circuitState?: string } | null;
    exportPolicy?: { currentIntakeSince: string | null; legacyPhases: Record<string, boolean> | null } | null;
    errors: Record<string, string | null> | null;
  } | null;
}

interface NativeSafetyResponse extends GhlNativeSafetySnapshot {
  reason?: string | null;
  warning?: string | null;
}

function showTime(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function TruthValue({ label, value }: { label: string; value: string | number | boolean | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium break-words">{valueOrUnknown(value)}</div>
    </div>
  );
}

function flattenMetrics(value: unknown, prefix = ""): Array<{ label: string; value: string | number | boolean | null }> {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [{ label: prefix || "Metric", value: value as string | number | boolean | null }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenMetrics(item, `${prefix} ${index + 1}`.trim()));
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) =>
      flattenMetrics(nested, `${prefix} ${key.replace(/([A-Z])/g, " $1")}`.trim())
    );
  }
  return [{ label: prefix || "Metric", value: null }];
}

export function GhlSyncControlCard({ canControl, summaryOnly = false }: { canControl: boolean; summaryOnly?: boolean }) {
  const { toast } = useToast();
  const [ownerProfileDraft, setOwnerProfileDraft] = useState("");
  const controlQuery = useQuery<{ control: SyncControl }>({
    queryKey: ["/api/admin/ghl/sync-control"],
    enabled: canControl,
    retry: false,
    refetchInterval: 30_000,
  });
  const truthQuery = useQuery<SyncTruth>({
    queryKey: ["/api/admin/ghl/sync-truth"],
    enabled: canControl,
    retry: false,
    refetchInterval: 15_000,
  });
  const nativeSafetyQuery = useQuery<NativeSafetyResponse>({
    queryKey: ["/api/admin/ghl/native-trigger-safety"],
    enabled: canControl,
    retry: false,
    refetchInterval: 30_000,
  });

  const control = controlQuery.data?.control ?? truthQuery.data?.control ?? null;
  const truth = truthQuery.data;

  useEffect(() => {
    setOwnerProfileDraft(control?.ownerProfile ?? "");
  }, [control?.ownerProfile]);

  const patchControl = useMutation({
    mutationFn: async (change: Record<string, unknown>) => {
      if (!control) throw new Error("GHL sync control is unavailable; refresh before changing it.");
      const response = await apiRequest("PATCH", "/api/admin/ghl/sync-control", {
        expectedEpoch: control.epoch,
        ...change,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ghl/sync-control"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ghl/sync-truth"] });
      toast({ title: "GHL sync control updated", description: "The server accepted the control change." });
    },
    onError: (error) => toast({
      title: "Could not update GHL sync control",
      description: getApiErrorMessage(error, "The control update failed."),
      variant: "destructive",
    }),
  });

  const nativeSafety = nativeSafetyQuery.data;
  const owner = truth?.runtime?.owner;
  const worker = truth?.runtime?.worker;
  const backlog = truth?.runtime?.queueBacklog;
  const isTruthUnavailable = truthQuery.isError || !truth || !truth.runtime;
  const nativeReviewCurrent = !nativeSafetyQuery.isError
    && nativeSafety?.state === "reviewed_current"
    && nativeSafety.nativeReview?.state === "approved";

  return (
    <Card data-testid="card-ghl-sync-control">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" />
              GHL CRM Sync
              {control ? (
                <Badge variant={control.enabled ? "default" : "secondary"}>
                  {control.transitioning ? "Control transition held" : `Sync ${control.enabled ? "enabled" : "disabled"}`}
                </Badge>
              ) : (
                <Badge variant="outline">Sync state unknown</Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1">
              Outgoing CRM export control and runtime evidence. This does not pause outbound messaging, and a connected badge elsewhere does not mean this worker is running; incoming sync is controlled separately.
            </CardDescription>
          </div>
          {truthQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Refreshing sync truth" />}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {control?.transitioning && (
          <Alert>
            <AlertDescription>
              The control transition is held while in-flight CRM writes drain. New writes are blocked; this is not an active sync state.
            </AlertDescription>
          </Alert>
        )}
        {!canControl && (
          <Alert>
            <Shield className="h-4 w-4" />
            <AlertDescription>Server-authorized admin access is required to read GHL sync control and worker truth.</AlertDescription>
          </Alert>
        )}
        {controlQuery.isError && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>Sync control is unavailable. No enabled/disabled state is assumed.</AlertDescription>
          </Alert>
        )}
        {truthQuery.isError && (
          <Alert variant="destructive" data-testid="alert-ghl-truth-unavailable">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Runtime truth is unavailable. Owner, heartbeat, worker state, and queue health are unknown—not healthy.
            </AlertDescription>
          </Alert>
        )}

        {!summaryOnly && control && canControl && (
          <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" data-testid="section-ghl-sync-control" role="group" aria-label="Outgoing CRM export controls">
            <div className="text-sm font-semibold sm:col-span-2">Outgoing CRM export (separate from incoming sync)</div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">CRM sync</div>
                <div className="text-xs text-muted-foreground">Controls this sync worker only</div>
              </div>
              <Switch
                checked={control.enabled}
                disabled={patchControl.isPending}
                onCheckedChange={(enabled) => patchControl.mutate({ enabled })}
                aria-label="Enable GHL CRM sync"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Permission-field writes</div>
                <div className="text-xs text-muted-foreground">Separate from the general CRM sync switch</div>
              </div>
              <Switch
                checked={control.permissionsEnabled}
                disabled={patchControl.isPending}
                onCheckedChange={(permissionsEnabled) => patchControl.mutate({ permissionsEnabled })}
                aria-label="Enable GHL permission field writes"
              />
            </div>
            <div className="flex min-w-0 gap-2 sm:col-span-2">
              <Input
                aria-label="GHL sync owner profile"
                value={ownerProfileDraft}
                onChange={(event) => setOwnerProfileDraft(event.target.value)}
                placeholder="Owner profile"
                className="min-w-0"
              />
              <Button
                variant="outline"
                disabled={patchControl.isPending || ownerProfileDraft === (control.ownerProfile ?? "")}
                onClick={() => patchControl.mutate({ ownerProfile: ownerProfileDraft.trim() || null })}
              >
                Save owner
              </Button>
              <Button
                variant="outline"
                disabled={patchControl.isPending}
                onClick={() => patchControl.mutate({ selectCurrentRuntime: true })}
              >
                Select this runtime
              </Button>
            </div>
            <div className="text-xs text-muted-foreground sm:col-span-2">
              Compare-and-swap control epoch: {control.epoch}. Conflicting changes must be refreshed before retrying.
            </div>
          </div>
        )}

        <section aria-label="GHL sync runtime truth" data-testid="section-ghl-runtime-truth">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Database className="h-4 w-4 text-muted-foreground" />
            Runtime truth
          </h3>
          {isTruthUnavailable ? (
            <p className="text-sm text-muted-foreground">
              Runtime evidence is unknown because the truth endpoint has not returned a runtime snapshot.
              {truth?.errors?.runtime ? ` ${truth.errors.runtime}` : ""}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                <TruthValue label="Owner profile" value={owner?.profile} />
                <TruthValue label="Process profile" value={owner?.processProfile} />
                <TruthValue label="Release SHA" value={owner?.releaseSha} />
                <TruthValue label="Deployment identity" value={owner?.deploymentIdentity} />
                <TruthValue label="Process identity" value={owner?.processIdentity} />
                <TruthValue label="Owner state" value={owner?.state} />
                <TruthValue label="Selected runtime" value={control?.selectedRuntime} />
                <TruthValue label="Worker profile" value={worker?.profile} />
                <TruthValue label="Worker state" value={worker?.state} />
                <TruthValue label="Worker selected" value={worker?.selected} />
                <TruthValue label="Worker active" value={worker?.active} />
                <TruthValue label="Owner heartbeat" value={showTime(owner?.heartbeatAt)} />
                <TruthValue label="Heartbeat fresh" value={owner?.heartbeatFresh} />
                <TruthValue label="Lease expires" value={showTime(owner?.leaseExpiresAt)} />
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
                <span><Clock3 className="mr-1 inline h-3 w-3" />Control owner: {valueOrUnknown(control?.ownerProfile)}</span>
                <span>Sync enabled: {valueOrUnknown(control?.enabled)}</span>
                <span>Permission writes: {valueOrUnknown(control?.permissionsEnabled)}</span>
              </div>
              <div className="mt-3 rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">Queue backlog</div>
                {backlog ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <TruthValue label="Waiting" value={backlog.waiting} />
                    <TruthValue label="Active" value={backlog.active} />
                    <TruthValue label="Delayed" value={backlog.delayed} />
                    <TruthValue label="Failed" value={backlog.failed} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Backlog unavailable or not reported (unknown).</p>
                )}
              </div>
              {truth.runtime && (
                <div className="mt-3">
                  <div className="mb-2 text-sm font-medium">Reported sync metrics</div>
                  {truth.runtime.metrics ? <div className="space-y-3">
                    {truth.runtime.metrics.currentEntityCounts && (
                      <div>
                        <div className="mb-1 text-xs font-medium text-muted-foreground">Current entity counts</div>
                        {flattenMetrics(truth.runtime.metrics.currentEntityCounts).length ? (
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          {flattenMetrics(truth.runtime.metrics.currentEntityCounts).map(({ label, value }, index) => (
                            <TruthValue key={`${label}-${index}`} label={label} value={value} />
                          ))}
                          </div>
                        ) : <p className="text-sm text-muted-foreground">No count fields reported (unknown).</p>}
                      </div>
                    )}
                    {truth.runtime.metrics.historicEntityCounts && (
                      <div>
                        <div className="mb-1 text-xs font-medium text-muted-foreground">Historical sync counters</div>
                        {flattenMetrics(truth.runtime.metrics.historicEntityCounts).length ? (
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          {flattenMetrics(truth.runtime.metrics.historicEntityCounts).map(({ label, value }, index) => (
                            <TruthValue key={`${label}-${index}`} label={label} value={value} />
                          ))}
                          </div>
                        ) : <p className="text-sm text-muted-foreground">No historical counters reported (unknown).</p>}
                      </div>
                    )}
                    {!truth.runtime.metrics.currentEntityCounts && !truth.runtime.metrics.historicEntityCounts && (
                      <p className="text-sm text-muted-foreground">Metrics are unavailable (unknown).</p>
                    )}
                  </div> : <p className="text-sm text-muted-foreground">Metrics are unavailable (unknown).</p>}
                </div>
              )}
              {truth.runtime && (
                <div className="mt-3 rounded-md border p-3">
                  <div className="mb-2 text-sm font-medium">Blocked / deferred sync work</div>
                  {truth.runtime.blockedDeferred ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <TruthValue label="Count" value={truth.runtime.blockedDeferred.count} />
                      <TruthValue label="Last observed" value={showTime(truth.runtime.blockedDeferred.lastAt)} />
                      <TruthValue label="Last entity type" value={truth.runtime.blockedDeferred.lastEntityType} />
                      <TruthValue label="Last reason" value={truth.runtime.blockedDeferred.lastReason} />
                    </div>
                  ) : <p className="text-sm text-muted-foreground">Deferred-work evidence is unavailable (unknown).</p>}
                </div>
              )}
              {truth.runtime && (
                <div className="mt-3 rounded-md border p-3" data-testid="section-ghl-export-backlog">
                  <div className="mb-2 text-sm font-medium">Outgoing contact export</div>
                  {truth.runtime.exportBacklog ? (
                    <>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <TruthValue label="Eligible, waiting to run" value={truth.runtime.exportBacklog.eligiblePending + truth.runtime.exportBacklog.eligibleRetryDue} />
                        <TruthValue label="Scheduled retry" value={truth.runtime.exportBacklog.eligibleRetryWaiting} />
                        <TruthValue label="Processing" value={truth.runtime.exportBacklog.processing} />
                        <TruthValue label="Needs reconciliation" value={truth.runtime.exportBacklog.ambiguous} />
                        <TruthValue label="Held (outside export scope)" value={truth.runtime.exportBacklog.heldHistorical} />
                        <TruthValue label="Local-only or test (never exported)" value={truth.runtime.exportBacklog.localOnlyOrTest} />
                        <TruthValue label="Terminal" value={truth.runtime.exportBacklog.terminal} />
                        <TruthValue label="Provider accepted" value={truth.runtime.exportBacklog.succeeded} />
                        <TruthValue label="Oldest eligible" value={showTime(truth.runtime.exportBacklog.oldestEligibleAt)} />
                        <TruthValue label="Oldest held" value={showTime(truth.runtime.exportBacklog.oldestHeldAt)} />
                        <TruthValue label="Total local deferrals" value={truth.runtime.exportBacklog.deferralsTotal} />
                        <TruthValue label="Counts as of" value={showTime(truth.runtime.exportBacklog.asOf)} />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Held contacts are not exported until an owner-approved export scope releases them. Counts cover every projection row, including test and local-only contacts, and are a point-in-time read, not a live feed.
                      </p>
                    </>
                  ) : <p className="text-sm text-muted-foreground">Export backlog evidence is unavailable (unknown).</p>}
                  {truth.runtime.lastTick ? (
                    <p className="mt-2 text-xs text-muted-foreground" data-testid="text-ghl-last-tick">
                      Last worker pass: {showTime(truth.runtime.lastTick.at)} — {valueOrUnknown(truth.runtime.lastTick.outcome)}
                      {truth.runtime.lastTick.reason ? ` (${truth.runtime.lastTick.reason.replace(/_/g, " ")})` : ""}
                      {truth.runtime.lastTick.circuitState ? `; circuit ${truth.runtime.lastTick.circuitState}` : ""}
                      {truth.runtime.lastTick.error ? `; error ${truth.runtime.lastTick.error}` : ""}.
                    </p>
                  ) : <p className="mt-2 text-xs text-muted-foreground">No worker pass has been recorded (unknown, not healthy).</p>}
                </div>
              )}
              {truth.runtime?.errors && Object.entries(truth.runtime.errors).some(([, error]) => error) && (
                <div className="mt-3 rounded-md border border-amber-300 p-3">
                  <div className="mb-1 text-sm font-medium">Runtime evidence errors</div>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    {Object.entries(truth.runtime.errors).filter(([, error]) => error).map(([source, error]) => (
                      <div key={source}><span className="font-medium">{source}:</span> {error}</div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <Alert variant="default" className={nativeReviewCurrent
          ? "border-green-300 bg-green-50 dark:bg-green-950/30"
          : "border-amber-300 bg-amber-50 dark:bg-amber-950/30"} data-testid="alert-ghl-native-trigger-safety">
          <ShieldAlert className={`h-4 w-4 ${nativeReviewCurrent ? "text-green-600" : "text-amber-600"}`} />
          <AlertDescription className={nativeReviewCurrent ? "text-green-900 dark:text-green-100" : "text-amber-900 dark:text-amber-100"}>
            <strong>{nativeReviewCurrent
              ? "Backend reports a current native-trigger safety review."
              : "Native GHL workflow safety is not currently verified."}</strong>{" "}
            {nativeReviewCurrent
              ? "CRM writes remain limited to the explicit operations recorded in that review; a changed inventory suspends it."
              : "Contact field, tag, or stage writes remain blocked until a current manual review is verified."}
            <span className="block mt-1 text-xs">
              Review state: {nativeSafetyQuery.isError ? "unknown (safety endpoint unavailable)" : valueOrUnknown(nativeSafety?.state)}
              {nativeSafety?.warning ? ` — ${nativeSafety.warning}` : nativeSafety?.reason ? ` — ${nativeSafety.reason}` : ""}
            </span>
          </AlertDescription>
        </Alert>
        {!summaryOnly && nativeSafetyQuery.isLoading && <span className="sr-only">Loading native workflow safety status</span>}
        {!summaryOnly && canControl && (
          <GhlNativeReviewForm
            control={control}
            safety={nativeSafety}
            safetyUnavailable={nativeSafetyQuery.isError}
          />
        )}
        {control?.nativeReview?.expiresAt && (() => {
          const remaining = new Date(control.nativeReview!.expiresAt!).getTime() - Date.now();
          if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 4 * 60 * 60 * 1000) return null;
          return (
            <Alert className="border-amber-300 bg-amber-50 dark:bg-amber-950/30" data-testid="alert-ghl-native-review-expiring">
              <Clock3 className="h-4 w-4 text-amber-600" />
              <AlertDescription>
                The native-trigger safety review expires in about {Math.max(1, Math.round(remaining / 60000))} minutes. Pending contact exports pause when it lapses and resume automatically after a legitimate renewal.
              </AlertDescription>
            </Alert>
          );
        })()}
        {control?.nativeReview && (
          <div className="rounded-md border p-3 text-xs text-muted-foreground" data-testid="text-ghl-native-review-evidence">
            Server review metadata: {valueOrUnknown(control.nativeReview.state)}; reviewed {showTime(control.nativeReview.reviewedAt)};
            {" "}expires {showTime(control.nativeReview.expiresAt)}; evidence {valueOrUnknown(control.nativeReview.evidenceReference)}.
            {" "}Allowed operations: {control.nativeReview.allowedOperations?.length
              ? control.nativeReview.allowedOperations.map((operation) => `${operation.method} ${operation.path} [fields: ${operation.fields.join(", ") || "none"}]`).join("; ")
              : "unknown"}.
          </div>
        )}
        {summaryOnly && truthQuery.isError && (
          <div className="text-xs text-destructive flex items-center gap-1"><AlertTriangle className="h-3 w-3" />GHL worker truth could not be verified.</div>
        )}
      </CardContent>
    </Card>
  );
}