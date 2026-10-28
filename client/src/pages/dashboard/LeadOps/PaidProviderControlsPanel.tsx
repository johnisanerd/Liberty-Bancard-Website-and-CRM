import { useQuery, useMutation } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

/**
 * Current Program Health location of the paid-provider control state and the emergency stop.
 * The stop calls the live, admin-gated POST /api/lead-ops/pilot/emergency-stop-paid; the route and its behavior are
 * unchanged by the pilot-history retirement. Nothing here calls a retired entrance. Never click it in production
 * tests: it disables provider controls, ZeroBounce auto-run and CRO-08A recurrence.
 */
export function PaidProviderControlsPanel() {
  const { toast } = useToast();
  const errToast = (err: unknown) => {
    toast({ title: "Action failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
  };

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
      queryClient.invalidateQueries({ queryKey: ["/api/lead-ops/pilot/status-overview"] });
    },
    onError: errToast,
  });

  return (
    <div className="space-y-4" data-testid="paid-provider-controls-panel">
    {/* Full telemetry snapshot */}
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h3 className="font-semibold text-sm">Paid provider controls &amp; emergency stop</h3>
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
            <div className="rounded border p-2"><div className="text-muted-foreground">Sunbiz source rows (estimate)</div><div>{statusOverviewQuery.data.funnel.sunbiz_source_rows ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Canonical businesses</div><div>{statusOverviewQuery.data.funnel.canonical_businesses ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Contacts linked to business</div><div>{statusOverviewQuery.data.funnel.contacts_linked_to_business ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Canonical missing domain</div><div>{statusOverviewQuery.data.funnel.canonical_missing_domain ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Free enrichment complete</div><div>{statusOverviewQuery.data.funnel.free_enrichment_complete ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Free enrichment queued</div><div>{statusOverviewQuery.data.funnel.free_enrichment_queued ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Paid discovered evidence (historical)</div><div>{statusOverviewQuery.data.funnel.paid_discovered_evidence_rows ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Policy eligible (historical)</div><div className="text-green-600 font-semibold">{statusOverviewQuery.data.funnel.policy_eligible ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Policy suppressed (historical)</div><div>{statusOverviewQuery.data.funnel.policy_suppressed ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Policy ineligible (historical)</div><div>{statusOverviewQuery.data.funnel.policy_ineligible ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Policy pending/discovery (historical)</div><div>{statusOverviewQuery.data.funnel.policy_pending ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Catch-all review (historical)</div><div>{statusOverviewQuery.data.funnel.policy_catch_all_review ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Ready-held businesses (current)</div><div className="text-green-600 font-semibold">{statusOverviewQuery.data.funnel.current?.readyHeldBusinesses ?? "—"}</div><div className="text-muted-foreground">{statusOverviewQuery.data.funnel.current?.readyHeldContacts ?? "—"} contacts · {statusOverviewQuery.data.funnel.current?.readyHeldUniqueAddresses ?? "—"} addresses · {statusOverviewQuery.data.funnel.current?.readyHeldPausedContacts ?? "—"} paused contacts · {statusOverviewQuery.data.funnel.current?.readyHeldPausedEnrollments ?? "—"} paused enrollments</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Verified links</div><div>{statusOverviewQuery.data.funnel.current?.verifiedLinkContacts ?? "—"} contacts · {statusOverviewQuery.data.funnel.current?.verifiedLinkBusinesses ?? "—"} businesses</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Ready-held enrollments (historical, frozen)</div><div>{statusOverviewQuery.data.funnel.ready_held_enrollments ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Identity quarantined</div><div>{statusOverviewQuery.data.funnel.identity_quarantined ?? "—"}</div></div>
            <div className="rounded border p-2"><div className="text-muted-foreground">Contacts suppressed</div><div>{statusOverviewQuery.data.funnel.contacts_suppressed ?? "—"}</div></div>
          </div>
        </div>
      )}
      {statusOverviewQuery.data && statusOverviewQuery.data.crosswalkOnlyExcluded == null && (
        <p className="text-xs text-muted-foreground" data-testid="crosswalk-excluded-unavailable">Crosswalk-only excluded contacts: unavailable (read failed, not zero).</p>
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
            {statusOverviewQuery.data.paidInFlightSample?.truncated && (
              <span data-testid="in-flight-sample-label"> (count is the whole population; the operation list shows the oldest {statusOverviewQuery.data.paidInFlightSample.returned} of {statusOverviewQuery.data.paidInFlightSample.total}, as of {new Date(statusOverviewQuery.data.paidInFlightSample.asOf).toLocaleTimeString()})</span>
            )}
          </div>
        </div>
      )}
      {statusOverviewQuery.data?.zeroBounceSafety && (
        <div className="rounded border p-2 text-xs">
          <div className="font-semibold">ZeroBounce automatic lane</div>
          <div className="font-mono mt-1">
            {statusOverviewQuery.data.zeroBounceSafety.autoRunEnabled === true ? "enabled" : statusOverviewQuery.data.zeroBounceSafety.autoRunEnabled === false ? "disabled" : "unavailable"} ·{" "}
            {statusOverviewQuery.data.zeroBounceSafety.nextAutomaticRunAt
              ? <>next run {new Date(statusOverviewQuery.data.zeroBounceSafety.nextAutomaticRunAt).toLocaleString()}</>
              : statusOverviewQuery.data.zeroBounceSafety.autoRunState === "disabled" ? "no automatic run scheduled while auto-run is off"
              : statusOverviewQuery.data.zeroBounceSafety.autoRunState === "schedule_unresolved" ? `next run not computed (custom schedule ${statusOverviewQuery.data.zeroBounceSafety.autoRunSchedule ?? "unknown"})`
              : "next run unavailable"}
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

      {statusOverviewQuery.isError && (
        <p className="text-xs text-red-500" data-testid="paid-provider-controls-error">
          Provider control state unavailable: {statusOverviewQuery.error instanceof Error ? statusOverviewQuery.error.message : "request failed"}. The emergency stop remains available.
        </p>
      )}
    </div>
  );
}
